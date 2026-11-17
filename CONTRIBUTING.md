# Contributing

- For anything beyond a small fix, open an issue first so we can agree on the
  approach.
- Run the checks with the [test Redis](docs/toolchain.md#checks) running:

  ```sh
  TEST_REDIS_URL=redis://127.0.0.1:16379 pnpm check
  pnpm scan:secrets
  ```

- In the pull request, say what you tested against real Slack and Vercel, and
  what you did not.
- Keep a pull request under 400 added lines, not counting `pnpm-lock.yaml`.
  Split bigger work into consecutive pull requests.
- Never commit credentials or real data. [AGENTS.md](AGENTS.md) has the coding
  rules.
