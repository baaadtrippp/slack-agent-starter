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

Deploy the gateway and worker together. PNG and JPEG are opt-in after vision
checks on the selected model and adapter build. Conversations with native
sessions from earlier builds can still resume. Inputs staged before the new
source catalog was added remain in the native history if Pi previously read
them.

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

A controlled OpenRouter endpoint also exercised the exact pinned Pi worker. It
observed only the two scoped tools on the resumed turn. Pi reopened the same
native session, reread both exact text sources, and wrote the expected 24-byte
CSV. The controlled first request and native transcript contained the same JPEG
bytes.

The fixture oracle reproduced the patch's incorrect inclusion at the end of the
interval and exclusion at its start. The CSV oracle calculated 28,200 and 32,600
cents for Q1 and Q2, a 4,400-cent increase of 15.6%, and a 46.0% North share of
Q2 revenue. It identified West as the row with missing orders.

## Provider integration evidence

The tested runtime source was `cd23e9bb9576d2385f0c4691987a90bedb77b5d7`. The
pinned acpx, pi-acp, and Pi worker ran in a Vercel Sandbox on a writable Drive
with the selected OpenRouter model. A local HTTPS recorder authenticated worker
admission and captured callbacks inside the Sandbox.

- **JPEG vision.** The native user turn contained the exact staged JPEG. Pi
  returned the fixture total of 91, then reopened the same image with
  `read_input` in the same native and adapter session and returned 91 again. The
  image bytes in both native records matched the fixture digest.
- **Patch review.** Pi opened both exact source files, asked whether the
  endpoints should be inclusive, and reopened both files after clarification
  with the same session IDs. The text review located the reversed comparisons at
  `window.ts:11` and separated inspection from the stated interval convention.
  The independent fixture check confirmed that the changed code returned the
  middle and end events where the requirement calls for the start and middle
  events. An earlier attempt wrote a diff with the correct predicate but an
  invalid hunk count. Its bytes matched the callback digest.
- **CSV analysis.** Pi read the exact CSV and methodology bytes, asked which
  periods to compare, and reopened both sources after the reply. It reported the
  correct 4,400-cent increase of 15.6% and saved a cleaned CSV through
  `write_artifact`. Its native tool digest, callback digest, and Drive file
  matched. The independent fixture check verified all six cleaned rows and the
  missing-orders flag. A third turn reopened both earlier sources and returned
  North's 46.0% share. All three turns used the same session IDs.

The [earlier IPv6 probe](milestone-13.md#ipv6-sandbox-probe) distinguishes
gateway refusal from unverified provider IPv6 firewall enforcement.

## Live Slack evidence

Both AC12 Slack workflows are pending. The operator has two synthetic fixture
sets and paste-ready prompts. Earlier live single-source and CSV-upload checks
remain linked from [traceability](traceability.md).

## Delivery state

[PR #22](https://github.com/baaadtrippp/slack-agent-starter/pull/22) is a draft.
The source revision passed 219 local tests, GitHub Quality CI, the repository
and history secret scans, and Codex review. The first full CodeRabbit review
prompted tighter image opt-ins, exact bare URL parsing, and file-write recovery.
The revised source passed all 227 local tests and the controlled Pi probe,
including the same-session source reads and CSV output. Use this source for the
live Slack checks.

Provider-only verification used temporary worker, seed, Drive, and snapshot
resources. Cleanup verified their removal. The stable Slack route still resolved
to the exact deployment captured before the provider runs.
