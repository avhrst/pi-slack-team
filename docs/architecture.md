# Architecture

## Decision

`pi-slack-team` is a standalone per-agent worker. It is not loaded into an existing interactive Pi session.

The worker uses Slack Socket Mode for transport and Pi RPC subprocesses for active conversations. Process isolation is intentional: it keeps headless Pi behavior close to the CLI, preserves the RPC extension UI protocol, and allows idle sessions to hibernate independently.

The Slack/Pi boundary is hidden behind internal adapters so a future SDK-backed runtime can replace RPC without changing routing or persistence.

## Agent roles

`role: worker` is the backward-compatible default. Workers allocate turns only for authorized DMs and explicit channel mentions.

`role: manager` also evaluates ordinary human messages delivered from public and private channels that the Slack app has joined. Ambient messages are wrapped as untrusted observations with sender/channel metadata. The manager may use its configured tools (for example Jira) and publish a threaded response when intervention is useful, or return the internal silent marker to produce no Slack output. Ambient turns never post a working/progress message. Explicit DMs and mentions retain normal worker behavior.

Manager delivery requires the Slack app event subscriptions `message.channels` and `message.groups`. Runtime authorization still requires `allowedUserIds`, and bot messages are ignored to prevent agent loops.

## Identity boundary

One tuple is immutable for the life of a worker:

```text
agentId -> Unix UID -> Slack workspace -> Slack app -> bot identity
```

The process refuses to start when the configured Unix username differs from its effective username. It also verifies incoming workspace and app IDs and uses a required Slack user allowlist.

## Conversation identity

The durable Slack conversation key is:

```text
(team_id, app_id, channel_id, thread_ts)
```

For a root message without `thread_ts`, its own `ts` becomes the thread root. The first qualifying message owns the conversation. Workers reject takeover attempts. Managers allow other authorized humans to contribute channel turns to the same session while retaining the first owner for interactive Pi confirmations.

When that first qualifying message creates a Pi session, the worker scans Slack thread history up to the triggering message and injects a bounded snapshot containing the root plus the most recent prior replies. The root message supplies the derived thread title. Prior messages, authors, timestamps, and file metadata are injected as explicitly untrusted user context; the triggering request is kept separate. Resumed Pi sessions do not receive the full transcript again.

## Process model

- One long-lived Slack runtime worker per agent, independent of the configured agent role.
- Zero or more active Pi RPC subprocesses inside the worker's systemd cgroup.
- One Pi process per active Slack conversation.
- Persistent Pi session file survives process hibernation.
- Per-conversation queue serializes input.
- A global semaphore limits simultaneous active turns.

## Storage

SQLite contains routing state, event IDs, and pending interaction metadata. It never contains Slack or model credentials.

Pi remains the source of truth for conversation history. SQLite stores only the path and ID required to resume that Pi session.
