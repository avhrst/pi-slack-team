# Runtime configuration examples

Choose the transport explicitly when adopting the shared tmux team:

| Role | Shared tmux history | Per-user/thread RPC history |
| --- | --- | --- |
| Manager | [tmux-manager.example.yaml](tmux-manager.example.yaml) | [manager.example.yaml](manager.example.yaml) |
| Worker | [tmux-worker.example.yaml](tmux-worker.example.yaml) | [worker.example.yaml](worker.example.yaml) |

`pi.transport` defaults to `rpc`. tmux forces one process and one turn per agent and shares history across users. See the complete guide in [English](../docs/guide.en.md#5-configuration) or [українською](../docs/guide.uk.md#5-конфігурація).

Use these generic public examples:

- [`worker.example.yaml`](worker.example.yaml)
- [`manager.example.yaml`](manager.example.yaml)

Copy the selected file to a private machine-specific location, replace every synthetic Slack ID and absolute path, and keep production credentials outside YAML.

The configuration schema is strict. `worker` is the default role, but public examples set it explicitly so the intended Slack event policy is visible during review. The generic examples also show reciprocal, opt-in `interAgent.peers`: remove that block to disable all bot-to-bot communication, or replace every synthetic peer identity on both sides before testing delegation.

Production credentials are normally loaded from systemd's `$CREDENTIALS_DIRECTORY`. The optional `credentials` YAML block is for local development with owner-readable absolute files only.

`pi.autoSelect` is an optional exact-match standing authorization for Pi RPC `select` dialogs. It never uses regexes or defaults, and the configured option must be present in the extension request. Keep it empty unless a dedicated agent has a narrowly reviewed unattended workflow; unmatched delegated dialogs still fail closed.

Other files in this directory illustrate specialized settings such as bounded file uploads and the reciprocal `dev`/`deploy`/`msboard`/`support` peer layout. They contain synthetic IDs and no credentials.

## Team model and output baseline

The specialized `dev-agent`, `deploy-agent`, `msboard-agent`, and `support-agent` examples explicitly select `openai-codex/gpt-6.1-sol`, `pi.thinkingLevel: xhigh`, and `slack.progressMode: informative`. These are team choices, not changes to the schema defaults or the generic manager/worker examples. The selected model must be available and authenticated in each private agent profile.

For an existing installation, merge only these model/output fields into the private YAML. Preserve transport, paths, Slack identities, allowlists, peer ACLs, and credentials; do not replace a live configuration with an example. Restart only the selected idle agents after checking their active requests and queues. Publishing these examples does not apply configuration or restart services.

To retain the same defaults when opening Pi directly, merge the following keys into each selected Unix user's private `~/.pi/agent/settings.json`, preserving all unrelated settings:

```json
{
  "defaultProvider": "openai-codex",
  "defaultModel": "gpt-6.1-sol",
  "defaultThinkingLevel": "xhigh",
  "modelThinkingLevels": {
    "openai-codex/gpt-6.1-sol": "xhigh"
  }
}
```

This profile baseline can also be stored for an inactive `main-agent` without enabling a Slack app or starting a service. Keep real profile files, auth, sessions, state, uploads, and logs outside Git.

See the [configuration reference](../README.md#configuration-reference), [role contract](../docs/roles.md), and [Slack setup guide](../docs/slack-setup.md).
