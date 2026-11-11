# Slack agent starter

A deployable TypeScript Slack agent with a Vercel gateway and a separate Pi
worker in Vercel Sandbox. Slack threads map to exact native Pi sessions on one
persistent Vercel Drive. Upstash Redis stores routing and coordination state,
and OpenRouter supplies the selected model.

The supported v1 installation is the [v1 quickstart](docs/service-setup.md). It
creates a clean worker snapshot, one named nonpersistent Sandbox, and one
writable Drive using only files in this repository and adopter-supplied service
accounts.

## V1 behavior

- Mentions in one configured public channel start work.
- Ordinary replies continue the same saved Pi session.
- Status, Stop, Slack files, public text URLs, generated files, thumbs feedback,
  and explicit channel notes use the same gateway and worker path.
- A stopped Sandbox is replaced from the clean startup snapshot while the Drive
  keeps sessions, work, results, and shared notes.
- The worker can reach only the gateway origin and OpenRouter. The Sandbox
  egress policy is configured to inject the model key without storing it in the
  worker.

## Documentation

- [V1 quickstart](docs/service-setup.md)
- [V1 requirements and architecture](docs/spec/v1.md)
- [Requirements traceability](docs/spec/traceability.md)
- [Worker implementation](apps/worker/README.md)
- [Toolchain and full local checks](docs/toolchain.md)
- [Developer instructions](AGENTS.md)
- [Contributing](CONTRIBUTING.md)

## Checks

Install the pinned toolchain and dependencies as described in
[docs/toolchain.md](docs/toolchain.md). For full checks, run the disposable
loopback Redis service there, then run:

```text
TEST_REDIS_URL=redis://127.0.0.1:16379 pnpm check
pnpm scan:secrets
```

Keep credentials, provider authentication, worker records, native sessions,
memory, real attachments, and runtime outputs out of Git. Committed fixtures are
synthetic.

Licensed under the [MIT License](LICENSE).
