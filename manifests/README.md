# Slack app manifests

Start with one generic public example:

- [`worker-agent.example.yaml`](worker-agent.example.yaml) for DMs, mentions and replies in engaged threads;
- [`manager-agent.example.yaml`](manager-agent.example.yaml) for worker behavior plus ambient public/private channel messages.

Both files are importable Slack app manifests and contain no workspace IDs, app IDs, user IDs, or credentials. Customize display names, descriptions, colors, and suggested prompts before creating the app.

## Event subscriptions and role policy

Both roles subscribe to:

```yaml
- app_home_opened
- app_mention
- assistant_thread_started
- message.channels
- message.groups
- message.im
```

The first authorized mention or trusted delegation engages the agent in a thread. Both roles accept subsequent replies from allowed humans without another mention. Workers reject other channel messages; managers may evaluate those as ambient observations and remain silent. The runtime `role` controls this difference. For an existing Slack App, update these event subscriptions as well as the runtime; a code update alone cannot enable events Slack does not send.

## Scopes

The generic manifests use the same minimal base scopes because both roles may bootstrap channel-thread context:

- `app_mentions:read`
- `assistant:write`
- `channels:history`
- `chat:write`
- `groups:history`
- `im:history`

Add `files:read` only when the corresponding runtime explicitly sets `slack.fileUploads: true`. The four environment-specific Pinet manifests enable this bounded attachment support; the generic examples keep it opt-in.

## Environment-specific examples

The other manifests demonstrate customized specialist/manager descriptions and optional scopes. They remain secret-free, but external deployments should usually copy a generic example rather than inheriting environment-specific names.

See [Slack app setup](../docs/slack-setup.md) for import, Socket Mode, installation, credential storage, channel invitations, canary tests, and troubleshooting.
