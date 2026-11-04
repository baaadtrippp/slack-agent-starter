# Milestone 5: recover an interrupted first turn

A new interaction in a blocked thread can clear an expired first turn after
Vercel confirms that the exact Sandbox session which owned it has stopped. Hydra
reports that the previous outcome is uncertain and asks for a fresh mention.
This adds partial evidence for F10 and AC08–AC10. O02 remains open.

## Tracer bullet

1. Before launching the detached worker, record the Sandbox name and immutable
   session ID against the Redis run owner. Send the command to that exact
   session. Never let a dispatch transparently resume a Sandbox.
2. Return HTTP 200 for the Slack event before checking the provider. If the
   owner is an expired first turn with no claimed result, look for its exact
   stopped session before composing the thread reply. An unavailable or
   inconclusive lookup leaves the thread locked.
3. Compare the owner, state, deadline, and target again in Redis, then
   atomically mark the run interrupted and release the thread. A retry can
   confirm the interruption after a lost Redis reply. If a newer run already
   owns the thread, retain that owner and give the busy reply. Keep event
   deduplication and any files the worker wrote. Do not dispatch the busy event
   or replay the original input. A fresh mention can start new work.
4. Use real local Redis with synthetic Slack and provider fixtures to verify
   admission, interruption, deduplication, and rejection of late callbacks.
   Separately probe cancellation isolation and exact session status in a
   disposable Vercel Sandbox.

This slice excludes resumed turns with potentially newer native transcripts,
uncertain Slack publication, unbound historical runs, automated lifecycle
management, result manifest recovery, and Stop or Status controls.

Keep the named Sandbox and its session history until affected threads have been
reconciled. If the Sandbox has been deleted or the exact session record is
missing, Hydra keeps ownership in place for operator inspection.

## Deterministic evidence

With disposable Redis, signed synthetic Slack requests, and mocked Slack and
Vercel responses, the gateway acknowledged the busy event before checking the
provider. A positive stop result for the bound target moved the old run to
`interrupted`, left both events deduplicated, and posted the retry instruction
in the same thread. A fresh mention was admitted without the old session
reference. The old authenticated callback returned HTTP 410 without changing the
new run or posting a reply.

The Redis tests also covered concurrent target binding and refusal to clear
ownership for an unexpired, unbound, resumed, or changed run. The gateway kept
the thread locked if the provider reported it was still running or the lookup
failed.

## Provider integration evidence

A disposable, nonpersistent Vercel Sandbox ran the pinned ACP and Pi versions
against a local model endpoint that returned deterministic streaming responses.
Two independent Pi sessions streamed concurrently. Cancelling session A
disconnected its stream while session B was still active. B finished, then A
accepted and completed a fresh turn. The operator stopped the VM after both runs
finished. Vercel's named Sandbox, direct session, and session listing reads
confirmed that the exact recorded VM session had stopped.

An authenticated Vercel API connection managed the VM. The model fixture
supplied every response locally. The gateway recovery flow was exercised
separately with disposable Redis and mocked Slack and provider responses.

## Live Slack recovery evidence

In the approved test channel, a synthetic mention started a fixture that
withheld its result. The operator stopped the worker and verified that Vercel
reported the exact recorded VM session as stopped. After the run deadline, a
second mention in that thread produced one recovery reply asking for a fresh
mention. The fixture recorded no launch for the recovery message.

The operator started a replacement VM session under the same Sandbox name. A
fresh mention in the original Slack thread launched one worker command, received
an accepted callback, and produced one expected fixture reply in that thread.
The original run and the recovery message were not replayed. This test used a
synthetic worker result. The Pi process check with the local model fixture is
recorded separately above. Rejection of late callbacks is covered by the
deterministic gateway and Redis tests.

For about two minutes the existing Vercel alias served the staged recovery
gateway. Slack kept its existing Request URL and app settings. The traffic check
was limited to the three synthetic mentions in the approved test channel. After
the fresh reply, the operator rolled back the alias and verified that it
resolved to the original deployment ID. Both test sessions were stopped and the
test Sandbox and snapshots were removed.
