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
simulated staging failure left no active Sandbox reservation, started no worker,
and published a safe retry notice. Download tests exercised the Slack host
check, type and size limits, access failure, size mismatch, and UTF-8
validation. Slack delivery and Drive writes were simulated.

A local probe through the pinned acpx, pi-acp, and Pi versions offered only the
CSV tool to a model double. Pi invoked the tool and passed the exact synthetic
CSV to the model double.
