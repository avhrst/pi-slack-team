# Architecture

## Decision

`pi-slack-team` is a standalone per-agent worker. It is not loaded into an existing interactive Pi session.

The worker uses Slack Socket Mode for transport and Pi RPC subprocesses for active conversations. Process isolation is intentional: it keeps headless Pi behavior close to the CLI, preserves the RPC extension UI protocol, and allows idle sessions to hibernate independently.

The Slack/Pi boundary is hidden behind internal adapters so a future SDK-backed runtime can replace RPC without changing routing or persistence.

## Agent roles

`role: worker` is the backward-compatible default. Workers allocate turns only for authorized DMs and explicit channel mentions.

`role: manager` also evaluates ordinary human messages delivered from public and private channels that the Slack app has joined. Ambient messages are wrapped as untrusted observations with sender/channel metadata. The manager may use its configured tools (for example Jira) and publish a threaded response when intervention is useful, or return the internal silent marker to produce no Slack output. Ambient turns never post a working/progress message. Explicit DMs and mentions retain normal worker behavior.

Manager delivery requires the Slack app event subscriptions `message.channels` and `message.groups`. Runtime authorization still requires `allowedUserIds`. Ordinary bot messages are ignored to prevent agent loops; the only exception is a versioned correlated inter-agent envelope whose sender app ID, bot user ID, role, and direction match `interAgent.peers`.

## Inter-agent delegation

A manager with configured worker peers loads a runtime-owned Pi extension into each RPC process. The extension registers `delegate_to_worker` and connects to a mode-`0600` Unix socket below the manager's private `stateDir`. The child provides its immutable Slack conversation key; the parent verifies that the conversation exists and is a public/private channel thread before posting anything.

```text
manager Pi turn
    │ delegate_to_worker(workerId, task)
    ▼
private same-UID Unix socket
    ▼
manager runtime ── explicit correlated @mention ──► worker Slack app/runtime
    ▲                                                    │
    └──── correlated response chunks in same thread ◄────┘
```

Slack remains the cross-Unix-account transport, so no shared root broker, agent credential, filesystem, or session store is introduced. Both apps must be members of the channel. Requests and responses authenticate the Slack event identity against reciprocal peer configuration. The manager consumes a matching worker response into the pending tool call and does not prompt its LLM again for that bot event. This synchronous correlation boundary prevents unbounded bot-to-bot reply loops.

A worker runs delegated work under its existing isolated account and per-thread session. Interactive dialogs are cancelled for delegated turns unless the worker runtime has an exact `pi.autoSelect` standing authorization for that select title and option; this local policy is not approval transferred to a bot. In-flight manager waits are memory-only and fail on timeout, cancellation, or runtime shutdown. Slack still retains the visible request/result, while the worker session remains persistent.

## Identity boundary

One tuple is immutable for the life of a worker:

```text
agentId -> Unix UID -> Slack workspace -> Slack app -> bot identity
                              └-> explicit opposite-role peer allowlist (optional)
```

The process refuses to start when the configured Unix username differs from its effective username. It also verifies incoming workspace and app IDs and uses a required Slack user allowlist.

## Conversation identity

The durable Slack conversation key is:

```text
(team_id, app_id, channel_id, thread_ts)
```

Slack conversation identity is intentionally separate from Pi session identity. Direct messages use `(team_id, app_id, user_id)`, so every human has an isolated Pi session per agent and new top-level DMs from that human resume it. Public/private channels use `(team_id, app_id, channel_id, thread_ts)`, so each channel thread remains isolated even when the same human starts several threads.

For a root message without `thread_ts`, its own `ts` becomes the Slack thread root. The first qualifying human normally owns the conversation. When a configured manager delegation creates a worker session, that exact manager bot is only a provisional owner: once the turn is idle, the first allowed human explicit mention may atomically claim it. Workers reject later human takeover attempts, while configured manager delegations may continue the human-owned session. Managers allow other authorized humans to contribute channel turns to the same session while retaining the durable owner for interactive Pi confirmations.

When that first qualifying message creates a Pi session, the worker scans Slack thread history up to the triggering message and injects a bounded snapshot containing the root plus the most recent prior replies. The root message supplies the derived thread title. Prior messages, authors, timestamps, and file metadata are injected as explicitly untrusted user context; the triggering request is kept separate. Resumed Pi sessions do not receive the full transcript again.

## Process model

- One long-lived Slack runtime worker per agent, independent of the configured agent role.
- Zero or more active Pi RPC subprocesses inside the worker's systemd cgroup.
- One Pi process per active logical Pi session: direct user or channel thread.
- One private local delegation gateway only for a manager with worker peers.
- Persistent Pi session files survive process hibernation and runtime restarts; OS process IDs do not.
- Per-session queues serialize messages targeting the same Pi process.
- A global semaphore limits simultaneous turns from different sessions.
- A resident-process limit hibernates the least-recent idle process before allocating another.

## Storage

SQLite contains routing state, event IDs, and pending interaction metadata. It never contains Slack or model credentials. Inter-agent response correlation is intentionally in memory; the local Unix socket carries no credential and is accessible only to the manager UID.

Pi remains the source of truth for conversation history. SQLite stores only the path and ID required to resume that Pi session.
