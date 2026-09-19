import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  shell: { openExternal: vi.fn().mockResolvedValue(undefined) },
}));

const { isSafeExternalUrl } = await import("../safe-external-url");

describe("isSafeExternalUrl", () => {
  it("allows browser and mail schemes", () => {
    expect(isSafeExternalUrl("https://example.com")).toBe(true);
    expect(isSafeExternalUrl("http://example.com")).toBe(true);
    expect(isSafeExternalUrl("mailto:someone@example.com")).toBe(true);
  });

  it("refuses schemes that invoke a local handler", () => {
    // Reachable from unsanitized .docx hyperlink targets: mammoth does no href
    // scheme validation, so these would otherwise be one-click launches.
    for (const url of [
      "file:///Applications/Calculator.app",
      "smb://attacker.example/share/payload.exe",
      "javascript:alert(1)",
      "cowork://task/whatever",
      "vscode://file/etc/passwd",
      "ms-msdt:/id",
      "data:text/html,<script>alert(1)</script>",
    ]) {
      expect(isSafeExternalUrl(url), url).toBe(false);
    }
  });

  it("refuses values that are not URLs", () => {
    expect(isSafeExternalUrl("not a url")).toBe(false);
    expect(isSafeExternalUrl("")).toBe(false);
  });
});
