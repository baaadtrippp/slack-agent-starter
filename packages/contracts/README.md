# Contracts

This package defines the versioned messages exchanged between the gateway and
worker, as Zod schemas with their inferred types. It does not expose Slack SDK
or Pi-specific types.

- `workerJobSchema`: the job the gateway dispatches, with the Slack input,
  staged sources, optional thread context, native session reference, content
  limits, deadline, and run-scoped callback credential.
- `workerResultSchema`, `workerProgressSchema`, and `workerCallbackSchema`: the
  worker's terminal result, its single `working` signal, and the union the
  gateway accepts on its callback route.
- `limits` and `RUN_DURATION_MS` in `src/limits.ts`: the content limits, one
  name per purpose, and the run duration. Each limit is enforced where its input
  is handled. The gateway sends `limits` with every job, and the Sandbox worker
  in `apps/worker/sandbox/` enforces the values it receives.
- Shared values such as the supported `artifactFormats`.
