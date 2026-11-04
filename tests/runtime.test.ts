import { once } from 'node:events';
import { createHmac, randomUUID } from 'node:crypto';
import net from 'node:net';
import { createRedisState } from '@chat-adapter/state-redis';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { WorkerJob } from '../packages/contracts/src/index.js';

const { background, sandboxGet } = vi.hoisted(() => ({
  background: [] as Promise<unknown>[],
  sandboxGet: vi.fn(),
}));
vi.mock('@vercel/functions', () => ({
  waitUntil: (task: Promise<unknown>) => background.push(task),
}));
vi.mock('../apps/gateway/node_modules/@vercel/sandbox/dist/index.js', () => ({
  Sandbox: { get: sandboxGet },
}));

const redisUrl = process.env.TEST_REDIS_URL;

describe.skipIf(!redisUrl)('gateway runtime Redis recovery', () => {
  let server: net.Server | undefined;
  const sockets: Array<{ client: net.Socket; server: net.Socket }> = [];
  let stallReplies = false;
  let connections = 0;

  afterAll(async () => {
    for (const pair of sockets) {
      pair.client.destroy();
      pair.server.destroy();
    }
    if (server?.listening) {
      server.close();
      await once(server, 'close');
    }
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('reopens a dead runtime and bounds stalled Redis replies', async () => {
    const target = new URL(redisUrl!);
    expect(target.protocol).toBe('redis:');
    expect(target.hostname).toBe('127.0.0.1');
    server = net.createServer((client) => {
      connections += 1;
      const upstream = net.connect(Number(target.port), target.hostname);
      const pair = { client, server: upstream };
      sockets.push(pair);
      client.on('data', (chunk) => upstream.write(chunk));
      upstream.on('data', (chunk) => {
        if (!stallReplies) client.write(chunk);
      });
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('TCP proxy did not bind');

    vi.stubEnv('GATEWAY_ORIGIN', 'https://gateway.example');
    vi.stubEnv('FAKE_WORKER_URL', 'https://gateway.example/api/worker/fake');
    vi.stubEnv('SLACK_ENABLED_CHANNEL_IDS', 'CTEST1');
    vi.stubEnv('SLACK_SIGNING_SECRET', 'synthetic-signing-secret');
    vi.stubEnv('SLACK_BOT_TOKEN', 'synthetic-bot-token');
    vi.stubEnv('SLACK_WORKSPACE_ID', 'TTEST1');
    vi.stubEnv('REDIS_URL', `redis://127.0.0.1:${address.port}`);
    vi.resetModules();
    const { handle } = await import('../apps/gateway/src/runtime.js');

    const forged = await handle(
      new Request('https://gateway.example/api/slack/events', {
        method: 'POST',
        body: '{}',
      }),
      'events',
    );
    expect(forged.status).toBe(401);
    expect(connections).toBe(0);

    const request = () =>
      new Request(
        'https://gateway.example/api/worker/callback?runId=00000000-0000-4000-8000-000000000001&generation=1',
        {
          method: 'GET',
          headers: { authorization: `Bearer ${'f'.repeat(64)}` },
        },
      );
    const first = await handle(request(), 'callback');
    expect(first.status).toBe(401);
    expect(connections).toBe(1);

    const disconnected = sockets.map((pair) => once(pair.client, 'close'));
    for (const pair of sockets) {
      pair.client.destroy();
      pair.server.destroy();
    }
    await Promise.all(disconnected);

    const reopened = await retryUntil(async () => {
      const response = await handle(request(), 'callback');
      return response.status === 401 ? response : null;
    });
    expect(reopened.status).toBe(401);
    expect(connections).toBeGreaterThan(1);

    stallReplies = true;
    const started = performance.now();
    const stalled = await handle(request(), 'callback');
    expect(stalled.status).toBe(503);
    expect(performance.now() - started).toBeLessThan(2_700);

    stallReplies = false;
    const recovered = await retryUntil(async () => {
      const response = await handle(request(), 'callback');
      return response.status === 401 ? response : null;
    });
    expect(recovered.status).toBe(401);
    expect(connections).toBeGreaterThan(2);

    vi.resetModules();
    const { handle: coldHandle } =
      await import('../apps/gateway/src/runtime.js');
    const beforeCold = connections;
    stallReplies = true;
    const coldStarted = performance.now();
    expect((await coldHandle(request(), 'callback')).status).toBe(503);
    expect(performance.now() - coldStarted).toBeLessThan(2_700);
    expect(connections).toBeGreaterThan(beforeCold);
    stallReplies = false;
    expect((await coldHandle(request(), 'callback')).status).toBe(401);
  }, 10_000);

  it('completes publication when Slack initialization and posting each take longer than one second', async () => {
    configureRuntime();
    const { SlackAdapter } = await import('@chat-adapter/slack');
    const initialize = vi
      .spyOn(SlackAdapter.prototype, 'initialize')
      .mockImplementation(
        () => new Promise<void>((resolve) => setTimeout(resolve, 1_300)),
      );
    vi.spyOn(SlackAdapter.prototype, 'postMessage').mockImplementation(
      async (threadId) => {
        await new Promise((resolve) => setTimeout(resolve, 1_300));
        return { id: '1800000001.000001', threadId, raw: {} };
      },
    );
    let job: WorkerJob | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        job = JSON.parse(String(init?.body)) as WorkerJob;
        return new Response(null, { status: 202 });
      }),
    );
    const { handle } = await import('../apps/gateway/src/runtime.js');
    const event = runtimeEvent();
    const observer = createRedisState({
      url: redisUrl!,
      keyPrefix: `runtime-observer:${randomUUID()}`,
    });
    await observer.connect();
    try {
      const response = await handle(event.request, 'events');
      expect(response.status).toBe(200);
      await drainBackground();
      expect(job).toBeDefined();
      expect(initialize).not.toHaveBeenCalled();
      const callback = await handle(
        new Request('https://gateway.example/api/worker/callback', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${job!.callbackToken}`,
          },
          body: JSON.stringify({
            version: 1,
            runId: job!.runId,
            generation: 1,
            eventId: randomUUID(),
            sequence: 1,
            type: 'completed',
            text: 'Synthetic delayed Slack result',
          }),
        }),
        'callback',
      );
      expect(callback.status).toBe(202);
      await drainBackground();
      expect(initialize).toHaveBeenCalledTimes(1);
      const encoded = await observer
        .getClient()
        .get(`slack-agent:m1:run:${job!.runId}`);
      expect(JSON.parse(encoded!)).toMatchObject({
        state: 'completed',
        messageId: '1800000001.000001',
      });
    } finally {
      await cleanupRuntimeRun(observer, event);
      await observer.disconnect();
    }
  }, 10_000);

  it.each(['running', 'stopped', 'unrecordable'] as const)(
    'uses the exact %s Sandbox session safely',
    async (condition) => {
      configureRuntime('synthetic-worker');
      const observer = createRedisState({
        url: redisUrl!,
        keyPrefix: `runtime-sandbox-observer:${randomUUID()}`,
      });
      await observer.connect();
      const sessionId = randomUUID();
      let recorded: unknown;
      const sessionRunCommand = vi.fn().mockImplementation(async (command) => {
        const job = JSON.parse(command.env.HYDRA_JOB) as WorkerJob;
        const encoded = await observer
          .getClient()
          .get(`slack-agent:m1:run:${job.runId}`);
        recorded = JSON.parse(encoded!);
      });
      const sandboxRunCommand = vi.fn();
      sandboxGet.mockResolvedValue({
        runCommand: sandboxRunCommand,
        currentSession: () => ({
          status: condition === 'stopped' ? 'stopped' : 'running',
          sessionId,
          runCommand: sessionRunCommand,
        }),
      });
      let restoreRecordTarget: (() => void) | undefined;
      if (condition === 'unrecordable') {
        const { RedisRunStore } = await import('../apps/gateway/src/store.js');
        const spy = vi.spyOn(RedisRunStore.prototype, 'recordDispatchTarget');
        spy.mockResolvedValue(false);
        restoreRecordTarget = () => spy.mockRestore();
      }
      const event = runtimeEvent();
      let runId: string | undefined;
      try {
        const { handle } = await import('../apps/gateway/src/runtime.js');
        expect((await handle(event.request, 'events')).status).toBe(200);
        await drainBackground();
        runId =
          (await observer
            .getClient()
            .get(`slack-agent:m1:event:TTEST1:${event.eventId}`)) ?? undefined;
        expect(runId).toBeDefined();
        const encoded = await observer
          .getClient()
          .get(`slack-agent:m1:run:${runId}`);
        expect(sandboxGet).toHaveBeenCalledWith({
          name: 'synthetic-worker',
          resume: false,
          signal: expect.any(AbortSignal),
        });
        expect(sandboxRunCommand).not.toHaveBeenCalled();
        if (condition === 'running') {
          expect(JSON.parse(encoded!)).toMatchObject({
            state: 'accepted',
            execution: { sandboxName: 'synthetic-worker', sessionId },
          });
          expect(recorded).toEqual(JSON.parse(encoded!));
          expect(sessionRunCommand).toHaveBeenCalledTimes(1);
        } else {
          expect(JSON.parse(encoded!)).toMatchObject({
            state: 'dispatch_failed',
          });
          expect(JSON.parse(encoded!)).not.toHaveProperty('execution');
          expect(sessionRunCommand).not.toHaveBeenCalled();
        }
      } finally {
        await cleanupRuntimeRun(observer, event, runId);
        await observer.disconnect();
        restoreRecordTarget?.();
      }
    },
  );
});

async function drainBackground() {
  while (background.length > 0) await Promise.all(background.splice(0));
}

async function retryUntil<T>(action: () => Promise<T | null>): Promise<T> {
  const deadline = performance.now() + 2_500;
  while (performance.now() < deadline) {
    const result = await action();
    if (result !== null) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Runtime did not recover before the test deadline');
}

function configureRuntime(sandboxName?: string) {
  background.splice(0);
  sandboxGet.mockReset();
  vi.stubEnv('GATEWAY_ORIGIN', 'https://gateway.example');
  vi.stubEnv('SANDBOX_WORKER_NAME', sandboxName ?? '');
  if (sandboxName) vi.stubEnv('OPENROUTER_MODEL', 'synthetic/model');
  else vi.stubEnv('FAKE_WORKER_URL', 'https://worker.example/api/fake');
  vi.stubEnv('SLACK_ENABLED_CHANNEL_IDS', 'CTEST1');
  vi.stubEnv('SLACK_SIGNING_SECRET', 'synthetic-signing-secret');
  vi.stubEnv('SLACK_BOT_TOKEN', 'synthetic-bot-token');
  vi.stubEnv('SLACK_WORKSPACE_ID', 'TTEST1');
  vi.stubEnv('REDIS_URL', redisUrl!);
  vi.resetModules();
}

function runtimeEvent() {
  const ts = `${Math.floor(Date.now() / 1_000)}.${String(
    Math.floor(Math.random() * 1_000_000),
  ).padStart(6, '0')}`;
  const eventId = `Ev${randomUUID()}`;
  const body = JSON.stringify({
    type: 'event_callback',
    team_id: 'TTEST1',
    event_id: eventId,
    is_ext_shared_channel: false,
    event: {
      type: 'app_mention',
      user: 'UTEST1',
      channel: 'CTEST1',
      text: '<@UBOT1> Synthetic Sandbox dispatch test',
      ts,
    },
  });
  const stamp = String(Math.floor(Date.now() / 1_000));
  const signature = createHmac('sha256', 'synthetic-signing-secret')
    .update(`v0:${stamp}:${body}`)
    .digest('hex');
  return {
    eventId,
    ts,
    request: new Request('https://gateway.example/api/slack/events', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': stamp,
        'x-slack-signature': `v0=${signature}`,
      },
    }),
  };
}

async function cleanupRuntimeRun(
  observer: ReturnType<typeof createRedisState>,
  event: { eventId: string; ts: string },
  knownRunId?: string,
) {
  const client = observer.getClient();
  const eventKey = `slack-agent:m1:event:TTEST1:${event.eventId}`;
  const runId = knownRunId ?? (await client.get(eventKey));
  const keys = [
    eventKey,
    `slack-agent:m1:message:TTEST1:CTEST1:${event.ts}`,
    `slack-agent:m1:owner:TTEST1:CTEST1:${event.ts}`,
  ];
  if (runId) keys.push(`slack-agent:m1:run:${runId}`);
  await client.del(keys);
}
