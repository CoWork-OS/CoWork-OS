import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourcePath = fileURLToPath(new URL("../CompaniesPanel.tsx", import.meta.url));

describe("CompaniesPanel theme styles", () => {
  it("uses app theme tokens for panel surfaces", () => {
    const source = readFileSync(sourcePath, "utf8");

    expect(source).toContain("--co-v2-card-bg: var(--color-bg-glass)");
    expect(source).toContain("--co-v2-card-bg-strong: var(--color-bg-secondary)");
    expect(source).toContain("--co-v2-input-bg: var(--color-bg-input)");
    expect(source).toContain(".companies-v2.settings-page");
    expect(source).toContain("background: transparent");
    expect(source).toContain("padding-top: 0");
    expect(source).toContain(".companies-v2 .provider-save-button");
    expect(source).toContain("gap: 8px");
    expect(source).toContain(".theme-light .companies-v2");
    expect(source).toContain("--co-v2-card-bg: var(--color-bg-glass)");
    expect(source).toContain(".co-v2-sidebar > .co-v2-card:first-child");
    expect(source).toContain("grid-template-columns: minmax(0, 1fr) auto");
    expect(source).toContain("grid-template-columns: repeat(4, minmax(0, 1fr))");
    expect(source).not.toMatch(/background:\s*rgba\(255,\s*255,\s*255,\s*0\.[0-9]+\)/);
    expect(source).not.toContain("background: linear-gradient(180deg, rgba(248, 250, 252");
    expect(source).not.toContain("border-color: #2563eb");
  });
});
