# Slack app manifests

Start with one generic public example:

- [`worker-agent.example.yaml`](worker-agent.example.yaml) for DMs and explicit channel mentions;
- [`manager-agent.example.yaml`](manager-agent.example.yaml) for worker behavior plus ambient public/private channel messages.

Both files are importable Slack app manifests and contain no workspace IDs, app IDs, user IDs, or credentials. Customize display names, descriptions, colors, and suggested prompts before creating the app.

## Role-defining event difference

A worker subscribes to:

```yaml
- app_home_opened
- app_mention
- assistant_thread_started
- message.im
```

A manager additionally subscribes to:

```yaml
- message.channels
- message.groups
```

The runtime config must use the matching `role`. Adding manager events to Slack while leaving `role: worker` causes the events to be delivered but rejected. Setting `role: manager` without adding the events means DMs/mentions work while ambient messages never arrive.

## Scopes

The generic manifests use the same minimal base scopes because both roles may bootstrap channel-thread context:

- `app_mentions:read`
- `assistant:write`
- `channels:history`
- `chat:write`
- `groups:history`
- `im:history`

Add `files:read` only when the corresponding runtime explicitly sets `slack.fileUploads: true`.

## Environment-specific examples

The other manifests demonstrate customized specialist/manager descriptions and optional scopes. They remain secret-free, but external deployments should usually copy a generic example rather than inheriting environment-specific names.

See [Slack app setup](../docs/slack-setup.md) for import, Socket Mode, installation, credential storage, channel invitations, canary tests, and troubleshooting.
