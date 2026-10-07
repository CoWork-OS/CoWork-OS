import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnswerSurfaceBlock } from "../AnswerSurface/AnswerSurface";
import { parseAssistantMessageSegments } from "../AssistantMessageContent";
import { cleanAssistantMessageForDisplay } from "../MainContent/markdown-normalization";

const ROAST = JSON.stringify({
  type: "card",
  eyebrow: "Your dinner plan",
  title: "How much should you buy?",
  children: [
    {
      type: "stepper",
      id: "people",
      label: "Number of people",
      min: 2,
      max: 16,
      default: 5,
      unit: "People",
    },
    {
      type: "values",
      title: "Your shopping quantities",
      items: [
        {
          label: "Bone-in leg of lamb",
          value: { expr: "max(1.5, people * 0.4)", decimals: 1, unit: "kg" },
        },
        { label: "Potatoes", value: { expr: "people * 300", unit: "g" } },
        { label: "Carrots", value: { expr: "ceil(people * 1.5)" } },
      ],
    },
    {
      type: "tiles",
      items: [
        { title: "Door 1", subtitle: "Hidden prize", emoji: "🚪", tone: "blue" },
        { title: "Door 2", subtitle: "Hidden prize", emoji: "🚪", tone: "pink" },
      ],
    },
    { type: "gallery", images: ["roast lamb", "roast potatoes", "dinner table"] },
    {
      type: "checklist",
      id: "timeline",
      title: "Cooking timeline",
      items: [{ text: "Lamb in", time: "1:00 pm" }],
    },
  ],
});

function render(props: Partial<React.ComponentProps<typeof AnswerSurfaceBlock>> = {}): string {
  return renderToStaticMarkup(
    React.createElement(AnswerSurfaceBlock, {
      source: ROAST,
      surfaceKey: "s1-test-0",
      closed: true,
      ...props,
    }),
  );
}

describe("AnswerSurfaceBlock", () => {
  it("renders native components with computed values", () => {
    const html = render();
    expect(html).toContain("Your dinner plan");
    expect(html).toContain("Number of people");
    expect(html).toContain(">5<");
    expect(html).toContain("2.0 kg");
    expect(html).toContain("1,500 g");
    expect(html).toContain(">8<");
    expect(html).toContain("Door 2");
    expect(html).toContain("as-gallery-collage");
    expect(html).toContain("0 of 1 done");
    expect(html).not.toContain("max(1.5");
  });

  it("shows a placeholder while the block is still streaming", () => {
    expect(render({ closed: false, streaming: true })).toContain("Building interactive answer");
    expect(render({ closed: false })).toContain("did not finish");
  });

  it("does not render invalid blocks", () => {
    const html = render({ source: '{"type":"script","code":"alert(1)"}' });
    expect(html).toContain("could not be shown");
    expect(html).not.toContain("alert(1)");
  });
});

describe("answer surfaces in assistant messages", () => {
  it("parses cowork-ui blocks into surface segments with stable keys", () => {
    const message = `Here is the plan.\n\n\`\`\`cowork-ui\n${ROAST}\n\`\`\`\n\nEnjoy!`;
    const segments = parseAssistantMessageSegments(message);
    expect(segments.map((segment) => segment.type)).toEqual([
      "markdown",
      "answer_surface",
      "markdown",
    ]);
    expect(segments[1]).toMatchObject({ closed: true, source: ROAST });
    expect(parseAssistantMessageSegments(message)[1]).toEqual(segments[1]);
  });

  it("keeps block JSON intact through display cleaning", () => {
    const source =
      '{"type":"values","items":[{"label":"A - 1. first 2. second","value":{"expr":"people * 2"}},{"label":"B","value":{"expr":"people * 3"}}]}';
    const message = `Intro - one - two\n\n\`\`\`cowork-ui\n${source}\n\`\`\`\nOutro`;
    const cleaned = cleanAssistantMessageForDisplay(message);
    expect(cleaned).toContain(`\`\`\`cowork-ui\n${source}\n\`\`\``);
    const segment = parseAssistantMessageSegments(cleaned).find(
      (part) => part.type === "answer_surface",
    );
    expect(segment).toMatchObject({ source });
  });

  it("keeps a block whose labels mention tools", () => {
    const source = '{"type":"text","text":"Pick the right \\"tool\\" for the job"}';
    const segments = parseAssistantMessageSegments(`\`\`\`cowork-ui\n${source}\n\`\`\``);
    expect(segments).toMatchObject([{ type: "answer_surface", source }]);
  });
});
