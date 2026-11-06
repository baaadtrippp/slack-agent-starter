# F03 first activation in an existing Slack thread

## Tracer bullet

1. A mention inside an allowed thread starts a new Pi session with a bounded
   selection of earlier messages and the current request. An ordinary reply or
   later mention uses the saved session and supplies only new input. A mention
   at a new root starts independently.
2. This advances F03 and AC01 and preserves F02, F07, and the thread isolation
   and deduplication covered by AC03 and AC08. Use the selected internal public
   channel and the existing bot installation. The limits here apply to this test
   slice. O05 production limits remain open.
3. After atomic admission and outside Slack HTTP acknowledgement, read one page
   of up to 20 messages from the admitted root using the mention timestamp as an
   exclusive upper bound. Keep the earliest permitted messages in order,
   including the root when available. Limit individual message text to 2 KiB and
   the serialized context to 16 KiB. Indicate when the window was cut. On a
   failed read, release the unsubmitted run and tell the user to mention the
   agent again in the same thread.
4. Send the projected context with the request to the worker. Pi sees a separate
   block of untrusted conversation data and the current request. Attachment
   metadata consists of file ID, media type, and size, with up to five entries
   per message. Exclude attachment contents, download fields, web links and
   Slack token patterns from earlier messages. Keep the transcript out of Redis.
   Preserve current input tools and exact session checks. Channel history, older
   file or URL retrieval, access expansion, shared memory, controls, and
   feedback are outside this slice.

## Success checks

- **Deterministic gateway and worker:** a signed in-thread mention returns
  before history retrieval begins. The accepted run makes one request for the
  correct root. The worker receives ordered, bounded earlier context and the
  distinct request. Duplicates, busy inputs, new roots, continuations, and
  refused inputs make no history request. A history failure dispatches no worker
  and permits a fresh mention. A lost saved session follows the existing error
  path. Progress remains one status per submitted run.
- **Live Slack and provider:** where authorized, place a synthetic fact in an
  earlier message in the configured test channel and ask for it in the first
  mention. An ordinary follow-up should recall it with the same native session
  ID, one new user turn, and no context import. Capture the Slack observations
  separately from the saved-session and provider evidence.

## Deterministic evidence

The signed gateway fixtures use local Redis and mock Slack delivery and the
history response. They verify the admitted thread and cutoff in the single Slack
API request, the root and earlier messages in chronological order, the count and
UTF-8 limits, and isolation from other threads and rejected inputs. They also
verify deduplication, safe retry after a failed history read, and no history
import on continuation. The worker checks exercise the actual prompt builder and
exact-session verifier. They verify separation of earlier data from the current
request, rejection of invalid context, and failure on a missing native session.

## Rollout

Use the worker build from this revision before routing Slack events to the new
gateway. The gateway supplies the context in the job and the updated worker
places it in Pi's first prompt.

The bot installation uses the public-channel `channels:history` grant for
[Slack's thread replies method](https://docs.slack.dev/reference/methods/conversations.replies/).
