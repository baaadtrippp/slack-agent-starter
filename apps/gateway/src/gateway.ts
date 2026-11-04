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
import { z } from 'zod';
import {
  WORKER_FAILURE_REPLY,
  workerResultSchema,
} from '../../../packages/contracts/src/index.js';
import type {
  WorkerJob,
  WorkerResult,
} from '../../../packages/contracts/src/index.js';
import type { RunRecord, RunStore, SandboxTarget } from './store.js';

export type GatewayConfig = {
  signingSecret: string;
  botToken: string;
  workspaceId: string;
  channelIds: string[];
  origin: string;
  threadResume?: boolean;
};

type GatewayOptions = {
  config: GatewayConfig;
  state: StateAdapter;
  store: RunStore;
  dispatch: (job: WorkerJob) => Promise<void | 'worker-unavailable'>;
  isSandboxStopped?: (target: SandboxTarget) => Promise<boolean>;
  schedule: (task: () => Promise<void>) => void;
  now?: () => number;
};

export const BUSY_REPLY =
  'This thread had an unfinished run when your message arrived. Your message was not submitted. During this test, start a new mention outside this thread and ask the operator to inspect it.';

export const RECOVERED_REPLY =
  'The environment assigned to the previous run has stopped. Hydra could not confirm a result. This message was not submitted. Mention me again in this thread to try a fresh run.';

export const WORKER_UNAVAILABLE_REPLY =
  'The worker is unavailable. Your message was not submitted. Mention me again when the worker is ready.';

const MAX_BODY_BYTES = 32 * 1024;
const MAX_EVENT_BYTES = 256 * 1024;
const RUN_DURATION_MS = 60_000;

const threadReplyEnvelope = z.object({
  type: z.literal('event_callback'),
  team_id: z.string(),
  event_id: z.string(),
  is_ext_shared_channel: z.literal(false),
  event: z.looseObject({
    type: z.literal('message'),
    channel_type: z.literal('channel'),
    channel: z.string(),
    user: z.string(),
    ts: z.string(),
    thread_ts: z.string(),
    text: z.string(),
  }),
});

function parseThreadReply(raw: unknown) {
  const parsed = threadReplyEnvelope.safeParse(raw);
  if (!parsed.success) return;
  const envelope = parsed.data;
  const event = envelope.event;
  if (event.ts === event.thread_ts) return;
  return {
    teamId: envelope.team_id,
    channelId: event.channel,
    isExtSharedChannel: envelope.is_ext_shared_channel,
    userId: event.user,
    eventId: envelope.event_id,
    ts: event.ts,
    threadTs: event.thread_ts,
    text: event.text,
    raw: event,
  };
}

export function createGateway({
  config,
  state,
  store,
  dispatch,
  isSandboxStopped,
  schedule,
  now = Date.now,
}: GatewayOptions) {
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
  });

  async function initializeBot() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        bot.initialize(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Chat initialization timed out')),
            15_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function publish(run: RunRecord, result: WorkerResult) {
    let messageId: string | undefined;
    try {
      await initializeBot();
      const threadId = slack.encodeThreadId({
        channel: run.channelId,
        threadTs: run.threadTs,
      });
      const message = await bot.thread(threadId).post(result.text);
      if (
        !message.id ||
        (result.session && !/^\d{10}\.\d{6}$/.test(message.id))
      )
        throw new Error('Publication did not return a valid message ID');
      messageId = message.id;
      if (!(await store.completePublication(run, messageId)))
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

  async function publishNotice(
    run: RunRecord,
    type: WorkerResult['type'],
    text: string,
  ) {
    const result: WorkerResult = {
      version: 1,
      runId: run.runId,
      generation: run.generation,
      eventId: randomUUID(),
      sequence: 1,
      type,
      text,
    };
    if ((await store.claimPublication(run.runId, result, now())) !== 'claimed')
      return false;
    await publish(run, result);
    return true;
  }

  async function recoverInterruptedRun(run: RunRecord) {
    if (!isSandboxStopped || !run.blockedBy) return false;
    const previous = await store.getRun(run.blockedBy);
    if (
      !previous?.execution ||
      previous.workspaceId !== run.workspaceId ||
      previous.channelId !== run.channelId ||
      previous.threadTs !== run.threadTs
    )
      return false;
    if (previous.state !== 'interrupted') {
      if (
        previous.session ||
        previous.deadline > now() ||
        (previous.state !== 'accepted' && previous.state !== 'dispatch_failed')
      )
        return false;
      if (!(await isSandboxStopped(previous.execution))) return false;
    }
    // The first write may have committed even if Redis did not acknowledge it.
    return store
      .interruptRun(previous, now())
      .catch(() => store.interruptRun(previous, now()));
  }

  async function events(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const body = await request.text();
    if (Buffer.byteLength(body) > MAX_EVENT_BYTES)
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
    const mention = payload.kind === 'app_mention';
    const input =
      payload.kind === 'app_mention'
        ? payload
        : config.threadResume && payload.kind === 'unsupported'
          ? parseThreadReply(payload.raw)
          : undefined;
    if (!input) return new Response(null, { status: 200 });

    const rawEvent = input.raw;
    if (
      input.teamId !== config.workspaceId ||
      !config.channelIds.includes(input.channelId) ||
      !input.channelId.startsWith('C') ||
      input.isExtSharedChannel !== false ||
      !input.userId ||
      input.userId === 'USLACKBOT' ||
      !/^[UW][A-Z0-9]+$/.test(input.userId) ||
      !input.eventId ||
      !/^\d{10}\.\d{6}$/.test(input.ts) ||
      !/^\d{10}\.\d{6}$/.test(input.threadTs) ||
      !input.text ||
      input.text.length > 12_000 ||
      !rawEvent ||
      rawEvent.bot_id ||
      rawEvent.bot_profile ||
      rawEvent.subtype !== undefined ||
      (rawEvent.user_team !== undefined &&
        rawEvent.user_team !== config.workspaceId) ||
      (rawEvent.team !== undefined && rawEvent.team !== config.workspaceId) ||
      (rawEvent.channel_type !== undefined &&
        rawEvent.channel_type !== 'channel')
    )
      return new Response(null, { status: 200 });

    // The synchronous adapter parser does not fetch users, history, or URLs.
    if (
      mention &&
      !slack.parseMessage({
        type: 'app_mention',
        user: input.userId,
        channel: input.channelId,
        ts: input.ts,
        thread_ts: input.threadTs,
        text: input.text,
      }).isMention
    )
      return new Response(null, { status: 200 });

    const callbackToken = randomBytes(32).toString('hex');
    const candidate: RunRecord = {
      runId: randomUUID(),
      conversationId: digest(
        `${input.teamId}:${input.channelId}:${input.threadTs}`,
      ),
      generation: 1,
      eventId: input.eventId,
      workspaceId: input.teamId,
      channelId: input.channelId,
      threadTs: input.threadTs,
      messageTs: input.ts,
      senderId: input.userId,
      deadline: now() + RUN_DURATION_MS,
      callbackHash: digest(callbackToken),
      kind: 'work',
      state: 'accepted',
    };
    let admission;
    try {
      admission = await store.admit(candidate, !mention);
    } catch {
      console.error(
        JSON.stringify({
          runId: candidate.runId,
          phase: 'admission_uncertain',
        }),
      );
      return new Response(null, { status: 503 });
    }
    if (admission.outcome === 'inactive')
      return new Response(null, { status: 200 });
    if (admission.outcome === 'duplicate') {
      if (
        admission.run.deadline <= now() &&
        admission.run.state !== 'completed' &&
        admission.run.state !== 'worker_failed' &&
        admission.run.state !== 'interrupted'
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
    schedule(async () => {
      try {
        if (run.kind === 'busy') {
          const recovered = await recoverInterruptedRun(run).catch(() => {
            console.error(
              JSON.stringify({
                runId: run.runId,
                phase: 'recovery_unavailable',
              }),
            );
            return false;
          });
          if (
            !(await publishNotice(
              run,
              'completed',
              recovered ? RECOVERED_REPLY : BUSY_REPLY,
            ))
          )
            console.error(
              JSON.stringify({
                runId: run.runId,
                phase: 'busy_reply_unavailable',
              }),
            );
          return;
        }
        const dispatchOutcome = await dispatch({
          version: 1,
          runId: run.runId,
          conversationId: run.conversationId,
          generation: run.generation,
          input: {
            text: input.text,
            senderId: run.senderId,
            workspaceId: run.workspaceId,
            channelId: run.channelId,
            threadTs: run.threadTs,
            messageTs: run.messageTs,
          },
          ...(run.session ? { session: run.session } : {}),
          deadline: run.deadline,
          callbackUrl: `${config.origin}/api/worker/callback`,
          callbackToken,
        });
        if (
          dispatchOutcome === 'worker-unavailable' &&
          !(await publishNotice(run, 'failed', WORKER_UNAVAILABLE_REPLY))
        )
          console.error(
            JSON.stringify({
              runId: run.runId,
              phase: 'unsubmitted_reply_unavailable',
            }),
          );
      } catch {
        const stateRecorded = await store
          .failDispatch(run.runId)
          .catch(() => false);
        console.error(
          JSON.stringify({
            runId: run.runId,
            phase: 'dispatch_failed',
            stateRecorded,
          }),
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
    const token = request.headers
      .get('authorization')
      ?.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
    if (
      !token ||
      !workerResultSchema.shape.runId.safeParse(runId).success ||
      !Number.isInteger(generation) ||
      generation < 1
    )
      return new Response(null, { status: 401 });
    const run = await store.getRun(runId);
    if (
      !run ||
      !timingSafeEqual(
        Buffer.from(digest(token), 'hex'),
        Buffer.from(run.callbackHash, 'hex'),
      )
    )
      return new Response(null, { status: 401 });
    if (run.generation !== generation || run.kind !== 'work')
      return new Response(null, { status: 409 });
    if (run.deadline <= now()) {
      if (
        run.state !== 'completed' &&
        run.state !== 'worker_failed' &&
        run.state !== 'interrupted'
      )
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
    if (result.type === 'failed') {
      if (result.session) return new Response(null, { status: 400 });
      result.text = WORKER_FAILURE_REPLY;
    }
    const run = await authenticate(request, result.runId, result.generation);
    if (run instanceof Response) return run;
    if (result.type === 'completed') {
      const expected = run.session;
      const received = result.session;
      if (
        (!received && (expected || config.threadResume)) ||
        (received &&
          received.seedRunId !== (expected?.seedRunId ?? run.runId)) ||
        (received &&
          expected &&
          (received.nativeId !== expected.nativeId ||
            received.adapterId !== expected.adapterId ||
            received.revision <= expected.revision))
      )
        return new Response(null, { status: 409 });
    }
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
