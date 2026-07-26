import fs from "node:fs/promises";
import path from "node:path";
import type { AgentConfig } from "../config/schema.js";
import type {
  IncomingSlackFile,
  IncomingSlackMessage,
} from "../routing/chat-key.js";

export type FetchSlackFile = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

function safeSegment(value: string, fallback: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, "_");
  return sanitized && sanitized !== "." && sanitized !== ".."
    ? sanitized
    : fallback;
}

function validateSlackDownload(file: IncomingSlackFile, maxBytes: number): URL {
  if (file.size > maxBytes) {
    throw new Error(`Slack file ${file.id} exceeds the configured size limit`);
  }
  const url = new URL(file.urlPrivateDownload);
  if (url.protocol !== "https:" || url.hostname !== "files.slack.com") {
    throw new Error(`Slack file ${file.id} has an untrusted download URL`);
  }
  return url;
}

async function readBounded(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.ok || !response.body) {
    throw new Error(`Slack file download failed with HTTP ${response.status}`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("Slack file response exceeds the configured size limit");
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  const reader = response.body.getReader();
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error("Slack file response exceeds the configured size limit");
    }
    chunks.push(Buffer.from(part.value));
  }
  return Buffer.concat(chunks, bytes);
}

export async function downloadSlackFiles(
  config: AgentConfig,
  message: IncomingSlackMessage,
  botToken: string,
  fetchFile: FetchSlackFile = fetch,
): Promise<string> {
  if (message.files.length === 0) return message.text;

  const directory = path.join(
    config.stateDir,
    "uploads",
    safeSegment(message.eventId, "event"),
  );
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });

  const attachments: string[] = [];
  for (const file of message.files) {
    const url = validateSlackDownload(file, config.slack.maxFileBytes);
    const response = await fetchFile(url, {
      headers: { authorization: `Bearer ${botToken}` },
      redirect: "error",
    });
    const content = await readBounded(response, config.slack.maxFileBytes);
    const filename = `${safeSegment(file.id, "file")}-${safeSegment(path.basename(file.name), "upload")}`;
    const destination = path.join(directory, filename);
    await fs.writeFile(destination, content, { mode: 0o600, flag: "wx" });
    attachments.push(
      `- ${file.name}${file.mimetype ? ` (${file.mimetype})` : ""}: ${destination}`,
    );
  }

  return [
    message.text.trim(),
    "Slack attachments were downloaded to these local paths:",
    ...attachments,
  ]
    .filter(Boolean)
    .join("\n");
}
