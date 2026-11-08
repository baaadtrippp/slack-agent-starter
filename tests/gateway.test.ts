import { createHash, createHmac, randomUUID } from 'node:crypto';
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
  STARTING_STATUS,
  WORKER_UNAVAILABLE_REPLY,
} from '../apps/gateway/src/gateway.js';
import type { WorkerInspection } from '../apps/gateway/src/gateway.js';
import {
  encodeControlValue,
  STATUS_ACTION_ID,
  STOP_ACTION_ID,
} from '../apps/gateway/src/slack-controls.js';
import { RedisRunStore } from '../apps/gateway/src/store.js';
import type { RunRecord, SandboxTarget } from '../apps/gateway/src/store.js';
import { createFakeWorker } from '../apps/worker/src/fake-worker.js';
import {
  SHARED_NOTE_SAVED,
  WORKER_FAILURE_REPLY,
  workerJobSchema,
} from '../packages/contracts/src/index.js';
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
const historyFetch = vi.fn<typeof fetch>();

function historyMessage(ts: string, text = 'Synthetic root.') {
  return { type: 'message', ts, user: 'UTEST1', text };
}
const initialTime = 1_800_000_000_000;
let timestamp = 0;

function envelope() {
  timestamp += 1;
  return {
    type: 'event_callback',
    team_id: 'TTEST1',
    event_id: `Ev${randomUUID()}`,
    is_ext_shared_channel: false,
    authorizations: [{ team_id: 'TTEST1', user_id: 'UBOT1', is_bot: true }],
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
  inputConfig: {
    fileExchange?: boolean;
    jpegInput?: boolean;
    csvInput?: boolean;
    pdfInput?: boolean;
    pngInput?: boolean;
    publicUrlInput?: boolean;
    csvOutput?: boolean;
  } = {},
  collectArtifact?: (runId: string, target: SandboxTarget) => Promise<Buffer>,
  progressUi = false,
  controls?: {
    inspectWorker: (run: RunRecord, stop: boolean) => Promise<WorkerInspection>;
    releaseRecoveredWorker?: (run: RunRecord) => Promise<void>;
    operatorIds?: string[];
  },
  storeNamespace = `${namespace}:${randomUUID()}`,
) {
  const clock = { now: initialTime };
  const tasks: Array<() => Promise<void>> = [];
  const dispatch = vi
    .fn<
      (
        job: WorkerJob,
        stagedInputs?: Buffer[],
      ) => Promise<void | 'worker-unavailable'>
    >()
    .mockResolvedValue();
  const store = new RedisRunStore(redis.getClient(), storeNamespace);
  if (!progressUi)
    vi.spyOn(store, 'claimStatusCreation').mockResolvedValue(false);
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
      ...(controls
        ? { controlsEnabled: true, operatorIds: controls.operatorIds ?? [] }
        : {}),
    },
    state: sdkState,
    store,
    dispatch,
    ...(isSandboxStopped ? { isSandboxStopped } : {}),
    ...(collectArtifact ? { collectArtifact } : {}),
    ...(controls
      ? {
          inspectWorker: controls.inspectWorker,
          ...(controls.releaseRecoveredWorker
            ? { releaseRecoveredWorker: controls.releaseRecoveredWorker }
            : {}),
        }
      : {}),
    schedule: (task) => tasks.push(task),
    now: () => clock.now,
  });
  async function flush() {
    for (let task = tasks.shift(); task; task = tasks.shift()) await task();
  }
  async function run() {
    return (await admit.mock.results[0]?.value)?.run;
  }
  async function owner(threadTs: string) {
    return redis
      .getClient()
      .get(`${storeNamespace}:owner:TTEST1:CTEST1:${threadTs}`);
  }
  return {
    ...gateway,
    storeNamespace,
    store,
    admit,
    dispatch,
    tasks,
    clock,
    flush,
    run,
    owner,
  };
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

function progress(job: WorkerJob, eventId = randomUUID()) {
  return {
    version: 1 as const,
    runId: job.runId,
    generation: job.generation,
    eventId,
    sequence: 1 as const,
    type: 'working' as const,
  };
}

const statusTs = '1800000001.000001';
const answerTs = '1800000002.000001';
const controlNow = initialTime + 3_000;

function interaction(
  run: RunRecord,
  actionId: string,
  changes: {
    user?: string;
    generation?: number;
    messageTs?: string;
    threadTs?: string;
    actionTs?: string;
    secret?: string;
    sentAt?: number;
  } = {},
) {
  const user = changes.user ?? run.senderId;
  const threadTs = changes.threadTs ?? run.threadTs;
  const messageTs = changes.messageTs ?? statusTs;
  const body = new URLSearchParams({
    payload: JSON.stringify({
      type: 'block_actions',
      team: { id: run.workspaceId },
      user: { id: user, team_id: run.workspaceId },
      channel: { id: run.channelId },
      container: {
        type: 'message',
        channel_id: run.channelId,
        message_ts: messageTs,
        thread_ts: threadTs,
      },
      message: { ts: messageTs, thread_ts: threadTs },
      actions: [
        {
          type: 'button',
          action_id: actionId,
          action_ts: changes.actionTs ?? '1800000003.000000',
          value: encodeControlValue({
            version: 1,
            runId: run.runId,
            generation: changes.generation ?? run.generation,
          }),
        },
      ],
    }),
  }).toString();
  const seconds = String(Math.floor((changes.sentAt ?? controlNow) / 1_000));
  const signature = createHmac('sha256', changes.secret ?? signingSecret)
    .update(`v0:${seconds}:${body}`)
    .digest('hex');
  return new Request('https://gateway.example/api/slack/interactions', {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-slack-request-timestamp': seconds,
      'x-slack-signature': `v0=${signature}`,
    },
  });
}

function mockControlAccess() {
  historyFetch.mockImplementation(async (url, options) => {
    const method = String(url).split('/').at(-1);
    const raw = String(options?.body);
    const params = raw.startsWith('{')
      ? (JSON.parse(raw) as Record<string, string>)
      : Object.fromEntries(new URLSearchParams(raw));
    if (method === 'users.info') {
      return Response.json({
        ok: true,
        user: {
          id: params.user,
          team_id: params.user === 'UEXTERNAL' ? 'TOTHER1' : 'TTEST1',
          is_bot: params.user === 'UBOT1',
          deleted: false,
        },
      });
    }
    if (method === 'conversations.info') {
      return Response.json({
        ok: true,
        channel: {
          id: params.channel,
          is_channel: true,
          is_private: false,
          is_member: true,
          is_ext_shared: false,
          is_pending_ext_shared: false,
        },
      });
    }
    if (method === 'conversations.members')
      return Response.json({
        ok: true,
        members: ['UTEST1', 'UOTHER1', 'UOP1', 'UBOT1', 'UEXTERNAL'],
      });
    throw new Error('Unexpected Slack request');
  });
}

function callback(body: unknown, token: string) {
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
      historyFetch.mockReset().mockImplementation(async (url, options) => {
        if (String(url) !== 'https://slack.com/api/conversations.replies')
          throw new Error('Unexpected network request');
        const root = new URLSearchParams(String(options?.body)).get('ts')!;
        return Response.json({ ok: true, messages: [historyMessage(root)] });
      });
      vi.stubGlobal('fetch', historyFetch);
      vi.spyOn(SlackAdapter.prototype, 'initialize').mockResolvedValue();
      vi.spyOn(SlackAdapter.prototype, 'postMessage').mockResolvedValue({
        id: '1800000001.000001',
        threadId: 'slack:CTEST1:1800000000.000001',
        raw: {},
      });
      vi.spyOn(SlackAdapter.prototype, 'addReaction').mockResolvedValue();
      vi.spyOn(SlackAdapter.prototype, 'editMessage').mockResolvedValue({
        id: '1800000001.000001',
        threadId: 'slack:CTEST1:1800000000.000001',
        raw: {},
      });
      vi.spyOn(console, 'info').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });
    afterAll(async () => {
      const client = redis.getClient();
      for await (const keys of client.scanIterator({ MATCH: `${namespace}:*` }))
        if (keys.length > 0) await client.del(keys);
      await redis.disconnect();
    });

    it('admits an explicit shared note from an ordinary member only once', async () => {
      mockControlAccess();
      vi.spyOn(SlackAdapter.prototype, 'botUserId', 'get').mockReturnValue(
        'UBOT1',
      );
      const gateway = harness();
      const event = envelope();
      event.event.text =
        '<@UBOT1> remember for this channel: The badge is purple.';
      await gateway.events(signed(event));
      await gateway.events(signed(event));
      await gateway.events(signed({ ...event, event_id: 'EvAnotherDelivery' }));
      await gateway.flush();
      expect(gateway.dispatch).toHaveBeenCalledTimes(1);
      expect(gateway.dispatch.mock.calls[0]?.[0]).toMatchObject({
        memory: 'save',
        input: {
          text: 'The badge is purple.',
          workspaceId: 'TTEST1',
          channelId: 'CTEST1',
        },
      });
    });

    it.each(['remember for this channel:', 'use shared notes:'])(
      'initializes a cold bot identity before classifying %s with human authorization',
      async (command) => {
        mockControlAccess();
        let initialized = false;
        vi.mocked(SlackAdapter.prototype.initialize).mockImplementationOnce(
          async () => {
            initialized = true;
          },
        );
        const botUserId = vi
          .spyOn(SlackAdapter.prototype, 'botUserId', 'get')
          .mockImplementation(() => (initialized ? 'UBOT1' : undefined));
        const gateway = harness();
        const event = {
          ...envelope(),
          authorizations: [
            { team_id: 'TTEST1', user_id: 'UTEST1', is_bot: false },
          ],
        };
        event.event.text = `<@UBOT1> ${command} Synthetic text`;
        expect((await gateway.events(signed(event))).status).toBe(200);
        await gateway.flush();
        expect(SlackAdapter.prototype.initialize).toHaveBeenCalledOnce();
        expect(gateway.dispatch).toHaveBeenCalledOnce();
        expect(gateway.dispatch.mock.calls[0]?.[0]).toMatchObject({
          memory: command.startsWith('remember') ? 'save' : 'read',
          input: { text: 'Synthetic text' },
        });
        botUserId.mockRestore();
      },
    );

    it('binds shared notes to the admitted scope and publishes a save only after the worker result', async () => {
      mockControlAccess();
      vi.spyOn(SlackAdapter.prototype, 'botUserId', 'get').mockReturnValue(
        'UBOT1',
      );
      const gateway = harness(createMockState(), true);
      const event = envelope();
      event.event.text =
        '<@UBOT1> remember for this channel: The badge is purple.';
      await gateway.events(signed(event));
      await gateway.flush();
      const save = workerJobSchema.parse(gateway.dispatch.mock.calls[0]![0]);
      expect(SlackAdapter.prototype.postMessage).not.toHaveBeenCalled();

      function admission(channelId: string) {
        const url = new URL(save.callbackUrl);
        for (const [key, value] of Object.entries({
          runId: save.runId,
          generation: '1',
          memory: 'save',
          workspaceId: save.input.workspaceId,
          channelId,
          messageTs: save.input.messageTs,
        }))
          url.searchParams.set(key, value);
        return new Request(url, {
          headers: { authorization: 'Bearer ' + save.callbackToken },
        });
      }
      expect((await gateway.callback(admission('CTEST2'))).status).toBe(409);
      expect((await gateway.callback(admission('CTEST1'))).status).toBe(204);
      const fake = result(save);
      expect(
        (await gateway.callback(callback(fake, save.callbackToken))).status,
      ).toBe(409);
      const saved = { ...fake, text: SHARED_NOTE_SAVED };
      expect(
        (await gateway.callback(callback(saved, save.callbackToken))).status,
      ).toBe(202);
      expect(
        (await gateway.callback(callback(saved, save.callbackToken))).status,
      ).toBe(204);
      await gateway.flush();
      expect(SlackAdapter.prototype.postMessage).toHaveBeenCalledTimes(1);
      expect(await gateway.owner(event.event.ts)).toBeNull();

      const reader = envelope();
      reader.event.user = 'UOTHER1';
      reader.event.text = '<@UBOT1> use shared notes: What color is the badge?';
      await gateway.events(signed(reader));
      await gateway.flush();
      const read = workerJobSchema.parse(gateway.dispatch.mock.calls[1]![0]);
      expect(read).toMatchObject({
        memory: 'read',
        input: {
          text: 'What color is the badge?',
          senderId: 'UOTHER1',
          threadTs: reader.event.ts,
        },
      });
      expect(read.session).toBeUndefined();
      expect(read.input.threadContext).toBeUndefined();
      expect(read.conversationId).not.toBe(save.conversationId);
    });

    it.each(['remember for this channel:', 'use shared notes:'])(
      'refuses %s in a disabled channel or from an external or nonmember actor',
      async (command) => {
        mockControlAccess();
        vi.spyOn(SlackAdapter.prototype, 'botUserId', 'get').mockReturnValue(
          'UBOT1',
        );
        const gateway = harness();
        for (const { user, channel } of [
          { user: 'UTEST1', channel: 'CTEST2' },
          { user: 'UEXTERNAL', channel: 'CTEST1' },
          { user: 'UNONMEMBER', channel: 'CTEST1' },
        ]) {
          const event = envelope();
          Object.assign(event.event, {
            user,
            channel,
            text: '<@UBOT1> ' + command + ' Synthetic text',
          });
          await gateway.events(signed(event));
          await gateway.flush();
        }
        expect(gateway.dispatch).not.toHaveBeenCalled();
      },
    );

    it.each([false, true])(
      'saves only current text from an ordinary file-share reply (file exchange: %s)',
      async (fileExchange) => {
        const gateway = harness(createMockState(), true, undefined, {
          fileExchange,
          publicUrlInput: true,
        });
        const root = envelope();
        await gateway.events(signed(root));
        await gateway.flush();
        const initial = gateway.dispatch.mock.calls[0]![0];
        const session = {
          seedRunId: initial.runId,
          nativeId: randomUUID(),
          adapterId: randomUUID(),
          revision: 1,
        };
        expect(
          (
            await gateway.callback(
              callback({ ...result(initial), session }, initial.callbackToken),
            )
          ).status,
        ).toBe(202);
        await gateway.flush();

        mockControlAccess();
        const reply = threadReply(root.event.ts);
        const note = 'The badge is documented at https://example.test/fixture.';
        await gateway.events(
          signed({
            ...reply,
            event: {
              ...reply.event,
              text: 'remember for this channel: ' + note,
              subtype: 'file_share',
              files: [
                {
                  id: 'FTEST1',
                  name: 'attachment.txt',
                  mimetype: 'text/plain',
                },
              ],
              ts: '1800000002.000002',
            },
          }),
        );
        await gateway.flush();
        const [save, staged] = gateway.dispatch.mock.calls[1]!;
        expect(save).toMatchObject({
          memory: 'save',
          session,
          input: { text: note },
        });
        expect(save.input.attachments).toBeUndefined();
        expect(save.input.sources).toBeUndefined();
        expect(save.input.threadContext).toBeUndefined();
        expect(staged).toBeUndefined();
        expect(save.artifactOutput).toBeUndefined();
        expect(
          workerJobSchema.safeParse({
            ...save,
            input: { ...save.input, text: ' ' + note },
          }).success,
        ).toBe(false);
      },
    );

    it.each([
      ['save', true, 'remember for this channel:'],
      ['save', false, 'remember for this channel:'],
      ['read', true, 'use shared notes:'],
      ['read', false, 'use shared notes:'],
      [undefined, true, 'remember for this channel:'],
      [undefined, false, 'remember for this channel:'],
    ])(
      'deduplicates %s across Slack deliveries (reply first: %s)',
      async (memory, replyFirst, prefix) => {
        const gateway = harness(createMockState(), true);
        const root = envelope();
        await gateway.events(signed(root));
        await gateway.flush();
        const first = gateway.dispatch.mock.calls[0]![0];
        const session = {
          seedRunId: first.runId,
          nativeId: randomUUID(),
          adapterId: randomUUID(),
          revision: 1,
        };
        await gateway.callback(
          callback({ ...result(first), session }, first.callbackToken),
        );
        await gateway.flush();

        mockControlAccess();
        // Slack's signed installation context is available before the
        // gateway has initialized the bot's identity.
        vi.spyOn(SlackAdapter.prototype, 'botUserId', 'get')
          .mockReturnValueOnce(undefined)
          .mockReturnValue('UBOT1');
        const reply = {
          ...threadReply(root.event.ts),
          authorizations: [
            { team_id: 'TTEST1', user_id: 'UBOT1', is_bot: true },
          ],
        };
        const requestText = memory
          ? 'The synthetic badge is purple.'
          : 'Discuss this with <@UBOT1>.';
        reply.event.ts = '1800000002.000002';
        reply.event.text =
          '<@' +
          (memory ? 'UBOT1' : 'UOTHER1') +
          '> ' +
          prefix +
          ' ' +
          requestText;
        const mention = {
          ...reply,
          event_id: 'Ev' + randomUUID(),
          event: { ...reply.event, type: 'app_mention' },
        };
        for (const delivery of replyFirst
          ? [reply, mention]
          : [mention, reply]) {
          await gateway.events(signed(delivery));
          await gateway.flush();
        }
        expect(gateway.dispatch).toHaveBeenCalledTimes(2);
        const command = gateway.dispatch.mock.calls[1]![0];
        expect(command.memory).toBe(memory);
        expect(command.input.text).toBe(
          memory ? requestText : reply.event.text,
        );
      },
    );

    it('keeps earlier instructions and busy replies out of shared-note admission', async () => {
      vi.spyOn(SlackAdapter.prototype, 'botUserId', 'get').mockReturnValue(
        'UBOT1',
      );
      const gateway = harness(createMockState(), true);
      const root = envelope();
      const event = envelope();
      event.event.text = '<@UBOT1> Could you remember the earlier note?';
      historyFetch.mockResolvedValue(
        Response.json({
          ok: true,
          messages: [
            historyMessage(
              root.event.ts,
              'remember for this channel: History text',
            ),
          ],
        }),
      );
      await gateway.events(
        signed({
          ...event,
          event: { ...event.event, thread_ts: root.event.ts },
        }),
      );
      await gateway.flush();
      expect(gateway.dispatch.mock.calls[0]?.[0].memory).toBeUndefined();
      const busy = threadReply(root.event.ts);
      busy.event.text = 'remember for this channel: Busy note';
      await gateway.events(signed(busy));
      await gateway.flush();
      expect(gateway.dispatch).toHaveBeenCalledTimes(1);
    });

    async function startControlled(
      inspectWorker: (
        run: RunRecord,
        stop: boolean,
      ) => Promise<WorkerInspection>,
      operatorIds: string[] = [],
      releaseRecoveredWorker?: (run: RunRecord) => Promise<void>,
      inputConfig: Parameters<typeof harness>[3] = {},
      collectArtifact?: Parameters<typeof harness>[4],
    ) {
      mockControlAccess();
      vi.mocked(SlackAdapter.prototype.postMessage)
        .mockResolvedValueOnce({
          id: statusTs,
          threadId: 'slack:CTEST1:1800000000.000001',
          raw: {},
        })
        .mockResolvedValue({
          id: answerTs,
          threadId: 'slack:CTEST1:1800000000.000001',
          raw: {},
        });
      const gateway = harness(
        createMockState(),
        false,
        undefined,
        inputConfig,
        collectArtifact,
        true,
        {
          inspectWorker,
          operatorIds,
          ...(releaseRecoveredWorker ? { releaseRecoveredWorker } : {}),
        },
      );
      const target = { sandboxName: 'test-sandbox', sessionId: 'test-session' };
      gateway.dispatch.mockImplementationOnce(async (job) => {
        expect(await gateway.store.recordDispatchTarget(job, target)).toBe(
          'recorded',
        );
      });
      const event = envelope();
      expect((await gateway.events(signed(event))).status).toBe(200);
      await gateway.flush();
      gateway.clock.now = controlNow;
      const admitted = (await gateway.run())!;
      const job = gateway.dispatch.mock.calls[0]![0];
      const run = (await gateway.store.getRun(admitted.runId))!;
      expect(run).toMatchObject({
        statusMessageId: statusTs,
        execution: target,
      });
      return { gateway, run, job };
    }

    it('acknowledges signed controls before lookup and rejects forged, stale, and unauthorized Stop', async () => {
      const inspect = vi.fn().mockResolvedValue({ state: 'stopped' });
      const { gateway, run } = await startControlled(inspect, [
        'UOP1',
        'UEXTERNAL',
      ]);
      expect(
        (
          await gateway.interactions(
            interaction(run, STOP_ACTION_ID, {
              secret: 'wrong-signing-secret',
            }),
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await gateway.interactions(
            interaction(run, STOP_ACTION_ID, {
              sentAt: controlNow - 301_000,
            }),
          )
        ).status,
      ).toBe(401);
      for (const changed of [
        { generation: 2 },
        { messageTs: answerTs },
        { threadTs: '1800000000.000000' },
        { user: 'UOTHER1' },
        { user: 'UEXTERNAL' },
        { actionTs: '1799999000.000000' },
      ]) {
        expect(
          (
            await gateway.interactions(
              interaction(run, STOP_ACTION_ID, changed),
            )
          ).status,
        ).toBe(200);
        await gateway.flush();
      }
      expect(inspect).not.toHaveBeenCalled();
      expect(await gateway.owner(run.threadTs)).toBe(run.runId);
      expect(
        (
          await gateway.interactions(
            interaction(run, STOP_ACTION_ID, { user: 'UOP1' }),
          )
        ).status,
      ).toBe(200);
      expect(inspect).not.toHaveBeenCalled();
      await gateway.flush();
      expect(inspect).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ runId: run.runId, state: 'stopping' }),
        true,
      );
      expect(await gateway.store.getRun(run.runId)).toMatchObject({
        state: 'stopped',
      });
    });

    it('keeps ownership during Stop, fences terminal and progress callbacks, and leaves a newer owner alone', async () => {
      const entered = Promise.withResolvers<void>();
      const proof = Promise.withResolvers<WorkerInspection>();
      const inspect = vi.fn(async () => {
        entered.resolve();
        return proof.promise;
      });
      const { gateway, run, job } = await startControlled(inspect);
      expect(
        (await gateway.interactions(interaction(run, STOP_ACTION_ID))).status,
      ).toBe(200);
      const stop = gateway.tasks.shift()!();
      await entered.promise;
      expect(await gateway.store.getRun(run.runId)).toMatchObject({
        state: 'stopping',
      });
      expect(await gateway.owner(run.threadTs)).toBe(run.runId);
      await vi.waitFor(() => {
        expect(SlackAdapter.prototype.editMessage).toHaveBeenLastCalledWith(
          expect.any(String),
          statusTs,
          expect.objectContaining({
            children: expect.arrayContaining([
              expect.objectContaining({ content: 'Stopping…' }),
            ]),
          }),
        );
      });
      const reply = result(job);
      expect(
        (await gateway.callback(callback(reply, job.callbackToken))).status,
      ).toBe(409);
      expect(
        (await gateway.callback(callback(progress(job), job.callbackToken)))
          .status,
      ).toBe(409);
      expect(
        (await gateway.interactions(interaction(run, STOP_ACTION_ID))).status,
      ).toBe(200);
      await gateway.flush();
      expect(inspect).toHaveBeenCalledTimes(1);
      proof.resolve({ state: 'stopped' });
      await stop;
      expect(await gateway.owner(run.threadTs)).toBeNull();
      expect(SlackAdapter.prototype.postMessage).toHaveBeenCalledTimes(1);

      const later = envelope();
      expect(
        (
          await gateway.events(
            signed(
              {
                ...later,
                event: { ...later.event, thread_ts: run.threadTs },
              },
              controlNow,
            ),
          )
        ).status,
      ).toBe(200);
      const newer = await gateway.owner(run.threadTs);
      expect(newer).toBeTruthy();
      expect(newer).not.toBe(run.runId);
      expect(
        (await gateway.callback(callback(reply, job.callbackToken))).status,
      ).toBe(409);
      expect(await gateway.owner(run.threadTs)).toBe(newer);
    });

    it('lets terminal publication finish if its claim beats Stop', async () => {
      const inspect = vi.fn().mockResolvedValue({ state: 'stopped' });
      const { gateway, run, job } = await startControlled(inspect);
      expect(
        (await gateway.callback(callback(result(job), job.callbackToken)))
          .status,
      ).toBe(202);
      expect(
        (await gateway.interactions(interaction(run, STOP_ACTION_ID))).status,
      ).toBe(200);
      await gateway.flush();
      expect(inspect).not.toHaveBeenCalled();
      expect(await gateway.store.getRun(run.runId)).toMatchObject({
        state: 'completed',
        messageId: answerTs,
      });
      expect(SlackAdapter.prototype.postMessage).toHaveBeenCalledTimes(2);
    });

    it('recovers an exited run’s saved answer with Status and does not submit a new run', async () => {
      const inspect = vi.fn();
      const { gateway, run, job } = await startControlled(inspect);
      inspect.mockResolvedValue({ state: 'exited', result: result(job) });
      gateway.clock.now = run.deadline + 1_000;
      expect(
        (
          await gateway.interactions(
            interaction(run, STATUS_ACTION_ID, {
              user: 'UOTHER1',
              actionTs: '1800000061.000000',
              sentAt: gateway.clock.now,
            }),
          )
        ).status,
      ).toBe(200);
      expect(inspect).not.toHaveBeenCalled();
      await gateway.flush();
      expect(inspect).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ runId: run.runId }),
        false,
      );
      expect(await gateway.store.getRun(run.runId)).toMatchObject({
        state: 'completed',
        messageId: answerTs,
      });
      expect(gateway.dispatch).toHaveBeenCalledTimes(1);
      expect(SlackAdapter.prototype.postMessage).toHaveBeenCalledTimes(2);
      expect(SlackAdapter.prototype.editMessage).toHaveBeenLastCalledWith(
        expect.any(String),
        statusTs,
        expect.objectContaining({
          children: [
            expect.objectContaining({
              content: 'Completed. The result is in this thread.',
            }),
          ],
        }),
      );
    });

    it('keeps a saved artifact retryable when its collection target turns stale', async () => {
      const csv = Buffer.from('label,value\nsynthetic,1\n');
      const inspect = vi.fn();
      const { gateway, run, job } = await startControlled(
        inspect,
        [],
        undefined,
        { csvOutput: true },
        vi.fn(),
      );
      const output = {
        ...result(job),
        artifact: { sha256: createHash('sha256').update(csv).digest('hex') },
        session: {
          seedRunId: job.runId,
          nativeId: randomUUID(),
          adapterId: randomUUID(),
          revision: 1,
        },
      };
      inspect.mockResolvedValue({
        state: 'exited',
        result: output,
        artifactTarget: run.execution,
      });
      const claimSavedResult = vi
        .spyOn(gateway.store, 'claimSavedResult')
        .mockResolvedValueOnce('retry');
      gateway.clock.now = run.deadline + 1_000;
      expect(
        (
          await gateway.interactions(
            interaction(run, STATUS_ACTION_ID, {
              user: 'UOTHER1',
              actionTs: '1800000061.500000',
              sentAt: gateway.clock.now,
            }),
          )
        ).status,
      ).toBe(200);
      await gateway.flush();
      expect(claimSavedResult).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ runId: run.runId }),
        output,
        run.execution,
      );
      expect(await gateway.store.getRun(run.runId)).toMatchObject({
        state: 'accepted',
      });
      expect(SlackAdapter.prototype.postMessage).toHaveBeenCalledOnce();
    });

    it('records exact exit proof and releases an expired run with no saved result', async () => {
      const inspect = vi.fn().mockResolvedValue({ state: 'exited' as const });
      const releaseRecoveredWorker = vi.fn(async () => {});
      const { gateway, run } = await startControlled(
        inspect,
        [],
        releaseRecoveredWorker,
      );
      gateway.clock.now = run.deadline + 1_000;
      expect(
        (
          await gateway.interactions(
            interaction(run, STATUS_ACTION_ID, {
              user: 'UOTHER1',
              actionTs: '1800000062.000000',
              sentAt: gateway.clock.now,
            }),
          )
        ).status,
      ).toBe(200);
      await gateway.flush();
      expect(await gateway.store.getRun(run.runId)).toMatchObject({
        state: 'interrupted',
        exitConfirmed: true,
      });
      expect(releaseRecoveredWorker).toHaveBeenCalledOnce();
    });

    it('releases terminal recovery after a callback wins an in-flight Status inspection', async () => {
      const entered = Promise.withResolvers<void>();
      const proof = Promise.withResolvers<WorkerInspection>();
      const inspect = vi.fn(async () => {
        entered.resolve();
        return proof.promise;
      });
      const releaseRecoveredWorker = vi.fn(async () => {});
      const { gateway, run, job } = await startControlled(
        inspect,
        [],
        releaseRecoveredWorker,
      );
      expect(
        (await gateway.interactions(interaction(run, STATUS_ACTION_ID))).status,
      ).toBe(200);
      const statusTask = gateway.tasks.shift()!;
      const status = statusTask();
      await entered.promise;

      const terminal = result(job);
      expect(
        (await gateway.callback(callback(terminal, job.callbackToken))).status,
      ).toBe(202);
      await gateway.flush();
      expect(releaseRecoveredWorker).toHaveBeenCalledOnce();

      proof.resolve({ state: 'exited', result: terminal });
      await status;
      expect(releaseRecoveredWorker).toHaveBeenCalledTimes(2);
      expect(await gateway.store.getRun(run.runId)).toMatchObject({
        state: 'completed',
        messageId: answerTs,
        exitConfirmed: true,
      });
      expect(SlackAdapter.prototype.postMessage).toHaveBeenCalledTimes(2);
      expect(SlackAdapter.prototype.editMessage).toHaveBeenLastCalledWith(
        expect.any(String),
        statusTs,
        expect.objectContaining({
          children: [
            expect.objectContaining({
              content: 'Completed. The result is in this thread.',
            }),
          ],
        }),
      );
    });

    it('records timestamp-ordered thumbs only on a final answer, without a worker dispatch', async () => {
      const inspect = vi.fn();
      const { gateway, run, job } = await startControlled(inspect);
      const react = (
        reaction: string,
        type: string,
        order: number,
        ts = answerTs,
        user = 'UOTHER1',
      ) =>
        signed(
          {
            type: 'event_callback',
            team_id: run.workspaceId,
            event_id: `Ev${randomUUID()}`,
            is_ext_shared_channel: false,
            event: {
              type,
              user,
              reaction,
              item_user: 'UBOT1',
              item: { type: 'message', channel: run.channelId, ts },
              event_ts: `1800000003.${String(order).padStart(6, '0')}`,
            },
          },
          controlNow,
        );

      expect(
        (await gateway.callback(callback(result(job), job.callbackToken)))
          .status,
      ).toBe(202);
      await gateway.flush();
      for (const request of [
        react('+1', 'reaction_added', 1, run.messageTs),
        react('+1', 'reaction_added', 1, statusTs),
        react('+1', 'reaction_added', 1, answerTs, 'UBOT1'),
        react('+1', 'reaction_added', 1, answerTs, 'UEXTERNAL'),
        react('+1', 'reaction_added', 2),
        react('-1', 'reaction_added', 3),
        react('+1', 'reaction_added', 2),
      ])
        expect((await gateway.events(request)).status).toBe(200);
      await gateway.flush();
      expect(await gateway.store.getRun(run.runId)).toMatchObject({
        feedback: {
          UOTHER1: {
            thumbsup: { active: true, eventTs: '1800000003.000002' },
            thumbsdown: { active: true, eventTs: '1800000003.000003' },
          },
        },
      });
      const removal = react('+1', 'reaction_removed', 5);
      historyFetch.mockRejectedValueOnce(new Error('Synthetic Slack outage'));
      expect((await gateway.events(removal.clone())).status).toBe(503);
      expect(
        (await gateway.store.getRun(run.runId))?.feedback?.UOTHER1?.thumbsup
          ?.active,
      ).toBe(true);
      for (const request of [
        removal,
        react('-1', 'reaction_removed', 6),
        react('+1', 'reaction_added', 4),
        react('-1', 'reaction_removed', 6),
      ])
        expect((await gateway.events(request)).status).toBe(200);
      await gateway.flush();
      expect((await gateway.store.getRun(run.runId))?.feedback).toEqual({
        UOTHER1: {
          thumbsup: { active: false, eventTs: '1800000003.000005' },
          thumbsdown: { active: false, eventTs: '1800000003.000006' },
        },
      });
      expect(gateway.dispatch).toHaveBeenCalledTimes(1);
      expect(inspect).not.toHaveBeenCalled();
      expect(SlackAdapter.prototype.postMessage).toHaveBeenCalledTimes(2);
    });

    it('reconciles early feedback only when its exact message is indexed as the answer', async () => {
      const { gateway, run, job } = await startControlled(vi.fn());
      vi.spyOn(SlackAdapter.prototype, 'botUserId', 'get').mockReturnValue(
        'UBOT1',
      );
      const posted = Promise.withResolvers<void>();
      const index = Promise.withResolvers<void>();
      const complete = gateway.store.completePublication.bind(gateway.store);
      vi.spyOn(gateway.store, 'completePublication').mockImplementation(
        async (...args) => {
          posted.resolve();
          await index.promise;
          return complete(...args);
        },
      );

      expect(
        (await gateway.callback(callback(result(job), job.callbackToken)))
          .status,
      ).toBe(202);
      const publication = gateway.tasks.shift()!();
      await posted.promise;
      const react = (ts: string, type: string, eventTs: string) =>
        signed(
          {
            type: 'event_callback',
            team_id: run.workspaceId,
            event_id: `Ev${randomUUID()}`,
            is_ext_shared_channel: false,
            event: {
              type,
              user: 'UOTHER1',
              item_user: 'UBOT1',
              reaction: '+1',
              item: { type: 'message', channel: run.channelId, ts },
              event_ts: eventTs,
            },
          },
          controlNow,
        );
      for (const request of [
        react(statusTs, 'reaction_added', '1800000003.000003'),
        react(answerTs, 'reaction_removed', '1800000003.000002'),
        react(answerTs, 'reaction_added', '1800000003.000001'),
      ])
        expect((await gateway.events(request)).status).toBe(200);
      await gateway.flush();
      expect((await gateway.store.getRun(run.runId))?.feedback).toBeUndefined();
      index.resolve();
      await publication;
      expect((await gateway.store.getRun(run.runId))?.feedback).toEqual({
        UOTHER1: {
          thumbsup: { active: false, eventTs: '1800000003.000002' },
        },
      });
      expect(gateway.dispatch).toHaveBeenCalledTimes(1);
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
      event.thread_ts = '1799999999.000001';
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

    it('acknowledges an accepted mention after the HTTP response with one eyes reaction and one status', async () => {
      const gateway = harness(
        createMockState(),
        false,
        undefined,
        {},
        undefined,
        true,
      );
      const body = envelope();
      const response = await gateway.events(signed(body));

      expect(response.status).toBe(200);
      expect(SlackAdapter.prototype.initialize).not.toHaveBeenCalled();
      expect(SlackAdapter.prototype.postMessage).not.toHaveBeenCalled();
      expect(SlackAdapter.prototype.addReaction).not.toHaveBeenCalled();

      await gateway.flush();

      const run = await gateway.run();
      const threadId = `slack:CTEST1:${body.event.ts}`;
      expect(
        SlackAdapter.prototype.postMessage,
      ).toHaveBeenCalledExactlyOnceWith(threadId, STARTING_STATUS);
      expect(
        SlackAdapter.prototype.addReaction,
      ).toHaveBeenCalledExactlyOnceWith(
        threadId,
        body.event.ts,
        expect.objectContaining({ name: 'eyes' }),
      );
      expect(await gateway.store.getRun(run!.runId)).toMatchObject({
        statusClaimed: true,
        statusMessageId: '1800000001.000001',
      });

      await gateway.events(signed(body));
      await gateway.flush();
      expect(SlackAdapter.prototype.postMessage).toHaveBeenCalledTimes(1);
      expect(SlackAdapter.prototype.addReaction).toHaveBeenCalledTimes(1);
      expect(gateway.dispatch).toHaveBeenCalledTimes(1);
    });

    it('retries transient bot initialization before claiming and posting one acknowledgement', async () => {
      const initialize = vi.mocked(SlackAdapter.prototype.initialize);
      initialize.mockRejectedValueOnce(
        new Error('Synthetic initialization timeout'),
      );
      const gateway = harness(
        createMockState(),
        false,
        undefined,
        {},
        undefined,
        true,
      );
      const body = envelope();

      expect((await gateway.events(signed(body))).status).toBe(200);
      await gateway.flush();

      const threadId = `slack:CTEST1:${body.event.ts}`;
      expect(initialize.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(
        SlackAdapter.prototype.postMessage,
      ).toHaveBeenCalledExactlyOnceWith(threadId, STARTING_STATUS);
      expect(
        SlackAdapter.prototype.addReaction,
      ).toHaveBeenCalledExactlyOnceWith(
        threadId,
        body.event.ts,
        expect.objectContaining({ name: 'eyes' }),
      );
      expect(
        await gateway.store.getRun((await gateway.run())!.runId),
      ).toMatchObject({
        statusClaimed: true,
        statusMessageId: '1800000001.000001',
      });
    });

    it('waits for the reaction after a status-post failure without creating another status', async () => {
      const reactionStarted = Promise.withResolvers<void>();
      const reaction = Promise.withResolvers<void>();
      vi.mocked(SlackAdapter.prototype.postMessage).mockRejectedValueOnce(
        new Error('Synthetic status post failure'),
      );
      vi.mocked(SlackAdapter.prototype.addReaction).mockImplementationOnce(
        async () => {
          reactionStarted.resolve();
          await reaction.promise;
        },
      );
      const gateway = harness(
        createMockState(),
        false,
        undefined,
        {},
        undefined,
        true,
      );
      const body = envelope();
      expect((await gateway.events(signed(body))).status).toBe(200);
      let backgroundFinished = false;
      const background = gateway.tasks.shift()!().finally(() => {
        backgroundFinished = true;
      });
      await reactionStarted.promise;

      expect(backgroundFinished).toBe(false);
      await gateway.events(signed(body));
      expect(gateway.tasks).toHaveLength(0);
      expect(SlackAdapter.prototype.postMessage).toHaveBeenCalledTimes(1);

      reaction.resolve();
      await background;
      const run = await gateway.run();
      expect(await gateway.store.getRun(run!.runId)).toMatchObject({
        statusClaimed: true,
      });
      expect(await gateway.store.getRun(run!.runId)).not.toHaveProperty(
        'statusMessageId',
      );
      expect(SlackAdapter.prototype.addReaction).toHaveBeenCalledTimes(1);
      expect(SlackAdapter.prototype.postMessage).toHaveBeenCalledTimes(1);
      expect(gateway.dispatch).toHaveBeenCalledTimes(1);
    });

    it('dispatches while Slack is slow and reconciles completion after the status ID is saved', async () => {
      const gateway = harness(
        createMockState(),
        false,
        undefined,
        {},
        undefined,
        true,
      );
      const statusStarted = Promise.withResolvers<void>();
      const statusPost = Promise.withResolvers<{
        id: string;
        threadId: string;
        raw: object;
      }>();
      const dispatched = Promise.withResolvers<WorkerJob>();
      gateway.dispatch.mockImplementation(async (job) => {
        dispatched.resolve(job);
      });
      vi.mocked(SlackAdapter.prototype.postMessage).mockImplementation(
        async (threadId, message) => {
          if (message === STARTING_STATUS) {
            statusStarted.resolve();
            return statusPost.promise;
          }
          return { id: '1800000001.000002', threadId, raw: {} };
        },
      );

      const body = envelope();
      expect((await gateway.events(signed(body))).status).toBe(200);
      let backgroundFinished = false;
      const background = gateway.tasks.shift()!().finally(() => {
        backgroundFinished = true;
      });
      const job = await dispatched.promise;
      await statusStarted.promise;
      expect(backgroundFinished).toBe(false);

      expect(
        (await gateway.callback(callback(result(job), job.callbackToken)))
          .status,
      ).toBe(202);
      await gateway.tasks.shift()!();
      expect(await gateway.store.getRun(job.runId)).toMatchObject({
        state: 'completed',
        messageId: '1800000001.000002',
      });
      expect(await gateway.store.getRun(job.runId)).not.toHaveProperty(
        'statusMessageId',
      );

      statusPost.resolve({
        id: '1800000001.000001',
        threadId: `slack:CTEST1:${body.event.ts}`,
        raw: {},
      });
      await background;

      expect(await gateway.store.getRun(job.runId)).toMatchObject({
        state: 'completed',
        statusMessageId: '1800000001.000001',
      });
      expect(SlackAdapter.prototype.postMessage).toHaveBeenCalledTimes(2);
      expect(SlackAdapter.prototype.editMessage).toHaveBeenLastCalledWith(
        `slack:CTEST1:${body.event.ts}`,
        '1800000001.000001',
        'Completed. The result is in this thread.',
      );
    });

    it('does not acknowledge refused, bot, or busy input as another accepted run', async () => {
      const gateway = harness(
        createMockState(),
        true,
        undefined,
        {},
        undefined,
        true,
      );
      const accepted = envelope();
      await gateway.events(signed(accepted));
      await gateway.flush();

      const bot = envelope();
      (bot.event as typeof bot.event & { bot_id?: string }).bot_id =
        'BSYNTHETIC';
      await gateway.events(signed(bot));
      await gateway.events(signed(threadReply(accepted.event.ts)));
      await gateway.flush();

      expect(SlackAdapter.prototype.addReaction).toHaveBeenCalledTimes(1);
      expect(SlackAdapter.prototype.postMessage).toHaveBeenCalledTimes(2);
      expect(SlackAdapter.prototype.postMessage).toHaveBeenLastCalledWith(
        `slack:CTEST1:${accepted.event.ts}`,
        BUSY_REPLY,
      );
      expect(gateway.dispatch).toHaveBeenCalledTimes(1);
    });

    it('publishes a refusal without creating an acknowledgement status or reaction', async () => {
      const gateway = harness(
        createMockState(),
        false,
        undefined,
        { publicUrlInput: true },
        undefined,
        true,
      );
      const body = envelope();
      body.event.text = '<@UBOT1> Read <https://127.0.0.1/private.txt>.';

      expect((await gateway.events(signed(body))).status).toBe(200);
      await gateway.flush();

      expect(gateway.dispatch).not.toHaveBeenCalled();
      expect(SlackAdapter.prototype.addReaction).not.toHaveBeenCalled();
      expect(
        SlackAdapter.prototype.postMessage,
      ).toHaveBeenCalledExactlyOnceWith(
        `slack:CTEST1:${body.event.ts}`,
        'That URL points to a private or restricted network address.',
      );
      const run = await gateway.run();
      expect(await gateway.store.getRun(run!.runId)).not.toHaveProperty(
        'statusClaimed',
      );
    });

    it('imports one permitted page of earlier messages after acknowledgement and deduplication', async () => {
      const gateway = harness(
        createMockState(),
        true,
        undefined,
        {},
        undefined,
        true,
      );
      const root = '1799999999.000001';
      const earlier = '1799999999.000002';
      const fixture = envelope();
      const body = {
        ...fixture,
        event: { ...fixture.event, thread_ts: root },
      };
      historyFetch.mockResolvedValueOnce(
        Response.json({
          ok: true,
          response_metadata: { next_cursor: 'unused' },
          messages: [
            {
              ...historyMessage(body.event.ts, 'Trigger duplicate.'),
              thread_ts: root,
            },
            {
              ...historyMessage(
                earlier,
                'Earlier <https://example.test/signed|file> xoxb-synthetic-placeholder.',
              ),
              thread_ts: root,
              user: 'UTEST2',
              files: [
                {
                  id: 'FTEST1',
                  mimetype: 'text/plain',
                  size: 42,
                  url_private_download:
                    'https://example.test/download?signature=hidden',
                },
              ],
            },
            {
              ...historyMessage('1800000001.000001', 'Later.'),
              thread_ts: root,
            },
            {
              ...historyMessage('1799999999.000003', 'Different root.'),
              thread_ts: '1799999999.000000',
            },
            {
              ...historyMessage('1799999999.000004', 'Different channel.'),
              thread_ts: root,
              channel: 'COTHER',
            },
            {
              ...historyMessage('1799999999.000005', 'External participant.'),
              thread_ts: root,
              user_team: 'TOTHER',
            },
            historyMessage(root),
          ],
        }),
      );
      const responses = await Promise.all([
        gateway.events(signed(body)),
        gateway.events(signed(body)),
      ]);
      expect(responses.map((r) => r.status)).toEqual([200, 200]);
      await gateway.events(signed({ ...body, event_id: 'EvDIFFERENT' }));
      expect(historyFetch).not.toHaveBeenCalled();
      expect(await gateway.owner(root)).toBe((await gateway.run())!.runId);
      await gateway.flush();

      expect(historyFetch).toHaveBeenCalledTimes(1);
      const [url, request] = historyFetch.mock.calls[0]!;
      expect(String(url)).toBe('https://slack.com/api/conversations.replies');
      expect(
        Object.fromEntries(new URLSearchParams(String(request?.body))),
      ).toEqual({
        channel: 'CTEST1',
        ts: root,
        latest: body.event.ts,
        inclusive: 'false',
        limit: '20',
      });
      expect(new Headers(request?.headers).get('authorization')).toBe(
        'Bearer synthetic-bot-token',
      );
      expect(request?.redirect).toBe('error');
      expect(request?.signal).toBeInstanceOf(AbortSignal);
      expect(gateway.dispatch).toHaveBeenCalledTimes(1);
      const seed = gateway.dispatch.mock.calls[0]![0];
      expect(seed.input).toEqual({
        workspaceId: 'TTEST1',
        channelId: 'CTEST1',
        threadTs: root,
        messageTs: body.event.ts,
        senderId: 'UTEST1',
        text: body.event.text,
        threadContext: {
          truncated: true,
          messages: [
            { messageTs: root, senderId: 'UTEST1', text: 'Synthetic root.' },
            {
              messageTs: earlier,
              senderId: 'UTEST2',
              text: 'Earlier [link omitted] [Slack token omitted].',
              attachments: [{ id: 'FTEST1', mimeType: 'text/plain', size: 42 }],
            },
          ],
        },
      });
      expect(
        JSON.stringify(await gateway.store.getRun(seed.runId)),
      ).not.toContain('Synthetic root.');
      expect(SlackAdapter.prototype.addReaction).toHaveBeenCalledTimes(1);

      const busy = threadReply(root);
      await gateway.events(signed(busy));
      await gateway.flush();
      expect(SlackAdapter.prototype.postMessage).toHaveBeenLastCalledWith(
        `slack:CTEST1:${root}`,
        BUSY_REPLY,
      );

      const published = envelope().event.ts;
      vi.mocked(SlackAdapter.prototype.postMessage).mockResolvedValueOnce({
        id: published,
        threadId: `slack:CTEST1:${root}`,
        raw: {},
      });
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

      const next = threadReply(root);
      await gateway.events(signed(next));
      await gateway.flush();
      const followup = gateway.dispatch.mock.calls[1]![0];
      expect(followup).toMatchObject({
        conversationId: seed.conversationId,
        session,
        input: { text: next.event.text },
      });
      expect(followup.input).not.toHaveProperty('threadContext');

      await gateway.events(signed(envelope()));
      await gateway.flush();
      const independent = gateway.dispatch.mock.calls[2]![0];
      expect(independent.session).toBeUndefined();
      expect(independent.input).not.toHaveProperty('threadContext');
      expect(independent.conversationId).not.toBe(seed.conversationId);
      expect(historyFetch).toHaveBeenCalledTimes(1);
    });

    it('keeps safe attachment metadata for a file-only root and the distinct request', async () => {
      const root = '1799999999.000001';
      historyFetch.mockResolvedValueOnce(
        Response.json({
          ok: true,
          messages: [
            {
              type: 'message',
              ts: root,
              user: 'UTEST1',
              subtype: 'file_share',
              files: Array.from({ length: 6 }, (_, i) => ({
                id: `FHISTORY${i}`,
                mimetype: 'invalid optional media type',
                url_private: 'https://example.test/signed-history',
              })),
            },
          ],
        }),
      );
      const mention = envelope();
      const gateway = harness();
      await gateway.events(
        signed({
          ...mention,
          event: {
            ...mention.event,
            thread_ts: root,
            files: [
              {
                id: 'FREQUEST1',
                mimetype: 'text/plain',
                size: 0,
                url_private_download: 'https://example.test/signed-request',
              },
            ],
          },
        }),
      );
      await gateway.flush();

      const job = workerJobSchema.parse(gateway.dispatch.mock.calls[0]![0]);
      expect(job.input.attachments).toEqual([
        { id: 'FREQUEST1', mimeType: 'text/plain', size: 0 },
      ]);
      expect(job.input.threadContext).toEqual({
        truncated: true,
        messages: [
          {
            messageTs: root,
            senderId: 'UTEST1',
            text: '',
            attachments: Array.from({ length: 5 }, (_, i) => ({
              id: `FHISTORY${i}`,
            })),
          },
        ],
      });
      expect(historyFetch).toHaveBeenCalledTimes(1);
    });

    it.each(['missing_scope', 'rate limit', 'transport', 'empty'])(
      'reports unavailable history (%s) once and releases the thread for a fresh mention',
      async (reason) => {
        if (reason === 'transport')
          historyFetch.mockRejectedValueOnce(new Error('synthetic timeout'));
        else
          historyFetch.mockResolvedValueOnce(
            reason === 'empty'
              ? Response.json({ ok: true, messages: [] })
              : Response.json(
                  { ok: false, error: reason },
                  { status: reason === 'rate limit' ? 429 : 200 },
                ),
          );
        const root = '1799999999.000001';
        const first = envelope();
        const body = { ...first, event: { ...first.event, thread_ts: root } };
        const gateway = harness();
        expect((await gateway.events(signed(body))).status).toBe(200);
        await gateway.flush();
        expect(gateway.dispatch).not.toHaveBeenCalled();
        expect(SlackAdapter.prototype.addReaction).not.toHaveBeenCalled();
        expect(
          SlackAdapter.prototype.postMessage,
        ).toHaveBeenCalledExactlyOnceWith(
          `slack:CTEST1:${root}`,
          'I could not read the earlier messages in this thread. Your request was not submitted. Mention me again in this thread to retry.',
        );
        expect(await gateway.owner(root)).toBeNull();
        expect((await gateway.events(signed(body))).status).toBe(200);
        await gateway.flush();
        expect(historyFetch).toHaveBeenCalledTimes(1);

        const retry = envelope();
        await gateway.events(
          signed({ ...retry, event: { ...retry.event, thread_ts: root } }),
        );
        await gateway.flush();
        expect(historyFetch).toHaveBeenCalledTimes(2);
        expect(gateway.dispatch).toHaveBeenCalledTimes(1);
      },
    );

    it.each(['count', 'bytes'])(
      'cuts history at the %s limit',
      async (limit) => {
        const root = '1799999999.000001';
        const messages = Array.from({ length: 21 }, (_, i) => ({
          ...historyMessage(
            `1799999999.${String(i + 1).padStart(6, '0')}`,
            limit === 'bytes' ? 'あ'.repeat(1_000) : 'Short message.',
          ),
          thread_ts: root,
        }));
        historyFetch.mockResolvedValueOnce(
          Response.json({ ok: true, messages: messages.reverse() }),
        );
        const mention = envelope();
        const gateway = harness();
        await gateway.events(
          signed({ ...mention, event: { ...mention.event, thread_ts: root } }),
        );
        await gateway.flush();
        const context = gateway.dispatch.mock.calls[0]![0].input.threadContext!;
        expect(context.truncated).toBe(true);
        expect(context.messages[0]?.messageTs).toBe(root);
        expect(context.messages).toHaveLength(limit === 'bytes' ? 7 : 20);
        expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThanOrEqual(
          16_384,
        );
        for (const message of context.messages) {
          expect(Buffer.byteLength(message.text)).toBeLessThanOrEqual(2048);
          expect(message.text).not.toContain('�');
        }
      },
    );

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

    it('recovers the artifact and releases the replacement when a lost worker callback arrives late', async () => {
      const csv = Buffer.from('label,value\nsynthetic,1\n');
      const collectArtifact = vi.fn(
        async (_runId: string, target: SandboxTarget) => {
          if (target.sessionId !== replacement.sessionId)
            throw new Error('The original worker is unavailable');
          return csv;
        },
      );
      let failRelease = true;
      const releaseRecoveredWorker = vi.fn(async (run: RunRecord) => {
        if (failRelease) {
          failRelease = false;
          throw new Error('Synthetic recovery release outage');
        }
        await gateway.store.releaseRecoveryTarget(run);
      });
      const gateway = harness(
        createMockState(),
        false,
        undefined,
        { csvOutput: true },
        collectArtifact,
        false,
        {
          inspectWorker: async () => ({ state: 'unknown' }),
          releaseRecoveredWorker,
        },
      );
      const body = envelope();
      await gateway.events(signed(body));
      await gateway.flush();
      const job = gateway.dispatch.mock.calls[0]![0];
      const lost = {
        sandboxName: 'synthetic-late-worker',
        sessionId: randomUUID(),
      };
      const replacement = {
        sandboxName: lost.sandboxName,
        sessionId: randomUUID(),
      };
      await Promise.all([
        gateway.store.enrollIdleSession(lost),
        gateway.store.enrollIdleSession(replacement),
      ]);
      expect(await gateway.store.recordDispatchTarget(job, lost)).toBe(
        'recorded',
      );
      expect(await gateway.store.fenceLostTarget(lost)).toBe(true);
      expect(await gateway.store.bindRecoveryTarget(lost, replacement)).toBe(
        true,
      );
      const output = {
        ...result(job),
        artifact: { sha256: createHash('sha256').update(csv).digest('hex') },
        session: {
          seedRunId: job.runId,
          nativeId: randomUUID(),
          adapterId: randomUUID(),
          revision: 1,
        },
      };

      expect(
        (await gateway.callback(callback(output, job.callbackToken))).status,
      ).toBe(202);
      await gateway.flush();
      expect(collectArtifact).toHaveBeenCalledExactlyOnceWith(
        job.runId,
        replacement,
        undefined,
      );
      expect(SlackAdapter.prototype.postMessage).toHaveBeenNthCalledWith(
        2,
        'slack:CTEST1:' + body.event.ts,
        {
          markdown: '',
          files: [{ data: csv, filename: 'result.csv', mimeType: 'text/csv' }],
        },
      );
      expect(releaseRecoveredWorker).toHaveBeenCalledOnce();
      expect(await gateway.store.getRun(job.runId)).toMatchObject({
        state: 'completed',
        execution: lost,
        recovery: replacement,
      });
      expect(await gateway.store.claimIdleStop(replacement, randomUUID())).toBe(
        'active',
      );

      expect(
        (await gateway.callback(callback(output, job.callbackToken))).status,
      ).toBe(204);
      await gateway.flush();
      expect(releaseRecoveredWorker).toHaveBeenCalledTimes(2);
      expect(await gateway.store.claimIdleStop(replacement, randomUUID())).toBe(
        'claimed',
      );
    });

    it('retries artifact collection when recovery binds after the final lookup', async () => {
      const csv = Buffer.from('label,value\nsynthetic,1\n');
      const lost = {
        sandboxName: 'synthetic-racing-worker',
        sessionId: randomUUID(),
      };
      const replacement = {
        sandboxName: lost.sandboxName,
        sessionId: randomUUID(),
      };
      const collectArtifact = vi.fn(
        async (_runId: string, target: SandboxTarget) => {
          if (target.sessionId !== replacement.sessionId)
            throw new Error('The original worker is unavailable');
          return csv;
        },
      );
      const gateway = harness(
        createMockState(),
        false,
        undefined,
        { csvOutput: true },
        collectArtifact,
      );
      const body = envelope();
      await gateway.events(signed(body));
      await gateway.flush();
      const job = gateway.dispatch.mock.calls[0]![0];
      await Promise.all([
        gateway.store.enrollIdleSession(lost),
        gateway.store.enrollIdleSession(replacement),
      ]);
      expect(await gateway.store.recordDispatchTarget(job, lost)).toBe(
        'recorded',
      );
      const claimPublication = gateway.store.claimPublication.bind(
        gateway.store,
      );
      vi.spyOn(gateway.store, 'claimPublication').mockImplementationOnce(
        async (...args) => {
          expect(await gateway.store.fenceLostTarget(lost)).toBe(true);
          expect(
            await gateway.store.bindRecoveryTarget(lost, replacement),
          ).toBe(true);
          return claimPublication(...args);
        },
      );
      const output = {
        ...result(job),
        artifact: { sha256: createHash('sha256').update(csv).digest('hex') },
        session: {
          seedRunId: job.runId,
          nativeId: randomUUID(),
          adapterId: randomUUID(),
          revision: 1,
        },
      };

      expect(
        (await gateway.callback(callback(output, job.callbackToken))).status,
      ).toBe(503);
      expect(collectArtifact).toHaveBeenCalledExactlyOnceWith(
        job.runId,
        lost,
        undefined,
      );
      expect(await gateway.store.getRun(job.runId)).toMatchObject({
        state: 'accepted',
        execution: lost,
        recovery: replacement,
      });

      expect(
        (await gateway.callback(callback(output, job.callbackToken))).status,
      ).toBe(202);
      await gateway.flush();
      expect(collectArtifact).toHaveBeenLastCalledWith(
        job.runId,
        replacement,
        undefined,
      );
      expect(SlackAdapter.prototype.postMessage).toHaveBeenNthCalledWith(
        2,
        'slack:CTEST1:' + body.event.ts,
        {
          markdown: '',
          files: [{ data: csv, filename: 'result.csv', mimeType: 'text/csv' }],
        },
      );
    });

    it('shows finishing while the final answer is still publishing, then completes', async () => {
      const gateway = harness(
        createMockState(),
        false,
        undefined,
        {},
        undefined,
        true,
      );
      const body = envelope();
      await gateway.events(signed(body));
      await gateway.flush();
      const job = gateway.dispatch.mock.calls[0]![0];
      const answerStarted = Promise.withResolvers<void>();
      const answer = Promise.withResolvers<{
        id: string;
        threadId: string;
        raw: object;
      }>();
      vi.mocked(SlackAdapter.prototype.postMessage).mockImplementationOnce(
        async () => {
          answerStarted.resolve();
          return answer.promise;
        },
      );
      const edit = vi.mocked(SlackAdapter.prototype.editMessage);
      edit.mockClear();

      expect(
        (await gateway.callback(callback(result(job), job.callbackToken)))
          .status,
      ).toBe(202);
      const publishing = gateway.tasks.shift()!();
      await answerStarted.promise;
      await vi.waitFor(() => {
        expect(edit).toHaveBeenLastCalledWith(
          `slack:CTEST1:${body.event.ts}`,
          '1800000001.000001',
          'Finishing: publishing the result…',
        );
      });

      answer.resolve({
        id: '1800000001.000002',
        threadId: `slack:CTEST1:${body.event.ts}`,
        raw: {},
      });
      await publishing;

      expect(edit).toHaveBeenLastCalledWith(
        `slack:CTEST1:${body.event.ts}`,
        '1800000001.000001',
        'Completed. The result is in this thread.',
      );
    });

    it('accepts authenticated content-free progress once and rejects malformed or terminal-late progress', async () => {
      const gateway = harness(
        createMockState(),
        false,
        undefined,
        {},
        undefined,
        true,
      );
      const target = { sandboxName: 'test-worker', sessionId: 'test-session' };
      gateway.dispatch.mockImplementation(async (job) => {
        expect(await gateway.store.recordDispatchTarget(job, target)).toBe(
          'recorded',
        );
      });
      await gateway.events(signed(envelope()));
      await gateway.flush();
      const job = gateway.dispatch.mock.calls[0]![0];
      const update = progress(job);

      expect(
        (
          await gateway.callback(
            callback(
              { ...update, text: 'private tool detail' },
              job.callbackToken,
            ),
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await gateway.callback(
            callback({ ...update, generation: 2 }, job.callbackToken),
          )
        ).status,
      ).toBe(409);
      expect(
        (await gateway.callback(callback(update, 'f'.repeat(64)))).status,
      ).toBe(401);
      expect(
        (await gateway.callback(callback(update, job.callbackToken))).status,
      ).toBe(204);
      await gateway.flush();
      expect(SlackAdapter.prototype.editMessage).toHaveBeenLastCalledWith(
        expect.stringMatching(/^slack:CTEST1:/),
        '1800000001.000001',
        'Working…',
      );

      expect(
        (await gateway.callback(callback(update, job.callbackToken))).status,
      ).toBe(204);
      await gateway.flush();
      expect(SlackAdapter.prototype.editMessage).toHaveBeenCalledTimes(3);
      expect(SlackAdapter.prototype.postMessage).toHaveBeenCalledTimes(1);
      expect(await gateway.store.getRun(job.runId)).toMatchObject({
        statusMessageId: '1800000001.000001',
        progress: { eventId: update.eventId },
      });

      const completed = { ...result(job), sequence: 2 as const };
      expect(
        (await gateway.callback(callback(completed, job.callbackToken))).status,
      ).toBe(202);
      await gateway.flush();
      expect(
        (await gateway.callback(callback(progress(job), job.callbackToken)))
          .status,
      ).toBe(409);
      expect(SlackAdapter.prototype.editMessage).toHaveBeenLastCalledWith(
        expect.stringMatching(/^slack:CTEST1:/),
        '1800000001.000001',
        'Completed. The result is in this thread.',
      );
    });

    it('repairs a working edit when completion lands during the Slack call', async () => {
      const gateway = harness(
        createMockState(),
        false,
        undefined,
        {},
        undefined,
        true,
      );
      const target = { sandboxName: 'test-worker', sessionId: 'test-session' };
      gateway.dispatch.mockImplementation(async (job) => {
        await gateway.store.recordDispatchTarget(job, target);
      });
      await gateway.events(signed(envelope()));
      await gateway.flush();
      const job = gateway.dispatch.mock.calls[0]![0];
      const workingEdit = Promise.withResolvers<void>();
      const workingStarted = Promise.withResolvers<void>();
      vi.mocked(SlackAdapter.prototype.editMessage).mockImplementationOnce(
        async (threadId, messageId) => {
          workingStarted.resolve();
          await workingEdit.promise;
          return { id: messageId, threadId, raw: {} };
        },
      );

      expect(
        (await gateway.callback(callback(progress(job), job.callbackToken)))
          .status,
      ).toBe(204);
      const renderWorking = gateway.tasks.shift()!();
      await workingStarted.promise;

      const completed = { ...result(job), sequence: 2 as const };
      expect(
        (await gateway.callback(callback(completed, job.callbackToken))).status,
      ).toBe(202);
      await gateway.tasks.shift()!();
      workingEdit.resolve();
      await renderWorking;

      const edits = vi.mocked(SlackAdapter.prototype.editMessage).mock.calls;
      expect(edits.some(([, , text]) => text === 'Working…')).toBe(true);
      expect(
        edits.every(([, messageId]) => messageId === '1800000001.000001'),
      ).toBe(true);
      expect(SlackAdapter.prototype.editMessage).toHaveBeenLastCalledWith(
        expect.stringMatching(/^slack:CTEST1:/),
        '1800000001.000001',
        'Completed. The result is in this thread.',
      );
    });

    it('retries a transient status edit against the same persisted message', async () => {
      const gateway = harness(
        createMockState(),
        false,
        undefined,
        {},
        undefined,
        true,
      );
      const target = { sandboxName: 'test-worker', sessionId: 'test-session' };
      gateway.dispatch.mockImplementation(async (job) => {
        await gateway.store.recordDispatchTarget(job, target);
      });
      await gateway.events(signed(envelope()));
      await gateway.flush();
      const job = gateway.dispatch.mock.calls[0]![0];
      const edit = vi.mocked(SlackAdapter.prototype.editMessage);
      edit.mockClear();
      edit.mockRejectedValueOnce(new Error('Synthetic Slack timeout'));

      expect(
        (await gateway.callback(callback(progress(job), job.callbackToken)))
          .status,
      ).toBe(204);
      await gateway.flush();

      expect(edit).toHaveBeenCalledTimes(2);
      expect(edit).toHaveBeenNthCalledWith(
        1,
        expect.stringMatching(/^slack:CTEST1:/),
        '1800000001.000001',
        'Working…',
      );
      expect(edit).toHaveBeenNthCalledWith(
        2,
        expect.stringMatching(/^slack:CTEST1:/),
        '1800000001.000001',
        'Working…',
      );
      expect(SlackAdapter.prototype.postMessage).toHaveBeenCalledTimes(1);
    });

    it('creates a fresh single status when an ordinary reply resumes the saved session', async () => {
      const gateway = harness(
        createMockState(),
        true,
        undefined,
        {},
        undefined,
        true,
      );
      const mention = envelope();
      vi.mocked(SlackAdapter.prototype.postMessage).mockImplementation(
        async (threadId) => ({
          id: mention.event.ts,
          threadId,
          raw: {},
        }),
      );
      await gateway.events(signed(mention));
      await gateway.flush();
      const seed = gateway.dispatch.mock.calls[0]![0];
      const session = {
        seedRunId: seed.runId,
        nativeId: randomUUID(),
        adapterId: randomUUID(),
        revision: 4,
      };
      await gateway.callback(
        callback({ ...result(seed), session }, seed.callbackToken),
      );
      await gateway.flush();

      const reply = threadReply(mention.event.ts);
      await gateway.events(signed(reply));
      await gateway.flush();

      expect(gateway.dispatch).toHaveBeenCalledTimes(2);
      expect(gateway.dispatch.mock.calls[1]![0].session).toEqual(session);
      expect(SlackAdapter.prototype.addReaction).toHaveBeenCalledTimes(2);
      expect(SlackAdapter.prototype.addReaction).toHaveBeenLastCalledWith(
        `slack:CTEST1:${mention.event.ts}`,
        reply.event.ts,
        expect.objectContaining({ name: 'eyes' }),
      );
      const startingCalls = vi
        .mocked(SlackAdapter.prototype.postMessage)
        .mock.calls.filter(([, message]) => message === STARTING_STATUS);
      expect(startingCalls).toHaveLength(2);
    });

    it.each([
      [
        'startup',
        'Starting: worker startup is unconfirmed. The outcome is uncertain; ask the operator to inspect this run.',
      ],
      ['worker', 'Failed. See the reply in this thread for details.'],
      [
        'publication',
        'Failed to confirm result publication. Ask the operator to inspect this run before retrying.',
      ],
    ] as const)(
      'keeps the status truthful after a %s failure',
      async (outcome, status) => {
        const gateway = harness(
          createMockState(),
          false,
          undefined,
          {},
          undefined,
          true,
        );
        if (outcome === 'startup')
          gateway.dispatch.mockRejectedValueOnce(
            new Error('Synthetic dispatch response loss'),
          );
        const body = envelope();
        await gateway.events(signed(body));
        await gateway.flush();
        const job = gateway.dispatch.mock.calls[0]![0];

        if (outcome === 'worker') {
          const failure = { ...result(job), type: 'failed' as const };
          expect(
            (await gateway.callback(callback(failure, job.callbackToken)))
              .status,
          ).toBe(202);
          await gateway.flush();
        }
        if (outcome === 'publication') {
          vi.mocked(SlackAdapter.prototype.postMessage).mockRejectedValueOnce(
            new Error('Synthetic publication response loss'),
          );
          expect(
            (await gateway.callback(callback(result(job), job.callbackToken)))
              .status,
          ).toBe(202);
          await gateway.flush();
        }

        expect(SlackAdapter.prototype.editMessage).toHaveBeenLastCalledWith(
          `slack:CTEST1:${body.event.ts}`,
          '1800000001.000001',
          status,
        );
      },
    );

    it('reports an attachment failure without discarding the completed text result', async () => {
      const csv = Buffer.from('label,value\nsynthetic,1\n');
      const collectArtifact = vi.fn().mockResolvedValue(csv);
      const gateway = harness(
        createMockState(),
        false,
        undefined,
        { csvOutput: true },
        collectArtifact,
        true,
      );
      const body = envelope();
      await gateway.events(signed(body));
      await gateway.flush();
      const job = gateway.dispatch.mock.calls[0]![0];
      const target = { sandboxName: 'test-worker', sessionId: 'test-session' };
      expect(await gateway.store.recordDispatchTarget(job, target)).toBe(
        'recorded',
      );
      const output: WorkerResult = {
        ...result(job),
        artifact: { sha256: createHash('sha256').update(csv).digest('hex') },
        session: {
          seedRunId: job.runId,
          nativeId: randomUUID(),
          adapterId: randomUUID(),
          revision: 1,
        },
      };
      const post = vi.mocked(SlackAdapter.prototype.postMessage);
      post.mockResolvedValueOnce({
        id: '1800000001.000002',
        threadId: `slack:CTEST1:${body.event.ts}`,
        raw: {},
      });
      const uploadStarted = Promise.withResolvers<void>();
      const releaseUpload = Promise.withResolvers<void>();
      post.mockImplementationOnce(async () => {
        uploadStarted.resolve();
        await releaseUpload.promise;
        throw new Error('Synthetic upload failure');
      });

      expect(
        (await gateway.callback(callback(output, job.callbackToken))).status,
      ).toBe(202);
      const publishing = gateway.flush();
      await uploadStarted.promise;
      try {
        await vi.waitFor(() => {
          expect(SlackAdapter.prototype.editMessage).toHaveBeenLastCalledWith(
            `slack:CTEST1:${body.event.ts}`,
            '1800000001.000001',
            'Completed. The text result is in this thread. Attachment delivery is unconfirmed.',
          );
        });
        expect(await gateway.owner(body.event.ts)).toBeNull();
        expect(await gateway.store.getRun(job.runId)).toMatchObject({
          state: 'completed',
          result: { session: output.session },
          messageId: '1800000001.000002',
        });
      } finally {
        releaseUpload.resolve();
        await publishing;
      }

      expect(await gateway.store.getRun(job.runId)).toMatchObject({
        state: 'completed',
        artifactPublication: 'failed',
        messageId: '1800000001.000002',
      });
      expect(SlackAdapter.prototype.editMessage).toHaveBeenLastCalledWith(
        `slack:CTEST1:${body.event.ts}`,
        '1800000001.000001',
        'Completed. The text result is in this thread. Attachment delivery is unconfirmed.',
      );
    });

    it.each([
      'uploaded',
      'upload rejected',
      'upload unconfirmed',
      'collection rejected',
      'collection timed out',
      'execution target missing',
      'digest mismatched',
    ])('preserves the text reply with CSV outcome %s', async (outcome) => {
      const csv = Buffer.from('label,cents\r\néclair,17\r\n');
      const collectArtifact = vi.fn().mockResolvedValue(csv);
      if (outcome === 'collection rejected')
        collectArtifact.mockRejectedValue(new Error('Artifact is unavailable'));
      if (outcome === 'digest mismatched')
        collectArtifact.mockResolvedValue(Buffer.from('different bytes'));
      const gateway = harness(
        createMockState(),
        false,
        undefined,
        { csvOutput: true },
        collectArtifact,
      );
      const body = envelope();
      await gateway.events(signed(body));
      await gateway.flush();
      const job = gateway.dispatch.mock.calls[0]![0];
      if (outcome === 'collection timed out')
        collectArtifact.mockImplementation(async () => {
          gateway.clock.now = job.deadline;
          throw new Error('Artifact collection timed out');
        });
      expect(job.csvOutput).toBe(true);
      const target = { sandboxName: 'test-worker', sessionId: 'test-session' };
      if (outcome !== 'execution target missing')
        expect(await gateway.store.recordDispatchTarget(job, target)).toBe(
          'recorded',
        );
      const output: WorkerResult = {
        ...result(job),
        artifact: { sha256: createHash('sha256').update(csv).digest('hex') },
        session: {
          seedRunId: job.runId,
          nativeId: randomUUID(),
          adapterId: randomUUID(),
          revision: 1,
        },
      };
      const post = vi.mocked(SlackAdapter.prototype.postMessage);
      post.mockResolvedValueOnce({
        id: '1800000001.000001',
        threadId: 'synthetic-thread',
        raw: {},
      });
      if (outcome === 'upload rejected')
        post.mockRejectedValueOnce(new Error('Slack refused the upload'));
      if (outcome === 'uploaded' || outcome === 'upload unconfirmed')
        post.mockResolvedValueOnce({
          id: 'file-synthetic',
          threadId: 'synthetic-thread',
          raw: outcome === 'uploaded' ? { uploadedFileIds: ['FTEST'] } : {},
        });

      expect(
        (await gateway.callback(callback(output, 'f'.repeat(64)))).status,
      ).toBe(401);
      expect(
        (
          await gateway.callback(
            callback(
              {
                ...output,
                artifact: { ...output.artifact, path: '../result.csv' },
              },
              job.callbackToken,
            ),
          )
        ).status,
      ).toBe(400);
      expect(collectArtifact).not.toHaveBeenCalled();
      if (outcome === 'uploaded') {
        const collecting = Promise.withResolvers<void>();
        const collected = Promise.withResolvers<Buffer>();
        collectArtifact.mockImplementationOnce(() => {
          collecting.resolve();
          return collected.promise;
        });
        const first = gateway.callback(callback(output, job.callbackToken));
        await collecting.promise;
        const overlap = await gateway.callback(
          callback(output, job.callbackToken),
        );
        collected.resolve(csv);
        expect(overlap.status).toBe(503);
        expect((await first).status).toBe(202);
      } else {
        expect(
          (await gateway.callback(callback(output, job.callbackToken))).status,
        ).toBe(202);
      }
      gateway.clock.now = initialTime;
      expect(
        (await gateway.callback(callback(output, job.callbackToken))).status,
      ).toBe(204);
      expect(
        (
          await gateway.callback(
            callback(
              { ...output, artifact: { sha256: 'a'.repeat(64) } },
              job.callbackToken,
            ),
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await gateway.callback(
            callback({ ...output, artifact: undefined }, job.callbackToken),
          )
        ).status,
      ).toBe(409);
      await gateway.flush();

      const threadId = `slack:CTEST1:${body.event.ts}`;
      if (outcome === 'execution target missing')
        expect(collectArtifact).not.toHaveBeenCalled();
      else
        expect(collectArtifact).toHaveBeenCalledExactlyOnceWith(
          job.runId,
          target,
          undefined,
        );
      expect(post).toHaveBeenNthCalledWith(1, threadId, output.text);
      if (outcome.startsWith('upload'))
        expect(post).toHaveBeenNthCalledWith(2, threadId, {
          markdown: '',
          files: [{ data: csv, filename: 'result.csv', mimeType: 'text/csv' }],
        });
      if (outcome !== 'uploaded')
        expect(post).toHaveBeenLastCalledWith(
          threadId,
          'I could not confirm the result.csv attachment. The text result is above.',
        );
      expect(post).toHaveBeenCalledTimes(outcome.startsWith('upload ') ? 3 : 2);
      expect(await gateway.store.getRun(job.runId)).toMatchObject({
        state: 'completed',
        messageId: '1800000001.000001',
      });
    });

    it.each([
      ['md', 'text/markdown'],
      ['diff', 'text/plain'],
    ] as const)(
      'uploads a generated %s alongside the original answer',
      async (format, mimeType) => {
        const bytes = Buffer.from('Synthetic output\n');
        const collect = vi.fn().mockResolvedValue(bytes);
        const gateway = harness(
          createMockState(),
          false,
          undefined,
          { fileExchange: true },
          collect,
        );
        const body = envelope();
        await gateway.events(signed(body));
        await gateway.flush();
        const job = gateway.dispatch.mock.calls[0]![0];
        const target = {
          sandboxName: 'test-worker',
          sessionId: 'test-session',
        };
        expect(await gateway.store.recordDispatchTarget(job, target)).toBe(
          'recorded',
        );
        const output: WorkerResult = {
          ...result(job),
          artifact: {
            sha256: createHash('sha256').update(bytes).digest('hex'),
            format,
          },
          session: {
            seedRunId: job.runId,
            nativeId: randomUUID(),
            adapterId: randomUUID(),
            revision: 1,
          },
        };
        const post = vi.mocked(SlackAdapter.prototype.postMessage);
        post.mockResolvedValueOnce({
          id: '1800000001.000001',
          threadId: 'synthetic-thread',
          raw: {},
        });
        post.mockResolvedValueOnce({
          id: 'file-synthetic',
          threadId: 'synthetic-thread',
          raw: { uploadedFileIds: ['FTEST'] },
        });
        expect(
          (await gateway.callback(callback(output, job.callbackToken))).status,
        ).toBe(202);
        await gateway.flush();

        expect(collect).toHaveBeenCalledExactlyOnceWith(
          job.runId,
          target,
          format,
        );
        const threadId = 'slack:CTEST1:' + body.event.ts;
        expect(post).toHaveBeenNthCalledWith(1, threadId, output.text);
        expect(post).toHaveBeenNthCalledWith(2, threadId, {
          markdown: '',
          files: [{ data: bytes, filename: 'result.' + format, mimeType }],
        });
        expect(
          (
            await gateway.callback(
              callback(
                { ...output, artifact: { ...output.artifact!, format: 'ts' } },
                job.callbackToken,
              ),
            )
          ).status,
        ).toBe(409);
      },
    );

    it.each([
      [undefined, undefined, WORKER_FAILURE_REPLY],
      [
        undefined,
        'provider_quota',
        'The model provider is out of quota or rate-limited. Try again after the provider limit clears.',
      ],
      [
        undefined,
        'drive_full',
        'Workspace storage is full. Ask an operator to free space, then retry.',
      ],
      [
        'pdf_unreadable',
        undefined,
        'I could not extract readable text from this PDF. Mention me again with a small text-based PDF.',
      ],
      [
        'pdf_text_too_large',
        undefined,
        'The PDF contains more than 16 KiB of text for this test. Mention me again with a shorter PDF.',
      ],
      [
        'retained_sources_unavailable',
        undefined,
        'I could not reopen an earlier file or link in this thread. Start a new message in the channel, mention me there, and include the files and links you still need.',
      ],
    ] as const)(
      'posts a safe failure once for %s / %s',
      async (inputError, failureCategory, notice) => {
        const gateway = harness();
        const body = envelope();
        await gateway.events(signed(body));
        await gateway.flush();
        const job = gateway.dispatch.mock.calls[0]![0];
        const failure = {
          ...result(job),
          type: 'failed',
          inputError,
          failureCategory,
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
          notice,
        );
        expect(await gateway.store.getRun(job.runId)).toMatchObject({
          state: 'worker_failed',
          result: { type: 'failed', text: notice },
        });
      },
    );

    it('activates only after a real session result and resumes that exact session after a gateway restart', async () => {
      let gateway = harness(createMockState(), true, undefined, {
        publicUrlInput: true,
      });
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
        hasRetainedSources: true as const,
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

      gateway = harness(
        createMockState(),
        true,
        undefined,
        { publicUrlInput: true },
        undefined,
        false,
        undefined,
        gateway.storeNamespace,
      );
      const next = threadReply(mention.event.ts);
      next.event.text = 'Continue using the earlier answer.';
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
      expect(gateway.dispatch).toHaveBeenCalledTimes(1);
      expect(SlackAdapter.prototype.postMessage).toHaveBeenCalledTimes(1);
      const followup = gateway.dispatch.mock.calls[0]![0];
      expect(followup).toMatchObject({
        conversationId: seed.conversationId,
        session,
        input: { text: next.event.text, threadTs: mention.event.ts },
      });
      expect(followup.input).not.toHaveProperty('sources');
      expect(
        (
          await gateway.callback(
            callback(result(followup), followup.callbackToken),
          )
        ).status,
      ).toBe(409);
      const updated = { ...session, revision: session.revision + 2 };
      const droppedRetainedSources = {
        seedRunId: updated.seedRunId,
        nativeId: updated.nativeId,
        adapterId: updated.adapterId,
        revision: updated.revision,
      };
      expect(
        (
          await gateway.callback(
            callback(
              { ...result(followup), session: droppedRetainedSources },
              followup.callbackToken,
            ),
          )
        ).status,
      ).toBe(409);
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
      expect(gateway.dispatch).toHaveBeenCalledTimes(1);
      expect(SlackAdapter.prototype.postMessage).toHaveBeenCalledTimes(2);

      const later = threadReply(mention.event.ts);
      await gateway.events(signed(later));
      await gateway.flush();
      expect(gateway.dispatch.mock.calls[1]![0].session).toEqual(updated);

      await gateway.events(signed(envelope()));
      await gateway.flush();
      expect(gateway.dispatch.mock.calls[2]![0].session).toBeUndefined();
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

    it('admits a file-only ordinary reply only in its activated conversation', async () => {
      const gateway = harness(createMockState(), true, undefined, {
        fileExchange: true,
      });
      const root = envelope();
      const bytes = Buffer.from('{"synthetic":true}\n');
      const file = {
        id: 'FTEST1',
        name: 'followup.json',
        mimetype: 'application/json',
        mode: 'hosted',
        size: bytes.length,
        url_private:
          'https://files.slack.com/files-pri/TTEST1-FTEST1/followup.json',
      };
      const reply = threadReply(root.event.ts);
      reply.event.text = '';
      const payload = {
        ...reply,
        event: { ...reply.event, subtype: 'file_share', files: [file] },
      };
      const download = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(bytes));
      vi.stubGlobal('fetch', download);

      expect((await gateway.events(signed(payload))).status).toBe(200);
      await gateway.flush();
      expect(download).not.toHaveBeenCalled();
      expect(gateway.dispatch).not.toHaveBeenCalled();

      expect((await gateway.events(signed(root))).status).toBe(200);
      await gateway.flush();
      const seed = gateway.dispatch.mock.calls[0]![0];
      const session = {
        seedRunId: seed.runId,
        nativeId: randomUUID(),
        adapterId: randomUUID(),
        revision: 4,
      };
      vi.mocked(SlackAdapter.prototype.postMessage).mockResolvedValueOnce({
        id: root.event.ts,
        threadId: 'slack:CTEST1:' + root.event.ts,
        raw: {},
      });
      expect(
        (
          await gateway.callback(
            callback({ ...result(seed), session }, seed.callbackToken),
          )
        ).status,
      ).toBe(202);
      await gateway.flush();

      expect((await gateway.events(signed(payload))).status).toBe(200);
      expect(download).not.toHaveBeenCalled();
      await gateway.flush();
      const [job, staged] = gateway.dispatch.mock.calls[1]!;
      expect(job).toMatchObject({
        conversationId: seed.conversationId,
        session,
        artifactOutput: true,
        input: {
          sources: [
            {
              kind: 'text',
              name: file.name,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            },
          ],
        },
      });
      expect(workerJobSchema.safeParse(job).success).toBe(true);
      expect(
        workerJobSchema.safeParse({ ...job, csvOutput: true }).success,
      ).toBe(false);
      expect(job.input.threadContext).toBeUndefined();
      expect(staged).toEqual([bytes]);
      expect(download).toHaveBeenCalledOnce();
    });

    it('refuses an explicit private URL on an ordinary reply after activation', async () => {
      const gateway = harness(createMockState(), true, undefined, {
        publicUrlInput: true,
      });
      const root = envelope();
      await gateway.events(signed(root));
      await gateway.flush();
      const seed = gateway.dispatch.mock.calls[0]![0];
      const session = {
        seedRunId: seed.runId,
        nativeId: randomUUID(),
        adapterId: randomUUID(),
        revision: 4,
      };
      vi.mocked(SlackAdapter.prototype.postMessage).mockResolvedValueOnce({
        id: root.event.ts,
        threadId: 'slack:CTEST1:' + root.event.ts,
        raw: {},
      });
      expect(
        (
          await gateway.callback(
            callback({ ...result(seed), session }, seed.callbackToken),
          )
        ).status,
      ).toBe(202);
      await gateway.flush();

      const reply = threadReply(root.event.ts);
      reply.event.text = 'Check <https://[::1]/source.txt>.';
      expect((await gateway.events(signed(reply))).status).toBe(200);
      await gateway.flush();
      expect(gateway.dispatch).toHaveBeenCalledOnce();
      expect(SlackAdapter.prototype.postMessage).toHaveBeenLastCalledWith(
        'slack:CTEST1:' + root.event.ts,
        'That URL points to a private or restricted network address.',
      );
    });

    it.each([
      ['png', 'image/png'],
      ['jpg', 'image/jpeg'],
    ])('requires a vision opt-in for %s input', async (extension, mimetype) => {
      const gateway = harness(createMockState(), false, undefined, {
        fileExchange: true,
      });
      const root = envelope();
      const file = {
        name: 'fixture.' + extension,
        mode: 'hosted',
        size: 100,
        mimetype,
        url_private:
          'https://files.slack.com/files-pri/TTEST1-FTEST1/fixture.' +
          extension,
      };
      const download = vi.fn<typeof fetch>();
      vi.stubGlobal('fetch', download);
      expect(
        (
          await gateway.events(
            signed({
              ...root,
              event: { ...root.event, subtype: 'file_share', files: [file] },
            }),
          )
        ).status,
      ).toBe(200);
      await gateway.flush();
      expect(download).not.toHaveBeenCalled();
      expect(gateway.dispatch).not.toHaveBeenCalled();
      expect(SlackAdapter.prototype.postMessage).toHaveBeenLastCalledWith(
        'slack:CTEST1:' + root.event.ts,
        'Attach a supported Slack-hosted UTF-8 text, Markdown, source, JSON, CSV, text-based PDF, or enabled image file.',
      );
    });

    it('refuses a batch over the attachment limit before any download or dispatch', async () => {
      const gateway = harness(createMockState(), false, undefined, {
        fileExchange: true,
      });
      const root = envelope();
      const download = vi.fn<typeof fetch>();
      vi.stubGlobal('fetch', download);
      expect(
        (
          await gateway.events(
            signed({
              ...root,
              event: {
                ...root.event,
                subtype: 'file_share',
                files: Array(6).fill({}),
              },
            }),
          )
        ).status,
      ).toBe(200);
      await gateway.flush();
      expect(download).not.toHaveBeenCalled();
      expect(gateway.dispatch).not.toHaveBeenCalled();
      expect(SlackAdapter.prototype.postMessage).toHaveBeenLastCalledWith(
        'slack:CTEST1:' + root.event.ts,
        'Attach at most 5 Slack files per message.',
      );
    });

    it.each([
      {
        outcome: 'oversized attachment',
        file: {
          name: 'oversized.png',
          mode: 'hosted',
          size: 16 * 1024 + 1,
          mimetype: 'image/png',
          url_private:
            'https://files.slack.com/files-pri/TTEST1-FTEST1/oversized.png',
        },
        notice:
          'The PNG exceeds the 16 KiB limit for this test. Attach a smaller file.',
        requests: 0,
      },
      {
        outcome: 'unsupported attachment',
        file: {
          name: 'unsupported.zip',
          mode: 'hosted',
          size: 24,
          mimetype: 'application/zip',
          url_private:
            'https://files.slack.com/files-pri/TTEST1-FTEST1/unsupported.zip',
        },
        notice:
          'Attach a supported Slack-hosted UTF-8 text, Markdown, source, JSON, CSV, text-based PDF, or enabled image file.',
        requests: 0,
      },
      {
        outcome: 'inaccessible attachment',
        file: {
          name: 'inaccessible.pdf',
          mode: 'hosted',
          size: 24,
          mimetype: 'application/pdf',
          url_private:
            'https://files.slack.com/files-pri/TTEST1-FTEST1/inaccessible.pdf',
        },
        notice:
          'I could not read the Slack file. Check that it is shared here and mention me again with the PDF.',
        requests: 1,
      },
      {
        outcome: 'private-network URL',
        notice: 'That URL points to a private or restricted network address.',
        requests: 0,
      },
    ])(
      'posts one same-thread notice for $outcome without dispatch',
      async ({ file, notice, requests }) => {
        const request = vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response('denied', { status: 403 }));
        vi.stubGlobal('fetch', request);
        const gateway = harness(createMockState(), false, undefined, {
          csvInput: true,
          pdfInput: true,
          pngInput: true,
          publicUrlInput: true,
        });
        const root = '1799999999.000001';
        const base = envelope();
        const mention = file
          ? {
              ...base,
              event: {
                ...base.event,
                thread_ts: root,
                subtype: 'file_share',
                files: [file],
              },
            }
          : {
              ...base,
              event: {
                ...base.event,
                thread_ts: root,
                text: '<@UBOT1> Read <https://127.0.0.1/source.txt>.',
              },
            };

        expect((await gateway.events(signed(mention))).status).toBe(200);
        expect(request).not.toHaveBeenCalled();
        expect(gateway.dispatch).not.toHaveBeenCalled();
        expect(SlackAdapter.prototype.postMessage).not.toHaveBeenCalled();

        await gateway.flush();

        expect(request).toHaveBeenCalledTimes(requests);
        expect(gateway.dispatch).not.toHaveBeenCalled();
        expect(
          SlackAdapter.prototype.postMessage,
        ).toHaveBeenCalledExactlyOnceWith(`slack:CTEST1:${root}`, notice);
        const run = await gateway.run();
        expect(await gateway.store.getRun(run!.runId)).toMatchObject({
          state: 'worker_failed',
        });
        expect(await gateway.owner(root)).toBeNull();
      },
    );

    it.each([
      'https://[::1]/source.txt.',
      'HTTPS://[::1]/source.txt.',
      'https://[::1]',
    ])('rejects a bare private IPv6 URL before dispatch: %s', async (url) => {
      const gateway = harness(createMockState(), false, undefined, {
        publicUrlInput: true,
      });
      const mention = envelope();
      mention.event.text = `<@UBOT1> Read ${url}`;

      expect((await gateway.events(signed(mention))).status).toBe(200);
      expect(gateway.dispatch).not.toHaveBeenCalled();
      expect(SlackAdapter.prototype.postMessage).not.toHaveBeenCalled();

      await gateway.flush();

      expect(gateway.dispatch).not.toHaveBeenCalled();
      expect(
        SlackAdapter.prototype.postMessage,
      ).toHaveBeenCalledExactlyOnceWith(
        `slack:CTEST1:${mention.event.ts}`,
        'That URL points to a private or restricted network address.',
      );
    });

    it.each([
      '<HTTPS://[::1]/source.txt>',
      '<HTTPS://[::1]/source.txt|source>',
    ])(
      'rejects an uppercase explicit private IPv6 URL before dispatch: %s',
      async (url) => {
        const gateway = harness(createMockState(), false, undefined, {
          publicUrlInput: true,
        });
        const mention = envelope();
        mention.event.text = `<@UBOT1> Read ${url}`;

        expect((await gateway.events(signed(mention))).status).toBe(200);
        expect(gateway.dispatch).not.toHaveBeenCalled();
        expect(SlackAdapter.prototype.postMessage).not.toHaveBeenCalled();

        await gateway.flush();

        expect(gateway.dispatch).not.toHaveBeenCalled();
        expect(
          SlackAdapter.prototype.postMessage,
        ).toHaveBeenCalledExactlyOnceWith(
          `slack:CTEST1:${mention.event.ts}`,
          'That URL points to a private or restricted network address.',
        );
      },
    );

    it('rejects credentials in a bare bracketed IPv6 URL before dispatch', async () => {
      const gateway = harness(createMockState(), false, undefined, {
        publicUrlInput: true,
      });
      const mention = envelope();
      mention.event.text = '<@UBOT1> Read https://user:pass@[::1]/source.txt';

      expect((await gateway.events(signed(mention))).status).toBe(200);
      expect(gateway.dispatch).not.toHaveBeenCalled();
      expect(SlackAdapter.prototype.postMessage).not.toHaveBeenCalled();

      await gateway.flush();

      expect(gateway.dispatch).not.toHaveBeenCalled();
      expect(
        SlackAdapter.prototype.postMessage,
      ).toHaveBeenCalledExactlyOnceWith(
        `slack:CTEST1:${mention.event.ts}`,
        'Send a direct public HTTPS link without credentials or a custom port.',
      );
    });

    it.each([
      [
        'bare public URL',
        '<@UBOT1> Explain this code: `const source = "https://example.invalid/source.txt";`',
      ],
      [
        'bracketed IPv6 URL in inline code',
        '<@UBOT1> Explain this value: `https://[::1]/source.txt`',
      ],
      [
        'bracketed IPv6 URL in fenced code',
        '<@UBOT1> Explain this code:\n```\nconst source = "https://[::1]/source.txt";\n```',
      ],
      [
        'explicit bracketed IPv6 URL in inline code',
        '<@UBOT1> Explain this value: `<HTTPS://[::1]/source.txt>`',
      ],
      [
        'explicit bracketed IPv6 URL in fenced code',
        '<@UBOT1> Explain this code:\n```\nconst source = "<HTTPS://[::1]/source.txt>";\n```',
      ],
    ])('leaves a %s as ordinary task text', async (_case, text) => {
      const gateway = harness(createMockState(), false, undefined, {
        publicUrlInput: true,
      });
      const mention = envelope();
      mention.event.text = text;

      expect((await gateway.events(signed(mention))).status).toBe(200);
      expect(gateway.dispatch).not.toHaveBeenCalled();

      await gateway.flush();

      expect(gateway.dispatch).toHaveBeenCalledOnce();
      expect(gateway.dispatch.mock.calls[0]![0].input).not.toHaveProperty(
        'sources',
      );
      expect(SlackAdapter.prototype.postMessage).not.toHaveBeenCalled();
    });

    it('rejects a linked URL combined with a bare IPv6 URL before download or dispatch', async () => {
      const request = vi.fn<typeof fetch>();
      vi.stubGlobal('fetch', request);
      const gateway = harness(createMockState(), false, undefined, {
        publicUrlInput: true,
      });
      const mention = envelope();
      mention.event.text =
        '<@UBOT1> Read <https://example.invalid/source.txt> and https://[::1]/source.txt.';

      expect((await gateway.events(signed(mention))).status).toBe(200);
      expect(gateway.dispatch).not.toHaveBeenCalled();
      expect(SlackAdapter.prototype.postMessage).not.toHaveBeenCalled();

      await gateway.flush();

      expect(request).not.toHaveBeenCalled();
      expect(gateway.dispatch).not.toHaveBeenCalled();
      expect(
        SlackAdapter.prototype.postMessage,
      ).toHaveBeenCalledExactlyOnceWith(
        `slack:CTEST1:${mention.event.ts}`,
        'Send at most one public HTTPS link per message.',
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
      expect(gateway.tasks).toHaveLength(1);
      await gateway.flush();
      expect(SlackAdapter.prototype.postMessage).toHaveBeenCalledTimes(1);
    });

    it('reconciles an exhausted terminal status edit on duplicate Slack delivery without republishing', async () => {
      const gateway = harness(
        createMockState(),
        false,
        undefined,
        {},
        undefined,
        true,
      );
      const body = envelope();
      await gateway.events(signed(body));
      await gateway.flush();
      const job = gateway.dispatch.mock.calls[0]![0];
      const edit = vi.mocked(SlackAdapter.prototype.editMessage);
      let terminalFailures = 0;
      edit.mockImplementation(async (threadId, messageId, message) => {
        if (
          message === 'Completed. The result is in this thread.' &&
          terminalFailures < 2
        ) {
          terminalFailures += 1;
          throw new Error('Synthetic terminal status timeout');
        }
        return { id: messageId, threadId, raw: {} };
      });

      expect(
        (await gateway.callback(callback(result(job), job.callbackToken)))
          .status,
      ).toBe(202);
      await gateway.flush();
      expect(terminalFailures).toBe(2);
      expect(await gateway.store.getRun(job.runId)).toMatchObject({
        state: 'completed',
        statusMessageId: '1800000001.000001',
      });
      const posts = vi.mocked(SlackAdapter.prototype.postMessage).mock.calls
        .length;
      const reactions = vi.mocked(SlackAdapter.prototype.addReaction).mock.calls
        .length;
      const dispatches = gateway.dispatch.mock.calls.length;

      expect((await gateway.events(signed(body))).status).toBe(200);
      await gateway.flush();

      expect(edit).toHaveBeenLastCalledWith(
        `slack:CTEST1:${body.event.ts}`,
        '1800000001.000001',
        'Completed. The result is in this thread.',
      );
      expect(SlackAdapter.prototype.postMessage).toHaveBeenCalledTimes(posts);
      expect(SlackAdapter.prototype.addReaction).toHaveBeenCalledTimes(
        reactions,
      );
      expect(gateway.dispatch).toHaveBeenCalledTimes(dispatches);
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

    it('recovers an interrupted save in an activated thread when controls are off', async () => {
      const stopped = vi.fn().mockResolvedValue(true);
      const gateway = harness(createMockState(), true, stopped);
      const original = envelope();
      await gateway.events(signed(original));
      await gateway.flush();
      const first = gateway.dispatch.mock.calls[0]![0];
      const session = {
        seedRunId: first.runId,
        nativeId: randomUUID(),
        adapterId: randomUUID(),
        revision: 1,
      };
      await gateway.callback(
        callback({ ...result(first), session }, first.callbackToken),
      );
      await gateway.flush();

      mockControlAccess();
      const target = {
        sandboxName: 'synthetic-worker',
        sessionId: 'synthetic-session',
      };
      gateway.dispatch.mockImplementationOnce(async (job) => {
        expect(await gateway.store.recordDispatchTarget(job, target)).toBe(
          'recorded',
        );
        throw new Error('Synthetic dispatch acknowledgement loss');
      });
      const save = threadReply(original.event.ts);
      save.event.ts = '1800000002.000001';
      save.event.text = 'remember for this channel: The badge is purple.';
      await gateway.events(signed(save));
      await gateway.flush();
      const job = gateway.dispatch.mock.calls[1]![0];
      expect(job).toMatchObject({ memory: 'save', session });

      gateway.clock.now = job.deadline;
      const recover = threadReply(original.event.ts);
      recover.event.ts = '1800000002.000002';
      await gateway.events(signed(recover, gateway.clock.now));
      await gateway.flush();
      expect(stopped).toHaveBeenCalledExactlyOnceWith(target);
      expect(gateway.dispatch).toHaveBeenCalledTimes(2);
      expect(await gateway.owner(original.event.ts)).toBeNull();
      expect(SlackAdapter.prototype.postMessage).toHaveBeenLastCalledWith(
        'slack:CTEST1:' + original.event.ts,
        expect.stringContaining('I could not confirm the shared note save.'),
      );

      const next = threadReply(original.event.ts);
      next.event.ts = '1800000002.000003';
      await gateway.events(signed(next, gateway.clock.now));
      await gateway.flush();
      expect(gateway.dispatch.mock.calls[2]?.[0].session).toEqual(session);
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

    it('records uncertainty when the publication-state write fails', async () => {
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
        expect.stringContaining(
          '"phase":"publication_uncertain","messageId":"1800000001.000001"',
        ),
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
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const dispatching = gateway.flush();
      await vi.advanceTimersByTimeAsync(30_000);
      vi.useRealTimers();
      await dispatching;
      const job = gateway.dispatch.mock.calls[0]![0];
      await gateway.callback(callback(result(job), job.callbackToken));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const flushing = gateway.flush();
      await vi.advanceTimersByTimeAsync(15_000);
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
