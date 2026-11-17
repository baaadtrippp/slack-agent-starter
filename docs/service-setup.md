# Quickstart

The completed installation uses one new Vercel gateway project, one dedicated
Upstash Redis database, one capped OpenRouter key and model, one Slack app in
one workspace and public channel, one named nonpersistent Sandbox, and one 1 GiB
Drive. Start with new isolated resources so setup, validation, and teardown
cannot affect another application.

The quickstart assumes Bash on x86_64 Linux or WSL. On macOS, replace the two
toolchain script lines below with the [macOS steps](toolchain.md#macos). Run
every command from the repository root in one shell. In a new shell, run
`source scripts/use-toolchain.sh` and set the variables from earlier sections
again. Keep all private files outside the clone.

## 1. Prepare a clean checkout

Fork the repository on GitHub, or clone it and push it to your own repository.
Then clone your copy.

```sh
git clone https://github.com/YOUR-ACCOUNT/YOUR-REPOSITORY.git
cd YOUR-REPOSITORY
./scripts/bootstrap-toolchain.sh
source scripts/use-toolchain.sh
pnpm install --frozen-lockfile
test -z "$(git status --porcelain)" && echo clean
```

If you already know what the agent is for, edit its instructions now, as
[Make it your agent](make-it-your-agent.md) describes, and commit the change.
Setup copies the committed worker files into the worker and refuses uncommitted
changes to tracked files. Changing those files later needs a new worker with a
new, empty Drive.

Run the checks before you deploy a commit that changes code. They need Docker
for a disposable local Redis, described in [toolchain.md](toolchain.md#checks).

```sh
docker run --rm --detach \
  --name slack-agent-starter-test-redis \
  --publish 127.0.0.1:16379:6379 \
  redis@sha256:4eec4565e45aa0b3966554c866bc73211e281b0b3d89fe9a33c982e6faca809d \
  redis-server --save "" --appendonly no &&
  { TEST_REDIS_URL=redis://127.0.0.1:16379 pnpm check
    docker stop slack-agent-starter-test-redis; }
pnpm scan:secrets
```

If `docker run` fails because the name or port is in use, another checkout or an
earlier run still has a test Redis up; the block then runs no checks and leaves
that container alone. If nothing else uses it, stop it with the same
`docker stop` command and run the block again. If you interrupt the checks, run
that `docker stop` command too.

## 2. Create the service resources

### Vercel gateway project

The pinned CLI creates the project with Root Directory `apps/gateway`, Node.js
`26.x`, and the framework preset Other. Choose your own project name. For the
scope, use the `id` column that `vercel teams ls` prints.

```sh
pnpm exec vercel login
pnpm exec vercel teams ls
PROJECT=your-new-gateway-project
SCOPE=your-team-id
pnpm exec vercel project create "$PROJECT" --scope "$SCOPE"
pnpm exec vercel project update "$PROJECT" --scope "$SCOPE" \
  --framework other \
  --root-directory apps/gateway \
  --node-version 26.x \
  --yes
pnpm exec vercel link --project "$PROJECT" --scope "$SCOPE" --yes
rm -f .env.local
pnpm exec vercel project inspect "$PROJECT" --scope "$SCOPE" --json
```

`vercel link` also saves a short-lived Vercel OIDC token to `.env.local` in the
clone. Git ignores that file and nothing here uses it, so the block deletes it.
In the `inspect` output, `framework: null` means Other. Copy its `id`, the
project ID for section 3.

Vercel assigns the production domain when it creates the project. It is often
`$PROJECT.vercel.app`, but Vercel adds a suffix when that name is taken; the
project's Domains settings show it, and so does
`pnpm exec vercel api "/v9/projects/$PROJECT/domains" --scope "$SCOPE"`. Set the
bare HTTPS origin, which must keep pointing to this gateway:

```sh
GATEWAY_ORIGIN=https://your-assigned-production-domain
```

### Upstash Redis

In the [Upstash console](https://console.upstash.com), create a Redis database
for this app only, in `us-east-1`, near the default Sandbox region `iad1`. The
free plan allows one database per account, so if you already have one, use
another account or pay for a second; delete the existing one only if nothing
needs its data. Under **Connect**, choose **TCP** and click the eye icon. Copy
only the URL that starts with `rediss://` and contains the password, without the
`REDIS_URL="…"` around it. The REST URL and token are not accepted by the
gateway or bootstrap. Keep automatic paid upgrades disabled if your plan offers
that control.

### OpenRouter

Create an API key with an explicit spending limit; setup accepts only a key of
the form `sk-or-v1-…`. Choose a model that supports tool calls.
`google/gemini-3.1-flash-lite` was the model used for the live Slack checks in
November 2026 (text answers, tool calls, a generated file). If you will turn on
PNG or JPEG input, check separately that your model reads images. Slack files
may be at most 16 KiB each by default, and PNG or JPEG images 2 MiB
([Change the limits](make-it-your-agent.md#change-the-limits)). Set an account
budget that covers the Slack test in section 6.

Setup writes the key into the worker Sandbox's firewall rule, which adds it to
the worker's requests to OpenRouter. The gateway, the worker's environment, the
Drive, and the startup snapshot never hold it, but revoking it stops the
worker's model calls.

### Slack app shell

At <https://api.slack.com/apps>, create an app **From scratch** with **Pick
features**: enter a final app name that no other app in the workspace uses, and
your workspace, add only the `chat:write` bot scope, skip events, and choose
**Create and Install**. The complete manifest is applied after the gateway
exists. Section 4 needs two values, which you can copy again later: the **Bot
User OAuth Token** (`xoxb-…`) under **OAuth & Permissions**, and the **Signing
Secret** under **Basic Information**.

Create a new public channel for the agent. Open it in Slack in a browser: the
address ends in `/client/T…/C…`, where `T…` is the workspace ID and `C…` the
channel ID. The gateway admits internal workspace members in that channel and
ignores DMs, private channels, Slack Connect channels, external users, and bot
messages.

## 3. Bootstrap the worker

Setup builds the worker from your commit. The
[worker README](../apps/worker/README.md) lists what it installs and checks.

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
test -e "$SETUP_ENV" || (umask 077 &&
  { grep -v '^VERCEL_OIDC_TOKEN=' .env.example; grep '^VERCEL_OIDC_TOKEN=' "$OIDC_ENV"; } >"$SETUP_ENV")
```

The last line creates `SETUP_ENV` from `.env.example` with the pulled token. In
an editor, fill in the other values: the project `id` and `GATEWAY_ORIGIN` from
section 2, and your own provider values. Setup accepts the example origin, but a
worker built with it cannot reach your gateway.

```dotenv
VERCEL_PROJECT_ID=prj_REPLACE_ME
REDIS_URL=rediss://default:REPLACE_ME@REPLACE_ME:6379
GATEWAY_ORIGIN=https://REPLACE_ME.vercel.app
OPENROUTER_API_KEY=replace-with-scoped-openrouter-key
OPENROUTER_MODEL=provider/model-slug
SANDBOX_REGION=iad1
```

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
```

Setup prints three nonsecret production settings. `SANDBOX_MANAGED_SEED` is the
startup snapshot ID. Keep them with the record: section 4 needs all three, and a
later worker change needs this worker's name.

```text
SANDBOX_WORKER_NAME=...
SANDBOX_MANAGED_DRIVE=...
SANDBOX_MANAGED_SEED=...
```

If setup fails, it says why. Run one setup or cleanup at a time, never edit or
delete the record, and retry with the same command and record.

- If it asks for a current OIDC token, refresh the token in `SETUP_ENV`:

  ```sh
  pnpm exec vercel env pull "$OIDC_ENV" --environment=development --yes
  (umask 077 && { grep -v '^VERCEL_OIDC_TOKEN=' "$SETUP_ENV"; grep '^VERCEL_OIDC_TOKEN=' "$OIDC_ENV"; } >"$SETUP_ENV.new") &&
    mv "$SETUP_ENV.new" "$SETUP_ENV"
  ```

- If it says the record belongs to a different checkout, project, or
  configuration, the commit or a value in `SETUP_ENV` changed. Restore it, or
  clean up.
- If the seed Sandbox stopped without a snapshot, clean up.

To clean up, run the last block of [section 8](#8-rollback-and-teardown) with
this record. Then set a new `WORKER_RECORD` path, such as
`"$PRIVATE_SETUP_DIR/worker-record-2.json"` (`-3` on a later retry), and run
setup again.

## 4. Configure and deploy the gateway

Add these Production environment variables to the new Vercel project.
`apps/gateway/.env.example` lists the same names with comments.

| Name                        | Value or source                                                              |
| --------------------------- | ---------------------------------------------------------------------------- |
| `SLACK_BOT_TOKEN`           | Slack app `xoxb-` token                                                      |
| `SLACK_SIGNING_SECRET`      | Slack app signing secret                                                     |
| `REDIS_URL`                 | dedicated password-bearing `rediss://` URL                                   |
| `SLACK_WORKSPACE_ID`        | intended workspace ID                                                        |
| `SLACK_ENABLED_CHANNEL_IDS` | the one intended public channel ID; a comma-separated list is untested       |
| `GATEWAY_ORIGIN`            | reserved bare production origin                                              |
| `SANDBOX_WORKER_NAME`       | setup output, added with the loop below                                      |
| `SANDBOX_MANAGED_DRIVE`     | setup output, added with the loop below                                      |
| `SANDBOX_MANAGED_SEED`      | setup output, added with the loop below                                      |
| `OPENROUTER_MODEL`          | the model slug in `SETUP_ENV`                                                |
| `SLACK_FILE_EXCHANGE`       | `1`                                                                          |
| `SLACK_JPEG_INPUT`          | optional, `1` once you know the model reads images                           |
| `SLACK_PNG_INPUT`           | optional, `1` once you know the model reads images                           |
| `SLACK_PUBLIC_URL_INPUT`    | `1`                                                                          |
| `SLACK_STOP_OPERATOR_IDS`   | optional comma-separated internal user IDs allowed to stop other users' runs |

Do not set `OPENROUTER_API_KEY`, `VERCEL_OIDC_TOKEN`, or `VERCEL_PROJECT_ID` in
the gateway. Vercel supplies runtime project authentication to the Sandbox SDK.

Add the variables with these loops; each `add` prompts for its value. The first
loop stores the credentials as Secrets. The second stores the rest as Config
values. `vercel env list` shows their values encrypted; to see which worker the
next deployment will use, open the project's Environment Variables settings in
the dashboard. Add an optional variable the same way. If a loop stops, run it
again with only the names still missing. `add` fails on a name that exists; to
change one later, run
`pnpm exec vercel env update NAME --environment production --scope "$SCOPE"` and
deploy again.

```sh
for NAME in SLACK_BOT_TOKEN SLACK_SIGNING_SECRET REDIS_URL; do
  pnpm exec vercel env add "$NAME" --environment production --sensitive --scope "$SCOPE" || break
done
for NAME in SLACK_WORKSPACE_ID SLACK_ENABLED_CHANNEL_IDS GATEWAY_ORIGIN OPENROUTER_MODEL \
  SANDBOX_WORKER_NAME SANDBOX_MANAGED_DRIVE SANDBOX_MANAGED_SEED \
  SLACK_FILE_EXCHANGE SLACK_PUBLIC_URL_INPUT; do
  pnpm exec vercel env add "$NAME" --environment production --no-sensitive --scope "$SCOPE" || break
done
pnpm exec vercel env list --environment production --scope "$SCOPE"
```

The list must show every name you added. Only the four switches set to `1` and
`SLACK_STOP_OPERATOR_IDS` are optional. If another one is missing or invalid,
the gateway answers every request with status 503 and logs only
`"category":"gateway_unavailable"`, without the name.

Deploy the gateway from the clean clone after the variables are set. A
deployment keeps the environment variables it was built with, so never promote a
deployment built before a settings change, such as one built from a Git push.

```sh
DEPLOYMENT_URL=$(pnpm exec vercel deploy --prod --yes --scope "$SCOPE")
pnpm exec vercel inspect "$DEPLOYMENT_URL" --scope "$SCOPE" --json
pnpm exec vercel inspect "$GATEWAY_ORIGIN" --scope "$SCOPE" --json
```

In a coding agent's shell, `vercel deploy` may print JSON instead of the bare
URL; then set `DEPLOYMENT_URL` to its `deployment.url`.

The new deployment must report `readyState` `READY` and `target` `production`;
if it does not, fix the build ([Troubleshooting](#7-troubleshooting)) and deploy
again. The origin must then report the same `id` and your project as `name`. If
the origin still reports an older `id`, the project does not assign production
domains automatically, as happens after an Instant Rollback. Promote the new
deployment and inspect the origin again.

```sh
pnpm exec vercel promote "$DEPLOYMENT_URL" --scope "$SCOPE"
pnpm exec vercel inspect "$GATEWAY_ORIGIN" --scope "$SCOPE" --json
```

Slack and the worker must reach this origin without signing in to Vercel. If the
project's Deployment Protection covers production, limit it to preview
deployments. To check, send an unsigned request:

```sh
curl -sS -w '%{http_code}\n' -X POST "$GATEWAY_ORIGIN/api/slack/events"
```

A bare `401` is the gateway's own answer: the origin is public and every setting
loaded. Text before the `401`, such as `Protected deployment`, comes from
Vercel's protection, which then covers production. `503` means a variable is
missing or invalid.

## 5. Apply the complete Slack manifest

Copy [`integrations/slack/manifest.yaml`](../integrations/slack/manifest.yaml)
to a private temporary file. Replace both `REPLACE-ME` values with the app
display name and replace `https://example.invalid` with `GATEWAY_ORIGIN`. Keep
the event route `/api/slack/events` and interaction route
`/api/slack/interactions` unchanged.

In Slack app management, open **App Manifest**, paste the completed copy into
the YAML tab, and save it to the existing app. If Slack then shows the request
URL as not verified, click **Click here to verify**. Slack's signed URL
challenge must verify the deployed event endpoint; if it fails, see
[Troubleshooting](#7-troubleshooting). Confirm Slack saves the interaction
request URL. Install or reinstall the app (**Install App** → **Reinstall to**
your workspace) so its bot token receives all manifest scopes. If Slack shows a
different bot token after reinstall, update `SLACK_BOT_TOKEN` with
`vercel env update` as in section 4 and deploy again.

Then post `/invite @YourAgent` in the channel. Invite the bot to no other
channel.

To rename the bot after installing it, edit the bot user in your workspace's app
management page (**Manage apps** → the app → **Configuration** → **Bot User** →
**Edit**). The manifest, App Home, and reinstalling do not rename an installed
bot. After a rename, check that the bot is still in the channel and `/invite` it
again if not.

## 6. Test it in Slack

This end-to-end test spends model credit. Use synthetic text and a marker you
have never used before.

```text
@YourAgent Remember the synthetic marker cobalt-7391 for this Slack thread. Reply with the marker and the words first turn.
```

Verify one eyes acknowledgement, one status message that reaches Completed, and
one separate answer containing the marker. In Vercel's Sandbox view, or with
this command, confirm the named Sandbox from the setup output ran a session for
this request. Wait for the managed worker to stop after the verified result.

```sh
pnpm exec vercel sandbox sessions list your-sandbox-worker-name --all --project "$PROJECT" --scope "$SCOPE"
```

Reply in the same Slack thread without mentioning the bot and without repeating
the marker.

```text
What marker did I ask you to remember? Return a UTF-8 text file containing that marker and the words second turn.
```

Verify that the answer recalls the marker and that Slack receives one attached
text file with the same marker. In Vercel's Sandbox view, or with the same
command, confirm the same named Sandbox has a new session ID and that the
earlier session is stopped.

## 7. Troubleshooting

The gateway logs JSON lines with a `phase` and, for a run, its `runId`. Read
them in the project's **Logs** tab in the Vercel dashboard, or with the first
command. The second lists each request's status code and path.

```sh
pnpm exec vercel logs --environment production --since 30m --scope "$SCOPE"
pnpm exec vercel logs requests --environment production --since 30m --scope "$SCOPE"
```

**The bot does not react at all.** The gateway answers with status 200 and logs
nothing for events from another workspace or channel, from bots or external
users, from DMs, private, or Slack Connect channels, and for messages over
12,000 characters. Check that the bot is in the channel, that
`SLACK_WORKSPACE_ID` and `SLACK_ENABLED_CHANNEL_IDS` hold the `T…` and `C…` IDs
from the channel's address, and that Slack shows the Event Subscriptions request
URL as verified. Change a variable with `vercel env update` as in section 4,
then deploy again.

**Slack cannot verify the request URL.** Find the request to `/api/slack/events`
in the request list.

- Status 503 with `{"phase":"events","category":"gateway_unavailable"}`: a
  variable from section 4 is missing or invalid, such as a `GATEWAY_ORIGIN` with
  a path or a channel ID that does not start with `C`.
- Status 401: `SLACK_SIGNING_SECRET` is not the app's signing secret.
- No request: check the manifest's URL and the Deployment Protection setting.

**The bot replies “The worker is unavailable…”.** The gateway could not get a
running session of the worker Sandbox. Check that the three `SANDBOX_*` values
match the setup output of the worker you use, then mention the bot again. The
[gateway README](../apps/gateway/README.md) explains how it restarts the worker.

**The deployment fails.** Read its build log, fix the error, and deploy again.

```sh
pnpm exec vercel inspect "$DEPLOYMENT_URL" --logs --scope "$SCOPE"
```

## 8. Rollback and teardown

To roll back a bad gateway deployment, point the stable Vercel origin to the
previous known-good deployment or redeploy that exact commit. A redeploy uses
the current worker settings, so first restore the three `SANDBOX_*` values of
the worker that deployment used. Keep the matching worker snapshot and Drive
until accepted work is terminal and the rollback has been checked. A gateway and
worker built from different revisions are not a supported steady state. The
exception is a gateway from a later commit that changes only values in
`packages/contracts/src/limits.ts`; see
[Change the limits](make-it-your-agent.md#change-the-limits).

After a [worker change](make-it-your-agent.md#apply-worker-changes), keep the
previous worker until the new deployment has been checked, because the previous
deployment still uses it. Once that worker has been cleaned up, a rollback needs
a new worker with a new, empty Drive: check out the previous commit, run setup
from [section 3](#3-bootstrap-the-worker) with a new `WORKER_RECORD` path,
replace the three settings, and deploy. To restore or replace the three
settings, follow step 3 of
[Apply worker changes](make-it-your-agent.md#apply-worker-changes).

For complete teardown, first disable Slack Event Subscriptions so no new run
starts. Keep Interactivity enabled and the app installed until every status
message in the channel shows a final state; press Status on any that stay
unfinished to recover them. A run whose status post failed has no message, so
also wait until Vercel's Sandbox view, or the command in
[section 6](#6-test-it-in-slack), shows no running session for the named worker
Sandbox.

Cleanup permanently removes all native sessions, work, results, retained inputs,
and shared notes on the Drive. Export anything that must be kept before you
continue.

Then disable Interactivity. In a new shell at the repository root, restore the
paths and refresh the token:

```sh
source scripts/use-toolchain.sh
PROJECT=your-new-gateway-project
PRIVATE_SETUP_DIR="$HOME/.slack-agent-starter/$PROJECT"
OIDC_ENV="$PRIVATE_SETUP_DIR/vercel-oidc.env"
SETUP_ENV="$PRIVATE_SETUP_DIR/setup.env"
pnpm exec vercel env pull "$OIDC_ENV" --environment=development --yes
(umask 077 && { grep -v '^VERCEL_OIDC_TOKEN=' "$SETUP_ENV"; grep '^VERCEL_OIDC_TOKEN=' "$OIDC_ENV"; } >"$SETUP_ENV.new") &&
  mv "$SETUP_ENV.new" "$SETUP_ENV"
```

Run the next two blocks once for each record whose cleanup has not finished: the
last one setup used (`worker-record.json`, or `-2` after a retry), and any
earlier worker kept for a rollback. Check the `prefix` first, because a record
already cleaned up still reports removal. The worker in use has the record whose
`prefix` begins the `SANDBOX_WORKER_NAME` value in the Environment Variables
settings.

```sh
WORKER_RECORD="$PRIVATE_SETUP_DIR/worker-record.json"
grep -o '"prefix":"[^"]*"' "$WORKER_RECORD"
```

Then run cleanup:

```sh
(
  unset $(grep -oE '^[A-Z_][A-Z0-9_]*' "$SETUP_ENV")
  node --env-file="$SETUP_ENV" \
    apps/gateway/scripts/bootstrap-worker.mjs cleanup "$WORKER_RECORD"
)
```

Cleanup verifies removal of the recorded worker Sandbox, seed Sandbox, startup
snapshot, and Drive. Cleanup marks the worker record retired before deletion, so
any later setup must use a new worker record path.

Remove the gateway project, revoke the OpenRouter key, uninstall the Slack app,
and delete the dedicated Redis database, which removes the gateway's stored
records. Once every record is cleaned up, delete the private setup directory.
