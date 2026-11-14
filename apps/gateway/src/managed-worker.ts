import { randomUUID } from 'node:crypto';
import { Drive, Sandbox } from '@vercel/sandbox';
import type { Session } from '@vercel/sandbox';
import type { ManagedRuntime, RedisRunStore, SandboxTarget } from './store.js';

export const MANAGED_WORKER_PRIVILEGE_DROP =
  'setpriv --reuid=1000 --regid=1000 --clear-groups --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs';

export const MANAGED_DRIVE_WRITE_SETUP = [
  'test ! -L /workspace',
  'mountpoint -q /workspace',
  'if [ "$(stat -c %u:%g -- /workspace)" != "1000:1000" ]; then chown --no-dereference -- 1000:1000 /workspace; fi',
  `${MANAGED_WORKER_PRIVILEGE_DROP} -- sh -c 'test -w /workspace && test -x /workspace'`,
].join(' && ');

type ManagedWorkerConfig = {
  sandboxName: string;
  driveName: string;
  seedId: string;
};

export function createManagedWorker(
  config: ManagedWorkerConfig,
  store: RedisRunStore,
) {
  const { sandboxName, driveName, seedId } = config;
  const target = (session: Session) => ({
    sandboxName,
    sessionId: session.sessionId,
  });

  function matchesSeedAndMount(sandbox: Sandbox, drive: Drive) {
    const mount = sandbox.mounts?.['/workspace'];
    return (
      !sandbox.persistent &&
      sandbox.currentSnapshotId === seedId &&
      mount?.mode === 'read-write' &&
      mount.drive === drive.name
    );
  }

  function isReadySession(session: Session, drive: Drive) {
    return (
      session.status === 'running' &&
      session.sourceSnapshotId === seedId &&
      drive.currentSessionId === session.sessionId &&
      drive.currentSandboxName === sandboxName
    );
  }

  async function activate(
    sandbox: Sandbox,
    drive: Drive,
    previous: ManagedRuntime | null,
    signal: AbortSignal,
  ) {
    const session = sandbox.currentSession();
    if (
      !matchesSeedAndMount(sandbox, drive) ||
      !isReadySession(session, drive) ||
      (previous &&
        (previous.phase !== 'starting' ||
          previous.driveId !== drive.driveId ||
          previous.sessionId === session.sessionId))
    )
      return;

    const ready = await session.runCommand({
      cmd: 'bash',
      args: [
        '-c',
        `set -eu; ${MANAGED_DRIVE_WRITE_SETUP} || exit 1; exec ${MANAGED_WORKER_PRIVILEGE_DROP} -- bash -c "$1"`,
        'hydra-readiness',
        'set -eu; cd /tmp/hydra-worker; test -x node_modules/.bin/pi; test -x node_modules/.bin/pi-acp; command -v flock >/dev/null; command -v sysctl >/dev/null; node --check run.mjs; node --check shared-notes.mjs; node --check supervise.mjs; node --check control.mjs',
      ],
      sudo: true,
      timeoutMs: 3_000,
      signal,
    });
    if (ready.exitCode !== 0) return;
    const enrolled = previous
      ? await store.enrollIdleSession(target(session))
      : await store.isIdleSessionOpen(target(session));
    if (!enrolled) return;
    if (
      previous &&
      (await store.isLostTarget({
        sandboxName,
        sessionId: previous.sessionId,
      })) &&
      !(await store.bindRecoveryTarget(
        { sandboxName, sessionId: previous.sessionId },
        target(session),
      ))
    )
      return;

    const updated = await store.compareManagedRuntime(sandboxName, previous, {
      phase: 'ready',
      sessionId: session.sessionId,
      driveId: drive.driveId,
    });
    if (updated) return session;
  }

  async function fenceStoppedReplacement(
    previous: ManagedRuntime,
    replacement: SandboxTarget,
  ) {
    if (await store.isLostTarget(replacement)) return true;
    if (!(await store.enrollIdleSession(replacement)))
      return store.isLostTarget(replacement);
    const prior = { sandboxName, sessionId: previous.sessionId };
    // Preserve every reservation from the original target before replacing
    // the stopped intermediate session, even if activation never bound it.
    if (
      (await store.isLostTarget(prior)) &&
      !(await store.bindRecoveryTarget(prior, replacement))
    )
      return store.isLostTarget(replacement);
    return store.fenceLostTarget(replacement);
  }

  async function load(deadline: number) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    const signal = AbortSignal.timeout(Math.min(25_000, remaining));
    const [sandbox, drive, current] = await Promise.all([
      Sandbox.get({ name: sandboxName, resume: false, signal }),
      Drive.get({ name: driveName, signal }),
      store.getManagedRuntime(sandboxName),
    ]);
    if (
      matchesSeedAndMount(sandbox, drive) &&
      (!current || current.driveId === drive.driveId)
    )
      return { sandbox, drive, current, signal };
  }

  // The persisted intent prevents a second resume after an ambiguous reply.
  async function resumeAndActivate(
    starting: ManagedRuntime,
    signal: AbortSignal,
  ) {
    const replacement = await Sandbox.get({
      name: sandboxName,
      resume: true,
      signal,
    });
    return activate(
      replacement,
      await Drive.get({ name: driveName, signal }),
      starting,
      signal,
    );
  }

  async function getSession(deadline: number) {
    const loaded = await load(deadline);
    if (!loaded) return;
    const { sandbox, drive, current, signal } = loaded;

    const session = sandbox.currentSession();
    const detached =
      session.status === 'stopped' &&
      !drive.currentSessionId &&
      !drive.currentSandboxName;
    if (
      !current ||
      (current.phase === 'starting' &&
        (!detached || session.sessionId === current.sessionId))
    )
      return activate(sandbox, drive, current, signal);

    if (current.phase === 'ready' && session.sessionId !== current.sessionId)
      return;
    if (isReadySession(session, drive)) return session;
    if (!detached) return;
    const stoppedTarget = target(session);
    if (current.phase === 'starting') {
      if (
        session.sourceSnapshotId !== seedId ||
        !(await fenceStoppedReplacement(current, stoppedTarget))
      )
        return;
    } else if (!(await store.isLostTarget(stoppedTarget))) {
      // An unexpected stop keeps active reservations for the next activation.
      await store.fenceLostTarget(stoppedTarget);
    }

    const starting: ManagedRuntime = {
      phase: 'starting',
      sessionId: session.sessionId,
      driveId: current.driveId,
      operationId: randomUUID(),
    };
    const claimed = await store
      .compareManagedRuntime(sandboxName, current, starting)
      .catch(() => store.compareManagedRuntime(sandboxName, current, starting));
    if (!claimed) return;
    if (signal.aborted) {
      // No provider resume was attempted, so this intent can be rolled back.
      await store.compareManagedRuntime(sandboxName, starting, current);
      return;
    }
    return resumeAndActivate(starting, signal);
  }

  async function recoverSession(lost: SandboxTarget, deadline: number) {
    if (lost.sandboxName !== sandboxName) return;
    const loaded = await load(deadline);
    const current = loaded?.current;
    if (!loaded || !current) return;
    const { sandbox, drive, signal } = loaded;
    if (current.sessionId !== lost.sessionId) return getSession(deadline);
    if (current.phase === 'starting') return getSession(deadline);

    let lostConfirmed = true;
    const sessions = await sandbox.listSessions({ signal });
    for await (const session of sessions) {
      if (session.id !== lost.sessionId) continue;
      lostConfirmed = session.status === 'stopped';
      break;
    }
    if (!lostConfirmed) return;

    const observed = sandbox.currentSession();
    const replacementAlreadyRunning =
      observed.sessionId !== lost.sessionId && isReadySession(observed, drive);
    if (
      !replacementAlreadyRunning &&
      (observed.status !== 'stopped' ||
        drive.currentSessionId ||
        drive.currentSandboxName)
    )
      return;
    if (!(await store.fenceLostTarget(lost))) return;

    const starting: ManagedRuntime = {
      phase: 'starting',
      sessionId: lost.sessionId,
      driveId: current.driveId,
      operationId: randomUUID(),
    };
    const claimed = await store
      .compareManagedRuntime(sandboxName, current, starting)
      .catch(() => store.compareManagedRuntime(sandboxName, current, starting));
    if (!claimed) return getSession(deadline);
    if (signal.aborted) {
      await store.compareManagedRuntime(sandboxName, starting, current);
      return;
    }

    if (replacementAlreadyRunning)
      return activate(sandbox, drive, starting, signal);
    return resumeAndActivate(starting, signal);
  }

  async function stopIfIdle(session: Session) {
    const exact = target(session);
    const operationId = randomUUID();
    const claim = await store
      .claimIdleStop(exact, operationId)
      .catch(() => store.claimIdleStop(exact, operationId));
    if (claim === 'claimed' || claim === 'stopping')
      await session.stop({ signal: AbortSignal.timeout(20_000) });
  }

  return { getSession, recoverSession, stopIfIdle };
}
