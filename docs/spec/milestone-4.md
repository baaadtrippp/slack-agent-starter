# Milestone 4: clarification without a waiting process

When Pi cannot safely continue because one fact is missing, its clarification
question is posted as the completed result of that turn. The worker saves the
native session, exits, and releases the thread. An ordinary later reply resumes
the exact saved conversation, including after Sandbox replacement. A different
thread can continue while the first conversation waits for a person. This
advances F08 and AC05.

## Tracer bullet

1. Give Pi a synthetic request that is deliberately missing one required fact
   and directs it not to infer the answer. Pi must return one concise question.
2. Publish that question through the existing completed-result path. Persist the
   exact session reference, stop Pi, and release ownership as for any other
   successful turn. Do not keep a process or lease open while waiting for a
   person.
3. Complete a turn in an independent Slack thread. Then replace the Sandbox and
   send an ordinary answer in the original thread. Reopen the exact saved native
   session and verify that the resumed response uses the supplied fact.

Use text-only synthetic prompts, the selected model, and the existing bounded
test setup. New Slack controls, an application-level waiting state, permission
dialogs, and inference from question-mark punctuation are outside this slice.

## Adapter decision

The published [acpx 0.21.1 package](https://www.npmjs.com/package/acpx/v/0.21.1)
defines text, status, and tool-call events and a generic terminal result in
`dist/runtime.d.ts`. The published
[pi-acp 0.0.34 package](https://www.npmjs.com/package/pi-acp/v/0.0.34) sends
model output as agent-message text and ends the turn generically in
`dist/index.js`. Its interactive request path is for tool or extension
permission, not for a model clarification question.

There is therefore no reliable structured clarification signal in the pinned
path. Per the v1 fallback, Hydra publishes the question as normal final text.
The worker result remains `completed`; no question classifier, punctuation
heuristic, new callback type, or new Slack control is added.

## Live Slack evidence

A synthetic request intentionally omitted a unit price. Pi posted one concise
clarification question as ordinary final text, the callback correlated to the
native transcript and OpenRouter record, and the Pi process exited. A separate
Slack thread then completed with a distinct native session while the first
conversation waited for a person.

The operator stopped the first Sandbox. A fresh Sandbox mounted the same Drive,
and an ordinary reply supplied the missing unit price in the original Slack
thread. The worker reopened the exact saved native and adapter session, added
one user turn, and returned the expected calculated total of 21. The second
callback also correlated to the native transcript and provider record. The
resumed process exited after publication. No process waited for the human reply.

The operator temporarily enabled public-channel reply events and a test gateway
deployment, then restored both the prior Slack settings and deployment. The test
used only synthetic values. Raw transcripts, credentials, Slack links, provider
metadata, and native identifiers remain outside the public repository.

## Evidence boundary

This is **live Slack** evidence for F08 and AC05 using the existing gateway and
worker implementation and its existing thread-resume test configuration.
Interactive permission requests, punctuation-based question detection, and
automatic Sandbox replacement remain outside this result.
