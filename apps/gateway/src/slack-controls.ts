import {
  callSlackApi,
  type SlackApiResponse,
  type SlackFetch,
} from '@chat-adapter/slack/api';
import { parseSlackWebhookBody } from '@chat-adapter/slack/webhook';
import { z } from 'zod';

export const STOP_ACTION_ID = 'hydra_stop';
export const STATUS_ACTION_ID = 'hydra_status';

const slackId = z.string().regex(/^[A-Z][A-Z0-9]+$/);
const slackMessageTs = z.string().regex(/^\d{10}\.\d{6}$/);
const controlValueSchema = z
  .object({
    version: z.literal(1),
    runId: z.uuid(),
    generation: z.number().int().positive(),
  })
  .strict();

const actionRawSchema = z.looseObject({
  type: z.literal('button'),
  action_ts: slackMessageTs,
});

const reactionEnvelopeSchema = z.looseObject({
  type: z.literal('event_callback'),
  team_id: slackId,
  event_id: z.string().min(1),
  is_ext_shared_channel: z.literal(false).optional(),
  event: z.looseObject({
    type: z.enum(['reaction_added', 'reaction_removed']),
    user: z.string().regex(/^[UW][A-Z0-9]+$/),
    reaction: z.enum(['+1', 'thumbsup', '-1', 'thumbsdown']),
    event_ts: slackMessageTs,
    item_user: slackId.optional(),
    user_team: slackId.optional(),
    team: slackId.optional(),
    bot_id: z.never().optional(),
    bot_profile: z.never().optional(),
    item: z.looseObject({
      type: z.literal('message'),
      channel: z.string().regex(/^C[A-Z0-9]+$/),
      ts: slackMessageTs,
    }),
  }),
});

const userInfoSchema = z.looseObject({
  ok: z.literal(true),
  user: z.looseObject({
    id: z.string().regex(/^[UW][A-Z0-9]+$/),
    team_id: slackId,
    deleted: z.literal(false),
    is_bot: z.literal(false),
    is_app_user: z.literal(false).optional(),
    is_stranger: z.literal(false).optional(),
  }),
});

const channelInfoSchema = z.looseObject({
  ok: z.literal(true),
  channel: z.looseObject({
    id: z.string().regex(/^C[A-Z0-9]+$/),
    is_channel: z.literal(true),
    is_private: z.literal(false),
    is_member: z.literal(true),
    is_ext_shared: z.literal(false),
    is_pending_ext_shared: z.boolean().optional(),
  }),
});

const membersSchema = z.looseObject({
  ok: z.literal(true),
  members: z.array(z.string().regex(/^[UW][A-Z0-9]+$/)),
  response_metadata: z
    .looseObject({ next_cursor: z.string().optional() })
    .optional(),
});

export type SlackControlValue = z.infer<typeof controlValueSchema>;

export type SlackControlAction = SlackControlValue & {
  actionId: typeof STOP_ACTION_ID | typeof STATUS_ACTION_ID;
  actionTs: string;
  channelId: string;
  messageTs: string;
  threadTs: string;
  userId: string;
  workspaceId: string;
};

export type SlackFeedbackReaction = {
  added: boolean;
  authorId?: string;
  channelId: string;
  eventId: string;
  eventTs: string;
  feedback: 'up' | 'down';
  messageTs: string;
  userId: string;
  workspaceId: string;
};

export function encodeControlValue(value: SlackControlValue) {
  return JSON.stringify(controlValueSchema.parse(value));
}

/**
 * Decodes a Slack interaction only after its raw request signature has been
 * verified by the caller. The returned IDs bind a click to one status message,
 * thread, run, and conversation generation.
 */
export function parseVerifiedSlackControl(
  body: string,
  contentType: string | null,
): SlackControlAction | undefined {
  let payload;
  try {
    payload = parseSlackWebhookBody(body, {
      contentType,
    });
  } catch {
    return;
  }
  if (
    payload.kind !== 'block_actions' ||
    payload.actions.length !== 1 ||
    !payload.teamId ||
    !payload.channelId ||
    !payload.threadTs ||
    !payload.messageTs ||
    !payload.userId
  )
    return;
  const action = payload.actions[0]!;
  if (
    (action.actionId !== STOP_ACTION_ID &&
      action.actionId !== STATUS_ACTION_ID) ||
    !action.value
  )
    return;
  let value;
  try {
    value = controlValueSchema.safeParse(JSON.parse(action.value));
  } catch {
    return;
  }
  if (!value.success) return;
  const raw = actionRawSchema.safeParse(action.raw);
  if (!raw.success) return;
  return {
    ...value.data,
    actionId: action.actionId,
    actionTs: raw.data.action_ts,
    workspaceId: payload.teamId,
    channelId: payload.channelId,
    threadTs: payload.threadTs,
    messageTs: payload.messageTs,
    userId: payload.userId,
  };
}

export function parseSlackFeedbackReaction(
  raw: unknown,
): SlackFeedbackReaction | undefined {
  const parsed = reactionEnvelopeSchema.safeParse(raw);
  if (!parsed.success) return;
  const { event } = parsed.data;
  if (
    (event.user_team && event.user_team !== parsed.data.team_id) ||
    (event.team && event.team !== parsed.data.team_id)
  )
    return;
  return {
    added: event.type === 'reaction_added',
    ...(event.item_user ? { authorId: event.item_user } : {}),
    workspaceId: parsed.data.team_id,
    channelId: event.item.channel,
    userId: event.user,
    eventId: parsed.data.event_id,
    eventTs: event.event_ts,
    messageTs: event.item.ts,
    feedback:
      event.reaction === '+1' || event.reaction === 'thumbsup' ? 'up' : 'down',
  };
}

export async function verifySlackActorAndChannel(options: {
  botToken: string;
  channelId: string;
  enabledChannelIds: readonly string[];
  fetch?: SlackFetch;
  userId: string;
  workspaceId: string;
}) {
  if (
    options.userId === 'USLACKBOT' ||
    !options.enabledChannelIds.includes(options.channelId)
  )
    return false;
  const signal = AbortSignal.timeout(5_000);
  const fetchSlack = options.fetch ?? fetch;
  const apiOptions = {
    token: options.botToken,
    fetch: ((input, init) =>
      fetchSlack(input, { ...init, signal })) satisfies SlackFetch,
  };
  async function actorIsMember() {
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const raw = await callSlackApi<SlackApiResponse>(
        'conversations.members',
        {
          channel: options.channelId,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        },
        apiOptions,
      );
      const parsed = membersSchema.safeParse(raw);
      if (!parsed.success) return false;
      if (parsed.data.members.includes(options.userId)) return true;
      cursor = parsed.data.response_metadata?.next_cursor || undefined;
      if (!cursor) return false;
    }
    return false;
  }
  const [rawUser, rawChannel, member] = await Promise.all([
    callSlackApi<SlackApiResponse>(
      'users.info',
      { user: options.userId },
      apiOptions,
    ),
    callSlackApi<SlackApiResponse>(
      'conversations.info',
      { channel: options.channelId },
      apiOptions,
    ),
    actorIsMember(),
  ]);
  const user = userInfoSchema.safeParse(rawUser);
  const channel = channelInfoSchema.safeParse(rawChannel);
  return (
    user.success &&
    channel.success &&
    user.data.user.id === options.userId &&
    user.data.user.team_id === options.workspaceId &&
    channel.data.channel.id === options.channelId &&
    channel.data.channel.is_pending_ext_shared !== true &&
    member
  );
}
