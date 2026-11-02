# Phase 0 service setup

Checked against current official documentation and package registries on
2026-11-02. This page records capability and setup evidence; it does not claim
that account resources were created or live traffic was tested.

## Readiness states

| Service    | Phase 0 state in source                                                      | Account check required                                                                                     |
| ---------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Slack      | Manifest template prepared; remote validation and app creation pending       | App display name, enabled/test channels, workspace authorization, and a real gateway URL                   |
| Vercel     | Official CLI/MCP and Sandbox/Drive procedure documented                      | OAuth account/team selection, dedicated project creation, quota check, region choice, and Drive smoke test |
| Upstash    | Free-tier and least-scope access procedure documented                        | OAuth account/team selection, existing database inventory, free capacity, and dedicated Redis creation     |
| Pi / ACP   | Exact validation candidate identified; executable compatibility test pending | Supported Node runtime and an OpenRouter key supplied securely at test time                                |
| CodeRabbit | Public-repository entitlement and repository-only install path documented    | GitHub App authorization after the public repository exists                                                |

Never reuse an unrelated project or database. Never put provider tokens,
downloaded environment files, Pi authentication state, sessions, or Drive
contents in Git.

## Vercel

Use the dedicated repository to create and link one Vercel project. The official
Vercel MCP endpoint is `https://mcp.vercel.com`; it uses OAuth, is available on
all plans, and supports project, deployment, log, analytics, and documentation
tasks. Use the repository-scoped connection template and login procedure in
[`development-integrations.md`](development-integrations.md) instead of adding
another global connection.

Authorize only the intended Vercel account/team. A successful connection must
perform a real read, such as listing the dedicated project; a configured server
name alone is not verification. Keep OAuth state in the user-level client
configuration. The CLI's local project link and pulled development environment
are local state and must stay ignored.

Current Sandbox Hobby allowances are 5 active CPU hours/month, 420 GB-hours of
provisioned memory/month, 5,000 creations/month, 20 GB/month outbound transfer,
and a 45-minute maximum session. Hobby pauses new sandbox creation after an
allowance is exhausted and does not charge overage. Drive allowances are 15 GB
of stored data (lifetime allocation) and 30 GB/month each of reads and writes.
The default maximum Drive size on Hobby is 1 GiB.

The architecture depends on one persistent Drive with one read-write mount.
Vercel currently permits one read-write sandbox mount per Drive; concurrent
point-in-time snapshots are read-only. A Drive belongs to one project and one
region, and any sandbox mounting it must use that region.

After account access and region are confirmed, the infrastructure-only check is:

```text
pnpm exec vercel link
pnpm exec vercel env pull
pnpm exec vercel sandbox drives get-or-create agent-workspace --max-size 1GiB --region <region>
pnpm exec vercel sandbox run --mount agent-workspace:/workspace --region <region> --network-policy deny-all --stop -- sh -lc "trap 'rm -f /workspace/phase-0-check' EXIT; printf ready > /workspace/phase-0-check; test -s /workspace/phase-0-check"
```

The pinned Vercel CLI exposes these Drive operations under `vercel sandbox`; the
`--stop` flag guarantees the session stops when the check command exits. Confirm
the Drive is detached and has no test file. Do not install Pi, start the worker
host, or deploy a placeholder Slack handler in this check. The observed registry
versions were Vercel CLI `65.9.0` and `@vercel/sandbox` SDK `3.9.1`; pin the SDK
when it becomes an application dependency rather than relying on `latest`.

References: [Vercel MCP](https://vercel.com/docs/agent-resources/vercel-mcp),
[Sandbox pricing and quotas](https://vercel.com/docs/sandbox/pricing), and
[Drives](https://vercel.com/docs/sandbox/concepts/drives).

## Upstash Redis

The current free Redis allowance is 256 MB of data, 500,000 commands/month, and
10 GB/month bandwidth. The pricing page currently gives inconsistent
account-level database counts in different sections, so inspect the selected
account rather than assuming a slot exists. Do not add a payment method,
upgrade, enable automatic upgrades, or repurpose an existing database.

The console or official CLI is sufficient for phase 0. If account inspection
needs an MCP connection, the smallest one is the official remote MCP restricted
to Redis tools:

```toml
[mcp_servers.upstash]
url = "https://mcp.upstash.com/mcp?features=redis"
```

OAuth is the preferred authentication method. Select the intended personal or
team account during consent. A read-only grant is sufficient for inventory and
stats; creating the dedicated database requires a write-capable grant. A real
read such as `redis_list_databases` verifies the connection. Do not request
credentials during inventory; management tools return them only when
`include_credentials` is explicitly true.

If free capacity exists, create one regional Redis database for this project,
leave it on the free plan, and keep auto-upgrade off. Put the REST URL and token
only in the development tool's user-local OAuth/authentication state or ignored
local files. Validate with a temporary namespaced key, delete that key, and
record the region and observed free-plan limits without recording credentials.

Runtime configuration has a different credential contract. Chat SDK's official
`@chat-adapter/state-redis` adapter uses the official `redis` client and
requires a Redis connection URL through `REDIS_URL` (or an explicitly supplied
`url` or connected client). Upstash's Vercel Marketplace integration supplies
`REDIS_URL`. If the database is provisioned directly in Upstash, inject its TLS
Redis connection URL as `REDIS_URL` in the gateway's Vercel environment. The
Upstash REST URL/token used by development tools do not satisfy this adapter
contract by themselves. Keep every form of the runtime credential out of tracked
files.

References: [Upstash MCP](https://upstash.com/docs/agent-resources/mcp) and
[Redis pricing](https://upstash.com/pricing/redis), plus the
[Chat SDK Redis adapter](https://chat-sdk.dev/adapters/official/redis).

## Slack

The tracked template and proposed overlay live under `integrations/slack/`.
Slack requires `app_mentions:read` for `app_mention`, `channels:history` for
`message.channels`, and `groups:history` for `message.groups`. File input and
output use `files:read` and `files:write`. The progress acknowledgement uses
`reactions:write`. The proposed feedback events require `reactions:read`.

Remote manifest validation requires a Slack app configuration token with
`app_configurations:write`. Request URL verification and installation remain
pending until a gateway endpoint exists. Receiving an event and sending a live
message are application acceptance checks, not phase 0 infrastructure checks.

References: [app manifest](https://docs.slack.dev/reference/app-manifest/),
[`apps.manifest.validate`](https://docs.slack.dev/reference/methods/apps.manifest.validate/),
[message events](https://docs.slack.dev/reference/events/message/), and
[working with files](https://docs.slack.dev/messaging/working-with-files/).

## Pi through acpx and pi-acp

The exact current validation candidate is:

| Component                         | Candidate | Compatibility evidence                                                        |
| --------------------------------- | --------- | ----------------------------------------------------------------------------- |
| `acpx`                            | `0.21.1`  | Requires Node `>=22.13.0`; its published Pi adapter range is `pi-acp ^0.0.33` |
| `pi-acp`                          | `0.0.34`  | Inside that acpx range; requires Pi `>=0.81.0`; npm engine is Node `>=20`     |
| `@earendil-works/pi-coding-agent` | `1.5.0`   | Above the adapter minimum; requires Node `>=22.19.0`                          |

The shared runtime therefore needs Node `>=22.19.0`; use the repository's pinned
supported Node release. Pi supports OpenRouter through `OPENROUTER_API_KEY`, and
its RPC mode can use the cached model catalog. Inject the key into the worker
process environment; do not run interactive `/login` or persist `auth.json` on
the Drive.

The candidate versions are registry and declared-range evidence, not proof of
the required behavior. After phase 0 review, pin all three exactly and run a
focused compatibility check for custom prompt/tools, file and image input,
native session save/resume, two independent sessions, cancellation, and
OpenRouter model selection. `pi-acp` documents partial ACP support, so do not
infer unsupported filesystem/terminal delegation or MCP wiring. A direct Pi RPC
adapter is only a fallback if this check identifies a required gap.

References: [acpx installation](https://acpx.sh/install.html),
[acpx Pi profile](https://acpx.sh/agents.html),
[`pi-acp` package](https://www.npmjs.com/package/pi-acp), and
[Pi providers](https://pi.dev/docs/latest/providers).

## CodeRabbit

CodeRabbit states that Pro-level reviews are free for public repositories after
installing its GitHub App. Public-repository use is rate-limited, and paid
features such as Dashboard and Reports are excluded. After the repository is
public, sign in with GitHub and grant the app access only to this repository. No
repository configuration file is needed for phase 0 unless an actual review
shows a project-specific need.

Reference:
[CodeRabbit public-repository setup](https://kb.coderabbit.ai/articles/8856795235-how-do-i-activate-coderabbit-pro-for-my-open-source-project).
