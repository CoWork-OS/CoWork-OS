import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const componentPath = fileURLToPath(new URL("../CustomizePanel.tsx", import.meta.url));

describe("CustomizePanel styling", () => {
  it("keeps Feature Packs aligned with the Devices panel visual language", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("animation: dp-fade-in 0.6s ease-out");
    expect(source).toContain("border-radius: var(--radius-xl)");
    expect(source).toContain("box-shadow: var(--shadow-lg), var(--shadow-glow)");
    expect(source).toContain("background: linear-gradient(135deg, var(--color-bg-glass) 0%, var(--color-accent-subtle) 100%)");
    expect(source).toContain("transform: translateX(4px)");
  });
});
