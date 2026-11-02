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
stalled response followed by recovery.

**Provider integration:** the exact admission, callback-claim, and completion
Lua scripts were exercised on the dedicated Upstash database with synthetic
keys. Delivery and callback duplicates were suppressed, ownership was released,
and fixture deletion was verified. This used the management REST path. Both
Vercel packages built successfully. The deployed gateway connected through
`REDIS_URL`, read a synthetic missing-run lookup, and rejected the
unauthenticated callback with 401. A synthetic, unadmitted job was rejected by
the separate worker with 403 after its real HTTPS gateway admission check. The
minimal remote manifest validation passed. Slack URL verification and a live
mention remain unverified. The fake worker does not demonstrate Pi, Sandbox,
Drive, or OpenRouter.

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
