# pi-slack-team

Run one Slack app per Linux-isolated Pi agent and map every Slack Agent chat to a separate persistent Pi session.

The project is a standalone worker, not an extension attached to one already-running Pi session. Each worker:

- runs as the target agent's Unix account;
- owns exactly one Slack Socket Mode app connection;
- accepts only configured Slack workspace and user IDs;
- responds to DMs and explicit `@agent` mentions in channels;
- maps each Slack DM or channel thread to a persistent Pi JSONL session;
- starts or resumes a headless Pi RPC subprocess for active chats;
- stores only non-secret routing state in a per-user SQLite database.

## Status

The initial runtime is under active development. Do not deploy it with production Slack credentials until the security and canary acceptance tests in [docs/PLAN.md](docs/PLAN.md) pass.

## Development

Requirements:

- Node.js 24 or newer
- Corepack

```bash
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm check
corepack pnpm build
```

Create a local config from [config/agent.example.yaml](config/agent.example.yaml). Keep Slack credentials outside the repository.

```bash
corepack pnpm build
node dist/main.js doctor --config /path/to/support-agent.yaml
node dist/main.js start --config /path/to/support-agent.yaml
```

## Documentation

- [Implementation plan](docs/PLAN.md)
- [Architecture](docs/architecture.md)
- [Security model](docs/security.md)
- [Operations](docs/operations.md)
