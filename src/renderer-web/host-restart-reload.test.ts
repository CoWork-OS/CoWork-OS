import { describe, expect, it } from "vitest";
import { allowHostRestartReload } from "./host-restart-reload";

function memoryStorage(initial?: string) {
  let value: string | null = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
    read: () => value,
  };
}

describe("reload after a host restart", () => {
  it("allows three reloads a minute, then leaves it to the user", () => {
    const storage = memoryStorage();
    const start = 1_000_000;
    expect(allowHostRestartReload(storage, start)).toBe(true);
    expect(allowHostRestartReload(storage, start + 5_000)).toBe(true);
    expect(allowHostRestartReload(storage, start + 10_000)).toBe(true);
    expect(allowHostRestartReload(storage, start + 15_000)).toBe(false);
    // A refusal is not counted, so the window still ends a minute after the first reload.
    expect(allowHostRestartReload(storage, start + 59_000)).toBe(false);
    expect(allowHostRestartReload(storage, start + 61_000)).toBe(true);
  });

  it("does not reload when the reloads cannot be counted", () => {
    expect(allowHostRestartReload(null)).toBe(false);
    expect(allowHostRestartReload(undefined)).toBe(false);
    const broken = {
      getItem: (): string | null => {
        throw new Error("SecurityError");
      },
      setItem: () => undefined,
    };
    expect(allowHostRestartReload(broken)).toBe(false);
    const readOnly = {
      getItem: (): string | null => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(allowHostRestartReload(readOnly)).toBe(false);
  });

  it("ignores stored values it did not write", () => {
    const now = 2_000_000;
    expect(allowHostRestartReload(memoryStorage("not json"), now)).toBe(false);
    expect(allowHostRestartReload(memoryStorage('{"a":1}'), now)).toBe(true);
    // Times from the future (a clock set back) and non-numbers do not count.
    const odd = memoryStorage(JSON.stringify([now + 9_000, "x", null, now - 1_000]));
    expect(allowHostRestartReload(odd, now)).toBe(true);
    expect(JSON.parse(odd.read() ?? "[]")).toEqual([now - 1_000, now]);
  });
});
