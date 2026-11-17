# Developer instructions

The [specification](docs/spec/specification.md) defines how the product behaves.
Read the relevant section before changing behavior, and update it in the same
PR. Do not build anything it lists as deferred or still open without the owner's
agreement.

## Architecture boundaries

- The gateway (`apps/gateway`) and the worker (`apps/worker`) are separate
  packages and processes.
- The gateway owns Slack calls, access checks, presentation, Redis state, and
  coordination. It never runs the model loop.
- The worker never calls Slack and never holds Slack, Redis, or model keys. The
  Sandbox firewall injects the model key and tool API keys.
- One active Vercel Sandbox and one persistent Vercel Drive. Pi processes for
  different threads share them; each Slack thread maps to its exact Pi session
  and workspace.
- Pi runs through acpx and pi-acp. Verify that path before proposing another
  adapter.
- OpenRouter is the only model provider. No OpenAI API dependency,
  subscription-based runtime authentication, or automatic provider fallback.
- Inputs are Slack messages, Slack files, and explicitly supplied public URLs.
  Do not add account connectors, browser automation, schedules, a runtime MCP
  catalog, more databases or queues, or other compute vendors.
- A work directory or prompt is not a security boundary. All threads share one
  Drive, so the agent gets no shell or open file access.
- One writer owns each Pi session. Serialize shared-note writes.

## Implementation rules

- Write the minimum code the change needs. No speculative configuration,
  extension points, or abstractions for one use.
- Make surgical changes in the existing style. Do not refactor adjacent code.
- Remove what your change makes obsolete. When a change replaces a switch or
  mode, delete the old one in the same PR.
- A PR adds at most 400 lines, not counting `pnpm-lock.yaml`; deletions do not
  count. Measure with `git diff --numstat origin/main...HEAD`. Split larger work
  into consecutive PRs.
- Exact-pin runtime and agent packages. Keep the toolchain pinned.
- Keep secrets, `.env` files, authentication state, `.vercel`, Pi sessions,
  transcripts, notes, workspaces, and outputs out of Git. Examples hold
  placeholders only.
- Fixtures are synthetic and safe to publish. Keep personal setup, account
  details, and progress notes out of the repository.
- Run `pnpm format` before the checks; they fail on any formatting difference.

## Verification

- Run `TEST_REDIS_URL=redis://127.0.0.1:16379 pnpm check` and
  `pnpm scan:secrets` ([test Redis](docs/toolchain.md#checks)).
- When practical, write a test that fails for the missing behavior first.
- Never claim a boundary was verified when it was mocked. A fake worker or
  stand-in model proves gateway and worker logic, not Pi, Sandbox, Drive,
  OpenRouter, or live Slack behavior. Report real provider and live Slack checks
  separately, and never mark an unperformed check as passing.
- Record new real provider or live Slack evidence in
  [How it's tested](docs/spec/traceability.md).
- A worker change reaches a running installation only through a new worker: see
  [Apply worker changes](docs/make-it-your-agent.md#apply-worker-changes).
