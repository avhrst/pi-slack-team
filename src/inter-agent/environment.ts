import path from "node:path";
import type { AgentConfig } from "../config/schema.js";
import type { ConversationKey } from "../storage/registry.js";

export const INTER_AGENT_SOCKET_FILE = "inter-agent.sock";
export const INTER_AGENT_SOCKET_ENV = "PI_SLACK_TEAM_INTER_AGENT_SOCKET";
export const INTER_AGENT_CONVERSATION_ENV =
  "PI_SLACK_TEAM_INTER_AGENT_CONVERSATION";
export const INTER_AGENT_WORKERS_ENV = "PI_SLACK_TEAM_INTER_AGENT_WORKERS";
export const INTER_AGENT_MAX_TASK_CHARS_ENV =
  "PI_SLACK_TEAM_INTER_AGENT_MAX_TASK_CHARS";

export function interAgentSocketPath(config: AgentConfig): string {
  return path.join(config.stateDir, INTER_AGENT_SOCKET_FILE);
}

export function interAgentExtensionEnvironment(
  config: AgentConfig,
  conversation: ConversationKey,
): NodeJS.ProcessEnv | undefined {
  if (
    config.role !== "manager" ||
    !["C", "G"].some((prefix) => conversation.channelId.startsWith(prefix)) ||
    !config.interAgent?.peers.some((peer) => peer.role === "worker")
  ) {
    return undefined;
  }
  const workers = config.interAgent.peers
    .filter((peer) => peer.role === "worker")
    .map((peer) => peer.agentId);
  return {
    [INTER_AGENT_SOCKET_ENV]: interAgentSocketPath(config),
    [INTER_AGENT_CONVERSATION_ENV]: Buffer.from(
      JSON.stringify(conversation),
      "utf8",
    ).toString("base64url"),
    [INTER_AGENT_WORKERS_ENV]: JSON.stringify(workers),
    [INTER_AGENT_MAX_TASK_CHARS_ENV]: String(config.interAgent.maxTaskChars),
  };
}
