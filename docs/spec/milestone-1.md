# Milestone 1: signed mention to canned reply

## User outcome

An internal member mentions the app in the configured public test channel and
receives one canned reply in the same Slack thread. This is gateway scaffolding,
not an agent answer.

## Scope and decisions

This slice starts F01 and provides partial evidence for AC01, AC08, AC09, AC11,
and AC13. It does not complete any criterion requiring real Pi execution.

O01 is settled for this slice: any internal member of the selected public test
channel may invoke the app. Reject externally shared channels, external users,
bots, other workspaces, and other channels. DMs and private-channel activation
remain disabled. O07 identity and test channel are selected in private
deployment configuration. Other open decisions remain open.

Phase 0 was reviewed before application implementation. The pinned local
formatting, Markdown, repository-boundary, and secret checks passed;
current-main CI passed. Provider provisioning is not runtime connectivity
evidence.

## Non-goals

No model, Pi, ACP adapter, Sandbox host, Drive integration, thread continuation,
channel-history fetch, attachments, URLs, reactions, controls, shared memory, or
automatic cleanup. Request only mention and reply scopes. No general worker
service or queue is introduced.

## Smallest implementation

1. A Vercel Function verifies the raw Slack signature and timestamp, validates
   the workspace and channel policy, and atomically persists a run, logical
   message identity, delivery identity, and thread ownership before returning an
   acknowledgement. Redis failure returns a retryable error.
2. Chat SDK and its official Slack and Redis adapters own normalized messaging
   and presentation. After acknowledgement, dispatch the versioned job to a
   separate fake-worker function implemented in the worker package and deployed
   to a temporary project without gateway credentials. This is test scaffolding
   replaced by Sandbox dispatch in milestone 2. The job contains only its input,
   correlation fields, deadline, callback address, and a run-scoped credential;
   no reusable gateway secrets.
3. The fake worker sends a canned result to the gateway callback. The callback
   validates the credential, run, generation, expiry, and transition before
   publishing through the Slack adapter. Repeated callbacks cannot intentionally
   repost a result. Uncertain publication is retained for inspection, not
   automatically retried.
4. Keep application coordination in its own Redis namespace. Retain run and
   deduplication records until an explicit retention decision; no expiry
   silently reruns an old message. Temporary locks may expire without clearing a
   run.

## Acceptance checks selected before implementation

- **Deterministic:** signed challenge and event handling; bad, stale, and future
  signatures; internal allowed mention; wrong workspace/channel and external/bot
  input; root and existing-thread routing; event and logical-message duplicates;
  concurrent admission; Redis failure before acknowledgement; forged, expired,
  wrong-run, stale-generation, and duplicate callbacks; uncertain publication;
  independent fake-worker HTTP contract with no model dependencies.
- **Provider integration:** runtime Redis write/read/delete through the actual
  adapter connection, labelled separately from in-memory tests.
- **Live Slack:** URL verification and one authorized mention in the selected
  channel, with a same-thread canned answer and retry evidence. A live canned
  reply does not demonstrate Pi, model tools, or independent Sandbox execution.

Run strict TypeScript, a TypeScript linter, Vitest, repository checks, and
secret scanning. Review the bounded implementation before deployment. Publish no
real messages, identities, credentials, or operator progress records in
fixtures.
