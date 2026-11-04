# V1 traceability

This index maps the stable feature and acceptance IDs in the canonical
[v1 specification](v1.md). Evidence links are added by tracer bullets; an empty
evidence cell means the requirement has not been demonstrated.

| Feature                   | Primary acceptance criteria | Status      | Evidence                                                                                                                                                                                                                                                     |
| ------------------------- | --------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F01 Start work            | AC01, AC08                  | Partial     | **deterministic:** [gateway tests](../../tests/gateway.test.ts) (local Redis; Slack delivery mocked)                                                                                                                                                         |
| F02 Continue a thread     | AC01, AC02, AC05            | Partial     | **deterministic:** [gateway tests](../../tests/gateway.test.ts). **provider integration:** [exact Sandbox replacement](milestone-3.md#sandbox-replacement-evidence). **live Slack:** [ordinary reply after replacement](milestone-3.md#live-slack-evidence). |
| F03 Know the context      | AC01, AC03                  | Specified   | —                                                                                                                                                                                                                                                            |
| F04 Receive attachments   | AC06, AC12                  | Specified   | —                                                                                                                                                                                                                                                            |
| F05 Read public URLs      | AC06, AC10                  | Specified   | —                                                                                                                                                                                                                                                            |
| F06 Return useful work    | AC06, AC10, AC12            | Specified   | —                                                                                                                                                                                                                                                            |
| F07 Show progress         | AC07, AC10                  | Specified   | —                                                                                                                                                                                                                                                            |
| F08 Ask questions         | AC05                        | Partial     | **live Slack:** [clarification and same-session answer](milestone-4.md#live-slack-evidence).                                                                                                                                                                 |
| F09 Stop and inspect      | AC03, AC07, AC10            | Proposed    | —                                                                                                                                                                                                                                                            |
| F10 Handle busy threads   | AC08                        | Partial     | **deterministic:** [gateway](../../tests/gateway.test.ts), [store](../../tests/store.test.ts). **provider integration:** [Pi](milestone-5.md#provider-integration-evidence). **live Slack:** [recovery](milestone-5.md#live-slack-recovery-evidence).        |
| F11 Recognize reactions   | AC07                        | Proposed    | —                                                                                                                                                                                                                                                            |
| F12 Use actual tools      | AC06, AC09, AC12            | Specified   | —                                                                                                                                                                                                                                                            |
| F13 Share agent knowledge | AC02, AC04                  | Policy open | —                                                                                                                                                                                                                                                            |

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
Coordinated Sandbox lifecycle remains unverified. The
[Milestone 3 Slack test](milestone-3.md#live-slack-evidence) verified ordinary
thread continuation after operator-managed Sandbox replacement (F02, AC02).

The [Milestone 4 clarification test](milestone-4.md#live-slack-evidence)
verified a question published as normal completed text, worker exit before the
human reply, independent work in another thread, and an ordinary answer
reopening the exact native session after Sandbox replacement (F08, AC05).

The [Milestone 5 recovery tests](milestone-5.md#deterministic-evidence) add
**deterministic** evidence for safe first-turn interruption, explicit retry, and
rejection of late callbacks (F10, AC08–AC10). The separate
[provider probe](milestone-5.md#provider-integration-evidence) adds **provider
integration** evidence for isolated Pi cancellation, a fresh Pi turn against a
local model fixture, and confirmation of the exact stopped Sandbox session. The
[Slack recovery test](milestone-5.md#live-slack-recovery-evidence) adds **live
Slack** evidence for the recovery reply and fresh mention after replacement with
a synthetic worker result.

The [Milestone 6 WSL probe](milestone-6.md#deterministic-evidence) adds
**deterministic** evidence for isolated Pi timeout and shutdown. The
[deployed worker probe](milestone-6.md#provider-integration-evidence) adds
**provider integration** evidence that one timed-out worker can finish cleanup
and deliver a failure while another worker continues in the same Sandbox (AC09,
AC10).

The [Milestone 7 tests](milestone-7.md#deterministic-evidence) add
**deterministic** evidence for the idle-stop fence and a retry notice after
known prelaunch refusal. The
[idle-stop probe](milestone-7.md#provider-integration-evidence) adds **provider
integration** evidence for exact-session stop, a fenced dispatch, and writable
Drive handoff to a replacement (AC03).

The [Milestone 8 tests](milestone-8.md#deterministic-evidence) add
**deterministic** evidence for one replacement intent and exact managed
dispatch. The
[automatic lifecycle probe](milestone-8.md#provider-integration-evidence) adds
**provider integration** evidence for idle stop, reconciliation after a lost
resume response, and preservation of the writable Drive across a clean
replacement (AC02, AC03).

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
