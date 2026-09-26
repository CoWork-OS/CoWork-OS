import { describe, expect, it } from "vitest";
import {
  PROTECTED_IDENTITIES,
  REMOVABLE_IDENTITIES,
  keychainAccounts,
} from "../scripts/cleanup-legacy-keychain.mjs";
import { LEGACY_MAC_SAFE_STORAGE_APP_NAMES } from "../src/electron/utils/mac-safe-storage-identity";

describe("cleanup-legacy-keychain", () => {
  it("never removes the current identity or identities shared with other software", () => {
    for (const name of PROTECTED_IDENTITIES) {
      expect(REMOVABLE_IDENTITIES).not.toContain(name);
    }
    expect(PROTECTED_IDENTITIES).toEqual(
      expect.arrayContaining(["CoWork OS", "Electron", "com.github.Electron", "Chromium"]),
    );
  });

  it("covers every CoWork-specific legacy identity the startup migration reads", () => {
    const coworkSpecific = LEGACY_MAC_SAFE_STORAGE_APP_NAMES.filter(
      (name) => !PROTECTED_IDENTITIES.includes(name),
    );
    expect(REMOVABLE_IDENTITIES).toEqual(expect.arrayContaining(coworkSpecific));
  });

  it("targets both Keychain account forms for an identity", () => {
    expect(keychainAccounts("cowork-os")).toEqual(["cowork-os", "cowork-os Key"]);
  });
});
