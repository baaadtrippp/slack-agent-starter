# Phase 0 infrastructure record

Date: 2026-11-02. This record distinguishes repository readiness from live
service verification. Application acceptance remains unimplemented.

## Scope

Prepared a clean public MIT repository with separate gateway, worker, and
contracts package boundaries. No Slack handlers, worker host, model loop,
runtime account connectors, or Slack messages are part of this phase.

The canonical [specification](spec/v1.md) carries F01–F13 and AC01–AC13.
[Traceability](spec/traceability.md) preserves proposed choices and records no
unperformed feature evidence. `AGENTS.md` is canonical; `CLAUDE.md` imports it.

## Toolchain and evidence

| Item                              | State                                                                        |
| --------------------------------- | ---------------------------------------------------------------------------- |
| Node.js                           | Exact 26.13.0, user-scoped Windows installation; global runtime unchanged    |
| pnpm                              | Exact 12.16.1; workspace and lockfile committed with infrastructure          |
| Vercel CLI                        | Exact 65.9.0; version check passed                                           |
| Gitleaks                          | Exact 8.30.1 locally; CI scans full Git history                              |
| Formatting and documentation lint | Present-file checks configured; final verification recorded below            |
| Repository boundary check         | Rejects private reference paths/material and runtime state                   |
| GitHub workflow                   | Read-only permissions; frozen install, repository checks, secret scan        |
| Feature tests/typecheck           | Deferred until real TypeScript source exists; no placeholder success scripts |

## Final repository verification

- Fresh clone from the public remote: frozen install and `pnpm check` passed.
- Formatting passed; Markdown lint checked 18 repository documents with zero
  issues.
- Repository boundaries passed for 45 files. A forced `.env.local` negative test
  was rejected and the disposable fixture removed.
- Gitleaks passed on the staged source and full initial Git history with no
  leaks.
- GitHub Actions run `41528278357` passed both `Repository checks` and
  `Secret scan`.
- GitHub secret scanning and push protection are enabled. Dependency alerts and
  automatic security fixes are enabled; Dependabot updates cover npm and
  Actions.
- Main requires the two actual CI checks, blocks deletion and force pushes, and
  retains administrator bypass for one-person bootstrap. No approving reviewer
  is required.
- The reference workspace was never initialized or published. Local provider
  link/OIDC files remain ignored.

## Service readiness

| Service           | State                                                                                                    | Remaining dependency                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| GitHub            | Public MIT repository published; checks and security settings verified                                   | None for repository bootstrap                                                                             |
| Vercel CLI        | Installed, authenticated, account and Hobby plan verified                                                | None for CLI access                                                                                       |
| Vercel MCP        | OAuth and team consent complete; intended-project MCP read passed                                        | None for verified desktop/Windows MCP access; WSL authentication is separate                              |
| Vercel project    | Dedicated project provisioned and locally linked; root `apps/gateway`, region `fra1`                     | GitHub repository connection verified; automatic builds intentionally ignored until a real gateway exists |
| Sandbox and Drive | 1 GiB `agent-workspace` Drive provisioned in `fra1`; write/read/cleanup smoke checks passed              | Full runtime/ACP behavior belongs to later slices                                                         |
| Upstash Redis     | Dedicated free database provisioned in Frankfurt; MCP inventory/details/stats verified; auto-upgrade off | Temporary-key smoke test blocked by MCP command approval policy; REDIS_URL injection pending              |
| Slack             | Manifest template and proposed-controls overlay prepared                                                 | App name, enabled/test channels, workspace authorization, validation token and eventual real webhook      |
| OpenRouter        | Environment names prepared; no keys or model calls                                                       | Model selection, budget cap and securely supplied credential                                              |
| Pi/acpx/pi-acp    | Exact compatibility candidates documented                                                                | Real compatibility evidence belongs to the second tracer bullet                                           |
| CodeRabbit        | Installed and posting checks; free OSS entitlement confirmed in its PR comment                           | Automatic reviews unavailable below 10 repository stars; manual review not tested                         |

### Sandbox/Drive evidence

The infrastructure smoke test mounted the named Drive read/write, wrote and read
a temporary marker, removed it through an exit trap, and stopped compute. A
second independent mount verified the marker was absent. Both commands used
one-minute timeouts and deny-all networking. The final running-sandbox list was
empty, and the Drive had no attached writable sandbox. No Pi or model executed.
The Hobby account accepted provisioning and these checks without an upgrade;
this does not establish remaining monthly quota for future application traffic.

Published plan limits in [service setup](service-setup.md) are not evidence of
available capacity in the selected accounts. A resource name is not proof of
live event delivery, persistence, or model/tool behavior.

## Pipeline follow-up evidence

- A fresh Linux clone of the readiness branch passed bootstrap, frozen install,
  formatting, Markdown lint, repository boundaries, shell syntax, and the new
  Git-visible-file plus history secret scan. The checkout remained clean.
- The synthetic-secret negative test returned failure with redacted output; the
  disposable fixture and temporary scan corpus were removed.
- The Vercel GitHub check received PR 2 and reported the deployment cancelled by
  the configured ignored-build step. This verifies Git integration, not a
  deployed application. Remove that temporary project setting in the first
  deployment slice.
- CodeRabbit received PR 2 but reported that automatic reviews require at least
  10 repository stars. Its installation is verified; automated review is not
  ready for this new repository. No paid upgrade was made.

## Coding agents in WSL

A separate native Linux checkout passes the pinned toolchain bootstrap and
repository checks. Codex 0.166.0, Claude Code 2.1.311, and Pi 1.3.0 are
installed. Their project MCP files are prepared; project trust/approval and
separate OAuth remain required before claiming provider access from each client.
The WSL Vercel CLI is installed but not authenticated. See
[WSL development](wsl-development.md).

No extra skill package is required: all three use the canonical AGENTS.md
instructions, with CLAUDE.md importing them. The Vercel plugin supplies vendor
skills to the desktop session; its installation does not copy skills or OAuth
credentials into WSL.

## Proposed first tracer bullet — awaiting phase 0 review

Prove signed event → gateway → Upstash → fake worker contract → authenticated
callback → same-thread reply. Cover the narrow paths in F01/F07/F10 and
AC01/AC08/AC09/AC10. Start with meaningful deterministic signature, retry,
ownership, callback-authentication, and terminal-state tests. Then verify the
claimed provider boundaries in an explicitly authorized live Slack test.

Non-goals: Pi, OpenRouter, Sandbox/Drive worker execution, attachments, shared
memory, controls, feedback, and account connectors. Mock evidence cannot prove
those boundaries. The second slice proves the real worker path and requires the
exact-pinned ACP/Pi compatibility check.

Do not begin this bullet until infrastructure has been reviewed.
