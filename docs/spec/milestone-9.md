# Milestone 9: receive a Slack CSV

An internal tester attaches one synthetic CSV to a mention in the authorized
public Slack test channel. Hydra reads the uploaded data and returns a
calculation that can be checked independently. This advances F04 and F12 and
provides partial evidence for AC06 and AC12. The reply is plain Slack text.

## Tracer bullet

1. Apply the
   [mention-only CSV manifest](../../integrations/slack/milestone-9.yaml) and
   reinstall the app to grant `files:read`. Enable `SLACK_CSV_INPUT=1` on the
   test gateway after copying the current worker entry point to a prewarmed
   Sandbox with a fresh writable Drive.
2. Admit the signed Slack event and acknowledge it. The gateway validates one
   Slack-hosted UTF-8 CSV, capped at 16 KiB for this test, and downloads it
   without following redirects. It writes the bytes to the thread's input area
   on the Drive using the reserved Sandbox session. The original filename and
   Slack download URL never reach Pi.
3. The detached worker provides Pi with a tool that reads only the staged CSV.
   Pi reads the staged file, returns its answer through the existing
   authenticated callback, and the gateway posts the answer to the original
   thread.
4. Compare the Drive file with the uploaded bytes. Inspect the native Pi session
   for the file read and check the same-thread Slack answer against calculations
   made locally from the original fixture.

This slice uses the existing selected model and authorized channel. The file cap
applies to the opt-in test configuration while O05 remains open. Public URL
fetching, generated file uploads, additional input types, and full AC06 and AC12
acceptance are subsequent work.

## Deterministic evidence

Signed webhook fixtures and disposable Redis verified that the gateway stages
the exact bytes before worker launch and passes a file reference in the job. A
simulated write failure and a deadline expiring during a successful write both
left no active Sandbox reservation, started no worker, and published a retry
notice. Download tests exercised the Slack host check, type and size limits,
access failure, size mismatch, and UTF-8 validation. Slack delivery and Drive
writes were simulated.

A local probe through the pinned acpx, pi-acp, and Pi versions offered only the
CSV tool to a model double. Pi invoked the tool and passed the exact synthetic
CSV to the model double.

## Sandbox and Pi evidence

During the live run, the temporary gateway staged the CSV on the Vercel worker's
writable Drive. The staged file's SHA-256 matched the independently hashed
149-byte source fixture. The real Pi worker used OpenRouter. Its native session
recorded one successful call to the scoped CSV tool, and the tool result's text
matched the staged file's UTF-8 contents exactly.

## Live Slack evidence

Slack identified the first upload as a snippet. The initial validator returned
an unsupported-file notice in the originating thread. The gateway now applies
the same validation to Slack files in `snippet` and `hosted` modes.

A fresh mention with the same synthetic CSV passed through the gateway and
separate worker. Hydra posted one reply in the originating thread after the
authenticated callback. A local calculation independently matched the four data
rows, the per-label sums, the 11,604-cent total, and the receipt in the third
data row. A later read found the same single reply.

The previous gateway routing was restored and the temporary resources were
removed.

## Public URL tracer

An internal tester mentions Hydra with one link to a small public plain-text
resource. Hydra reads that resource and returns a result in the originating
thread that can be checked against the source. This advances F05 and F12 and
adds partial evidence for AC06 and AC12.

1. Enable the opt-in URL check for the authorized test channel. Use one direct
   HTTPS link, an 8-second fetch deadline, and a 16 KiB decoded body limit while
   the broader operating limits remain open under O05.
2. The gateway uses the signed mention's link, a DNS-pinned downloader, and
   public destination checks. This tracer rejects redirects, credentials in
   URLs, non-default HTTPS ports, and responses other than UTF-8 plain text.
   Fetching happens after Slack acknowledgement.
3. Stage the downloaded bytes on the thread's Drive. Give Pi one tool for those
   bytes. Keep the Sandbox's existing callback and model egress rules.
4. Check refusal and download bounds locally. In the live test, compare the
   staged bytes with an independent download, verify the native Pi tool result,
   and check the same-thread answer against the source.

HTTP, redirect following, other response types, combining a URL with a CSV,
search, and generated file uploads are subsequent work.
