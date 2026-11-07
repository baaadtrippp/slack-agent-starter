# F09 and F11 tracer

- **Outcome.** A requester or configured internal operator can stop their
  targeted active run from its status message. Internal members of the enabled
  channel can refresh the same message. Thumbs-up and thumbs-down on a final
  answer update private gateway state per answer, reactor, and reaction.
- **Scope.** F09, F10, F11, AC03, AC07, AC08, AC09, and AC10. O02 approves both
  controls and feedback. Keep the existing public-channel and internal-user
  access checks, native-session mapping, and file exchange.
- **Out of scope.** Shared memory, broader Slack access, provider changes,
  automatic retries, retention policy, rollout, and an inferred Waiting state.
  F08's existing clarification fallback is covered by the integrated pass.
- **Path.** Authenticate Slack deliveries, bind a control to the stored status
  message, run, and generation, and acknowledge before background work. Give
  Stop and terminal publication one atomic decision point. Once Stop wins, show
  Stopping and suppress the result. Confirm that the run has exited before
  releasing ownership. Status uses the same reconciliation and status edit path.
  Record timestamp-ordered thumbs changes only against a confirmed final answer,
  with no worker dispatch.
- **Evidence.** Exercise signed deliveries, access checks, duplicates, stale
  controls, Stop/publication races, late callbacks, saved-result recovery, and
  thumbs adds/removes deterministically. Exercise two active runs through the
  worker entry point with a controlled model and verify that one stops while the
  other completes. Track provider and live Slack evidence separately. Live Stop,
  Status, thumbs, and the F08 regression belong to integrated acceptance with
  matching gateway and worker builds.

## Deterministic evidence

- Signed gateway tests use local Redis with Slack and Sandbox mocked. They
  exercise requester and operator permissions, stale and forged clicks, one
  editable status, Stop racing publication, late callbacks, and Status recovery
  without dispatching a new turn. They also cover both thumbs directions and
  removals on the final answer, with duplicate and older deliveries. If a
  reaction arrives during final publication, a short-lived pending entry becomes
  feedback only when that exact message is indexed as the final answer.
- Redis tests cover exact ownership, the native session checkpoint, answer
  indexing and historical backfill. Runtime tests reject wrong Sandbox sessions
  and incomplete exit evidence. Replacement inspection uses the same managed
  Drive and cannot send a cancellation command to the replacement.

If a resumed turn fully saves a completed checkpoint before exiting after Stop
wins, the gateway keeps that verified revision of the same native session and
suppresses its Slack answer. If a stop leaves the session's safety unconfirmed,
the gateway keeps ownership and displays `Stopping`. The forced process-group
fallback is still an acceptance gap.

## Provider evidence

A disposable Vercel Sandbox ran the pinned acpx, pi-acp, and Pi versions
`0.21.1`, `0.0.34`, and `1.5.0` with one writable Drive. A loopback model
fixture supplied responses while Sandbox egress was denied.

- Two real Pi runs reported progress concurrently. Cooperative Stop ended only
  the target. Its marked processes exited and it produced no terminal callback
  or result. The peer remained active and completed once.
- A second check stopped a resumed turn while its peer was active. The stopped
  turn's prior native revision and file hash matched exactly, and the peer
  completed. A fresh provider read confirmed that the Sandbox stayed running and
  the writable Drive stayed attached.
- The disposable Sandbox and Drive were removed and verified absent after the
  check. The existing Slack route remained active. Live Slack and paid model
  evidence are separate from this provider check.

The packaged worker files had these SHA-256 digests.

| File            | SHA-256                                                            |
| --------------- | ------------------------------------------------------------------ |
| `run.mjs`       | `2862598e95ab5a24f7541794554f721d9305593bdaeae92947c223d872372bb7` |
| `supervise.mjs` | `c6c105371047a9b920479c391509338035393e0d0970730014d62467d6fe783e` |
| `control.mjs`   | `645f6103c3de3eb6cf37b15d640f8f2e42093952c4b4a972622dd343ebdb4c4c` |

## Live Slack acceptance

1. Stage matching gateway and worker builds and preserve the current route and
   rollback builds. Validate and apply the complete public-channel manifest to
   the existing app in the enabled internal channel.
2. Start work in two threads. Have the requester stop one run and another
   internal member refresh its existing status message. Verify that ownership
   persists through `Stopping`, the target produces no late answer, and the
   other run finishes on the shared Sandbox.
3. Add and remove both thumbs on the other run's final answer. Check ordered
   feedback in gateway state and confirm that it starts no worker. Verify that
   the input and status messages have no feedback.
4. Exercise the F08 fallback with a file-bearing clarification and an ordinary
   reply that resumes the exact native session. Verify the final same-thread
   answer and artifact in the integrated candidate.
