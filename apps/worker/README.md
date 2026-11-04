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

Copy [`sandbox/run.mjs`](sandbox/run.mjs) to `/tmp/hydra-worker/run.mjs`.
Configure the Sandbox firewall for the gateway origin and OpenRouter. Inject the
model key through the OpenRouter egress rule. The command receives only a
placeholder key, the selected model and the admitted job. Keep the Sandbox's
`NODE_EXTRA_CA_CERTS` available for Pi's TLS connection to the firewall.

The gateway launches the command by Sandbox name with SDK detachment enabled.
The SDK request signal bounds launch acknowledgement. The worker deadline and
Sandbox lifetime bound execution. If delivery is uncertain, inspect the run's
Drive result manifest and gateway record before taking manual action.

For the [text-based PDF tracer](../../docs/spec/milestone-11.md), prepare the
startup seed with the distribution's security-maintained Poppler tools and
`prlimit` from util-linux. Verify `/usr/bin/pdftotext` and `/usr/bin/prlimit`
before enabling PDF input on the gateway. The worker extracts at most 16 KiB of
text with a 256 MiB parser address-space limit and a three-second deadline.
