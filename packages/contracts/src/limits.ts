// Content limits shared by the gateway and the worker. The gateway enforces
// them and sends `limits` with every job; the worker enforces the values it
// receives.
export const limits = {
  inputFileBytes: 16 * 1024,
  publicLinkBytes: 16 * 1024,
  generatedFileBytes: 16 * 1024,
  pdfTextBytes: 16 * 1024,
  messageChars: 12_000,
  // A longer answer is cut.
  answerChars: 4_000,
  // Slack files per message; one public link can come with them.
  filesPerMessage: 5,
  // Slack file descriptions per message that the agent sees as metadata.
  attachmentMetadataPerMessage: 5,
  // Files and links a thread keeps for later turns.
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
