# How it's tested

There are three kinds of evidence, and one never stands in for another:

- **Deterministic**: `pnpm check` with synthetic fixtures, test doubles, and a
  local Redis. It proves gateway and worker logic, not Pi, the model, the
  Sandbox, or Slack.
- **Provider**: real Vercel Sandbox and Drive, Pi, or OpenRouter, without Slack.
  The repeatable one is the
  [worker check](../../apps/worker/README.md#check-the-worker).
- **Live Slack**: a run through a real Slack app and workspace.

Feature names follow the
[specification](specification.md#2-user-visible-features).

| Feature                   | Deterministic | Provider | Live Slack |
| ------------------------- | ------------- | -------- | ---------- |
| F01 Start work            | yes           | yes      | yes        |
| F02 Continue a thread     | yes           | yes      | yes        |
| F03 Know the context      | yes           |          | yes        |
| F04 Receive attachments   | yes           | yes      | yes        |
| F05 Read public URLs      | yes           | yes      | yes        |
| F06 Return useful work    | yes           | yes      | yes        |
| F07 Show progress         | yes           | yes      | yes        |
| F08 Ask questions         | yes           | yes      | yes        |
| F09 Stop and inspect      | yes           | yes      | yes        |
| F10 Handle busy threads   | yes           | yes      | yes        |
| F11 Recognize reactions   | yes           |          | yes        |
| F12 Use actual tools      | yes           | yes      | yes        |
| F13 Share agent knowledge | yes           | yes      | yes        |
| Worker runtime            | yes           | yes      | yes        |

The full log, with dates and commits, is in this file's Git history.

## Known gaps

- F01: Slack URL verification and a Slack retry were not seen live; duplicate
  handling is deterministic only. The provider check used a fake worker.
- F02: Independent threads and stale revisions are checked deterministically or
  locally only. No live gateway restart is recorded.
- F04: No live run had JPEG input on, so no JPEG or JPEG thumbnail was read
  live. The "not enabled" notice and an inaccessible Slack download are
  deterministic only.
- F04: Only PNG thumbnails were seen live. The JPEG thumbnail path and format
  come from public Slack payload examples.
- F04–F06, F12: Apart from one image run, runs used small synthetic files within
  the 16 KiB limits.
- F05: IPv6 egress blocking is unverified; the tested Sandbox had no IPv6 route.
- F06: The refused-file notice and the 256 KiB file limit ran only with a
  stand-in model. Code and Markdown uploads and the upload-failure fallback are
  deterministic only.
- F07: Live runs show only the final Completed status. Intermediate and failure
  states have no live or provider check.
- F07: The model usage on the Completed status was seen live with tokens and
  cost, per run, with one OpenRouter model. The tokens-only case and a
  comparison with OpenRouter's own activity page are not verified.
- F08: No live run combines a file-bearing question, Sandbox replacement, a
  gateway restart, and an ordinary reply.
- F09: No intermediate Status edit was captured live. Provider Stop checks used
  a loopback model, not OpenRouter.
- F10: Live recovery used a synthetic worker result. Late callbacks and lost
  sessions are deterministic only.
- F11: Live Slack did not see a thumbs-up removal or both reactions inactive.
- F13: Live save and recall used one member. A second reader is covered only by
  gateway tests.
- Worker runtime: deadline isolation has no live, paid-model, or Drive check.
  Quota handling used synthetic 402 responses. No check shows a paid model
  follows the instructions file. Tool API keys were checked live only with a
  throwaway tool, one header, and a synthetic key.
- Automatic cleanup is deferred. The limits are defaults, not tested targets.
