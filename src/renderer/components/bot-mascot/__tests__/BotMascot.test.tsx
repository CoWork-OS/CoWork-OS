import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BOT_MASCOT_IDS } from "../../../../shared/bot-mascots";
import { resolveTwinIcon, botIconLabel } from "../../../utils/twin-icons";
import { BotGlyph } from "../../BotGlyph";
import { BotMascot } from "../BotMascot";
import { BotIconPicker } from "../BotIconPicker";
import {
  mascotExpressionForBotConversation,
  mascotExpressionForConversation,
  mascotExpressionForTaskStatus,
} from "../mascot-expressions";

describe("BotMascot", () => {
  it("draws the body artwork with the eyes on top", () => {
    const markup = renderToStaticMarkup(
      React.createElement(BotMascot, { mascot: "code", size: 36 }),
    );
    expect(markup).toContain('href="./bot-mascots/code.webp"');
    expect(markup).toContain('viewBox="0 0 256 256"');
    expect(markup).toContain('data-expression="idle"');
    expect(markup).toContain("bot-mascot--animated");
    expect(markup.match(/class="bot-mascot__eye"/g)).toHaveLength(2);
    expect(markup).toContain('aria-hidden="true"');
  });

  it("draws both faces of a two-character mascot", () => {
    const markup = renderToStaticMarkup(
      React.createElement(BotMascot, { mascot: "collaborate", size: 36 }),
    );
    expect(markup.match(/class="bot-mascot__face"/g)).toHaveLength(2);
    expect(markup.match(/class="bot-mascot__eye"/g)).toHaveLength(4);
  });

  it("glows only when large enough for the glow to show", () => {
    const small = renderToStaticMarkup(
      React.createElement(BotMascot, { mascot: "code", size: 24 }),
    );
    const large = renderToStaticMarkup(
      React.createElement(BotMascot, { mascot: "code", size: 64 }),
    );
    expect(small).not.toContain("<filter");
    expect(large).toContain("<filter");
    // Dark painted eyes never glow.
    const rock = renderToStaticMarkup(
      React.createElement(BotMascot, { mascot: "automate", size: 64 }),
    );
    expect(rock).not.toContain("<filter");
  });

  it("can stand still and still show the expression", () => {
    const markup = renderToStaticMarkup(
      React.createElement(BotMascot, {
        mascot: "analyze",
        size: 32,
        expression: "sleeping",
        animated: false,
      }),
    );
    expect(markup).not.toContain("bot-mascot--animated");
    expect(markup).toContain('data-expression="sleeping"');
    // Closed eyes are stroked lines, not the filled open pills.
    expect(markup).toContain('stroke-linecap="round"');
    expect(markup).not.toContain("bot-mascot__lid--blink");
  });

  it("labels itself only when asked to", () => {
    const markup = renderToStaticMarkup(
      React.createElement(BotMascot, { mascot: "focus", "aria-label": "Focus bot" }),
    );
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="Focus bot"');
    expect(markup).not.toContain("aria-hidden");
  });
});

describe("bot icon resolution", () => {
  it("resolves mascot icons to a glyph-compatible mascot component", () => {
    const Icon = resolveTwinIcon("mascot:learn");
    expect(Icon).not.toBe(BotGlyph);
    expect(resolveTwinIcon("mascot:learn")).toBe(Icon);
    const markup = renderToStaticMarkup(React.createElement(Icon, { size: 14 }));
    expect(markup).toContain('data-mascot="learn"');
    expect(markup).toContain('width="14"');
  });

  it("draws simple icons and legacy emoji as the closest character", () => {
    const markup = (icon: string | undefined) =>
      renderToStaticMarkup(React.createElement(resolveTwinIcon(icon), { size: 16 }));
    expect(markup("Laptop")).toContain('data-mascot="code"');
    expect(markup("🤖")).toContain('data-mascot="assist"');
    expect(markup(undefined)).toContain('data-mascot="assist"');
    expect(resolveTwinIcon("Laptop")).not.toBe(BotGlyph);
  });

  it("names every icon by the character it is drawn as", () => {
    expect(botIconLabel("mascot:everything")).toBe("Everything");
    expect(botIconLabel("Laptop")).toBe("Code");
    expect(botIconLabel(undefined)).toBe("Assist");
  });
});

describe("BotIconPicker", () => {
  it("offers every character and marks the current one", () => {
    const markup = renderToStaticMarkup(
      React.createElement(BotIconPicker, { value: "mascot:browse", onChange: () => {} }),
    );
    expect(markup.match(/data-mascot="/g)).toHaveLength(BOT_MASCOT_IDS.length);
    expect(markup.match(/role="radio"/g)).toHaveLength(BOT_MASCOT_IDS.length);
    expect(markup.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(markup).toMatch(/aria-checked="true" aria-label="Browse"/);
  });

  it("selects the character a bot with a simple icon is drawn as", () => {
    const markup = renderToStaticMarkup(
      React.createElement(BotIconPicker, { value: "ClipboardList", onChange: () => {} }),
    );
    expect(markup).toMatch(/aria-checked="true" aria-label="Plan"/);
  });
});

describe("mascot expressions", () => {
  it("follows the bot conversation state", () => {
    expect(mascotExpressionForConversation("working")).toBe("working");
    expect(mascotExpressionForConversation("waiting")).toBe("thinking");
    expect(mascotExpressionForConversation("needs_input")).toBe("attention");
    expect(mascotExpressionForConversation("completed")).toBe("happy");
    expect(mascotExpressionForConversation("failed")).toBe("error");
    expect(mascotExpressionForConversation("ready")).toBe("idle");
    expect(mascotExpressionForConversation(null)).toBe("idle");
  });

  it("asks for attention while a run waits on an approval, even mid-work", () => {
    expect(mascotExpressionForBotConversation("working", "waiting_for_approval")).toBe("attention");
    expect(mascotExpressionForBotConversation("working", "working")).toBe("working");
    expect(mascotExpressionForBotConversation(null, "completed")).toBe("happy");
    expect(mascotExpressionForBotConversation(undefined, "idle")).toBe("idle");
  });

  it("maps raw task statuses for surfaces without a projection", () => {
    expect(mascotExpressionForTaskStatus("executing")).toBe("working");
    expect(mascotExpressionForTaskStatus("blocked")).toBe("attention");
    expect(mascotExpressionForTaskStatus("failed")).toBe("error");
    expect(mascotExpressionForTaskStatus("completed")).toBe("happy");
    expect(mascotExpressionForTaskStatus("cancelled")).toBe("idle");
  });
});
