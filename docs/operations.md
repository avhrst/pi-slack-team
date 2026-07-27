# Operations

## Per-agent files

Recommended production layout:

```text
/opt/pi-slack-team/current/                 immutable application build
/etc/pi-slack-team/<agent>.yaml             secret-free agent config
/etc/pi-slack-team/credentials/<agent>/     root-managed Slack credentials
/home/<agent>/.local/state/pi-slack-team/   SQLite state and optional Slack uploads
/home/<agent>/.pi/agent/                    Pi config, auth, skills, sessions
```

## Onboarding

1. Choose `role: worker` or `role: manager` in the secret-free agent config (`worker` is the default).
2. Create a dedicated Slack app from the manifest template.
3. For a manager, add `message.channels` and `message.groups` bot event subscriptions, then invite the app only to channels it should observe. The existing `channels:history` and `groups:history` scopes are required.
4. Enable Socket Mode and create an app-level token with `connections:write`.
5. Install the app and obtain its bot token.
6. Store both credentials outside Git.
7. Run `pi-slack-team doctor`.
8. Enable one systemd unit.
9. For an upload-enabled agent, add `files:read` to its manifest and set `slack.fileUploads: true`; keep count and byte limits bounded.
10. Complete the canary acceptance test before onboarding another agent.

For initial provisioning, an owner-only agent environment file may be imported
into the root-managed systemd credential directory:

```bash
node deploy/import-env-credentials.mjs \
  /home/support-agent/.env \
  /etc/pi-slack-team/credentials/support-agent
```

The environment file must have mode `0600` and contain exactly
`SLACK_APP_TOKEN` and `SLACK_BOT_TOKEN`. The importer never overwrites a
different existing credential.

## Failure handling

The runtime acknowledges Slack delivery before starting Pi work and records the event ID before prompt submission. A duplicate Slack event is ignored. Manager apps ignore bot-authored events and route explicit mentions through the mention listener so one Slack message cannot execute both an ambient and explicit turn.

On shutdown, the worker stops accepting new events, lets bounded cleanup run, terminates child Pi processes, and closes SQLite. Persistent Pi session files remain available for the next start.
