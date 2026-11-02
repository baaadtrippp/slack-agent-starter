# Development integrations

These connections assist developers. They do not grant the runtime agent account
access.

| Service       | Connection                                                 | Secret handling                                                           |
| ------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| GitHub        | Existing authenticated `gh` and GitHub connector           | User-local CLI authentication; no duplicate MCP                           |
| Vercel        | Official CLI and OAuth MCP                                 | User-local OAuth; narrow endpoint to the dedicated project when available |
| Upstash       | Official console/API                                       | Keep management credentials outside this repository; MCP is optional      |
| Slack         | Manifest and official validation API                       | User-local manifest configuration token; no message sending in phase 0    |
| Browser       | Existing browser tooling                                   | Reuse the existing installation                                           |
| Documentation | Existing official documentation connection and vendor docs | No additional account required                                            |

The checked-in `.codex/config.toml` is disabled until account access is ready.
Enable it locally and run `codex mcp login vercel` from the trusted project. The
currently documented endpoint uses the authenticated account's access; project
scoping must be verified before claiming it is restricted. Keep deployment
identities in local configuration. A server listing proves configuration only:
verify a read of the intended project before calling the connection ready.
Preserve existing user MCP configuration.

Claude Code can use its project/user HTTP MCP configuration with the same
endpoint and user-local OAuth. Installation of Claude Code is optional;
`CLAUDE.md` imports the canonical developer instructions.

Sources: [Codex MCP configuration](https://developers.openai.com/codex/mcp),
[Vercel MCP](https://vercel.com/docs/agent-resources/vercel-mcp).
