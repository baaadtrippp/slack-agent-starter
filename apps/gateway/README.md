# Gateway

Follow the [v1 quickstart](../../docs/service-setup.md) for the managed Pi
worker, Vercel project settings, Slack manifest, and gateway configuration.

## Automatic idle stop

The gateway requires `SANDBOX_WORKER_NAME`, `SANDBOX_MANAGED_DRIVE`, and
`SANDBOX_MANAGED_SEED` from the worker bootstrap output. The bootstrap prepares
the named nonpersistent worker from that exact clean startup seed, configures
its provider-side model firewall, mounts the Drive read-write at `/workspace`,
and enrolls the initial exact session. The seed contains the pinned worker
packages and entry point, and no credentials or workspace data.

The gateway stops after the last verified result and normal exit. A later
request can resume from the pinned startup seed after fresh reads confirm the
old session stopped and the Drive detached. If a resume reply is uncertain, a
later request can verify the new session already created by that intent. The
gateway leaves the intent fenced if it cannot verify a replacement. If no new
session exists, inspect the exact named Sandbox and Drive. Once no resume is in
flight and the old session is confirmed stopped and detached, an operator can
resume the same configured Sandbox. Keep the intent in Redis so the gateway
checks and adopts the new session on the next request.

A request blocked before launch tells the sender to mention the bot again when
the worker is ready.
