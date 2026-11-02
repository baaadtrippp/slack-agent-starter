# ADR 0001: V1 component and persistence architecture

- Status: accepted
- Date: 2026-11-02
- Canonical requirements: [v1 specification](../spec/v1.md)

## Context

The Slack agent must keep a conversation's native Pi session and files across
worker shutdown and replacement, allow a small number of threads to work
independently, and keep the Slack-facing request path separate from the
model/tool loop. The initial deployment is deliberately small and uses free
infrastructure tiers where available.

## Decision

Use a TypeScript monorepo with separate gateway and worker packages.

The gateway runs on Vercel Functions with Vercel Chat SDK's official Slack
adapter. It owns Slack verification, presentation, access checks, run
coordination, and Upstash Redis state. It never hosts an LLM loop.

The worker uses one active Vercel Sandbox with one persistent Vercel Drive
mounted read/write. Independent Pi processes inside that sandbox serve different
Slack threads. Every Slack thread maps to an exact native Pi/ACP session and
work directory. A small worker host manages per-run processes and authenticated
callbacks to the gateway; it is not another agent loop.

The Drive stores native sessions, per-thread work/results, and shared memory.
Upstash stores routing, coordination, leases, deduplication, and Chat SDK state.
Only one sandbox may hold the Drive's writable mount. Processes share the mount,
so directories organize work but do not isolate mutually untrusted code.

Use OpenRouter initially. Prefer the existing acpx + pi-acp integration and
verify it before designing another adapter.

## Consequences

- Conversation identity survives physical sandbox replacement.
- The gateway can finish its request while the worker continues and calls back.
- One run can be cancelled without stopping other runs, but runtime startup and
  idle shutdown require shared coordination.
- Session and shared-memory writes require explicit ownership and serialization.
- The Drive is durable storage, not a backup or an isolation boundary.
- Neon/Postgres, another queue, an always-on worker, per-thread sandboxes,
  runtime account connectors, and additional compute vendors are outside v1.

## Open follow-up decisions

Memory audience/write policy, retention, model and spend cap, operating limits,
Slack display identity/channels, and the proposed Stop/Status and reaction
behaviors remain open as listed in the specification.
