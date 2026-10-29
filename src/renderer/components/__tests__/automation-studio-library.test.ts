import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { libraryRunStateLabel } from "../AutomationStudioPanel";

const styles = readFileSync(
  fileURLToPath(new URL("../automation-studio.css", import.meta.url)),
  "utf8",
);
const studioSource = readFileSync(
  fileURLToPath(new URL("../AutomationStudioPanel.tsx", import.meta.url)),
  "utf8",
);

describe("Automation Library", () => {
  it("labels a row's latest run in sentence case", () => {
    expect(libraryRunStateLabel(undefined)).toBe("No recent run");
    expect(libraryRunStateLabel("")).toBe("No recent run");
    expect(libraryRunStateLabel("completed")).toBe("Completed");
    expect(libraryRunStateLabel("waiting_for_approval")).toBe("Waiting for approval");
    // CSS no longer capitalizes every word ("No Recent Run").
    expect(styles).not.toMatch(/\.studio-run-state\s*\{[^}]*text-transform:\s*capitalize/s);
  });

  it("pluralizes the summary counts", () => {
    expect(studioSource).toContain('pluralize(libraryItems.length, "automation")');
    expect(studioSource).toContain("<span>with triggers on</span>");
    expect(studioSource).not.toContain("<span>automations</span>");
    expect(studioSource).not.toContain("<span>triggers on</span>");
  });

  it("styles the search as a field with the scope hint under it", () => {
    expect(studioSource).toContain('className="studio-library-search-field"');
    expect(studioSource).toContain('aria-describedby="studio-library-search-hint"');
    expect(styles).toMatch(/\.studio-library-search\s*\{[^}]*display:\s*grid/s);
    expect(styles).toMatch(
      /\.studio-library-search-field\s*\{[^}]*border:\s*1px solid var\(--studio-line\);[^}]*background:\s*var\(--color-bg-input\)/s,
    );
    expect(styles).toMatch(
      /\.studio-library-search > span\s*\{[^}]*color:\s*var\(--color-text-muted\)/s,
    );
  });

  it("never lets the list force the page wider than the main column", () => {
    expect(styles).toMatch(
      /\.studio-flow-row\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) 90px 130px 90px;/s,
    );
    expect(styles).toMatch(/\.studio-flow-list\s*\{[^}]*min-width:\s*0;/s);
    expect(styles).toMatch(/\.studio-library-layout\s*\{[^}]*flex-wrap:\s*wrap;/s);
    // A narrow main column (small window, sidebar open) drops the kind and time columns.
    expect(styles).toMatch(
      /@container \(max-width: 760px\)\s*\{\s*\.studio-flow-row\s*\{\s*grid-template-columns:\s*auto minmax\(0, 1fr\) auto;/s,
    );
  });
});
