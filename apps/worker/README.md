# Temporary fake worker

Milestone 1 deploys this canned worker to a separate temporary Vercel project.
It has no Slack, Redis, model, or platform-control credentials. Configure only
`GATEWAY_ORIGIN`, the gateway's public HTTPS origin, in this project.

Vercel project root: `apps/worker`. Enable source files outside the root to
include the shared `packages/contracts` package. The worker accepts a bounded,
run-scoped job at `POST /api/fake`, asks the gateway to confirm admission, and
posts a canned result to the HTTPS callback URL already bound to its job. Its
retries reuse one callback event ID.

This project is temporary test scaffolding. It does not demonstrate the Pi,
OpenRouter, Vercel Sandbox, or Drive worker path and is replaced by the worker
host integration in milestone 2.
