import { describe, expect, it } from "vitest";
import {
  readWorkControlCache,
  writeWorkControlCache,
  workControlCacheKey,
} from "../bot-work-control-cache";
const scope = { workspaceId: "workspace", agentRoleId: "private" };
const request = { scope, requestId: "original", action: "stop_bot" as const };
function storage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}
describe("minimal scoped work-control recovery cache", () => {
  it("roundtrips only the original identity and exact stop versions", () => {
    const store = storage();
    writeWorkControlCache(request, [{ taskId: "task", stopVersion: 9 }], store);
    expect(readWorkControlCache(scope, store)).toEqual({
      version: 1,
      request,
      stopped: [{ taskId: "task", stopVersion: 9 }],
    });
    expect(Object.keys(JSON.parse(store.getItem(workControlCacheKey(scope))!)).sort()).toEqual([
      "request",
      "stopped",
      "version",
    ]);
  });
  it("does not accept another scope, malformed versions, extra data or oversized input", () => {
    const store = storage();
    const key = workControlCacheKey(scope);
    for (const raw of [
      "{broken",
      JSON.stringify({
        version: 1,
        request: { ...request, scope: { ...scope, workspaceId: "foreign" } },
        stopped: [],
      }),
      JSON.stringify({ version: 1, request, stopped: [{ taskId: "task", stopVersion: 0 }] }),
      JSON.stringify({ version: 1, request, stopped: [], receiptError: "private" }),
      "x".repeat(1024 * 1024 + 1),
    ]) {
      store.setItem(key, raw);
      expect(readWorkControlCache(scope, store)).toBeNull();
    }
  });
  it("surfaces quota/access failures to the caller before an action", () => {
    expect(() => writeWorkControlCache(request, [], null)).toThrow("unavailable");
    expect(() =>
      writeWorkControlCache(request, [], {
        getItem: () => null,
        setItem: () => {
          throw Error("Quota");
        },
      }),
    ).toThrow("Quota");
  });
});
