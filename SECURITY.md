# Security policy

`pi-slack-team` turns Slack into a remote command surface for a coding agent. Treat every Slack app token, bot token, Pi credential, tool integration, and Unix account as security-sensitive.

## Supported version

Security fixes are applied to the current `main` branch while the project is pre-1.0. Older commits and private deployments are not maintained automatically.

## Reporting a vulnerability

Use GitHub private vulnerability reporting for security issues. Do not open a public issue containing:

- credentials or token fragments;
- private Slack messages or file URLs;
- customer, employee, operational, or database data;
- hostnames, connection strings, or internal infrastructure details;
- an exploit that could cause an agent to execute tools without authorization.

Include the affected revision, impact, minimal reproduction steps, and a redacted log when possible.

## If a credential was committed

Assume it is compromised even if the commit was quickly removed.

1. Revoke/rotate the Slack or service credential immediately.
2. Stop affected runtime instances if unauthorized use is possible.
3. Remove the value from the working tree and Git history.
4. Review Slack audit data, service logs, Pi sessions, and tool-side audit trails.
5. Restore service only with new credentials.

Deleting a GitHub branch or force-pushing is not a substitute for rotation.

## Public-repository rules

Before committing:

- use only synthetic `T…`, `A…`, `U…`, and `W…` IDs in examples;
- never commit `.env`, token, SQLite, upload, session, or log files;
- keep production paths and identities in `/etc`, systemd credentials, or another private deployment repository;
- run `git diff --check`, `corepack pnpm check`, and a credential scanner;
- inspect staged files with `git diff --cached`;
- confirm Slack manifests contain scopes/events only, never tokens.

See [docs/security.md](docs/security.md) for the runtime trust model and [docs/slack-setup.md](docs/slack-setup.md) for credential installation.
