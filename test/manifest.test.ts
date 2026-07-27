import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("Slack app manifest", () => {
  it("provides a valid role-specific manifest for every Pi agent", () => {
    const expected = new Map([
      ["deploy-agent.yaml", { name: "Pinet Deploy", manager: false }],
      ["dev-agent.yaml", { name: "Pinet Dev", manager: true }],
      ["msboard-agent.yaml", { name: "Pinet MSBoard", manager: false }],
      ["support-agent.yaml", { name: "Pinet Support", manager: false }],
    ]);
    const files = fs
      .readdirSync("manifests")
      .filter((file) => file.endsWith("-agent.yaml"))
      .sort();

    expect(files).toEqual([...expected.keys()]);
    for (const file of files) {
      const manifest = parse(
        fs.readFileSync(`manifests/${file}`, "utf8"),
      ) as {
        display_information: { name: string; description: string };
        features: { bot_user: { display_name: string } };
        oauth_config: { scopes: { bot: string[] } };
        settings: {
          socket_mode_enabled: boolean;
          event_subscriptions: { bot_events: string[] };
        };
      };
      const expectedAgent = expected.get(file);
      expect(manifest.display_information.name).toBe(expectedAgent?.name);
      expect(manifest.features.bot_user.display_name).toBe(expectedAgent?.name);
      expect(manifest.display_information.description.length).toBeGreaterThan(0);
      expect(manifest.oauth_config.scopes.bot).toEqual([
        "app_mentions:read",
        "assistant:write",
        "channels:history",
        "chat:write",
        ...(file === "deploy-agent.yaml" ? ["files:read"] : []),
        "groups:history",
        "im:history",
      ]);
      expect(manifest.settings.event_subscriptions.bot_events).toEqual([
        "app_home_opened",
        "app_mention",
        ...(expectedAgent?.manager
          ? ["message.channels", "message.groups"]
          : []),
        "message.im",
      ]);
      expect(manifest.settings.socket_mode_enabled).toBe(true);
    }
  });

  it("uses Agent view, Socket Mode, DMs, and channel mentions", () => {
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
        "app_mention",
        "assistant_thread_started",
        "message.im",
      ]),
    );
    expect(manifest.settings.event_subscriptions.bot_events).not.toContain(
      "message.channels",
    );
  });

  it("keeps the support agent manifest least-privileged", () => {
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
      "app_mentions:read",
      "assistant:write",
      "channels:history",
      "chat:write",
      "groups:history",
      "im:history",
    ]);
    expect(manifest.settings.event_subscriptions.bot_events).toEqual([
      "app_home_opened",
      "app_mention",
      "message.im",
    ]);
    expect(manifest.settings.interactivity.is_enabled).toBe(false);
    expect(manifest.settings.socket_mode_enabled).toBe(true);
  });
});
