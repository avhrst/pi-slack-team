# ADR 0001: per-agent worker with Pi RPC subprocesses

Status: accepted for initial implementation.

## Context

A Pi extension is bound to an existing session, while this project must create and resume many independent sessions from Slack. All agents share a host but use different Unix accounts.

## Decision

Run one standalone Node.js worker per Unix agent and one Pi RPC subprocess per active Slack chat.

Pi SDK remains a possible future adapter. RPC is selected initially because it provides process isolation and a defined extension UI request/response protocol.

## Consequences

- Slack routing does not depend on an interactive Pi process.
- Each active chat costs one child process.
- Idle processes must hibernate.
- The RPC JSONL framing and lifecycle require dedicated contract tests.
