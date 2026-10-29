import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const styles = readFileSync(
  fileURLToPath(new URL("../automation-studio.css", import.meta.url)),
  "utf8",
);

describe("Automation Studio layout", () => {
  it("owns vertical scrolling inside the main app shell", () => {
    expect(styles).toMatch(
      /\.app-layout\s*>\s*main\.main-content\.automation-studio-main\s*\{[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;/s,
    );
  });

  it("uses one consistent full-width grid for every template row", () => {
    expect(styles).toMatch(
      /\.studio-template-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/s,
    );
    expect(styles).toMatch(/\.studio-template\s*\{[^}]*width:\s*100%;/s);
    expect(styles).not.toContain(".studio-template:nth-child(odd)");
  });

  it("drops the Builder to two columns by content width, not window width", () => {
    // The window is never narrower than 1200px, so a viewport breakpoint never
    // fired while the three columns overflowed the card next to the sidebar.
    expect(styles).toMatch(
      /@container \(max-width: 1080px\) \{\s*\.studio-builder-shell \{\s*grid-template-columns: 210px minmax\(380px, 1fr\);/,
    );
    expect(styles).not.toMatch(/@media \(max-width: 1180px\)/);
  });

  it("keeps Builder action rows full width and left-aligned", () => {
    expect(styles).toMatch(
      /\.studio-catalog-scroll section > button \{[^}]*justify-content:\s*stretch;[^}]*justify-items:\s*start;/s,
    );
  });
});
