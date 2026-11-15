// Content limits shared by the gateway and the worker. Each limit is enforced
// where its input is handled. The gateway sends `limits` with every job, and
// the worker enforces the values it receives.
export const limits = {
  inputFileBytes: 16 * 1024,
  publicLinkBytes: 16 * 1024,
  generatedFileBytes: 256 * 1024,
  pdfTextBytes: 16 * 1024,
  messageChars: 12_000,
  // A longer answer is cut. The result must fit the fixed 32 KiB callback,
  // Status proof, and worker control bodies.
  answerChars: 4_000,
  // Slack files per message; one public link can come with them.
  filesPerMessage: 5,
  // Slack file descriptions per message that the agent sees as metadata.
  attachmentMetadataPerMessage: 5,
  // Files and links a thread keeps for later turns. Their catalog must fit the
  // worker's 16 KiB catalogByteLimit in run.mjs.
  sourcesPerThread: 12,
  threadContextMessages: 20,
  threadMessageBytes: 2 * 1024,
  threadContextBytes: 16 * 1024,
  sharedNoteBytes: 512,
  sharedNotesPerChannel: 16,
  // Must hold sharedNotesPerChannel notes of sharedNoteBytes each.
  sharedNotesFileBytes: 20 * 1024,
};

// A run's deadline is its admission time plus this duration.
export const RUN_DURATION_MS = 60_000;

// Limit text for replies: whole KiB when exact, otherwise bytes.
export const formatBytes = (bytes: number) =>
  bytes % 1024
    ? `${bytes.toLocaleString('en-US')} bytes`
    : `${(bytes / 1024).toLocaleString('en-US')} KiB`;
