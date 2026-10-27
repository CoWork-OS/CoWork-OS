import { describe, expect, it } from "vitest";
import { DEFAULT_DEV_BUNDLE_ID, resolveDevBundleId } from "../scripts/brand_electron_dev_app.mjs";

describe("brand_electron_dev_app", () => {
  it("gives the dev Electron.app its own bundle id instead of com.github.Electron", () => {
    expect(resolveDevBundleId({})).toBe(DEFAULT_DEV_BUNDLE_ID);
    expect(DEFAULT_DEV_BUNDLE_ID).toBe("com.cowork-os.app.dev");
  });

  it("lets COWORK_DEV_BUNDLE_ID choose another identifier", () => {
    expect(resolveDevBundleId({ COWORK_DEV_BUNDLE_ID: " com.example.cowork " })).toBe(
      "com.example.cowork",
    );
  });

  it("rejects values that are not bundle identifiers", () => {
    expect(() => resolveDevBundleId({ COWORK_DEV_BUNDLE_ID: "bad id; rm -rf" })).toThrow(
      /not a bundle identifier/,
    );
    expect(() => resolveDevBundleId({ COWORK_DEV_BUNDLE_ID: "nodots" })).toThrow();
  });
});
