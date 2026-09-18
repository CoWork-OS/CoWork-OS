import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourcePath = fileURLToPath(new URL("../DigitalTwinsPanel.tsx", import.meta.url));

describe("DigitalTwinsPanel persona gallery", () => {
  it("opens the company gallery on all templates so management operators remain visible", () => {
    const source = readFileSync(sourcePath, "utf8");

    expect(source).toContain('initialCategory="all"');
    expect(source).not.toContain('initialCategory={selectedCompany ? "operations" : "all"}');
  });
});
