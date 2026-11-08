import { randomUUID } from 'node:crypto';
import { Drive, Sandbox } from '@vercel/sandbox';
import type { Session } from '@vercel/sandbox';
import type { ManagedRuntime, RedisRunStore, SandboxTarget } from './store.js';

type ManagedWorkerConfig = {
  sandboxName: string;
  driveName: string;
  seedId: string;
  controlsEnabled?: boolean;
};

export function createManagedWorker(
  config: ManagedWorkerConfig,
  store: RedisRunStore,
) {
  const { sandboxName, driveName, seedId, controlsEnabled } = config;
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
        'set -eu; mountpoint -q /workspace; cd /tmp/hydra-worker; test -x node_modules/.bin/pi; test -x node_modules/.bin/pi-acp; command -v flock >/dev/null; command -v sysctl >/dev/null; command -v setpriv >/dev/null; node --check run.mjs; node --check shared-notes.mjs' +
          (controlsEnabled
            ? '; node --check supervise.mjs; node --check control.mjs'
            : ''),
      ],
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

  async function getSession(deadline: number) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    const signal = AbortSignal.timeout(Math.min(25_000, remaining));
    const [sandbox, drive, current] = await Promise.all([
      Sandbox.get({ name: sandboxName, resume: false, signal }),
      Drive.get({ name: driveName, signal }),
      store.getManagedRuntime(sandboxName),
    ]);
    if (
      !matchesSeedAndMount(sandbox, drive) ||
      (current && current.driveId !== drive.driveId)
    )
      return;

    if (!current || current.phase === 'starting')
      return activate(sandbox, drive, current, signal);

    const session = sandbox.currentSession();
    if (session.sessionId !== current.sessionId) return;
    if (isReadySession(session, drive)) return session;
    if (
      session.status !== 'stopped' ||
      drive.currentSessionId ||
      drive.currentSandboxName
    )
      return;
    const stoppedTarget = target(session);
    // Fence an unexpectedly stopped session before resuming it. If active
    // runs still own this target, activate() migrates them to the replacement
    // before the managed runtime becomes ready for a fresh dispatch.
    if (!(await store.isLostTarget(stoppedTarget)))
      await store.fenceLostTarget(stoppedTarget);

    const starting: ManagedRuntime = {
      phase: 'starting',
      sessionId: current.sessionId,
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

    // The persisted intent prevents a second resume after an ambiguous reply.
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

  async function recoverSession(lost: SandboxTarget, deadline: number) {
    if (lost.sandboxName !== sandboxName) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    const signal = AbortSignal.timeout(Math.min(25_000, remaining));
    const [sandbox, drive, current] = await Promise.all([
      Sandbox.get({ name: sandboxName, resume: false, signal }),
      Drive.get({ name: driveName, signal }),
      store.getManagedRuntime(sandboxName),
    ]);
    if (
      !matchesSeedAndMount(sandbox, drive) ||
      !current ||
      current.driveId !== drive.driveId
    )
      return;
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
