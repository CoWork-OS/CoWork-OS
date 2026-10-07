import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const componentPath = fileURLToPath(new URL("../BotFormDialog.tsx", import.meta.url));
const stylesPath = fileURLToPath(new URL("../bot-form.css", import.meta.url));

describe("Bot create and edit dialog layout", () => {
  it("keeps the action bar outside the scrollable form content", () => {
    const source = readFileSync(componentPath, "utf8");
    const contentStart = source.indexOf('className="bot-form-content"');
    const footerStart = source.indexOf('<footer className="bot-form-actions">');

    expect(contentStart).toBeGreaterThan(-1);
    expect(footerStart).toBeGreaterThan(contentStart);
  });

  it("constrains the dialog and gives only the form content vertical scrolling", () => {
    const styles = readFileSync(stylesPath, "utf8");

    expect(styles).toContain("max-height: min(760px, calc(100dvh - 40px));");
    expect(styles).toContain(".bot-form-content {");
    expect(styles).toContain("overflow-y: auto;");
    expect(styles).toContain(".bot-form-actions {");
    expect(styles).toContain("flex: 0 0 auto;");
  });
});
