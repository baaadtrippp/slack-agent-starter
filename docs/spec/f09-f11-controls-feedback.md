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

## Forced Stop follow-up

- **Outcome.** A run that cannot stop cooperatively can still reach Stopped. Its
  peer continues, and a resumed thread keeps its last committed native
  checkpoint if the stopped turn left an incomplete transcript.
- **Scope.** F09, AC03, AC07, and AC10. This follows the accepted O02 controls.
  Slack routing, shared storage policy, and live acceptance stay outside this
  worker follow-up.
- **Path.** Preserve the exact verified checkpoint before a resumed turn can
  write. After a bounded cooperative attempt, use the supervisor's recorded
  child identity to target only its isolated process group. Prove exit before
  restoring the checkpoint or releasing ownership. Escalation requires the
  original supervised group leader. If process identity, exit, or checkpoint
  integrity cannot be verified, retain ownership.
- **Checks.** Verify group membership, forced exit, exact restoration, and
  duplicate Stop with deterministic fixtures. Exercise the real process verifier
  and a still-running peer in a disposable Sandbox using the packaged worker.
  Require a full CodeRabbit review of the tested PR revision before merge.

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
the gateway keeps ownership and displays `Stopping`.

Forced-stop regressions verify exact marker and group membership, refuse mixed
and escaped groups, and reject incomplete gateway proofs. Synthetic worker
fixtures exercise the force and checkpoint-restore paths with the group
membership check supplied separately. The provider check below runs the actual
process verifier.

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
| `run.mjs`       | `4ac39ecfc548d58500761dc0114a97adaaa1b9aa752343e7a9169cd5423ae956` |
| `supervise.mjs` | `f5de343d7f2941981fe10c9bac43f7f079eda2aa3ac17318450e54e95025a5d5` |
| `control.mjs`   | `7ee89c20b95d8164b135c17b9171b5b1a12d8ab93e65057dd3c9ae9e5e8ca4f6` |

### Forced Stop in a disposable Sandbox

The packaged worker used the same pinned Pi runtime and loopback fixture. A test
wrapper held each target active through cooperative Stop. The supervisor then
terminated the target's recorded isolated process group. In both initial and
resumed cases, the exact group and its marked processes were gone, the target
produced no terminal callback or result, and the peer remained active and
completed.

For the resumed target, the transcript differed from the committed checkpoint
before Stop. After exit, the transcript matched the prior revision and SHA-256
exactly. The seed result and adapter routing fields matched. The leased adapter
entry's ordinary `updatedAt` timestamp advanced. The Sandbox remained running
with its writable Drive attached. Both disposable resources were removed and
verified absent after testing.

| File            | SHA-256                                                            |
| --------------- | ------------------------------------------------------------------ |
| `run.mjs`       | `6937d0ccf99676ac25a710c22d2e235f013305e99b75083eea46bd8e96261d92` |
| `supervise.mjs` | `e9739ae3c3fc75317b6570efa0a10b0920a65a4952a509a7f8ec5343f8435471` |
| `control.mjs`   | `ab4becc52b6d155ce9d59007a2f47d6f3f6bff919efdeb03f02b567c5fea1960` |

## Live Slack acceptance

1. Stage matching gateway and worker builds and preserve the current route and
   rollback builds. Validate and apply the complete public-channel manifest to
   the existing app in the enabled internal channel.
2. Start work in two threads. Have the requester click Status on the target's
   existing status message, then click Stop. Verify that ownership persists
   through `Stopping`, the target produces no late answer, and the other run
   finishes on the shared Sandbox. Signed gateway tests cover the Status
   permission for a different internal member.
3. Add and remove both thumbs on the other run's final answer. Check ordered
   feedback in gateway state and confirm that it starts no worker. Verify that
   the input and status messages have no feedback.
4. Exercise the F08 fallback with a file-bearing clarification and an ordinary
   reply that resumes the exact native session. Verify the final same-thread
   answer and artifact in the integrated candidate.
