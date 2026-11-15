import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  limits,
  workerJobSchema,
} from '../packages/contracts/src/index.js';

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
    limits,
    deadline: now + 30_000,
    callbackUrl: 'https://gateway.example/api/worker/callback',
    callbackToken,
    ...overrides,
  };
}

it.each([
  [16 * 1024, '16 KiB'],
  [10_000, '10,000 bytes'],
  [512, '512 bytes'],
])('prints the limit %i as %s', (bytes, text) => {
  expect(formatBytes(bytes)).toBe(text);
});

describe('worker job contract', () => {
  it('requires every content limit as a positive integer', () => {
    expect(workerJobSchema.safeParse(makeJob()).success).toBe(true);
    for (const value of [undefined, 0, 1.5])
      expect(
        workerJobSchema.safeParse(
          makeJob({ limits: { ...limits, inputFileBytes: value } }),
        ).success,
      ).toBe(false);
  });

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
