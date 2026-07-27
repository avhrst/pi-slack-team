# Slack app setup

Each runtime instance requires its own Slack app, bot token, app-level Socket Mode token, and immutable app ID. Do not reuse one Slack app across multiple Unix agents.

## 1. Choose a public manifest

Import one of these files in the Slack app configuration UI:

- [worker-agent.example.yaml](../manifests/worker-agent.example.yaml) — DMs and explicit mentions only;
- [manager-agent.example.yaml](../manifests/manager-agent.example.yaml) — worker events plus ordinary public/private channel messages.

Customize only display information and suggested prompts at first. Neither manifest contains workspace IDs, app IDs, user IDs, tokens, webhook URLs, or other secrets.

The examples intentionally disable Slack interactivity. Pi confirmation/select/input requests are handled as authenticated text replies in the originating Slack thread.

## 2. Create the Slack app

1. Open the Slack API app-management page.
2. Choose **Create New App → From an app manifest**.
3. Select the target workspace.
4. Paste the selected YAML manifest.
5. Review scopes and event subscriptions, then create the app.

For an existing app, update its manifest or edit **Event Subscriptions → Subscribe to bot events** directly.

### Event differences

| Event | Worker | Manager | Purpose |
| --- | :---: | :---: | --- |
| `app_home_opened` | Yes | Yes | Presence only; never creates a Pi session |
| `assistant_thread_started` | Yes | Yes | Slack Agent lifecycle; session creation remains lazy |
| `message.im` | Yes | Yes | Direct messages |
| `app_mention` | Yes | Yes | Explicit public/private channel requests |
| `message.channels` | No | Yes | Ambient public-channel observation |
| `message.groups` | No | Yes | Ambient private-channel observation |

### Bot scopes

The base examples request:

| Scope | Why it is needed |
| --- | --- |
| `app_mentions:read` | Receive explicit channel mentions |
| `assistant:write` | Use Slack Agent view |
| `channels:history` | Read public-channel messages and bootstrap thread context |
| `groups:history` | Read private-channel messages and bootstrap thread context |
| `im:history` | Receive/read direct-message context |
| `chat:write` | Publish progress, final responses, and Pi UI prompts |

Add `files:read` only for an agent whose runtime config explicitly enables `slack.fileUploads`. Avoid adding unrelated scopes.

## 3. Enable Socket Mode

1. Open **Socket Mode** for the app and enable it.
2. Create an app-level token with only `connections:write`.
3. Store the resulting app-level token outside Git.

Socket Mode avoids a public HTTP event endpoint. The long-lived runtime opens the WebSocket connection itself.

## 4. Install the app

1. Open **OAuth & Permissions**.
2. Install or reinstall the app to the workspace.
3. Store the bot OAuth token outside Git.
4. Reinstall after adding a new OAuth scope. Event-subscription-only changes normally do not require new scopes, but they must still be saved in Slack.

Never place either token in:

- a committed YAML manifest or runtime config;
- a command-line argument;
- an issue, chat message, or build log;
- SQLite or a Pi session prompt.

## 5. Collect non-secret IDs

The runtime config needs:

- workspace/team ID (`T…`);
- Slack app ID (`A…`);
- one or more authorized human user IDs (`U…` or `W…`).

These are identifiers, not credentials, but production values should still stay in the machine-specific config rather than public examples. The example configs use synthetic IDs.

The app ID is shown under **Basic Information**. Human user IDs are available from the Slack profile menu. The bot user ID is reported as `botUserId` in the runtime's `slack_connected` log after a successful canary connection. Ensure `allowedUserIds` contains humans who are authorized to invoke every tool available to that Unix agent. Never put bot IDs in this human allowlist; use `interAgent.peers` for explicit manager/worker trust.

## 6. Create runtime configuration

Start from:

- [config/worker.example.yaml](../config/worker.example.yaml) for a worker;
- [config/manager.example.yaml](../config/manager.example.yaml) for a manager.

Set absolute paths and replace all synthetic Slack IDs. Role and manifest must agree:

```yaml
version: 1
agentId: coordinator
role: manager
expectedUnixUser: coordinator-agent
stateDir: /home/coordinator-agent/.local/state/pi-slack-team

slack:
  teamId: T0000000000
  appId: A0000000000
  allowedUserIds:
    - U0000000000
  progressMode: summary

# Optional manager example. Put the reciprocal manager identity on the worker.
interAgent:
  peers:
    - agentId: specialist
      role: worker
      appId: A00000000000
      botUserId: U00000000000

pi:
  command: /usr/bin/pi
  cwd: /home/coordinator-agent
  agentDir: /home/coordinator-agent/.pi/agent
  sessionDir: /home/coordinator-agent/.pi/agent/sessions
  maxActiveSessions: 1
  idleTimeoutMs: 300000
  requestTimeoutMs: 30000
```

The process verifies the configured Unix username before loading Slack credentials.

## 7. Install credentials

### Production with systemd

The provided unit loads two root-managed credential files:

```text
/etc/pi-slack-team/credentials/<unix-user>/slack_bot_token
/etc/pi-slack-team/credentials/<unix-user>/slack_app_token
```

Each source environment file must be a regular mode-`0600` file containing exactly `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`. Import it without printing token values:

```bash
node deploy/import-env-credentials.mjs \
  /home/<unix-user>/.env \
  /etc/pi-slack-team/credentials/<unix-user>
```

The importer creates root-owned mode-`0600` files and refuses to overwrite different existing credentials.

### Local development

For local-only testing, add a `credentials` block pointing to absolute owner-readable files:

```yaml
credentials:
  botTokenFile: /secure/path/slack_bot_token
  appTokenFile: /secure/path/slack_app_token
```

Do not commit this block with real paths if those paths reveal private infrastructure.

## 8. Invite the app to channels

A manager can observe only channels whose events Slack delivers to that bot identity. Invite it deliberately to each public/private channel in scope.

Channel membership is not authorization. A human message still must come from `allowedUserIds` before Pi runs. Ordinary bot-authored messages are ignored to prevent loops. Inter-agent messages require a reciprocal peer entry plus an exact sender app ID, bot user ID, role/direction, explicit mention, and correlation envelope.

For delegation, invite both the manager and target worker app to the same channel. Slack app DMs cannot be shared with another app, so `delegate_to_worker` intentionally rejects DM conversations.

## 9. Validate and start

Build once:

```bash
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm check
corepack pnpm build
```

Run `doctor` as the configured Unix account in an environment where credentials are readable:

```bash
node dist/main.js doctor --config /absolute/path/agent.yaml
```

Then start directly for local testing or enable the systemd instance:

```bash
node dist/main.js start --config /absolute/path/agent.yaml

# Production example
systemctl enable --now pi-slack-team@<unix-user>.service
```

## 10. Canary checklist

### Worker

- Authorized DM creates one Pi session and one final response.
- Authorized channel mention creates/resumes the correct thread session.
- An unmentioned channel message creates no session.
- Unauthorized and ordinary bot-authored messages create no session.
- A repeated Slack event executes no second Pi turn.

### Manager

Complete the worker checks, then:

- An authorized human message without a mention reaches the manager.
- No `Working…` message appears for an ambient observation.
- Routine conversation can complete silently.
- A clearly actionable message can produce one threaded response or allowed tool action.
- Bot and unauthorized-user messages create no Pi session.
- Public and private channel delivery are tested separately when both are required.

### Inter-agent delegation

Complete both role checklists, then:

- Reciprocal peer entries use the exact `appId` and logged `botUserId` of the other runtime.
- Both apps are members of the canary channel.
- The manager lists `delegate_to_worker` in its Pi tools and can delegate a harmless read-only task.
- The worker request and response stay in the originating thread, and the response returns to the current manager turn.
- A malformed marker, unconfigured bot, ordinary bot message, attachment, and DM delegation fail closed.
- An unmatched worker confirmation/select request is cancelled and reported as a blocker rather than approved by a bot; any configured `pi.autoSelect` rule matches only its exact select title and option.

## Troubleshooting

### DMs work, but ambient manager messages do not arrive

Check all of the following:

1. Runtime config says `role: manager`.
2. Slack bot events include `message.channels` and/or `message.groups`.
3. The app was invited to the channel.
4. The sender is in `allowedUserIds`.
5. The app was reinstalled if scopes changed.
6. Runtime logs show `slack_connected` with `role: manager`.

A working `@mention` proves `app_mention`, not `message.channels`; always test one message without a mention.

### `delegate_to_worker` is missing or times out

Check all of the following:

1. The manager config has at least one `interAgent.peers` entry with `role: worker`.
2. The worker has the reciprocal manager entry; both sender `appId` and `botUserId` are exact.
3. Both services were restarted after config changes, and the manager log contains `inter_agent_gateway_started`.
4. Both apps are installed in the same workspace and invited to the current `C…`/`G…` channel.
5. The worker manifest subscribes to `app_mention` and the manager manifest receives worker mentions.
6. Runtime logs contain `inter_agent_delegation_started` and either `inter_agent_delegation_completed`, an ignored-event reason, or an orphan/mismatch warning.

Do not add bot IDs to `allowedUserIds`, enable all bot messages, or remove correlation checks as a workaround.

### `missing_scope`

Compare installed scopes with the manifest. Add only the missing documented scope and reinstall the app.

### `wrong-team` or `wrong-app`

The event does not belong to the immutable workspace/app identity configured for this runtime. Correct the machine config rather than weakening the check.

### Socket Mode cannot connect

Verify that Socket Mode is enabled and the app-level token has `connections:write`. A bot OAuth token cannot replace the app-level token.

### Manager responds too often

Tighten the manager's Pi instructions, narrow channel membership and `allowedUserIds`, and require a clear durable outcome before side effects. Do not remove the runtime authorization checks.
