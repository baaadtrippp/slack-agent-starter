# F08 clarification

- **Outcome.** A file-bearing request can finish with a question before Pi opens
  the file. The next ordinary Slack reply can reopen the exact file in the same
  native session while independent threads can run between the two turns.
- **Scope.** F08 and AC05 on the PR #24 merge, with related AC02 and AC03 checks
  for checkpoint reuse and independent progress. Keep the current ordinary
  final-answer fallback, existing Stop and Status, first-turn history, and file
  exchange. O04 storage retention remains open.
- **Path.** Reuse normal terminal publication and exact-session resume. Verify
  that Pi exits, the result and source catalog are saved before the callback,
  and a later reply starts one new turn. Keep the existing error path for
  missing or unsafe checkpoints. Waiting labels, question detection, shared
  memory, and Slack routing changes are outside this slice.
- **Evidence gap.** Earlier live runs prove text clarification after Sandbox
  replacement and file reuse after a clarification. Verify the integrated worker
  with a controlled model that asks before calling a file tool. Assert process
  exit before the reply, peer completion during the gap, matching native and
  adapter IDs, advancing revisions, exact retained bytes, and no replay. Use the
  existing gateway tests for callback and input deduplication and ownership. Run
  the file-bearing replacement sequence against the actual Sandbox and Drive.

## Deterministic evidence on the PR #24 merge

The gateway and Redis tests verify one publication for a terminal result, atomic
checkpoint save and ownership release, and one dispatch for duplicate Slack
deliveries of the same reply. The next job carries the exact saved session
reference and current input. Slack and Sandbox calls use test doubles. The
worker tests cover missing native sessions and unsafe retained catalogs.

A local controlled-model probe ran the unmodified worker, supervisor, and
control code from `de5e5718ecae7f08bc2ab9a21901f8109a9c59f3` with acpx `0.21.1`,
pi-acp `0.0.34`, and Pi `1.5.0`. It used synthetic files and loopback model and
callback servers.

- Pi asked which period to select before any file-tool call. When the callback
  arrived, the saved result matched it, revision 6 contained the question, and
  the catalog identified the original 23-byte CSV by checksum. Pi and pi-acp had
  exited. The supervisor subsequently recorded committed state and exit of all
  run processes before the reply.
- A second thread completed with distinct native and adapter IDs while the first
  conversation awaited its answer. The reply then used the original IDs and
  transcript path, advanced to revision 13, and added exactly one native user
  message. Pi read the original CSV bytes and wrote the expected 18-byte CSV
  artifact. The worker job carried the new text without a new attachment or a
  replayed thread.
- A missing retained catalog, missing native transcript, and mismatched native
  revision each failed before a model call. The catalog failure preserved the
  previous transcript. The supervisor withheld a safe checkpoint confirmation
  for the missing transcript or mismatched revision. No replacement session was
  created, and the earlier input bytes were intact.

The probe ran actual Pi processes with a simulated model and local storage.
Earlier [text-only live evidence](milestone-4.md#live-slack-evidence) covers
exact resume after Sandbox replacement.
[File-bearing live evidence](f04-f06-file-exchange.md#live-slack-evidence)
covers same-session source reuse and a verified Slack artifact on an earlier
runtime.

## Provider replacement evidence

A controlled model drove the packaged worker from
`9401bbb02dd8da18d87d5a4197e1b4726e6b07bf` through the real Vercel Sandbox and
Drive. The first Pi turn asked which period to select before calling a file
tool, then saved the checkpoint and exited. The original Sandbox detached the
Drive. A fresh nonpersistent Sandbox mounted the same Drive at `/workspace`. A
temporary runtime marker from the first Sandbox was absent in the replacement.

The reply reused the same native and adapter IDs and transcript path, advanced
the revision, and added exactly one native user turn. It read the retained
23-byte CSV without another upload or history import and wrote the exact 18-byte
output `period,units\nQ2,7\n`. Both disposable Sandboxes and the Drive were
removed and verified absent.

This route-free check exercised the worker and Drive rather than Slack or a
gateway restart. The earlier live runs separately cover Slack clarification and
same-thread delivery.

The packaged worker from `8e620a92b2c24d2476136162fc99f83c3d4f4eae` repeated
this check with the managed launch restriction active. A fresh Sandbox resumed
the same native and adapter sessions, consumed one reply without replay, and
produced the same exact CSV from the retained input. The worker and supervisor
files were unchanged when this evidence was recorded.

## Integrated Slack regression

1. In the authorized acceptance window, stage matching gateway and worker builds
   in the enabled internal channel. Start with a synthetic human thread root. In
   that thread, mention the app with `metrics.csv` containing the following
   UTF-8 bytes with LF line endings and a final newline.

   ```csv
   period,units
   Q1,3
   Q2,7
   ```

   Ask it to select a period and return the matching row as a CSV, and to ask
   which period to use before opening the file. Verify one acknowledgement, one
   status ending in Completed, and one separate question in the original thread.
   Capture the exact seed, native and adapter IDs, revision, source checksum,
   and terminal result privately. Check that the native turn has no file-tool
   call, the worker has exited, and the thread lease is released.

2. Leave the question unanswered and complete a request in a second thread.
   Verify a distinct session and an answer in that thread. For the combined AC02
   check, then replace the Sandbox without restoring its filesystem snapshot,
   mount the same Drive at the same path, and restart the gateway against the
   same state before answering.

3. Reply in the original thread with `Use Q2. Return its row as a CSV.` Send an
   ordinary human reply with no mention or attachment. Verify one new run and
   one new native user turn, no second history import, the same native and
   adapter IDs, an advanced revision, and a scoped read of the original CSV.
   Verify one acknowledgement, one status ending in Completed, and one final
   answer and CSV in the same thread. Download the artifact and compare its
   exact bytes to `period,units\nQ2,7\n`. Verify the retained source against the
   recorded source checksum, and record the output artifact's checksum
   separately. Keep any duplicate-delivery claim tied to the deterministic tests
   unless a redelivery is observed in this window.
