import { describe, expect, it } from 'vitest';
import { workerJobSchema } from '../packages/contracts/src/index.js';

const now = 1_800_000_000_000;
const callbackToken = 'a'.repeat(64);

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    runId: '11111111-1111-4111-8111-111111111111',
    conversationId: 'b'.repeat(64),
    generation: 1,
    input: {
      text: 'Please help with this task.',
      senderId: 'U00000001',
      workspaceId: 'T00000001',
      channelId: 'C00000001',
      threadTs: '1800000000.000001',
      messageTs: '1800000000.000002',
    },
    deadline: now + 30_000,
    callbackUrl: 'https://gateway.example/api/worker/callback',
    callbackToken,
    ...overrides,
  };
}

describe('worker job contract', () => {
  it.each([
    ['save', 'workspace', 'C00000001'],
    ['read', 'T00000001', 'channel'],
  ])(
    'rejects invalid %s memory scope identifiers',
    (memory, workspaceId, channelId) => {
      const job = makeJob({ memory });
      job.input.workspaceId = workspaceId;
      job.input.channelId = channelId;

      expect(workerJobSchema.safeParse(job).success).toBe(false);
    },
  );
});
