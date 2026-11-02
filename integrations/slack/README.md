# Slack app configuration

`manifest.yaml` is the minimum template for the accepted mention, thread,
attachment, response, and progress-reaction behavior under the proposed O01
channel scope. It intentionally uses a placeholder app name and non-routable
request URL so each deployment can supply its own app identity and gateway
endpoint.

The template subscribes to public- and private-channel message events so an
ordinary reply can continue an activated thread. That channel-only selection,
including invited private channels and deferred DMs, is proposed O01 and has not
been accepted. Review O01 in the
[canonical specification](../../docs/spec/v1.md#10-open-review-points) before
configuring event subscriptions; revise these subscriptions and scopes if that
decision changes. Under O01, runtime configuration must enforce the
enabled-channel allowlist and ignore bot messages. The broad `*:history` and
`files:read` scopes are needed for the specified inputs, so install the app only
in the intended workspace and invite it only to enabled private channels.

`proposed-controls-and-feedback.yaml` is an overlay for the still-proposed
Stop/Status controls and thumbs feedback. It is deliberately excluded from the
baseline manifest. `reactions:write` remains in the baseline because the
accepted progress behavior uses an acknowledgement reaction; `reactions:read` is
only needed for feedback events.

## Create an app shell

In [Slack app management](https://api.slack.com/apps), choose **Create an app**,
start with a blank app, and select the display name and intended workspace. An
uninstalled app shell can exist before the gateway is deployed. Leave event
subscriptions and interactivity unconfigured until a real HTTPS endpoint exists.

## Validate before applying the manifest

1. Replace both `REPLACE-ME` values with the chosen app and bot display name.
2. Replace `example.invalid` with the deployed HTTPS gateway endpoint. Slack
   requires a valid request URL (or Socket Mode) for event subscriptions; this
   project uses HTTP request URLs.
3. With a Slack app configuration token that has `app_configurations:write`,
   validate the complete manifest using the official
   [`apps.manifest.validate`](https://docs.slack.dev/reference/methods/apps.manifest.validate/)
   API. The official Slack CLI exposes the same method as
   `slack api apps.manifest.validate`.
4. After linking a Slack CLI project whose manifest hook returns this file, the
   equivalent project command is `slack manifest validate`. Do not infer that
   `slack run` hosts this webhook application; it does not replace the Vercel
   gateway.
5. Apply the complete manifest only after validation passes. Reinstall the app
   if scopes or event subscriptions change.

Complete remote validation, URL verification, and installation after choosing
the enabled test channels and deploying the gateway. Sending test messages is a
separate end-to-end verification step.
