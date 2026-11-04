# Milestone 11: read one text-based Slack PDF

An internal tester attaches one synthetic text-based PDF to a mention in the
authorized public test channel. Hydra reads it with the real Pi worker and posts
a result that can be checked in the originating thread. This advances F04 and
F12 and provides partial AC06 evidence. The opt-in test accepts one Slack-hosted
PDF of up to 16 KiB while the broader limits under O05 remain open.

1. Verify the existing installed bot's `files:read` grant and enable
   `SLACK_PDF_INPUT=1` on the test gateway.
2. The gateway validates and downloads the Slack attachment after
   acknowledgement, then stages the exact bytes in the reserved Sandbox.
3. In the Sandbox, extract bounded text from the fixed staged path in a separate
   process before starting Pi. Give Pi a tool scoped to that extracted text. A
   file that yields no readable text receives a fixed retry notice.
4. Verify the staging and rejection cases locally. In the live test, compare the
   staged bytes with the fixture, inspect the native Pi tool call, and check the
   answer in the original thread against an independent calculation.

The tracer covers one mention with one text-based document. OCR, image
interpretation, and combining sources are outside this slice.

## Deterministic evidence

The signed event tests checked that acknowledgement precedes staging and that
the exact PDF bytes reach the reserved Sandbox path before worker launch. The
download tests rejected multiple attachments, wrong metadata and host, an
oversized attachment, denied access, truncated bytes, and an invalid PDF header.
The callback tests checked that the fixed unreadable-PDF notice is published
once in the originating thread. Slack delivery and Sandbox writes were simulated
in these tests.

## Sandbox extraction probe

The reserved Sandbox extracted the reference and three item values from the
2,456-byte fixture with its bounded Poppler command. An independent calculation
from those values returned 7,490 cents. The final bounded extractor also
rejected malformed input and a small compressed PDF whose extracted text
exceeded 16 KiB. The probe exercised extraction in the Sandbox before the live
Slack run.

## Live Slack evidence

One mention in the authorized test channel included the synthetic text-based
PDF. The installed bot token had `files:read`. The gateway downloaded and staged
the attachment in the reserved Sandbox. The 2,456-byte staged file matched the
independently prepared PDF byte for byte.

The real Pi worker's native session recorded one successful `read_pdf_text`
call. Hydra posted one answer in the originating thread. Its reference ID, three
data rows, and total of 7,490 cents matched the independent fixture check. The
gateway's recorded publication ID matched that reply. A later thread read still
found one answer.

The previous gateway routing was restored, and the temporary deployment, worker,
Drive, and startup seed were removed. AC06 remains partial.
