import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChronicleSettingsCard } from "../ChronicleSettings";
import { ComputerUseSettings } from "../ComputerUseSettings";

describe("desktop-only settings cards", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("show a desktop-app note in a browser session without the host methods", () => {
    const electronAPI = new Proxy(
      {},
      {
        get: (_target, method) => {
          throw new Error(`unexpected host call: ${String(method)}`);
        },
      },
    );
    vi.stubGlobal("window", {
      coworkBrowserHost: true,
      coworkBrowserHostInfo: { desktopMethods: {} },
      electronAPI,
    });

    const chronicle = renderToStaticMarkup(React.createElement(ChronicleSettingsCard));
    expect(chronicle).toContain("Chronicle");
    expect(chronicle).toContain("Configure it in the desktop app.");
    expect(chronicle).not.toContain("Loading Chronicle");

    const computerUse = renderToStaticMarkup(React.createElement(ComputerUseSettings));
    expect(computerUse).toContain("Computer use");
    expect(computerUse).toContain("in the desktop app.");
    expect(computerUse).not.toContain("Loading computer use");
  });

  it("render the full cards on the desktop", () => {
    vi.stubGlobal("window", { electronAPI: {} });

    expect(renderToStaticMarkup(React.createElement(ChronicleSettingsCard))).toContain(
      "Loading Chronicle",
    );
    expect(renderToStaticMarkup(React.createElement(ComputerUseSettings))).toContain(
      "Loading computer use",
    );
  });
});
