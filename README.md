# pi-slack-team

Run one Slack app per Linux-isolated [Pi coding agent](https://github.com/earendil-works/pi) and map each Slack DM or channel thread to a persistent Pi session.

`pi-slack-team` is a standalone Node.js runtime, not an extension attached to an already-running interactive Pi session. It connects to Slack over Socket Mode, starts headless Pi RPC subprocesses on demand, streams safe progress, and resumes conversation state after idle hibernation or service restarts.

> **Security status:** this project is pre-1.0 and exposes coding-agent tools through Slack. Start with a non-production canary, use a strict human allowlist, and read [the security model](docs/security.md) before deployment.

## Highlights

- One immutable identity chain per runtime: Slack app → Unix account → Pi agent.
- Two roles: on-demand `worker` and proactive `manager`.
- Opt-in, correlated manager-to-worker delegation in a shared Slack thread.
- Exact Slack workspace, app, human-user, and inter-agent peer authorization.
- One persistent Pi JSONL session per Slack DM/thread.
- Bounded untrusted Slack thread history for new sessions.
- Event deduplication and per-thread serial execution.
- Global concurrency limit and idle Pi-process hibernation.
- Slack rendering for progress, final output, and Pi UI requests.
- Optional bounded Slack file downloads into private storage.
- SQLite routing state with no Slack/model credentials.
- systemd credentials and a hardened per-agent service template.

## Roles

Set the role in each secret-free runtime configuration:

```yaml
role: worker # or manager
```

`worker` is the backward-compatible default.

| Behavior | `worker` | `manager` |
| --- | :---: | :---: |
| Authorized direct messages | Yes | Yes |
| Explicit channel `@mention` | Yes | Yes |
| Ordinary authorized human messages in joined channels | No | Yes |
| Ordinary bot-authored or unauthorized messages | Ignored | Ignored |
| Authenticated inter-agent request/response envelope | Accepted from configured managers | Accepted from configured workers |
| Ambient turn may remain completely silent | N/A | Yes |

### Worker

A worker is an on-demand specialist. It receives authorized DMs and explicit `@agent` mentions. Ordinary channel conversation cannot allocate a Pi session or invoke tools.

Use [the public worker manifest](manifests/worker-agent.example.yaml) and [the worker config example](config/worker.example.yaml).

### Manager

A manager receives the worker events plus authorized human messages in every public/private channel the app has joined. Each ambient message is presented to Pi as untrusted context. The agent decides whether to:

- perform an allowed action and report the result;
- ask one material clarification in the Slack thread;
- remain silent.

Ambient manager turns never publish `Working…` or tool progress. This avoids flooding channels when no intervention is useful.

The runtime itself is not Jira-specific. A manager can create Jira work only when its Pi account has Jira tools and its agent instructions authorize that behavior. Good manager instructions should require duplicate search, a clear project/scope, and no sensitive data in tickets.

When `interAgent.peers` is configured on both sides, manager Pi sessions for shared channel threads also receive a `delegate_to_worker` tool. It posts a correlated explicit mention in the originating shared Slack thread, waits for the configured worker's response, and returns that response to the manager's current turn. Ordinary bot messages remain rejected; both the sender app ID and bot user ID must match the peer allowlist.

Use [the public manager manifest](manifests/manager-agent.example.yaml) and [the manager config example](config/manager.example.yaml). See [Agent roles](docs/roles.md) for the complete contract.

## Architecture

```text
Authorized Slack user
        │
        ▼
Dedicated Slack app (Socket Mode)
        │
        ▼
pi-slack-team runtime (one Unix account)
        │
        ├── authorization + event deduplication
        ├── Slack thread → Pi session registry (SQLite)
        ├── per-thread queue + global semaphore
        ├── manager tool ↔ private Unix IPC ↔ correlated Slack peer envelope
        │
        ├── active chat A → Pi RPC → session A.jsonl
        └── active chat B → Pi RPC → session B.jsonl
```

A runtime owns exactly one Slack app connection and runs as exactly one Unix user. Pi inherits only that user's working directory, agent instructions, tools, credentials, sessions, and OS permissions.

The durable conversation key is:

```text
(team_id, app_id, channel_id, thread_ts)
```

A root message uses its own timestamp as the thread root. New sessions receive a bounded snapshot of prior thread messages marked as untrusted user context. Resumed sessions continue from Pi's JSONL session file.

Read [Architecture](docs/architecture.md) for process, identity, ownership, and storage details.

## Requirements

- Linux for the production isolation model and systemd unit.
- Node.js 24 or newer.
- Corepack and pnpm.
- Pi CLI installed at an absolute path (default `/usr/bin/pi`).
- One Slack app per runtime instance.
- A dedicated non-root Unix account per security boundary.

## Quick start

### 1. Install and verify

```bash
git clone https://github.com/avhrst/pi-slack-team.git
cd pi-slack-team
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm check
corepack pnpm build
```

### 2. Create a Slack app

Choose exactly one public manifest:

- [`manifests/worker-agent.example.yaml`](manifests/worker-agent.example.yaml)
- [`manifests/manager-agent.example.yaml`](manifests/manager-agent.example.yaml)

Import it through **Create New App → From an app manifest**, enable Socket Mode, create an app-level token with `connections:write`, and install the app to obtain its bot token.

Manager delivery requires both `message.channels` and `message.groups`. A working `@mention` proves only the `app_mention` subscription; always canary-test an ordinary message without a mention.

Follow [Slack app setup](docs/slack-setup.md) for scopes, IDs, channel invitations, credential handling, and troubleshooting.

### 3. Create secret-free runtime configuration

Start from a checked-in example:

```bash
cp config/worker.example.yaml /absolute/private/path/worker.yaml
# or
cp config/manager.example.yaml /absolute/private/path/manager.yaml
```

Replace the synthetic IDs and all paths. Keep real deployment configuration outside this public repository.

Minimal shape:

```yaml
version: 1
agentId: example
role: worker
expectedUnixUser: example-agent
stateDir: /home/example-agent/.local/state/pi-slack-team

slack:
  teamId: T0000000000
  appId: A0000000000
  allowedUserIds:
    - U0000000000
  progressMode: summary

pi:
  command: /usr/bin/pi
  cwd: /home/example-agent
  agentDir: /home/example-agent/.pi/agent
  sessionDir: /home/example-agent/.pi/agent/sessions
  maxActiveSessions: 1
  idleTimeoutMs: 300000
  requestTimeoutMs: 30000
```

All Slack IDs above are synthetic placeholders.

### 4. Install credentials

Production instances read credentials through systemd, not YAML or environment variables inherited by the long-lived process:

```text
$CREDENTIALS_DIRECTORY/slack_bot_token
$CREDENTIALS_DIRECTORY/slack_app_token
```

An owner-only provisioning file can be imported into the root-managed credential directory:

```bash
chmod 0600 /home/<unix-user>/.env
node deploy/import-env-credentials.mjs \
  /home/<unix-user>/.env \
  /etc/pi-slack-team/credentials/<unix-user>
```

The source file must contain exactly `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`. The importer validates formats and permissions, never prints values, and refuses to overwrite a different credential.

For local development only, config may point to absolute owner-readable token files via the optional `credentials` block. Never commit those paths with real credentials.

### 5. Validate and run

Run commands as the configured Unix account:

```bash
node dist/main.js doctor --config /absolute/private/path/agent.yaml
node dist/main.js start --config /absolute/private/path/agent.yaml
```

`doctor` checks Unix identity, state storage, credential readability, and Pi availability without printing secret values.

## Configuration reference

The schema is strict: unknown keys and invalid IDs fail startup.

### Top level

| Field | Required | Default | Description |
| --- | :---: | --- | --- |
| `version` | Yes | — | Must currently be `1` |
| `agentId` | Yes | — | Stable lowercase runtime identifier |
| `role` | No | `worker` | `worker` or `manager` event policy |
| `expectedUnixUser` | Yes | — | Effective Unix user required at startup |
| `stateDir` | Yes | — | Private SQLite, manager IPC socket, and optional upload storage |
| `interAgent` | No | disabled | Explicit opposite-role Slack app peers and delegation bounds |
| `credentials` | No | systemd | Local-only absolute token-file paths |

### `slack`

| Field | Required | Default | Description |
| --- | :---: | --- | --- |
| `teamId` | Yes | — | Exact Slack workspace ID |
| `appId` | Yes | — | Exact Slack app ID |
| `allowedUserIds` | Yes | — | Non-empty authorized human allowlist |
| `progressMode` | No | `summary` | `summary` hides tool arguments/output; `raw` exposes them |
| `fileUploads` | No | `false` | Permit authorized attachment downloads |
| `maxFileBytes` | No | 20 MiB | Per-file download limit, maximum 100 MiB |
| `maxFilesPerMessage` | No | `5` | Attachment count limit, maximum 10 |

Use `progressMode: raw` only when everyone who can see the Slack thread may see tool arguments and output. Private model thinking is never sent to Slack. Progress updates are capped below Slack's recommended 4,000-character message size. If Slack rejects a detailed raw update, that turn immediately retries with compact summary progress and remains in summary mode; the final answer is still posted separately.

In `summary` mode, partial tool output remains hidden. The bridge recognizes only strict `PI_DEPLOY_PROGRESS` JSON markers (`apex`/`sql-files`, bounded integer counts, and an uppercase TT identifier) and renders those validated fields as a live deployment status. Invalid markers and all surrounding output are ignored.

### `pi`

| Field | Required | Default | Description |
| --- | :---: | --- | --- |
| `command` | No | `/usr/bin/pi` | Absolute Pi executable path |
| `cwd` | Yes | — | Agent working directory |
| `agentDir` | Yes | — | Pi configuration/instructions directory |
| `sessionDir` | Yes | — | Persistent Pi JSONL session directory |
| `maxActiveSessions` | No | `1` | Concurrent Pi turns for this runtime, maximum 32 |
| `idleTimeoutMs` | No | `300000` | Stop an idle Pi subprocess while retaining its session |
| `requestTimeoutMs` | No | `30000` | Pi RPC request timeout |
| `autoSelect` | No | `[]` | Exact Pi UI select title/option standing authorizations, maximum 16 |

Each `autoSelect` rule must match the complete dialog title and an option present in that request. Rules never match confirms, prefixes, or regular expressions. A match is answered before delegated-dialog cancellation, so treat every rule as pre-authorized execution under that Unix agent and keep the list narrowly scoped.

### `interAgent`

Inter-agent communication is disabled when this block is absent. Managers list workers; workers list managers. Every peer requires a stable `agentId`, the opposite `role`, the sender Slack `appId`, and sender `botUserId`. Peer app IDs, bot user IDs, and agent IDs must be unique, and a runtime cannot trust its own app.

```yaml
interAgent:
  peers:
    - agentId: msboard
      role: worker       # use manager on the worker's reciprocal config
      appId: A00000000000
      botUserId: U00000000000
  requestTimeoutMs: 900000
  maxTaskChars: 30000
  maxResponseChars: 50000
```

| Field | Required | Default | Description |
| --- | :---: | --- | --- |
| `peers` | Yes | — | 1–32 explicitly trusted opposite-role agent identities |
| `requestTimeoutMs` | No | `900000` | How long a manager tool waits for the worker, 10 seconds–1 hour |
| `maxTaskChars` | No | `30000` | Delegated task bound, maximum 37,000 to fit one Slack message |
| `maxResponseChars` | No | `50000` | Aggregated worker response bound, maximum 100,000 |

Both apps must be installed in the same workspace and invited to the originating public/private channel. Delegation from an app DM is rejected because another app cannot share that DM. The runtime loads `delegate_to_worker` only for shared-channel sessions of a manager with configured worker peers.

## Slack manifests and permissions

The public examples are generic and contain no IDs or tokens:

| Manifest | Channel events | Recommended use |
| --- | --- | --- |
| [Worker](manifests/worker-agent.example.yaml) | Explicit `app_mention` only | Sensitive/on-demand specialist |
| [Manager](manifests/manager-agent.example.yaml) | `app_mention`, `message.channels`, `message.groups` | Coordinator/project manager |

Both include history scopes because new channel sessions bootstrap bounded thread context. Add `files:read` only when `slack.fileUploads: true`.

Other manifests demonstrate role-specific names, descriptions, prompts, and optional scopes. Public adopters should begin with the generic manifests above and keep environment-specific IDs/configuration outside Git.

## Production deployment with systemd

Recommended layout:

```text
/opt/pi-slack-team/current/                 immutable application release
/etc/pi-slack-team/<unix-user>.yaml         secret-free machine config
/etc/pi-slack-team/credentials/<unix-user>/ root-managed Slack credentials
/home/<unix-user>/.local/state/pi-slack-team/
/home/<unix-user>/.pi/agent/
```

Install [`deploy/systemd/pi-slack-team@.service`](deploy/systemd/pi-slack-team@.service), then enable one instance per Unix agent:

```bash
systemctl daemon-reload
systemctl enable --now pi-slack-team@<unix-user>.service
systemctl status pi-slack-team@<unix-user>.service
```

The template uses `LoadCredential=`, `NoNewPrivileges=`, `ProtectSystem=strict`, private temporary storage, and a bounded writable home directory. Review and adapt hardening for your distribution.

See [Operations](docs/operations.md) for onboarding, rollout, and failure handling.

## Message lifecycle

1. Bolt acknowledges a Slack Socket Mode event.
2. The runtime validates workspace, receiving app, conversation type, sender, bot status, subtype, and file limits. Inter-agent envelopes additionally require an exact configured sender app and bot user.
3. The event ID is claimed in SQLite; retries become no-ops.
4. The Slack thread is mapped to a durable conversation record.
5. A new Pi session receives bounded prior thread context.
6. A Pi RPC subprocess starts or resumes and runs under the configured Unix account.
7. Explicit requests receive throttled progress updates; ambient manager observations do not.
8. Final text is rendered to Slack, or a manager's silent decision produces no message.
9. A delegated worker response is correlated, reassembled, and returned to the waiting manager tool without allocating a second manager turn.
10. The Pi process hibernates after the idle timeout; its JSONL session remains resumable.

## Security model

Slack is a remote command interface, not merely chat. An allowed user can cause Pi to use every tool and OS permission available to that Unix account.

Core controls:

- dedicated Slack app and Unix account per agent;
- exact team/app checks and mandatory human allowlist;
- worker role by default;
- bot-message rejection to prevent loops, except versioned correlated envelopes from exact configured peers;
- no message body logging;
- untrusted-context markers around Slack history;
- bounded thread context, files, concurrency, and RPC operations;
- credentials outside Git, YAML, SQLite, and command-line arguments;
- safe progress mode by default;
- owner-bound interactive confirmations and exact, explicitly configured automatic select rules.

Read [SECURITY.md](SECURITY.md) before publishing changes or reporting a vulnerability.

## File uploads

Uploads are disabled by default. To enable them for one agent:

1. add `files:read` to that Slack app and reinstall it;
2. set `slack.fileUploads: true`;
3. keep count and size limits bounded;
4. restart the runtime.

Accepted files must come from `https://files.slack.com`, are downloaded without redirects, and are written mode `0600` below the private state directory. Ambient manager observations can see attachment metadata without downloading contents when uploads are disabled.

## Development

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm check
corepack pnpm build
```

The test suite covers configuration, manifests, authorization, event parsing, file bounds, persistent session routing, UI requests, Slack rendering, thread context, RPC behavior, logging redaction, and manager silence/intervention policy.

Before committing to this public repository:

```bash
git diff --check
corepack pnpm check
git diff --cached
```

Also scan staged files for Slack token prefixes and real deployment IDs. If any credential was committed, rotate it immediately; removing the line is not enough.

## Project layout

```text
config/             secret-free runtime examples
manifests/          generic and role-specific Slack app manifests
deploy/             systemd unit and credential importer
docs/               architecture, roles, security, setup, operations, plan
src/config/         strict YAML schema and credential loading
src/inter-agent/    manager Pi tool, private IPC gateway, and Slack peer protocol
src/pi/             Pi RPC client and session pool
src/routing/        authorization, conversation identity, queues
src/slack/          Slack bridge, parsing, rendering, manager policy, files/UI
src/storage/        SQLite routing registry
test/               unit and contract tests
```

## Known limitations

- Pre-1.0; production rollout requires a canary and local threat review.
- One workspace and Slack app per runtime configuration.
- No high availability for one Slack app connection.
- No shared-channel/Slack Connect authorization model.
- No per-chat Git worktree isolation yet.
- Manager evaluation consumes a Pi turn for every qualifying human channel message.
- Delegation requires both apps in the same Slack channel; an in-flight manager tool is not resumable across a runtime restart, although the worker's Slack result remains visible.
- Slack app manifest updates are managed in Slack; bot/app Socket Mode tokens cannot administer manifests.

## Documentation

- [Runtime configuration examples](config/README.md)
- [Slack app manifest examples](manifests/README.md)
- [Agent roles](docs/roles.md)
- [Slack app setup](docs/slack-setup.md)
- [Architecture](docs/architecture.md)
- [Security model](docs/security.md)
- [Operations](docs/operations.md)
- [Implementation plan](docs/PLAN.md)
- [Runtime ADR](docs/adr/0001-runtime.md)
- [Inter-agent delegation ADR](docs/adr/0002-inter-agent-delegation.md)
