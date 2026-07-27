# Runtime configuration examples

Use these generic public examples:

- [`worker.example.yaml`](worker.example.yaml)
- [`manager.example.yaml`](manager.example.yaml)

Copy the selected file to a private machine-specific location, replace every synthetic Slack ID and absolute path, and keep production credentials outside YAML.

The configuration schema is strict. `worker` is the default role, but public examples set it explicitly so the intended Slack event policy is visible during review. The generic examples also show reciprocal, opt-in `interAgent.peers`: remove that block to disable all bot-to-bot communication, or replace every synthetic peer identity on both sides before testing delegation.

Production credentials are normally loaded from systemd's `$CREDENTIALS_DIRECTORY`. The optional `credentials` YAML block is for local development with owner-readable absolute files only.

Other files in this directory illustrate specialized settings such as bounded file uploads and the reciprocal `dev`/`deploy`/`msboard`/`support` peer layout. They contain synthetic IDs and no credentials.

See the [configuration reference](../README.md#configuration-reference), [role contract](../docs/roles.md), and [Slack setup guide](../docs/slack-setup.md).
