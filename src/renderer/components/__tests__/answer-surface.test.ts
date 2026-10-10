import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ANSWER_SURFACE_EXAMPLES } from "../../../shared/answer-surfaces/prompt";
import { AnswerSurfaceBlock } from "../AnswerSurface/AnswerSurface";
import { SurfaceActionProvider } from "../AnswerSurface/SurfaceActions";
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

  it("renders the themed calculator with the result first and editable inputs", () => {
    const html = render({ source: JSON.stringify(ANSWER_SURFACE_EXAMPLES.calculator) });
    expect(html).toContain("as-theme-ocean");
    expect(html).toContain("as-card-gradient");
    expect(html.indexOf("as-hero")).toBeLessThan(html.indexOf("as-number"));
    expect(html).toContain("$754");
    expect(html).toMatch(/<input[^>]*inputMode="decimal"[^>]*value="50,000"/);
    expect(html).toContain("as-metrics-colorful");
    expect(html).toContain("--as-fill:40%");
  });

  it("renders tabs, a timeline and tags for a plan", () => {
    const html = render({ source: JSON.stringify(ANSWER_SURFACE_EXAMPLES.plan) });
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("Tram 28 to Alfama");
    // Only the active tab's panel is rendered.
    expect(html).not.toContain("LX Factory");
    expect(html).toContain("as-timeline-marker");
    expect(html).toContain("as-tag as-tone-orange");
  });

  it("renders metric deltas with their direction and sentiment", () => {
    const html = render({ source: JSON.stringify(ANSWER_SURFACE_EXAMPLES.chart) });
    expect(html).toContain("as-delta as-delta-good");
    expect(html).toContain("No growth");
    expect(html).toContain("$76,123");
  });

  it("renders progress bars and rings from values", () => {
    const html = render({
      source: JSON.stringify({
        type: "stack",
        children: [
          { type: "progress", items: [{ label: "Saved", value: 40 }] },
          { type: "progress", style: "ring", items: [{ label: "Steps", value: 50, max: 200 }] },
        ],
      }),
    });
    expect(html).toContain("--as-fill:0.4");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain("as-ring-fill");
  });

  it("renders action buttons, enabled only where the view offers actions", () => {
    const source = JSON.stringify({
      type: "stack",
      children: [
        { type: "slider", id: "n", label: "People", min: 1, max: 8, default: 4 },
        { type: "button", label: "Book for {{n}}", action: { prompt: "Book a table for {{n}}" } },
        { type: "button", label: "Menu", style: "secondary", action: { open: "https://a.com" } },
      ],
    });
    const alone = render({ source });
    expect(alone).toContain("Book for 4");
    expect(alone).toContain("as-action-button-secondary");
    expect(alone.match(/disabled=""/g)?.length).toBe(2);
    const offered = renderToStaticMarkup(
      React.createElement(SurfaceActionProvider, {
        onSendPrompt: () => {},
        onOpenLink: () => {},
        children: React.createElement(AnswerSurfaceBlock, {
          source,
          surfaceKey: "s1-x-0",
          closed: true,
        }),
      }),
    );
    expect(offered).not.toContain('disabled=""');
    // The message itself is only shown in the app's confirmation, never sent on render.
    expect(offered).not.toContain("Book a table for 4");
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
