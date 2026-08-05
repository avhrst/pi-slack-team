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
2. Create a dedicated Slack app from the matching public template: [worker](../manifests/worker-agent.example.yaml) or [manager](../manifests/manager-agent.example.yaml).
3. For a manager, verify `message.channels` and `message.groups` bot event subscriptions, then invite the app only to channels it should observe. The existing `channels:history` and `groups:history` scopes are required.
4. Enable Socket Mode and create an app-level token with `connections:write`.
5. Install the app and obtain its bot token.
6. Store both credentials outside Git.
7. Run `pi-slack-team doctor`.
8. Enable one systemd unit.
9. For an upload-enabled agent, add `files:read` to its manifest and set `slack.fileUploads: true`; keep count and byte limits bounded.
10. For manager-to-worker delegation, add reciprocal `interAgent.peers` entries using the sender app ID and the `botUserId` logged by `slack_connected`; invite both apps to every channel where delegation is allowed.
11. Complete the canary acceptance test before onboarding another agent.

For initial provisioning, an owner-only agent environment file may be imported
into the root-managed systemd credential directory:

```bash
node deploy/import-env-credentials.mjs \
  /home/support-agent/.env \
  /etc/pi-slack-team/credentials/support-agent
```

The environment file must have mode `0600` and contain exactly
`SLACK_APP_TOKEN` and `SLACK_BOT_TOKEN`. The importer never prints values or
overwrites a different existing credential.

## Canary rollout

Roll out one runtime at a time. Before restart, verify that it has no active Pi child process or `running` conversation record.

For every role:

1. Confirm `slack_connected` reports the expected `agentId`, role, team, and bot user.
2. Send one authorized DM and verify exactly one Pi turn and final response.
3. Retry the same event or inspect deduplication tests; it must not execute twice.
4. Confirm an unauthorized human and a bot cannot allocate a session.
5. Restart the runtime and verify an existing Slack thread resumes its Pi session.

For a worker, verify an ordinary channel message is ignored and an explicit mention is accepted.

For a manager, send an authorized human channel message **without** a mention. A working mention validates only `app_mention`, not `message.channels`. Verify that ambient evaluation posts no progress message and can remain silent. Test public and private channels independently when both are in scope.

For each configured manager/worker pair:

1. Verify both `slack_connected` identities against the reciprocal peer entries.
2. Invite both apps to one bounded canary channel.
3. Ask the manager to delegate a harmless read-only task with `delegate_to_worker`.
4. Verify one correlated manager mention, one worker turn, and one result returned inside the original manager turn.
5. Verify an ordinary bot message, a wrong app ID, a malformed marker, and a worker response without a pending request do not allocate a Pi turn.
6. Restart the manager during a harmless in-flight canary and verify the wait fails closed; do not use a destructive task for this test.

See [Slack app setup](slack-setup.md#10-canary-checklist) for the full checklist and troubleshooting.

## Changing roles

Changing config alone is insufficient when promoting a worker to manager. Slack must also have `message.channels` and `message.groups` in bot event subscriptions. Apply the manager manifest, save the Slack configuration, invite the app to bounded channels, restart, and perform an unmentioned-message canary.

Demoting a manager to worker takes effect at the runtime authorization layer immediately after restart. Remove the ambient Slack event subscriptions as defense in depth and reduce unnecessary event delivery.

## Failure handling

The runtime acknowledges Slack delivery before starting Pi work and records the event ID before prompt submission. A duplicate Slack event is ignored. Manager apps ignore ordinary bot-authored events and route explicit mentions through the mention listener so one Slack message cannot execute both an ambient and explicit turn. A valid correlated worker response is consumed before UI or chat routing and resolves only its matching pending delegation.

Progress updates are bounded independently from final responses. If Slack rejects a `progressMode: raw` update, the current turn retries immediately with compact summary progress and stays in summary mode. A `slack_progress_update_failed` warning records `updateAttempt: configured`; `updateAttempt: summary-fallback` means Slack also rejected the fallback and may indicate a broader Slack API incident. Progress failure never suppresses the separately posted final answer.

Summary mode ignores ordinary partial tool output. A long deployment can opt in to live safe updates by emitting `PI_DEPLOY_PROGRESS` followed by one-line JSON with version `1`, stage `apex` or `sql-files`, consistent non-negative counters, state `running`/`completed`, and an optional uppercase TT identifier. The bridge renders only validated fields; it never includes the marker JSON, adjacent output, commands, or SQL logs.

An automatic Pi selection logs `pi_ui_auto_selected` with its zero-based configuration rule index, but not the title or option text. Treat changes to `pi.autoSelect` as production authorization changes: validate the exact extension strings, restart only while conversations are idle, and canary both a matching selection and an unmatched cancellation.

On shutdown, the worker stops accepting new events, lets bounded cleanup run, terminates child Pi processes, and closes SQLite. A manager also closes its private delegation socket and rejects pending waits. Persistent Pi session files remain available for the next start.
