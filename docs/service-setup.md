# Service setup

This guide provisions the services selected by the
[v1 specification](spec/v1.md). Check current provider plan limits before
creating resources. Use dedicated project resources, keep automatic paid
upgrades disabled, and never reuse an unrelated project or database.

Do not commit provider tokens, downloaded environment files, Slack credentials,
Pi authentication state, sessions, shared memory, or Drive contents.

## 1. Vercel project

Create a dedicated Vercel project for this repository and link the local
checkout with the pinned CLI:

```text
pnpm exec vercel link
```

Keep `.vercel/` ignored. If development environment values are needed locally,
pull them only into an ignored environment file.

The gateway deploys to Vercel Functions. Do not deploy a placeholder Slack
handler solely to create a deployment; the first gateway tracer bullet should
create the first executable endpoint.

## 2. Vercel Sandbox and Drive

Create one persistent Drive for worker sessions, per-thread workspaces, results,
and shared memory. A Drive has one read-write sandbox mount at a time, and the
sandbox must run in the Drive's region. Other sandboxes may use read-only
snapshots, but the v1 worker architecture uses one active writer sandbox.

Use a size supported by the selected plan and leave capacity headroom. The
following infrastructure-only smoke check creates or reuses a Drive, mounts it
in a temporary sandbox, writes and removes one test file, and stops the sandbox:

```text
pnpm exec vercel sandbox drives get-or-create <drive-name> --max-size <size> --region <region>
pnpm exec vercel sandbox run --mount <drive-name>:/workspace --region <region> --network-policy deny-all --stop -- sh -lc "trap 'rm -f /workspace/service-check' EXIT; printf ready > /workspace/service-check; test -s /workspace/service-check"
```

After the command, confirm the sandbox stopped, the Drive is detached, and the
temporary file is absent. This check must not install Pi or start the
application worker.

References: [Vercel Sandbox](https://vercel.com/docs/sandbox),
[Drives](https://vercel.com/docs/sandbox/concepts/drives), and
[pricing and quotas](https://vercel.com/docs/sandbox/pricing).

## 3. Upstash Redis

Create one dedicated Redis database in a region suitable for the gateway. Keep
it on the intended plan and disable automatic upgrades where the provider offers
that control.

Chat SDK's official `@chat-adapter/state-redis` adapter uses the official Redis
client. Configure its TLS Redis connection URL as `REDIS_URL` in the gateway's
Vercel environment. Upstash REST credentials used by management tools do not
satisfy this adapter contract by themselves.

Reserve the Chat SDK key prefix for adapter state and a separate prefix for
application records such as conversation mappings, run ownership, callback
deduplication, and runtime coordination.

To verify the database without retaining test data:

1. connect using a secure local or provider tool;
2. write a uniquely namespaced temporary key with a short TTL;
3. read the value back;
4. delete the key;
5. confirm the key no longer exists.

Never print or record the connection URL in logs or documentation.

References: [Upstash Redis](https://upstash.com/docs/redis) and
[Chat SDK Redis adapter](https://chat-sdk.dev/adapters/official/redis).

## 4. Slack app

The files under `integrations/slack/` separate the base manifest from behavior
that remains proposed in the specification. Resolve the relevant open decisions
in the spec before merging proposed scopes or events into the app manifest.

An optional blank app shell may be created before the gateway exists. It needs
only an app display name and target workspace; leave it uninstalled, with event
subscriptions and interactivity unconfigured. Follow
[Create an app shell](../integrations/slack/README.md#create-an-app-shell) for
that limited step.

After a real gateway endpoint exists, complete the app configuration:

1. resolve the enabled/test channel and proposed-behavior decisions linked from
   the specification;
2. replace the manifest placeholders with the app identity and deployed HTTPS
   gateway routes;
3. validate the complete manifest with Slack's official manifest API or
   supported CLI;
4. apply the validated manifest to the app shell, or create the complete app if
   no shell exists;
5. install the completed app, and reinstall it after scope or event-subscription
   changes;
6. keep the bot invited only to channels enabled for the application.

The base manifest uses scopes for mentions, thread continuation, files, replies,
and progress reactions. The proposed overlay adds feedback reaction events and
interactive controls. Runtime configuration must enforce the workspace and
channel allowlists and ignore bot-originated messages.

Request-URL verification and live event delivery require a real gateway
endpoint. Record those as live application evidence rather than treating
manifest validation as an end-to-end test.

References:
[Slack app manifests](https://docs.slack.dev/reference/app-manifest/),
[manifest validation](https://docs.slack.dev/reference/methods/apps.manifest.validate/),
and [working with files](https://docs.slack.dev/messaging/working-with-files/).

## 5. OpenRouter and Pi integration

Select the OpenRouter model and budget cap required by the specification before
running a live model test. Store `OPENROUTER_API_KEY` only in secure provider
configuration or an ignored local environment file, and inject it only into the
worker process. Do not persist interactive Pi login state or an `auth.json` file
on the Drive.

Before the real-worker tracer bullet, exact-pin compatible versions of acpx,
pi-acp, and Pi. Run a focused compatibility check for:

- custom system prompt and tool selection;
- OpenRouter model selection;
- text, file, and image input through the actual adapter path;
- native session save and exact-session resume;
- two independent sessions;
- cancellation of one run without stopping another.

The compatibility check is evidence for the selected integration path, not proof
of Slack delivery, Drive replacement, or the complete application flow. Consider
a direct Pi RPC adapter only if the preferred existing ACP route fails a
required capability.

References: [acpx](https://acpx.sh/),
[acpx sessions](https://acpx.sh/sessions.html),
[Pi sessions](https://pi.dev/docs/latest/sessions), and
[Pi providers](https://pi.dev/docs/latest/providers).

## 6. Optional repository review app

If an automated review app is used, install it only for this repository and
treat it as a review aid. It does not replace CI, acceptance checks, or human
review. Verify current public-repository terms before installation and do not
add repository configuration until an observed review need justifies it.
