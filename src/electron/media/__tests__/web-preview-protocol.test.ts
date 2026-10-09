import { describe, expect, it, vi } from "vitest";
import {
  WEB_PREVIEW_CSP,
  createWebPreviewUrl,
  resolveWebPreviewRequest,
} from "../web-preview-protocol";

describe("web preview protocol", () => {
  it("serves registered HTML with the preview CSP", async () => {
    const url = createWebPreviewUrl("<p>hi</p><script>1</script>");
    expect(url).toMatch(/^cowork-preview:\/\/local\/[0-9a-f-]{36}$/);

    const response = resolveWebPreviewRequest(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Content-Security-Policy")).toBe(WEB_PREVIEW_CSP);
    expect(await response.text()).toBe("<p>hi</p><script>1</script>");
  });

  it("lets inline scripts run but blocks network, framing and form posts", () => {
    expect(WEB_PREVIEW_CSP).toContain("default-src 'none'");
    expect(WEB_PREVIEW_CSP).toContain("script-src 'unsafe-inline' blob:");
    expect(WEB_PREVIEW_CSP).not.toContain("unsafe-eval");
    expect(WEB_PREVIEW_CSP).toContain("connect-src 'none'");
    expect(WEB_PREVIEW_CSP).toContain("frame-src 'none'");
    expect(WEB_PREVIEW_CSP).toContain("form-action 'none'");
    expect(WEB_PREVIEW_CSP).not.toMatch(/https?:/);
  });

  it("denies device, payment and clipboard access and sends no referrer", () => {
    const response = resolveWebPreviewRequest(createWebPreviewUrl("<p>policy</p>"));
    expect(response.headers.get("Permissions-Policy")).toContain("camera=()");
    expect(response.headers.get("Permissions-Policy")).toContain("clipboard-write=()");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("X-DNS-Prefetch-Control")).toBe("off");
  });

  it("rejects unknown tokens and malformed URLs", () => {
    expect(resolveWebPreviewRequest("cowork-preview://local/not-a-token").status).toBe(404);
    expect(resolveWebPreviewRequest("cowork-preview://local/").status).toBe(404);
    expect(resolveWebPreviewRequest("not a url").status).toBe(400);
  });

  it("keeps the store bounded", () => {
    const first = createWebPreviewUrl("first");
    for (let i = 0; i < 80; i += 1) createWebPreviewUrl(`page ${i}`);
    expect(resolveWebPreviewRequest(first).status).toBe(404);
  });
});

describe("web preview token reuse", () => {
  it("renews registration after expiration or eviction", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const html = "<main>renewed preview</main>";
      const original = createWebPreviewUrl(html);
      clock.mockReturnValue(1_000_000 + 60 * 60 * 1000 + 1);
      expect(resolveWebPreviewRequest(original).status).toBe(404);
      const renewed = createWebPreviewUrl(html);
      expect(resolveWebPreviewRequest(renewed).status).toBe(200);
      for (let i = 0; i < 64; i++) createWebPreviewUrl(`eviction-${i}`);
      expect(resolveWebPreviewRequest(renewed).status).toBe(404);
      expect(resolveWebPreviewRequest(createWebPreviewUrl(html)).status).toBe(200);
    } finally {
      clock.mockRestore();
    }
  });
  it("evicts the least recently reopened preview first", () => {
    const kept = createWebPreviewUrl("<p>still on screen</p>");
    for (let i = 0; i < 40; i++) createWebPreviewUrl(`lru-a-${i}`);
    expect(createWebPreviewUrl("<p>still on screen</p>")).toBe(kept);
    for (let i = 0; i < 40; i++) createWebPreviewUrl(`lru-b-${i}`);
    expect(resolveWebPreviewRequest(kept).status).toBe(200);
  });
  it("returns the same URL for the same content", () => {
    const html = `<p>${Math.random()}</p>`;
    expect(createWebPreviewUrl(html)).toBe(createWebPreviewUrl(html));
    expect(createWebPreviewUrl(`${html} `)).not.toBe(createWebPreviewUrl(html));
  });
});
