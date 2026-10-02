import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesPath = fileURLToPath(new URL("../MainContent/main-content.css", import.meta.url));
const pickerStylesPath = fileURLToPath(
  new URL("../MainContent/model-source-picker.css", import.meta.url),
);

describe("Model dropdown styles", () => {
  it("provides a compact quick-controls surface alongside the advanced picker", () => {
    const source = readFileSync(stylesPath, "utf8");

    expect(source).toMatch(
      /\.model-dropdown-quick\s*\{[^}]*width:\s*min\(360px,\s*calc\(100vw\s*-\s*24px\)\);/s,
    );
    expect(source).toMatch(
      /\.model-quick-effort-range\s*\{[^}]*appearance:\s*none;[^}]*cursor:\s*pointer;/s,
    );
    expect(source).toMatch(
      /\.model-quick-panel\s*\{[^}]*border-radius:\s*18px;[^}]*animation:\s*quickPickerReveal/s,
    );
    expect(source).toMatch(/@keyframes\s+quickPickerSheen/);
    expect(source).toMatch(
      /\.model-quick-custom\s*\{[^}]*border-top:\s*1px\s+solid\s+var\(--color-border-subtle\);/s,
    );
  });

  it("styles the full picker as one column with source chips and a reasoning row", () => {
    const source = readFileSync(pickerStylesPath, "utf8");

    expect(source).toMatch(
      /\.model-dropdown\.model-dropdown-advanced\s*\{[^}]*width:\s*min\(420px,\s*calc\(100vw\s*-\s*24px\)\);/s,
    );
    expect(source).toMatch(/\.msp-sources\s*\{[^}]*overflow-x:\s*auto;/s);
    expect(source).toMatch(/\.msp-list\s*\{[^}]*overflow-y:\s*auto;/s);
    // Only the model list may shrink; the header, sources, search and footer keep their size.
    expect(source).toMatch(
      /\.msp-header,\s*\.msp-sources,\s*\.msp-search,\s*\.msp-footer\s*\{[^}]*flex-shrink:\s*0;/s,
    );
    expect(source).toMatch(/\.msp-reasoning-option\s*\{[^}]*flex:\s*1 1 0;/s);
  });
});
