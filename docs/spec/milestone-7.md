# Milestone 7: coordinate idle worker shutdown

A dispatch that reserves the running Sandbox session keeps it available until
the command has exited. A shutdown that claims an idle session first fences that
session before stopping it. A replacement can take the writable Drive after the
old session is confirmed stopped and detached. This advances AC03.

## Tracer bullet

1. In a fresh test runtime, reserve dispatch against an exact Sandbox session in
   Redis before any command launch. Attempt shutdown during reservation and
   while commands remain active. Both attempts must leave the session running.
2. Confirm the exact commands exited before releasing their reservations.
   Atomically fence the idle session and try a competing dispatch. The competing
   dispatch must make no command request against the draining session.
3. Stop the captured session by immutable ID and verify its status with a fresh
   provider read. Confirm the writable Drive is detached. Prepare only one
   replacement, remount the Drive, and verify it retains the earlier file. The
   old session must remain fenced.
4. Keep the operator in charge of worker preparation in this tracer. Use
   disposable Redis, Sandbox sessions, and a disposable Drive.

The gateway records reservations before launching commands and releases them
after a normal exit and a recorded terminal result are confirmed. An operator
command enrolls a fresh prepared session and stops it only when its reservations
are clear. A dispatch rejected before launch gets a reply asking for a fresh
mention when a worker is ready.

The tracer leaves automatic idle timing, production cutover, and Slack Stop or
Status controls for separate work. A command whose start or exit is uncertain
keeps its reservation. Missing stop or detach proof blocks replacement.

## Deterministic evidence

With local Redis and mocked Slack and provider calls, the gateway reserved the
exact session before launch and kept it reserved through the exit check. A
normal exit with a recorded result released the reservation. A lost start
response, unconfirmed exit, or missing result each kept it in place. A known
prelaunch refusal posted one retry notice, released thread ownership, and
required a fresh mention. Redis tests covered dispatch-first and stop-first
races, two active reservations, wrong-session release, and a repeated stop claim
after a lost acknowledgement.

## Provider integration evidence

An initial disposable Vercel and Redis probe exercised both race orders.
Dispatch reserved the original session before launch and blocked shutdown. When
shutdown claimed the idle session first, a later dispatch was denied. Two
competing replacement preparation claims produced one winner after the old
session was confirmed stopped and its Drive detached.

A second probe used the gateway's Redis store and the actual operator command
with two real detached commands in a disposable Vercel Sandbox. The command
refused to stop before the first launch and again while a second command was
active. After both exact commands exited and their reservations were cleared,
the stop command fenced the session and a competing reservation was denied
before launch. Fresh provider reads confirmed the original session stopped and
the writable Drive detached. The operator prepared one replacement, which
mounted the same Drive, read the synthetic file, and ran new work. The old
session remained fenced. Both disposable Sandboxes and the Drive were removed.

The provider probe also retried an exact session stop after a simulated operator
interruption following the fence write. The original fence kept late dispatch
blocked and the retry confirmed the old session stopped.

The provider probe called the Redis store, operator command, and Vercel SDK
directly. Gateway behavior is covered by the deterministic tests. Live Slack and
model execution were outside the idle-stop probes.
