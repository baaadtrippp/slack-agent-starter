import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { createSlackAdapter } from '@chat-adapter/slack';
import { unescapeSlackText } from '@chat-adapter/slack/format';
import {
  parseSlackWebhookBody,
  verifySlackSignature,
} from '@chat-adapter/slack/webhook';
import { Chat, ConsoleLogger, emoji } from 'chat';
import type { StateAdapter } from 'chat';
import { z } from 'zod';
import {
  WORKER_FAILURE_REPLY,
  workerCallbackSchema,
  workerResultSchema,
} from '../../../packages/contracts/src/index.js';
import type {
  WorkerJob,
  WorkerResult,
} from '../../../packages/contracts/src/index.js';
import { fetchPublicText } from './public-url.js';
import { downloadSlackFile } from './slack-file.js';
import {
  loadThreadContext,
  slackAttachmentMetadata,
} from './slack-thread-context.js';
import type { RunRecord, RunStore, SandboxTarget } from './store.js';

export type GatewayConfig = {
  signingSecret: string;
  botToken: string;
  workspaceId: string;
  channelIds: string[];
  origin: string;
  threadResume?: boolean;
  csvInput?: boolean;
  pdfInput?: boolean;
  pngInput?: boolean;
  csvOutput?: boolean;
  publicUrlInput?: boolean;
};

type GatewayOptions = {
  config: GatewayConfig;
  state: StateAdapter;
  store: RunStore;
  dispatch: (
    job: WorkerJob,
    stagedInput?: Buffer,
  ) => Promise<void | 'worker-unavailable' | 'input-staging-failed'>;
  collectCsv?: (runId: string, target: SandboxTarget) => Promise<Buffer>;
  isSandboxStopped?: (target: SandboxTarget) => Promise<boolean>;
  schedule: (task: () => Promise<void>) => void;
  now?: () => number;
};

export const BUSY_REPLY =
  'This thread has an unfinished run. Your message was not submitted. Please resend it after the run finishes. If it remains unfinished, ask the operator to inspect it.';

export const STARTING_STATUS = 'Starting…';

function statusText(run: RunRecord) {
  switch (run.state) {
    case 'publishing':
      return 'Finishing: publishing the result…';
    case 'completed':
      if (run.result?.artifact && run.artifactPublication !== 'uploaded')
        return 'Completed. The text result is in this thread. Attachment delivery is unconfirmed.';
      return 'Completed. The result is in this thread.';
    case 'worker_failed':
      return 'Failed. See the reply in this thread for details.';
    case 'publication_uncertain':
      return 'Failed to confirm result publication. Ask the operator to inspect this run before retrying.';
    case 'dispatch_failed':
      return run.progress
        ? 'Working…'
        : 'Starting: worker startup is unconfirmed. The outcome is uncertain; ask the operator to inspect this run.';
    case 'interrupted':
      return 'Failed: the worker environment stopped without a confirmed result. Mention me again to try a fresh run.';
    default:
      return run.progress ? 'Working…' : STARTING_STATUS;
  }
}

export const RECOVERED_REPLY =
  'The environment assigned to the previous run has stopped. Hydra could not confirm a result. This message was not submitted. Mention me again in this thread to try a fresh run.';

export const WORKER_UNAVAILABLE_REPLY =
  'The worker is unavailable. Your message was not submitted. Mention me again when the worker is ready.';

const INPUT_STAGING_FAILURE_REPLY = {
  csv: 'The CSV could not be staged. Mention me again with the file to retry.',
  pdf: 'The PDF could not be staged. Mention me again with the file to retry.',
  png: 'The PNG could not be staged. Mention me again with the file to retry.',
  publicUrl:
    'The public URL text could not be staged. Mention me again with the link to retry.',
};
const THREAD_CONTEXT_UNAVAILABLE_REPLY =
  'I could not read the earlier messages in this thread. Your request was not submitted. Mention me again in this thread to retry.';
const PDF_UNREADABLE_REPLY =
  'I could not extract readable text from this PDF. Mention me again with a small text-based PDF.';
const PDF_TEXT_TOO_LARGE_REPLY =
  'The PDF contains more than 16 KiB of text for this test. Mention me again with a shorter PDF.';

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
  collectCsv,
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
  const createBot = () =>
    new Chat({
      userName: 'agent',
      adapters: { slack },
      state,
      logger: 'silent',
    });
  let bot = createBot();

  async function initializeBot() {
    const current = bot;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        current.initialize().catch((error: unknown) => {
          // The SDK can cache a rejected adapter initialization. Replace that
          // Chat instance without disconnecting the shared Redis connection.
          if (bot === current) bot = createBot();
          throw error;
        }),
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

  function threadIdFor(run: RunRecord) {
    return slack.encodeThreadId({
      channel: run.channelId,
      threadTs: run.threadTs,
    });
  }

  async function acknowledge(run: RunRecord) {
    try {
      await initializeBot().catch(() => initializeBot());
      if (!(await store.claimStatusCreation(run.runId))) return;
      const threadId = threadIdFor(run);
      // A lost post response is deliberately not retried: it may have created
      // the message. Never create a second status to resolve that uncertainty.
      const [status] = await Promise.allSettled([
        (async () => {
          const message = await bot.thread(threadId).post(STARTING_STATUS);
          if (
            !/^\d{10}\.\d{6}$/.test(message.id) ||
            !(await store.recordStatusMessage(run.runId, message.id))
          )
            throw new Error('Status reference was not recorded');
          await renderStatus(run.runId);
        })(),
        slack.addReaction(threadId, run.messageTs, emoji.eyes).catch(() => {
          console.error(
            JSON.stringify({ runId: run.runId, phase: 'reaction_unconfirmed' }),
          );
        }),
      ]);
      if (status.status === 'rejected') throw status.reason;
    } catch {
      console.error(
        JSON.stringify({
          runId: run.runId,
          phase: 'status_creation_uncertain',
        }),
      );
    }
  }

  async function renderStatus(runId: string) {
    const token = randomUUID();
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const initial = await store.getRun(runId);
          if (!initial?.statusMessageId) return;
          await initializeBot();
          if (!(await store.claimStatusEdit(runId, token))) return;
          for (;;) {
            const current = await store.getRun(runId);
            if (!current?.statusMessageId) return;
            for (let edit = 0; edit < 2; edit += 1) {
              try {
                await slack.editMessage(
                  threadIdFor(current),
                  current.statusMessageId,
                  statusText(current),
                );
                break;
              } catch {
                if (edit === 1)
                  console.error(
                    JSON.stringify({ runId, phase: 'status_edit_unconfirmed' }),
                  );
              }
            }
            // Drain changes that arrived during the external call before an
            // atomic version check releases the token-owned lease.
            if (
              (await store.finishStatusEdit(
                runId,
                token,
                current.statusVersion ?? 0,
              )) !== 'changed'
            )
              return;
          }
        } catch {
          if (attempt === 1)
            console.error(
              JSON.stringify({ runId, phase: 'status_update_unavailable' }),
            );
        }
      }
    } finally {
      // Safe after success too: a different renderer's token cannot be released.
      await store.finishStatusEdit(runId, token).catch(() => {});
    }
  }

  async function publish(run: RunRecord, result: WorkerResult, csv?: Buffer) {
    let messageId: string | undefined;
    let threadId: string;
    let publishingStatus: Promise<void> | undefined;
    try {
      await initializeBot();
      publishingStatus = renderStatus(run.runId);
      threadId = threadIdFor(run);
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
      await publishingStatus;
      await renderStatus(run.runId);
      return;
    }

    if (result.artifact) {
      const attachmentStatus = renderStatus(run.runId);
      const thread = bot.thread(threadId);
      let artifactPublication: 'uploaded' | 'failed';
      try {
        if (!csv) throw new Error('Generated CSV was unavailable');
        const upload = await slack.postMessage(threadId, {
          markdown: '',
          files: [{ data: csv, filename: 'result.csv', mimeType: 'text/csv' }],
        });
        const receipt = z.object({
          uploadedFileIds: z.tuple([z.string().min(1)]),
        });
        if (!receipt.safeParse(upload.raw).success)
          throw new Error('Slack did not confirm the upload');
        artifactPublication = 'uploaded';
        console.info(
          JSON.stringify({
            runId: run.runId,
            phase: 'csv_uploaded',
            bytes: csv.length,
          }),
        );
      } catch {
        artifactPublication = 'failed';
        console.error(
          JSON.stringify({
            runId: run.runId,
            phase: 'csv_attachment_unconfirmed',
            category: csv ? 'slack_upload' : 'artifact_unavailable',
          }),
        );
        await thread
          .post(
            'I could not confirm the CSV attachment. The text result is above.',
          )
          .catch(() => {});
      }
      const recorded = await store
        .recordArtifactPublication(run.runId, artifactPublication)
        .catch(() => false);
      if (!recorded)
        console.error(
          JSON.stringify({
            runId: run.runId,
            phase: 'artifact_publication_state_uncertain',
            messageId,
          }),
        );
      await attachmentStatus;
    }
    await publishingStatus;
    await renderStatus(run.runId);
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
    const claimed =
      type === 'failed'
        ? await store.claimUnsubmitted(run, result)
        : (await store.claimPublication(run.runId, result, now())) ===
          'claimed';
    if (!claimed) return false;
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
    const recovered = await store
      .interruptRun(previous, now())
      .catch(() => store.interruptRun(previous, now()));
    if (recovered) await renderStatus(previous.runId);
    return recovered;
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
    const attachedFiles = rawEvent?.files;
    const hasFiles = Array.isArray(attachedFiles) && attachedFiles.length > 0;
    const fileInputEnabled =
      config.csvInput || config.pdfInput || config.pngInput;
    const fileShare =
      fileInputEnabled &&
      mention &&
      rawEvent?.subtype === 'file_share' &&
      hasFiles;
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
      input.threadTs > input.ts ||
      !input.text ||
      input.text.length > 12_000 ||
      !rawEvent ||
      rawEvent.bot_id ||
      rawEvent.bot_profile ||
      (rawEvent.subtype !== undefined && !fileShare) ||
      (!mention && fileInputEnabled && hasFiles) ||
      (rawEvent.user_team !== undefined &&
        rawEvent.user_team !== config.workspaceId) ||
      (rawEvent.team !== undefined && rawEvent.team !== config.workspaceId) ||
      (rawEvent.channel_type !== undefined &&
        rawEvent.channel_type !== 'channel')
    )
      return new Response(null, { status: 200 });

    // The synchronous adapter parser does not fetch users, history, or URLs.
    const message = mention
      ? slack.parseMessage({
          type: 'app_mention',
          user: input.userId,
          channel: input.channelId,
          ts: input.ts,
          thread_ts: input.threadTs,
          text: input.text,
        })
      : undefined;
    if (message && !message.isMention)
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
      if (admission.run.statusMessageId)
        schedule(() => renderStatus(admission.run.runId));
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
      let acknowledgement: Promise<void> | undefined;
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
        const urlText =
          config.publicUrlInput && mention
            ? input.text.replace(/```[\s\S]*?```|`[^`\n]*`/g, ' ')
            : '';
        const explicitIpv6Links = Array.from(
          urlText.matchAll(
            /<(https?:\/\/(?:[^\s<>|/]+@)?\[[\da-f:.]+\][^\s<>|]*)(?:\|[^>]*)?>/gi,
          ),
          ([, url]) => unescapeSlackText(url!),
        );
        const links = config.publicUrlInput
          ? [
              ...new Set([
                ...(message?.links ?? []).map((link) =>
                  unescapeSlackText(link.url),
                ),
                ...explicitIpv6Links,
                ...(
                  urlText
                    .replace(/<[^>]*>/g, ' ')
                    .match(
                      /https?:\/\/(?:[^\s<>|/]+@)?\[[\da-f:.]+\][^\s<>|]*/gi,
                    ) ?? []
                ).map((url) =>
                  unescapeSlackText(url).replace(/[.,;:!?)"']+$/g, ''),
                ),
              ]),
            ]
          : [];
        const publicUrl = links[0];
        if (links.length > 1 || (publicUrl && hasFiles)) {
          await publishNotice(
            run,
            'failed',
            'Mention me with one public HTTPS link on its own for this test.',
          );
          return;
        }

        let threadContext: WorkerJob['input']['threadContext'];
        if (mention && !run.session && run.threadTs !== run.messageTs) {
          threadContext = await loadThreadContext(run, config.botToken).catch(
            () => undefined,
          );
          if (!threadContext) {
            console.error(
              JSON.stringify({
                runId: run.runId,
                phase: 'thread_context_unavailable',
              }),
            );
            await publishNotice(
              run,
              'failed',
              THREAD_CONTEXT_UNAVAILABLE_REPLY,
            );
            return;
          }
          console.info(
            JSON.stringify({
              runId: run.runId,
              phase: 'thread_context_loaded',
              messageCount: threadContext.messages.length,
              truncated: threadContext.truncated,
            }),
          );
        }

        const mimeType = hasFiles ? attachedFiles[0]?.mimetype : undefined;
        const fileKind =
          config.pngInput && mimeType === 'image/png'
            ? 'png'
            : config.pdfInput && mimeType === 'application/pdf'
              ? 'pdf'
              : config.csvInput
                ? 'csv'
                : config.pdfInput
                  ? 'pdf'
                  : 'png';
        const inputKind = publicUrl
          ? 'publicUrl'
          : fileInputEnabled && hasFiles
            ? fileKind
            : undefined;
        let stagedInput: Buffer | undefined;
        if (inputKind) {
          const source = publicUrl
            ? await fetchPublicText(publicUrl)
            : await downloadSlackFile(attachedFiles, config.botToken, fileKind);
          if (typeof source === 'string') {
            await publishNotice(run, 'failed', source);
            return;
          }
          stagedInput = source;
        }
        const attachments = slackAttachmentMetadata(attachedFiles);
        acknowledgement = acknowledge(run);
        const job: WorkerJob = {
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
            ...(threadContext ? { threadContext } : {}),
            ...(attachments ? { attachments } : {}),
            ...(inputKind ? { [inputKind]: true } : {}),
          },
          ...(run.session ? { session: run.session } : {}),
          ...(config.csvOutput && !stagedInput ? { csvOutput: true } : {}),
          deadline: run.deadline,
          callbackUrl: `${config.origin}/api/worker/callback`,
          callbackToken,
        };
        const dispatchOutcome = stagedInput
          ? await dispatch(job, stagedInput)
          : await dispatch(job);
        const notice =
          dispatchOutcome === 'worker-unavailable'
            ? WORKER_UNAVAILABLE_REPLY
            : dispatchOutcome === 'input-staging-failed' && inputKind
              ? INPUT_STAGING_FAILURE_REPLY[inputKind]
              : undefined;
        if (notice && !(await publishNotice(run, 'failed', notice)))
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
        await renderStatus(run.runId);
      } finally {
        await acknowledgement;
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
      parsed = workerCallbackSchema.safeParse(JSON.parse(body));
    } catch {
      return new Response(null, { status: 400 });
    }
    if (!parsed.success) return new Response(null, { status: 400 });
    const result = parsed.data;
    if (result.type === 'working') {
      const run = await authenticate(request, result.runId, result.generation);
      if (run instanceof Response) return run;
      const claim = await store.claimProgress(result, now());
      if (claim === 'expired') return new Response(null, { status: 410 });
      if (claim === 'conflict') return new Response(null, { status: 409 });
      schedule(() => renderStatus(run.runId));
      return new Response(null, { status: 204 });
    }
    if (result.type === 'failed') {
      if (result.session || result.artifact)
        return new Response(null, { status: 400 });
      result.text =
        result.inputError === 'pdf_unreadable'
          ? PDF_UNREADABLE_REPLY
          : result.inputError === 'pdf_text_too_large'
            ? PDF_TEXT_TOO_LARGE_REPLY
            : WORKER_FAILURE_REPLY;
    } else if (result.inputError) {
      return new Response(null, { status: 400 });
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
    const claimAt = now();
    let csv: Buffer | undefined;
    let csvLease: string | undefined;
    if (
      result.artifact &&
      config.csvOutput &&
      collectCsv &&
      run.execution &&
      result.session &&
      !run.result &&
      claimAt < run.deadline
    ) {
      // Keep retries from racing the collection or acknowledging it early.
      csvLease = randomUUID();
      const reserved = await store
        .reserveCsvCollection(run.runId, csvLease)
        .catch(() => false);
      if (!reserved) return new Response(null, { status: 503 });

      // Collect before the worker can exit and release its Sandbox reservation.
      const bytes = await collectCsv(run.runId, run.execution).catch(
        () => undefined,
      );
      if (bytes && digest(bytes) === result.artifact.sha256) csv = bytes;
    }
    let claim;
    try {
      // Collection failure must not expire a text result already received on time.
      claim = await store.claimPublication(
        run.runId,
        result,
        claimAt,
        csvLease,
      );
    } catch {
      console.error(
        JSON.stringify({
          runId: run.runId,
          phase: 'publication_claim_uncertain',
        }),
      );
      return new Response(null, { status: 503 });
    }
    if (claim === 'duplicate') {
      schedule(() => renderStatus(run.runId));
      return new Response(null, { status: 204 });
    }
    if (claim === 'expired') return new Response(null, { status: 410 });
    if (claim === 'retry') return new Response(null, { status: 503 });
    if (claim !== 'claimed') return new Response(null, { status: 409 });
    schedule(() => publish(run, result, csv));
    return new Response(null, { status: 202 });
  }

  return { events, callback };
}

function digest(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}
