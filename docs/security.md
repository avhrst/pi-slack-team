# Security model

## Trust boundaries

Slack is a remote command surface for a coding agent. An authorized Slack user can cause the agent to read files, invoke tools, or change state within the Unix account's permissions.

The MVP therefore defaults to:

- direct messages and explicit app mentions only;
- a required explicit Slack user allowlist for both DMs and channel mentions;
- one Slack app per Unix agent;
- Slack progress defaults to visible assistant text and tool names only;
- `progressMode: raw` is an explicit per-agent opt-in that exposes tool arguments and output in the authorized conversation;
- private model thinking is never sent to Slack in either progress mode;
- no message body logging;
- file uploads are disabled by default and bounded by configured count and size limits;
- accepted files are downloaded only from `files.slack.com` into mode `0600` files under the agent's private state directory;
- no credentials in YAML, SQLite, command-line arguments, or Git.

## Secrets

Production workers read `slack_bot_token` and `slack_app_token` from the systemd credentials directory. Local development may point to owner-readable credential files.

The repository is public. Examples must always contain placeholders and `.gitignore` covers common local secret files.

## Linux isolation

Workers must not run as root. Each systemd unit sets `User=` and `Group=` to the corresponding agent account. The worker verifies its effective username against config before opening Slack or Pi.

One Unix account cannot provide isolation between its own simultaneous sessions. Until per-chat worktrees exist, mutating work targeting the same cwd must be serialized.

## Interactive requests

Pi confirmation and selection requests are bound to:

- Slack workspace and app;
- channel and thread;
- Slack user;
- Pi conversation;
- opaque one-time request ID;
- expiration time.

Late, duplicate, or cross-user actions fail closed.
