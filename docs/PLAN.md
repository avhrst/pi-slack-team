# pi-slack-team implementation plan

## Goal

Give every Linux-isolated Pi agent its own Slack app. Each agent is configured as a `worker` or `manager`. Each new qualifying Slack chat creates a distinct persistent Pi session; subsequent messages in the same Slack thread resume that session. Optionally let a manager delegate to explicitly configured workers and receive their correlated results without accepting ordinary bot messages or sharing Unix credentials.

## Architecture

One systemd worker runs per agent account:

```text
Slack user
    |
    v
Dedicated Slack app (unique xapp + xoxb)
    |
    v
pi-slack-team@<agent>.service (User=<agent>)
    |
    +-- Slack adapter
    +-- authorization and event deduplication
    +-- Slack thread -> Pi session registry
    +-- per-user SQLite state
    |
    +-- active chat A -> Pi RPC -> session A.jsonl
    +-- active chat B -> Pi RPC -> session B.jsonl
```

There is no root message broker and no shared Slack app token. Each worker inherits only the target Unix user's home, Pi configuration, credentials, skills, extensions, and session store.

## Chat/session contract

1. `app_home_opened` is presence only and never creates a Pi session.
2. `assistant_thread_started` may register Slack metadata but session allocation remains lazy.
3. The first authorized `message.im` or `app_mention` in a new root/thread creates a persistent Pi session.
4. For `role: worker`, later channel turns must explicitly mention the agent.
5. For `role: manager`, authorized human `message.channels` and `message.groups` events also resume or create the thread session; the agent decides whether to act/respond or remain silent.
6. A configured manager may call `delegate_to_worker` only from a shared channel thread; the worker response resolves that pending tool call without a second manager Pi turn.
7. A different Slack thread creates a different Pi session.
8. Mapping survives runtime worker and Pi subprocess restarts; an in-flight delegation wait intentionally does not.
9. Active same-thread inputs are queued deterministically; explicit steering is a separate action.
10. Idle Pi processes may stop while their session files remain resumable.

## Delivery sequence

### 1. Architecture and scaffold

- TypeScript ESM project with pinned dependencies and lockfile
- build, lint, typecheck, test, and CI
- config schema and secret-free example
- ADRs for runtime, mapping, and security

Exit: a clean `pnpm check` and `pnpm build`.

### 2. Slack runtime

- Bolt Socket Mode
- secret-free worker and manager Slack Agent manifest examples
- exact workspace/app/user authorization
- immediate event acknowledgement
- duplicate-event suppression
- DMs and explicit channel mentions for workers
- opt-in ambient public/private channel events for managers, with silent no-op decisions
- reciprocal app/bot-user peer allowlists and correlated manager-to-worker envelopes

Exit: a canary worker accepts an allowed DM or channel mention, a canary manager evaluates an allowed ambient channel message without mandatory output, and both reject unauthorized users.

### 3. Pi RPC runtime

- strict byte-delimited JSONL parser
- request/response correlation
- prompt, follow-up, steer, abort, and session stats
- Pi event streaming
- extension UI request/response transport
- graceful subprocess termination

Exit: mock and real Pi RPC processes pass protocol contract tests.

### 4. Persistent session routing

- SQLite conversation registry
- Slack thread -> Pi session file mapping
- per-thread serialization
- configurable global concurrency
- idle hibernation and resume

Exit: two chats create different sessions and a worker restart resumes both correctly.

### 5. Slack rendering and interactions

- one working message updated at a bounded rate
- final response rendering and safe chunking
- stop action
- `confirm`, `select`, and `input` mapped to authenticated Slack interactions
- generic error responses with correlation IDs

Exit: streaming does not flood Slack and UI responses cannot cross users or chats.

### 6. Security

- required fail-closed Slack allowlist
- fixed workspace, app, Unix identity, cwd, and Pi directories
- systemd credentials instead of token environment values
- token/content redaction
- ordinary bot rejection with exact peer, direction, version, and correlation checks for delegation
- no thinking or raw tool output in Slack by default
- single-use expiring interactive actions
- per-cwd mutation serialization

Exit: the security acceptance suite passes and logs contain no credentials or raw prompts.

### 7. Deployment and rollout

- systemd template and hardening
- `doctor` CLI
- graceful shutdown and recovery
- support-agent canary
- one-at-a-time rollout to remaining agents

Exit: each bot routes exclusively to its Unix agent and one failed worker does not affect the others.

## Acceptance criteria

1. A support bot message is processed only under `support-agent`.
2. Two Slack chats receive different Pi session IDs and JSONL files.
3. The same chat resumes after service restart.
4. Slack retries never execute a prompt twice.
5. Concurrent chats never mix output.
6. An unauthorized Slack user cannot create or resume a session.
7. App-level and bot tokens are unique per agent and absent from logs/state.
8. Interactive requests return only to the originating Pi session.
9. Two mutating chats cannot operate on the same cwd concurrently.
10. A single worker failure leaves all other agent bots healthy.
11. A configured manager can delegate one task to a worker in the same channel thread and receive the result in its current Pi turn.
12. Unconfigured bots, wrong app/bot-user pairs, malformed/orphaned envelopes, DM delegation, and bot approval attempts fail closed; only exact worker-side `pi.autoSelect` standing authorizations may answer delegated select dialogs.

## Deferred work

- shared-channel and Slack Connect authorization
- file and image output
- Git worktree per mutating chat
- high availability for one Slack app
- multi-workspace OAuth distribution
