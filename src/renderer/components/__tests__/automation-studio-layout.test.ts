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
});
