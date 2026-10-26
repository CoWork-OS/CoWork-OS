import { describe, expect, it } from "vitest";
import {
  desktopBrowserAppDeployment,
  isDesktopBrowserAppEnabled,
  normalizeBrowserAppPublicOrigin,
  storedBrowserAppPublicOrigin,
} from "../browser-app-settings";

describe("desktop browser app settings", () => {
  it("turns on from the setting or the environment", () => {
    expect(isDesktopBrowserAppEnabled({ browserApp: false }, {})).toBe(false);
    expect(isDesktopBrowserAppEnabled({ browserApp: true }, {})).toBe(true);
    expect(isDesktopBrowserAppEnabled({ browserApp: false }, { COWORK_WEB_ENABLED: "1" })).toBe(
      true,
    );
  });

  it("stays on loopback without a public address", () => {
    expect(desktopBrowserAppDeployment({ publicOrigin: "" }, {})).toEqual({ mode: "loopback" });
  });

  it("trusts only a proxy on this computer for a saved public address", () => {
    expect(desktopBrowserAppDeployment({ publicOrigin: "https://mac.example.ts.net" }, {})).toEqual(
      {
        mode: "https-proxy",
        publicOrigin: "https://mac.example.ts.net",
        trustedProxyAddresses: ["127.0.0.1", "::1"],
      },
    );
  });

  it("lets the environment override the saved address", () => {
    expect(
      desktopBrowserAppDeployment(
        { publicOrigin: "https://saved.example.com" },
        {
          COWORK_WEB_PUBLIC_ORIGIN: "https://env.example.com",
          COWORK_WEB_TRUSTED_PROXY_ADDRESSES: "10.0.0.2",
        },
      ),
    ).toEqual({
      mode: "https-proxy",
      publicOrigin: "https://env.example.com",
      trustedProxyAddresses: ["10.0.0.2"],
    });
  });

  it("accepts only HTTPS origins without a path", () => {
    expect(normalizeBrowserAppPublicOrigin("")).toBe("");
    expect(normalizeBrowserAppPublicOrigin("  ")).toBe("");
    expect(normalizeBrowserAppPublicOrigin(undefined)).toBe("");
    expect(normalizeBrowserAppPublicOrigin(" https://Mac.Example.ts.net/ ")).toBe(
      "https://mac.example.ts.net",
    );
    expect(normalizeBrowserAppPublicOrigin("https://mac.example.ts.net:8443")).toBe(
      "https://mac.example.ts.net:8443",
    );
    for (const bad of [
      "http://mac.example.ts.net",
      "https://mac.example.ts.net/app",
      "https://user:pw@mac.example.ts.net",
      "https://mac.example.ts.net?x=1",
      "mac.example.ts.net",
      42,
    ]) {
      expect(() => normalizeBrowserAppPublicOrigin(bad)).toThrow();
    }
  });

  it("drops an unusable stored address instead of failing startup", () => {
    expect(storedBrowserAppPublicOrigin("http://insecure.example.com")).toBe("");
    expect(storedBrowserAppPublicOrigin("https://ok.example.com")).toBe("https://ok.example.com");
  });
});
