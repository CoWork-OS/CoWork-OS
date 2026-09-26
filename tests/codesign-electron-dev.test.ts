import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectIdentity,
  isSigningEnabled,
  selectSigningPlan,
} from "../scripts/codesign_electron_dev.mjs";

const NO_CONFIG = path.join(os.tmpdir(), "cowork-missing-dev-codesign.json");

describe("codesign_electron_dev", () => {
  it("does not infer a signing identity when the env var is absent", () => {
    expect(detectIdentity({}, NO_CONFIG)).toBeNull();
  });

  it("ignores blank configured signing identities", () => {
    expect(detectIdentity({ COWORK_CODESIGN_IDENTITY: "   " }, NO_CONFIG)).toBeNull();
  });

  it("reads a stable identity from the local dev-codesign config", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-codesign-"));
    const configPath = path.join(dir, "dev-codesign.json");
    try {
      fs.writeFileSync(configPath, JSON.stringify({ identity: "  ABCDEF0123  " }));
      expect(detectIdentity({}, configPath)).toBe("ABCDEF0123");
      expect(isSigningEnabled({}, configPath)).toBe(true);
      expect(detectIdentity({ COWORK_CODESIGN_IDENTITY: "From env" }, configPath)).toBe("From env");

      fs.writeFileSync(configPath, "{not json");
      expect(detectIdentity({}, configPath)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps development signing disabled by default", () => {
    expect(isSigningEnabled({}, NO_CONFIG)).toBe(false);
    expect(selectSigningPlan("signed", null)).toEqual({
      action: "skip",
      message:
        "Skipping Electron.app development signing. Set COWORK_CODESIGN_IDENTITY or add .cowork/dev-codesign.json to sign with a stable identity.",
    });
  });

  it("repairs an invalid Electron.app signature by default", () => {
    expect(selectSigningPlan("invalid", null)).toEqual({
      action: "sign",
      message: "Electron.app signature is invalid; applying an ad-hoc development signature.",
      signingIdentity: "-",
      timestamp: false,
      useEntitlements: false,
    });
  });

  it("enables signing with an explicit toggle", () => {
    expect(isSigningEnabled({ COWORK_CODESIGN_ENABLE: "1" }, NO_CONFIG)).toBe(true);
  });

  it("enables signing with an explicit identity", () => {
    expect(
      isSigningEnabled({ COWORK_CODESIGN_IDENTITY: "Apple Development: Example" }, NO_CONFIG),
    ).toBe(true);
  });

  it("replaces a team signature with ad-hoc signing when explicitly enabled", () => {
    expect(selectSigningPlan("signed", null, true)).toEqual({
      action: "sign",
      message: "Replacing existing team signature with an ad-hoc development signature.",
      signingIdentity: "-",
      timestamp: false,
      useEntitlements: false,
    });
  });

  it("skips when the app is already ad-hoc signed and no identity is configured", () => {
    expect(selectSigningPlan("adhoc", null, true)).toEqual({
      action: "skip",
      message: "Electron.app is already ad-hoc signed — skipping.",
    });
  });

  it("uses an explicit signing identity when configured", () => {
    expect(selectSigningPlan("adhoc", "Apple Development: Example (TEAMID1234)", true)).toEqual({
      action: "sign",
      message: "Signing Electron.app with: Apple Development: Example (TEAMID1234)",
      signingIdentity: "Apple Development: Example (TEAMID1234)",
      timestamp: true,
      useEntitlements: true,
    });
  });
});
