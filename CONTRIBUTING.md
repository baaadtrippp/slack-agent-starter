# Contributing

Read [AGENTS.md](AGENTS.md) and the canonical
[v1 specification](docs/spec/v1.md) before making a change.

Work in small tracer bullets. Each change should name the user outcome, affected
F/AC IDs, non-goals, smallest end-to-end implementation, and observable
evidence. Keep changes focused and update
[traceability](docs/spec/traceability.md) only with evidence that actually ran.

Before opening a pull request:

1. run the repository checks documented in the README;
2. review the diff and tracked files for secrets, private material, local paths,
   session data, and generated outputs;
3. state which checks ran and which provider or live boundaries remain
   unverified;
4. confirm that no proposed default was silently promoted to an accepted
   decision.

Never commit credentials. Use the credential-free environment example and
configure real values through local or provider secret storage.
