import { once } from 'node:events';
import net from 'node:net';
import { afterAll, describe, expect, it, vi } from 'vitest';

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

    const request = () =>
      new Request(
        'https://gateway.example/api/worker/callback?runId=00000000-0000-4000-8000-000000000001&generation=1',
        { method: 'GET', headers: { authorization: 'Bearer invalid' } },
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
  }, 10_000);
});

async function retryUntil<T>(action: () => Promise<T | null>): Promise<T> {
  const deadline = performance.now() + 2_500;
  while (performance.now() < deadline) {
    const result = await action();
    if (result !== null) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Runtime did not recover before the test deadline');
}
