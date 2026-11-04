# Milestone 10: return one generated CSV

An internal tester asks Hydra to generate a small synthetic CSV and gets both a
text answer and the CSV in the originating thread. This advances F06 and F12 and
adds partial evidence for AC06. The authorized public test channel and existing
model remain in use. The test allows one UTF-8 CSV of up to 16 KiB while O05
remains open.

1. Apply the
   [mention-only upload manifest](../../integrations/slack/milestone-10.yaml)
   and reinstall to grant `files:write`. Verify the installed scope before
   enabling `SLACK_CSV_OUTPUT=1` on the Sandbox-backed test gateway.
2. Give Pi one write tool. The tool accepts CSV text and selects the filename
   and the current run's results directory itself.
3. The worker sends an artifact reference with its authenticated terminal
   callback. The gateway collects the file from the reserved Sandbox session at
   the run's fixed output path and checks it against the tool's SHA-256. It
   rejects symbolic links, hard links, non-regular files, and files outside the
   test size limit.
4. Publish the text answer before attempting the Slack upload. Verify the exact
   bytes in the originating thread and exercise the upload failure path
   separately.

Other output types, arbitrary filenames, multiple artifacts, and combining the
tool with staged inputs are outside this slice. Broader AC06 remains partial.

## Deterministic evidence

The result reader returned the exact bytes of a synthetic CSV containing
non-ASCII text and CRLF line endings. It rejected another run's file, traversal,
symbolic links in the file and directory positions, hard links, directories, and
oversized files.

Signed callback tests with disposable Redis checked the recorded Sandbox target
and Slack thread. Overlapping callbacks caused one collection attempt and one
upload. A repeat callback with a different digest was rejected. Simulated upload
rejection, a missing upload receipt, transfer failure, transfer timeout, an
unavailable execution target, and a checksum mismatch all preserved the text
reply. Slack delivery was mocked.

A local probe through the pinned acpx, pi-acp, and Pi packages used a model
double. Pi advertised only `write_csv`, ignored extra path and filename
arguments, wrote the expected bytes, and recorded their SHA-256 in its native
session.

## Live Slack evidence

The installed bot token had `files:write` in the authorized test workspace. One
mention asked the real Pi worker to generate a two-row synthetic CSV. Its native
session recorded one successful `write_csv` call. The authenticated callback
carried the tool's SHA-256. The gateway collected the artifact from the worker's
reserved Sandbox session.

One text answer and one `result.csv` upload appeared in the originating thread.
An independent calculation matched the answer's total of 18. The 28-byte Slack
download, Drive file, and independently prepared fixture had identical SHA-256
digests. A later thread read still found one answer and one upload. Upload
failure was verified separately in the deterministic checks.

The previous gateway routing was restored. The temporary gateway, scope probe,
worker, Drive, and startup seed were removed.
