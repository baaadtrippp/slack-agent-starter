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
