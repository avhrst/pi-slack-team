# Architecture

## Decision

`pi-slack-team` is a standalone per-agent worker. It is not loaded into an existing interactive Pi session.

The worker uses Slack Socket Mode for transport and Pi RPC subprocesses for active conversations. Process isolation is intentional: it keeps headless Pi behavior close to the CLI, preserves the RPC extension UI protocol, and allows idle sessions to hibernate independently.

The Slack/Pi boundary is hidden behind internal adapters so a future SDK-backed runtime can replace RPC without changing routing or persistence.

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

For a root message without `thread_ts`, its own `ts` becomes the thread root. The first qualifying message owns the conversation; the owner cannot be changed by later events.

## Process model

- One long-lived Slack worker per agent.
- Zero or more active Pi RPC subprocesses inside the worker's systemd cgroup.
- One Pi process per active Slack conversation.
- Persistent Pi session file survives process hibernation.
- Per-conversation queue serializes input.
- A global semaphore limits simultaneous active turns.

## Storage

SQLite contains routing state, event IDs, and pending interaction metadata. It never contains Slack or model credentials.

Pi remains the source of truth for conversation history. SQLite stores only the path and ID required to resume that Pi session.
