# Optional development integrations

These connections help contributors inspect or configure development
infrastructure. They are developer tools only and must never grant the runtime
agent access to personal or business accounts.

| Service       | Suggested connection                                         | Credential location                                                  |
| ------------- | ------------------------------------------------------------ | -------------------------------------------------------------------- |
| GitHub        | GitHub CLI or an existing GitHub development connector       | User-local authentication                                            |
| Vercel        | Pinned project CLI and official OAuth MCP                    | User-local OAuth and ignored `.vercel/` link state                   |
| Upstash       | Console, API, or Redis-only OAuth MCP                        | User-local OAuth; runtime Redis credentials stay in provider secrets |
| Slack         | Tracked manifest plus the official manifest API or Slack CLI | User-local app-configuration authentication                          |
| Documentation | Official vendor documentation or optional vendor skills      | No repository credential                                             |

Use the smallest connection that supports the required task. A configured
connection name is not verification; perform a read of the intended project or
database before using it for changes.

## Vercel MCP

Configure the Vercel endpoint in the development client's user-local MCP
configuration. Keep the endpoint, deployment identity, and OAuth state outside
the repository. After the Vercel project exists, prefer the project-specific
endpoint form documented by Vercel when the client supports it.

Codex CLI can also add the official endpoint directly:

```text
codex mcp add vercel --url https://mcp.vercel.com
codex mcp login vercel
```

Claude Code and other supported MCP clients can use the same official endpoint
with their own user-local OAuth. Do not commit generated client configuration
containing deployment identities or authentication state.

## Upstash MCP

An Upstash MCP is optional because the console or API is sufficient to provision
Redis. When an MCP is useful, add it to the development client's user-local
configuration and restrict it to Redis features:

```toml
[mcp_servers.upstash]
url = "https://mcp.upstash.com/mcp?features=redis"
```

Use read-only access for inventory when possible. Runtime Redis credentials
belong in the gateway's provider environment, not in the development MCP
configuration.

## Slack tooling

Use `integrations/slack/manifest.yaml` as the tracked template. Validate the
completed manifest with Slack's official `apps.manifest.validate` API or
supported Slack CLI command. The Slack CLI does not replace this project's
Vercel webhook gateway.

## References

- [Codex MCP configuration](https://developers.openai.com/codex/mcp)
- [Vercel MCP](https://vercel.com/docs/agent-resources/vercel-mcp)
- [Upstash MCP](https://upstash.com/docs/agent-resources/mcp)
- [Slack manifest API](https://docs.slack.dev/reference/methods/apps.manifest.validate/)
