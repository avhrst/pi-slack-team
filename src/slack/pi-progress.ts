import { decodeSlackEntities, escapeSlackText } from "./mrkdwn.js";

const DEPLOY_STORE_RE = /^[A-Z0-9_]{1,32}$/u;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

// The fence alternative also matches an unclosed fence, so a streamed code
// block is never parsed as prose while its closing fence is still pending.
const CODE_SEGMENT_RE = /(```[\s\S]*?(?:```|$)|`[^`\n]+`)/gu;
const MARKDOWN_LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/gu;

function slackLink(match: string, label: string, escapedUrl: string): string {
  const url = decodeSlackEntities(escapedUrl);
  if (/[<>|]/u.test(url)) return match;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return match;
  } catch {
    return match;
  }
  return `<${escapedUrl}|${label}>`;
}

/** Prose is escaped before any rule that emits Slack `<url|label>` markup. */
function transformMarkdownSegment(text: string): string {
  return escapeSlackText(text)
    .replace(/^#{1,6}\s+(.+)$/gmu, "*$1*")
    .replace(MARKDOWN_LINK_RE, slackLink)
    .replace(/\*\*([^*\n]+)\*\*/gu, "*$1*")
    .replace(/__([^_\n]+)__/gu, "*$1*");
}

/** Slack has no syntax highlighting; an info string would render as code. */
function transformCodeSegment(text: string): string {
  if (!text.startsWith("```")) return escapeSlackText(text);
  const body = text.slice(3).replace(/^[^\n`]*\n/u, "\n");
  return `\`\`\`${escapeSlackText(body)}`;
}

function jsonText(value: unknown): string {
  if (value === undefined) return "";
  const encoded = JSON.stringify(value, null, 2);
  return encoded ?? String(value);
}

function resultText(value: unknown): string {
  const record = asRecord(value);
  if (Array.isArray(record?.content)) {
    const text = record.content
      .map((item) => asRecord(item))
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item?.text as string)
      .join("\n");
    if (text) return text;
  }
  return jsonText(value);
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

export interface DeploymentSnapshot {
  stage: "apex" | "sql-files";
  state: "running" | "completed";
  planned: number;
  completed: number;
  pending: number;
  ok: number;
  warn: number;
  fail: number;
  skip: number;
  current?: string;
}

export function deploymentSnapshot(value: unknown): DeploymentSnapshot | undefined {
  const text = resultText(value);
  const markers = [...text.matchAll(/PI_DEPLOY_PROGRESS (\{[^\r\n]{1,1200}\})/gu)];
  const encoded = markers.at(-1)?.[1];
  if (!encoded) return undefined;

  let payload: Record<string, unknown>;
  try {
    payload = asRecord(JSON.parse(encoded)) ?? {};
  } catch {
    return undefined;
  }
  const stage = payload.stage;
  const state = payload.state;
  const planned = safeInteger(payload.planned);
  const completed = safeInteger(payload.completed);
  const pending = safeInteger(payload.pending);
  const ok = safeInteger(payload.ok);
  const warn = safeInteger(payload.warn);
  const fail = safeInteger(payload.fail);
  const skip = safeInteger(payload.skip);
  const current = payload.current;
  if (
    payload.version !== 1 ||
    !["apex", "sql-files"].includes(String(stage)) ||
    !["running", "completed"].includes(String(state)) ||
    planned === undefined ||
    completed === undefined ||
    pending === undefined ||
    ok === undefined ||
    warn === undefined ||
    fail === undefined ||
    skip === undefined ||
    completed > planned ||
    pending !== planned - completed ||
    ok + warn + fail + skip !== completed ||
    !(current === null || current === undefined ||
      (typeof current === "string" && DEPLOY_STORE_RE.test(current)))
  ) {
    return undefined;
  }

  return { stage: stage as DeploymentSnapshot["stage"], state: state as DeploymentSnapshot["state"],
    planned, completed, pending, ok, warn, fail, skip,
    ...(typeof current === "string" ? { current } : {}) };
}

export function toSlackMrkdwn(text: string): string {
  return text
    .split(CODE_SEGMENT_RE)
    .map((segment) =>
      segment.startsWith("`")
        ? transformCodeSegment(segment)
        : transformMarkdownSegment(segment),
    )
    .join("");
}
