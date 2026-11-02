# Contracts

This package defines the versioned worker job and result exchanged between the
gateway and worker. It does not expose Slack SDK or Pi-specific types.

Milestone 1 uses a canned fake worker to verify admission, callback
authentication, and same-thread publication. Pi, Sandbox, and Drive behavior is
added in later slices.
