# Development toolchain

The repository pins Node.js 26.13.0 and pnpm 12.16.1. Node 26 is an LTS release,
and pnpm 12 officially supports Node 26. Exact versions keep local and CI
installs reproducible.

## Windows setup

The machine-wide Node installation may be older and belongs to other projects.
Install this repository's copy under the current user's local application-data
directory without changing the persistent `PATH`:

```powershell
& .\scripts\Bootstrap-Toolchain.ps1
. .\scripts\Use-Toolchain.ps1
pnpm install --frozen-lockfile
pnpm check
pnpm scan:secrets
```

`Use-Toolchain.ps1` changes only the current PowerShell process. Open a fresh
shell to return to the machine's default runtime.

On macOS or Linux, use a version manager that reads `.node-version`, install the
`packageManager` version from `package.json`, then run the same `pnpm` commands.

## Checks

- Prettier checks formatting for the files that exist in phase 0.
- markdownlint checks the Markdown documentation and package placeholders.
- The repository-boundary script inspects everything visible to Git. It rejects
  local absolute paths, private handoff/course material, runtime state, and
  credential paths, and it requires the agreed repository structure.
- CI runs Gitleaks against repository content and history with redacted output.

The bootstrap installs Gitleaks 8.30.1 beside the pinned Node and pnpm copies.
The Vercel CLI is an exact project dependency; invoke it with
`pnpm exec vercel`. Authentication remains in Vercel's user-local storage and is
never committed.

pnpm permits install scripts only for `esbuild` and `koffi`, the two native
dependencies required by the pinned Vercel CLI. The allowlist is held in
`pnpm-workspace.yaml`, where pnpm 12 reads project settings. A new dependency
with an install script fails installation until it is reviewed and explicitly
allowed.

There is no phase-0 typecheck or test command because the packages contain no
executable source. Add strict TypeScript, a single TypeScript linter, and Vitest
with the first tracer bullet that introduces behavior and meaningful acceptance
tests.

## Sources

- [Node.js releases](https://nodejs.org/en/about/previous-releases)
- [Node.js 26.13.0 release](https://nodejs.org/en/blog/release/v26.13.0)
- [pnpm installation and compatibility](https://pnpm.io/installation)
