import { describe, expect, it } from "vitest";
import {
  getTextForSpeech,
  parseVoiceDirectives,
  shouldSpeak,
  stripMarkdownForSpeech,
} from "../voice-directives";

describe("stripMarkdownForSpeech", () => {
  it("removes images before processing links", () => {
    expect(stripMarkdownForSpeech("![a chart](chart.png)")).toBe("");
    expect(stripMarkdownForSpeech("See ![a chart](chart.png) and [the guide](guide.md).")).toBe(
      "See  and the guide.",
    );
    expect(stripMarkdownForSpeech("![](chart.png) [guide](guide.md)")).toBe("guide");
  });

  it("preserves underscores within identifiers", () => {
    expect(stripMarkdownForSpeech("Open my_config_file and other__config__file.")).toBe(
      "Open my_config_file and other__config__file.",
    );
    expect(stripMarkdownForSpeech("_italic_ and (__bold__) and **strong** and *emphasis*.")).toBe(
      "italic and (bold) and strong and emphasis.",
    );
    expect(stripMarkdownForSpeech("é_config_file _你好_ 日本_語_名")).toBe(
      "é_config_file 你好 日本_語_名",
    );
  });

  it("retains the existing treatment of headings, lists, rules and code", () => {
    expect(
      stripMarkdownForSpeech("# Title\n- **one**\n1. *two*\n---\n```js\nhidden()\n```\n`hidden`"),
    ).toBe("Title\none\ntwo");
    expect(stripMarkdownForSpeech("")).toBe("");
  });
});

describe("parseVoiceDirectives", () => {
  it("uses cleaned message text without explicit directives", () => {
    expect(parseVoiceDirectives("  **Hello**, my_config_file.  ")).toEqual({
      speakText: "Hello, my_config_file.",
      displayText: "**Hello**, my_config_file.",
      hasDirective: false,
      params: undefined,
    });
  });

  it("combines speech blocks and keeps surrounding text for display", () => {
    const message = "Before [[speak]] hello [[/speak]] middle [[SPEAK]]world[[/SPEAK]] after";
    expect(parseVoiceDirectives(message)).toEqual({
      speakText: "hello world",
      displayText: "Before  hello  middle world after",
      hasDirective: true,
      params: undefined,
    });
    expect(getTextForSpeech(message)).toBe("hello world");
  });

  it.each(["speed", "rate"])("parses voice, %s and pitch parameters", (rate) => {
    expect(
      parseVoiceDirectives(`[[speak:voice=alloy ${rate}=1.2 pitch=0.8]]Hi[[/speak]]`).params,
    ).toEqual({ voice: "alloy", speed: 1.2, pitch: 0.8 });
  });

  it("takes parameters from the first parameterised directive", () => {
    expect(
      parseVoiceDirectives("[[speak:voice=alloy]]A[[/speak]][[speak:voice=echo]]B[[/speak]]")
        .params,
    ).toEqual({ voice: "alloy" });
    expect(parseVoiceDirectives("[[speak]]  [[/speak]]").speakText).toBe("");
    expect(parseVoiceDirectives("[[speak:unknown=value]]Hi[[/speak]]").params).toBeUndefined();
  });
});

describe("shouldSpeak", () => {
  it.each(["auto", "manual", "smart"] as const)(
    "does not speak in %s mode when voice is disabled",
    (mode) => {
      expect(shouldSpeak("[[speak]]Hello[[/speak]]", mode, false)).toBe(false);
    },
  );

  it("speaks non-empty content automatically", () => {
    expect(shouldSpeak("Hello", "auto", true)).toBe(true);
    expect(shouldSpeak("![chart](chart.png)", "auto", true)).toBe(false);
    expect(shouldSpeak("", "auto", true)).toBe(false);
  });

  it("requires explicit directives in smart mode", () => {
    expect(shouldSpeak("Hello", "smart", true)).toBe(false);
    expect(shouldSpeak("[[speak]]Hello[[/speak]]", "smart", true)).toBe(true);
  });

  it("never speaks automatically in manual mode", () => {
    expect(shouldSpeak("[[speak]]Hello[[/speak]]", "manual", true)).toBe(false);
  });
});
