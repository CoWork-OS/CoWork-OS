import { describe, expect, it } from "vitest";
import {
  DICTATION_ACTION_PREFIX,
  buildDictationOverlayHtml,
  parseDictationAction,
} from "../dictation-overlay-html";

describe("dictation overlay page", () => {
  it("allows inline code only and blocks every network and frame sink", () => {
    const html = buildDictationOverlayHtml();
    const csp = /Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("img-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain("window.__dictation");
  });

  it("reads only its own two button actions from console messages", () => {
    expect(parseDictationAction(`${DICTATION_ACTION_PREFIX}finish`)).toBe("finish");
    expect(parseDictationAction(`${DICTATION_ACTION_PREFIX}cancel`)).toBe("cancel");
    expect(parseDictationAction(`${DICTATION_ACTION_PREFIX}paste`)).toBeNull();
    expect(parseDictationAction("finish")).toBeNull();
  });
});
