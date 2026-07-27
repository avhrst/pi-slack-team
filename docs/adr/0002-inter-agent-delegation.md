# ADR 0002: correlated Slack transport for manager-to-worker delegation

## Status

Accepted.

## Context

Each Pi agent runs under a different Unix account and owns a different Slack app. The manager must be able to invoke a specialist worker and consume its result in the same manager turn.

Ordinary bot-authored events are rejected to prevent recursive agent loops. Sharing worker credentials, session files, or filesystem access with the manager would break the isolation model. A privileged host-wide broker would add a new root trust boundary and contradict the per-agent failure-isolation goal.

## Decision

Use two bounded transports:

1. A manager-only Pi extension calls its parent runtime over a mode-`0600` Unix socket inside the manager's private state directory. This registers the `delegate_to_worker` tool without exposing the manager Slack token to the Pi extension.
2. The manager runtime posts a versioned, correlated explicit mention in the originating Slack channel thread. The worker responds in that thread with the same correlation ID. Slack therefore remains the only transport crossing Unix accounts.

Both runtimes configure reciprocal opposite-role peers. An inter-agent event is accepted only when the sender Slack app ID and bot user ID both match the peer entry, the direction is valid, the message is an explicit mention with the expected versioned envelope, and all size/subtype/channel constraints pass.

The manager registers the pending correlation before posting. Matching response chunks resolve the existing `delegate_to_worker` call and do not allocate another manager Pi turn. This breaks automatic bot-to-bot reply chains. Ordinary bot messages remain rejected.

Worker Pi dialogs are cancelled for delegated turns. A manager bot cannot approve an interactive confirmation; the worker must return the approval requirement as a blocker.

## Consequences

- Worker execution retains its own Unix identity, Pi configuration, tools, credentials, cwd, and persistent thread session.
- Requests and results remain visible and auditable in the originating Slack thread.
- Both apps must be installed in the same workspace and invited to that channel.
- Delegation from an app DM is unsupported because another app cannot share that DM.
- A manager restart, timeout, or cancellation rejects the in-memory pending wait. The worker may still finish and post a visible orphaned result.
- Configuring a manager peer is an explicit transitive authorization decision and must be narrower than accepting arbitrary bot events.

## Rejected alternatives

### Accept every bot-authored mention

Rejected because it permits spoofable task injection from unrelated apps and creates recursive manager/worker loops.

### Share worker Slack or Pi credentials with the manager

Rejected because it collapses Unix and agent identity boundaries and makes attribution ambiguous.

### Root or host-wide message broker

Rejected for this phase because it introduces a privileged shared failure domain and additional credential/authorization state.

### Spawn the worker directly from the manager process

Rejected because the manager Unix account cannot and should not inherit the worker's filesystem, tools, auth, or process identity.
