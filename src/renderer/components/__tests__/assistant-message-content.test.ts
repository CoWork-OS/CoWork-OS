import { describe, expect, it } from "vitest";
import { parseAssistantMessageSegments } from "../AssistantMessageContent";

describe("AssistantMessageContent", () => {
  it("splits markdown and video directives", () => {
    const segments = parseAssistantMessageSegments(
      "Here is the clip.\n\n::video{path=\"artifacts/demo.mp4\" title=\"Demo clip\" muted=true loop=false}\n\nWrap up.",
    );

    expect(segments).toHaveLength(3);
    expect(segments[0]).toMatchObject({ type: "markdown" });
    expect(segments[1]).toMatchObject({
      type: "video",
      directive: {
        path: "artifacts/demo.mp4",
        title: "Demo clip",
        muted: true,
        loop: false,
      },
    });
    expect(segments[2]).toMatchObject({ type: "markdown" });
  });

  it("returns a compact error segment for malformed directives", () => {
    const segments = parseAssistantMessageSegments("::video{title=\"Missing path\"}");
    expect(segments).toEqual([
      {
        type: "video_error",
        raw: "::video{title=\"Missing path\"}",
        error: "Video embed requires a path",
      },
    ]);
  });

  it("sanitizes leaked tool transcript prefixes before segment parsing", () => {
    const segments = parseAssistantMessageSegments(
      'Tackling: {"id":"call_skill_list","tool":"skill_list","input":{}} <tool name="skill_list">{}</tool>\n{"description":"Real content"}',
    );

    expect(segments).toEqual([
      {
        type: "markdown",
        content: 'Tackling:\n{"description":"Real content"}',
      },
    ]);
  });
});
