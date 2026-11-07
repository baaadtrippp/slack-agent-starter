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
  removals on the final answer, with duplicate and older deliveries.
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

Record the disposable Sandbox test separately from any paid model or Slack
delivery. The isolation check uses two actual worker processes and a controlled
model fixture.

## Live Slack acceptance

Validate and apply the complete public-channel manifest during the integrated
acceptance window. Verify that a requester can stop one run, another eligible
member can refresh Status, and thumbs additions and removals update only final
answers. Include the F08 clarification and ordinary reply in that window.
