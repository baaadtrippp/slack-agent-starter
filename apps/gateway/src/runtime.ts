import { createRedisState } from '@chat-adapter/state-redis';
import { waitUntil } from '@vercel/functions';
import { Sandbox } from '@vercel/sandbox';
import { ConsoleLogger } from 'chat';
import { createClient } from 'redis';
import { createGateway } from './gateway.js';
import { RedisRunStore } from './store.js';

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
  return createGateway({
    config,
    state,
    store: new RedisRunStore(client),
    dispatch: async (job) => {
      if (worker.kind === 'sandbox') {
        const signal = AbortSignal.timeout(15_000);
        const sandbox = await Sandbox.get({
          name: worker.sandboxName,
          signal,
        });
        if (sandbox.status !== 'running')
          throw new Error('Worker Sandbox is not running');
        await sandbox.runCommand({
          cmd: 'node',
          args: ['/tmp/hydra-worker/run.mjs'],
          cwd: '/tmp/hydra-worker',
          env: {
            HYDRA_JOB: JSON.stringify(job),
            HYDRA_MODEL: worker.model,
            OPENROUTER_API_KEY: 'sandbox-firewall',
          },
          detached: true,
          signal,
        });
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
