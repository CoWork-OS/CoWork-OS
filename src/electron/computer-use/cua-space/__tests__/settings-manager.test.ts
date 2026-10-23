import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let stored: unknown;
  return {
    get stored() {
      return stored;
    },
    set stored(value: unknown) {
      stored = value;
    },
    save: vi.fn((_category: string, value: unknown) => {
      stored = value;
      return true;
    }),
    load: vi.fn(() => stored),
  };
});

vi.mock("../../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: {
    isInitialized: () => true,
    getInstance: () => ({ save: mocks.save, load: mocks.load }),
  },
}));

import { CuaSpaceSettingsManager } from "../settings";

beforeEach(() => {
  mocks.stored = undefined;
  mocks.save.mockClear();
  CuaSpaceSettingsManager.clearCache();
});

describe("CuaSpaceSettingsManager", () => {
  it("stores the token encrypted and never returns it to display callers", () => {
    CuaSpaceSettingsManager.save({
      enabled: true,
      url: " http://192.168.64.5:3211 ",
      token: " secret ",
    });
    expect(mocks.save).toHaveBeenCalledWith("cua-space", {
      enabled: true,
      url: "http://192.168.64.5:3211",
      token: "secret",
    });
    const display = CuaSpaceSettingsManager.getDisplaySettings();
    expect(display).toEqual({
      enabled: true,
      url: "http://192.168.64.5:3211",
      tokenConfigured: true,
    });
    expect(JSON.stringify(display)).not.toContain("secret");
  });

  it("keeps the stored token when the update omits it and clears it on null", () => {
    CuaSpaceSettingsManager.save({ url: "http://127.0.0.1:3211", token: "secret" });
    CuaSpaceSettingsManager.save({ enabled: true });
    expect(CuaSpaceSettingsManager.load().token).toBe("secret");
    CuaSpaceSettingsManager.save({ token: null });
    expect(CuaSpaceSettingsManager.load()).toEqual({
      enabled: true,
      url: "http://127.0.0.1:3211",
    });
  });

  it("drops the stored token when the Space origin changes", () => {
    CuaSpaceSettingsManager.save({ url: "https://space.example.com", token: "secret" });
    CuaSpaceSettingsManager.save({ url: "https://space.example.com/other" });
    expect(CuaSpaceSettingsManager.load().token).toBe("secret");
    CuaSpaceSettingsManager.save({ url: "https://attacker.example" });
    expect(CuaSpaceSettingsManager.load().token).toBeUndefined();
    expect(() =>
      CuaSpaceSettingsManager.save({ url: "https://space.example.com", enabled: true }),
    ).toThrow(/token is required/);
  });

  it("refuses to enable an unusable Space and leaves the stored settings alone", () => {
    CuaSpaceSettingsManager.save({ url: "http://192.168.64.5:3211" });
    expect(() => CuaSpaceSettingsManager.save({ enabled: true })).toThrow(/token is required/);
    expect(CuaSpaceSettingsManager.load().enabled).toBe(false);
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });

  it("accepts any draft URL while the Space is off", () => {
    expect(() => CuaSpaceSettingsManager.save({ url: "http://example.com" })).not.toThrow();
  });

  it("surfaces a refused secure-storage write", () => {
    mocks.save.mockReturnValueOnce(false);
    expect(() => CuaSpaceSettingsManager.save({ url: "http://127.0.0.1:3211" })).toThrow(
      /secure storage refused/,
    );
  });

  it("treats malformed stored data as the defaults", () => {
    mocks.stored = { enabled: "yes", url: 42, token: "" };
    expect(CuaSpaceSettingsManager.load()).toEqual({ enabled: false, url: "" });
  });
});
