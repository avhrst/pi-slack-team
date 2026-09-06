# One agent, one tmux session

The `pi.transport: tmux` backend keeps Slack as the human-facing interface, but replaces per-user/per-thread Pi RPC processes and Slack bot-to-bot delegation with **one interactive Pi process and one shared Pi history per agent**.

## Topology

```text
Slack humans → existing allowlist + dedup + Slack bridge
                                          │
                              tmux load-buffer / wait-for
                                          │
                 private tmux server, one named session, interactive Pi
                                          │
                                delegate_to_worker tool
                                          │
                               source tmux request buffer
                                          │
                 local root relay (fixed sockets, reciprocal peer ACLs)
                                          │
                               worker tmux inbox buffer
                                          │
                 worker bridge → same worker's interactive Pi → result
                                          │
                       result buffer → manager tool → Slack human
```

The relay **does not** grant shared tmux-server access, run arbitrary commands, type into terminals, or parse terminal output. It copies bounded JSON buffers using `load-buffer` and `save-buffer`; `wait-for -S` wakes consumers. Consumers recheck buffers after a bounded wait because wakeups can coalesce. Each agent's existing Unix account owns its server/socket/process. Root can observe all of them without giving one agent control of another account.

No per-Slack-user, per-thread, per-task or observer tmux sessions are created. The session is named after `expectedUnixUser`; its one window is `pi`. Slack routing records remain per conversation **only to route responses and confirmations**, not to allocate Pi processes. All conversations bind to `agent:<team>:<app>` when used. The fixed Pi history is `<pi.sessionDir>/tmux-agent.jsonl`.

## Configuration

Add to an existing secret-free configuration:

```yaml
pi:
  transport: tmux
  tmuxCommand: /usr/local/bin/tmux # absolute path to tmux 3.5+
  command: /usr/bin/pi
  cwd: /home/example-agent
  agentDir: /home/example-agent/.pi/agent
  sessionDir: /home/example-agent/.pi/agent/sessions
  turnTimeoutMs: 3600000
```

Other existing fields, Slack apps, allowlists, credentials, working directories and role-specific tools remain unchanged. `maxConcurrentTurns` and `maxResidentProcesses` become **1** in this mode. Idle hibernation is disabled: Pi remains visible while idle. `requestTimeoutMs` remains a startup bound (interactive startup allows at least 90 seconds); `turnTimeoutMs` bounds a request including queue time (default one hour, maximum one day). `interAgent.requestTimeoutMs` bounds delegation including worker queue time.

Use the existing reciprocal `interAgent.peers` configuration. Manager → worker delegation works from **DMs, channels and local TUI**, without requiring a shared Slack channel. Requests are authorized against both peers' configured identities and, for Slack-origin requests, both human allowlists. Worker → manager nested delegation is intentionally disabled to prevent cycles/deadlocks in serial agents. Results return to the manager's waiting tool, not to a second manager turn.

`pi.transport` defaults to `rpc` for backward compatibility. Opt in explicitly; see `config/tmux-worker.example.yaml` and `config/tmux-manager.example.yaml`.

## Operator commands

Install a `pi-team` wrapper that executes:

```sh
#!/bin/sh
exec /usr/bin/node /opt/pi-slack-team/current/dist/tmux/cli.js "$@"
```

As root (or the matching Unix agent for its own socket):

```bash
pi-team list
pi-team watch dev-agent       # read-only; recommended for observation
pi-team watch support-agent
pi-team attach msboard-agent  # interactive: may steer/cancel/change work
pi-team capture deploy-agent  # last 200 lines of terminal output
```

Detach using **Ctrl+b, then d**. Detaching does not stop Pi. `watch`/`attach` connect to the existing session and do not create observer sessions. Separate servers mean ordinary `tmux ls` on the operator's default socket will not list the agents; use `pi-team list`.

Equivalent raw tmux command:

```bash
tmux -S /home/dev-agent/.local/state/pi-slack-team/tmux.sock attach-session -r -t dev-agent
```

Terminal output, tool arguments and thinking are visible to authorized terminal observers. Treat terminal captures as sensitive. Thinking is not transported to Slack. Slack progress retains the existing summary/raw policy.

Managers get `team_status` (live, bounded relay heartbeat) and `delegate_to_worker` (correlated request/result/progress). The old `subagent` spawning tool is excluded/blocked in managed panes; standalone personal Pi configuration is not uninstalled or rewritten. Do not use old subagent slash workflows, hidden Pi subprocesses or manual shell spawning as an alternate team transport.

## Queue, UI and persistence contract

- One Pi request executes at a time, including Slack and delegated work. Up to 128 bridge requests may wait. Arrival timestamps determine order, then IDs break ties.
- Local typed messages received during a remote turn wait separately (maximum 32) rather than contaminating the remote response. Idle local interaction remains available. Interactive operator access can still cancel/alter work; prefer read-only watching.
- Shared history means **users are no longer context-isolated**. Use this mode only when that trade-off is accepted. Request metadata identifies the actual sender/channel/thread every turn. It does not grant permission to disclose another user's information.
- Slack-origin work remains remote work after delegation. A message cannot gain local/TUI authorization by claiming it in its text.
- Remote select/confirm/input/editor dialogs use the existing Slack broker, bound to the **current request sender**, not the historical conversation owner. Exact configured auto-select rules still apply. Unconfigured delegated dialogs and unsupported custom terminal dialogs cancel safely. Pure local turns use normal TUI dialogs.
- `/new`, `/resume`, `/fork`, `/clone` and `/tree` replacement/navigation are rejected in a managed pane to keep the shared history stable. `/reload` terminates any active remote request rather than silently reassigning it.
- UUIDs correlate requests, progress, UI and results. Different managers have distinct worker execution IDs even if they reuse a UUID.
- A receipt is written **before execution**. Interrupted deliveries are not replayed automatically; repeated completed deliveries can return their saved result. Receipts are private, retained for seven days; expired requests cannot start again after receipt cleanup. The worker bridge also claims peer IDs in SQLite.
- Relay restart preserves pending correlation in the source/target tmux buffers. **tmux/server/host restart does not preserve in-flight buffers**. Persistent Pi history survives; in-flight work is reported as failed/interrupted where the caller still exists, never silently replayed.
- Deadlines/abort send correlated cancellation. Already executed tools, spawned jobs and external side effects are **not undone**. Inspect artifacts before manually retrying a failed or uncertain task.
- Buffer payloads are limited to 1 MiB. Requests, responses and progress have additional schema bounds. Large raw tool progress is omitted/truncated; inspect the actual terminal/artifacts for full output.

## Deployment and rollback

1. Run `pnpm check` and `pnpm build`; run an isolated real-Pi canary without production tasks.
2. Record the previous release symlink and back up live YAML, SQLite state and systemd configuration in a root-only directory. **Keep backups outside Git**; databases contain sensitive routing/history metadata.
3. Check that agents have no active work. A restart interrupts in-flight tasks and must not be disguised as successful completion.
4. Deploy an immutable release containing `dist/`, dependencies and `deploy/tmux.conf`.
5. Opt the selected agents into `pi.transport: tmux` and restart their existing `pi-slack-team@<unix-user>` services. Each bridge eagerly starts its Pi pane before connecting to Slack.
6. Install/enable `deploy/systemd/pi-tmux-relay.service`. Keep `/etc/pi-slack-team` and relay YAML root-owned, not group/world writable. The relay reads only `.yaml` files in that directory; it rejects non-root/writable files. `PI_TEAM_CONFIG_DIR` can select another root-managed directory for a separate deployment.
7. Verify `pi-team list`, one session/pane per account, Slack connections, a safe correlated delegation and no RPC Pi processes. Check `journalctl -u pi-tmux-relay` plus per-agent service journals.

The original per-user/thread JSONL files and `pi_sessions` rows are retained; old chats are rebound lazily to the new shared history. Old histories are **not silently merged** into the new context.

To roll back: stop the relay and affected agent services; restore the previous release symlink, YAML and the backed-up SQLite databases (remove WAL/SHM only while stopped); restart the original services. Do not restore database files underneath a live process. The new shared JSONL can remain on disk for audit. Restoring only YAML is insufficient once conversations have been rebound to the shared agent session.

A bridge watchdog checks the Pi heartbeat. Loss of the pane/extension causes the service to fail and systemd to restart it, resuming the same JSONL. Unknown existing tmux sessions are not adopted as an agent. Stopping a managed agent never kills the operator's tmux server.
