import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WatchdogSettingsSection } from "../WatchdogSettingsSection";

const globalWithWindow = globalThis as unknown as { window?: unknown };
const originalWindow = globalWithWindow.window;

afterEach(() => {
  globalWithWindow.window = originalWindow;
});

describe("WatchdogSettingsSection", () => {
  it("renders nothing on hosts without the watchdog settings", () => {
    globalWithWindow.window = { electronAPI: {} };
    expect(renderToStaticMarkup(React.createElement(WatchdogSettingsSection))).toBe("");
  });

  it("explains the watchdog where the host offers it", () => {
    globalWithWindow.window = {
      electronAPI: {
        getWatchdogSettings: vi.fn(() => new Promise(() => {})),
        saveWatchdogSettings: vi.fn(),
      },
    };
    const markup = renderToStaticMarkup(React.createElement(WatchdogSettingsSection));
    expect(markup).toContain("<h3>Progress Watchdog</h3>");
    expect(markup).toContain("steering note");
  });
});
