# F04–F06 file exchange

- An internal tester can give Pi a diff and source for review or a CSV and a
  public methodology URL for analysis. A clarification and subsequent replies
  use the same Pi session and can reopen accepted inputs. Results and any
  generated artifact appear in the original Slack thread.
- This covers F04–F06 and the file-related parts of F12, AC06, AC10, and AC12.
  Keep the existing 16 KiB file and output bounds for this test. Bound the
  number of inputs per turn and retained sources per session. Production limits
  and retention under O05 remain open.
- Keep Slack downloads, URL checks, and publication in the gateway. Stage
  bounded inputs under worker-generated paths and expose only those sources
  through scoped Pi tools. Keep PNG on the native image path and require
  equivalent evidence before enabling JPEG. Use the existing checksum and
  same-thread upload flow for one generated code, Markdown, or CSV file.
- Historical Slack content remains context only. The change excludes browser and
  account connectors, arbitrary worker filesystem or network tools, OCR, shared
  memory, and user controls. Pi performs the review and analysis.
- Deterministic checks exercise admission and rejection, exact staging, scoped
  reuse, output integrity, and readable text when upload fails. Real provider
  checks inspect native Pi session and tool results. Live Slack checks use
  synthetic fixtures to confirm both workflows, independently verify findings
  and calculations, compare downloaded output, and confirm route restoration.

## Test limits and rollout

The gateway accepts up to five Slack attachments and one direct public HTTPS
plain-text URL per current message. The byte limit is 16 KiB per source.
Supported images have at most 1,024 pixels on each edge. The worker makes up to
12 accepted sources available per saved session and allows one UTF-8 result file
of up to 16 KiB per run. Start a new thread when the source limit is reached.
O05 production limits and retention are open.

Deploy the gateway and worker together. JPEG remains opt-in pending the vision
check. Conversations with native sessions from earlier builds can still resume.
Inputs staged before the new source catalog was added remain in the native
history if Pi previously read them.

## Deterministic evidence

Signed Slack event tests against disposable Redis verified mixed CSV and URL
staging, a file-only ordinary reply with the exact saved session, private URL
refusal on a reply, the attachment count limit, and same-thread publication of
CSV, Markdown, and patch artifacts. Attachment checks verified allowed types,
file and image bounds, authenticated download, and access refusal. Worker tests
reopened exact CSV and URL bytes from the selected revision and refused a
different conversation, traversal, symbolic links, and checksum mismatches.
Result collection preserved the text answer after transfer or upload failure.
Slack, Sandbox staging, and provider requests were simulated at these test
boundaries.

The fixture oracle reproduced the patch's incorrect inclusion at the end of the
interval and exclusion at its start. The CSV oracle calculated 28,200 and 32,600
cents for Q1 and Q2, a 4,400-cent increase of 15.6%, and a 46.0% North share of
Q2 revenue. It identified West as the row with missing orders.

## Provider integration evidence

Pending. The [earlier IPv6 probe](milestone-13.md#ipv6-sandbox-probe)
distinguishes gateway refusal from unverified provider IPv6 firewall
enforcement.

## Live Slack evidence

Both AC12 workflows are pending. The earlier single-source and CSV-upload checks
remain linked from [traceability](traceability.md).
