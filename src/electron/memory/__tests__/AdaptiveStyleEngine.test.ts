import { describe, it, expect, vi, beforeEach } from "vitest";
import { AdaptiveStyleEngine } from "../AdaptiveStyleEngine";

// ── Mocks ─────────────────────────────────────────────────────────────

const mockSecureStore = new Map<string, string>();

vi.mock("../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: {
    getInstance: () => ({
      load: (key: string) => {
        const raw = mockSecureStore.get(key);
        return raw ? JSON.parse(raw) : null;
      },
      save: (key: string, value: unknown) => mockSecureStore.set(key, JSON.stringify(value)),
    }),
  },
}));

let mockGuardrails = {
  adaptiveStyleEnabled: true,
  adaptiveStyleMaxDriftPerWeek: 3,
};

vi.mock("../../guardrails/guardrail-manager", () => ({
  GuardrailManager: {
    loadSettings: () => mockGuardrails,
  },
}));

let mockResponseStyle = {
  emojiUsage: "minimal" as const,
  responseLength: "balanced" as const,
  codeCommentStyle: "moderate" as const,
  explanationDepth: "balanced" as const,
};

const setResponseStyleMock = vi.fn((style: Record<string, string>) => {
  Object.assign(mockResponseStyle, style);
});

vi.mock("../../settings/personality-manager", () => ({
  PersonalityManager: {
    loadSettings: () => ({ responseStyle: mockResponseStyle }),
    setResponseStyle: (...args: unknown[]) =>
      setResponseStyleMock(...(args as [Record<string, string>])),
  },
}));

// ── Tests ─────────────────────────────────────────────────────────────

describe("AdaptiveStyleEngine", () => {
  beforeEach(() => {
    mockSecureStore.clear();
    setResponseStyleMock.mockClear();
    mockGuardrails = {
      adaptiveStyleEnabled: true,
      adaptiveStyleMaxDriftPerWeek: 3,
    };
    mockResponseStyle = {
      emojiUsage: "minimal",
      responseLength: "balanced",
      codeCommentStyle: "moderate",
      explanationDepth: "balanced",
    };
    AdaptiveStyleEngine.reset();
  });

  describe("observe", () => {
    it("does nothing when disabled", () => {
      mockGuardrails.adaptiveStyleEnabled = false;
      for (let i = 0; i < 20; i++) {
        AdaptiveStyleEngine.observe("short msg");
      }
      expect(setResponseStyleMock).not.toHaveBeenCalled();
    });

    it("accumulates observations without immediate adaptation", () => {
      AdaptiveStyleEngine.observe("Hello there!");
      expect(setResponseStyleMock).not.toHaveBeenCalled();
    });

    it("ignores very short messages", () => {
      AdaptiveStyleEngine.observe("hi");
      const stats = AdaptiveStyleEngine.getObservationStats();
      expect(stats.totalMessages).toBe(0);
    });

    it("tracks message count", () => {
      for (let i = 0; i < 5; i++) {
        AdaptiveStyleEngine.observe(`Message number ${i + 1} with enough content`);
      }
      const stats = AdaptiveStyleEngine.getObservationStats();
      expect(stats.totalMessages).toBe(5);
    });
  });

  describe("observeFeedback", () => {
    it("triggers adaptation on 'too verbose' feedback", () => {
      AdaptiveStyleEngine.observeFeedback("reject", "Response was too verbose and wordy");

      expect(setResponseStyleMock).toHaveBeenCalledWith(
        expect.objectContaining({ responseLength: "terse" }),
      );
    });

    it("triggers adaptation on 'more detail' feedback", () => {
      AdaptiveStyleEngine.observeFeedback("reject", "Please give more detailed explanations");

      expect(setResponseStyleMock).toHaveBeenCalledWith(
        expect.objectContaining({ responseLength: "detailed" }),
      );
    });

    it("triggers adaptation on emoji feedback", () => {
      AdaptiveStyleEngine.observeFeedback("reject", "Please stop using emoji in responses");

      expect(setResponseStyleMock).toHaveBeenCalledWith(
        expect.objectContaining({ emojiUsage: "none" }),
      );
    });

    it("triggers adaptation on technical depth feedback", () => {
      AdaptiveStyleEngine.observeFeedback("reject", "Skip the basics, I'm an expert");

      expect(setResponseStyleMock).toHaveBeenCalledWith(
        expect.objectContaining({ explanationDepth: "expert" }),
      );
    });

    it("does nothing when disabled", () => {
      mockGuardrails.adaptiveStyleEnabled = false;
      AdaptiveStyleEngine.observeFeedback("reject", "Response was too verbose");
      expect(setResponseStyleMock).not.toHaveBeenCalled();
    });
  });

  describe("rate limiting", () => {
    it("respects weekly drift limit", () => {
      // Allow only 1 drift per week
      mockGuardrails.adaptiveStyleMaxDriftPerWeek = 1;

      // First feedback should work
      AdaptiveStyleEngine.observeFeedback("reject", "Too verbose");
      expect(setResponseStyleMock).toHaveBeenCalledTimes(1);

      // Second feedback should be blocked by rate limit
      setResponseStyleMock.mockClear();
      AdaptiveStyleEngine.observeFeedback("reject", "No emoji please");
      expect(setResponseStyleMock).not.toHaveBeenCalled();
    });
  });

  describe("pattern-based adaptation", () => {
    it("adapts to short messages suggesting terse preference", () => {
      // Send many short messages to trigger pattern detection
      for (let i = 0; i < 20; i++) {
        AdaptiveStyleEngine.observe("fix bug");
      }
      // Force adaptation check
      AdaptiveStyleEngine.maybeAdapt();

      expect(setResponseStyleMock).toHaveBeenCalledWith(
        expect.objectContaining({ responseLength: "terse" }),
      );
    });

    it("adapts to emoji-heavy messages", () => {
      for (let i = 0; i < 20; i++) {
        AdaptiveStyleEngine.observe("Great work! 🎉 Love this feature! 🚀");
      }
      AdaptiveStyleEngine.maybeAdapt();

      expect(setResponseStyleMock).toHaveBeenCalledWith(
        expect.objectContaining({ emojiUsage: "moderate" }),
      );
    });

    it("adapts to technical vocabulary", () => {
      for (let i = 0; i < 20; i++) {
        AdaptiveStyleEngine.observe(
          "Deploy the docker container with kubernetes, configure the nginx proxy and redis cache",
        );
      }
      AdaptiveStyleEngine.maybeAdapt();

      expect(setResponseStyleMock).toHaveBeenCalledWith(
        expect.objectContaining({ explanationDepth: "expert" }),
      );
    });
  });

  describe("adaptation history", () => {
    it("records adaptations in history", () => {
      AdaptiveStyleEngine.observeFeedback("reject", "Too verbose and wordy");
      const history = AdaptiveStyleEngine.getAdaptationHistory();

      expect(history.length).toBe(1);
      expect(history[0].dimension).toBe("responseLength");
      expect(history[0].fromValue).toBe("balanced");
      expect(history[0].toValue).toBe("terse");
      expect(history[0].reason).toContain("feedback");
    });
  });

  describe("observation stats", () => {
    it("returns current stats", () => {
      const stats = AdaptiveStyleEngine.getObservationStats();
      expect(stats.enabled).toBe(true);
      expect(stats.totalMessages).toBe(0);
      expect(stats.weeklyAdaptations).toBe(0);
      expect(stats.maxWeeklyDrift).toBe(3);
    });
  });

  describe("scale shifting", () => {
    it("does not shift beyond scale boundaries", () => {
      // Already at "minimal" emoji, try to decrease
      mockResponseStyle.emojiUsage = "none";
      AdaptiveStyleEngine.observeFeedback("reject", "No emoji please");
      // Should not crash or call setResponseStyle for emoji
      // (it may still adapt other dimensions though)
    });

    it("does not shift when already at target extreme", () => {
      mockResponseStyle.responseLength = "terse";
      AdaptiveStyleEngine.observeFeedback("reject", "Too verbose");
      // Can't go below "terse" — nothing should change for responseLength
      if (setResponseStyleMock.mock.calls.length > 0) {
        const call = setResponseStyleMock.mock.calls[0][0];
        expect(call.responseLength).toBeUndefined();
      }
    });
  });
});
