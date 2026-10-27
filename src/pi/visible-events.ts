import type { RpcRecord } from "./rpc-client.js";
import { compactProgressText, workerProgressDetails } from "./activity-progress.js";

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function textContent(message: unknown): string {
  const content = object(message)?.content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    const item = object(part);
    return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
  }).join("\n");
}

function boundedText(text: string): string {
  // Also bound JSON expansion (control characters), not just UTF-16 length.
  let result = text.slice(0, 200_000);
  while (Buffer.byteLength(JSON.stringify(result)) > 400_000) result = result.slice(0, Math.floor(result.length * 0.8));
  return result.length < text.length ? `${result}\n[transport text truncated]` : result;
}

function workerDetails(result: unknown): Record<string, unknown> {
  const progress = object(object(result)?.details)?.progress;
  const value = object(progress);
  if (value?.version !== 1 || typeof value.workerId !== "string" ||
      !/^[a-z][a-z0-9-]{1,62}$/u.test(value.workerId) || typeof value.text !== "string") return {};
  return { details: workerProgressDetails(value.workerId, value.text) };
}

/** Allowlisted wire events: no assistant snapshots, thinking deltas or signatures. */
export class VisibleEventProjector {
  #text = "";
  #message = 0;

  project(event: RpcRecord): RpcRecord | undefined {
    if (event.type === "message_start" && object(event.message)?.role === "assistant") {
      this.#text = "";
      this.#message++;
      return { type: "message_start", message: { role: "assistant" }, messageId: this.#message };
    }
    if (event.type === "message_update") {
      const update = object(event.assistantMessageEvent);
      if (update?.type !== "text_delta" || typeof update.delta !== "string") return undefined;
      // The SDK supplies a full message too. Read only its visible text blocks.
      this.#text = object(event.message)?.content ? textContent(event.message) : this.#text + update.delta;
      return { type: "message_update", messageId: this.#message,
        assistantMessageEvent: { type: "text_snapshot", text: boundedText(this.#text) } };
    }
    if (event.type === "message_end" && object(event.message)?.role === "assistant") {
      const text = boundedText(textContent(event.message));
      this.#text = "";
      return { type: "message_end", messageId: this.#message, message: { role: "assistant", content: [{ type: "text", text }] } };
    }
    if (event.type.startsWith("tool_execution_")) {
      const output = textContent(event.type === "tool_execution_update" ? event.partialResult : event.result);
      const visible: RpcRecord = {
        type: event.type, toolCallId: event.toolCallId,
        toolName: typeof event.toolName === "string" ? event.toolName.slice(0, 80) : "tool",
        ...(event.args !== undefined ? { args: event.args } : {}),
        ...(event.partialResult !== undefined ? { partialResult: { content: [{ type: "text", text: output.slice(0, 8_000) }], ...workerDetails(event.partialResult) } } : {}),
        ...(event.result !== undefined ? { result: { content: [{ type: "text", text: output.slice(0, 8_000) }], ...workerDetails(event.result) } } : {}),
        ...(output ? { outputLines: output.split(/\r?\n/u).length } : {}),
        ...(event.isError !== undefined ? { isError: event.isError } : {}),
      };
      const bounded = JSON.parse(JSON.stringify(visible, (key, value: unknown) => {
        if (key === "thinking" || key === "thinkingSignature" || object(value)?.type === "thinking") return undefined;
        return typeof value === "string" ? value.slice(0, 8_000) : value;
      })) as RpcRecord;
      if (Buffer.byteLength(JSON.stringify(bounded)) <= 400_000) return bounded;
      return { type: event.type, toolCallId: event.toolCallId, toolName: visible.toolName, isError: event.isError,
        result: { content: [{ type: "text", text: "Large tool payload omitted from transport; inspect the agent terminal." }] } };
    }
    if (event.type === "agent_progress" && typeof event.text === "string") {
      const text = compactProgressText(event.text);
      return text ? { type: "agent_progress", text } : undefined;
    }
    if (["agent_start", "agent_waiting", "agent_resumed", "compaction_start", "compaction_end", "auto_retry_start", "auto_retry_end"].includes(event.type)) {
      return { type: event.type,
        ...(typeof event.attempt === "number" ? { attempt: event.attempt } : {}),
        ...(typeof event.success === "boolean" ? { success: event.success } : {}),
        ...(event.type === "compaction_end" ? { failed: Boolean(event.aborted || event.errorMessage) } : {}),
      };
    }
    return undefined;
  }
}
