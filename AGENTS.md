# Developer instructions

## Source of truth

For Chat SDK work, read the installed `chat-sdk` skill first. Prioritize the
installed package's `docs/` and `resources/`, then `chat-sdk.dev`. Use Context7
only when those sources leave a gap; this overrides generic Context7-first
guidance for this SDK.

Read [docs/spec/v1.md](docs/spec/v1.md) before changing application behavior. It
is the canonical v1 specification. Use its stable feature IDs (F01–F13),
acceptance IDs (AC01–AC13), and open-decision IDs (O01–O07). Keep
[docs/spec/traceability.md](docs/spec/traceability.md) current when a slice adds
evidence.

Do not treat proposed defaults as accepted decisions. Do not implement behavior
gated by an open decision until that decision is settled.

## Architecture boundaries

- Keep the Slack gateway and agent worker in separate packages and processes.
- The gateway owns Slack calls, access checks, presentation, Upstash state, and
  coordination. It must not run an agent/model loop.
- Use one active Vercel Sandbox and one persistent writable Vercel Drive for the
  initial worker. Independent Pi processes share the sandbox and Drive; each
  Slack thread maps to its exact native session and workspace.
- Prefer acpx + pi-acp. Verify that path before proposing a new adapter.
- OpenRouter is the initial model provider. NVIDIA is only an optional
  alternative. Do not add an OpenAI API dependency, subscription-based runtime
  authentication, or automatic provider fallback.
- Runtime input is limited to Slack messages/attachments and explicitly supplied
  public URLs. Account connectors, browser automation, schedules, a runtime MCP
  catalog, additional databases/queues, and alternative compute vendors are
  deferred.
- Never treat a work directory or prompt as a security boundary. One writer owns
  each native session; shared-memory writes are serialized.

## Before implementation

State assumptions and success criteria. Surface an ambiguity when it changes
product behavior or architecture. Prefer the simplest approach that proves the
required behavior.

For a non-trivial change, write a short tracer-bullet spec before code:

1. user outcome;
2. touched F/AC IDs and any open decisions;
3. explicit non-goals;
4. smallest end-to-end implementation;
5. observable evidence and whether it is deterministic, provider integration, or
   live Slack evidence.

Phase 0 contains repository, tooling, configuration, CI, documentation, and
service-readiness work only. Do not add Slack handlers, a worker host, an LLM
loop, runtime connectors, or user features until phase 0 has been reviewed.

## Implementation rules

- Write the minimum code required by the selected slice. Do not add speculative
  configuration, extension points, plugin systems, or abstractions for one use.
- Make surgical changes and follow the existing style. Do not refactor adjacent
  code or remove pre-existing material unless the task requires it.
- Remove imports, variables, and files made obsolete by your own change.
- Exact-pin compatibility-sensitive runtime and agent packages. Keep the
  repository toolchain pinned.
- Keep secrets, `.env` files, authentication state, `.vercel`, native sessions,
  transcripts, memory, workspaces, and outputs out of Git. Examples must contain
  placeholders only.
- Use only synthetic, public-safe fixtures in the repository.
- Public documentation describes the product and reusable development steps.
  Keep personal workstation setup, account inventories, progress journals,
  private handoffs, and operator-specific connection configuration outside Git.

## Verification

Select acceptance checks before implementation, make them fail for the missing
behavior when practical, then implement until they pass. Run the smallest
meaningful checks first and stop repeating them once evidence is sufficient.

Never claim a boundary was verified when it was mocked. A fake worker is valid
for deterministic gateway tests but cannot prove Pi, Sandbox, Drive, OpenRouter,
or live Slack behavior. Record real provider and live Slack checks separately.
Do not mark an unperformed check as passing.

## Parallel work

For non-trivial tasks with two or more independent workstreams, use up to five
subagents. Give agents disjoint file ownership, keep the primary agent
responsible for coordination and final verification, and wait for required
results. Stay single-agent for trivial or tightly sequential work.

## Communication

Use plain language. Report what changed, why, the checks that ran, and any real
limitation. Do not silently expand v1, change the harness, merge gateway and
worker responsibilities, or add providers.
