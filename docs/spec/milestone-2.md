# Milestone 2: first Pi answer

An internal member mentions the app in the existing test channel and receives a
model-generated reply in the originating thread. This slice advances F01 and F12
and adds evidence toward AC01, AC09, AC10, and AC11. O06 must be settled before
a paid compatibility run. Use bounded test settings for this slice while O05
remains open.

## Sequence and acceptance

1. Verify the pinned ACP path. Start two named sessions with a custom system
   prompt and selected tools, reopen the first after its process exits, and
   check that each session retains only its own history. With the approved
   OpenRouter model, verify a text reply, a tool read of a synthetic file, and
   image input through the adapter. Verify cancellation of one probe turn
   without ending the other session before relying on ACP cancellation.
2. Dispatch one admitted mention to a detached worker in Vercel Sandbox, using
   one writable Drive at a stable path for native sessions and work files. Keep
   provider credentials and Pi authentication files off the Drive. In provider
   integration, verify that a replacement sandbox can reopen the exact native
   session. Flush the session and result before the authenticated callback.
   Verify that provider failure reaches the gateway as a failed run.
3. In live Slack, verify one authorized mention produces one same-thread Pi
   answer after the original gateway request ends.

This slice keeps the existing Slack access policy and gateway/worker boundary.
Slack attachment staging, public URLs, ordinary thread follow-ups, user-facing
controls, shared memory, and production limits belong to later slices. File and
image input in step 1 are compatibility probes with synthetic inputs.

## First Slack run

For this bounded test, the operator prepares one named Sandbox with the Drive
mounted read/write. The gateway dispatches by name and does not start or resume
the runtime. The Sandbox firewall injects the dedicated model credential for
OpenRouter requests. The worker runs a text-only turn with tools disabled and
writes native state and a result manifest before callback. The gateway uses a
generic failure reply and records a failed worker result distinctly. The
existing fake-worker route remains available for Milestone 1 configuration.

Runtime creation, coordinated idle shutdown, tool-enabled Slack turns and thread
continuation require later slices. The operator stops the Sandbox after the test
and restores the prior gateway deployment.

## Local compatibility evidence

**Deterministic, no paid inference.** On Node 26.13.0, acpx 0.21.1 launched
pi-acp 0.0.34 and Pi 1.5.0 using a configured agent pointing to the installed
adapter. The adapter's `PI_ACP_PI_COMMAND` pointed to a launcher that added Pi's
`--provider`, `--model`, `--system-prompt`, and `--tools read` flags and
forwarded the adapter's arguments. With isolated state and a synthetic
credential, named `sessions new` and `prompt -s` calls created two separate
native files. After the first runner went idle with no owner PID, a later prompt
used `session/load` and appended to its original file. Native records showed the
intended model, system prompt, read-only tool selection, and separate histories.

The test turns recorded an authentication error and zero usage. acpx returned
success with `end_turn` and no answer. A worker must verify the turn outcome
before sending a successful callback. Treat this as a required negative case for
the adapter path.

The pinned acpx CLI reads prompt text from its arguments or a file. For the
image probe, the installed `acpx/runtime` API exposes image attachments as ACP
image blocks, and pi-acp maps those blocks into Pi RPC image input. This is
source inspection. Verify actual image handling with the selected model before
relying on it.

## Concurrent cancellation evidence

**Deterministic, WSL.** Two separate Pi sessions streamed responses from a local
fixture through `acpx/runtime` and pi-acp. After both emitted output, cancelling
A closed only A's HTTP stream and returned ACP `cancelled`. B was still active
when cancellation was confirmed, then returned its expected final text with
`end_turn`. A's existing session accepted a fresh turn and completed. The
fixture controlled when B's response finished to make the overlap repeatable.
This checks cooperative cancellation through real Pi processes.

## OpenRouter compatibility evidence

**Provider integration.** The pinned packages used
`google/gemini-3.1-flash-lite` with a dedicated OpenRouter key capped at US$1
without a reset. The CLI path returned the expected text and read a staged
synthetic file with Pi's `read` tool, verified in the native session record. A
separate turn through `acpx/runtime` attached a generated PNG as an ACP image
block. Pi returned the correct dominant color and the turn completed.

Cancellation against OpenRouter remains to be verified.

## Sandbox and Drive recovery evidence

**Provider integration, synthetic model response.** Two distinct nonpersistent
Vercel Sandboxes ran the pinned acpx, pi-acp, and Pi packages in sequence. The
first mounted the Drive read/write, wrote a workspace fixture, saved a native Pi
turn, and stopped. The second mounted the same Drive at the same path and
reopened the saved session. The probe verified the native file path and session
ID, the prior user prompt and assistant reply in the next model request, and the
workspace file. The Drive was detached after the second Sandbox stopped. The
model endpoint was a loopback fixture.

## Live Slack evidence

A single synthetic mention in the configured test channel produced one
model-generated reply in its originating thread in about six seconds. The
gateway publication record matched the Slack reply. The Drive manifest recorded
completion, and the native Pi file identified the configured OpenRouter model, a
successful stop reason, and nonzero input and output usage. The worker process
exited after the callback.

The first attempt verified the failure path. Pi could not establish TLS with the
Sandbox firewall because its child environment excluded the firewall CA setting.
The gateway published one generic failure in the same thread. Passing only
`NODE_EXTRA_CA_CERTS` to the adapter fixed the connection, and the successful
test used a fresh mention. The real key remained in the Sandbox firewall.
