import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ document: undefined as Any }));

vi.mock("../../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: {
    isInitialized: () => true,
    getInstance: () => ({
      load: () => state.document,
      save: (_category: string, document: Any) => {
        state.document = structuredClone(document);
      },
    }),
  },
}));

import { RoutineWorkflowSecretStore } from "../secret-store";

describe("RoutineWorkflowSecretStore", () => {
  beforeEach(() => {
    state.document = undefined;
  });

  it("stores secret values but only returns redacted summaries", () => {
    const store = new RoutineWorkflowSecretStore();
    const saved = store.upsert({ name: "CRM hook", value: "top-secret" });

    expect(saved).toMatchObject({ name: "CRM hook", configured: true });
    expect(saved).not.toHaveProperty("value");
    expect(store.list()[0]).not.toHaveProperty("value");
    expect(store.resolve(saved.id)).toBe("top-secret");
  });

  it("updates a referenced secret and removes it", () => {
    const store = new RoutineWorkflowSecretStore();
    const saved = store.upsert({ name: "Hook", value: "one" });
    const updated = store.upsert({ id: saved.id, name: "Hook v2", value: "two" });

    expect(updated.id).toBe(saved.id);
    expect(updated.createdAt).toBe(saved.createdAt);
    expect(store.resolve(saved.id)).toBe("two");
    expect(store.remove(saved.id)).toBe(true);
    expect(() => store.resolve(saved.id)).toThrow(/not found/);
  });
});
