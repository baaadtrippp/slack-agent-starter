import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  encodeControlValue,
  parseSlackFeedbackReaction,
  parseVerifiedSlackControl,
  STATUS_ACTION_ID,
  STOP_ACTION_ID,
  verifySlackActorAndChannel,
} from '../apps/gateway/src/slack-controls.js';

const runId = randomUUID();

function interaction(
  actionId = STOP_ACTION_ID,
  value = encodeControlValue({ version: 1, runId, generation: 3 }),
  additionalActions: Array<Record<string, unknown>> = [],
) {
  return new URLSearchParams({
    payload: JSON.stringify({
      type: 'block_actions',
      team: { id: 'TTEST1' },
      user: { id: 'UTEST1', team_id: 'TTEST1' },
      channel: { id: 'CTEST1', name: 'test' },
      container: {
        type: 'message',
        channel_id: 'CTEST1',
        message_ts: '1800000001.000001',
        thread_ts: '1800000000.000001',
      },
      message: {
        ts: '1800000001.000001',
        thread_ts: '1800000000.000001',
      },
      actions: [
        {
          type: 'button',
          action_id: actionId,
          action_ts: '1800000002.000001',
          value,
        },
        ...additionalActions,
      ],
      trigger_id: 'synthetic-trigger',
    }),
  }).toString();
}

function reaction(overrides: Record<string, unknown> = {}) {
  return {
    type: 'event_callback',
    team_id: 'TTEST1',
    event_id: 'EvSynthetic',
    is_ext_shared_channel: false,
    event: {
      type: 'reaction_added',
      user: 'UTEST1',
      reaction: '+1',
      item_user: 'UBOT1',
      item: {
        type: 'message',
        channel: 'CTEST1',
        ts: '1800000003.000001',
      },
      event_ts: '1800000004.000001',
    },
    ...overrides,
  };
}

describe('Slack controls and feedback boundary', () => {
  it.each([STOP_ACTION_ID, STATUS_ACTION_ID])(
    'decodes an exact %s action binding',
    (actionId) => {
      expect(
        parseVerifiedSlackControl(
          interaction(actionId),
          'application/x-www-form-urlencoded',
        ),
      ).toEqual({
        version: 1,
        runId,
        generation: 3,
        actionId,
        actionTs: '1800000002.000001',
        workspaceId: 'TTEST1',
        channelId: 'CTEST1',
        threadTs: '1800000000.000001',
        messageTs: '1800000001.000001',
        userId: 'UTEST1',
      });
    },
  );

  it.each([
    ['unknown action', interaction('other_action')],
    ['missing run binding', interaction(STOP_ACTION_ID, '{}')],
    [
      'multiple actions',
      interaction(STOP_ACTION_ID, undefined, [
        {
          type: 'button',
          action_id: STATUS_ACTION_ID,
          action_ts: '1800000002.000002',
        },
      ]),
    ],
  ])('rejects an %s', (_name, body) => {
    expect(
      parseVerifiedSlackControl(body, 'application/x-www-form-urlencoded'),
    ).toBeUndefined();
  });

  it.each([
    ['addition', reaction(), true, 'up'],
    [
      'removal',
      reaction({
        event: {
          ...reaction().event,
          type: 'reaction_removed',
          reaction: 'thumbsdown',
        },
      }),
      false,
      'down',
    ],
  ])('decodes a thumbs %s', (_name, payload, added, feedback) => {
    expect(parseSlackFeedbackReaction(payload)).toMatchObject({
      added,
      feedback,
      workspaceId: 'TTEST1',
      channelId: 'CTEST1',
      messageTs: '1800000003.000001',
      userId: 'UTEST1',
    });
  });

  it('decodes the documented event without an outer sharing flag for live channel verification', () => {
    const { is_ext_shared_channel, ...payload } = reaction();
    expect(is_ext_shared_channel).toBe(false);
    expect(parseSlackFeedbackReaction(payload)).toMatchObject({
      feedback: 'up',
      channelId: 'CTEST1',
    });
  });

  it.each([
    ['shared channel', reaction({ is_ext_shared_channel: true })],
    [
      'unrelated emoji',
      reaction({ event: { ...reaction().event, reaction: 'eyes' } }),
    ],
    [
      'non-message item',
      reaction({
        event: {
          ...reaction().event,
          item: { type: 'file', file: 'FTEST1' },
        },
      }),
    ],
    [
      'bot-shaped reactor',
      reaction({ event: { ...reaction().event, user: 'BTEST1' } }),
    ],
  ])('rejects a %s reaction', (_name, payload) => {
    expect(parseSlackFeedbackReaction(payload)).toBeUndefined();
  });

  it('verifies the current actor and channel with Slack', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const method = new URL(String(input)).pathname.split('/').at(-1);
      if (method === 'users.info')
        return Response.json({
          ok: true,
          user: {
            id: 'UTEST1',
            team_id: 'TTEST1',
            deleted: false,
            is_bot: false,
            is_app_user: false,
            is_stranger: false,
          },
        });
      if (method === 'conversations.members')
        return Response.json({
          ok: true,
          members: ['UOTHER1', 'UTEST1'],
          response_metadata: { next_cursor: '' },
        });
      return Response.json({
        ok: true,
        channel: {
          id: 'CTEST1',
          is_channel: true,
          is_private: false,
          is_member: true,
          is_ext_shared: false,
          is_pending_ext_shared: false,
        },
      });
    });

    await expect(
      verifySlackActorAndChannel({
        botToken: 'synthetic',
        workspaceId: 'TTEST1',
        enabledChannelIds: ['CTEST1'],
        channelId: 'CTEST1',
        userId: 'UTEST1',
        fetch,
      }),
    ).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['external actor', { user: { team_id: 'TOTHER1' } }],
    ['bot actor', { user: { is_bot: true } }],
    ['shared channel', { channel: { is_ext_shared: true } }],
    ['pending share', { channel: { is_pending_ext_shared: true } }],
    ['private channel', { channel: { is_private: true } }],
  ])('rejects a currently %s', async (_name, change) => {
    const userChange = 'user' in change ? change.user : {};
    const channelChange = 'channel' in change ? change.channel : {};
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const method = new URL(String(input)).pathname.split('/').at(-1);
      if (method === 'users.info')
        return Response.json({
          ok: true,
          user: {
            id: 'UTEST1',
            team_id: 'TTEST1',
            deleted: false,
            is_bot: false,
            is_app_user: false,
            is_stranger: false,
            ...userChange,
          },
        });
      if (method === 'conversations.members')
        return Response.json({
          ok: true,
          members: ['UTEST1'],
          response_metadata: { next_cursor: '' },
        });
      return Response.json({
        ok: true,
        channel: {
          id: 'CTEST1',
          is_channel: true,
          is_private: false,
          is_member: true,
          is_ext_shared: false,
          is_pending_ext_shared: false,
          ...channelChange,
        },
      });
    });
    await expect(
      verifySlackActorAndChannel({
        botToken: 'synthetic',
        workspaceId: 'TTEST1',
        enabledChannelIds: ['CTEST1'],
        channelId: 'CTEST1',
        userId: 'UTEST1',
        fetch,
      }),
    ).resolves.toBe(false);
  });

  it('finds the actor beyond the tenth membership page', async () => {
    let memberPage = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const method = new URL(String(input)).pathname.split('/').at(-1);
      if (method === 'users.info')
        return Response.json({
          ok: true,
          user: {
            id: 'UTEST1',
            team_id: 'TTEST1',
            deleted: false,
            is_bot: false,
          },
        });
      if (method === 'conversations.members') {
        memberPage += 1;
        return Response.json({
          ok: true,
          members: memberPage === 11 ? ['UTEST1'] : ['UOTHER1'],
          response_metadata: {
            next_cursor: memberPage < 11 ? `next-${memberPage}` : '',
          },
        });
      }
      return Response.json({
        ok: true,
        channel: {
          id: 'CTEST1',
          is_channel: true,
          is_private: false,
          is_member: true,
          is_ext_shared: false,
        },
      });
    });
    await expect(
      verifySlackActorAndChannel({
        botToken: 'synthetic',
        workspaceId: 'TTEST1',
        enabledChannelIds: ['CTEST1'],
        channelId: 'CTEST1',
        userId: 'UTEST1',
        fetch,
      }),
    ).resolves.toBe(true);
    expect(memberPage).toBe(11);
  });

  it('rejects a repeated membership cursor', async () => {
    let memberPage = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const method = new URL(String(input)).pathname.split('/').at(-1);
      if (method === 'users.info')
        return Response.json({
          ok: true,
          user: {
            id: 'UTEST1',
            team_id: 'TTEST1',
            deleted: false,
            is_bot: false,
          },
        });
      if (method === 'conversations.members') {
        memberPage += 1;
        return Response.json({
          ok: true,
          members: ['UOTHER1'],
          response_metadata: { next_cursor: 'same-cursor' },
        });
      }
      return Response.json({
        ok: true,
        channel: {
          id: 'CTEST1',
          is_channel: true,
          is_private: false,
          is_member: true,
          is_ext_shared: false,
        },
      });
    });
    await expect(
      verifySlackActorAndChannel({
        botToken: 'synthetic',
        workspaceId: 'TTEST1',
        enabledChannelIds: ['CTEST1'],
        channelId: 'CTEST1',
        userId: 'UTEST1',
        fetch,
      }),
    ).resolves.toBe(false);
    expect(memberPage).toBe(2);
  });
});
