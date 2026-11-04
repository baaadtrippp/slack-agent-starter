# Slack app configuration

`milestone-1.yaml` is the minimal manifest for the initial canned-reply slice.
It subscribes only to `app_mention` and requests `app_mentions:read` and
`chat:write`. It uses placeholders for the app name and gateway HTTPS URL.
Configure only the selected public test channel; any internal member may invoke
the app. The gateway rejects other workspaces and channels, bots, and externally
shared events. Private channels and DMs are disabled.

`manifest.yaml` is the broader future-v1 template for thread continuation,
files, and progress. It includes scopes and events that milestone 1 does not
need. Do not apply it for the canned-reply deployment. Resolve the remaining
open decisions before enabling those later behaviors.

`milestone-9.yaml` adds the `files:read` bot scope to the mention-only
configuration. Reinstall the app after applying it so the installed token can
download the CSV. Invite the app only to the selected public test channel. See
[the CSV tracer](../../docs/spec/milestone-9.md) for the gateway setting.

`milestone-10.yaml` keeps the mention-only configuration and adds the
`files:write` bot scope. Reinstall and verify the installed scope before
enabling the [generated CSV check](../../docs/spec/milestone-10.md).

`proposed-controls-and-feedback.yaml` contains the separate, still-proposed
Stop/Status and feedback overlay. It is not used in milestone 1.

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
