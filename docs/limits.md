# Limits

These are defaults, not load-tested. Most live in
[`packages/contracts/src/limits.ts`](../packages/contracts/src/limits.ts);
[Change the limits](make-it-your-agent.md#change-the-limits) says how to change
them.

| Area                | Limit                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Run time            | 60 s from when the gateway accepts the message; the model turn ends 12 s early (18 s with file exchange) to leave time to save. |
| Runs per thread     | One at a time.                                                                                                                  |
| Runs across threads | No cap; all share one Sandbox with 1 vCPU and one 1 GiB Drive.                                                                  |
| Message             | 12,000 characters; a longer message gets no reply.                                                                              |
| Inputs per message  | Up to 5 Slack files and 1 public link, 16 KiB each except images.                                                               |
| Images              | PNG or JPEG up to 2 MiB and 1,024 pixels per edge; a larger one is sent as Slack's 1,024-pixel thumbnail if it has one.         |
| PDF                 | Text-based, up to 16 KiB of extracted text.                                                                                     |
| Inputs per thread   | 12 files and links in total.                                                                                                    |
| Thread context      | Up to 20 earlier messages, 2 KiB each and 16 KiB in total.                                                                      |
| Answer              | 4,000 characters; a longer answer is cut.                                                                                       |
| Generated file      | One per answer, UTF-8, up to 256 KiB: CSV, Markdown, text, diff, JSON, YAML, HTML, CSS, SQL, shell, or code.                    |
| Shared notes        | 16 per channel, 512 bytes each; a full channel is reported and nothing is evicted.                                              |
| Worker Sandbox      | Stops after the last active run, or at its 25-minute session timeout.                                                           |
| Retention           | Drive data, the startup snapshot, and most Redis records stay until teardown, even if the Slack message is deleted.             |

The Drive is not a backup.
