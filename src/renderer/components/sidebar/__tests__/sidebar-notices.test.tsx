import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasComposerPredictionAvailable,
  markComposerPredictionAvailable,
} from "../../../hooks/useComposerPredictions";
import { recordShownSidebarNotices, SIDEBAR_NOTICES, SidebarNotices } from "../SidebarNotices";

const predictionNotice = SIDEBAR_NOTICES.find((notice) => notice.id === "composer-predictions-v1")!;
const seenKey = "cowork.sidebarNotices.seen";
const dismissedKey = "cowork.sidebarNotices.dismissed";

describe("composer prediction discovery", () => {
  let stored: Map<string, string>;
  let events: EventTarget & { electronAPI?: { getComposerPrediction: () => void } };

  beforeEach(() => {
    stored = new Map();
    events = Object.assign(new EventTarget(), {
      electronAPI: { getComposerPrediction: () => {} },
    });
    vi.stubGlobal("window", events);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("waits for the first usable prediction, then persists availability and announces it once", () => {
    const changed = vi.fn();
    events.addEventListener("composer-predictions-available-changed", changed);
    expect(hasComposerPredictionAvailable()).toBe(false);
    expect(renderToStaticMarkup(createElement(SidebarNotices))).not.toContain(
      "New: Composer predictions",
    );
    markComposerPredictionAvailable();
    markComposerPredictionAvailable();
    expect(hasComposerPredictionAvailable()).toBe(true);
    expect(changed).toHaveBeenCalledOnce();
    expect(renderToStaticMarkup(createElement(SidebarNotices))).toContain(
      "New: Composer predictions",
    );
  });

  it("does not advertise predictions on hosts without the prediction API", () => {
    markComposerPredictionAvailable();
    delete events.electronAPI;
    expect(renderToStaticMarkup(createElement(SidebarNotices))).not.toContain(
      "New: Composer predictions",
    );
  });

  it("opens the first-use tip once, including after a remount or reload", () => {
    expect(recordShownSidebarNotices([predictionNotice])).toBe(predictionNotice);
    expect(JSON.parse(stored.get(seenKey)!)).toContain(predictionNotice.id);
    expect(recordShownSidebarNotices([predictionNotice])).toBeUndefined();
    expect(
      recordShownSidebarNotices([predictionNotice], new Set(JSON.parse(stored.get(seenKey)!))),
    ).toBeUndefined();
  });

  it("keeps a dismissed notice hidden without hiding other sidebar notices", () => {
    markComposerPredictionAvailable();
    stored.set(dismissedKey, JSON.stringify([predictionNotice.id]));
    const markup = renderToStaticMarkup(createElement(SidebarNotices));
    expect(markup).not.toContain("New: Composer predictions");
    expect(markup).toContain("See how people use CoWork OS");
  });

  it("opens Appearance settings so users can turn predictions on or off", () => {
    const opened = vi.fn();
    events.addEventListener("open-settings", (event) => opened((event as CustomEvent).detail));
    predictionNotice.onActivate({ openUseCasesFallback: vi.fn() });
    expect(opened).toHaveBeenCalledExactlyOnceWith({ tab: "appearance" });
  });

  it("retains one-time tip behavior within the session when storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
    });
    const seen = new Set<string>();
    expect(recordShownSidebarNotices([predictionNotice], seen)).toBe(predictionNotice);
    expect(recordShownSidebarNotices([predictionNotice], seen)).toBeUndefined();
    expect(() => markComposerPredictionAvailable()).not.toThrow();
  });
});
