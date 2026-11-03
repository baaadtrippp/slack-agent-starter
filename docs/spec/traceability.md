# V1 traceability

This index maps the stable feature and acceptance IDs in the canonical
[v1 specification](v1.md). Evidence links are added by tracer bullets; an empty
evidence cell means the requirement has not been demonstrated.

| Feature                   | Primary acceptance criteria | Status      | Evidence                                                                                                                  |
| ------------------------- | --------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| F01 Start work            | AC01, AC08                  | Partial     | **deterministic:** [gateway tests](../../tests/gateway.test.ts) (local Redis; Slack delivery mocked)                      |
| F02 Continue a thread     | AC01, AC02, AC05            | Specified   | —                                                                                                                         |
| F03 Know the context      | AC01, AC03                  | Specified   | —                                                                                                                         |
| F04 Receive attachments   | AC06, AC12                  | Specified   | —                                                                                                                         |
| F05 Read public URLs      | AC06, AC10                  | Specified   | —                                                                                                                         |
| F06 Return useful work    | AC06, AC10, AC12            | Specified   | —                                                                                                                         |
| F07 Show progress         | AC07, AC10                  | Specified   | —                                                                                                                         |
| F08 Ask questions         | AC05                        | Specified   | —                                                                                                                         |
| F09 Stop and inspect      | AC03, AC07, AC10            | Proposed    | —                                                                                                                         |
| F10 Handle busy threads   | AC08                        | Partial     | **deterministic:** [gateway and store tests](../../tests/gateway.test.ts), [Redis store tests](../../tests/store.test.ts) |
| F11 Recognize reactions   | AC07                        | Proposed    | —                                                                                                                         |
| F12 Use actual tools      | AC06, AC09, AC12            | Specified   | —                                                                                                                         |
| F13 Share agent knowledge | AC02, AC04                  | Policy open | —                                                                                                                         |

AC11 covers the development path and sanitized fixtures. AC13 covers repository
publication. Both apply across all tracer bullets.

Milestone 1 provides partial deterministic evidence for admission, busy input,
deduplication, callback authentication, and same-thread canned publication. The
local runs used disposable Redis 8.4 and mocked Slack initialization and message
posting. The TCP-proxy runtime test also covers a dropped Redis socket and a
stalled response followed by recovery. It also covers a stalled cold handshake
and successful publication when Slack initialization and posting each take
longer than one second. Invalid credentials are rejected before Redis access;
run records retain input references rather than the full message text.

**Provider integration and live Slack evidence:** the tested gateway and
separate fake worker deployments matched all committed source files at the time
of the test. One authorized mention in the selected public test channel received
exactly one expected canned reply in its originating thread. A later read more
than a minute afterward still found exactly one reply. The runtime Redis run and
message records referred to the same run; the run's published message ID matched
the Slack reply, and thread ownership was removed after completion. The
completed run and message records remained without expiration. This demonstrates
the real Redis read/write/delete path, worker callback, and Chat SDK publication
for this canned flow. No Slack-generated retry was observed; duplicate coverage
remains deterministic against disposable Redis, not live Slack retry evidence.

The Slack app's manifest update saved the event endpoint without changing
scopes, but no native URL challenge outcome was observed, so Slack URL
verification remains unverified. These results do not demonstrate Pi, model
access, Sandbox, Drive, or OpenRouter. F01 remains partial; later thread
continuation and agent runtime acceptance criteria remain unproven.

[Milestone 2 compatibility and cancellation probes](milestone-2.md#local-compatibility-evidence)
add **deterministic** evidence for pinned ACP startup, native session reopening,
provider failure handling, and cancellation of one Pi turn while another
continues. The
[OpenRouter probe](milestone-2.md#openrouter-compatibility-evidence) adds
**provider integration** evidence for a real Pi answer, a file read, and image
input (F12, AC06, and AC11). The
[Sandbox recovery probe](milestone-2.md#sandbox-and-drive-recovery-evidence)
verified that a fresh Sandbox could reopen the exact native Pi session and
workspace on the same Drive, using a synthetic model response.

The [Milestone 2 Slack test](milestone-2.md#live-slack-evidence) adds **live
Slack** evidence for a detached Sandbox/Pi/OpenRouter answer in the originating
thread and a distinct worker failure reply (F01, F12, AC01, AC09, and AC10).
Ordinary Slack thread continuation across Sandbox replacement and coordinated
Sandbox lifecycle remain unverified.

## Evidence rules

For each slice, link evidence and label it as one of:

- **deterministic** — local or CI checks using synthetic fixtures and test
  doubles;
- **provider integration** — real provider behavior without Slack's live
  boundary;
- **live Slack** — an authorized end-to-end Slack/model run.

State exactly what ran. A fake worker proves gateway routing and error behavior,
not real Pi behavior. A local webhook fixture proves signature handling logic,
not Slack delivery. Provider dashboards or a resource name prove provisioning,
not a working application round trip.
