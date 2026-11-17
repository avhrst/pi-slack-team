import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import type { IncomingSlackMessage } from "../src/routing/chat-key.js";
import { SlackDeliveryQueue } from "../src/slack/console-reporter.js";
import { createSlackWorkThread, SlackWorkThread, slackWorkTopic } from "../src/slack/work-thread.js";

const source: IncomingSlackMessage = {
  kind: "app-mention", eventId: "Ev01", teamId: "T01", appId: "A01", channelId: "C01",
  channelType: "channel", userId: "U01", ts: "10.2", threadTs: "10.1", text: "Перевірка розгортання", files: [],
};
const workLink = "https://example.slack.com/archives/C01/p12000000?thread_ts=11.1&cid=C01";

function setup() {
  const chat = {
    postMessage: vi.fn<WebClient["chat"]["postMessage"]>().mockResolvedValue({ ok: true, ts: "11.1" }),
    update: vi.fn<WebClient["chat"]["update"]>().mockResolvedValue({ ok: true }),
    getPermalink: vi.fn<WebClient["chat"]["getPermalink"]>().mockResolvedValue({ ok: true, permalink: workLink }),
  };
  const apiCall = vi.fn<WebClient["apiCall"]>().mockResolvedValue({ ok: true });
  const client = { chat, apiCall };
  const onError = vi.fn();
  const queue = new SlackDeliveryQueue(0);
  return { apiCall, chat, client, onError, queue };
}

describe("Slack work thread", () => {
  it("creates a bot-owned root, subscribes the requester and links back to the source thread", async () => {
    const { client, chat, apiCall, queue, onError } = setup();
    chat.postMessage.mockResolvedValueOnce({ ok: true, ts: "11.1" }).mockResolvedValueOnce({ ok: true, ts: "12.0" });
    const root = await createSlackWorkThread(client, queue, source, true);
    expect(root).toBe("11.1");
    expect(chat.postMessage.mock.calls[0]?.[0]).not.toHaveProperty("thread_ts");
    expect(chat.postMessage.mock.calls[0]?.[0]).toMatchObject({
      channel: "C01", text: "⏳ Перевірка розгортання · У черзі",
    });

    const thread = new SlackWorkThread(client, queue, source, root, { onError });
    await thread.acknowledge(true, true);
    await thread.acknowledge(true, true);
    expect(apiCall).toHaveBeenNthCalledWith(1, "agents.sessions.setStatus", {
      channel_id: "C01", thread_ts: "11.1", initiator_user_id: "U01",
      status: "processing", title: "⏳ Перевірка розгортання · У черзі",
    });
    expect(chat.postMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({ channel: "C01", thread_ts: "11.1" }));
    expect(chat.getPermalink).toHaveBeenCalledWith({ channel: "C01", message_ts: "12.0" });
    expect(chat.postMessage).toHaveBeenNthCalledWith(3, expect.objectContaining({
      channel: "C01", thread_ts: "10.1", text: `🧵 <${workLink}|Відкрити хід роботи>`,
    }));
    expect(chat.postMessage).toHaveBeenCalledTimes(3);
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps an active turn's headline while a follow-up is queued and settles the final warning", async () => {
    const { client, chat, apiCall, queue } = setup();
    const followup = { ...source, text: "І що тепер?", ts: "13.0", threadTs: "11.1", eventId: "Ev02" };
    const thread = new SlackWorkThread(client, queue, followup, "11.1", { topic: "Перевірка розгортання" });
    await thread.acknowledge(true, false);
    expect(chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      thread_ts: "11.1", text: "⏳ Уточнення отримано й поставлено в чергу.",
    }));
    expect(apiCall).not.toHaveBeenCalled();
    expect(chat.update).not.toHaveBeenCalled();

    await thread.running();
    await thread.updateSummary("8 із 12 операцій");
    await thread.waitingForInput();
    await thread.updateSummary("застарілий прогрес");
    await thread.running();
    await thread.complete("12 із 12 операцій", true);
    await thread.updateSummary("застарілий прогрес");

    const calls = apiCall.mock.calls.filter(([method]) => method === "agents.sessions.setStatus");
    expect(calls.map(([, args]) => args?.status)).toEqual(["processing", "suspended", "processing", "active"]);
    const title = "⚠️ Перевірка розгортання · Завершено з попередженням · 12 із 12 операцій";
    expect(apiCall).toHaveBeenLastCalledWith("agents.sessions.rename", { channel_id: "C01", thread_ts: "11.1", title });
    expect(chat.update).toHaveBeenLastCalledWith(expect.objectContaining({ channel: "C01", ts: "11.1", text: title }));
    expect(chat.update.mock.calls.map(([args]) => args.text)).not.toContain(expect.stringContaining("застарілий"));
    expect(chat.getPermalink).not.toHaveBeenCalled();
  });

  it("retains and updates the bot-owned summary when Agent Sessions is disabled", async () => {
    const { client, chat, apiCall, queue, onError } = setup();
    apiCall.mockRejectedValue({ code: "slack_webapi_platform_error", data: { error: "feature_disabled" } });
    const thread = new SlackWorkThread(client, queue, source, "11.1", { onError });
    await thread.acknowledge(false, true);
    await thread.running();
    await thread.updateSummary("2 із 3 операцій");
    await thread.fail("Звернення abc");
    expect(apiCall).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(chat.update).toHaveBeenLastCalledWith(expect.objectContaining({
      channel: "C01", ts: "11.1", text: "❌ Перевірка розгортання · Запит не завершено · Звернення abc",
    }));
    expect(chat.postMessage).toHaveBeenCalledTimes(2);
  });

  it("coalesces stale heading summaries and delivers the terminal view last", async () => {
    const { client, chat, apiCall, queue } = setup();
    const thread = new SlackWorkThread(client, queue, source, "11.1");
    await thread.running();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    chat.update.mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
      return { ok: true };
    });
    const first = thread.updateSummary("1 із 3 операцій");
    await started.promise;
    const stale = thread.updateSummary("2 із 3 операцій");
    const complete = thread.complete("3 із 3 операцій");
    release.resolve();
    await Promise.all([first, stale, complete]);

    expect(chat.update.mock.calls.map(([args]) => args.text).join("\n")).not.toContain("2 із 3 операцій");
    expect(apiCall).toHaveBeenLastCalledWith("agents.sessions.rename", expect.objectContaining({
      title: "✅ Перевірка розгортання · Завершено · 3 із 3 операцій",
    }));
  });

  it("does not replay an ambiguous root publication and redacts public heading input", async () => {
    const { client, chat, queue } = setup();
    chat.postMessage.mockRejectedValue({ code: "slack_webapi_request_error" });
    await expect(createSlackWorkThread(client, queue, source)).rejects.toMatchObject({ code: "slack_webapi_request_error" });
    expect(chat.postMessage).toHaveBeenCalledTimes(1);

    const fakeToken = ["xoxb", "test-topic-redaction-1234567890"].join("-");
    const topic = slackWorkTopic(`<!channel> \`git push\` ${fakeToken} <https://ex.test?secret=xyz|ref>\nignored text`);
    expect(topic).toContain("[секрет приховано]");
    expect(topic).not.toMatch(/channel|git push|xoxb-|xyz|ignored/u);
    expect(slackWorkTopic(" ")).toBe("Запит до агента");
    expect(slackWorkTopic("😀".repeat(100)).length).toBeLessThanOrEqual(90);
  });
});
