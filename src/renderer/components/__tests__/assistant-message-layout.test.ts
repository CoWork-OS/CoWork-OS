import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesPath = fileURLToPath(new URL("../MainContent/main-content.css", import.meta.url));
const styles = readFileSync(stylesPath, "utf8");

describe("Assistant message layout", () => {
  it("does not clip the first glyph of the base assistant prose style", () => {
    const assistantBubbleRules = [
      ...styles.matchAll(/^\.chat-bubble\.assistant-bubble\s*\{([\s\S]*?)\}/gm),
    ];
    const assistantBubbleRule = assistantBubbleRules.at(-1)?.[1] ?? "";

    expect(assistantBubbleRule).toMatch(/border-radius:\s*0;/);
    expect(assistantBubbleRule).toMatch(/overflow:\s*visible;/);
  });

  it("gives bot-conversation replies a compact Grok-style bubble", () => {
    const botConversationRule =
      styles.match(
        /\.bot-conversation \.chat-message\.assistant-message \.chat-bubble\.assistant-bubble\s*\{([\s\S]*?)\}/,
      )?.[1] ?? "";

    expect(botConversationRule).toMatch(/border-radius:\s*18px 18px 18px 6px;/);
    expect(botConversationRule).toMatch(/background:\s*var\(--bot-assistant-bubble-bg\);/);
  });
});
