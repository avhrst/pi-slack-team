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

  it("keeps the support agent manifest DM-only and least-privileged", () => {
    const manifest = parse(
      fs.readFileSync("manifests/support-agent.yaml", "utf8"),
    ) as {
      features: {
        app_home: {
          home_tab_enabled: boolean;
          messages_tab_enabled: boolean;
          messages_tab_read_only_enabled: boolean;
        };
        agent_view?: unknown;
        assistant_view?: unknown;
        slash_commands?: unknown;
      };
      oauth_config: { scopes: { bot: string[] } };
      settings: {
        interactivity: { is_enabled: boolean };
        socket_mode_enabled: boolean;
        event_subscriptions: { bot_events: string[] };
      };
    };

    expect(manifest.features.agent_view).toBeDefined();
    expect(manifest.features.assistant_view).toBeUndefined();
    expect(manifest.features.slash_commands).toBeUndefined();
    expect(manifest.features.app_home).toEqual({
      home_tab_enabled: false,
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
    });
    expect(manifest.oauth_config.scopes.bot).toEqual([
      "assistant:write",
      "chat:write",
      "im:history",
    ]);
    expect(manifest.settings.event_subscriptions.bot_events).toEqual([
      "app_home_opened",
      "message.im",
    ]);
    expect(manifest.settings.interactivity.is_enabled).toBe(false);
    expect(manifest.settings.socket_mode_enabled).toBe(true);
  });
});
