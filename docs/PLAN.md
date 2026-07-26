# pi-slack-team implementation plan

## Goal

Give every Linux-isolated Pi agent its own Slack app. Each new Slack Agent chat creates a distinct persistent Pi session; subsequent messages in the same Slack thread resume that session.

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
3. The first authorized `message.im` in a new root/thread creates a persistent Pi session.
4. Replies in that thread resume the same session.
5. A different Slack thread creates a different Pi session.
6. Mapping survives worker and Pi subprocess restarts.
7. Active same-thread inputs are queued deterministically; explicit steering is a separate action.
8. Idle Pi processes may stop while their session files remain resumable.

## Delivery sequence

### 1. Architecture and scaffold

- TypeScript ESM project with pinned dependencies and lockfile
- build, lint, typecheck, test, and CI
- config schema and secret-free example
- ADRs for runtime, mapping, and security

Exit: a clean `pnpm check` and `pnpm build`.

### 2. Slack runtime

- Bolt Socket Mode
- Slack Agent manifest template
- exact workspace/app/user authorization
- immediate event acknowledgement
- duplicate-event suppression
- DM-only MVP

Exit: a canary bot accepts an allowed DM and rejects all other users and event types.

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

## Deferred work

- channel mentions and shared-channel authorization
- file and image input/output
- Git worktree per mutating chat
- high availability for one Slack app
- multi-workspace OAuth distribution
