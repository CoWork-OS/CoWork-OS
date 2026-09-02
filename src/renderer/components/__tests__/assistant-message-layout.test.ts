import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesPath = fileURLToPath(new URL("../MainContent/main-content.css", import.meta.url));
const styles = readFileSync(stylesPath, "utf8");

describe("Assistant message layout", () => {
  it("does not clip the first glyph of borderless assistant prose", () => {
    const assistantBubbleRules = [
      ...styles.matchAll(/\.chat-bubble\.assistant-bubble\s*\{([\s\S]*?)\}/g),
    ];
    const finalAssistantBubbleRule = assistantBubbleRules.at(-1)?.[1] ?? "";

    expect(finalAssistantBubbleRule).toMatch(/border-radius:\s*0;/);
    expect(finalAssistantBubbleRule).toMatch(/overflow:\s*visible;/);
  });
});
