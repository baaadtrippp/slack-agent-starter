# Milestone 8: automatic idle shutdown and replacement

An explicitly enabled test worker can stop after its last verified result and
exit. A later request can prepare a replacement after the exact old session
stops and its writable Drive detaches. The replacement starts from a clean
startup seed and uses the same Drive for saved work. This advances AC03 and adds
replacement evidence toward AC02.

## Tracer bullet

1. Enroll a fresh nonpersistent worker from a clean, pinned seed before routing
   any work. Keep worker packages in the seed and mutable work on the Drive.
   Reuse the named Sandbox's provider-managed network settings.
2. Reserve work on the exact ready session. After the last recorded result and
   normal exit, fence the session and stop it. A competing dispatch either
   reserves first or receives an explicit prelaunch refusal.
3. On later input, verify the old session stopped and the same Drive is
   detached. Record one replacement intent before resuming. Verify a new
   session, the configured seed, the exact writable Drive mount, and the worker
   entry point before opening dispatch.
4. Test both race orders and a replacement whose reply is lost. Use disposable
   Redis, Vercel Sandbox, a clean seed, and a disposable Drive.

This tracer uses immediate idle stop in an opt-in test mode. Production timing
and limits remain open under O05. The existing operator-managed mode remains
available. An inconclusive stop or replacement proof keeps dispatch fenced.

## Deterministic evidence

With disposable Redis and mocked provider responses, the managed pointer
admitted only the exact ready session with an open idle gate. Concurrent
replacement claims produced one winner. A stale or starting pointer could not
launch a command. A stopped session with an attached Drive could not resume. A
lost resume response was reconciled by reading and validating the new session
without another resume call. A timeout before any resume call restored the prior
ready record so a later request could try.

The gateway runtime test enabled both managed settings and observed the idle
stop after a stored terminal result, a normal command exit, and release of the
reservation. The existing manual and fake worker tests remained in the same
suite.

## Provider integration evidence

A disposable unseeded nonpersistent Sandbox stopped and detached its Drive.
Vercel rejected a resume because it had no snapshot. A separate clean seed
contained only synthetic boot assets. A worker created from this seed resumed
under the same name with a new session ID and retained its Drive configuration.
A marker written only to the old runtime filesystem was absent in the
replacement.

The integrated probe used the gateway's managed worker and Redis store with two
real detached synthetic commands. The first command's completion left the
session running while the second command still held a reservation. Recording the
last result and confirming its command exit triggered automatic exact-session
stop. Fresh provider reads confirmed the Drive detached.

One request then claimed replacement while a competing request stayed blocked.
The probe let the real resume succeed and discarded its response. A later
request verified the already-created session, pinned seed, and exact Drive
attachment. The provider history contained one old and one new session. The new
session read the Drive file and lacked the old runtime marker. Its network
policy matched the original configuration. The test worker, seed, snapshot, and
Drive were removed.

The provider probe used synthetic commands and startup assets. It verifies the
lifecycle and writable Drive handoff, with Slack routing and result handling
covered separately by deterministic tests.
