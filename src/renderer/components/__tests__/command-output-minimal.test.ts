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

  it("renders a shell card with the command pinned above scrolling output", () => {
    const minimalBranch = source.slice(
      source.indexOf("if (isMinimal)"),
      source.indexOf('return (\n    <div className="command-output-container">'),
    );

    expect(minimalBranch).toContain("command-output-minimal command-shell");
    expect(minimalBranch).not.toContain("command-window-dot");
    expect(minimalBranch).not.toContain("command-prompt-glyph");
    // The command sits outside the scroller, so only the output scrolls.
    const commandAt = minimalBranch.indexOf('className="command-shell-command"');
    const scrollAt = minimalBranch.indexOf("command-shell-scroll");
    expect(commandAt).toBeGreaterThan(-1);
    expect(scrollAt).toBeGreaterThan(commandAt);
    expect(minimalBranch).toContain("ref={outputRef}");
  });

  it("labels the card with the command it ran and folds it from that label", () => {
    const minimalBranch = source.slice(
      source.indexOf("if (isMinimal)"),
      source.indexOf('return (\n    <div className="command-output-container">'),
    );

    const summaryAt = minimalBranch.indexOf('className="command-shell-summary"');
    expect(summaryAt).toBeGreaterThan(-1);
    expect(summaryAt).toBeLessThan(minimalBranch.indexOf('className="command-shell-card"'));
    expect(minimalBranch).toContain('{isRunning ? "Running" : "Ran"}');
    expect(minimalBranch).toContain("aria-expanded={!shellCollapsed}");
    expect(source).toContain("useState(true);");
  });

  it("lets the command and the output be copied separately", () => {
    const minimalBranch = source.slice(
      source.indexOf("if (isMinimal)"),
      source.indexOf('return (\n    <div className="command-output-container">'),
    );

    expect(source).toContain("navigator.clipboard.writeText(text)");
    expect(minimalBranch).toContain('<CopyTextButton text={command} label="Copy command" />');
    expect(minimalBranch).toContain('<CopyTextButton text={shell.text} label="Copy output" />');
  });

  it("keeps stop and stdin controls available while a command runs", () => {
    const minimalBranch = source.slice(
      source.indexOf("if (isMinimal)"),
      source.indexOf('return (\n    <div className="command-output-container">'),
    );

    expect(minimalBranch).toContain("killCommand");
    expect(minimalBranch).toContain("forceKillCommand");
    expect(minimalBranch).toContain("command-shell-stdin-input");
  });

  it("caps the output body height and scrolls it", () => {
    const styles = readFileSync(stylesPath, "utf8");
    const block = styles.slice(styles.indexOf(".command-output-minimal {"));
    const scrollRule = block.slice(block.indexOf(".command-shell-scroll {"));

    expect(scrollRule).toMatch(/max-height: \d+px;/);
    expect(scrollRule).toContain("overflow: auto;");
    expect(block).toContain(".command-shell-copy::after");
  });
});
