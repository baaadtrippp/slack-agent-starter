# Slack app configuration

`milestone-1.yaml` is the minimal manifest for the initial canned-reply slice.
It subscribes only to `app_mention` and requests `app_mentions:read` and
`chat:write`. It uses placeholders for the app name and gateway HTTPS URL.
Configure only the selected public test channel; any internal member may invoke
the app. The gateway rejects other workspaces and channels, bots, and externally
shared events. Private channels and DMs are disabled.

`manifest.yaml` is the broader future-v1 template for thread continuation,
files, and progress. It includes scopes and events that milestone 1 does not
need. Do not apply it for the canned-reply deployment.

`milestone-9.yaml` adds the `files:read` bot scope to the mention-only
configuration. Reinstall the app after applying it so the installed token can
download the CSV. Invite the app only to the selected public test channel. See
[the CSV tracer](../../docs/spec/milestone-9.md) for the gateway setting.

`milestone-10.yaml` keeps the mention-only configuration and adds the
`files:write` bot scope. Reinstall and verify the installed scope before
enabling the [generated CSV check](../../docs/spec/milestone-10.md).

`proposed-controls-and-feedback.yaml` records the earlier review overlay for
Stop/Status and feedback. It is not a complete manifest.

`f07-progress.yaml` is the complete minimal manifest for progress with the
existing public-channel continuation and file paths. It adds `reactions:write`
for the acknowledgement and uses `chat:write` for status creation and edits.
`channels:history` and `message.channels` enable ordinary thread replies; the
gateway still filters to configured channels. No reaction-read subscription,
private-channel access, interactivity, or assistant scope is required.

For an F07-only installation, keep its current name, bot display name, and event
URL in the placeholders. In Slack app management, open that app's **App
Manifest**, replace it with the completed file, validate, and save. If Slack
requests installation for the added scopes, use **Install to Workspace** for
this same app. Verify the installed token has `reactions:write`; saving a
manifest alone does not grant it. Keep the app invited only to the selected test
channel. A failed acknowledgement reaction never prevents the status or answer.

`f09-f11-controls-feedback.yaml` is the complete public-channel manifest for the
accepted Stop/Status controls and thumbs feedback. It keeps the established
thread, file, artifact, and progress scopes. `reactions:read` receives feedback,
`users:read` verifies the actor belongs to the installed workspace, and
`channels:read` rejects a configured public channel if it later becomes private,
pending external sharing, or Slack Connect. The manifest subscribes to reaction
additions and removals and enables the signed `/api/slack/interactions`
endpoint. Stop and Status buttons require no additional OAuth scope.

To update the installed app, keep its existing identity and both deployed HTTPS
URLs in the placeholders. Validate and save the manifest, then reinstall the
same app so its bot token receives the three added read scopes. Confirm both
request URLs before the acceptance check. Saving the event subscriptions or
interactivity settings does not prove delivery, and the live Slack check remains
a separate acceptance step.

Stage the matching worker files described in the
[worker setup](../../apps/worker/README.md). Before enabling
`SLACK_CONTROLS_AND_FEEDBACK` on the candidate gateway, run
`node apps/gateway/scripts/backfill-feedback-index.mjs` once with the target
gateway's `REDIS_URL` in the environment. The script indexes existing confirmed
final answers without altering their run records. It can be rerun safely. Set
`SLACK_STOP_OPERATOR_IDS` only for the intended internal operators. Preserve the
existing route and matching worker build for rollback during acceptance.

## Create an app shell

In [Slack app management](https://api.slack.com/apps), create a blank app in the
intended workspace. Leave event subscriptions and interactivity unconfigured
until the gateway has a public HTTPS endpoint.

## Apply the milestone-1 manifest

1. Replace both `REPLACE-ME` placeholders with the app and bot display names.
2. Replace `example.invalid` with the gateway's deployed HTTPS
   `/api/slack/events` URL.
3. Validate with Slack's official manifest API or the Slack CLI.
4. Apply the validated `milestone-1.yaml`, then install the app.
5. Invite the bot only to the selected public test channel.

Manifest validation and Slack URL verification do not prove a complete event
round trip. Record the live Slack check separately.
