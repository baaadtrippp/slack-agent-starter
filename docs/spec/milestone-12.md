# Milestone 12: read one Slack PNG

An internal tester attaches one synthetic PNG to a mention in the authorized
public test channel. Hydra reads the image and returns an independently
checkable result in the originating thread. This advances F04 and F12 and
provides partial AC06 evidence.

The selected model and pinned ACP path already passed the
[vision compatibility probe](milestone-2.md#openrouter-compatibility-evidence).
The opt-in tracer accepts one Slack-hosted PNG up to 16 KiB and 1,024 pixels on
either edge while the broader limits under O05 remain open.

1. Verify the installed bot's existing `files:read` grant. Enable
   `SLACK_PNG_INPUT=1` for the test gateway.
2. Validate the Slack metadata, download the original image after
   acknowledgement, check the PNG header and dimensions, and stage the exact
   bytes in the reserved Sandbox.
3. Give Pi those bytes as one native ACP image attachment from the fixed staged
   path. The native Pi session must retain the image in the admitted user
   message.
4. Compare the staged and native image bytes with the fixture. Verify the
   image's reference, values, and calculated total in the same Slack thread.

Other image types, multiple inputs, and combining sources are outside this
slice.

## Deterministic evidence

A signed mention test checked that the gateway stages the exact PNG bytes before
worker launch, including when CSV and PDF are also enabled. Download tests
checked metadata, file and image dimension limits, the PNG header and end
marker, the Slack host, and authenticated transfer without redirects. Slack
delivery and Sandbox staging were simulated in these tests.

The exact pinned acpx, pi-acp, and Pi packages also ran a local model-double
probe with the fixture. The native user record retained one PNG, and the model
request carried an image with the exact same bytes. The request advertised zero
tools.

## Live Slack evidence

One mention in the authorized test channel included a synthetic 640 × 360 PNG.
The installed bot token had `files:read`. The gateway downloaded and staged
15,178 bytes in the reserved Sandbox, matching the original fixture byte for
byte.

The real Pi worker's native user record retained one `image/png` attachment with
the same bytes. The prompt contained the question. The reference and values
appeared only in the image. Hydra posted one answer in the originating thread.
The reference, the three labeled values, and the total of 91 matched an
independent reading of the fixture. The gateway's publication ID matched that
reply. A later thread read still showed one answer.

The previous gateway routing was restored, and the temporary deployment, worker,
Drive, and startup seed were removed. This verifies the PNG case of AC06.
