# WSL development environment

Use Ubuntu 24.04 in WSL 2 for Codex CLI, Claude Code, and Pi development. Keep a
separate Linux checkout under the WSL user's home directory. Do not install
Linux dependencies into the Windows checkout under `/mnt/c`: native packages and
pnpm links are platform-specific and will corrupt each other's `node_modules`
state. Provider credentials and agent authentication also remain in the WSL
user's home directory.

## Verified starting state

The WSL distribution is Ubuntu 24.04 on WSL 2. Codex CLI 0.166.0, Claude Code
2.1.311, Pi 1.3.0, Git 2.43.0, GitHub CLI 2.88.1, `curl`, and `jq` were already
installed. Node and pnpm were absent, so the existing Pi launcher could not run.
`acpx` was also absent; it is deferred until the Pi/ACP compatibility tracer
bullet.

Existing user-level Codex, Claude, and Pi configuration was inspected by key
name only. All three already had a Vercel entry. The setup below preserves those
files and adds project-scoped definitions without copying credentials into the
repository.

## Bootstrap and checks

Open a WSL shell and run:

```bash
wsl.exe -d Ubuntu-24.04
mkdir -p ~/src
git clone <repository-url> ~/src/slack-agent-starter
cd ~/src/slack-agent-starter
bash ./scripts/bootstrap-toolchain.sh
source ./scripts/use-toolchain.sh
pnpm install --frozen-lockfile
pnpm check
pnpm scan:secrets
```

The bootstrap verifies published SHA-256 values and installs Node 26.13.0, pnpm
12.16.1, and Gitleaks 8.30.1 below
`~/.local/share/slack-agent-starter/toolchains`. It does not modify shell
startup files, the persistent `PATH`, or system packages. The sourced
environment keeps all dependencies in the Linux checkout. Use normal Git pushes
and pulls to move source changes between the Windows and WSL checkouts; never
share `node_modules` between them.

Start any development agent from the same sourced shell:

```bash
codex
claude
pi
```

`AGENTS.md` is the shared development guidance. `CLAUDE.md` imports it, and Pi
discovers `AGENTS.md` from the repository tree. No additional shared skill is
needed for phase 0.

## Development MCP connections

The checked-in files contain endpoints only:

| Client      | Project configuration |
| ----------- | --------------------- |
| Codex       | `.codex/config.toml`  |
| Claude Code | `.mcp.json`           |
| Pi          | `.pi/mcp.json`        |

Vercel uses its official OAuth endpoint, `https://mcp.vercel.com`. Upstash uses
its hosted OAuth endpoint restricted to the Redis feature group,
`https://mcp.upstash.com/mcp?features=redis`. These are developer connections;
they are not runtime connectors for the Slack agent.

Authentication is intentionally still user-local:

- In Codex, start `codex` from the Linux checkout and trust the project so Codex
  will load `.codex/config.toml`. Then run `codex mcp login vercel` and
  `codex mcp login upstash`, and use read-only calls to confirm the intended
  account and project.
- In Claude Code, start `claude` from the checkout, approve the project MCP
  definitions, open `/mcp`, and authenticate each server. Review the OAuth
  account and requested access before granting it.
- In Pi, start `pi` from the checkout and trust the project so Pi will load
  `.pi/mcp.json`. Then use `/mcp` or `pi mcp login <server>` to authenticate. Pi
  1.3.0 has official built-in MCP support, so no third-party MCP adapter is
  installed.

Prefer read-only Upstash authorization for routine inspection where the consent
flow offers it. Redis-only scoping hides unrelated Upstash products, but the
Redis group still contains write and destructive tools when the authorization
allows them.

Vercel's published supported-client list includes Codex CLI, Claude Code, and
Pi. Vercel's Pi recipe still installs `pi-mcp-adapter`, while the installed Pi
1.3.0 CLI and current Pi documentation provide built-in streamable HTTP, OAuth,
`pi mcp` commands, and `.pi/mcp.json`. This repository uses that built-in client
to avoid replacing or duplicating it with a third-party adapter. If live Vercel
OAuth fails after project trust is granted, review the adapter as a focused
compatibility fallback. Upstash documents its hosted endpoint for any MCP
client.

### Verification status

The project files parse as JSON and contain the expected secret-free endpoints.
The installed Pi 1.3.0 help confirms that it reads `.pi/mcp.json` in trusted
projects and supports `list`, `login`, and streamable HTTP without an extension.
No provider data read has passed yet because the relevant connections are not
authenticated:

- Vercel CLI 65.9.0 runs natively in WSL, but `vercel whoami` reports logged out
  and the Linux checkout has no `.vercel/project.json` link. CLI login/link and
  MCP OAuth are separate readiness steps.
- `codex mcp list` shows Vercel as not logged in; the project Upstash entry will
  not load until the Linux checkout is trusted.
- `claude mcp list` shows Vercel needs authentication and Upstash is pending
  project approval.
- `pi mcp list` shows the existing user-level Vercel entry needs sign-in and the
  project file is ignored until the checkout is trusted.

These states prove configuration discovery only. Do not report either provider
as readable until the trust, OAuth, and read-only account/project checks above
have succeeded.

Do not paste tokens into these files, shell history, issues, or chat. OAuth
caches and provider CLI state belong under the WSL user's home directory.

## Sources

- [Node.js releases](https://nodejs.org/en/about/previous-releases)
- [pnpm installation and compatibility](https://pnpm.io/installation)
- [Pi MCP servers](https://pi.dev/docs/latest/mcp)
- [Vercel MCP](https://vercel.com/docs/agent-resources/vercel-mcp)
- [Upstash MCP](https://upstash.com/docs/agent-resources/mcp)
