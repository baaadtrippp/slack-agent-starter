import { once } from 'node:events';
import { createHmac, randomUUID } from 'node:crypto';
import net from 'node:net';
import { createRedisState } from '@chat-adapter/state-redis';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { WorkerJob } from '../packages/contracts/src/index.js';

const { background } = vi.hoisted(() => ({
  background: [] as Promise<unknown>[],
}));
vi.mock('@vercel/functions', () => ({
  waitUntil: (task: Promise<unknown>) => background.push(task),
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
    vi.stubEnv('GATEWAY_ORIGIN', 'https://gateway.example');
    vi.stubEnv('FAKE_WORKER_URL', 'https://worker.example/api/fake');
    vi.stubEnv('SLACK_ENABLED_CHANNEL_IDS', 'CTEST1');
    vi.stubEnv('SLACK_SIGNING_SECRET', 'synthetic-signing-secret');
    vi.stubEnv('SLACK_BOT_TOKEN', 'synthetic-bot-token');
    vi.stubEnv('SLACK_WORKSPACE_ID', 'TTEST1');
    vi.stubEnv('REDIS_URL', redisUrl!);
    vi.resetModules();
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
    const ts = `${Math.floor(Date.now() / 1_000)}.000001`;
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
        text: '<@UBOT1> Synthetic delayed Slack test',
        ts,
      },
    });
    const stamp = String(Math.floor(Date.now() / 1_000));
    const signature = createHmac('sha256', 'synthetic-signing-secret')
      .update(`v0:${stamp}:${body}`)
      .digest('hex');
    const observer = createRedisState({
      url: redisUrl!,
      keyPrefix: `runtime-observer:${randomUUID()}`,
    });
    await observer.connect();
    try {
      const response = await handle(
        new Request('https://gateway.example/api/slack/events', {
          method: 'POST',
          body,
          headers: {
            'content-type': 'application/json',
            'x-slack-request-timestamp': stamp,
            'x-slack-signature': `v0=${signature}`,
          },
        }),
        'events',
      );
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
      const client = observer.getClient();
      const eventKey = `slack-agent:m1:event:TTEST1:${eventId}`;
      const runId = await client.get(eventKey);
      const keys = [
        eventKey,
        `slack-agent:m1:message:TTEST1:CTEST1:${ts}`,
        `slack-agent:m1:owner:TTEST1:CTEST1:${ts}`,
      ];
      if (runId) keys.push(`slack-agent:m1:run:${runId}`);
      await client.del(keys);
      await observer.disconnect();
    }
  }, 10_000);
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
