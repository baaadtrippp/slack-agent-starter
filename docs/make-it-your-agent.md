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
worker does not need a rebuild for this.

Bootstrap does not give the model to the worker, but the worker record stores
the slug from `SETUP_ENV`, and setup refuses that record once `SETUP_ENV` names
another model. Keep the old slug in `SETUP_ENV` while you might still retry
setup with the current record. Switch it when you next use a new record path:
for the [worker check](../apps/worker/README.md#check-the-worker), or for the
next [worker change](#apply-worker-changes). Cleanup accepts the record whatever
the slug.

## Add a tool

Tools are Pi extensions that the worker writes for each run. `write_artifact` in
[`apps/worker/sandbox/run.mjs`](../apps/worker/sandbox/run.mjs) is the example
to copy:

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

Add your extension the same way. The stand-in model in
[`check-worker-fixture.mjs`](../apps/gateway/scripts/check-worker-fixture.mjs)
expects the exact tool list, so add the new name there too. A tool runs inside
the worker Sandbox within the 60-second run deadline, and it can reach only the
gateway origin and OpenRouter. Treat everything a tool reads as untrusted data.
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
text expect the defaults; update them with your values.

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
needs a new worker, and the gateway must be deployed from the same commit.

1. Commit the change and run the checks from
   [quickstart section 1](service-setup.md#1-prepare-a-clean-checkout). Run the
   [worker check](../apps/worker/README.md#check-the-worker) on that commit.
2. Run setup from
   [quickstart section 3](service-setup.md#3-bootstrap-the-worker) with a new
   `WORKER_RECORD` path, such as `"$PRIVATE_SETUP_DIR/worker-record-2.json"`.
   Setup refuses the old record because it names a different commit.
3. In the gateway's Production environment, replace `SANDBOX_WORKER_NAME`,
   `SANDBOX_MANAGED_DRIVE`, and `SANDBOX_MANAGED_SEED` with the new setup
   output. Deploy the gateway from the same commit, as in
   [section 4](service-setup.md#4-configure-and-deploy-the-gateway).
4. Wait until every status message posted before the switch shows a final state;
   press Status on any that stay unfinished. A run accepted before the switch
   still uses the old Drive. Also wait until Vercel's Sandbox view shows no
   running session for the old worker Sandbox, which can keep running until its
   25-minute session timeout. Then run only the cleanup command from
   [section 8](service-setup.md#8-rollback-and-teardown), with a fresh OIDC
   token and the old record. It deletes the old Drive.

The new worker has a new, empty Drive. Replies in threads started before the
switch fail, because their Pi sessions stayed on the old Drive; start a new
thread instead. Channel notes also start empty.
