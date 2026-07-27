import crypto from "node:crypto";
import net from "node:net";
import { TextDecoder } from "node:util";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  INTER_AGENT_CONVERSATION_ENV,
  INTER_AGENT_MAX_TASK_CHARS_ENV,
  INTER_AGENT_SOCKET_ENV,
  INTER_AGENT_WORKERS_ENV,
} from "./environment.js";
import type { ConversationKey } from "../storage/registry.js";

interface DelegationResult {
  delegationId: string;
  workerId: string;
  text: string;
}

interface DelegationResponse {
  requestId: string;
  ok: boolean;
  result?: DelegationResult;
  error?: string;
}

interface ExtensionConfiguration {
  socketPath: string;
  conversation: ConversationKey;
  workers: string[];
  maxTaskChars: number;
}

function configuration(
  environment: NodeJS.ProcessEnv = process.env,
): ExtensionConfiguration | undefined {
  const socketPath = environment[INTER_AGENT_SOCKET_ENV];
  const encodedConversation = environment[INTER_AGENT_CONVERSATION_ENV];
  const encodedWorkers = environment[INTER_AGENT_WORKERS_ENV];
  const maxTaskChars = Number(environment[INTER_AGENT_MAX_TASK_CHARS_ENV]);
  if (
    !socketPath ||
    !encodedConversation ||
    !encodedWorkers ||
    !Number.isSafeInteger(maxTaskChars) ||
    maxTaskChars < 1
  ) {
    return undefined;
  }
  try {
    const conversation = JSON.parse(
      Buffer.from(encodedConversation, "base64url").toString("utf8"),
    ) as Partial<ConversationKey>;
    const workersValue: unknown = JSON.parse(encodedWorkers);
    if (
      typeof conversation.teamId !== "string" ||
      typeof conversation.appId !== "string" ||
      typeof conversation.channelId !== "string" ||
      typeof conversation.threadTs !== "string" ||
      !Array.isArray(workersValue) ||
      !workersValue.every(
        (worker): worker is string =>
          typeof worker === "string" &&
          /^[a-z][a-z0-9-]{1,62}$/u.test(worker),
      )
    ) {
      return undefined;
    }
    return {
      socketPath,
      maxTaskChars,
      workers: workersValue,
      conversation: {
        teamId: conversation.teamId,
        appId: conversation.appId,
        channelId: conversation.channelId,
        threadTs: conversation.threadTs,
      },
    };
  } catch {
    return undefined;
  }
}

async function requestDelegation(
  config: ExtensionConfiguration,
  workerId: string,
  task: string,
  signal?: AbortSignal,
): Promise<DelegationResult> {
  const requestId = crypto.randomUUID();
  const request = JSON.stringify({
    requestId,
    conversation: config.conversation,
    workerId,
    task,
  });
  return new Promise<DelegationResult>((resolve, reject) => {
    const socket = net.createConnection(config.socketPath);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = Buffer.alloc(0);
    let settled = false;

    const cleanup = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
      socket.removeAllListeners();
      if (!socket.destroyed) socket.destroy();
    };
    const settle = (
      operation: (value: DelegationResult) => void,
      value: DelegationResult,
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      operation(value);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => fail(new Error("Worker delegation was cancelled"));

    socket.once("connect", () => {
      socket.write(`${request}\n`, "utf8");
    });
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 512 * 1_024) {
        fail(new Error("Worker delegation response is too large"));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) return;
      let response: DelegationResponse;
      try {
        response = JSON.parse(
          decoder.decode(buffer.subarray(0, newline)),
        ) as DelegationResponse;
      } catch {
        fail(new Error("Worker delegation returned an invalid response"));
        return;
      }
      if (response.requestId !== requestId) {
        fail(new Error("Worker delegation response correlation failed"));
        return;
      }
      if (!response.ok || !response.result) {
        fail(
          new Error(
            response.error || "Worker could not complete the delegated task",
          ),
        );
        return;
      }
      if (
        !/^[0-9a-f-]{36}$/u.test(response.result.delegationId) ||
        response.result.workerId !== workerId ||
        typeof response.result.text !== "string"
      ) {
        fail(new Error("Worker delegation returned malformed result data"));
        return;
      }
      settle(resolve, response.result);
    });
    socket.once("error", () => {
      fail(new Error("Could not connect to the manager delegation gateway"));
    });
    socket.once("end", () => {
      if (!settled) fail(new Error("Manager delegation gateway closed early"));
    });
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
  });
}

export default function managerWorkerDelegationExtension(pi: ExtensionAPI) {
  const config = configuration();
  if (!config) return;
  const availableWorkers = config.workers.join(", ");

  pi.registerTool({
    name: "delegate_to_worker",
    label: "Delegate to Worker",
    description: [
      "Send a scoped task to a configured Linux-isolated Pi worker through the originating Slack thread and wait for its authenticated response.",
      `Available worker IDs: ${availableWorkers}.`,
      "The worker runs with its own tools, instructions, credentials, working directory, and persistent per-thread session.",
    ].join(" "),
    promptSnippet:
      "Delegate specialist implementation to a configured worker and wait for its result",
    promptGuidelines: [
      "Use delegate_to_worker when specialist implementation belongs to one of its configured workers; do not ask the human to mention that worker manually.",
      "When calling delegate_to_worker, include the original goal, Jira/Confluence context, target environment, authorization and safety constraints, acceptance criteria, and expected evidence in the task.",
      "Do not report delegated work as completed until delegate_to_worker returns evidence; report worker failures or timeouts accurately.",
    ],
    parameters: Type.Object({
      workerId: Type.String({
        description: `Configured worker ID. Available: ${availableWorkers}`,
        minLength: 2,
        maxLength: 63,
      }),
      task: Type.String({
        description:
          "Self-contained task for the worker, including constraints and expected evidence",
        minLength: 1,
        maxLength: config.maxTaskChars,
      }),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      if (!config.workers.includes(params.workerId)) {
        throw new Error(`Unknown or unauthorized worker: ${params.workerId}`);
      }
      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Delegated to ${params.workerId}; waiting for the worker response...`,
          },
        ],
        details: { workerId: params.workerId, status: "waiting" },
      });
      const result = await requestDelegation(
        config,
        params.workerId,
        params.task,
        signal,
      );
      const truncated = truncateHead(result.text, {
        maxBytes: DEFAULT_MAX_BYTES,
        maxLines: DEFAULT_MAX_LINES,
      });
      const visibleResult = truncated.truncated
        ? `${truncated.content}\n\n[Worker response truncated for manager context; the full response remains in the Slack thread.]`
        : truncated.content;
      return {
        content: [{ type: "text", text: visibleResult }],
        details: {
          workerId: result.workerId,
          delegationId: result.delegationId,
          status: "completed",
        },
      };
    },
  });
}
