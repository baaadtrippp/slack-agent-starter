import { createHmac, randomUUID } from 'node:crypto';
import { createRedisState } from '@chat-adapter/state-redis';
import { SlackAdapter } from '@chat-adapter/slack';
import { createMockState } from '@chat-adapter/tests';
import type { StateAdapter } from 'chat';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createGateway, BUSY_REPLY } from '../apps/gateway/src/gateway.js';
import { RedisRunStore } from '../apps/gateway/src/store.js';
import { createFakeWorker } from '../apps/worker/src/fake-worker.js';
import type {
  WorkerJob,
  WorkerResult,
} from '../packages/contracts/src/index.js';

const redisUrl = process.env.TEST_REDIS_URL;
const namespace = `gateway-test:${randomUUID()}`;
const redis = createRedisState({
  url: redisUrl ?? 'redis://127.0.0.1:1',
  keyPrefix: namespace,
});
const signingSecret = 'synthetic-signing-secret';
const initialTime = 1_800_000_000_000;
let timestamp = 0;

function envelope() {
  timestamp += 1;
  return {
    type: 'event_callback',
    team_id: 'TTEST1',
    event_id: `Ev${randomUUID()}`,
    is_ext_shared_channel: false,
    event: {
      type: 'app_mention',
      user: 'UTEST1',
      channel: 'CTEST1',
      text: '<@UBOT1> Check the gateway.',
      ts: `1800000000.${String(timestamp).padStart(6, '0')}`,
    },
  };
}

function signed(body: unknown, sentAt = initialTime, secret = signingSecret) {
  const text = JSON.stringify(body);
  const seconds = String(Math.floor(sentAt / 1_000));
  const signature = createHmac('sha256', secret)
    .update(`v0:${seconds}:${text}`)
    .digest('hex');
  return new Request('https://gateway.example/api/slack/events', {
    method: 'POST',
    body: text,
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': seconds,
      'x-slack-signature': `v0=${signature}`,
    },
  });
}

function harness(sdkState: StateAdapter = createMockState()) {
  const clock = { now: initialTime };
  const tasks: Array<() => Promise<void>> = [];
  const dispatch = vi
    .fn<(job: WorkerJob) => Promise<void>>()
    .mockResolvedValue();
  const store = new RedisRunStore(redis, `${namespace}:${randomUUID()}`);
  const admit = vi.spyOn(store, 'admit');
  const gateway = createGateway({
    config: {
      signingSecret,
      botToken: 'synthetic-bot-token',
      workspaceId: 'TTEST1',
      channelIds: ['CTEST1'],
      origin: 'https://gateway.example',
    },
    state: sdkState,
    store,
    dispatch,
    schedule: (task) => tasks.push(task),
    now: () => clock.now,
  });
  async function flush() {
    for (let task = tasks.shift(); task; task = tasks.shift()) await task();
  }
  async function run() {
    return (await admit.mock.results[0]?.value)?.run;
  }
  return { ...gateway, store, admit, dispatch, tasks, clock, flush, run };
}

function result(job: WorkerJob): WorkerResult {
  return {
    version: 1,
    runId: job.runId,
    generation: job.generation,
    eventId: randomUUID(),
    sequence: 1,
    type: 'completed',
    text: 'Synthetic worker answer.',
  };
}

function callback(body: WorkerResult, token: string) {
  return new Request('https://gateway.example/api/worker/callback', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!redisUrl)(
  'signed gateway with real local Redis and mocked Slack delivery',
  () => {
    beforeAll(async () => {
      await redis.connect();
    });
    beforeEach(() => {
      vi.spyOn(SlackAdapter.prototype, 'initialize').mockResolvedValue();
      vi.spyOn(SlackAdapter.prototype, 'postMessage').mockResolvedValue({
        id: '1800000001.000001',
        threadId: 'slack:CTEST1:1800000000.000001',
        raw: {},
      });
      vi.spyOn(console, 'info').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => vi.useRealTimers());
    afterAll(async () => {
      const client = redis.getClient();
      for await (const keys of client.scanIterator({ MATCH: `${namespace}:*` }))
        if (keys.length > 0) await client.del(keys);
      await redis.disconnect();
    });

    it('returns a signed URL challenge without admitting work', async () => {
      const gateway = harness();
      const response = await gateway.events(
        signed({ type: 'url_verification', challenge: 'synthetic-challenge' }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        challenge: 'synthetic-challenge',
      });
      expect(gateway.admit).not.toHaveBeenCalled();
    });

    it.each([-301_000, 301_000])(
      'rejects signatures outside the freshness window (%i)',
      async (offset) => {
        const gateway = harness();
        expect(
          (await gateway.events(signed(envelope(), initialTime + offset)))
            .status,
        ).toBe(401);
        expect(gateway.admit).not.toHaveBeenCalled();
      },
    );

    it('rejects a forged or modified body before state changes', async () => {
      const gateway = harness();
      expect(
        (await gateway.events(signed(envelope(), initialTime, 'wrong-secret')))
          .status,
      ).toBe(401);
      const original = signed(envelope());
      const modified = new Request(original.url, {
        method: 'POST',
        headers: original.headers,
        body: '{}',
      });
      expect((await gateway.events(modified)).status).toBe(401);
      expect(gateway.admit).not.toHaveBeenCalled();
    });

    it.each([
      'workspace',
      'channel',
      'shared',
      'unknown-sharing',
      'external',
      'bot',
      'subtype',
      'dm',
      'ordinary',
    ])('ignores %s input without dispatch or state changes', async (kind) => {
      const gateway = harness();
      const body: Record<string, unknown> = envelope();
      const event = body.event as Record<string, unknown>;
      if (kind === 'workspace') body.team_id = 'TOTHER';
      if (kind === 'channel') event.channel = 'COTHER';
      if (kind === 'shared') body.is_ext_shared_channel = true;
      if (kind === 'unknown-sharing') delete body.is_ext_shared_channel;
      if (kind === 'external') event.user_team = 'TOTHER';
      if (kind === 'bot') event.bot_id = 'BBOT';
      if (kind === 'subtype') event.subtype = 'bot_message';
      if (kind === 'dm') event.channel = 'DTEST1';
      if (kind === 'ordinary') event.type = 'message';
      expect((await gateway.events(signed(body))).status).toBe(200);
      expect(gateway.admit).not.toHaveBeenCalled();
      expect(gateway.tasks).toHaveLength(0);
    });

    it('persists admission before acknowledgement and defers worker dispatch', async () => {
      const gateway = harness();
      const body = envelope();
      expect((await gateway.events(signed(body))).status).toBe(200);
      const run = await gateway.run();
      expect(await gateway.store.getRun(run!.runId)).toMatchObject({
        state: 'accepted',
        threadTs: body.event.ts,
      });
      expect(gateway.dispatch).not.toHaveBeenCalled();
      await gateway.flush();
      expect(gateway.dispatch).toHaveBeenCalledTimes(1);
      expect(gateway.dispatch.mock.calls[0]?.[0].input.threadTs).toBe(
        body.event.ts,
      );
      expect(JSON.stringify(run)).not.toContain(
        gateway.dispatch.mock.calls[0]?.[0].callbackToken,
      );
    });

    it('keeps existing-thread mentions on their root and logical retries on one run', async () => {
      const gateway = harness();
      const body = {
        ...envelope(),
        event: { ...envelope().event, thread_ts: '1799999999.000001' },
      };
      const responses = await Promise.all([
        gateway.events(signed(body)),
        gateway.events(signed(body)),
      ]);
      expect(responses.map((r) => r.status)).toEqual([200, 200]);
      await gateway.events(signed({ ...body, event_id: 'EvDIFFERENT' }));
      await gateway.flush();
      expect(gateway.dispatch).toHaveBeenCalledTimes(1);
      expect(gateway.dispatch.mock.calls[0]?.[0].input.threadTs).toBe(
        '1799999999.000001',
      );
    });

    it('returns a retryable error if durable admission fails', async () => {
      const gateway = harness();
      gateway.admit.mockRejectedValueOnce(new Error('Synthetic Redis outage'));
      expect((await gateway.events(signed(envelope()))).status).toBe(503);
      expect(gateway.tasks).toHaveLength(0);
    });

    it('authenticates callbacks and publishes once through Chat SDK to the same thread', async () => {
      const gateway = harness();
      const body = envelope();
      await gateway.events(signed(body));
      await gateway.flush();
      const job = gateway.dispatch.mock.calls[0]![0];
      const output = result(job);
      expect(
        (await gateway.callback(callback(output, 'f'.repeat(64)))).status,
      ).toBe(401);
      expect(
        (
          await gateway.callback(
            callback({ ...output, runId: randomUUID() }, job.callbackToken),
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await gateway.callback(
            callback({ ...output, generation: 2 }, job.callbackToken),
          )
        ).status,
      ).toBe(409);
      const responses = await Promise.all([
        gateway.callback(callback(output, job.callbackToken)),
        gateway.callback(callback(output, job.callbackToken)),
      ]);
      expect(responses.map((r) => r.status).sort()).toEqual([202, 204]);
      expect(SlackAdapter.prototype.postMessage).not.toHaveBeenCalled();
      await gateway.flush();
      expect(SlackAdapter.prototype.postMessage).toHaveBeenCalledTimes(1);
      expect(SlackAdapter.prototype.postMessage).toHaveBeenCalledWith(
        `slack:CTEST1:${body.event.ts}`,
        output.text,
      );
      expect(await gateway.store.getRun(job.runId)).toMatchObject({
        state: 'completed',
        messageId: '1800000001.000001',
      });
    });

    it('rejects an expired callback and rejects unauthenticated worker admission', async () => {
      const gateway = harness();
      await gateway.events(signed(envelope()));
      await gateway.flush();
      const job = gateway.dispatch.mock.calls[0]![0];
      const url = `https://gateway.example/api/worker/callback?runId=${job.runId}&generation=1`;
      expect((await gateway.callback(new Request(url))).status).toBe(401);
      expect(
        (
          await gateway.callback(
            new Request(url, {
              headers: { authorization: `Bearer ${job.callbackToken}` },
            }),
          )
        ).status,
      ).toBe(204);
      gateway.clock.now = job.deadline;
      expect(
        (await gateway.callback(callback(result(job), job.callbackToken)))
          .status,
      ).toBe(410);
      expect(SlackAdapter.prototype.postMessage).not.toHaveBeenCalled();
    });

    it('retains uncertain publication and never blindly reposts a duplicate callback', async () => {
      const gateway = harness();
      await gateway.events(signed(envelope()));
      await gateway.flush();
      const job = gateway.dispatch.mock.calls[0]![0];
      const output = result(job);
      vi.mocked(SlackAdapter.prototype.postMessage).mockRejectedValueOnce(
        new Error('Response lost after sending'),
      );
      await gateway.callback(callback(output, job.callbackToken));
      await gateway.flush();
      expect(await gateway.store.getRun(job.runId)).toMatchObject({
        state: 'publication_uncertain',
      });
      expect(
        (await gateway.callback(callback(output, job.callbackToken))).status,
      ).toBe(204);
      expect(gateway.tasks).toHaveLength(0);
      expect(SlackAdapter.prototype.postMessage).toHaveBeenCalledTimes(1);
    });

    it('responds explicitly to busy input and records failed dispatch without clearing ownership', async () => {
      const gateway = harness();
      const body = envelope();
      gateway.dispatch.mockRejectedValueOnce(
        new Error('Synthetic dispatch failure'),
      );
      await gateway.events(signed(body));
      await gateway.flush();
      const run = await gateway.run();
      expect(await gateway.store.getRun(run!.runId)).toMatchObject({
        state: 'dispatch_failed',
      });
      await gateway.events(
        signed({
          ...envelope(),
          event: { ...envelope().event, thread_ts: body.event.ts },
        }),
      );
      await gateway.flush();
      expect(gateway.dispatch).toHaveBeenCalledTimes(1);
      expect(SlackAdapter.prototype.postMessage).toHaveBeenCalledWith(
        `slack:CTEST1:${body.event.ts}`,
        BUSY_REPLY,
      );
    });

    it('accepts the original worker result if the dispatch response was lost', async () => {
      const gateway = harness();
      gateway.dispatch.mockRejectedValueOnce(
        new Error('Dispatch acknowledgement lost'),
      );
      await gateway.events(signed(envelope()));
      await gateway.flush();
      const job = gateway.dispatch.mock.calls[0]![0];
      expect(
        (await gateway.callback(callback(result(job), job.callbackToken)))
          .status,
      ).toBe(202);
      await gateway.flush();
      expect(await gateway.store.getRun(job.runId)).toMatchObject({
        state: 'completed',
      });
    });

    it('completes the fake-worker HTTP contract through the real gateway callback and SDK Redis state', async () => {
      const gateway = harness(redis);
      const workerTasks: Array<Promise<unknown>> = [];
      const worker = createFakeWorker({
        origin: 'https://gateway.example',
        now: () => gateway.clock.now,
        waitUntil: (task) => workerTasks.push(task),
        fetch: async (input, init) =>
          gateway.callback(new Request(input, init)),
      });
      gateway.dispatch.mockImplementation(async (job) => {
        const response = await worker(
          new Request('https://worker.example/api/fake', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${job.callbackToken}`,
            },
            body: JSON.stringify(job),
          }),
        );
        expect(response.status).toBe(202);
      });
      await gateway.events(signed(envelope()));
      await gateway.flush();
      await Promise.all(workerTasks);
      await gateway.flush();
      const job = gateway.dispatch.mock.calls[0]![0];
      expect(await gateway.store.getRun(job.runId)).toMatchObject({
        state: 'completed',
      });
      expect(SlackAdapter.prototype.postMessage).toHaveBeenCalledTimes(1);
    });

    it('retains the Slack message ID when its publication-state write fails', async () => {
      const gateway = harness();
      await gateway.events(signed(envelope()));
      await gateway.flush();
      const job = gateway.dispatch.mock.calls[0]![0];
      vi.spyOn(gateway.store, 'completePublication').mockRejectedValueOnce(
        new Error('State acknowledgement lost'),
      );
      await gateway.callback(callback(result(job), job.callbackToken));
      await gateway.flush();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('"messageId":"1800000001.000001"'),
      );
      expect(await gateway.store.getRun(job.runId)).toMatchObject({
        state: 'publication_uncertain',
      });
    });

    it('records dispatch failure if SDK subscription state routes past the mention handler', async () => {
      const sdkState = createMockState();
      const gateway = harness(sdkState);
      const body = envelope();
      await sdkState.subscribe(`slack:CTEST1:${body.event.ts}`);
      await gateway.events(signed(body));
      await gateway.flush();
      const run = await gateway.run();
      expect(gateway.dispatch).not.toHaveBeenCalled();
      expect(await gateway.store.getRun(run!.runId)).toMatchObject({
        state: 'dispatch_failed',
      });
    });

    it('bounds SDK initialization when its external Redis connection never becomes ready', async () => {
      const sdkState = createMockState();
      vi.spyOn(sdkState, 'connect').mockImplementation(
        () => new Promise<void>(() => {}),
      );
      const gateway = harness(sdkState);
      await gateway.events(signed(envelope()));
      vi.useFakeTimers();
      const flushing = gateway.flush();
      await vi.advanceTimersByTimeAsync(15_001);
      vi.useRealTimers();
      await flushing;
      const run = await gateway.run();
      expect(gateway.dispatch).not.toHaveBeenCalled();
      expect(await gateway.store.getRun(run!.runId)).toMatchObject({
        state: 'dispatch_failed',
      });
    });
  },
);
