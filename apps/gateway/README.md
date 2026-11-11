# Gateway

Follow the [v1 quickstart](../../docs/service-setup.md) for the managed Pi
worker, Vercel project settings, Slack manifest, and gateway configuration.

The unmanaged, prewarmed Sandbox is a historical milestone fixture. The
coordinated commands below are for operators of the managed worker.

## Coordinated idle stop

Use the coordinated command with a freshly prepared nonpersistent worker
session. Enroll its exact VM session before routing work to it, after all
gateway deployments that can target it use the reservation protocol and their
pre-upgrade in-flight work has finished. Keep manual commands off the worker
once enrolled. The operator uses the gateway's existing `SANDBOX_WORKER_NAME`
and `REDIS_URL` plus the Vercel project identity.

```sh
node apps/gateway/scripts/idle-shutdown.mjs enroll EXACT_SESSION_ID
node apps/gateway/scripts/idle-shutdown.mjs stop EXACT_SESSION_ID
```

The gateway reserves the exact session before sending a detached command. It
releases the reservation after a confirmed normal exit and a recorded worker
result. If it cannot confirm a start or exit, it keeps the reservation for
operator inspection. The stop command fences the session atomically only when
all reservations are clear. A dispatch that encounters the fence before launch
tells the sender to retry with a fresh mention after a worker is ready. A stop
with an uncertain response keeps the fence in place. Retry against the same
exact session ID.

Keep the stopped Sandbox's session record for proof. Verify the Drive is
detached before preparing a single replacement with the same writable mount.
Enrollment and stop fencing apply to an exact session. Enroll each fresh
replacement before sending work to it.

## Automatic idle test mode

Set `SANDBOX_MANAGED_DRIVE` and `SANDBOX_MANAGED_SEED` together with
`SANDBOX_WORKER_NAME` to enable the automatic test mode. Prepare the named
nonpersistent worker from that exact clean startup seed, configure its
provider-side model firewall, and mount the configured Drive read-write at
`/workspace`. The seed contains the pinned worker packages and entry point.
Capture it before attaching a Drive or running work. Keep credentials and
workspace data out of the seed.

Enroll the initial exact session before routing requests, with all targeting
gateway deployments upgraded and earlier work drained. The gateway stops after
the last verified result and normal exit. A later request can resume from the
pinned startup seed after fresh reads confirm the old session stopped and the
Drive detached. If a resume reply is uncertain, a later request can verify the
new session already created by that intent. The gateway leaves the intent fenced
if it cannot verify a replacement. If no new session exists, inspect the exact
named Sandbox and Drive. Once no resume is in flight and the old session is
confirmed stopped and detached, an operator can resume the same configured
Sandbox. Keep the intent in Redis so the gateway checks and adopts the new
session on the next request.

This mode uses immediate idle stop for the tracer. Production idle timing is an
open operating-limit decision. A request blocked before launch receives the same
explicit retry notice as the operator-controlled flow.
