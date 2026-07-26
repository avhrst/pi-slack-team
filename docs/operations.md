# Operations

## Per-agent files

Recommended production layout:

```text
/opt/pi-slack-team/current/                 immutable application build
/etc/pi-slack-team/<agent>.yaml             secret-free agent config
/etc/pi-slack-team/credentials/<agent>/     root-managed Slack credentials
/home/<agent>/.local/state/pi-slack-team/   SQLite state
/home/<agent>/.pi/agent/                    Pi config, auth, skills, sessions
```

## Onboarding

1. Create a dedicated Slack app from the manifest template.
2. Enable Socket Mode and create an app-level token with `connections:write`.
3. Install the app and obtain its bot token.
4. Store both credentials outside Git.
5. Create the secret-free agent config.
6. Run `pi-slack-team doctor`.
7. Enable one systemd unit.
8. Complete the canary acceptance test before onboarding another agent.

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

The worker acknowledges Slack delivery before starting Pi work and records the event ID before prompt submission. A duplicate Slack event is ignored.

On shutdown, the worker stops accepting new events, lets bounded cleanup run, terminates child Pi processes, and closes SQLite. Persistent Pi session files remain available for the next start.
