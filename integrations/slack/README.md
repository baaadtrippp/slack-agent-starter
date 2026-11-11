# Slack app configuration

`v1.yaml` is the Slack app manifest for v1. It requests the bot scopes, event
subscriptions, and interactivity that the gateway uses for public-channel
threads, files, progress, Stop and Status, and thumbs feedback.

To install it, follow the [v1 quickstart](../../docs/service-setup.md):

1. Create the app shell and copy its bot token and signing secret, as described
   in [Slack app shell](../../docs/service-setup.md#slack-app-shell).
2. After the gateway is deployed, complete the manifest's placeholders, apply
   it, and reinstall the app, as described in
   [Apply the complete Slack manifest](../../docs/service-setup.md#5-apply-the-complete-slack-manifest).

Manifest validation and Slack URL verification do not prove a complete event
round trip. The
[installation smoke](../../docs/service-setup.md#6-run-the-paid-installation-smoke)
is the live check.
