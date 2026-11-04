# Milestone 3: resume a Slack thread

After one successful mention, an ordinary human reply in that thread continues
the exact saved Pi conversation, including after the Sandbox is replaced. A new
Slack thread starts independently. This advances F02, F03 and AC02, and adds
evidence toward AC08, AC09, AC10 and AC11.

## Tracer bullet

1. Keep the selected internal public channel policy from O01 and O07. Add only
   public channel message events and their read scope. Slack can deliver those
   events from public channels the app has joined. The gateway filters to the
   one enabled test channel. Internal participants in that channel can continue
   the same thread. Ignore root messages, bots, edits and replies in unactivated
   threads. Deduplicate mention/message overlap before dispatch.
2. Store an exact reference to the saved session when the first real worker
   result is published. Resolve the reference and acquire the existing thread
   owner atomically in Redis. An uncertain publication retains the owner so a
   reply gets the existing busy response. Ignore replies older than the first
   publication, including delayed retries. Pass the new turn only. A missing
   session fails visibly instead of creating a replacement conversation.
3. Stop the first Sandbox, mount the same Drive at the same path in a fresh
   Sandbox, and reopen the exact native session. Verify the persisted native ID
   before submitting the new turn. Keep auth and process state off the Drive.
   The existing gateway/worker boundary and authenticated callback remain in
   place.

Use text-only prompts, the selected model and the existing bounded test setup.
Clarification signals, broader channel access, automatic Sandbox replacement,
attachments, history fetch, controls and retention are outside this slice.

## Evidence to collect

- **Deterministic:** signed ordinary reply routing, inactive and busy threads,
  duplicate event forms, rejected bot/external input, exact reference and
  missing-session failure.
- **Provider integration:** seed, stop and replace the Sandbox, then resume the
  exact saved session from the Drive. Record the native ID and verify that the
  second turn receives only the new prompt and uses the saved history.
- **Live Slack:** one synthetic fact on activation, one ordinary thread reply
  after replacement, and the expected same-thread answer. A separate thread must
  have a different native session.

## Deterministic and local worker evidence

The Redis-backed gateway tests exercise inactive and busy replies, delayed
pre-activation delivery, logical deduplication across the two Slack event forms,
activation only after publication, and exact session identity and revision
validation. The application Redis record controls whether a thread is active.

A separate WSL probe used the pinned real worker and OpenRouter. A fresh process
reopened the exact saved session, recalled a synthetic code, and advanced the
recorded revision. A stale revision failed without starting Pi or changing the
transcript. The callback in this probe was a fixture.

A local streaming fixture also forced a provider error after a resumed turn
started. The worker restored the committed transcript after shutdown, and a
retry completed with the same native session ID. An unconfirmed exit still
retains ownership for inspection.

## Sandbox replacement evidence

Two fresh Vercel Sandboxes mounted the same Drive read/write in sequence. The
first used the real worker and OpenRouter to remember a synthetic code. The
second received only a question about that code and reopened the exact seed
session. Its answer matched, the native and adapter IDs stayed the same, and the
transcript revision advanced. The result manifest matched the callback payload.
Both Sandboxes stopped. The callback endpoint was a fixture, so the test
provides **provider integration** evidence.

## Live Slack evidence

An authorized synthetic mention received one acknowledgement from the first
Sandbox. After that worker exited and the Sandbox stopped, a second Sandbox
mounted the same Drive. An ordinary reply in the original Slack thread, without
a second mention or the synthetic code, received one answer containing the
correct code. The native Pi session ID and adapter ID matched the first run. The
transcript contained one new user turn and advanced to the new committed
revision. Both results correlated to the gateway publication records and
recorded OpenRouter usage.

The test temporarily enabled public-channel message events and used the existing
test-channel filter. The independent-thread and stale-revision checks remain
deterministic and local worker evidence.
