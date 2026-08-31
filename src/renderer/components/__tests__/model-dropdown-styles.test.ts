import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesPath = fileURLToPath(new URL("../MainContent/main-content.css", import.meta.url));

describe("Model dropdown styles", () => {
  it("gives model browsing enough width for model metadata and controls", () => {
    const source = readFileSync(stylesPath, "utf8");

    expect(source).toMatch(
      /\.model-dropdown\s*\{[^}]*width:\s*min\(560px,\s*calc\(100vw\s*-\s*24px\)\);/s,
    );
    expect(source).toMatch(
      /\.model-dropdown-content\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1\.25fr\)\s+minmax\(185px,\s*0\.75fr\);/s,
    );
  });

  it("collapses the picker into a mobile-friendly stacked layout", () => {
    const source = readFileSync(stylesPath, "utf8");

    expect(source).toMatch(
      /@media\s*\(max-width:\s*520px\)[\s\S]*?\.model-dropdown-content\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s,
    );
    expect(source).toMatch(
      /@media\s*\(max-width:\s*520px\)[\s\S]*?\.model-dropdown-sidebar\s*\{[^}]*overflow-x:\s*auto;/s,
    );
  });
});
