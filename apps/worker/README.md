# Temporary fake worker

Milestone 1 deploys this canned worker to a separate temporary Vercel project.
It has no Slack, Redis, model, or platform-control credentials. Configure only
`GATEWAY_ORIGIN`, the gateway's public HTTPS origin, in this project.

Vercel project root: `apps/worker`. Enable source files outside the root to
include the shared `packages/contracts` package. The worker accepts a bounded,
run-scoped job at `POST /api/fake`, asks the gateway to confirm admission, and
posts a canned result to the HTTPS callback URL already bound to its job. Its
retries reuse one callback event ID.

This project is temporary test scaffolding. It does not demonstrate the Pi,
OpenRouter, Vercel Sandbox, or Drive worker path and is replaced by the worker
host integration in milestone 2.

## Milestone 2 Sandbox worker

Use one running, nonpersistent Sandbox with Node 24 or later and the Drive
mounted read/write at `/workspace`. In the Sandbox, prepare the ephemeral worker
directory with the pinned packages used in the live probe:

```bash
mkdir -m 700 /tmp/hydra-worker
npm install --prefix /tmp/hydra-worker --no-audit --no-fund --ignore-scripts \
  --save-exact acpx@0.21.1 pi-acp@0.0.34 @earendil-works/pi-coding-agent@1.5.0
```

Copy [`sandbox/run.mjs`](sandbox/run.mjs),
[`sandbox/supervise.mjs`](sandbox/supervise.mjs),
[`sandbox/control.mjs`](sandbox/control.mjs), and
[`sandbox/shared-notes.mjs`](sandbox/shared-notes.mjs) into `/tmp/hydra-worker`
with the same filenames. Verify `flock` from util-linux is available for shared
notes writes. Configure the Sandbox firewall for the gateway origin and
OpenRouter. Inject the model key through the OpenRouter egress rule. The command
receives only a placeholder key, the selected model and the admitted job. Keep
the Sandbox's `NODE_EXTRA_CA_CERTS` available for Pi's TLS connection to the
firewall.

The gateway launches `node /tmp/hydra-worker/supervise.mjs` by Sandbox name with
SDK detachment enabled. It invokes `control.mjs` separately with a
run-and-generation-bound `HYDRA_CONTROL` value for Stop or Status. Stop starts
with cooperative cancellation. If the run still has its original verified group
leader after the grace period, the supervisor can terminate that isolated group.
It verifies that the group and its marked ACP/Pi descendants have exited before
restoring a resumed turn's exact prior checkpoint when needed. A fully committed
checkpoint of the same native session can also be retained while the Slack
answer is suppressed. The gateway displays Stopping and retains ownership
whenever exit or session safety is unconfirmed.

The SDK request signal bounds launch acknowledgement. The worker deadline and
Sandbox lifetime bound execution. Status can recover the exact bounded Drive
result after a normal worker exit or after the gateway has independently
confirmed that exact Sandbox session stopped. If delivery is uncertain, inspect
the run's Drive result manifest and gateway record before taking manual action.

For the [text-based PDF tracer](../../docs/spec/milestone-11.md), prepare the
startup seed with the distribution's security-maintained Poppler tools and
`prlimit` from util-linux. Verify `/usr/bin/pdftotext` and `/usr/bin/prlimit`
before enabling PDF input on the gateway. The worker extracts at most 16 KiB of
text with a 256 MiB parser address-space limit and a three-second deadline.
