import { describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../../../shared/types";
import { BrowserService, _testUtils } from "../browser-service";

function serviceFixture() {
  const workspace: Workspace = {
    id: "evaluate",
    name: "Evaluate",
    path: "/tmp",
    createdAt: 0,
    permissions: { read: true, write: false, delete: false, network: true, shell: false },
  };
  const evaluate = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(42);
  const service = new BrowserService(workspace);
  Object.assign(service, {
    page: { url: () => "https://example.com", isClosed: () => false, evaluate },
  });
  return { service, evaluate };
}

describe("browser script execution boundary", () => {
  it.each(["0);globalThis.injected=true;//", NaN, Infinity, -1, null])(
    "rejects malformed scroll amount %s before evaluating",
    async (amount) => {
      const { service, evaluate } = serviceFixture();
      await expect(service.scroll("down", amount as number)).rejects.toThrow(/amount/);
      expect(evaluate).not.toHaveBeenCalled();
    },
  );
  it("passes scroll data to a fixed evaluator, preserving zero and default amounts", async () => {
    const { service, evaluate } = serviceFixture();
    await expect(service.scroll("down", 0)).resolves.toEqual({ success: true });
    expect(evaluate.mock.calls[0][0]).toBeTypeOf("function");
    expect(evaluate.mock.calls[0][1]).toEqual({ direction: "down", amount: 0 });
    await service.scroll("up");
    expect(evaluate.mock.calls[1][1]).toEqual({ direction: "up", amount: 500 });
  });
  it.each(["  6 * 7  ", "return 6 * 7;", "return await Promise.resolve(42);"])(
    "passes normalized source to Playwright's page evaluator: %s",
    async (source) => {
      const { service, evaluate } = serviceFixture();
      expect(await service.evaluate(source)).toMatchObject({ success: true, result: 42 });
      expect(evaluate).toHaveBeenCalledExactlyOnceWith(_testUtils.normalizeEvaluateScript(source));
    },
  );
  it("preserves page-script failures as structured tool failures", async () => {
    const { service, evaluate } = serviceFixture();
    evaluate.mockRejectedValueOnce(new Error("Page script failed"));
    expect(await service.evaluate("throw new Error('Page script failed')")).toMatchObject({
      success: false,
      result: "Page script failed",
    });
  });
});
