import { describe, it, expect, vi } from "vitest";
import { BotWorkResultLoader } from "../bot-work-result-loader";
import type { BotWorkResult } from "../../../shared/bot-work-result";
const request = { workspaceId: "ws", agentRoleId: "bot", taskId: "task" };
const result = {
  request,
  title: "Report",
  status: "completed",
  checkedAt: 1,
  recordedVerification: "passed",
  delivery: "unknown",
  contract: null,
  outputs: [],
  evidence: [],
  truncated: false,
  issues: [],
} as BotWorkResult;
describe("result evidence loader", () => {
  it("does not disclose foreign task, bot or workspace replies", async () => {
    for (const key of ["taskId", "agentRoleId", "workspaceId"] as const) {
      const loader = new BotWorkResultLoader(
        async () => ({ ...result, request: { ...request, [key]: "other" } }),
        request,
      );
      await loader.load();
      expect(loader.getSnapshot()).toMatchObject({
        result: null,
        loading: false,
        error: expect.stringContaining("another"),
      });
    }
  });
  it("clears stale proof during refresh and ignores older replies", async () => {
    let resolve!: (value: BotWorkResult) => void;
    const read = vi
      .fn()
      .mockResolvedValueOnce(result)
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      )
      .mockResolvedValueOnce({ ...result, checkedAt: 3 });
    const loader = new BotWorkResultLoader(read, request);
    await loader.load();
    const pending = loader.load();
    expect(loader.getSnapshot()).toMatchObject({ result: null, loading: true });
    await loader.load();
    resolve({ ...result, checkedAt: 2 });
    await pending;
    expect(loader.getSnapshot().result?.checkedAt).toBe(3);
  });
  it("ignores disposed replies and allows a fresh mounted read", async () => {
    let resolve!: (value: BotWorkResult) => void;
    const loader = new BotWorkResultLoader(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
      request,
    );
    const pending = loader.load();
    loader.dispose();
    loader.activate();
    resolve(result);
    await pending;
    expect(loader.getSnapshot().result).toBeNull();
  });
  it("keeps a mounted subscriber through evidence collapse and reopening", async () => {
    const loader = new BotWorkResultLoader(async () => result, request);
    const listener = vi.fn();
    const unsubscribe = loader.subscribe(listener);
    loader.dispose();
    loader.activate();
    await loader.load();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(loader.getSnapshot().result).toBe(result);
    unsubscribe();
  });
  it("clears proof after a failed refresh", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(result)
      .mockRejectedValueOnce(new Error("Unavailable"));
    const loader = new BotWorkResultLoader(read, request);
    await loader.load();
    await loader.load();
    expect(loader.getSnapshot()).toEqual({ result: null, loading: false, error: "Unavailable" });
  });
});
