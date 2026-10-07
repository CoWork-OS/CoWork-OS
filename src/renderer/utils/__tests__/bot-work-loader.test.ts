import { describe, expect, it, vi } from "vitest";
import type { BotWorkPage, BotWorkQuery } from "../../../shared/types";
import { BotWorkLoader } from "../bot-work-loader";
const scope: BotWorkQuery = { workspaceId: "ws", agentRoleId: "user-bot", view: "working" };
function page(overrides: Partial<BotWorkPage> = {}): BotWorkPage {
  return {
    ...scope,
    items: [],
    counts: { needs_you: 0, working: 0, scheduled: 0, results: 0 },
    scheduleAvailability: "unavailable",
    scheduleRuntime: "unavailable",
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("bot work load lifecycle", () => {
  it("ignores old bot loads after disposal and overlapping refreshes", async () => {
    const first = deferred<BotWorkPage>();
    const second = deferred<BotWorkPage>();
    const query = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const publish = vi.fn();
    const loader = new BotWorkLoader(query, scope, publish);
    const a = loader.load();
    const b = loader.load();
    second.resolve(page());
    await b;
    const calls = publish.mock.calls.length;
    first.resolve(page({ counts: { needs_you: 0, working: 999, scheduled: 0, results: 0 } }));
    await a;
    expect(publish).toHaveBeenCalledTimes(calls);
    const old = deferred<BotWorkPage>();
    const oldPublish = vi.fn();
    const disposed = new BotWorkLoader(() => old.promise, scope, oldPublish);
    const pending = disposed.load();
    disposed.dispose();
    old.resolve(page());
    await pending;
    expect(oldPublish).toHaveBeenCalledTimes(1);
  });
  it("refuses foreign workspace or bot responses", async () => {
    const publish = vi.fn();
    const loader = new BotWorkLoader(async () => page({ agentRoleId: "other" }), scope, publish);
    await loader.load();
    expect(publish.mock.lastCall?.[0]).toMatchObject({
      page: null,
      loading: false,
      error: expect.stringContaining("another bot"),
    });
  });
  it("keeps the current page on pagination failure and retries the same cursor", async () => {
    const initial = page({ nextCursor: "cursor" });
    const query = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(page());
    const publish = vi.fn();
    const loader = new BotWorkLoader(query, scope, publish);
    await loader.load();
    await loader.load(true);
    expect(publish.mock.lastCall?.[0]).toMatchObject({ page: initial, error: "offline" });
    await loader.load(true);
    expect(query.mock.calls[2][0].cursor).toBe("cursor");
  });
});
