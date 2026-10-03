import { afterEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  initialized: true,
  value: undefined as unknown,
  failUpdate: false,
  updates: 0,
}));

vi.mock("../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: {
    isInitialized: () => store.initialized,
    getInstance: () => ({
      load: () => store.value,
      update: (_category: string, mutate: (current: unknown) => unknown) => {
        store.updates += 1;
        if (store.failUpdate) throw new Error("keychain changed");
        const next = mutate(store.value);
        if (next !== undefined) store.value = next;
        return { value: store.value, revision: 1 };
      },
    }),
  },
}));

import {
  getCheckpointSigningKey,
  setCheckpointSigningKeyForTests,
  signCheckpointBody,
  verifyCheckpointSignature,
} from "../checkpoint-signing";

afterEach(() => {
  store.initialized = true;
  store.value = undefined;
  store.failUpdate = false;
  store.updates = 0;
  setCheckpointSigningKeyForTests(null);
});

describe("checkpoint signing key", () => {
  it("creates one persistent key in the encrypted settings store and reuses it", () => {
    setCheckpointSigningKeyForTests(null);
    const first = getCheckpointSigningKey();
    expect(first).toHaveLength(32);
    expect(store.updates).toBe(1);
    expect((store.value as { key: string }).key).toBe(first.toString("base64"));

    // A new process (cache cleared) reads the same stored key.
    setCheckpointSigningKeyForTests(null);
    expect(getCheckpointSigningKey().equals(first)).toBe(true);
    expect(store.updates).toBe(1);
  });

  it("falls back to a process-only key when the store cannot be written", () => {
    store.failUpdate = true;
    setCheckpointSigningKeyForTests(null);
    const key = getCheckpointSigningKey();
    expect(key).toHaveLength(32);
    expect(store.value).toBeUndefined();
    expect(getCheckpointSigningKey().equals(key)).toBe(true);
  });

  it("binds signatures to the task, generation and body", () => {
    setCheckpointSigningKeyForTests("fixed-key");
    const signature = signCheckpointBody("task-1", 2, "{}");
    expect(verifyCheckpointSignature("task-1", 2, "{}", signature)).toBe(true);
    expect(verifyCheckpointSignature("task-2", 2, "{}", signature)).toBe(false);
    expect(verifyCheckpointSignature("task-1", 3, "{}", signature)).toBe(false);
    expect(verifyCheckpointSignature("task-1", 2, '{"a":1}', signature)).toBe(false);
    expect(verifyCheckpointSignature("task-1", 2, "{}", "not-hex")).toBe(false);
  });
});
