# Milestone 13: explain rejected file and URL inputs

An internal tester receives one useful reply in the originating Slack thread
when a selected input cannot be used. This slice advances F04 and F05 and adds
partial AC06 evidence. The current opt-in CSV, PDF, PNG, and public URL limits
remain tracer limits under O05.

## Tracer bullet

1. Inspect the existing admission, downloader, and worker dispatch paths. Keep
   working rejection behavior unchanged; add only missing checks or necessary
   fixes. Recognize explicit IPv6 HTTP(S) URL text when Slack does not autolink
   the literal, then apply the same downloader validation before dispatch.
2. Exercise an oversized supported attachment, an unsupported attachment, a
   controlled inaccessible Slack download, and a private-network URL. Verify
   acknowledgement before deferred work, one specific same-thread notice,
   released conversation ownership, and no worker dispatch for each rejection.
3. Investigate the outstanding IPv6 Sandbox boundary using the real provider.
   Distinguish gateway URL validation, local loopback reachability, IPv6
   routing, and provider egress enforcement. Record controls and limitations
   rather than treating a mocked refusal or an unavailable route as firewall
   proof.
4. Where practical, use authorized live Slack messages and synthetic attachments
   to verify the deployed refusal path. Keep inaccessible-download injection in
   deterministic checks unless a real failure can be safely reproduced. Restore
   the captured gateway routing and remove temporary resources after the checks.

Broader attachment support, operating-limit decisions, and AC12 scenarios are
outside this slice. AC06 remains partial. Evidence below will distinguish
**deterministic**, **provider integration**, and **live Slack** checks.

## Deterministic evidence

Signed gateway events against disposable Redis checked four refusals with all
three attachment flags and the URL flag enabled: oversized PNG metadata, an
unsupported ZIP, a controlled HTTP 403 while downloading a PDF, and a private
IPv4 URL. Each event was acknowledged before deferred transfer or publication,
posted exactly one fixed notice to its original thread, started no worker
dispatch, recorded terminal failure, and released thread ownership. Slack calls
and the denied attachment response were simulated. Existing downloader tests
also exercise private IPv6 and IPv4-mapped IPv6 destinations.

The live IPv6 URL attempt exposed a missing gateway check: Slack can leave an
IPv6 URL as plain text rather than autolinking it. The adapter's link list then
omitted the URL and the gateway attempted ordinary dispatch. Two regression
tests reproduced this before the fix: a bare IPv6 loopback URL, and a linked
public URL combined with a bare IPv6 URL. Both now pass. The gateway combines
explicit bracketed IPv6 HTTP(S) URL text with adapter links, unescapes and
deduplicates them, then applies the existing single-source and downloader checks
before dispatch. The focused gateway suite passed before and after the
correction.

## IPv6 Sandbox probe

A separate real, nonpersistent Sandbox in `fra1`, using Sandbox SDK 3.9.1,
exercised unrestricted, deny-all, and runtime-equivalent hostname-allowlist plus
private-IPv4-deny policies. No Drive or Pi worker was needed.

Under unrestricted egress, a local IPv6 listener on `::1` worked and AAAA DNS
resolution succeeded. Public IPv6 TCP and HTTPS forced to address family 6
failed with `ENETUNREACH`; the guest routing table had no default IPv6 route.
The runtime-equivalent policy also resolved the allowed host's AAAA records but
could not route the IPv6 connection. Under deny-all, DNS was blocked and a
direct public IPv6 TCP attempt still returned `ENETUNREACH`.

The local `::1` connection also worked under deny-all. This is intra-VM traffic,
not evidence that provider egress permits a private destination. The provider
rejected explicit `::1/128`, `fc00::/7`, `fe80::/10`, and public IPv6 `/128`
allow/deny CIDRs with HTTP 400 `Invalid CIDR`.

These observations establish the tested Sandbox's current lack of routed IPv6
egress. They do **not** prove IPv6 firewall enforcement, which remains open if
IPv6 routing becomes available. Gateway URL refusal is a separate boundary and
cannot close that item. The probe Sandbox was stopped, deleted, and
independently verified absent.

## Live Slack evidence

Two authorized mentions each included one synthetic attachment in the same
message: a 16,399-byte CSV and a 158-byte ZIP. Hydra returned the size-limit
notice and supported-file guidance respectively in the originating thread. A
separate mention with an IPv4 loopback URL returned the private-network notice.
The published message IDs matched the gateway run records. Those records had no
worker execution target, and the actual thread ownership keys were released. No
Pi worker was provisioned for this refusal window.

An initial IPv6 URL attempt received the worker-unavailable notice because the
bare URL was not recognized. That outcome is the regression described above; it
is not a successful private-network refusal.

A fresh mention with a bare IPv6 loopback URL, after the gateway correction,
received exactly one private-network notice in its original thread. Its run
record had no worker execution target or native session and no remaining thread
owner. The recorded publication ID matched the observed Slack reply. This checks
gateway validation, not Sandbox egress.

The inaccessible-file outcome remains deterministic evidence from a controlled
HTTP 403, not a live Slack access-denial claim. AC06 remains partial; broader
attachment types and AC12 scenarios are separate work.
