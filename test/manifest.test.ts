import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("Slack app manifest", () => {
  it("uses Agent view, Socket Mode, and DM-only message events", () => {
    const manifest = parse(
      fs.readFileSync("manifests/slack-agent.template.yaml", "utf8"),
    ) as {
      features: Record<string, unknown>;
      settings: {
        socket_mode_enabled: boolean;
        event_subscriptions: { bot_events: string[] };
      };
    };

    expect(manifest.features).toHaveProperty("agent_view");
    expect(manifest.settings.socket_mode_enabled).toBe(true);
    expect(manifest.settings.event_subscriptions.bot_events).toEqual(
      expect.arrayContaining([
        "app_home_opened",
        "assistant_thread_started",
        "message.im",
      ]),
    );
    expect(manifest.settings.event_subscriptions.bot_events).not.toContain(
      "message.channels",
    );
  });
});
