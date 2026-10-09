import { describe, expect, it, vi } from "vitest";
import { prepareHtmlSurfaceDocument, registerHtmlSurface } from "../html-surface-document";

describe("prepareHtmlSurfaceDocument", () => {
  it("puts the bridge before the page's own scripts", () => {
    const html =
      '<!doctype html><html><head><script>window.cowork = "spoofed";</script></head><body><p>Hi</p></body></html>';
    const doc = prepareHtmlSurfaceDocument({ html, theme: "light", designLanguage: false });
    const bridge = doc.indexOf('id="cowork-surface-bridge"');
    expect(bridge).toBeGreaterThan(-1);
    expect(bridge).toBeLessThan(doc.indexOf("spoofed"));
    expect(doc).toContain("cowork-autosize");
    expect(doc).not.toContain('id="cowork-surface-kit"');
    expect(doc).not.toContain('id="cowork-rich-frame-design-language"');
  });

  it("adds the design language for frames and handles fragments", () => {
    const doc = prepareHtmlSurfaceDocument({
      html: '<div class="rf-card">Total</div>',
      theme: "dark",
      designLanguage: true,
    });
    expect(doc.startsWith('<style id="cowork-surface-autosize">')).toBe(true);
    expect(doc).toContain('id="cowork-rich-frame-design-language"');
    // The kit runs before the bridge so the bridge can expose its helpers.
    expect(doc.indexOf('id="cowork-surface-kit"')).toBeLessThan(
      doc.indexOf('id="cowork-surface-bridge"'),
    );
    expect(doc).toContain("color-scheme: dark");
  });
});

describe("hardening", () => {
  it("strips resource hints that the CSP does not cover", () => {
    const doc = prepareHtmlSurfaceDocument({
      html: '<html><head><link rel="dns-prefetch" href="//leak.example"><link rel=preconnect href="https://x.example"><link rel="stylesheet" href="a.css"></head></html>',
      theme: "light",
      designLanguage: false,
    });
    expect(doc).not.toContain("leak.example");
    expect(doc).not.toContain("x.example");
    expect(doc).toContain('rel="stylesheet"');
  });

  it.each([
    ["unclosed head openings", "<head ".repeat(166_000)],
    ["unclosed link openings", "<link ".repeat(166_000)],
    ["many short tags", "<link rel=preconnect>".repeat(47_000)],
    ["tags closing far away", `${"<html <head <link ".repeat(50_000)}>`],
  ])("handles a megabyte of %s in linear time", (_label, html) => {
    const started = performance.now();
    prepareHtmlSurfaceDocument({ html, theme: "dark", designLanguage: true });
    // Linear work on 1 MB takes milliseconds; the old regexes took seconds on CI.
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("registerHtmlSurface", () => {
  it("serves the prepared document and rejects bad requests", () => {
    const createPreviewUrl = vi.fn(() => "cowork-preview://local/token");
    expect(
      registerHtmlSurface(
        { html: "<p>Hi</p>", theme: "light", designLanguage: false },
        createPreviewUrl,
      ),
    ).toEqual({ url: "cowork-preview://local/token" });
    expect(createPreviewUrl.mock.calls[0][0]).toContain("cowork-surface-bridge");
    for (const bad of [
      { html: "", theme: "light", designLanguage: false },
      { html: "<p>Hi</p>", theme: "sepia", designLanguage: false },
      { html: "<p>Hi</p>", theme: "light", designLanguage: false, url: "https://x" },
      { html: "x".repeat(1_000_001), theme: "light", designLanguage: false },
    ]) {
      expect(() => registerHtmlSurface(bad, createPreviewUrl)).toThrow(/Invalid HTML surface/);
    }
  });
});
