# Development toolchain

The repository pins Node.js 26.13.0 and pnpm 12.16.1. Use these exact versions
locally and in CI so frozen dependency installs are reproducible.

## Windows

The repository includes PowerShell scripts that install a project-specific
toolchain under the current user's local application-data directory. They do not
persistently change `PATH`.

```powershell
& .\scripts\Bootstrap-Toolchain.ps1
. .\scripts\Use-Toolchain.ps1
pnpm install --frozen-lockfile
pnpm check
pnpm scan:secrets
```

`Use-Toolchain.ps1` updates only the current PowerShell process.

## Linux

On x86_64 Linux, use the repository scripts to download the pinned Node.js,
pnpm, and Gitleaks releases, verify their checksums, and add them to the current
shell only:

```bash
bash scripts/bootstrap-toolchain.sh
source scripts/use-toolchain.sh
pnpm install --frozen-lockfile
pnpm check
pnpm scan:secrets
```

For another Linux architecture, install the exact Node.js and pnpm versions
declared by the repository and the pinned Gitleaks version, then ensure all
three are on `PATH` before running the same pnpm commands.

## macOS

Use a version manager that reads `.node-version`, install the pnpm version
declared by `packageManager` in `package.json`, and install the pinned Gitleaks
version used by the bootstrap scripts. Confirm `node`, `pnpm`, and `gitleaks`
are on `PATH`, then run the same install and check commands shown above.

Do not share `node_modules` between operating systems or CPU architectures.

## Checks

- `pnpm format:check` verifies formatting with Prettier.
- `pnpm lint` checks repository Markdown.
- `pnpm typecheck` runs strict, no-emit TypeScript checks across apps, packages,
  and tests.
- `pnpm lint:ts` checks TypeScript with ESLint and typescript-eslint.
- `pnpm test` runs the deterministic Vitest suite with Node.js.
- `pnpm check:repository` rejects required-path omissions, private reference
  material, local absolute paths, credentials, and runtime state visible to Git.
- `pnpm scan:secrets` scans all current Git-visible regular files and Git
  history with redacted output. Ignored local credentials remain outside the
  current-file scan; force-tracked files remain included.
- `pnpm check` runs formatting, Markdown and TypeScript lint, type checking,
  tests, and repository-boundary checks.

The Windows and Linux bootstrap scripts install the pinned Gitleaks release used
by `pnpm scan:secrets`. The Vercel CLI is an exact project dependency; invoke it
as `pnpm exec vercel` so contributors use the repository version.

pnpm permits install scripts only for the reviewed native dependencies listed in
`pnpm-workspace.yaml`. Review a new dependency's install script before adding it
to that allowlist.

Vitest tests use synthetic fixtures and do not require provider credentials. The
Redis store and gateway integration suites run only when `TEST_REDIS_URL` is
set. Without it, those suites are skipped; `pnpm check` alone is then not full
test verification. Provider connectivity and live Slack checks are separate.

For full local verification on Linux or WSL, start the same pinned ephemeral
Redis image used in CI. It listens only on loopback, disables snapshots and
append-only persistence, and is removed when stopped:

```bash
docker run --rm --detach \
  --name slack-agent-starter-test-redis \
  --publish 127.0.0.1:16379:6379 \
  redis@sha256:4eec4565e45aa0b3966554c866bc73211e281b0b3d89fe9a33c982e6faca809d \
  redis-server --save "" --appendonly no

TEST_REDIS_URL=redis://127.0.0.1:16379 pnpm check

docker stop slack-agent-starter-test-redis
```

If the check exits early, stop the test container with the same `docker stop`
command. The test suites namespace and remove their Redis keys. They mock Slack
delivery; this verifies gateway behavior against local Redis, not Slack's live
boundary.

## References

- [Node.js releases](https://nodejs.org/en/about/previous-releases)
- [pnpm installation](https://pnpm.io/installation)
