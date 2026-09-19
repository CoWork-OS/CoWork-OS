import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { postJson } = require("../scripts/qa/run_eval_suite.cjs");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("never posts an approval after the case deadline", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const result = await postJson("/hooks/approval/respond", { approved: true }, Date.now() - 1);
  expect(result.status).toBe(408);
  expect(fetch).not.toHaveBeenCalled();
});

it("bounds an in-flight request by the remaining case budget", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    ),
  );
  const request = postJson("/hooks/agent", {}, Date.now() + 20);
  await vi.advanceTimersByTimeAsync(20);
  expect((await request).status).toBe(408);
  expect(vi.getTimerCount()).toBe(0);
});
