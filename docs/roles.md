# Agent roles

`pi-slack-team` supports two runtime roles. The role controls which Slack events may create a Pi turn; it does not change the Linux identity, Pi model, tools, or agent instructions.

```yaml
role: worker # or manager
```

`worker` is the default when `role` is omitted, so existing configurations remain backward compatible.

## Behavior matrix

| Capability | `worker` | `manager` |
| --- | --- | --- |
| Authorized direct messages | Processed | Processed |
| Explicit `@agent` mention in a public/private channel | Processed | Processed |
| Ordinary authorized human message in a joined channel | Ignored | Evaluated |
| Ordinary bot-authored message | Ignored | Ignored |
| Correlated envelope from an exact configured opposite-role peer | Manager request only | Worker response only |
| Message from a user outside `allowedUserIds` | Ignored | Ignored |
| Visible `Working…` progress for explicit requests | Yes | Yes |
| Visible progress for ambient channel observations | N/A | No |
| Ability to remain silent after evaluation | N/A | Yes |

Both roles require an exact workspace ID, app ID, and non-empty user allowlist. Slack channel membership does not grant authorization by itself.

## Worker role

Use a worker for an on-demand specialist that should act only when addressed.

A worker accepts:

1. `message.im` events from an allowed user;
2. `app_mention` events from an allowed user in a public or private channel.

An ordinary channel message cannot allocate or resume its Pi session. Follow-up channel turns must mention the worker again. This is the least-privileged role and is appropriate for deployment, infrastructure, database, and other agents with sensitive tools.

Use [the worker Slack manifest](../manifests/worker-agent.example.yaml) as the public template.

## Manager role

Use a manager for a coordinator or project-management agent that should monitor conversations and intervene selectively.

A manager has all worker behavior and additionally accepts:

- `message.channels` for public channels the app has joined;
- `message.groups` for private channels the app has joined.

Ambient messages are processed only when all runtime checks pass:

- workspace and app IDs match the configuration;
- the sender is listed in `slack.allowedUserIds`;
- the sender is human, not a bot;
- the message subtype and attachment count are supported.

The message is wrapped as an explicitly untrusted observation with channel, thread, timestamp, and sender metadata. The manager is instructed to apply its own project-management policy and decide among three outcomes:

1. take an allowed action and report the useful result;
2. ask one material clarification in the Slack thread;
3. return the internal silent decision, producing no Slack message.

Ambient turns do not post a `Working…` message or stream tool progress. This prevents a manager from adding noise to every conversation it evaluates.

Use [the manager Slack manifest](../manifests/manager-agent.example.yaml) as the public template.

## Manager-to-worker communication

Inter-agent communication is opt-in and does not relax the ordinary bot-message rejection rule. Configure reciprocal peers under `interAgent`:

- the manager lists each worker with `role: worker`, its Slack app ID, and bot user ID;
- each worker lists the manager with `role: manager`, its Slack app ID, and bot user ID;
- both apps must be invited to the originating shared channel.

A configured manager Pi session for a shared channel thread receives `delegate_to_worker`. The tool sends one bounded, versioned request envelope as an explicit worker mention in the current Slack thread. The worker runtime accepts it only when all of these match:

- receiving workspace/app and channel constraints;
- bot-authored explicit `app_mention` event;
- sender app ID and bot user ID from the reciprocal peer entry;
- request correlation format, size, subtype, and empty attachment set.

The worker uses its normal per-thread persistent Pi session and its own Unix identity, tools, credentials, working directory, and instructions. Its response explicitly mentions the manager with the same correlation ID. The manager runtime consumes response chunks directly into the waiting tool call instead of creating another manager Pi turn, which prevents recursive agent loops. A worker-side error is returned as a failed tool call.

Interactive Pi dialogs are cancelled during a delegated turn. A worker that requires human approval must report that blocker rather than treating the manager bot as a human approver. Ordinary bot text, malformed envelopes, unconfigured apps, wrong-role peers, files, DMs, and orphaned responses remain fail-closed.

`allowedUserIds` continues to authorize humans only. `interAgent.peers` is a separate transitive trust decision: configure a manager only when its policy is permitted to invoke that worker's capabilities.

## Tools and Jira behavior

The runtime does not contain Jira-specific automation. It exposes the Slack observation to the configured Pi agent. Whether a manager searches or creates Jira issues depends on:

- the manager's `AGENTS.md` and other Pi instructions;
- which Jira/Confluence tools are installed for that Unix account;
- authorization and project-specific policy;
- whether the message contains enough scope to create durable work safely.

A useful manager policy should require duplicate search, a clear target project, actionable acceptance criteria, and no credentials or sensitive data in tickets. Routine discussion should not produce Jira noise.

Example decision:

```text
Channel: “We agreed to fix the checkout timeout this sprint.”
Manager: search for an existing issue; create one only if the project and scope
are unambiguous; reply with the issue key. Otherwise ask one clarification.
```

## Slack thread and ownership model

The durable conversation key is:

```text
(team_id, app_id, channel_id, thread_ts)
```

A root message uses its own timestamp as `thread_ts`. The first accepted user becomes the durable conversation owner.

- Workers reject later turns from another human in the same thread, but a configured manager delegation may continue the worker's thread session while preserving its first owner.
- Managers allow other authorized humans to contribute channel turns to the same Pi session.
- Interactive Pi confirmations remain bound to the first owner to prevent cross-user approval.

New sessions receive bounded prior thread context. Existing sessions resume from their Pi JSONL file and do not receive the full transcript again.

## Attachments

Explicit requests with attachments require both:

- `slack.fileUploads: true` in runtime configuration;
- the `files:read` Slack bot scope.

For a manager with downloads disabled, an ambient file-share can still be evaluated from safe metadata such as filename, MIME type, and size; file contents and private download URLs are not provided to Pi.

## Choosing a role

Prefer `worker` unless proactive observation is a requirement.

Choose `manager` only when:

- the app is deliberately invited to a bounded set of channels;
- every user allowed to trigger tools is explicitly listed;
- the agent has clear instructions for silence versus intervention;
- tool side effects are constrained by the Unix account and agent policy;
- model usage for every qualifying channel message is acceptable.

A manager evaluates more events and can create many persistent sessions. Keep channel membership and `allowedUserIds` narrow, and start with `pi.maxActiveSessions: 1`.

## Migrating an existing worker to manager

1. Change the secret-free config to `role: manager`.
2. Add `message.channels` and `message.groups` to the Slack app's bot event subscriptions.
3. Confirm `channels:history` and `groups:history` are installed scopes.
4. Invite the app only to channels it should observe.
5. Restart the runtime.
6. Send one authorized channel message without mentioning the app and verify either a useful response or a logged silent decision.
7. Verify ordinary bot and unauthorized-user messages do not allocate Pi sessions.
8. If inter-agent delegation is configured, canary `delegate_to_worker` in a shared channel, verify the worker result returns to the same manager turn, then test an unconfigured bot and malformed correlation marker.

See [Slack app setup](slack-setup.md) for the complete procedure.
