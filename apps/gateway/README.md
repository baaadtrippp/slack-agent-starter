# Gateway

Milestone 1 accepts signed Slack `app_mention` events in one configured public
channel. It checks workspace, channel, internal-user, bot, and Slack Connect
fields, then atomically records the run and deduplication keys in Redis before
acknowledging Slack. Chat SDK processes the admitted message. An isolated,
temporary fake-worker project sends a run-authenticated canned result to the
gateway, which posts it in the originating Slack thread.

Vercel project root: `apps/gateway`. Enable source files outside the root so the
gateway can import the shared `packages/contracts` package. The Node.js `api/`
functions need no web framework. Configure the names in
[`.env.example`](.env.example) in the project environment; keep token and Redis
values secret.

The first slice does not implement Pi, OpenRouter, Sandbox, Drive, ordinary
thread follow-up, channel history, files, URLs, or controls. Runs whose dispatch
or reply outcome is uncertain keep thread ownership for manual inspection; the
gateway does not retry work or repost blindly.

Milestone 2 test deployments set `SANDBOX_WORKER_NAME` and `OPENROUTER_MODEL` to
dispatch to one prewarmed, operator-managed Sandbox. The gateway starts a
detached worker command after admission. Configure model authentication on the
Sandbox firewall. The gateway does not need the OpenRouter key. Keep this
deployment within the selected test channel and Sandbox lifetime.

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
