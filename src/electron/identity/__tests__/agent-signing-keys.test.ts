import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  initialized: true,
  result: { status: "not_found" } as { status: string; data?: Any },
  saved: [] as Any[],
}));

vi.mock("../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: {
    isInitialized: () => store.initialized,
    getInstance: () => ({
      loadWithStatus: () => store.result,
      save: (_category: string, value: Any) => {
        store.saved.push(value);
        store.result = { status: "success", data: value };
        return true;
      },
    }),
  },
}));

import {
  AgentSigningKeyUnavailableError,
  PREVIOUS_KEY_OVERLAP_MS,
  agentPublicJwks,
  getAgentSigningKey,
  resetAgentSigningKeyCache,
  rotateAgentSigningKey,
} from "../agent-signing-keys";

describe("agent signing key", () => {
  beforeEach(() => {
    store.initialized = true;
    store.result = { status: "not_found" };
    store.saved = [];
    resetAgentSigningKeyCache();
  });

  it("creates a key only when none was ever stored, then reuses it", () => {
    const key = getAgentSigningKey()!;
    expect(store.saved).toHaveLength(1);
    resetAgentSigningKeyCache();
    expect(getAgentSigningKey()!.keyid).toBe(key.keyid);
    expect(store.saved).toHaveLength(1);
  });

  it("never replaces a stored key it cannot read", () => {
    for (const status of ["decryption_failed", "checksum_mismatch", "os_encryption_unavailable"]) {
      resetAgentSigningKeyCache();
      store.result = { status };
      expect(() => getAgentSigningKey()).toThrow(AgentSigningKeyUnavailableError);
    }
    resetAgentSigningKeyCache();
    store.result = { status: "success", data: { privateKeyPem: "not a key", createdAt: 1 } };
    expect(() => getAgentSigningKey()).toThrow(AgentSigningKeyUnavailableError);
    expect(store.saved).toHaveLength(0);
  });

  it("is unavailable, not created, while the encrypted store is closed", () => {
    store.initialized = false;
    expect(getAgentSigningKey()).toBeUndefined();
    expect(rotateAgentSigningKey()).toBeUndefined();
    expect(store.saved).toHaveLength(0);
  });

  it("keeps a replaced key in the directory for the overlap period only", () => {
    const first = getAgentSigningKey()!;
    const second = rotateAgentSigningKey()!;
    expect(second.keyid).not.toBe(first.keyid);
    expect(second.previous?.x).toBe(first.x);

    const retiredAt = second.previous!.retiredAt;
    expect(agentPublicJwks(second, retiredAt + 1)!.keys.map((key) => key.kid)).toEqual([
      second.keyid,
      first.keyid,
    ]);
    expect(
      agentPublicJwks(second, retiredAt + PREVIOUS_KEY_OVERLAP_MS)!.keys.map((key) => key.kid),
    ).toEqual([second.keyid]);
  });

  it("lets the user replace a key that can no longer be read", () => {
    store.result = { status: "decryption_failed" };
    const replaced = rotateAgentSigningKey()!;
    expect(replaced.previous).toBeUndefined();
    expect(store.saved).toHaveLength(1);
    resetAgentSigningKeyCache();
    expect(getAgentSigningKey()!.keyid).toBe(replaced.keyid);
  });
});
