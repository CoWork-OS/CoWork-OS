import { afterEach, describe, expect, it, vi } from "vitest";
import { readAttempt, writeAttempt } from "./TaskGovernance";

afterEach(() => vi.unstubAllGlobals());

describe("browser decision recovery", () => {
  it("persists only non-secret receipt metadata for an unresolved input response", () => {
    const items = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => items.set(key, value),
        removeItem: (key: string) => items.delete(key),
      },
    });
    writeAttempt("pending", {
      id: "request-1",
      key: "operation-key-1",
      kind: "input_request",
      expectedVersion: 123,
      decision: "submitted",
      answers: { account: { otherText: "private answer" } },
    });
    expect(items.get("pending")).not.toContain("private answer");
    expect(readAttempt("pending")).toEqual({
      id: "request-1",
      key: "operation-key-1",
      kind: "input_request",
      expectedVersion: 123,
      decision: "submitted",
    });
    writeAttempt("pending", null);
    expect(items.has("pending")).toBe(false);
  });
});
