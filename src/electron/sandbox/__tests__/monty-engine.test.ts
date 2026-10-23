import { afterAll, describe, expect, it } from "vitest";
import { closeMontyPool, createMontySafeStdlib, runMontyCode } from "../monty-engine";

const stdlib = createMontySafeStdlib() as unknown as Record<
  string,
  (...args: unknown[]) => unknown
>;

describe("runMontyCode", () => {
  afterAll(async () => {
    await closeMontyPool();
  });

  it("returns the trailing expression with input bound", async () => {
    const res = await runMontyCode({ code: 'input["n"] * 2', input: { n: 21 } });
    expect(res).toEqual({ ok: true, output: 42 });
  });

  it("converts dicts and lists to plain JS values", async () => {
    const res = await runMontyCode({ code: '{"a": [1, 2], "b": {"c": None}}' });
    expect(res).toEqual({ ok: true, output: { a: [1, 2], b: { c: null } } });
  });

  it("calls the safe stdlib with keyword arguments as a trailing options record", async () => {
    const res = await runMontyCode({
      code: 'json_stringify({"b": 1, "a": 2}, sort_keys=True)',
      externalFunctions: stdlib,
    });
    expect(res).toEqual({ ok: true, output: '{"a":2,"b":1}' });
  });

  it("reports syntax errors", async () => {
    const res = await runMontyCode({ code: "def (" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("syntax");
  });

  it("reports runtime errors with a traceback", async () => {
    const res = await runMontyCode({ code: "1 / 0" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.kind).toBe("runtime");
      expect(res.error.message).toContain("division");
      expect(Array.isArray(res.error.traceback)).toBe(true);
    }
  });

  it("stops code that runs past maxDurationSecs", async () => {
    const started = Date.now();
    const res = await runMontyCode({
      code: "while True:\n    pass",
      limits: { maxDurationSecs: 0.2 },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("runtime");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("does not let sleeps escape the duration budget", async () => {
    const started = Date.now();
    await runMontyCode({
      code: "import time\nfor _ in range(50):\n    time.sleep(10)\n1",
      limits: { maxDurationSecs: 0.5 },
    });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("stops code that exceeds maxMemory", async () => {
    const res = await runMontyCode({
      code: 'x = "a" * (64 * 1024 * 1024)\nlen(x)',
      limits: { maxMemory: 8 * 1024 * 1024 },
    });
    expect(res.ok).toBe(false);
  });

  it("gives each run a fresh session", async () => {
    await runMontyCode({ code: "leaked = 1\nleaked" });
    const res = await runMontyCode({ code: "leaked" });
    expect(res.ok).toBe(false);
  });

  it("runs concurrent calls", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => runMontyCode({ code: "input + 1", input: i })),
    );
    expect(results.map((r) => (r.ok ? r.output : null))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("fails closed with a load error after shutdown", async () => {
    await closeMontyPool();
    const res = await runMontyCode({ code: "1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("load");
  });
});
