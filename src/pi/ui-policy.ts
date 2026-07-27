import type { AgentConfig } from "../config/schema.js";
import type { RpcRecord } from "./rpc-client.js";

export interface AutomaticSelectMatch {
  response: { value: string };
  ruleIndex: number;
}

/**
 * Resolve only an exact configured select title and an option present in the
 * extension's current request. No regex, prefix, default, or confirm matching
 * is allowed because each rule is a standing authorization.
 */
export function matchAutomaticSelect(
  rules: AgentConfig["pi"]["autoSelect"],
  request: RpcRecord,
): AutomaticSelectMatch | undefined {
  if (
    request.type !== "extension_ui_request" ||
    request.method !== "select" ||
    typeof request.title !== "string" ||
    !Array.isArray(request.options) ||
    request.options.some((option) => typeof option !== "string")
  ) {
    return undefined;
  }

  const ruleIndex = rules.findIndex((rule) => rule.title === request.title);
  if (ruleIndex < 0) return undefined;
  const rule = rules[ruleIndex];
  if (!rule || !request.options.includes(rule.option)) return undefined;
  return { response: { value: rule.option }, ruleIndex };
}
