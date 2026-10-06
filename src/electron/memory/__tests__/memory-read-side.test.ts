import { beforeEach, describe, expect, it, vi } from "vitest";

const personality = vi.hoisted(() => ({
  current: { responseLength: "balanced", emojiUsage: "minimal" } as Record<string, string>,
  explicit: false,
}));

vi.mock("../../settings/personality-manager", () => ({
  PersonalityManager: {
    loadSettings: vi.fn(() => ({ responseStyle: personality.current })),
    setResponseStyle: vi.fn((style: Record<string, string>) => {
      personality.current = { ...personality.current, ...style };
    }),
    setResponseStyleExplicit: vi.fn((value: boolean) => {
      personality.explicit = value;
    }),
  },
}));

import {
  isRevertOfStyleAdaptation,
  withSettingsResponseStyleMirror,
} from "../memory-read-side";

const hasExplicitResponseStyle = () => personality.explicit;

describe("Settings response style choices", () => {
  beforeEach(() => {
    personality.current = { responseLength: "balanced", emojiUsage: "minimal" };
    personality.explicit = false;
  });

  it("marks a changed style explicit, and leaves an unchanged save alone", () => {
    withSettingsResponseStyleMirror(() => undefined);
    expect(hasExplicitResponseStyle()).toBe(false);

    const result = withSettingsResponseStyleMirror(() => {
      personality.current = { responseLength: "terse", emojiUsage: "none" };
      return "saved";
    });
    expect(result).toBe("saved");
    expect(hasExplicitResponseStyle()).toBe(true);
  });

  describe("stale settings saves", () => {
    const adapted = { responseLength: "terse", emojiUsage: "minimal" };
    const loadedByForm = { responseLength: "balanced", emojiUsage: "minimal" };
    const history = [{ dimension: "responseLength", fromValue: "balanced", toValue: "terse" }];

    beforeEach(() => {
      // The engine adapted the style after the form loaded it.
      personality.current = { ...adapted };
    });

    it("does not record a stale form copy and keeps the adapted style (baseline sent)", () => {
      withSettingsResponseStyleMirror(
        () => {
          personality.current = { ...loadedByForm };
        },
        { baseline: loadedByForm },
      );
      expect(hasExplicitResponseStyle()).toBe(false);
      // The stale copy did not revert what the engine adapted.
      expect(personality.current.responseLength).toBe("terse");
    });

    it("records a style the user changed in the form (baseline sent)", () => {
      withSettingsResponseStyleMirror(
        () => {
          personality.current = { responseLength: "detailed", emojiUsage: "minimal" };
        },
        { baseline: loadedByForm },
      );
      expect(hasExplicitResponseStyle()).toBe(true);
    });

    it("without a baseline, does not record a save that exactly undoes the last adaptation", () => {
      withSettingsResponseStyleMirror(
        () => {
          personality.current = { ...loadedByForm };
        },
        { adaptationHistory: history },
      );
      expect(hasExplicitResponseStyle()).toBe(false);

      // Any other change is still the user's choice.
      withSettingsResponseStyleMirror(
        () => {
          personality.current = { responseLength: "detailed", emojiUsage: "none" };
        },
        { adaptationHistory: history },
      );
      expect(hasExplicitResponseStyle()).toBe(true);
    });
  });
});

describe("isRevertOfStyleAdaptation", () => {
  const history = [
    { dimension: "responseLength", fromValue: "detailed", toValue: "balanced" },
    { dimension: "responseLength", fromValue: "balanced", toValue: "terse" },
    { dimension: "emojiUsage", fromValue: "none", toValue: "minimal" },
  ];

  it("matches only the latest adaptation of every changed dimension", () => {
    expect(
      isRevertOfStyleAdaptation(
        { responseLength: "terse", emojiUsage: "minimal" },
        { responseLength: "balanced", emojiUsage: "none" },
        history,
      ),
    ).toBe(true);
    // An older value of the dimension is not the latest adaptation.
    expect(
      isRevertOfStyleAdaptation({ responseLength: "terse" }, { responseLength: "detailed" }, history),
    ).toBe(false);
    // A changed dimension the engine never adapted is a user change.
    expect(
      isRevertOfStyleAdaptation(
        { responseLength: "terse", codeCommentStyle: "minimal" },
        { responseLength: "balanced", codeCommentStyle: "verbose" },
        history,
      ),
    ).toBe(false);
    expect(isRevertOfStyleAdaptation({ responseLength: "terse" }, { responseLength: "terse" }, history)).toBe(
      false,
    );
    expect(isRevertOfStyleAdaptation({ responseLength: "terse" }, { responseLength: "balanced" }, [])).toBe(
      false,
    );
  });
});
