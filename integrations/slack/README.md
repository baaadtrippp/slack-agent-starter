# Slack app configuration

`manifest.yaml` is the minimum template for the accepted mention, thread,
attachment, response, and progress-reaction behavior under the proposed O01
channel scope. It intentionally uses a placeholder app name and non-routable
request URL because the app identity and deployed gateway endpoint have not been
chosen yet.

The template subscribes to public- and private-channel message events so an
ordinary reply can continue an activated thread. That channel-only selection,
including invited private channels and deferred DMs, is proposed O01 and has not
been accepted. Review O01 in the
[canonical specification](../../docs/spec/v1.md#10-open-review-points) before
creating the app; revise these event subscriptions and scopes if that decision
changes. Under O01, runtime configuration must enforce the enabled-channel
allowlist and ignore bot messages. The broad `*:history` and `files:read` scopes
are needed for the specified inputs, so install the app only in the intended
workspace and invite it only to enabled private channels.

`proposed-controls-and-feedback.yaml` is an overlay for the still-proposed
Stop/Status controls and thumbs feedback. It is deliberately excluded from the
baseline manifest. `reactions:write` remains in the baseline because the
accepted progress behavior uses an acknowledgement reaction; `reactions:read` is
only needed for feedback events.

## Validate before creation

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
5. Create or update the app only after validation passes. Reinstall the app if
   scopes or event subscriptions change.

Remote validation, URL verification, installation, and event delivery are
pending until the app name, enabled test channels, and real gateway URL exist.
No Slack message should be sent during phase 0.
