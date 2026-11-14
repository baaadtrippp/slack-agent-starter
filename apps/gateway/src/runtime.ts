import { randomUUID } from 'node:crypto';
import { createRedisState } from '@chat-adapter/state-redis';
import { waitUntil } from '@vercel/functions';
import { Sandbox } from '@vercel/sandbox';
import { ConsoleLogger } from 'chat';
import { createClient } from 'redis';
import { collectRunArtifact } from './generated-artifact.js';
import { createGateway, normalizeFailureResult } from './gateway.js';
import {
  createManagedWorker,
  MANAGED_WORKER_LAUNCH,
  MANAGED_WORKER_PRELAUNCH_EXIT,
} from './managed-worker.js';
import { RedisRunStore } from './store.js';
import type { SandboxTarget } from './store.js';
import { getRunningSession, inspectSandboxRun } from './worker-control.js';

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
  const sandboxName = required('SANDBOX_WORKER_NAME');
  const model = required('OPENROUTER_MODEL');
  const managedDrive = required('SANDBOX_MANAGED_DRIVE');
  const managedSeed = required('SANDBOX_MANAGED_SEED');
  const channelIds = required('SLACK_ENABLED_CHANNEL_IDS')
    .split(',')
    .map((id) => id.trim());
  if (channelIds.some((id) => !/^C[A-Z0-9]+$/.test(id)))
    throw new Error('Invalid enabled channel configuration');
  const operatorIds =
    process.env.SLACK_STOP_OPERATOR_IDS?.split(',')
      .map((id) => id.trim())
      .filter(Boolean) ?? [];
  if (
    operatorIds.some((id) => !/^[UW][A-Z0-9]+$/.test(id) || id === 'USLACKBOT')
  )
    throw new Error('Invalid Stop operator configuration');
  const config = {
    operatorIds,
    signingSecret: required('SLACK_SIGNING_SECRET'),
    botToken: required('SLACK_BOT_TOKEN'),
    workspaceId: required('SLACK_WORKSPACE_ID'),
    channelIds,
    origin: origin.origin,
    fileExchange: process.env.SLACK_FILE_EXCHANGE === '1',
    jpegInput: process.env.SLACK_JPEG_INPUT === '1',
    pngInput: process.env.SLACK_PNG_INPUT === '1',
    publicUrlInput: process.env.SLACK_PUBLIC_URL_INPUT === '1',
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
  const managed = createManagedWorker(
    {
      sandboxName,
      driveName: managedDrive,
      seedId: managedSeed,
    },
    store,
  );
  return createGateway({
    config,
    state,
    store,
    isSandboxStopped,
    inspectWorker: async (run, stop) => {
      const currentTarget = run.recovery ?? run.execution;
      if (!run.recovery) {
        const exact = await inspectSandboxRun(run, stop).catch(() => undefined);
        if (exact?.state === 'exited' || exact?.state === 'stopped')
          return exact;
      }
      if (!currentTarget || currentTarget.sandboxName !== sandboxName)
        return { state: 'unknown' };

      const bound = run.recovery
        ? await getRunningSession(currentTarget).catch(() => undefined)
        : undefined;
      // Only a verified stopped target can be rebound. An existing
      // binding already proves that its original environment stopped.
      const session =
        bound ??
        (await managed.recoverSession(currentTarget, Date.now() + 25_000));
      if (!session) return { state: 'unknown' };
      const target = {
        sandboxName: currentTarget.sandboxName,
        sessionId: session.sessionId,
      };
      if (!bound && !(await store.bindRecoveryTarget(currentTarget, target)))
        return { state: 'unknown' };
      const token = randomUUID();
      if (!(await store.reserveRecovery(target, token)))
        return { state: 'unknown' };
      try {
        const inspection = await inspectSandboxRun(run, stop, session);
        if (
          config.fileExchange &&
          inspection.state === 'exited' &&
          inspection.result?.artifact
        ) {
          const bytes = await collectRunArtifact(
            run.runId,
            target,
            inspection.result.artifact.format,
          ).catch(() => undefined);
          if (bytes) return { ...inspection, artifactBytes: bytes };
        }
        return inspection;
      } finally {
        await store.finishRecovery(target, token);
        if (!stop) await managed.stopIfIdle(session).catch(() => {});
      }
    },
    releaseRecoveredWorker: async (run, reconcileExit) => {
      let target = await store.releaseRecoveryTarget(run);
      if (reconcileExit && !target && !run.recovery && run.execution) {
        const inspection = await inspectSandboxRun(run, false).catch(
          () => undefined,
        );
        if (inspection?.state === 'exited') {
          if (
            inspection.result &&
            !normalizeFailureResult(run, inspection.result)
          )
            await store
              .claimSavedResult(run, inspection.result)
              .catch(() => undefined);
          target = await store.releaseRecoveryTarget(run, true);
        }
      }
      if (!target || target.sandboxName !== sandboxName) return;
      const session = await getRunningSession(target).catch(() => undefined);
      if (session) await managed.stopIfIdle(session).catch(() => {});
    },
    ...(config.fileExchange ? { collectArtifact: collectRunArtifact } : {}),
    dispatch: async (job, stagedInputs) => {
      const session = await managed
        .getSession(job.deadline)
        .catch(() => undefined);
      if (session?.status !== 'running') return 'worker-unavailable';
      const target = {
        sandboxName,
        sessionId: session.sessionId,
      };
      const stopIfIdle = () =>
        managed.stopIfIdle(session).catch(() => {
          console.error(
            JSON.stringify({
              runId: job.runId,
              phase: 'idle_stop_unconfirmed',
            }),
          );
        });
      const reservation = await store.recordDispatchTarget(job, target);
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
      if ((await store.getRun(job.runId))?.state === 'stopping') {
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
      const command = await session.runCommand({
        cmd: 'bash',
        args: [
          '-c',
          MANAGED_WORKER_LAUNCH,
          'hydra-worker',
          '/tmp/hydra-worker/supervise.mjs',
        ],
        sudo: true,
        cwd: '/tmp/hydra-worker',
        env: {
          HYDRA_JOB: JSON.stringify(job),
          HYDRA_MODEL: model,
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
        if (finished.exitCode === MANAGED_WORKER_PRELAUNCH_EXIT) {
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
