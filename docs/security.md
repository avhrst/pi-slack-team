# Security model

## Trust boundaries

Slack is a remote command surface for a coding agent. An authorized Slack user can cause the agent to read files, invoke tools, or change state within the Unix account's permissions.

The MVP therefore defaults to:

- `role: worker` by default, accepting direct messages and explicit app mentions only;
- manager channel observation is an explicit opt-in and is limited to Slack channels the app joined;
- a required explicit Slack user allowlist for DMs, mentions, and manager observations;
- one Slack app per Unix agent;
- Slack progress defaults to visible assistant text and tool names only;
- `progressMode: raw` is an explicit per-agent opt-in that exposes tool arguments and output in the authorized conversation;
- private model thinking is never sent to Slack in either progress mode;
- bot-authored channel messages are ignored so managers cannot recursively trigger one another;
- ambient manager turns publish no working/progress message and produce no Slack output when the agent selects the silent decision;
- no message body logging;
- new sessions receive at most 200 prior Slack thread messages and 50,000 characters, marked as untrusted conversation context;
- file uploads are disabled by default and bounded by configured count and size limits;
- accepted files are downloaded only from `files.slack.com` into mode `0600` files under the agent's private state directory;
- no credentials in YAML, SQLite, command-line arguments, or Git.

## Secrets

Production workers read `slack_bot_token` and `slack_app_token` from the systemd credentials directory. Local development may point to owner-readable credential files.

The repository is public. Generic manifests contain scopes and events only; example runtime configs use visibly synthetic IDs. `.gitignore` covers common local secret, token, SQLite, upload, session, and log files. Follow the pre-commit and incident-response rules in [SECURITY.md](../SECURITY.md).

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
