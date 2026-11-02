import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventGateSettings } from "../../../shared/types";

const store = vi.hoisted(() => ({ value: undefined as unknown }));

vi.mock("../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: {
    isInitialized: vi.fn().mockReturnValue(true),
    getInstance: vi.fn().mockReturnValue({
      save: vi.fn((_category: string, value: unknown) => {
        store.value = value;
      }),
      load: vi.fn(() => store.value),
    }),
  },
}));

import {
  EVENT_GATE_MAX_POLICIES,
  EventGateSettingsManager,
  normalizeEventGateSettings,
} from "../event-gate-manager";

describe("EventGateSettingsManager", () => {
  beforeEach(() => {
    store.value = undefined;
    EventGateSettingsManager.clearCache();
  });

  it("starts with no policies and every source in explicit_only", () => {
    const settings = EventGateSettingsManager.loadSettings();
    expect(settings).toEqual({ policies: [], sourceModes: {}, chatModes: {} });
    expect(EventGateSettingsManager.resolveEventMode({ source: "github_event", fields: {} })).toBe(
      "explicit_only",
    );
  });

  it("adds, toggles and removes policies and persists them", () => {
    let settings = EventGateSettingsManager.addPolicy(
      "  Act on   direct questions\nabout releases ",
    );
    expect(settings.policies).toHaveLength(1);
    const [policy] = settings.policies;
    expect(policy.text).toBe("Act on direct questions about releases");
    expect(policy.enabled).toBe(true);
    expect((store.value as EventGateSettings).policies[0].id).toBe(policy.id);

    settings = EventGateSettingsManager.togglePolicy(policy.id);
    expect(settings.policies[0].enabled).toBe(false);
    expect(EventGateSettingsManager.enabledPolicyTexts()).toEqual([]);
    settings = EventGateSettingsManager.togglePolicy(policy.id, true);
    expect(EventGateSettingsManager.enabledPolicyTexts()).toEqual([
      "Act on direct questions about releases",
    ]);

    settings = EventGateSettingsManager.removePolicy(policy.id);
    expect(settings.policies).toEqual([]);
  });

  it("rejects empty policies, unknown ids and too many policies", () => {
    expect(() => EventGateSettingsManager.addPolicy("   ")).toThrow(/required/);
    expect(() => EventGateSettingsManager.togglePolicy("missing")).toThrow(/not found/);
    for (let index = 0; index < EVENT_GATE_MAX_POLICIES; index += 1) {
      EventGateSettingsManager.addPolicy(`Policy ${index}`);
    }
    expect(() => EventGateSettingsManager.addPolicy("one more")).toThrow(/At most/);
  });

  it("sets source modes and lets a chat's own mode win for channel messages", () => {
    EventGateSettingsManager.setSourceMode("channel_message", "candidate");
    EventGateSettingsManager.setSourceMode("github_event", "ignore");
    EventGateSettingsManager.setChatMode("slack:C123", "explicit_only");

    expect(
      EventGateSettingsManager.resolveEventMode({
        source: "channel_message",
        fields: { channelType: "slack", chatId: "C123" },
      }),
    ).toBe("explicit_only");
    expect(
      EventGateSettingsManager.resolveEventMode({
        source: "channel_message",
        fields: { channelType: "slack", chatId: "C999" },
      }),
    ).toBe("candidate");
    expect(EventGateSettingsManager.resolveChatMode("slack", "C999")).toBe("candidate");
    expect(EventGateSettingsManager.resolveEventMode({ source: "github_event", fields: {} })).toBe(
      "ignore",
    );

    // explicit_only clears a source; null clears a chat.
    EventGateSettingsManager.setSourceMode("github_event", "explicit_only");
    EventGateSettingsManager.setChatMode("slack:C123", null);
    const settings = EventGateSettingsManager.loadSettings();
    expect(settings.sourceModes).toEqual({ channel_message: "candidate" });
    expect(settings.chatModes).toEqual({});
  });

  it("validates sources, modes and chat keys", () => {
    expect(() => EventGateSettingsManager.setSourceMode("shell", "candidate")).toThrow(/source/);
    expect(() => EventGateSettingsManager.setSourceMode("webhook", "sometimes")).toThrow(/mode/);
    expect(() => EventGateSettingsManager.setChatMode("no-separator", "candidate")).toThrow(
      /Chat key/,
    );
    expect(() => EventGateSettingsManager.setChatMode("slack:C1", "loud")).toThrow(/mode/);
  });

  it("drops corrupted stored values on load", () => {
    expect(
      normalizeEventGateSettings({
        policies: [
          { id: "a", text: "keep", enabled: true, createdAt: 1 },
          { id: "a", text: "duplicate id", enabled: true, createdAt: 2 },
          { id: "b", text: "", enabled: true, createdAt: 3 },
          "not a policy",
        ],
        sourceModes: { webhook: "candidate", bogus: "candidate", email: "nonsense" },
        chatModes: { "slack:C1": "ignore", broken: "ignore" },
      }),
    ).toEqual({
      policies: [{ id: "a", text: "keep", enabled: true, createdAt: 1 }],
      sourceModes: { webhook: "candidate" },
      chatModes: { "slack:C1": "ignore" },
    });
  });
});
