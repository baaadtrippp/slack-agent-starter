# V1 quickstart

This is the authoritative installation path for the public v1 stack.

The completed installation uses one new Vercel gateway project, one dedicated
Upstash Redis database, one capped OpenRouter key and model, one Slack app in
one workspace and public channel, one named nonpersistent Sandbox, and one 1 GiB
Drive. Start with new isolated resources so setup, validation, and teardown
cannot affect another application.

The quickstart assumes Bash on x86_64 Linux or WSL, with Docker for the test
Redis. On macOS, replace the two toolchain script lines below with the
[macOS steps](toolchain.md#macos). Keep all private files outside the clone.
Commands that use `$SETUP_ENV` and `$WORKER_RECORD` expect absolute paths.

## 1. Prepare a clean checkout

Clone the repository and select the reviewed commit or release you intend to
deploy. Record it before provisioning resources.

```sh
git clone https://github.com/baaadtrippp/slack-agent-starter.git
cd slack-agent-starter
git rev-parse HEAD
./scripts/bootstrap-toolchain.sh
source scripts/use-toolchain.sh
pnpm install --frozen-lockfile
docker run --rm --detach \
  --name slack-agent-starter-test-redis \
  --publish 127.0.0.1:16379:6379 \
  redis@sha256:4eec4565e45aa0b3966554c866bc73211e281b0b3d89fe9a33c982e6faca809d \
  redis-server --save "" --appendonly no
TEST_REDIS_URL=redis://127.0.0.1:16379 pnpm check
docker stop slack-agent-starter-test-redis
pnpm scan:secrets
test -z "$(git status --porcelain)" && echo clean
```

`pnpm check` uses the disposable loopback Redis described in
[toolchain.md](toolchain.md). If it exits early, run the same `docker stop`
command. A clean status matters because the bootstrap binds its startup snapshot
to the committed revision and refuses tracked local changes.

## 2. Create the service resources

Use separate accounts or projects when your organization requires that boundary.
Do not reuse a Vercel project, Redis database, OpenRouter key, or Slack app that
serves another workload.

### Vercel gateway project

Create a new Vercel project with these exact settings.

| Setting          | Value          |
| ---------------- | -------------- |
| Framework preset | Other          |
| Root Directory   | `apps/gateway` |
| Node.js Version  | `26.x`         |
| Install Command  | default        |
| Build Command    | default        |
| Output Directory | default        |

The pinned CLI can create and configure it directly. Choose your own project
name and account scope.

```sh
PROJECT=your-new-gateway-project
SCOPE=your-vercel-account-or-team
pnpm exec vercel project create "$PROJECT" --scope "$SCOPE"
pnpm exec vercel project update "$PROJECT" --scope "$SCOPE" \
  --framework other \
  --root-directory apps/gateway \
  --node-version 26.x \
  --yes
pnpm exec vercel link --project "$PROJECT" --scope "$SCOPE" --yes
pnpm exec vercel project inspect "$PROJECT" --scope "$SCOPE" --json
```

Verify the readback before continuing. Copy the expected Project ID from the
Vercel project settings. Then copy the production domain that Vercel assigned
under the project's Domains settings. It is often `$PROJECT.vercel.app`, but
Vercel adds a suffix when that name is taken. Set the bare HTTPS origin, which
must keep pointing to this gateway:

```sh
GATEWAY_ORIGIN=https://your-assigned-production-domain
```

### Upstash Redis

Create a dedicated Redis database. Copy its password-bearing TLS connection URL
in `rediss://` form. The REST URL and token are not accepted by the gateway or
bootstrap. Keep automatic paid upgrades disabled if your plan offers that
control.

The application uses `slack-agent:chat-sdk` for Chat SDK state and
`slack-agent:m1` for its own records. Application run, session, message,
feedback, and managed-runtime records have no automatic retention policy.
Deleting a Slack message does not remove them.

### OpenRouter

Select one exact model slug that supports the Pi tool path. If you enable PNG
and JPEG input, verify vision with that same model. Create a new API key with an
explicit spending limit and set an account budget that can cover the smoke test.
There is no automatic provider or model fallback.

The model key is used only while the bootstrap creates the Sandbox network
policy. It is not a gateway environment variable, worker environment secret,
Drive file, or startup-snapshot file.

### Slack app shell

Create an app from scratch in the intended workspace. Use the final app and bot
display name. Add the `chat:write` bot scope and install the shell so Slack
issues a bot token. Copy the `xoxb-` bot token and the app's signing secret. The
complete v1 manifest is applied after the gateway exists.

Record the workspace ID and the ID of one ordinary public channel. The gateway
admits internal workspace members in that configured public channel and rejects
DMs, private channels, Slack Connect channels, external users, and bot messages.

## 3. Bootstrap the worker

Create private paths in durable storage outside the clone, and keep them until
cleanup has finished, because cleanup needs the same record. The setup
environment is a local mode-600 dotenv file. A separate Vercel pull provides its
short-lived OIDC token. The JSON record makes setup retryable and binds every
created resource to the checkout, Vercel project, Redis endpoint, model, region,
and gateway origin.

```sh
PRIVATE_SETUP_DIR="$HOME/.slack-agent-starter/$PROJECT"
mkdir -p "$PRIVATE_SETUP_DIR"
chmod 700 "$HOME/.slack-agent-starter" "$PRIVATE_SETUP_DIR"
OIDC_ENV="$PRIVATE_SETUP_DIR/vercel-oidc.env"
SETUP_ENV="$PRIVATE_SETUP_DIR/setup.env"
WORKER_RECORD="$PRIVATE_SETUP_DIR/worker-record.json"
pnpm exec vercel env pull "$OIDC_ENV" --environment=development --yes
chmod 600 "$OIDC_ENV"
```

Confirm that the pull came from the new linked gateway project. It supplies a
short-lived `VERCEL_OIDC_TOKEN`. With an editor, create `SETUP_ENV`, copy that
one token into it, and add the values below. Use the project ID copied from
Vercel and your own provider values. Set the finished file to mode 600.

```dotenv
VERCEL_PROJECT_ID=prj_REPLACE_ME
REDIS_URL=rediss://default:REPLACE_ME@REPLACE_ME:6379
GATEWAY_ORIGIN=https://REPLACE_ME.vercel.app
OPENROUTER_API_KEY=replace-with-scoped-openrouter-key
OPENROUTER_MODEL=provider/model-slug
SANDBOX_REGION=iad1
```

```sh
chmod 600 "$SETUP_ENV"
```

`SANDBOX_REGION` is optional and defaults to `iad1`. The Drive and both
Sandboxes use the same region with no failover regions.

Run setup from the repository root. Node lets variables already exported in the
shell override `--env-file`, so each command that reads an env file runs in a
subshell that first clears the names the file sets, such as a `REDIS_URL` from
another project. Your shell keeps its own values.

```sh
(
  unset $(grep -oE '^[A-Z_][A-Z0-9_]*' "$SETUP_ENV")
  node --env-file="$SETUP_ENV" \
    apps/gateway/scripts/bootstrap-worker.mjs setup "$WORKER_RECORD"
)
chmod 600 "$WORKER_RECORD"
```

Setup prints three nonsecret production settings.

```text
SANDBOX_WORKER_NAME=...
SANDBOX_MANAGED_DRIVE=...
SANDBOX_MANAGED_SEED=...
```

Keep the exact record and run only one setup or cleanup process at a time. A
failed or interrupted setup is retried with the same command, environment, and
record. Do not delete or edit the record to work around a mismatch. If the OIDC
token expires, pull into `OIDC_ENV` again and replace only `VERCEL_OIDC_TOKEN`
in `SETUP_ENV`. If a seed Sandbox stopped before producing a snapshot, run
cleanup with this record, then set a new `WORKER_RECORD` path, such as
`"$PRIVATE_SETUP_DIR/worker-record-2.json"`, and run setup again.

The bootstrap performs the following checks before printing settings.

- It installs exact-pinned Pi and ACP packages and the checked-in worker files
  into a credential-free startup snapshot.
- It verifies worker hashes and required PDF, privilege, process-control, and
  file-locking programs inside the Sandbox.
- It creates one 1 GiB Drive and confirms it has one writable mount at
  `/workspace`.
- It restricts egress to the gateway hostname and OpenRouter, denies private
  IPv4 ranges, and configures OpenRouter credential injection at the provider
  boundary. The paid model smoke verifies that configured path.
- It enrolls the exact initial worker session in the dedicated Redis database.

The worker uses one vCPU, a 25-minute Sandbox session timeout, and a startup
snapshot with no automatic expiry. The initially enrolled worker may remain
running until its first completed run, after which the application performs a
verified idle stop, or until the 25-minute provider timeout. The next admitted
turn resumes automatically in a fresh session from the same snapshot and Drive.

## 4. Configure and deploy the gateway

Add these Production environment variables to the new Vercel project. Values
printed by setup must be copied exactly.

| Name                        | Value or source                                                              |
| --------------------------- | ---------------------------------------------------------------------------- |
| `SLACK_BOT_TOKEN`           | Slack app `xoxb-` token                                                      |
| `SLACK_SIGNING_SECRET`      | Slack app signing secret                                                     |
| `REDIS_URL`                 | dedicated password-bearing `rediss://` URL                                   |
| `SLACK_WORKSPACE_ID`        | intended workspace ID                                                        |
| `SLACK_ENABLED_CHANNEL_IDS` | the one intended public channel ID                                           |
| `GATEWAY_ORIGIN`            | reserved bare production origin                                              |
| `SANDBOX_WORKER_NAME`       | setup output                                                                 |
| `SANDBOX_MANAGED_DRIVE`     | setup output                                                                 |
| `SANDBOX_MANAGED_SEED`      | setup output                                                                 |
| `OPENROUTER_MODEL`          | exact model slug used by setup                                               |
| `SLACK_FILE_EXCHANGE`       | `1`                                                                          |
| `SLACK_JPEG_INPUT`          | `1` after an exact-model vision check                                        |
| `SLACK_PNG_INPUT`           | `1` after an exact-model vision check                                        |
| `SLACK_PUBLIC_URL_INPUT`    | `1`                                                                          |
| `SLACK_STOP_OPERATOR_IDS`   | optional comma-separated internal user IDs allowed to stop other users' runs |

Do not set `OPENROUTER_API_KEY`, `VERCEL_OIDC_TOKEN`, or `VERCEL_PROJECT_ID` in
the gateway. Vercel supplies runtime project authentication to the Sandbox SDK.

Deploy the gateway from the clean clone.

```sh
pnpm exec vercel deploy --prod --yes --scope "$SCOPE"
pnpm exec vercel inspect "$GATEWAY_ORIGIN" --scope "$SCOPE" --json
```

Confirm that the stable origin reports `READY`, targets Production, and belongs
to the new project and expected deployment. Slack and the worker must reach this
origin without signing in to Vercel. If the project's Deployment Protection
covers production, limit it to preview deployments. Keep the deployment URL for
rollback until the Slack smoke has passed.

## 5. Apply the complete Slack manifest

Copy [`integrations/slack/v1.yaml`](../integrations/slack/v1.yaml) to a private
temporary file. Replace both `REPLACE-ME` values with the app display name and
replace `https://example.invalid` with `GATEWAY_ORIGIN`. Keep the event route
`/api/slack/events` and interaction route `/api/slack/interactions` unchanged.

In Slack app management, open **App Manifest**, validate the completed copy, and
save it to the existing app. Slack's signed URL challenge must verify the
deployed event endpoint. Confirm Slack saves the interaction request URL.
Install or reinstall the app so its bot token receives all manifest scopes. If
Slack shows a different bot token after reinstall, update `SLACK_BOT_TOKEN` in
the Vercel Production environment and redeploy.

The manifest requests these bot scopes.

- `app_mentions:read`, `channels:history`, and `chat:write`
- `channels:read` and `users:read` for admission checks
- `files:read` and `files:write` for file exchange
- `reactions:read` and `reactions:write` for acknowledgement and feedback

It subscribes to `app_mention`, `message.channels`, `reaction_added`, and
`reaction_removed`, enables signed interactivity, disables Socket Mode and org
deployment, and keeps token rotation disabled. Invite the bot only to the
configured public channel.

## 6. Run the paid installation smoke

Use synthetic text in the isolated channel. The first request must reach the
real selected OpenRouter model through Pi. Choose a marker you have never used
before.

```text
@YourAgent Remember the synthetic marker cobalt-7391 for this Slack thread. Reply with the marker and the words first turn.
```

Verify one eyes acknowledgement, one status message that reaches Completed, and
one separate answer containing the marker. In Vercel's Sandbox view, confirm the
named Sandbox from the setup output ran a session for this request. Wait for the
managed worker to stop after the verified result.

Reply in the same Slack thread without mentioning the bot and without repeating
the marker.

```text
What marker did I ask you to remember? Return a UTF-8 text file containing that marker and the words second turn.
```

Verify that the answer recalls the marker and that Slack receives one attached
text file with the same marker. In Vercel's Sandbox view, confirm the same named
Sandbox has a new session ID and that the earlier session is stopped.

From the gateway log lines with `"phase":"published"`, record the first and
second run IDs for this thread in shell variables named `FIRST_RUN_ID` and
`SECOND_RUN_ID`. Use the existing Redis store to check the two exact runs.

```sh
(
unset $(grep -oE '^[A-Z_][A-Z0-9_]*' "$SETUP_ENV")
node --env-file="$SETUP_ENV" --input-type=module - \
  "$FIRST_RUN_ID" "$SECOND_RUN_ID" <<'JS'
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { RedisRunStore } from './apps/gateway/src/store.ts';

const require = createRequire(import.meta.resolve('./apps/gateway/package.json'));
const { createClient } = require('redis');
const client = createClient({
  url: process.env.REDIS_URL,
  socket: { connectTimeout: 5000, reconnectStrategy: false },
  disableOfflineQueue: true,
});
client.on('error', () => {});
try {
  const store = new RedisRunStore(client);
  const [first, second] = await Promise.all(process.argv.slice(2).map((id) => store.getRun(id)));
  const a = first?.result?.session;
  const b = second?.result?.session;
  assert.ok(a && b && first.execution?.sessionId && second.execution?.sessionId);
  assert.ok(first.conversationId === second.conversationId, 'Conversation changed');
  assert.ok(first.execution.sessionId !== second.execution.sessionId, 'Sandbox session did not change');
  assert.ok(a.seedRunId === b.seedRunId && a.nativeId === b.nativeId && a.adapterId === b.adapterId,
    'Native session reference changed');
  assert.ok(b.revision > a.revision, 'Native session revision did not advance');
  console.log('A new Sandbox session continued the same native Pi session.');
} finally {
  if (client.isOpen) client.destroy();
}
JS
)
```

The earlier Sandbox session must remain stopped. The new session uses the same
configured Drive. Later turns do not replay the earlier Slack transcript.

This smoke spends model credit and is live Slack evidence. Local tests, manifest
validation, a Vercel build, and the bootstrap's asset checks do not replace it.

## 7. Implemented limits and retention

The current code enforces these limits.

| Area                   | Implemented behavior                                             |
| ---------------------- | ---------------------------------------------------------------- |
| Slack access           | configured workspace and one public channel only                 |
| Run ownership          | one active run per Slack thread                                  |
| Run deadline           | 60 seconds, including staging, model work, callback, and cleanup |
| Prompt                 | 12,000 characters                                                |
| Initial thread context | up to 20 earlier messages, 2 KiB each and 16 KiB total           |
| Inputs                 | up to 5 Slack files plus 1 public URL per turn, 16 KiB each      |
| Retained inputs        | up to 12 sources in one native session                           |
| Generated result       | one UTF-8 file up to 16 KiB plus the text answer                 |
| Shared notes           | 16 notes per channel, 512 UTF-8 bytes per note                   |
| Worker resources       | one shared 1-vCPU Sandbox session and one 1 GiB Drive            |

There is no separate workspace-wide Pi process cap in the gateway. Concurrent
threads share that one-vCPU Sandbox and Drive. Broader command execution and a
permanent production rollout policy remain outside this packaging path.

Native Pi sessions, per-run work and result manifests, retained inputs, and
shared notes persist on the Drive. Redis run, message, conversation, feedback,
and managed-runtime records persist without an application TTL. The named
Sandbox is nonpersistent, so its local filesystem does not carry between
sessions. The credential-free startup snapshot has no automatic expiry and is
retained until cleanup. Slack message deletion does not delete Drive or Redis
data. The Drive is durable working storage rather than a backup.

## 8. Rollback and teardown

To roll back a bad gateway deployment, point the stable Vercel origin to the
previous known-good deployment or redeploy that exact commit. Keep the matching
worker snapshot and Drive until accepted work is terminal and the rollback has
been checked. A gateway and worker built from different revisions are not a
supported steady state.

For complete teardown, first disable Slack Event Subscriptions so no new run
starts. Keep Interactivity enabled and the app installed until every status
message in the channel shows a final state; press Status on any that stay
unfinished to recover them. A run whose status post failed has no message, so
also wait until Vercel's Sandbox view shows no running session for the named
worker Sandbox.

Cleanup permanently removes all native sessions, work, results, retained inputs,
and shared notes on the Drive. Export anything that must be kept before you
continue.

Then disable Interactivity and run the destructive cleanup with the same private
record and a fresh OIDC token for the same Vercel project. From the clone, in a
new shell, restore the paths from section 3. Use the newer record path if setup
was retried.

```sh
source scripts/use-toolchain.sh
PROJECT=your-new-gateway-project
PRIVATE_SETUP_DIR="$HOME/.slack-agent-starter/$PROJECT"
WORKER_RECORD="$PRIVATE_SETUP_DIR/worker-record.json"
CLEANUP_OIDC_ENV="$PRIVATE_SETUP_DIR/cleanup-oidc.env"
CLEANUP_ENV="$PRIVATE_SETUP_DIR/cleanup.env"
pnpm exec vercel env pull "$CLEANUP_OIDC_ENV" \
  --environment=development --yes
chmod 600 "$CLEANUP_OIDC_ENV"
```

With an editor, create `CLEANUP_ENV`, copy `VERCEL_OIDC_TOKEN` into it, and add
only the same `VERCEL_PROJECT_ID` used for setup. Then run cleanup:

```sh
chmod 600 "$CLEANUP_ENV"
(
  unset $(grep -oE '^[A-Z_][A-Z0-9_]*' "$CLEANUP_ENV")
  node --env-file="$CLEANUP_ENV" \
    apps/gateway/scripts/bootstrap-worker.mjs cleanup "$WORKER_RECORD"
)
```

Cleanup verifies removal of the recorded worker Sandbox, seed Sandbox, startup
snapshot, and Drive. Cleanup marks the worker record retired before deletion, so
any later setup must use a new worker record path.

Remove the gateway deployment or project, revoke the OpenRouter key, uninstall
the Slack app, and delete the dedicated Redis database. Deleting the Redis
database is what removes retained gateway metadata. Finally delete the private
setup environment and worker record. Keep only sanitized results that identify
the deployed Git revision and state which checks actually ran.
