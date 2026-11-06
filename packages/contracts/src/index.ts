import { z } from 'zod';

const workerSessionSchema = z
  .object({
    seedRunId: z.uuid(),
    nativeId: z.uuid(),
    adapterId: z.uuid(),
    revision: z.number().int().positive(),
  })
  .strict();

export type WorkerSession = z.infer<typeof workerSessionSchema>;

export const slackTimestamp = z.string().regex(/^\d{10}\.\d{6}$/);
export const slackContextSender = z.string().regex(/^[UWB][A-Z0-9]{1,31}$/);

export const MAX_SLACK_ATTACHMENT_METADATA = 5;
export const MAX_THREAD_CONTEXT_MESSAGES = 20;
export const MAX_THREAD_MESSAGE_BYTES = 2 * 1024;
export const MAX_THREAD_CONTEXT_BYTES = 16 * 1024;

export const slackAttachmentSchema = z
  .object({
    id: z.string().regex(/^F[A-Z0-9]{1,31}$/),
    mimeType: z
      .string()
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,62}\/[A-Za-z0-9][A-Za-z0-9.+_-]{0,62}$/,
      )
      .optional(),
    size: z.int().nonnegative().optional(),
  })
  .strict();

export const MAX_SLACK_INPUT_FILES = 5;
export const MAX_RETAINED_INPUTS = 12;
export const INPUT_BYTE_LIMIT = 16 * 1024;

export const artifactFormats = [
  'csv',
  'md',
  'diff',
  'patch',
  'txt',
  'js',
  'mjs',
  'ts',
  'tsx',
  'jsx',
  'py',
  'go',
  'rs',
  'rb',
  'java',
  'kt',
  'cs',
  'c',
  'cpp',
  'h',
  'sh',
  'sql',
  'json',
  'yaml',
  'yml',
  'html',
  'css',
] as const;

const checksum = z.string().regex(/^[0-9a-f]{64}$/);
const stagedSourceSchema = z
  .object({
    kind: z.enum(['csv', 'pdf', 'png', 'jpeg', 'text', 'publicUrl']),
    name: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[^/\\\p{Cc}]+$/u),
    sha256: checksum,
  })
  .strict();

export type StagedSource = z.infer<typeof stagedSourceSchema>;
export type ArtifactFormat = (typeof artifactFormats)[number];

const slackAttachments = z
  .array(slackAttachmentSchema)
  .max(MAX_SLACK_ATTACHMENT_METADATA);
const slackThreadContextSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            messageTs: slackTimestamp,
            senderId: slackContextSender,
            text: z
              .string()
              .refine(
                (text) => Buffer.byteLength(text) <= MAX_THREAD_MESSAGE_BYTES,
              ),
            attachments: slackAttachments.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_THREAD_CONTEXT_MESSAGES),
    truncated: z.boolean(),
  })
  .strict()
  .refine(
    (context) =>
      Buffer.byteLength(JSON.stringify(context)) <= MAX_THREAD_CONTEXT_BYTES,
  );

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
        attachments: slackAttachments.optional(),
        threadContext: slackThreadContextSchema.optional(),
        sources: z
          .array(stagedSourceSchema)
          .min(1)
          .max(MAX_SLACK_INPUT_FILES + 1)
          .refine((sources) => {
            const urls = sources.filter(
              ({ kind }) => kind === 'publicUrl',
            ).length;
            return urls <= 1 && sources.length - urls <= MAX_SLACK_INPUT_FILES;
          })
          .optional(),
      })
      .strict(),
    session: workerSessionSchema.optional(),
    csvOutput: z.literal(true).optional(),
    artifactOutput: z.literal(true).optional(),
    deadline: z.number().int().positive(),
    callbackUrl: z.url().startsWith('https://'),
    callbackToken: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
  .refine(({ csvOutput, artifactOutput }) => !(csvOutput && artifactOutput))
  .refine(({ input, session }) => {
    const messages = input.threadContext?.messages;
    return (
      !messages ||
      (!session &&
        messages.every(
          ({ messageTs }, index) =>
            messageTs >= input.threadTs &&
            messageTs < input.messageTs &&
            (index === 0 || messageTs > messages[index - 1]!.messageTs),
        ))
    );
  });

export type WorkerJob = z.infer<typeof workerJobSchema>;

export const workerResultSchema = z
  .object({
    version: z.literal(1),
    runId: z.uuid(),
    generation: z.number().int().positive(),
    eventId: z.uuid(),
    sequence: z.union([z.literal(1), z.literal(2)]),
    type: z.enum(['completed', 'failed']),
    inputError: z
      .enum(['pdf_unreadable', 'pdf_text_too_large', 'too_many_sources'])
      .optional(),
    artifact: z
      .object({ sha256: checksum, format: z.enum(artifactFormats).optional() })
      .strict()
      .optional(),
    session: workerSessionSchema.optional(),
    text: z.string().min(1).max(4_000),
  })
  .strict();

export type WorkerResult = z.infer<typeof workerResultSchema>;

// A single content-free signal: the worker has started a real Pi turn.
export const workerProgressSchema = z
  .object({
    version: z.literal(1),
    runId: z.uuid(),
    generation: z.number().int().positive(),
    eventId: z.uuid(),
    sequence: z.literal(1),
    type: z.literal('working'),
  })
  .strict();

export type WorkerProgress = z.infer<typeof workerProgressSchema>;

export const workerCallbackSchema = z.union([
  workerResultSchema,
  workerProgressSchema,
]);

export const CANNED_REPLY =
  'Gateway round trip complete. The agent runtime is not connected yet.';

export const WORKER_FAILURE_REPLY =
  'The agent could not finish this run. You can retry by mentioning it again.';
