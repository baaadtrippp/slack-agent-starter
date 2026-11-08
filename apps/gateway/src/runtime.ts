import { randomUUID } from 'node:crypto';
import { createRedisState } from '@chat-adapter/state-redis';
import { waitUntil } from '@vercel/functions';
import { Sandbox } from '@vercel/sandbox';
import { ConsoleLogger } from 'chat';
import { createClient } from 'redis';
import { collectRunArtifact } from './generated-artifact.js';
import { createGateway } from './gateway.js';
import { createManagedWorker } from './managed-worker.js';
import { RedisRunStore } from './store.js';
import type { SandboxTarget } from './store.js';
import { inspectSandboxRun } from './worker-control.js';

const MANAGED_WORKER_PRELAUNCH_EXIT = 78;
const MANAGED_WORKER_PRIVILEGE_DROP =
  'setpriv --reuid=1000 --regid=1000 --clear-groups --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs';

// The provider's domain allowlist remains the IPv4 egress boundary. Verify
// IPv6 is disabled, then start the entire worker tree without privilege to
// restore it. The managed image and staged files use uid/gid 1000.
const MANAGED_WORKER_LAUNCH = [
  'set -u',
  `sysctl -qw net.ipv6.conf.default.disable_ipv6=1 net.ipv6.conf.all.disable_ipv6=1 || exit ${MANAGED_WORKER_PRELAUNCH_EXIT}`,
  `for setting in /proc/sys/net/ipv6/conf/*/disable_ipv6; do read -r disabled < "$setting" || exit ${MANAGED_WORKER_PRELAUNCH_EXIT}; test "$disabled" = 1 || exit ${MANAGED_WORKER_PRELAUNCH_EXIT}; done`,
  `${MANAGED_WORKER_PRIVILEGE_DROP} -- true || exit ${MANAGED_WORKER_PRELAUNCH_EXIT}`,
  `exec ${MANAGED_WORKER_PRIVILEGE_DROP} -- sh -c 'node "$1"; code=$?; if [ "$code" -eq ${MANAGED_WORKER_PRELAUNCH_EXIT} ]; then exit 79; fi; exit "$code"' hydra-worker "$1"`,
].join('; ');

let gateway: ReturnType<typeof createGateway> | undefined;

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing configuration: ${name}`);
  return value;
}

function httpsUrl(name: string) {
  const url = new URL(required(name));
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new Error(`Invalid configuration: ${name}`);
  return url;
}

async function isSandboxStopped(target: SandboxTarget) {
  const signal = AbortSignal.timeout(5_000);
  const sandbox = await Sandbox.get({
    name: target.sandboxName,
    resume: false,
    signal,
  });
  const sessions = await sandbox.listSessions({ signal });
  for await (const session of sessions) {
    if (session.id === target.sessionId) return session.status === 'stopped';
  }
  return true;
}

function initialize() {
  const origin = httpsUrl('GATEWAY_ORIGIN');
  if (origin.pathname !== '/' || origin.search)
    throw new Error('GATEWAY_ORIGIN must be a bare HTTPS origin');
  const sandboxName = process.env.SANDBOX_WORKER_NAME;
  const worker = sandboxName
    ? {
        kind: 'sandbox' as const,
        sandboxName,
        model: required('OPENROUTER_MODEL'),
      }
    : { kind: 'fake' as const, url: httpsUrl('FAKE_WORKER_URL') };
  const managedDrive = process.env.SANDBOX_MANAGED_DRIVE;
  const managedSeed = process.env.SANDBOX_MANAGED_SEED;
  if (
    (managedDrive || managedSeed) &&
    (!sandboxName || !managedDrive || !managedSeed)
  )
    throw new Error(
      'Managed worker requires a Sandbox name, Drive, and startup seed',
    );
  const channelIds = required('SLACK_ENABLED_CHANNEL_IDS')
    .split(',')
    .map((id) => id.trim());
  if (channelIds.some((id) => !/^C[A-Z0-9]+$/.test(id)))
    throw new Error('Invalid enabled channel configuration');
  const controlsEnabled =
    worker.kind === 'sandbox' &&
    process.env.SLACK_CONTROLS_AND_FEEDBACK === '1';
  const operatorIds =
    process.env.SLACK_STOP_OPERATOR_IDS?.split(',')
      .map((id) => id.trim())
      .filter(Boolean) ?? [];
  if (
    operatorIds.some((id) => !/^[UW][A-Z0-9]+$/.test(id) || id === 'USLACKBOT')
  )
    throw new Error('Invalid Stop operator configuration');
  const config = {
    controlsEnabled,
    operatorIds,
    signingSecret: required('SLACK_SIGNING_SECRET'),
    botToken: required('SLACK_BOT_TOKEN'),
    workspaceId: required('SLACK_WORKSPACE_ID'),
    channelIds,
    origin: origin.origin,
    threadResume:
      worker.kind === 'sandbox' && process.env.SLACK_THREAD_RESUME === '1',
    fileExchange:
      worker.kind === 'sandbox' && process.env.SLACK_FILE_EXCHANGE === '1',
    jpegInput:
      worker.kind === 'sandbox' && process.env.SLACK_JPEG_INPUT === '1',
    csvInput: worker.kind === 'sandbox' && process.env.SLACK_CSV_INPUT === '1',
    pdfInput: worker.kind === 'sandbox' && process.env.SLACK_PDF_INPUT === '1',
    pngInput: worker.kind === 'sandbox' && process.env.SLACK_PNG_INPUT === '1',
    csvOutput:
      worker.kind === 'sandbox' && process.env.SLACK_CSV_OUTPUT === '1',
    publicUrlInput:
      worker.kind === 'sandbox' && process.env.SLACK_PUBLIC_URL_INPUT === '1',
  };
  const redisUrl = new URL(required('REDIS_URL'));
  if (
    (redisUrl.protocol !== 'redis:' && redisUrl.protocol !== 'rediss:') ||
    redisUrl.hash
  )
    throw new Error('Invalid Redis URL configuration');

  const client = createClient({
    RESP: 2,
    url: redisUrl.toString(),
    socket: {
      connectTimeout: 1_000,
      reconnectStrategy: false,
    },
    disableOfflineQueue: true,
  });
  client.on('error', () => {});
  const state = createRedisState({
    client,
    keyPrefix: 'slack-agent:chat-sdk',
    logger: new ConsoleLogger('silent'),
  });
  const store = new RedisRunStore(client);
  const managed =
    sandboxName && managedDrive && managedSeed
      ? createManagedWorker(
          {
            sandboxName,
            driveName: managedDrive,
            seedId: managedSeed,
            controlsEnabled,
          },
          store,
        )
      : undefined;
  return createGateway({
    config,
    state,
    store,
    ...(worker.kind === 'sandbox' ? { isSandboxStopped } : {}),
    ...(controlsEnabled
      ? {
          inspectWorker: async (run, stop) => {
            const currentTarget = run.recovery ?? run.execution;
            const exact = await inspectSandboxRun(
              currentTarget ? { ...run, execution: currentTarget } : run,
              stop,
            ).catch(() => undefined);
            if (exact?.state === 'exited' || exact?.state === 'stopped')
              return exact;
            if (
              !managed ||
              !currentTarget ||
              currentTarget.sandboxName !== sandboxName
            )
              return { state: 'unknown' };

            // Recovery proves the exact target stopped or disappeared before
            // fencing it and reconciling one replacement on the same Drive.
            const session = await managed.recoverSession(
              currentTarget,
              Date.now() + 25_000,
            );
            if (!session) return { state: 'unknown' };
            const target = {
              sandboxName: currentTarget.sandboxName,
              sessionId: session.sessionId,
            };
            if (!(await store.bindRecoveryTarget(currentTarget, target)))
              return { state: 'unknown' };
            const token = randomUUID();
            if (!(await store.reserveRecovery(target, token)))
              return { state: 'unknown' };
            try {
              const inspection = await inspectSandboxRun(run, stop, session);
              if (
                inspection.state === 'exited' &&
                inspection.result?.artifact
              ) {
                const format = inspection.result.artifact.format;
                if (
                  config.fileExchange ||
                  (config.csvOutput && (format ?? 'csv') === 'csv')
                ) {
                  const bytes = await collectRunArtifact(
                    run.runId,
                    target,
                    format,
                  ).catch(() => undefined);
                  if (bytes) return { ...inspection, artifactBytes: bytes };
                }
              }
              return inspection;
            } finally {
              await store.finishRecovery(target, token);
              if (!stop) await managed.stopIfIdle(session).catch(() => {});
            }
          },
          releaseRecoveredWorker: async (run) => {
            const target = await store.releaseRecoveryTarget(run);
            if (!managed || !target || target.sandboxName !== sandboxName)
              return;
            const sandbox = await Sandbox.get({
              name: target.sandboxName,
              resume: false,
              signal: AbortSignal.timeout(5_000),
            }).catch(() => undefined);
            const session = sandbox?.currentSession();
            if (
              session?.status === 'running' &&
              session.sessionId === target.sessionId
            )
              await managed.stopIfIdle(session).catch(() => {});
          },
        }
      : {}),
    ...(config.csvOutput || config.fileExchange
      ? { collectArtifact: collectRunArtifact }
      : {}),
    dispatch: async (job, stagedInputs) => {
      if (job.memory && !managed) return 'worker-unavailable';
      if (worker.kind === 'sandbox') {
        const session = await (
          managed
            ? managed.getSession(job.deadline)
            : Sandbox.get({
                name: worker.sandboxName,
                resume: false,
                signal: AbortSignal.timeout(15_000),
              }).then((sandbox) => sandbox.currentSession())
        ).catch(() => undefined);
        if (session?.status !== 'running') return 'worker-unavailable';
        const target = {
          sandboxName: worker.sandboxName,
          sessionId: session.sessionId,
        };
        const stopIfIdle = () =>
          managed?.stopIfIdle(session).catch(() => {
            console.error(
              JSON.stringify({
                runId: job.runId,
                phase: 'idle_stop_unconfirmed',
              }),
            );
          });
        const reservation = await store.recordDispatchTarget(
          job,
          target,
          Boolean(managed),
        );
        if (reservation === 'stopping') await stopIfIdle();
        if (reservation === 'stopping' || reservation === 'unavailable')
          return 'worker-unavailable';
        if (reservation !== 'recorded')
          throw new Error('Worker Sandbox target was not recorded');
        const releaseReservation = (unsubmitted = false) =>
          store
            .releaseDispatchTarget(job.runId, target, unsubmitted)
            .catch(() =>
              store.releaseDispatchTarget(job.runId, target, unsubmitted),
            );
        if (stagedInputs) {
          try {
            const stageTimeout = Math.min(10_000, job.deadline - Date.now());
            if (stageTimeout <= 0) throw new Error('Worker deadline expired');
            const seed = job.session?.seedRunId ?? job.runId;
            await session.writeFiles(
              stagedInputs.map((content, index) => ({
                path:
                  '/workspace/inputs/' +
                  seed +
                  '/' +
                  job.runId +
                  '/input-' +
                  index,
                content,
                mode: 0o600,
              })),
              { signal: AbortSignal.timeout(stageTimeout) },
            );
            console.info(
              JSON.stringify({
                runId: job.runId,
                phase: 'inputs_staged',
                count: stagedInputs.length,
              }),
            );
          } catch (error) {
            await releaseReservation(true);
            await stopIfIdle();
            const storageFull =
              error instanceof Error &&
              (('code' in error &&
                (error.code === 'ENOSPC' || error.code === 'EDQUOT')) ||
                ('response' in error &&
                  error.response instanceof Response &&
                  error.response.status === 507));
            return storageFull ? 'input-storage-full' : 'input-staging-failed';
          }
        }
        if (
          controlsEnabled &&
          (await store.getRun(job.runId))?.state === 'stopping'
        ) {
          // No provider launch has been attempted by this dispatch.
          await releaseReservation(true);
          return;
        }
        const timeoutMs = job.deadline - Date.now();
        if (timeoutMs <= 0) {
          await releaseReservation(Boolean(stagedInputs));
          if (stagedInputs) {
            await stopIfIdle();
            return 'input-staging-failed';
          }
          throw new Error('Worker deadline expired');
        }
        const entry = controlsEnabled
          ? '/tmp/hydra-worker/supervise.mjs'
          : '/tmp/hydra-worker/run.mjs';
        const launch = managed
          ? {
              cmd: 'bash',
              args: ['-c', MANAGED_WORKER_LAUNCH, 'hydra-worker', entry],
              sudo: true,
            }
          : { cmd: 'node', args: [entry] };
        const command = await session.runCommand({
          ...launch,
          cwd: '/tmp/hydra-worker',
          env: {
            HYDRA_JOB: JSON.stringify(job),
            HYDRA_MODEL: worker.model,
            OPENROUTER_API_KEY: 'sandbox-firewall',
          },
          detached: true,
          timeoutMs,
          signal: AbortSignal.timeout(Math.min(15_000, timeoutMs)),
        });
        try {
          const finished = await command.wait({
            signal: AbortSignal.timeout(
              Math.max(1, job.deadline - Date.now() + 1_000),
            ),
          });
          const current = await store.getRun(job.runId);
          if (managed && finished.exitCode === MANAGED_WORKER_PRELAUNCH_EXIT) {
            const released = await releaseReservation(true);
            await stopIfIdle();
            console.error(
              JSON.stringify({
                runId: job.runId,
                phase: released
                  ? 'worker_prelaunch_failed'
                  : 'worker_prelaunch_release_unconfirmed',
              }),
            );
            if (released && current?.state === 'accepted')
              return 'worker-start-failed';
            return;
          }
          if (current?.state === 'stopping' || current?.state === 'stopped')
            return;
          if (
            finished.exitCode !== 0 ||
            !current?.result ||
            !(await releaseReservation())
          )
            throw new Error('Worker exit was not recorded');
          await stopIfIdle();
        } catch {
          console.error(
            JSON.stringify({
              runId: job.runId,
              phase: 'worker_exit_unconfirmed',
            }),
          );
        }
        return;
      }
      const response = await fetch(worker.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${job.callbackToken}`,
        },
        body: JSON.stringify(job),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status !== 202) throw new Error('Worker dispatch failed');
    },
    schedule: (task) =>
      waitUntil(
        new Promise<void>((resolve) => setImmediate(resolve))
          .then(task)
          .catch(() => {
            console.error(
              JSON.stringify({
                phase: 'background',
                category: 'gateway_unavailable',
              }),
            );
          }),
      ),
  });
}

export async function handle(
  request: Request,
  route: 'events' | 'interactions' | 'callback',
) {
  try {
    gateway ??= initialize();
    return await gateway[route](request);
  } catch {
    console.error(
      JSON.stringify({ phase: route, category: 'gateway_unavailable' }),
    );
    return new Response(null, { status: 503 });
  }
}
