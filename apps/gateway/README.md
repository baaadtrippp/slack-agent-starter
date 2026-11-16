# Gateway

Follow the [quickstart](../../docs/service-setup.md) for the managed Pi worker,
Vercel project settings, Slack manifest, and gateway configuration.

## Automatic idle stop

The gateway requires `SANDBOX_WORKER_NAME`, `SANDBOX_MANAGED_DRIVE`, and
`SANDBOX_MANAGED_SEED` from the worker bootstrap output. The bootstrap prepares
the named nonpersistent worker from a clean startup snapshot, configures its
firewall rule for the model key, mounts the Drive read-write at `/workspace`,
and records the first worker session in Redis. The snapshot contains the pinned
worker packages and files, and no credentials or workspace data.

The gateway stops the worker after the last run has finished. A later request
starts a new session from the same startup snapshot once fresh reads show that
the old session stopped and released the Drive. The gateway records each start
in Redis first, so it never starts two; if Vercel's reply was unclear, a later
request looks for the session that start created. Until the gateway can confirm
a session, requests get "The worker is unavailable… Mention me again when the
worker is ready." If Vercel's Sandbox view then shows no new session, check the
named worker Sandbox and Drive. Once no start is in progress and the old session
is stopped and has released the Drive, an operator can resume the same Sandbox.
Leave the Redis records in place; the next request checks and uses the new
session.
