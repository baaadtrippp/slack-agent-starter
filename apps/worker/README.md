# Sandbox worker

The supported worker is the pinned Pi and ACP runtime in `sandbox/`. It runs in
one named, nonpersistent Vercel Sandbox with one Vercel Drive mounted read/write
at `/workspace`. The public bootstrap creates the clean startup snapshot, Drive,
initial exact session, network policy, and Redis enrollment.

Follow the [v1 quickstart](../../docs/service-setup.md). From the repository
root, its worker entry points are:

```text
node --env-file="$SETUP_ENV" apps/gateway/scripts/bootstrap-worker.mjs setup "$WORKER_RECORD"
node --env-file="$SETUP_ENV" apps/gateway/scripts/bootstrap-worker.mjs cleanup "$WORKER_RECORD"
```

Before a later cleanup, refresh the short-lived `VERCEL_OIDC_TOKEN` in
`SETUP_ENV` as the quickstart describes.

The setup command installs these exact packages into the startup snapshot:

- `acpx@0.21.1`
- `pi-acp@0.0.34`
- `@earendil-works/pi-coding-agent@1.5.0`

It copies `sandbox/run.mjs`, `sandbox/supervise.mjs`, `sandbox/control.mjs`, and
`sandbox/shared-notes.mjs` from the checked-out commit and verifies their hashes
inside the Sandbox. It also installs the Poppler and util-linux programs
required by the checked-in PDF, privilege, process-control, and shared-note
paths.

The startup snapshot contains dependencies and the checked-in worker files. It
has no Drive, model key, Slack credential, Redis credential, session, or user
data. The live worker is forked from that snapshot with the Drive mounted at
`/workspace`. Its egress allowlist contains only the configured gateway host and
OpenRouter. The provider firewall is configured to inject the OpenRouter key
into requests, while the process receives a placeholder value. The paid model
smoke in the quickstart verifies that path end to end.

The gateway starts `supervise.mjs` for work and invokes `control.mjs` for Stop
or Status. A completed run saves its result and native session on the Drive
before callback delivery. The managed runtime stops the Sandbox after verified
idle and creates a fresh session from the same snapshot and Drive for the next
turn.

Cleanup permanently deletes the worker Sandbox, seed Sandbox, startup snapshot,
and Drive recorded by the bootstrap. It does not delete the gateway deployment,
Slack app, OpenRouter key, Redis database, or Redis records. Use it only after
Slack ingress is disabled and all accepted runs are terminal.

## Check the worker

`apps/gateway/scripts/check-worker.mjs` checks the worker on a real Sandbox and
Drive without Slack or model spend. Run it from a clean checkout of the commit
under test, with the quickstart's `SETUP_ENV`, a new record path outside the
clone, and `openssl` on `PATH`.

```sh
CHECK_RECORD="$(mktemp -d)/check-record.json"
(
  unset $(grep -oE '^[A-Z_][A-Z0-9_]*' "$SETUP_ENV")
  node --env-file="$SETUP_ENV" \
    apps/gateway/scripts/check-worker.mjs "$CHECK_RECORD"
)
```

It runs bootstrap setup on that record, which builds a separate worker from the
commit and reads back its egress policy. Loopback stand-ins inside the worker
answer for OpenRouter and the gateway callback. Jobs use the gateway's launch
command. A first run stages a CSV; after the gateway's idle stop, a new session
resumes on the same Drive, and a reply continues the exact native session, reads
the retained CSV, and saves a file with `write_artifact`.

The check prints the tested commit, then always runs bootstrap cleanup and
removes the check worker's Redis records. If cleanup fails, retry it with
`bootstrap-worker.mjs cleanup "$CHECK_RECORD"`. This is provider integration
evidence with a stand-in model, not proof of the paid model path or live Slack.
