import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BOT_MASCOT_IDS, botMascotIcon } from "../../../shared/bot-mascots";
import { BotIconPicker } from "../bot-mascot/BotIconPicker";

describe("BotIconPicker", () => {
  it("is a single Tab stop: only the selected character is focusable", () => {
    const selected = BOT_MASCOT_IDS[2];
    const markup = renderToStaticMarkup(
      React.createElement(BotIconPicker, { value: botMascotIcon(selected), onChange: () => {} }),
    );
    expect(markup.match(/tabindex="0"/g)).toHaveLength(1);
    expect(markup.match(/tabindex="-1"/g)).toHaveLength(BOT_MASCOT_IDS.length - 1);
  });
});
