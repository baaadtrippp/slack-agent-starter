import { createRedisState } from '@chat-adapter/state-redis';
import { waitUntil } from '@vercel/functions';
import { Sandbox } from '@vercel/sandbox';
import { ConsoleLogger } from 'chat';
import { createClient } from 'redis';
import { collectRunCsv } from './generated-csv.js';
import { createGateway } from './gateway.js';
import { createManagedWorker } from './managed-worker.js';
import { RedisRunStore } from './store.js';
import type { SandboxTarget } from './store.js';

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
  return false;
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
  const config = {
    signingSecret: required('SLACK_SIGNING_SECRET'),
    botToken: required('SLACK_BOT_TOKEN'),
    workspaceId: required('SLACK_WORKSPACE_ID'),
    channelIds,
    origin: origin.origin,
    threadResume:
      worker.kind === 'sandbox' && process.env.SLACK_THREAD_RESUME === '1',
    csvInput: worker.kind === 'sandbox' && process.env.SLACK_CSV_INPUT === '1',
    pdfInput: worker.kind === 'sandbox' && process.env.SLACK_PDF_INPUT === '1',
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
          { sandboxName, driveName: managedDrive, seedId: managedSeed },
          store,
        )
      : undefined;
  return createGateway({
    config,
    state,
    store,
    ...(worker.kind === 'sandbox' ? { isSandboxStopped } : {}),
    ...(config.csvOutput ? { collectCsv: collectRunCsv } : {}),
    dispatch: async (job, stagedInput) => {
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
        if (stagedInput) {
          try {
            const stageTimeout = Math.min(10_000, job.deadline - Date.now());
            if (stageTimeout <= 0) throw new Error('Worker deadline expired');
            const seed = job.session?.seedRunId ?? job.runId;
            const input = job.input.publicUrl
              ? 'public_url'
              : job.input.pdf
                ? 'pdf'
                : 'csv';
            const filename =
              input === 'public_url' ? 'source.txt' : `input.${input}`;
            await session.writeFiles(
              [
                {
                  path: `/workspace/inputs/${seed}/${job.runId}/${filename}`,
                  content: stagedInput,
                  mode: 0o600,
                },
              ],
              { signal: AbortSignal.timeout(stageTimeout) },
            );
            console.info(
              JSON.stringify({
                runId: job.runId,
                phase: `${input}_staged`,
                bytes: stagedInput.length,
              }),
            );
          } catch {
            await releaseReservation(true);
            await stopIfIdle();
            return 'input-staging-failed';
          }
        }
        const timeoutMs = job.deadline - Date.now();
        if (timeoutMs <= 0) {
          await releaseReservation(Boolean(stagedInput));
          if (stagedInput) {
            await stopIfIdle();
            return 'input-staging-failed';
          }
          throw new Error('Worker deadline expired');
        }
        const command = await session.runCommand({
          cmd: 'node',
          args: ['/tmp/hydra-worker/run.mjs'],
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
          if (
            finished.exitCode !== 0 ||
            !(await store.getRun(job.runId))?.result ||
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

export async function handle(request: Request, route: 'events' | 'callback') {
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
