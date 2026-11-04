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
import {
  createGateway,
  BUSY_REPLY,
  RECOVERED_REPLY,
  WORKER_UNAVAILABLE_REPLY,
} from '../apps/gateway/src/gateway.js';
import { RedisRunStore } from '../apps/gateway/src/store.js';
import type { SandboxTarget } from '../apps/gateway/src/store.js';
import { createFakeWorker } from '../apps/worker/src/fake-worker.js';
import { WORKER_FAILURE_REPLY } from '../packages/contracts/src/index.js';
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

function threadReply(root: string) {
  const body = envelope();
  return {
    ...body,
    event: {
      ...body.event,
      type: 'message',
      channel_type: 'channel',
      thread_ts: root,
      text: 'What did I ask you to remember?',
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

function harness(
  sdkState: StateAdapter = createMockState(),
  threadResume = false,
  isSandboxStopped?: (target: SandboxTarget) => Promise<boolean>,
  inputConfig: { csvInput?: boolean; publicUrlInput?: boolean } = {},
) {
  const clock = { now: initialTime };
  const tasks: Array<() => Promise<void>> = [];
  const dispatch = vi
    .fn<(job: WorkerJob) => Promise<void | 'worker-unavailable'>>()
    .mockResolvedValue();
  const store = new RedisRunStore(
    redis.getClient(),
    `${namespace}:${randomUUID()}`,
  );
  const admit = vi.spyOn(store, 'admit');
  const gateway = createGateway({
    config: {
      signingSecret,
      botToken: 'synthetic-bot-token',
      workspaceId: 'TTEST1',
      channelIds: ['CTEST1'],
      origin: 'https://gateway.example',
      threadResume,
      ...inputConfig,
    },
    state: sdkState,
    store,
    dispatch,
    ...(isSandboxStopped ? { isSandboxStopped } : {}),
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
      expect(await gateway.store.getRun(run!.runId)).not.toHaveProperty('text');
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

    it('accepts a multibyte mention whose Slack rich-text envelope exceeds 32 KiB', async () => {
      const gateway = harness();
      const body = envelope();
      const text = `<@UBOT1> ${'あ'.repeat(11_900)}`;
      const payload = {
        ...body,
        event: {
          ...body.event,
          text,
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
        },
      };
      expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(
        32 * 1024,
      );
      expect((await gateway.events(signed(payload))).status).toBe(200);
      await gateway.flush();
      expect(gateway.dispatch.mock.calls[0]?.[0].input.text).toBe(text);
    });

    it('rejects malformed callback credentials and routing fields before reading Redis', async () => {
      const gateway = harness();
      const read = vi.spyOn(gateway.store, 'getRun');
      for (const [runId, generation, bearer] of [
        [randomUUID(), '1', 'invalid'],
        ['invalid', '1', 'f'.repeat(64)],
        [randomUUID(), 'invalid', 'f'.repeat(64)],
      ]) {
        const request = new Request(
          `https://gateway.example/api/worker/callback?runId=${runId}&generation=${generation}`,
          {
            headers: { authorization: `Bearer ${bearer}` },
          },
        );
        expect((await gateway.callback(request)).status).toBe(401);
      }
      expect(read).not.toHaveBeenCalled();
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

    it('posts a safe failure once and records the worker failure separately', async () => {
      const gateway = harness();
      const body = envelope();
      await gateway.events(signed(body));
      await gateway.flush();
      const job = gateway.dispatch.mock.calls[0]![0];
      const failure = {
        ...result(job),
        type: 'failed',
        text: 'private provider error',
      } as const;
      expect(
        (await gateway.callback(callback(failure, job.callbackToken))).status,
      ).toBe(202);
      await gateway.flush();
      expect(
        (await gateway.callback(callback(failure, job.callbackToken))).status,
      ).toBe(204);
      expect(
        SlackAdapter.prototype.postMessage,
      ).toHaveBeenCalledExactlyOnceWith(
        `slack:CTEST1:${body.event.ts}`,
        WORKER_FAILURE_REPLY,
      );
      expect(await gateway.store.getRun(job.runId)).toMatchObject({
        state: 'worker_failed',
        result: { type: 'failed', text: WORKER_FAILURE_REPLY },
      });
    });

    it('activates only after a real session result and routes one ordinary turn with that exact reference', async () => {
      const gateway = harness(createMockState(), true);
      const mention = envelope();
      const inactive = threadReply(mention.event.ts);
      await gateway.events(signed(inactive));
      await gateway.flush();
      expect(gateway.dispatch).not.toHaveBeenCalled();

      // A delayed retry of an older reply must not become input after activation.
      vi.mocked(SlackAdapter.prototype.postMessage).mockResolvedValueOnce({
        id: envelope().event.ts,
        threadId: `slack:CTEST1:${mention.event.ts}`,
        raw: {},
      });
      await gateway.events(signed(mention));
      await gateway.flush();
      const seed = gateway.dispatch.mock.calls[0]![0];
      expect(
        (await gateway.callback(callback(result(seed), seed.callbackToken)))
          .status,
      ).toBe(409);
      const session = {
        seedRunId: seed.runId,
        nativeId: randomUUID(),
        adapterId: randomUUID(),
        revision: 4,
      };
      expect(
        (
          await gateway.callback(
            callback({ ...result(seed), session }, seed.callbackToken),
          )
        ).status,
      ).toBe(202);
      await gateway.flush();

      await gateway.events(signed(inactive));
      await gateway.flush();
      expect(gateway.dispatch).toHaveBeenCalledTimes(1);

      const next = threadReply(mention.event.ts);
      const duplicate = {
        ...next,
        event_id: `Ev${randomUUID()}`,
        event: {
          ...next.event,
          type: 'app_mention',
          text: '<@UBOT1> ' + next.event.text,
        },
      };
      await gateway.events(signed(next));
      await gateway.events(signed(duplicate));
      await gateway.flush();
      expect(gateway.dispatch).toHaveBeenCalledTimes(2);
      expect(SlackAdapter.prototype.postMessage).toHaveBeenCalledTimes(1);
      const followup = gateway.dispatch.mock.calls[1]![0];
      expect(followup).toMatchObject({
        conversationId: seed.conversationId,
        session,
        input: { text: next.event.text, threadTs: mention.event.ts },
      });
      expect(
        (
          await gateway.callback(
            callback(result(followup), followup.callbackToken),
          )
        ).status,
      ).toBe(409);
      const updated = { ...session, revision: session.revision + 2 };
      expect(
        (
          await gateway.callback(
            callback({ ...result(followup), session }, followup.callbackToken),
          )
        ).status,
      ).toBe(409);
      const wrong = { ...updated, nativeId: randomUUID() };
      expect(
        (
          await gateway.callback(
            callback(
              { ...result(followup), session: wrong },
              followup.callbackToken,
            ),
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await gateway.callback(
            callback(
              { ...result(followup), session: updated },
              followup.callbackToken,
            ),
          )
        ).status,
      ).toBe(202);
      await gateway.flush();

      await gateway.events(
        signed({ ...duplicate, event_id: `Ev${randomUUID()}` }),
      );
      await gateway.flush();
      expect(gateway.dispatch).toHaveBeenCalledTimes(2);
      expect(SlackAdapter.prototype.postMessage).toHaveBeenCalledTimes(2);

      const later = threadReply(mention.event.ts);
      await gateway.events(signed(later));
      await gateway.flush();
      expect(gateway.dispatch.mock.calls[2]![0].session).toEqual(updated);

      await gateway.events(signed(envelope()));
      await gateway.flush();
      expect(gateway.dispatch.mock.calls[3]![0].session).toBeUndefined();
    });

    it('rejects ineligible ordinary events and reports a busy thread while its first run is active', async () => {
      const gateway = harness(createMockState(), true, undefined, {
        csvInput: true,
      });
      const mention = envelope();
      await gateway.events(signed(mention));
      await gateway.flush();
      const ordinary = threadReply(mention.event.ts);
      for (const ignored of [
        {
          ...ordinary,
          event: { ...ordinary.event, thread_ts: ordinary.event.ts },
        },
        { ...ordinary, event: { ...ordinary.event, bot_id: 'BTEST1' } },
        {
          ...ordinary,
          event: { ...ordinary.event, subtype: 'message_changed' },
        },
        {
          ...ordinary,
          event: { ...ordinary.event, subtype: 'thread_broadcast' },
        },
        { ...ordinary, event: { ...ordinary.event, subtype: 'file_share' } },
        {
          ...ordinary,
          event: { ...ordinary.event, files: [{ id: 'FTEST1' }] },
        },
        { ...ordinary, is_ext_shared_channel: true },
        { ...ordinary, event: { ...ordinary.event, user_team: 'TOTHER' } },
      ]) {
        expect((await gateway.events(signed(ignored))).status).toBe(200);
      }
      expect(gateway.admit).toHaveBeenCalledTimes(1);
      expect((await gateway.events(signed(ordinary))).status).toBe(200);
      await gateway.flush();
      expect(gateway.dispatch).toHaveBeenCalledTimes(1);
      expect(
        SlackAdapter.prototype.postMessage,
      ).toHaveBeenCalledExactlyOnceWith(
        `slack:CTEST1:${mention.event.ts}`,
        BUSY_REPLY,
      );
    });

    it('posts a private URL refusal to the originating thread without dispatch', async () => {
      const gateway = harness(createMockState(), false, undefined, {
        publicUrlInput: true,
      });
      const mention = envelope();
      mention.event.text = '<@UBOT1> Read <https://127.0.0.1/source.txt>.';

      expect((await gateway.events(signed(mention))).status).toBe(200);
      await gateway.flush();

      expect(gateway.dispatch).not.toHaveBeenCalled();
      expect(
        SlackAdapter.prototype.postMessage,
      ).toHaveBeenCalledExactlyOnceWith(
        `slack:CTEST1:${mention.event.ts}`,
        'That URL points to a private or restricted network address.',
      );
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

    it('releases an expired first turn only after stop proof, without replaying either event', async () => {
      const target = {
        sandboxName: 'synthetic-worker',
        sessionId: 'synthetic-session',
      };
      const stopped = vi.fn().mockResolvedValue(true);
      const gateway = harness(createMockState(), true, stopped);
      const interruptRun = gateway.store.interruptRun.bind(gateway.store);
      const interrupted = vi
        .spyOn(gateway.store, 'interruptRun')
        .mockImplementationOnce(async (run, now) => {
          if (!(await interruptRun(run, now)))
            throw new Error('Expected interruption to commit');
          throw new Error('Synthetic Redis acknowledgement loss');
        });
      gateway.dispatch.mockImplementationOnce(async (job) => {
        expect(await gateway.store.recordDispatchTarget(job, target)).toBe(
          'recorded',
        );
        throw new Error('Synthetic dispatch acknowledgement loss');
      });
      const original = envelope();
      await gateway.events(signed(original));
      await gateway.flush();
      const oldJob = gateway.dispatch.mock.calls[0]![0];
      const recoveryInput = threadReply(original.event.ts);
      gateway.clock.now = oldJob.deadline;
      expect(
        (await gateway.events(signed(recoveryInput, gateway.clock.now))).status,
      ).toBe(200);
      await gateway.events(
        signed(threadReply(original.event.ts), gateway.clock.now),
      );
      const delayedBusyReply = gateway.tasks.pop()!;
      expect(stopped).not.toHaveBeenCalled();
      await gateway.flush();

      expect(stopped).toHaveBeenCalledExactlyOnceWith(target);
      expect(interrupted).toHaveBeenCalledTimes(2);
      expect(gateway.dispatch).toHaveBeenCalledTimes(1);
      expect(await gateway.store.getRun(oldJob.runId)).toMatchObject({
        state: 'interrupted',
        execution: target,
      });
      expect(
        SlackAdapter.prototype.postMessage,
      ).toHaveBeenCalledExactlyOnceWith(
        `slack:CTEST1:${original.event.ts}`,
        RECOVERED_REPLY,
      );
      await gateway.events(signed(original, gateway.clock.now));
      await gateway.events(signed(recoveryInput, gateway.clock.now));
      await gateway.flush();
      expect(gateway.dispatch).toHaveBeenCalledTimes(1);
      expect(SlackAdapter.prototype.postMessage).toHaveBeenCalledTimes(1);

      const fresh = envelope();
      await gateway.events(
        signed(
          {
            ...fresh,
            event: { ...fresh.event, thread_ts: original.event.ts },
          },
          gateway.clock.now,
        ),
      );
      await gateway.flush();
      expect(gateway.dispatch).toHaveBeenCalledTimes(2);
      const newJob = gateway.dispatch.mock.calls[1]![0];
      expect(newJob.input.threadTs).toBe(original.event.ts);
      expect(newJob.session).toBeUndefined();
      expect(newJob.runId).not.toBe(oldJob.runId);

      expect(
        (await gateway.callback(callback(result(oldJob), oldJob.callbackToken)))
          .status,
      ).toBe(410);
      expect(await gateway.store.getRun(oldJob.runId)).toMatchObject({
        state: 'interrupted',
      });
      expect(await gateway.store.getRun(newJob.runId)).toMatchObject({
        state: 'accepted',
      });
      expect(SlackAdapter.prototype.postMessage).toHaveBeenCalledTimes(1);

      await delayedBusyReply();
      expect(SlackAdapter.prototype.postMessage).toHaveBeenLastCalledWith(
        `slack:CTEST1:${original.event.ts}`,
        BUSY_REPLY,
      );
      expect(stopped).toHaveBeenCalledTimes(1);
      expect(gateway.dispatch).toHaveBeenCalledTimes(2);
    });

    it.each(['unbound', 'unexpired', 'running', 'lookup error'])(
      'keeps ownership when the previous worker is %s',
      async (reason) => {
        const target = {
          sandboxName: 'synthetic-worker',
          sessionId: 'synthetic-session',
        };
        const stopped = vi.fn().mockResolvedValue(false);
        if (reason === 'lookup error')
          stopped.mockRejectedValue(new Error('Synthetic provider outage'));
        const gateway = harness(createMockState(), true, stopped);
        if (reason !== 'unbound') {
          gateway.dispatch.mockImplementationOnce(async (job) => {
            expect(await gateway.store.recordDispatchTarget(job, target)).toBe(
              'recorded',
            );
          });
        }
        const original = envelope();
        await gateway.events(signed(original));
        await gateway.flush();
        const job = gateway.dispatch.mock.calls[0]![0];
        if (reason !== 'unexpired') gateway.clock.now = job.deadline;
        await gateway.events(
          signed(threadReply(original.event.ts), gateway.clock.now),
        );
        await gateway.flush();

        expect(stopped).toHaveBeenCalledTimes(
          reason === 'running' || reason === 'lookup error' ? 1 : 0,
        );
        expect(gateway.dispatch).toHaveBeenCalledTimes(1);
        expect(await gateway.store.getRun(job.runId)).toMatchObject({
          state: 'accepted',
        });
        expect(
          SlackAdapter.prototype.postMessage,
        ).toHaveBeenCalledExactlyOnceWith(
          `slack:CTEST1:${original.event.ts}`,
          BUSY_REPLY,
        );
      },
    );

    it.each(['active', 'expired'])(
      'releases an unsubmitted %s run after a worker refusal',
      async (state) => {
        const gateway = harness();
        gateway.dispatch.mockResolvedValueOnce('worker-unavailable');
        const original = envelope();
        await gateway.events(signed(original));
        if (state === 'expired')
          gateway.clock.now = (await gateway.run())!.deadline;
        await gateway.flush();
        const job = gateway.dispatch.mock.calls[0]![0];
        expect(await gateway.store.getRun(job.runId)).toMatchObject({
          state: 'worker_failed',
        });
        expect(
          SlackAdapter.prototype.postMessage,
        ).toHaveBeenCalledExactlyOnceWith(
          `slack:CTEST1:${original.event.ts}`,
          WORKER_UNAVAILABLE_REPLY,
        );
        await gateway.events(signed(original));
        await gateway.flush();
        expect(gateway.dispatch).toHaveBeenCalledTimes(1);

        const fresh = envelope();
        await gateway.events(
          signed({
            ...fresh,
            event: { ...fresh.event, thread_ts: original.event.ts },
          }),
        );
        await gateway.flush();
        expect(gateway.dispatch).toHaveBeenCalledTimes(2);
        expect(gateway.dispatch.mock.calls[1]![0].input.threadTs).toBe(
          original.event.ts,
        );
        expect(SlackAdapter.prototype.postMessage).toHaveBeenCalledTimes(1);
      },
    );

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

    it('dispatches an admitted mention independently of unrelated SDK subscription state', async () => {
      const sdkState = createMockState();
      const gateway = harness(sdkState);
      const body = envelope();
      await sdkState.subscribe(`slack:CTEST1:${body.event.ts}`);
      await gateway.events(signed(body));
      await gateway.flush();
      const run = await gateway.run();
      expect(gateway.dispatch).toHaveBeenCalledTimes(1);
      expect(await gateway.store.getRun(run!.runId)).toMatchObject({
        state: 'accepted',
      });
    });

    it('bounds SDK initialization when its external Redis connection never becomes ready', async () => {
      const sdkState = createMockState();
      vi.spyOn(sdkState, 'connect').mockImplementation(
        () => new Promise<void>(() => {}),
      );
      const gateway = harness(sdkState);
      await gateway.events(signed(envelope()));
      await gateway.flush();
      const job = gateway.dispatch.mock.calls[0]![0];
      await gateway.callback(callback(result(job), job.callbackToken));
      vi.useFakeTimers();
      const flushing = gateway.flush();
      await vi.advanceTimersByTimeAsync(15_001);
      vi.useRealTimers();
      await flushing;
      const run = await gateway.run();
      expect(gateway.dispatch).toHaveBeenCalledTimes(1);
      expect(SlackAdapter.prototype.postMessage).not.toHaveBeenCalled();
      expect(await gateway.store.getRun(run!.runId)).toMatchObject({
        state: 'publication_uncertain',
      });
    });
  },
);
