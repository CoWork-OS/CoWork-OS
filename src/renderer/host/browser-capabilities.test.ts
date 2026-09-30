import { afterEach, describe, expect, it, vi } from "vitest";
import { getHostCapabilityReason, hasHostCapability } from "./browser-capabilities";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser host workflow capabilities", () => {
  it("keeps native desktop workflows available", () => {
    vi.stubGlobal("window", {});

    expect(hasHostCapability("browser.interactive")).toBe(true);
    expect(getHostCapabilityReason("browser.interactive")).toBeUndefined();
  });

  it("uses the authenticated browser host capability and reason", () => {
    vi.stubGlobal("window", {
      coworkBrowserHost: true,
      coworkBrowserHostInfo: {
        capabilities: {
          "browser.interactive": {
            available: false,
            reason: "Interactive browser streaming is unavailable on this host.",
          },
        },
      },
    });

    expect(hasHostCapability("browser.interactive")).toBe(false);
    expect(getHostCapabilityReason("browser.interactive")).toBe(
      "Interactive browser streaming is unavailable on this host.",
    );
  });

  it("fails closed when a browser host omits a workflow capability", () => {
    vi.stubGlobal("window", { coworkBrowserHost: true, coworkBrowserHostInfo: {} });

    expect(hasHostCapability("browser.interactive")).toBe(false);
    expect(getHostCapabilityReason("browser.interactive")).toBe(
      "This workflow is not available in this browser session.",
    );
  });
});
