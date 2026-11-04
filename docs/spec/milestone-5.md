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
   atomically mark the run interrupted and release the thread. Keep event
   deduplication and any files the worker wrote. Do not dispatch the busy event
   or replay the original input. A fresh mention can start new work.
4. Use real local Redis with synthetic Slack and provider fixtures to verify
   admission, interruption, deduplication, and rejection of late callbacks.
   Separately probe cancellation isolation and exact session status in a
   disposable Vercel Sandbox.

This slice excludes resumed turns with potentially newer native transcripts,
uncertain Slack publication, unbound historical runs, automated lifecycle
management, result manifest recovery, and Stop or Status controls.

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
with a deterministic local streaming fixture. Two independent Pi sessions
streamed concurrently. Cancelling session A disconnected its stream while
session B was still active. B finished, then A accepted and completed a fresh
turn. The operator stopped the VM after both runs finished. Vercel's named
Sandbox, direct session, and session listing reads confirmed that the exact
recorded VM session had stopped.

The provider probe used an authenticated Vercel API connection and no Drive,
Slack, or model credential. The gateway recovery flow was exercised separately
with disposable Redis and mocked Slack and provider responses.
