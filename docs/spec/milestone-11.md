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
