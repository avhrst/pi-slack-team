import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentConfigSchema } from "../src/config/schema.js";
import type { IncomingSlackMessage } from "../src/routing/chat-key.js";
import { downloadSlackFiles } from "../src/slack/file-download.js";

const temporaryDirectories: string[] = [];

function setup() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-slack-files-"));
  temporaryDirectories.push(stateDir);
  const config = agentConfigSchema.parse({
    version: 1,
    agentId: "deploy",
    expectedUnixUser: "deploy-agent",
    stateDir,
    slack: {
      teamId: "T01",
      appId: "A01",
      allowedUserIds: ["U01"],
      fileUploads: true,
      maxFileBytes: 1024,
    },
    pi: {
      cwd: stateDir,
      agentDir: stateDir,
      sessionDir: path.join(stateDir, "sessions"),
    },
  });
  const message: IncomingSlackMessage = {
    kind: "direct-message",
    eventId: "Ev01",
    teamId: "T01",
    appId: "A01",
    channelId: "D01",
    channelType: "im",
    userId: "U01",
    ts: "123.456",
    text: "deploy this",
    files: [
      {
        id: "F01",
        name: "change.sql",
        mimetype: "text/plain",
        size: 9,
        urlPrivateDownload: "https://files.slack.com/files-pri/change.sql",
      },
    ],
  };
  return { config, message, stateDir };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Slack file downloads", () => {
  it("downloads an authorized attachment to private state storage", async () => {
    const { config, message, stateDir } = setup();
    const fetchFile = vi.fn(async () => new Response("select 1;"));

    const prompt = await downloadSlackFiles(
      config,
      message,
      "xoxb-secret",
      fetchFile,
    );

    const destination = path.join(
      stateDir,
      "uploads",
      "Ev01",
      "F01-change.sql",
    );
    expect(fs.readFileSync(destination, "utf8")).toBe("select 1;");
    expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
    expect(prompt).toContain(destination);
    expect(fetchFile).toHaveBeenCalledWith(
      new URL("https://files.slack.com/files-pri/change.sql"),
      expect.objectContaining({
        headers: { authorization: "Bearer xoxb-secret" },
        redirect: "error",
      }),
    );
  });

  it("rejects oversized files and untrusted URLs", async () => {
    const { config, message } = setup();
    message.files[0]!.size = 2048;
    await expect(
      downloadSlackFiles(config, message, "xoxb-secret"),
    ).rejects.toThrow("size limit");

    message.files[0]!.size = 9;
    message.files[0]!.urlPrivateDownload = "https://example.com/change.sql";
    await expect(
      downloadSlackFiles(config, message, "xoxb-secret"),
    ).rejects.toThrow("untrusted");
  });
});
