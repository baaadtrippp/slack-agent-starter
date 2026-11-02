import { z } from 'zod';

const slackTimestamp = z.string().regex(/^\d{10}\.\d{6}$/);

export const workerJobSchema = z
  .object({
    version: z.literal(1),
    runId: z.uuid(),
    conversationId: z.string().regex(/^[0-9a-f]{64}$/),
    generation: z.number().int().positive(),
    input: z
      .object({
        text: z.string().min(1).max(12_000),
        senderId: z.string().min(1),
        workspaceId: z.string().min(1),
        channelId: z.string().min(1),
        threadTs: slackTimestamp,
        messageTs: slackTimestamp,
      })
      .strict(),
    deadline: z.number().int().positive(),
    callbackUrl: z.url().startsWith('https://'),
    callbackToken: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type WorkerJob = z.infer<typeof workerJobSchema>;

export const workerResultSchema = z
  .object({
    version: z.literal(1),
    runId: z.uuid(),
    generation: z.number().int().positive(),
    eventId: z.uuid(),
    sequence: z.literal(1),
    type: z.literal('completed'),
    text: z.string().min(1).max(4_000),
  })
  .strict();

export type WorkerResult = z.infer<typeof workerResultSchema>;

export const CANNED_REPLY =
  'Gateway round trip complete. The agent runtime is not connected yet.';
