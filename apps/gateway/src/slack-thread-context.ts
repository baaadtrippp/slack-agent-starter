import { fetchSlackThreadReplies } from '@chat-adapter/slack/api';
import { z } from 'zod';
import {
  MAX_SLACK_ATTACHMENT_METADATA,
  MAX_THREAD_CONTEXT_BYTES,
  MAX_THREAD_CONTEXT_MESSAGES,
  MAX_THREAD_MESSAGE_BYTES,
  slackAttachmentSchema,
  slackContextSender,
  slackTimestamp,
} from '../../../packages/contracts/src/index.js';
import type { WorkerJob } from '../../../packages/contracts/src/index.js';
import type { RunRecord } from './store.js';

type ThreadContext = NonNullable<WorkerJob['input']['threadContext']>;

const slackFile = z.object({
  id: slackAttachmentSchema.shape.id,
  mimetype: slackAttachmentSchema.shape.mimeType.catch(undefined),
  size: slackAttachmentSchema.shape.size.catch(undefined),
});

export function slackAttachmentMetadata(files: unknown) {
  if (!Array.isArray(files)) return;
  const attachments = files
    .slice(0, MAX_SLACK_ATTACHMENT_METADATA)
    .flatMap((raw: unknown) => {
      const file = slackFile.safeParse(raw);
      if (!file.success) return [];
      const { id, mimetype, size } = file.data;
      return [
        {
          id,
          ...(mimetype === undefined ? {} : { mimeType: mimetype }),
          ...(size === undefined ? {} : { size }),
        },
      ];
    });
  return attachments.length ? attachments : undefined;
}

const slackHistoryMessage = z.object({
  type: z.literal('message'),
  ts: slackTimestamp,
  thread_ts: slackTimestamp.optional(),
  text: z.string().default(''),
  user: slackContextSender.optional(),
  bot_id: slackContextSender.optional(),
  team: z.string().optional(),
  user_team: z.string().optional(),
  source_team: z.string().optional(),
  channel: z.string().optional(),
  subtype: z.string().optional(),
  files: z.unknown().optional(),
});

export async function loadThreadContext(
  run: RunRecord,
  token: string,
): Promise<ThreadContext | undefined> {
  // The generic history API can page through the whole thread. Ask Slack for
  // one page ending before this mention, then enforce that cutoff locally.
  const page = await fetchSlackThreadReplies({
    token,
    channel: run.channelId,
    ts: run.threadTs,
    latest: run.messageTs,
    inclusive: false,
    limit: MAX_THREAD_CONTEXT_MESSAGES,
    fetch: (url, init) =>
      fetch(url, {
        ...init,
        signal: AbortSignal.timeout(5_000),
        redirect: 'error',
      }),
  });

  const earlier = page.messages
    .flatMap((raw) => {
      const parsed = slackHistoryMessage.safeParse(raw);
      if (!parsed.success) return [];
      const row = parsed.data;
      const senderId = row.user ?? row.bot_id;
      if (
        !senderId ||
        row.subtype === 'message_deleted' ||
        row.ts < run.threadTs ||
        row.ts >= run.messageTs ||
        (row.thread_ts ?? row.ts) !== run.threadTs ||
        (row.channel !== undefined && row.channel !== run.channelId) ||
        [row.team, row.user_team, row.source_team].some(
          (team) => team !== undefined && team !== run.workspaceId,
        )
      )
        return [];
      return [{ ...row, senderId }];
    })
    .sort((a, b) => a.ts.localeCompare(b.ts));

  const context: ThreadContext = {
    messages: [],
    truncated: Boolean(page.nextCursor) || page.raw.has_more === true,
  };
  for (const row of earlier) {
    if (row.ts === context.messages.at(-1)?.messageTs) continue;
    if (context.messages.length === MAX_THREAD_CONTEXT_MESSAGES) {
      context.truncated = true;
      break;
    }
    const textBytes = Buffer.from(
      row.text
        .replace(/<https?:\/\/[^>]*>|https?:\/\/[^\s<>]+/gi, '[link omitted]')
        .replace(
          /\b(?:xox[a-z0-9]*|xapp)-[a-z0-9-]+\b/gi,
          '[Slack token omitted]',
        ),
    );
    if (textBytes.length > MAX_THREAD_MESSAGE_BYTES) context.truncated = true;
    // Streaming decode drops a partial UTF-8 character at the byte boundary.
    const text = new TextDecoder().decode(
      textBytes.subarray(0, MAX_THREAD_MESSAGE_BYTES),
      { stream: true },
    );
    const attachments = slackAttachmentMetadata(row.files);
    if (
      Array.isArray(row.files) &&
      row.files.length > MAX_SLACK_ATTACHMENT_METADATA
    )
      context.truncated = true;
    context.messages.push({
      messageTs: row.ts,
      senderId: row.senderId,
      text,
      ...(attachments ? { attachments } : {}),
    });
    if (Buffer.byteLength(JSON.stringify(context)) > MAX_THREAD_CONTEXT_BYTES) {
      context.messages.pop();
      context.truncated = true;
      break;
    }
  }
  return context.messages.length ? context : undefined;
}
