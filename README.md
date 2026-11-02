# Slack agent starter

A TypeScript monorepo for a Slack agent with a lightweight messaging gateway and
a separate Pi worker runtime.

## Architecture

- A Vercel Chat SDK gateway receives Slack events, owns all Slack API calls, and
  coordinates runs through Upstash Redis.
- One Vercel Sandbox hosts independent Pi processes for active Slack threads.
- One persistent Vercel Drive stores exact native sessions, per-thread files,
  results, and shared memory across sandbox replacement.
- OpenRouter provides model access. The gateway never runs the agent loop.

The repository currently contains the infrastructure scaffold, canonical
specification, service templates, and development checks. Application handlers,
the worker host, and the model/tool loop are intentionally absent until
implementation begins through reviewed tracer bullets.

## Project documentation

- [V1 product and architecture specification](docs/spec/v1.md)
- [Requirements traceability](docs/spec/traceability.md)
- [Development toolchain](docs/toolchain.md)
- [Service setup](docs/service-setup.md)
- [Optional development integrations](docs/development-integrations.md)
- [Developer instructions](AGENTS.md)
- [Contributing](CONTRIBUTING.md)

## Local checks

Install the pinned toolchain and dependencies as described in
[docs/toolchain.md](docs/toolchain.md), then run:

```text
pnpm check
pnpm scan:secrets
```

Use only synthetic fixtures in the repository. Keep credentials, provider
authentication, sessions, shared memory, real attachments, and generated runtime
outputs in ignored local files or provider secret stores.

Licensed under the [MIT License](LICENSE).
