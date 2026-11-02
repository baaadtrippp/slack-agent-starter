# Slack agent starter

A TypeScript monorepo for a Slack gateway and a separate agent worker. The
canonical product and architecture requirements are in the
[v1 specification](docs/spec/v1.md).

## Current implementation

Milestone 1 implements a signed Slack mention through Chat SDK and Upstash Redis
to a temporary, separate fake-worker deployment. A run-authenticated callback
returns a canned answer to its originating thread. O01 permits any internal
member of the selected public test channel; private channels and DMs remain
disabled.

The fake worker is test scaffolding. Pi, OpenRouter, Vercel Sandbox, and Drive
are not connected. The v1 target architecture keeps Slack access and run
coordination in the gateway, with a separate Pi worker process and one
persistent Drive.

## Documentation

- [V1 requirements and architecture](docs/spec/v1.md)
- [Milestone 1 slice](docs/spec/milestone-1.md)
- [Requirements traceability](docs/spec/traceability.md)
- [Toolchain and full local checks](docs/toolchain.md)
- [Service setup](docs/service-setup.md)
- [Developer instructions](AGENTS.md)
- [Contributing](CONTRIBUTING.md)

## Checks

Install the pinned toolchain and dependencies as described in
[docs/toolchain.md](docs/toolchain.md). For full checks, run the disposable
loopback Redis service there, then:

```text
TEST_REDIS_URL=redis://127.0.0.1:16379 pnpm check
pnpm scan:secrets
```

Keep credentials, provider authentication, sessions, memory, real attachments,
and runtime outputs out of Git. The committed fixtures are synthetic.

Licensed under the [MIT License](LICENSE).
