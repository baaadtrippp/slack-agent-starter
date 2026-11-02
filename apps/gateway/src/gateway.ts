import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { createSlackAdapter } from '@chat-adapter/slack';
import {
  parseSlackWebhookBody,
  verifySlackSignature,
} from '@chat-adapter/slack/webhook';
import { Chat, ConsoleLogger } from 'chat';
import type { StateAdapter } from 'chat';
import { workerResultSchema } from '../../../packages/contracts/src/index.js';
import type {
  WorkerJob,
  WorkerResult,
} from '../../../packages/contracts/src/index.js';
import type { RunRecord, RunStore } from './store.js';

export type GatewayConfig = {
  signingSecret: string;
  botToken: string;
  workspaceId: string;
  channelIds: string[];
  origin: string;
};

type GatewayOptions = {
  config: GatewayConfig;
  state: StateAdapter;
  store: RunStore;
  dispatch: (job: WorkerJob) => Promise<void>;
  schedule: (task: () => Promise<void>) => void;
  now?: () => number;
};

export const BUSY_REPLY =
  'This thread has an unfinished run. Your message was not submitted. During this test, start a new mention outside this thread and ask the operator to inspect it.';

const MAX_BODY_BYTES = 32 * 1024;
const RUN_DURATION_MS = 60_000;

export function createGateway({
  config,
  state,
  store,
  dispatch,
  schedule,
  now = Date.now,
}: GatewayOptions) {
  function makeBot() {
    const slack = createSlackAdapter({
      botToken: config.botToken,
      signingSecret: config.signingSecret,
      logger: new ConsoleLogger('silent'),
      webClientOptions: {
        retryConfig: { retries: 0 },
        rejectRateLimitedCalls: true,
        timeout: 10_000,
      },
    });
    const bot = new Chat({
      userName: 'agent',
      adapters: { slack },
      state,
      logger: 'silent',
      // Application admission already serializes runs and deduplicates input.
      concurrency: 'concurrent',
    });
    return { bot, slack };
  }

  async function publish(run: RunRecord, result: WorkerResult) {
    let messageId: string | undefined;
    try {
      const { bot, slack } = makeBot();
      await bot.initialize();
      const threadId = slack.encodeThreadId({
        channel: run.channelId,
        threadTs: run.threadTs,
      });
      const message = await bot.thread(threadId).post(result.text);
      if (!message.id)
        throw new Error('Publication did not return a message ID');
      messageId = message.id;
      if (!(await store.completePublication(run.runId, messageId)))
        throw new Error('Publication state was not recorded');
      console.info(
        JSON.stringify({ runId: run.runId, phase: 'published', messageId }),
      );
    } catch {
      const stateRecorded = await store
        .failPublication(run.runId)
        .catch(() => false);
      console.error(
        JSON.stringify({
          runId: run.runId,
          phase: 'publication_uncertain',
          messageId,
          stateRecorded,
        }),
      );
    }
  }

  async function events(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const body = await request.text();
    if (Buffer.byteLength(body) > MAX_BODY_BYTES)
      return new Response(null, { status: 413 });
    try {
      await verifySlackSignature(body, request.headers, {
        signingSecret: config.signingSecret,
        now,
      });
    } catch {
      return new Response(null, { status: 401 });
    }
    let payload;
    try {
      payload = parseSlackWebhookBody(body, {
        contentType: request.headers.get('content-type'),
      });
    } catch {
      return new Response(null, { status: 400 });
    }
    if (payload.kind === 'url_verification')
      return Response.json({ challenge: payload.challenge });
    if (payload.kind !== 'app_mention')
      return new Response(null, { status: 200 });

    const rawEvent = payload.raw;
    if (
      payload.teamId !== config.workspaceId ||
      !config.channelIds.includes(payload.channelId) ||
      !payload.channelId.startsWith('C') ||
      payload.isExtSharedChannel !== false ||
      !payload.userId ||
      payload.userId === 'USLACKBOT' ||
      !/^[UW][A-Z0-9]+$/.test(payload.userId) ||
      !payload.eventId ||
      !/^\d{10}\.\d{6}$/.test(payload.ts) ||
      !/^\d{10}\.\d{6}$/.test(payload.threadTs) ||
      !payload.text ||
      payload.text.length > 12_000 ||
      !rawEvent ||
      rawEvent.bot_id ||
      rawEvent.bot_profile ||
      rawEvent.subtype ||
      (rawEvent.user_team !== undefined &&
        rawEvent.user_team !== config.workspaceId) ||
      (rawEvent.team !== undefined && rawEvent.team !== config.workspaceId) ||
      (rawEvent.channel_type !== undefined &&
        rawEvent.channel_type !== 'channel')
    )
      return new Response(null, { status: 200 });

    const { bot, slack } = makeBot();
    // The synchronous adapter parser does not fetch users, history, or URLs.
    const message = slack.parseMessage({
      type: 'app_mention',
      user: payload.userId,
      channel: payload.channelId,
      ts: payload.ts,
      thread_ts: payload.threadTs,
      text: payload.text,
    });
    if (!message.isMention) return new Response(null, { status: 200 });

    const callbackToken = randomBytes(32).toString('hex');
    const candidate: RunRecord = {
      runId: randomUUID(),
      conversationId: digest(
        `${payload.teamId}:${payload.channelId}:${payload.threadTs}`,
      ),
      generation: 1,
      eventId: payload.eventId,
      workspaceId: payload.teamId,
      channelId: payload.channelId,
      threadTs: payload.threadTs,
      messageTs: payload.ts,
      senderId: payload.userId,
      text: payload.text,
      deadline: now() + RUN_DURATION_MS,
      callbackHash: digest(callbackToken),
      kind: 'work',
      state: 'accepted',
    };
    let admission;
    try {
      admission = await store.admit(candidate);
    } catch {
      console.error(
        JSON.stringify({
          runId: candidate.runId,
          phase: 'admission_uncertain',
        }),
      );
      return new Response(null, { status: 503 });
    }
    if (admission.outcome === 'duplicate') {
      if (
        admission.run.deadline <= now() &&
        admission.run.state !== 'completed'
      )
        console.error(
          JSON.stringify({
            runId: admission.run.runId,
            phase: 'abandoned_run',
            state: admission.run.state,
          }),
        );
      return new Response(null, { status: 200 });
    }

    const run = admission.run;
    let handlerRan = false;
    bot.onNewMention(async () => {
      handlerRan = true;
      if (run.kind === 'busy') {
        const result: WorkerResult = {
          version: 1,
          runId: run.runId,
          generation: 1,
          eventId: randomUUID(),
          sequence: 1,
          type: 'completed',
          text: BUSY_REPLY,
        };
        if (
          (await store.claimPublication(run.runId, result, now())) === 'claimed'
        )
          await publish(run, result);
        else
          console.error(
            JSON.stringify({
              runId: run.runId,
              phase: 'busy_reply_unavailable',
            }),
          );
        return;
      }
      await dispatch({
        version: 1,
        runId: run.runId,
        conversationId: run.conversationId,
        generation: run.generation,
        input: {
          text: run.text,
          senderId: run.senderId,
          workspaceId: run.workspaceId,
          channelId: run.channelId,
          threadTs: run.threadTs,
          messageTs: run.messageTs,
        },
        deadline: run.deadline,
        callbackUrl: `${config.origin}/api/worker/callback`,
        callbackToken,
      });
    });
    schedule(async () => {
      try {
        await bot.initialize();
        await bot.processMessage(slack, message.threadId, message, {
          deduplicate: false,
        });
        if (!handlerRan) throw new Error('Admitted mention was not handled');
      } catch {
        await store.failDispatch(run.runId);
        console.error(
          JSON.stringify({ runId: run.runId, phase: 'dispatch_failed' }),
        );
      }
    });
    return new Response(null, { status: 200 });
  }

  async function authenticate(
    request: Request,
    runId: string,
    generation: number,
  ) {
    const run = await store.getRun(runId);
    const token = request.headers
      .get('authorization')
      ?.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
    if (
      !run ||
      !token ||
      !timingSafeEqual(
        Buffer.from(digest(token), 'hex'),
        Buffer.from(run.callbackHash, 'hex'),
      )
    )
      return new Response(null, { status: 401 });
    if (run.generation !== generation || run.kind !== 'work')
      return new Response(null, { status: 409 });
    if (run.deadline <= now()) {
      if (run.state !== 'completed')
        console.error(
          JSON.stringify({
            runId: run.runId,
            phase: 'abandoned_run',
            state: run.state,
          }),
        );
      return new Response(null, { status: 410 });
    }
    return run;
  }

  async function callback(request: Request): Promise<Response> {
    if (request.method === 'GET') {
      const url = new URL(request.url);
      const auth = await authenticate(
        request,
        url.searchParams.get('runId') ?? '',
        Number(url.searchParams.get('generation')),
      );
      if (auth instanceof Response) return auth;
      return new Response(null, {
        status:
          auth.state === 'accepted' || auth.state === 'dispatch_failed'
            ? 204
            : 409,
      });
    }
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const body = await request.text();
    if (Buffer.byteLength(body) > MAX_BODY_BYTES)
      return new Response(null, { status: 413 });
    let parsed;
    try {
      parsed = workerResultSchema.safeParse(JSON.parse(body));
    } catch {
      return new Response(null, { status: 400 });
    }
    if (!parsed.success) return new Response(null, { status: 400 });
    const result = parsed.data;
    const run = await authenticate(request, result.runId, result.generation);
    if (run instanceof Response) return run;
    let claim;
    try {
      claim = await store.claimPublication(run.runId, result, now());
    } catch {
      console.error(
        JSON.stringify({
          runId: run.runId,
          phase: 'publication_claim_uncertain',
        }),
      );
      return new Response(null, { status: 503 });
    }
    if (claim === 'duplicate') return new Response(null, { status: 204 });
    if (claim === 'expired') return new Response(null, { status: 410 });
    if (claim !== 'claimed') return new Response(null, { status: 409 });
    schedule(() => publish(run, result));
    return new Response(null, { status: 202 });
  }

  return { events, callback };
}

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
