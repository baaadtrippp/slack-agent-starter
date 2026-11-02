# Development integrations

These connections assist developers. They do not grant the runtime agent account
access.

| Service       | Connection                                                 | Secret handling                                                           |
| ------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| GitHub        | Existing authenticated `gh` and GitHub connector           | User-local CLI authentication; no duplicate MCP                           |
| Vercel        | Official CLI and OAuth MCP                                 | User-local OAuth; narrow endpoint to the dedicated project when available |
| Upstash       | Official Redis-only OAuth MCP                              | User-local OAuth; runtime Redis credentials remain separate               |
| Slack         | Manifest and official validation API                       | User-local manifest configuration token; no message sending in phase 0    |
| Browser       | Existing browser tooling                                   | Reuse the existing installation                                           |
| Documentation | Existing official documentation connection and vendor docs | No additional account required                                            |

The checked-in `.codex/config.toml` declares Vercel and Redis-only Upstash
development connections. Run `codex mcp login vercel` and
`codex mcp login upstash` from the trusted project on each development host. The
currently documented endpoint uses the authenticated account's access; project
scoping must be verified before claiming it is restricted. Keep deployment
identities in local configuration. A server listing proves configuration only:
verify a read of the intended project before calling the connection ready.
Preserve existing user MCP configuration.

Claude Code and Pi development sessions use the shared endpoints with separate
user-local OAuth. `CLAUDE.md` imports the canonical developer instructions. See
[WSL development](wsl-development.md) for the Linux-host setup and checks.

Sources: [Codex MCP configuration](https://developers.openai.com/codex/mcp),
[Vercel MCP](https://vercel.com/docs/agent-resources/vercel-mcp).
