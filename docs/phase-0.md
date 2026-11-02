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

## Service readiness

| Service           | State                                                    | Remaining dependency                                                                                 |
| ----------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| GitHub            | Existing personal-account CLI authentication verified    | Final publication/security/CI verification                                                           |
| Vercel CLI        | Installed and version verified; login initiated          | User completes account sign-in                                                                       |
| Vercel MCP        | Secret-free disabled project template prepared           | OAuth and a successful intended-project read                                                         |
| Vercel project    | Pending                                                  | Account inventory, free capacity, dedicated project link                                             |
| Sandbox and Drive | Capability researched; not provisioned or smoke-tested   | Dedicated project, region, account quota and access                                                  |
| Upstash Redis     | Capability researched; no existing resources changed     | Account sign-in, free-slot inventory, dedicated database and temporary-key check                     |
| Slack             | Manifest template and proposed-controls overlay prepared | App name, enabled/test channels, workspace authorization, validation token and eventual real webhook |
| OpenRouter        | Environment names prepared; no keys or model calls       | Model selection, budget cap and securely supplied credential                                         |
| Pi/acpx/pi-acp    | Exact compatibility candidates documented                | Real compatibility evidence belongs to the second tracer bullet                                      |
| CodeRabbit        | Free public-repository offering researched               | Repository-only GitHub App installation                                                              |

Published plan limits in [service setup](service-setup.md) are not evidence of
available capacity in the selected accounts. A resource name is not proof of
live event delivery, persistence, or model/tool behavior.

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
