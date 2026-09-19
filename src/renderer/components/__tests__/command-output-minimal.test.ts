import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const componentPath = fileURLToPath(new URL("../CommandOutput.tsx", import.meta.url));
const stylesPath = fileURLToPath(new URL("../../styles/index.css", import.meta.url));

describe("CommandOutput minimal variant", () => {
  const source = readFileSync(componentPath, "utf8");

  it("defaults to the classic terminal window", () => {
    expect(source).toContain('variant = "terminal"');
    expect(source).toContain('const isMinimal = variant === "minimal"');
  });

  it("drops terminal chrome and collapses output in the minimal variant", () => {
    const minimalBranch = source.slice(
      source.indexOf("if (isMinimal)"),
      source.indexOf('return (\n    <div className="command-output-container">'),
    );

    expect(minimalBranch).toContain("command-output-minimal");
    expect(minimalBranch).not.toContain("command-window-dot");
    expect(minimalBranch).not.toContain("command-prompt-glyph");
    // Output stays collapsed to a short tail until expanded.
    expect(minimalBranch).toContain("minimalExpanded");
    expect(minimalBranch).toContain("minimal.hiddenCount");
  });

  it("keeps stop and stdin controls available while a command runs", () => {
    const minimalBranch = source.slice(
      source.indexOf("if (isMinimal)"),
      source.indexOf('return (\n    <div className="command-output-container">'),
    );

    expect(minimalBranch).toContain("killCommand");
    expect(minimalBranch).toContain("forceKillCommand");
    expect(minimalBranch).toContain("command-minimal-stdin-input");
  });

  it("styles the minimal variant without a terminal surface", () => {
    const styles = readFileSync(stylesPath, "utf8");
    const block = styles.slice(styles.indexOf(".command-output-minimal {"));

    expect(block).toContain("background: transparent;");
    expect(block).toContain(".command-minimal-more");
    expect(block).toContain(".command-minimal-scroll.expanded");
  });
});
