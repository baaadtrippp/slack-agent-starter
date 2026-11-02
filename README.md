# Slack agent starter

A public TypeScript monorepo for a Slack gateway and a separate Pi agent worker.
Phase 0 prepares the repository and development infrastructure. No Slack
handler, worker host, model loop, or runtime account connector is implemented
yet.

## Architecture

- Vercel Chat SDK and its official Slack adapter run in the gateway on Vercel
  Functions.
- Upstash Redis holds gateway state and coordination.
- One Vercel Sandbox hosts independent Pi processes for separate Slack threads.
- One persistent Vercel Drive holds exact native sessions, thread files, and
  shared memory.
- OpenRouter supplies the model; model selection and spending cap remain open.

The gateway owns Slack calls. The worker owns the agent loop. A thread's
identity survives sandbox replacement. Runtime account connectors are deferred.

## Start here

1. Read the [canonical specification](docs/spec/v1.md).
2. Follow [toolchain setup](docs/toolchain.md) and run the documented checks.
3. Read [development guidance](AGENTS.md) and
   [contribution workflow](CONTRIBUTING.md).
4. Inspect [phase 0 readiness](docs/phase-0.md) before starting feature work.
5. Follow [service setup](docs/service-setup.md) for external prerequisites.

Local secrets belong in ignored files or provider secret stores. Copy
`.env.example` only to an ignored local environment file. Never commit sessions,
shared memory, real attachments, credentials, or provider authentication state.

MIT licensed. Infrastructure setup does not demonstrate live Slack delivery or
native Pi resume; those need separate acceptance evidence.
