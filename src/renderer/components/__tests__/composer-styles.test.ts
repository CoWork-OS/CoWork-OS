import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesPath = fileURLToPath(new URL("../../styles/index.css", import.meta.url));
const mainContentStylesPath = fileURLToPath(
  new URL("../MainContent/main-content.css", import.meta.url),
);

describe("Composer styles", () => {
  it("does not reserve input-row space for an empty workspace dropdown anchor", () => {
    const source = readFileSync(stylesPath, "utf8");

    expect(source).toMatch(
      /\.input-row\s*>\s*\.workspace-dropdown-container:empty\s*\{[^}]*display:\s*none;/s,
    );
  });

  it("keeps the focused attachment button close to the prompt placeholder", () => {
    const source = readFileSync(stylesPath, "utf8");

    expect(source).toMatch(
      /\.density-focused\s+\.input-row\s*>\s*\.attachment-btn-left\s*\{[^}]*margin-right:\s*-2px;/s,
    );
  });

  it("keeps focused composer action buttons compact", () => {
    const source = readFileSync(stylesPath, "utf8");

    expect(source).toMatch(/\.density-focused\s+\.input-actions\s*\{[^}]*gap:\s*6px;/s);
  });

  it("removes animated caret surfaces after pasted editor content appears", () => {
    const source = readFileSync(stylesPath, "utf8");

    expect(source).toMatch(
      /\.mention-autocomplete-wrapper:has\(\.prompt-composer-input:not\(:empty\)\)\s*>\s*\.cli-rotating-placeholder,\s*\.mention-autocomplete-wrapper:has\(\.prompt-composer-input:not\(:empty\)\)\s*~\s*\.cli-cursor\s*\{[^}]*display:\s*none;[^}]*animation:\s*none;/s,
    );
  });

  it("anchors both composer variants to the bottom when the prompt wraps", () => {
    const source = readFileSync(mainContentStylesPath, "utf8");

    expect(source).toMatch(/\.main-footer\s*\{[^}]*flex:\s*0\s+0\s+auto;/s);
    expect(source).toMatch(/\.input-row\s*\{[^}]*align-items:\s*flex-end;/s);
    expect(source).toMatch(/\.cli-input-wrapper\s*\{[^}]*align-items:\s*flex-end;/s);
    expect(source).toMatch(
      /\.input-row\s*>\s*\.mention-autocomplete-wrapper,\s*\.cli-input-wrapper\s*>\s*\.mention-autocomplete-wrapper\s*\{[^}]*align-self:\s*stretch;[^}]*align-items:\s*flex-end;/s,
    );
    expect(source).toMatch(
      /\.input-row\s+\.prompt-composer-input,\s*\.cli-input-wrapper\s+\.prompt-composer-input\s*\{[^}]*overflow-y:\s*auto;/s,
    );
  });
});
