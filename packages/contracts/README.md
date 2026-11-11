# Contracts

This package defines the versioned messages exchanged between the gateway and
worker, as Zod schemas with their inferred types. It does not expose Slack SDK
or Pi-specific types.

- `workerJobSchema`: the job the gateway dispatches, with the Slack input,
  staged sources, optional thread context, native session reference, deadline,
  and run-scoped callback credential.
- `workerResultSchema`, `workerProgressSchema`, and `workerCallbackSchema`: the
  worker's terminal result, its single `working` signal, and the union the
  gateway accepts on its callback route.
- Shared limits and values the gateway enforces, such as `INPUT_BYTE_LIMIT`,
  `MAX_SLACK_INPUT_FILES`, the thread-context limits, `SHARED_NOTE_BYTE_LIMIT`,
  and the supported `artifactFormats`. The Sandbox worker in
  `apps/worker/sandbox/` keeps its own copies of the values it needs.
