# F13 shared channel notes

An internal member of the enabled Slack channel can save a short note and
another member can ask Pi to use that note in a new thread in the same channel.
This traces F13 and AC04, with AC02 replacement and AC10 failure coverage. O03
permits explicit writes and use in that channel. O04 retention and O05
production limits remain open.

## Smallest path

- Use `@bot remember for this channel: <note>` to save and
  `@bot use shared notes: <question>` to read with Pi. The same prefixes work
  without a mention on ordinary replies in activated threads. Recognize them
  only at the start of the current human input after the bot mention. Save at
  most 512 UTF-8 bytes per note and 16 notes per channel in this slice.
- Keep the workspace, channel, member, busy, and duplicate checks at the
  gateway. A save sends only the explicit note to the worker and does not invoke
  Pi or change a native session. A read opens only the notes for the admitted
  workspace and channel and supplies their text as untrusted data.
- Keep one Markdown file per workspace and channel on the existing Drive,
  separate from conversations. Serialize read-modify-write within the single
  writable Sandbox. Sync a staged file and atomically replace the previous
  version before acknowledging success. Report uncertain outcomes so members can
  check before resending.
- Defer automatic extraction, search, other channel audiences, deletion, and
  automatic retention.

## Rollout and integrated Slack check

Use matching gateway and worker revisions on the managed Sandbox path. The
gateway uses the same Slack channel and membership lookups as Stop and Status.
The worker needs `flock` and the shared-notes module in its startup seed.

1. As an ordinary internal member of the enabled channel, send
   `@bot remember for this channel: The synthetic badge is violet.` Wait for one
   saved reply. The starting status reports admission and the saved reply
   reports persistence. A save-only mention leaves the native session unchanged.
2. As another internal member, start a fresh thread in that channel and send
   `@bot use shared notes: What color is the synthetic badge?` Verify the answer
   says violet. The writer's thread can include an unrelated synthetic detail to
   check that Pi receives the note alone.
3. Send an ordinary request phrased as a memory suggestion without the command
   prefix. Use a new thread to ask for that detail and verify it was never added
   to the shared notes.

## Acceptance checks

- Deterministic gateway and worker tests check that a nonoperator can save, a
  later same-channel thread can use the note, and external users and disabled
  channels cannot save or read. History, attachments, URL content, ordinary
  prose, busy input, and duplicate deliveries cannot write notes.
- Two simultaneous saves retain both notes. Failed or interrupted writes
  preserve the earlier notes. A restarted worker reads the same notes after
  cleanup of a synthetic conversation workspace. A controlled Pi turn receives
  the note text without the other thread's private state.
- A disposable provider probe checks lock contention and same-mount atomic
  replacement on the actual Drive, then reads after a clean Sandbox replacement.
  The integrated live Slack pass checks the save acknowledgement and
  cross-thread use by two internal members.

## Deterministic evidence

Signed event tests with local Redis and mocked Slack check explicit saves, scope
and membership, the busy and duplicate gates, and one reply after the worker
reports persistence. An activated reply saves only its explicit text while
carrying the existing session reference. Worker storage tests use separate Linux
processes to verify concurrent updates, duplicate suppression, pre-commit
interruption, slice capacity, and independence from conversation cleanup.

## Provider evidence

A disposable Vercel Drive mounted read/write at `/workspace` held both updates
from concurrent supervised workers. The worker reported success only after the
notes were readable from the Drive. A repeated message added no second entry. An
interruption before replacement preserved the earlier notes. The pinned Pi/ACP
stack with a controlled model used both notes in a distinct native session. The
model received neither the writer's earlier prompt nor any additional tool
access. Saves made no model requests and left the writer's existing session
byte-for-byte unchanged.

After the writer's synthetic conversation workspace was deleted and the first
Sandbox released the Drive, a fresh Sandbox mounted the same Drive read/write
and read both notes. The provider confirmed the writable attachment in each
session. Both temporary Sandboxes and the Drive were removed and verified
absent. Live Slack delivery and the actual membership lookups remain for the
integrated pass.
