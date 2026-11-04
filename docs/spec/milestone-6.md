# Milestone 6: isolate worker deadlines

A Pi turn that reaches its deadline must end without interrupting another
thread's work in the same Sandbox. The worker reserves time to shut down Pi,
persist the result, and report a failure before the job deadline. This slice
adds partial evidence for AC09 and AC10.

## Tracer bullet

1. Start two independent worker processes in one disposable Sandbox. Use the
   merged worker entry point, the pinned ACP and Pi packages, and a local model
   fixture that holds both response streams open.
2. Give the first job an earlier deadline. Verify its model stream closes, its
   failure callback arrives before its job deadline, and its worker, adapter,
   and Pi processes exit while the second stream is still open.
3. Release the second stream. Verify the worker completes with its own native
   session reference, saves its result, and delivers one authenticated callback.

This slice covers the worker deadline and process isolation. Coordinated idle
shutdown, manual Stop and Status controls, and production limits remain separate
decisions and checks.

## Deterministic evidence

In WSL, two pinned Pi sessions used independent ACP runtimes and a local model
fixture. The first turn's timeout signal cancelled its stream. Its runtime shut
down while the second turn was active, and the second turn then completed.

## Provider integration evidence

A disposable Vercel Sandbox ran two copies of the unmodified worker entry point,
verified against the merged source. A test launcher configured pinned Pi to use
a loopback model fixture. Both streams were active when the first job reached
its turn deadline. The first stream disconnected and the worker saved one failed
result. The local HTTPS fixture accepted that authenticated result before the
job deadline. The worker exited normally, and process checks confirmed its Pi
and adapter had exited. The second stream and its Pi process remained active
through that cleanup.

After the test released the second stream, the worker completed with the
expected synthetic answer and its own native session reference. The saved result
matched the callback, and the second worker and its subprocesses exited. The VM
was stopped and removed after the test.

The Sandbox network policy was set to deny all external access during the runs.
Model and HTTPS callback endpoints were local fixtures, and workspace files were
written to the disposable VM filesystem. This verifies the worker's deadline
path in Vercel Sandbox. The live Slack gateway, paid model provider, and Drive
mount were outside this probe.
