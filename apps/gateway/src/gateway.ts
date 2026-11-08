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
import { Actions, Button, CardText, Chat, ConsoleLogger, emoji } from 'chat';
import type { StateAdapter } from 'chat';
import { z } from 'zod';
import {
  MAX_RETAINED_INPUTS,
  MAX_SLACK_INPUT_FILES,
  SHARED_NOTE_BYTE_LIMIT,
  SHARED_NOTE_SAVED,
  WORKER_FAILURE_REPLY,
  workerCallbackSchema,
  workerResultSchema,
} from '../../../packages/contracts/src/index.js';
import type {
  ArtifactFormat,
  StagedSource,
  WorkerJob,
  WorkerResult,
} from '../../../packages/contracts/src/index.js';
import { fetchPublicText } from './public-url.js';
import {
  encodeControlValue,
  parseSlackFeedbackReaction,
  parseVerifiedSlackControl,
  STATUS_ACTION_ID,
  STOP_ACTION_ID,
  verifySlackActorAndChannel,
} from './slack-controls.js';
import type { SlackFeedbackReaction } from './slack-controls.js';
import { downloadSlackFile, selectSlackFileKind } from './slack-file.js';
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
  fileExchange?: boolean;
  jpegInput?: boolean;
  csvInput?: boolean;
  pdfInput?: boolean;
  pngInput?: boolean;
  csvOutput?: boolean;
  publicUrlInput?: boolean;
  controlsEnabled?: boolean;
  operatorIds?: string[];
};

export type WorkerInspection =
  | { state: 'unknown' }
  | { state: 'stopped'; completed?: WorkerResult }
  | {
      state: 'exited';
      result?: WorkerResult;
      artifactTarget?: SandboxTarget;
      artifactBytes?: Buffer;
      sessionRestored?: true;
    };

type GatewayOptions = {
  config: GatewayConfig;
  state: StateAdapter;
  store: RunStore;
  dispatch: (
    job: WorkerJob,
    stagedInputs?: Buffer[],
  ) => Promise<
    | void
    | 'worker-unavailable'
    | 'worker-start-failed'
    | 'input-staging-failed'
    | 'input-storage-full'
  >;
  collectArtifact?: (
    runId: string,
    target: SandboxTarget,
    format?: ArtifactFormat,
  ) => Promise<Buffer>;
  isSandboxStopped?: (target: SandboxTarget) => Promise<boolean>;
  inspectWorker?: (run: RunRecord, stop: boolean) => Promise<WorkerInspection>;
  releaseRecoveredWorker?: (
    run: RunRecord,
    reconcileExit?: boolean,
  ) => Promise<void>;
  schedule: (task: () => Promise<void>) => void;
  now?: () => number;
};

export const BUSY_REPLY =
  'This thread has an unfinished run. Your message was not submitted. Please resend it after the run finishes. If it remains unfinished, ask the operator to inspect it.';

export const STARTING_STATUS = 'Starting…';

function statusText(run: RunRecord) {
  switch (run.state) {
    case 'stopping':
      return 'Stopping…';
    case 'stopped':
      return 'Stopped. You can send another request in this thread.';
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
      if (run.memory === 'save') return SHARED_NOTE_UNCONFIRMED_REPLY;
      return run.controls
        ? 'Failed: work ended without a confirmed result. Mention me again to try a fresh run.'
        : 'Failed: the worker environment stopped without a confirmed result. Mention me again to try a fresh run.';
    default:
      return run.progress ? 'Working…' : STARTING_STATUS;
  }
}

export const RECOVERED_REPLY =
  'The environment assigned to the previous run has stopped. Hydra could not confirm a result. This message was not submitted. Mention me again in this thread to try a fresh run.';

export const WORKER_UNAVAILABLE_REPLY =
  'The worker is unavailable. Your message was not submitted. Mention me again when the worker is ready.';
export const WORKER_START_FAILURE_REPLY =
  'The worker could not start. Your message was not submitted. Mention me again when the worker is ready.';

const INPUT_STAGING_FAILURE_REPLY =
  'The inputs could not be staged. Resend the message with its files and links to retry.';
const INPUT_STORAGE_FULL_REPLY =
  'Workspace storage is full. Your request was not submitted. Ask an operator to free space, then resend your message.';
const WORKER_STORAGE_FULL_REPLY =
  'Workspace storage is full. Ask an operator to free space, then retry.';
const SHARED_NOTE_STORAGE_FULL_REPLY =
  'Workspace storage is full. Check the channel’s shared notes before resending your request.';
const WORKER_QUOTA_REPLY =
  'The model provider is out of quota or rate-limited. Try again after the provider limit clears.';
const UNSUPPORTED_FILE_REPLY =
  'Attach a supported Slack-hosted UTF-8 text, Markdown, source, JSON, CSV, text-based PDF, or enabled image file.';
const THREAD_CONTEXT_UNAVAILABLE_REPLY =
  'I could not read the earlier messages in this thread. Your request was not submitted. Mention me again in this thread to retry.';
const PDF_UNREADABLE_REPLY =
  'I could not extract readable text from this PDF. Mention me again with a small text-based PDF.';
const PDF_TEXT_TOO_LARGE_REPLY =
  'The PDF contains more than 16 KiB of text for this test. Mention me again with a shorter PDF.';
const RETAINED_SOURCES_UNAVAILABLE_REPLY =
  'I could not reopen an earlier file or link in this thread. Start a new message in the channel, mention me there, and include the files and links you still need.';

const SHARED_NOTE_UNCONFIRMED_REPLY =
  'I could not confirm the shared note save. Check the channel’s shared notes before resending it.';
const SHARED_NOTE_FULL_REPLY =
  'This channel’s shared notes are full. The existing notes are still available.';
const SHARED_NOTES_UNAVAILABLE_REPLY =
  'I could not open this channel’s shared notes. Please try again later.';

const MAX_BODY_BYTES = 32 * 1024;
const MAX_EVENT_BYTES = 256 * 1024;
const RUN_DURATION_MS = 60_000;
const CONTROL_FRESHNESS_MS = 300_000;

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
    text: z.string().default(''),
  }),
});

const eventAuthorizations = z.object({
  authorizations: z.array(
    z.object({
      team_id: z.string(),
      user_id: z.string(),
      is_bot: z.boolean(),
    }),
  ),
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
  collectArtifact,
  isSandboxStopped,
  inspectWorker,
  releaseRecoveredWorker,
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

  function statusMessage(run: RunRecord) {
    const active = run.state === 'accepted' || run.state === 'dispatch_failed';
    const expired = run.deadline <= now();
    const text =
      run.controls && expired && active
        ? 'The run deadline passed. Its outcome is unconfirmed. Use Status to check again.'
        : run.controls && expired && run.state === 'publishing'
          ? 'Finishing: result delivery is unconfirmed.'
          : statusText(run);
    if (!run.controls) return text;
    const value = encodeControlValue({
      version: 1,
      runId: run.runId,
      generation: run.generation,
    });
    const children = [
      CardText(text),
      ...(config.controlsEnabled &&
      (active || run.state === 'stopping' || run.state === 'publishing')
        ? [
            Actions([
              ...(active && run.memory !== 'save'
                ? [
                    Button({
                      id: STOP_ACTION_ID,
                      label: 'Stop',
                      style: 'danger',
                      value,
                    }),
                  ]
                : []),
              Button({ id: STATUS_ACTION_ID, label: 'Status', value }),
            ]),
          ]
        : []),
    ];
    return { type: 'card' as const, children };
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
                  statusMessage(current),
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

  async function publish(
    run: RunRecord,
    result: WorkerResult,
    artifact?: Buffer,
  ) {
    let messageId: string | undefined;
    let threadId: string;
    let publishingStatus: Promise<void> | undefined;
    try {
      await initializeBot();
      publishingStatus = renderStatus(run.runId);
      threadId = threadIdFor(run);
      if (
        config.controlsEnabled &&
        run.kind === 'work' &&
        run.memory !== 'save' &&
        result.type === 'completed'
      ) {
        await store
          .openAnswerPublication(run.workspaceId, run.channelId)
          .catch(() => {});
      }
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
      await releaseRecoveredWorker?.(run).catch(() => {});
      return;
    }

    if (result.artifact) {
      const attachmentStatus = renderStatus(run.runId);
      const thread = bot.thread(threadId);
      const format = result.artifact.format ?? 'csv';
      const filename = 'result.' + format;
      const mimeType =
        format === 'csv'
          ? 'text/csv'
          : format === 'md'
            ? 'text/markdown'
            : 'text/plain';
      let artifactPublication: 'uploaded' | 'failed';
      try {
        if (!artifact) throw new Error('Generated file was unavailable');
        const upload = await slack.postMessage(threadId, {
          markdown: '',
          files: [{ data: artifact, filename, mimeType }],
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
            phase: 'artifact_uploaded',
            bytes: artifact.length,
          }),
        );
      } catch {
        artifactPublication = 'failed';
        console.error(
          JSON.stringify({
            runId: run.runId,
            phase: 'artifact_attachment_unconfirmed',
            category: artifact ? 'slack_upload' : 'artifact_unavailable',
          }),
        );
        await thread
          .post(
            'I could not confirm the ' +
              filename +
              ' attachment. The text result is above.',
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
    await releaseRecoveredWorker?.(run).catch(() => {});
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

  async function confirmStop(run: RunRecord, rendering?: Promise<void>) {
    const inspection = run.execution
      ? await inspectWorker?.(run, true).catch(() => undefined)
      : undefined;
    const stopped =
      !run.execution ||
      inspection?.state === 'stopped' ||
      (!run.session &&
        (await isSandboxStopped?.(run.execution).catch(() => false)));
    await rendering;
    if (!stopped) return;
    const completed =
      inspection?.state === 'stopped' ? inspection.completed : undefined;
    if (completed && validateResult(run, completed)) return;
    const confirmed = await store.confirmStopped(run, completed?.session);
    if (confirmed !== 'conflict') await releaseRecoveredWorker?.(run);
  }

  function validateResult(run: RunRecord, result: WorkerResult) {
    if (result.type === 'failed') {
      if (result.session || result.artifact) return 400;
      if (result.failureCategory === 'provider_quota') {
        result.text = WORKER_QUOTA_REPLY;
        return;
      }
      if (result.failureCategory === 'drive_full') {
        result.text =
          run.memory === 'save'
            ? SHARED_NOTE_STORAGE_FULL_REPLY
            : WORKER_STORAGE_FULL_REPLY;
        return;
      }
      if (run.memory === 'save') {
        result.text =
          result.inputError === 'shared_notes_full'
            ? SHARED_NOTE_FULL_REPLY
            : SHARED_NOTE_UNCONFIRMED_REPLY;
        return;
      }
      if (
        run.memory === 'read' &&
        result.inputError === 'shared_notes_unavailable'
      ) {
        result.text = SHARED_NOTES_UNAVAILABLE_REPLY;
        return;
      }
      result.text =
        result.inputError === 'pdf_unreadable'
          ? PDF_UNREADABLE_REPLY
          : result.inputError === 'pdf_text_too_large'
            ? PDF_TEXT_TOO_LARGE_REPLY
            : result.inputError === 'too_many_sources'
              ? 'This thread has reached its ' +
                MAX_RETAINED_INPUTS +
                '-source limit. Start a new thread to add more files or links.'
              : result.inputError === 'retained_sources_unavailable'
                ? RETAINED_SOURCES_UNAVAILABLE_REPLY
                : WORKER_FAILURE_REPLY;
      return;
    }
    if (result.inputError || result.failureCategory) return 400;
    if (run.memory === 'save') {
      if (
        result.session ||
        result.artifact ||
        result.text !== SHARED_NOTE_SAVED
      )
        return 409;
      return;
    }
    const expected = run.session;
    const received = result.session;
    if (
      (!received && (expected || config.threadResume)) ||
      (received && received.seedRunId !== (expected?.seedRunId ?? run.runId)) ||
      (received &&
        expected &&
        (received.nativeId !== expected.nativeId ||
          received.adapterId !== expected.adapterId ||
          received.revision <= expected.revision ||
          (expected.hasRetainedSources && !received.hasRetainedSources)))
    )
      return 409;
  }

  async function readArtifact(
    run: Pick<RunRecord, 'runId' | 'execution' | 'recovery'>,
    result: WorkerResult,
    onAttempt?: (target: SandboxTarget) => void,
  ) {
    const collect = collectArtifact;
    const artifact = result.artifact;
    if (!artifact || !run.execution || !collect) return;
    const getRecovery = async () =>
      (await store.getRun(run.runId).catch(() => undefined))?.recovery;
    const target = (await getRecovery()) ?? run.recovery ?? run.execution;
    const readFrom = (execution: SandboxTarget) => {
      onAttempt?.(execution);
      return collect(run.runId, execution, artifact.format).catch(
        () => undefined,
      );
    };
    let bytes = await readFrom(target);
    if (!bytes) {
      const moved = await getRecovery();
      if (
        moved &&
        (moved.sandboxName !== target.sandboxName ||
          moved.sessionId !== target.sessionId)
      )
        bytes = await readFrom(moved);
    }
    return bytes && digest(bytes) === artifact.sha256 ? bytes : undefined;
  }

  function supportsArtifact(result: WorkerResult) {
    return (
      result.artifact &&
      (config.fileExchange ||
        (config.csvOutput && (result.artifact.format ?? 'csv') === 'csv'))
    );
  }

  async function reconcileStatus(run: RunRecord, rendering?: Promise<void>) {
    try {
      if (run.state === 'stopping') {
        await confirmStop(run, rendering);
        return;
      }
      if (
        [
          'completed',
          'worker_failed',
          'publication_uncertain',
          'interrupted',
          'stopped',
        ].includes(run.state)
      ) {
        await releaseRecoveredWorker?.(run, true);
        return;
      }
      if (run.state !== 'accepted' && run.state !== 'dispatch_failed') return;
      let exited = !run.execution;
      let sessionRestored = false;
      if (run.execution && inspectWorker) {
        const inspection = await inspectWorker(run, false).catch(
          () => undefined,
        );
        exited = inspection?.state === 'exited';
        sessionRestored =
          inspection?.state === 'exited' && inspection.sessionRestored === true;
        if (inspection?.state === 'exited' && inspection.result) {
          const result = inspection.result;
          if (
            result.runId !== run.runId ||
            result.generation !== run.generation ||
            validateResult(run, result)
          )
            return;
          const bytes = inspection.artifactTarget
            ? inspection.artifactBytes
            : supportsArtifact(result)
              ? await readArtifact(run, result)
              : undefined;
          const artifact =
            bytes && digest(bytes) === result.artifact?.sha256
              ? bytes
              : undefined;
          const saved = await store.claimSavedResult(run, result);
          if (saved === 'claimed') {
            try {
              await publish(run, result, artifact);
            } finally {
              await releaseRecoveredWorker?.(run);
            }
          } else if (saved === 'duplicate') await releaseRecoveredWorker?.(run);
          return;
        }
      }
      if (
        run.deadline <= now() &&
        exited &&
        (await store.interruptRun(
          (await store.getRun(run.runId)) ?? run,
          now(),
          sessionRestored,
        ))
      )
        await releaseRecoveredWorker?.(run);
    } finally {
      await renderStatus(run.runId);
    }
  }

  async function recoverInterruptedRun(
    run: RunRecord,
  ): Promise<string | false> {
    if (!run.blockedBy) return false;
    const previous = await store.getRun(run.blockedBy);
    if (
      !previous ||
      previous.workspaceId !== run.workspaceId ||
      previous.channelId !== run.channelId ||
      previous.threadTs !== run.threadTs
    )
      return false;
    const saving = previous.memory === 'save';
    const recoveryReply = saving
      ? SHARED_NOTE_UNCONFIRMED_REPLY + ' This message was not submitted.'
      : RECOVERED_REPLY;
    if (previous.controls && config.controlsEnabled) {
      if (previous.deadline <= now()) await reconcileStatus(previous);
      const current = await store.getRun(previous.runId);
      if (
        current?.state === 'interrupted' &&
        (await store.interruptRun(current, now()))
      )
        return recoveryReply;
      if (
        current &&
        ['completed', 'worker_failed', 'stopped'].includes(current.state) &&
        (await store.isThreadAvailable(current))
      )
        return 'The previous run ended. This message was not submitted. Please resend it.';
      return false;
    }
    if (!isSandboxStopped || !previous.execution) return false;
    if (previous.state !== 'interrupted') {
      if (
        (previous.session && !saving) ||
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
    return recovered && recoveryReply;
  }

  function channelEnabled(workspaceId: string, channelId: string) {
    return (
      workspaceId === config.workspaceId &&
      config.channelIds.includes(channelId)
    );
  }

  async function actorAllowed(channelId: string, userId: string) {
    return verifySlackActorAndChannel({
      botToken: config.botToken,
      workspaceId: config.workspaceId,
      enabledChannelIds: config.channelIds,
      channelId,
      userId,
    });
  }

  async function feedback(event: SlackFeedbackReaction) {
    const answer = {
      workspaceId: event.workspaceId,
      channelId: event.channelId,
      messageId: event.messageTs,
    };
    const published = await store.getPublishedAnswer(answer);
    let allowPending = false;
    if (
      !published &&
      event.authorId &&
      (await store.hasOpenAnswerPublication(event.workspaceId, event.channelId))
    ) {
      await initializeBot().catch(() => {});
      allowPending = slack.botUserId === event.authorId;
    }
    if (
      (!published && !allowPending) ||
      !(await actorAllowed(event.channelId, event.userId))
    )
      return;
    await store.recordFeedback(
      answer,
      event.userId,
      event.feedback === 'up' ? 'thumbsup' : 'thumbsdown',
      event.added ? 'added' : 'removed',
      event.eventTs,
      allowPending,
    );
  }

  async function interactions(request: Request): Promise<Response> {
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
    const action = parseVerifiedSlackControl(
      body,
      request.headers.get('content-type'),
    );
    if (
      !config.controlsEnabled ||
      !action ||
      action.actionTs < action.messageTs ||
      Math.abs(now() - Number(action.actionTs) * 1_000) >
        CONTROL_FRESHNESS_MS ||
      !channelEnabled(action.workspaceId, action.channelId)
    )
      return new Response(null, { status: 200 });
    schedule(async () => {
      const run = await store.getRun(action.runId);
      if (
        !run?.controls ||
        run.kind !== 'work' ||
        run.generation !== action.generation ||
        run.workspaceId !== action.workspaceId ||
        run.channelId !== action.channelId ||
        run.threadTs !== action.threadTs ||
        run.statusMessageId !== action.messageTs ||
        (action.actionId === STOP_ACTION_ID &&
          (run.memory === 'save' ||
            (run.senderId !== action.userId &&
              !config.operatorIds?.includes(action.userId)))) ||
        !(await actorAllowed(action.channelId, action.userId).catch(
          () => false,
        ))
      )
        return;
      if (action.actionId === STATUS_ACTION_ID) {
        await reconcileStatus(run);
        return;
      }
      const outcome = await store.requestStop({
        runId: run.runId,
        generation: run.generation,
        statusMessageId: action.messageTs,
      });
      if (outcome === 'requested') {
        const current = await store.getRun(run.runId);
        if (current) {
          const rendering = renderStatus(run.runId);
          await reconcileStatus(current, rendering);
        }
      } else if (outcome !== 'conflict') {
        await renderStatus(run.runId);
      }
    });
    return new Response(null, { status: 200 });
  }

  async function busyMessage(run: RunRecord) {
    if (!config.controlsEnabled || !run.blockedBy) return BUSY_REPLY;
    const active = await store.getRun(run.blockedBy);
    if (
      !active?.controls ||
      !active.statusMessageId ||
      !['accepted', 'dispatch_failed', 'stopping', 'publishing'].includes(
        active.state,
      )
    )
      return BUSY_REPLY;
    return 'This thread has an unfinished run. Your message was not submitted. Use Status on the current run’s status message and resend your message after the run ends.';
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
    if (config.controlsEnabled && payload.kind === 'unsupported') {
      const reaction = parseSlackFeedbackReaction(payload.raw);
      if (reaction) {
        if (!channelEnabled(reaction.workspaceId, reaction.channelId))
          return new Response(null, { status: 200 });
        // A transient lookup or Redis failure leaves the delivery retryable.
        // Bound the entire receipt so Slack gets a response within its deadline.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const status = await Promise.race([
            feedback(reaction).then(
              () => 200,
              () => 503,
            ),
            new Promise<number>((resolve) => {
              timer = setTimeout(() => resolve(503), 2_200);
            }),
          ]);
          return new Response(null, { status });
        } finally {
          clearTimeout(timer);
        }
      }
    }
    const mention = payload.kind === 'app_mention';
    const input =
      payload.kind === 'app_mention'
        ? payload
        : config.threadResume && payload.kind === 'unsupported'
          ? parseThreadReply(payload.raw)
          : undefined;
    if (!input) return new Response(null, { status: 200 });

    const currentText = input.text.trimStart();
    const leadingMention = currentText.match(/^<@([UW][A-Z0-9]+)>\s+/);
    // The same Slack message can arrive as a reply and a mention. On a cold
    // gateway, the signed envelope identifies the installed bot before admission.
    const botUserId =
      slack.botUserId ??
      (leadingMention
        ? eventAuthorizations
            .safeParse(mention ? JSON.parse(body) : payload.raw)
            .data?.authorizations.find(
              (authorization) =>
                authorization.is_bot &&
                authorization.team_id === config.workspaceId,
            )?.user_id
        : undefined);
    const botMention =
      leadingMention && leadingMention[1] === botUserId ? leadingMention : null;
    const command =
      !mention || botMention
        ? currentText
            .slice(botMention?.[0].length ?? 0)
            .match(/^(remember for this channel:|use shared notes:)([\s\S]*)$/i)
        : null;
    const memory = command
      ? command[1]!.toLowerCase() === 'remember for this channel:'
        ? 'save'
        : 'read'
      : undefined;
    const saving = memory === 'save';

    const rawEvent = input.raw;
    const attachedFiles = rawEvent?.files;
    const hasFiles = Array.isArray(attachedFiles) && attachedFiles.length > 0;
    const enabledFiles = {
      csv: config.fileExchange || config.csvInput,
      pdf: config.fileExchange || config.pdfInput,
      png: config.pngInput,
      jpeg: config.jpegInput,
      text: config.fileExchange,
    };
    const fileInputEnabled = Object.values(enabledFiles).some(Boolean);
    const fileShare =
      (fileInputEnabled || saving) &&
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
      (!input.text.trim() && !(hasFiles && fileInputEnabled && !mention)) ||
      input.text.length > 12_000 ||
      !rawEvent ||
      rawEvent.bot_id ||
      rawEvent.bot_profile ||
      (rawEvent.subtype !== undefined && !fileShare) ||
      (!mention && !saving && !fileInputEnabled && hasFiles) ||
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
      ...(memory ? { memory } : {}),
      ...(config.controlsEnabled && inspectWorker ? { controls: true } : {}),
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
            return false as const;
          });
          if (
            !(await publishNotice(
              run,
              'completed',
              recovered || (await busyMessage(run)),
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
        let text = input.text;
        if (command) {
          const allowed = await actorAllowed(run.channelId, run.senderId).catch(
            () => false,
          );
          if (botMention && allowed) await initializeBot();
          if (!allowed || (botMention && botMention[1] !== slack.botUserId)) {
            await publishNotice(
              run,
              'failed',
              'Shared notes are available to internal members of this enabled channel.',
            );
            return;
          }
          text = command[2]!.trim();
          if (memory === 'save') text = unescapeSlackText(text).trim();
          if (
            !text ||
            (memory === 'save' &&
              (Buffer.byteLength(text) > SHARED_NOTE_BYTE_LIMIT ||
                /[\p{Cc}\p{Zl}\p{Zp}]/u.test(text)))
          ) {
            await publishNotice(
              run,
              'failed',
              memory === 'save'
                ? 'Put the note on one line after “remember for this channel:”, up to 512 UTF-8 bytes.'
                : 'Put your question after “use shared notes:”.',
            );
            return;
          }
        }
        const links =
          !saving && config.publicUrlInput
            ? currentMessageLinks(input.text)
            : [];
        const publicUrl = links[0];
        if (links.length > 1) {
          await publishNotice(
            run,
            'failed',
            'Send at most one public HTTPS link per message.',
          );
          return;
        }

        const files =
          !saving && fileInputEnabled && hasFiles ? attachedFiles : [];
        if (files.length > MAX_SLACK_INPUT_FILES) {
          await publishNotice(
            run,
            'failed',
            'Attach at most ' +
              MAX_SLACK_INPUT_FILES +
              ' Slack files per message.',
          );
          return;
        }
        const sources: StagedSource[] = [];
        const downloads: Promise<Buffer | string>[] = [];
        const selected = files.map((file: unknown) =>
          selectSlackFileKind(file),
        );
        if (selected.some((kind) => !kind || !enabledFiles[kind])) {
          await publishNotice(run, 'failed', UNSUPPORTED_FILE_REPLY);
          return;
        }
        for (const [index, kind] of selected.entries()) {
          if (kind)
            downloads.push(
              downloadSlackFile([files[index]], config.botToken, kind),
            );
        }
        if (publicUrl) downloads.push(fetchPublicText(publicUrl));
        const stagedInputs: Buffer[] = [];
        for (const [index, value] of (await Promise.all(downloads)).entries()) {
          if (typeof value === 'string') {
            await publishNotice(run, 'failed', value);
            return;
          }
          const kind = selected[index] ?? 'publicUrl';
          sources.push({
            kind,
            name: kind === 'publicUrl' ? 'Public URL text' : files[index].name,
            sha256: digest(value),
          });
          stagedInputs.push(value);
        }

        let threadContext: WorkerJob['input']['threadContext'];
        if (
          !saving &&
          mention &&
          !run.session &&
          run.threadTs !== run.messageTs
        ) {
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

        const attachments = saving
          ? undefined
          : slackAttachmentMetadata(attachedFiles);
        acknowledgement = acknowledge(run);
        const job: WorkerJob = {
          version: 1,
          runId: run.runId,
          conversationId: run.conversationId,
          generation: run.generation,
          input: {
            text: text.trim()
              ? text
              : 'Use the attached files for this thread.',
            senderId: run.senderId,
            workspaceId: run.workspaceId,
            channelId: run.channelId,
            threadTs: run.threadTs,
            messageTs: run.messageTs,
            ...(threadContext ? { threadContext } : {}),
            ...(attachments ? { attachments } : {}),
            ...(sources.length ? { sources } : {}),
          },
          ...(run.session ? { session: run.session } : {}),
          ...(memory ? { memory } : {}),
          ...(!saving && config.fileExchange
            ? { artifactOutput: true }
            : !saving && config.csvOutput
              ? { csvOutput: true }
              : {}),
          deadline: run.deadline,
          callbackUrl: `${config.origin}/api/worker/callback`,
          callbackToken,
        };
        const dispatchOutcome = stagedInputs.length
          ? await dispatch(job, stagedInputs)
          : await dispatch(job);
        const notice =
          dispatchOutcome === 'worker-unavailable'
            ? WORKER_UNAVAILABLE_REPLY
            : dispatchOutcome === 'worker-start-failed'
              ? WORKER_START_FAILURE_REPLY
              : dispatchOutcome === 'input-storage-full'
                ? INPUT_STORAGE_FULL_REPLY
                : dispatchOutcome === 'input-staging-failed'
                  ? INPUT_STAGING_FAILURE_REPLY
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
        if (run.controls) {
          const current = await store.getRun(run.runId);
          if (current?.state === 'stopping') await reconcileStatus(current);
        }
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
        run.state !== 'interrupted' &&
        run.state !== 'stopped'
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
      const memory = url.searchParams.get('memory') ?? undefined;
      if (
        auth.memory !== memory ||
        (memory &&
          (!channelEnabled(auth.workspaceId, auth.channelId) ||
            url.searchParams.get('workspaceId') !== auth.workspaceId ||
            url.searchParams.get('channelId') !== auth.channelId ||
            url.searchParams.get('messageTs') !== auth.messageTs))
      )
        return new Response(null, { status: 409 });
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
    const run = await authenticate(request, result.runId, result.generation);
    if (run instanceof Response) return run;
    if (run.state === 'stopping' || run.state === 'stopped')
      return new Response(null, { status: 409 });
    const invalid = validateResult(run, result);
    if (invalid) return new Response(null, { status: invalid });
    const claimAt = now();
    let artifact: Buffer | undefined;
    let artifactLease: string | undefined;
    let artifactTarget: SandboxTarget | undefined;
    if (
      supportsArtifact(result) &&
      collectArtifact &&
      run.execution &&
      result.session &&
      !run.result &&
      claimAt < run.deadline
    ) {
      // Keep retries from racing the collection or acknowledging it early.
      artifactLease = randomUUID();
      const reserved = await store
        .reserveArtifactCollection(run.runId, artifactLease)
        .catch(() => false);
      if (!reserved) return new Response(null, { status: 503 });

      // Collect before the worker can exit and release its Sandbox reservation.
      artifact = await readArtifact(run, result, (target) => {
        artifactTarget = target;
      });
    }
    let claim;
    try {
      // Collection failure must not expire a text result already received on time.
      claim = await store.claimPublication(
        run.runId,
        result,
        claimAt,
        artifactLease,
        artifactTarget,
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
      schedule(async () => {
        await releaseRecoveredWorker?.(run).catch(() => {});
        await renderStatus(run.runId);
      });
      return new Response(null, { status: 204 });
    }
    if (claim === 'expired') return new Response(null, { status: 410 });
    if (claim === 'retry') return new Response(null, { status: 503 });
    if (claim !== 'claimed') return new Response(null, { status: 409 });
    schedule(() => publish(run, result, artifact));
    return new Response(null, { status: 202 });
  }

  return { events, interactions, callback };
}

function currentMessageLinks(text: string) {
  const plain = text.replace(/`{3}[\s\S]*?`{3}|`[^`\n]*`/g, ' ');
  const explicit = Array.from(
    plain.matchAll(/<(https?:\/\/[^\s<>|]+)(?:\|[^>]*)?>/gi),
    ([, url]) => unescapeSlackText(url!),
  );
  const bare = (
    plain.replace(/<[^>]*>/g, ' ').match(/https?:\/\/[^\s<>|]+/gi) ?? []
  ).map((url) => trimBareLink(unescapeSlackText(url)));
  return [...new Set([...explicit, ...bare])];
}

function trimBareLink(url: string) {
  let unmatchedClosing = url.split(')').length - url.split('(').length;
  let end = url.length;
  while (end > 0) {
    const character = url[end - 1]!;
    if (character === ')' && unmatchedClosing > 0) unmatchedClosing -= 1;
    else if (!/[.,;:!?"']/.test(character)) break;
    end -= 1;
  }
  return url.slice(0, end);
}

function digest(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}
