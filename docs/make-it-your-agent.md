# Make it your agent

Slack agent starter ships a generic Slack assistant. This guide covers the first
changes most forks make: its instructions, its model, its tools, and its limits.
It assumes an installation from the [quickstart](service-setup.md).

## Change the instructions

Edit
[`apps/worker/sandbox/instructions.md`](../apps/worker/sandbox/instructions.md).
The worker starts Pi with `--append-system-prompt` and the absolute path of this
file, for new and resumed sessions alike. Pi's discovery of `AGENTS.md`, skills,
extensions, and MCP servers stays off, so this file is the one place for agent
instructions. The file is required: bootstrap stops while checking inputs if it
is missing. An empty file adds nothing to the prompt.

Pi's own default prompt stays in front of the file and describes a coding
assistant that runs commands and edits code. Describe what the agent is for and
how it should answer, and state what it can and cannot really do, as the default
file does for the shell. Otherwise the model will promise things it cannot do.
The file is part of the worker snapshot, so
[apply the change](#apply-worker-changes) as described below.

## Change the model

The gateway passes `OPENROUTER_MODEL` to the worker on every run. Choose an
OpenRouter model that supports tool calls, and image input if you set
`SLACK_PNG_INPUT` or `SLACK_JPEG_INPUT`. Set the new slug in the gateway's
Production environment and deploy the gateway again, as in
[quickstart section 4](service-setup.md#4-configure-and-deploy-the-gateway). The
worker does not need a rebuild for this. The command prompts for the slug:

```sh
source scripts/use-toolchain.sh
pnpm exec vercel env update OPENROUTER_MODEL --environment production
```

Also set the slug in `SETUP_ENV`: the worker check's paid run reads it there,
and setup refuses a worker record made with another slug, so finish any setup
retry first.

## Add a tool

Tools are Pi extensions that the worker writes for each run. `write_artifact` in
[`apps/worker/sandbox/run.mjs`](../apps/worker/sandbox/run.mjs) is the example
to copy; `read_input` (`readStagedInputExtension`) is a shorter one:

1. `writeArtifactExtension(byteLimit)` returns the extension source, with the
   job's generated-file limit written in. Its default export calls
   `pi.registerTool` with a name, a description for the model, TypeBox
   parameters, and an `execute` function that returns the tool result.
2. In `prompt()`, the run writes that source to its scratch directory, adds an
   `--extension` option for the file to `extensions`, and adds the tool name to
   `tools`, which becomes Pi's `--tools` list. Pi offers the model only the
   tools that `--tools` names, so Pi's built-in tools stay off.
3. Values the tool needs at run time go into `agentProcessEnv`, as
   `WORKER_RESULTS` does for `write_artifact`.

Add your extension the same way. A tool runs in the worker Sandbox within the
60-second run deadline; treat everything it reads as untrusted data. Then:

- **Tell the model.** Describe the tool in `instructions.md`, and drop any line
  there that says the agent cannot do what the tool does.
- **Network access.** The worker can reach only the gateway origin and
  `openrouter.ai`. For an API, add its host to `toolApis` at the top of
  [`bootstrap-worker.mjs`](../apps/gateway/scripts/bootstrap-worker.mjs), and
  call it over HTTPS.
- **API keys.** Never put a key in the job, the worker's environment, or a file
  it can read. In the host's `toolApis` entry, name the header and a `SETUP_ENV`
  variable that holds its whole value: the Sandbox firewall adds the header to
  requests to that host. A changed key needs a
  [new worker](#apply-worker-changes).
- **npm packages.** A tool cannot import an npm package yet
  ([#49](https://github.com/baaadtrippp/slack-agent-starter/issues/49)), except
  those Pi provides to extensions, such as `typebox`. Use Node built-ins such as
  `fetch`.
- **Worker check.** The stand-in model in
  [`check-worker-fixture.mjs`](../apps/gateway/scripts/check-worker-fixture.mjs)
  compares the tool names with two fixed lists (`assert.deepEqual`, in order;
  they follow the `tools` order in `prompt()`). Add yours at the same position
  in each list whose run offers it. It never calls your tool: test it in Slack.

Then [apply the change](#apply-worker-changes).

## Change the limits

The content limits are defaults in
[`packages/contracts/src/limits.ts`](../packages/contracts/src/limits.ts), one
name per purpose: Slack files, public links, generated files, PDF text, thread
context, answers, and shared notes. Edit a value there, run the checks, and
deploy the gateway from the new commit, as in
[quickstart section 4](service-setup.md#4-configure-and-deploy-the-gateway). The
gateway sends the limits with every job and the worker enforces the values it
receives, so a changed value needs no new worker. Replies and the
`write_artifact` tool description show the new values. Tests that check a reply
text expect the defaults; update them with your values. Two limits have fixed
bounds, noted beside them in the file: `answerChars` must fit 32 KiB message
bodies, and `sourcesPerThread` must fit the worker's 16 KiB source catalog.

`RUN_DURATION_MS` in the same file sets the 60-second run time, which also needs
only a gateway deploy. The gateway's Vercel Function waits for each run in the
background (`waitUntil`), and the repository sets no `maxDuration`, so Vercel's
default function duration for your plan applies. Check it before you raise the
run time.

Adding, renaming, or removing a limit changes the job shape. Then the worker and
the gateway must come from the same commit:
[apply the change](#apply-worker-changes) as for any worker change.

Two related values live elsewhere. The image edge limit of 1,024 pixels is in
[`apps/gateway/src/slack-file.ts`](../apps/gateway/src/slack-file.ts). The
instructions file tells the model that answers are cut after 4,000 characters;
change that line with `answerChars`, which needs a new worker. The model writes
a generated file as tool-call output within the 60-second run, so the run time
can stop a large file before its limit does.

## Why the agent has no shell

Every thread's Pi process runs in the same Sandbox as the same user, with the
same Drive mounted at `/workspace`. That Drive holds every thread's sessions,
inputs, and results, and the shared channel notes. A shell, or a tool that opens
arbitrary paths, would let one thread read or change another thread's data, and
a working directory or prompt is not a security boundary. So the tools only read
the inputs staged for the run and write one result file. Running commands is
deferred until it has its own design (see
[section 8 of the spec](spec/specification.md#8-deferred)).

## Apply worker changes

Bootstrap copies the worker files from the committed revision into the startup
snapshot, and the worker record is bound to that commit. Before the first setup,
committing the change is enough. On a running installation, a changed worker
needs a new worker, and the gateway must be deployed from the same commit. So
does a new OpenRouter or tool API key, which setup writes into the worker's
firewall rule.

1. Commit any code change and run the checks from
   [quickstart section 1](service-setup.md#1-prepare-a-clean-checkout). If the
   Vercel project is connected to Git, push the commit to the production branch
   only after step 3: a build from an earlier push goes live with the old worker
   settings.
2. In a new shell at the repository root, set your values from the quickstart
   and refresh the short-lived OIDC token in `SETUP_ENV`; setup and cleanup
   reject an expired one. Run this first block again in a new shell.

   ```sh
   source scripts/use-toolchain.sh
   PROJECT=your-gateway-project
   SCOPE=your-vercel-account-or-team
   GATEWAY_ORIGIN=https://your-assigned-production-domain
   PRIVATE_SETUP_DIR="$HOME/.slack-agent-starter/$PROJECT"
   OIDC_ENV="$PRIVATE_SETUP_DIR/vercel-oidc.env"
   SETUP_ENV="$PRIVATE_SETUP_DIR/setup.env"
   pnpm exec vercel env pull "$OIDC_ENV" --environment=development --yes
   chmod 600 "$OIDC_ENV"
   (umask 077 && { grep -v '^VERCEL_OIDC_TOKEN=' "$SETUP_ENV"; grep '^VERCEL_OIDC_TOKEN=' "$OIDC_ENV"; } >"$SETUP_ENV.new") &&
     mv "$SETUP_ENV.new" "$SETUP_ENV"
   ```

   Optionally run the [worker check](../apps/worker/README.md#check-the-worker)
   now. Then run setup; retry a failure with the same commands. The record path
   must be one no earlier setup used: for a key-only change on the same commit,
   or a retry that asks for a new record, add a suffix such as `-2`.

   ```sh
   WORKER_RECORD="$PRIVATE_SETUP_DIR/worker-record-$(git rev-parse --short HEAD).json"
   (
     unset $(grep -oE '^[A-Z_][A-Z0-9_]*' "$SETUP_ENV")
     node --env-file="$SETUP_ENV" \
       apps/gateway/scripts/bootstrap-worker.mjs setup "$WORKER_RECORD"
   )
   chmod 600 "$WORKER_RECORD"
   ```

3. Replace the three `SANDBOX_*` settings, pasting each value from the setup
   output when prompted. The loop must end without an error, and the list must
   show all three with type `Config`, each created moments ago.

   ```sh
   for NAME in SANDBOX_WORKER_NAME SANDBOX_MANAGED_DRIVE SANDBOX_MANAGED_SEED; do
     pnpm exec vercel env remove "$NAME" --environment production --yes --scope "$SCOPE" &&
       pnpm exec vercel env add "$NAME" --environment production --no-sensitive --scope "$SCOPE" || break
   done
   pnpm exec vercel env list --environment production --scope "$SCOPE"
   ```

   Then deploy. Keep the URL the first `inspect` shows for a rollback.

   ```sh
   pnpm exec vercel inspect "$GATEWAY_ORIGIN" --scope "$SCOPE" --json
   DEPLOYMENT_URL=$(pnpm exec vercel deploy --prod --yes --scope "$SCOPE")
   pnpm exec vercel inspect "$DEPLOYMENT_URL" --scope "$SCOPE" --json
   pnpm exec vercel inspect "$GATEWAY_ORIGIN" --scope "$SCOPE" --json
   ```

   The new deployment must report `readyState` `READY`. If the origin then
   reports an older `id`, promote the new deployment. The origin must then
   report the new `id`.

   ```sh
   pnpm exec vercel promote "$DEPLOYMENT_URL" --scope "$SCOPE"
   pnpm exec vercel inspect "$GATEWAY_ORIGIN" --scope "$SCOPE" --json
   ```

4. Wait until every status message posted before the switch shows a final state;
   press Status on any that stay unfinished. A run accepted before the switch
   still uses the old Drive. Also wait until Vercel's Sandbox view shows no
   running session for the old worker Sandbox, which can keep running until its
   25-minute session timeout. Keep the old worker until the new deployment has
   answered in a new thread, because a rollback needs it. Then run cleanup with
   a fresh token (step 2). Set `OLD_RECORD` to the record of the worker you
   replaced: `worker-record.json` after the quickstart, otherwise the path its
   setup used. A retired record finds nothing and still reports removal. Cleanup
   deletes the old Drive. Then revoke a replaced key.

   ```sh
   OLD_RECORD="$PRIVATE_SETUP_DIR/record-of-the-replaced-worker.json"
   (
     unset $(grep -oE '^[A-Z_][A-Z0-9_]*' "$SETUP_ENV")
     node --env-file="$SETUP_ENV" apps/gateway/scripts/bootstrap-worker.mjs \
       cleanup "$OLD_RECORD"
   )
   ```

The new worker has a new, empty Drive. Replies in threads started before the
switch fail, because their Pi sessions stayed on the old Drive; start a new
thread instead. Channel notes also start empty.
