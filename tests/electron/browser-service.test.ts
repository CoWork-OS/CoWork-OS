import { describe, expect, it } from "vitest";
import { _testUtils } from "../../src/electron/agent/browser/browser-service";

describe("BrowserService evaluate script normalization", () => {
  it("wraps top-level return statements", () => {
    const normalized = _testUtils.normalizeEvaluateScript(`
const buttons = document.querySelectorAll('button');
return buttons.length;
`);
    expect(normalized).toContain("(() => {");
    expect(normalized).toContain("return buttons.length;");
    expect(normalized.endsWith("})()")).toBe(true);
  });

  it("wraps await+return scripts in async iife", () => {
    const normalized = _testUtils.normalizeEvaluateScript(`
await new Promise(resolve => setTimeout(resolve, 10));
return 42;
`);
    expect(normalized).toContain("(async () => {");
    expect(normalized).toContain("await new Promise");
    expect(normalized.endsWith("})()")).toBe(true);
  });

  it("keeps expression scripts unchanged (except trim)", () => {
    const normalized = _testUtils.normalizeEvaluateScript("   document.title   ");
    expect(normalized).toBe("document.title");
  });
});
