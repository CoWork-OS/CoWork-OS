import { describe, expect, it } from "vitest";
import { toPlainAnswerText, withoutAnswerSurfaceBlocks } from "../answer-surfaces/blocks";
import { richEmbedsToPlainText } from "../rich-embeds";

const page = `<!doctype html><html><head><title>Savings calculator</title></head><body><input id="goal"><script>cowork.ready</script></body></html>`;

describe("rich embeds in plain text", () => {
  it("turns frames, pages, file embeds and videos into one line each", () => {
    const message = [
      "Here you go.",
      '::frame{title="Budget planner" kind="calculator"}',
      "```html",
      page,
      "```",
      "```html",
      page,
      "```",
      '::html{path="reports/summary.html"}',
      '<rich-frame path="artifacts/chart.html" title="Chart">',
      "</rich-frame>",
      '::video{path="clips/demo.mp4" title="Demo"}',
      "Done.",
    ].join("\n");
    expect(richEmbedsToPlainText(message)).toBe(
      [
        "Here you go.",
        "**Budget planner** (interactive; open this answer in CoWork to use it)",
        "**Savings calculator** (interactive; open this answer in CoWork to use it)",
        "**summary.html** (reports/summary.html; open this answer in CoWork to view it)",
        "**Chart** (artifacts/chart.html; open this answer in CoWork to view it)",
        "Video: Demo (clips/demo.mp4)",
        "Done.",
      ].join("\n"),
    );
  });

  it("leaves code alone, including html snippets and quoted directives", () => {
    const message = [
      "Use this markup:",
      "```html",
      "<p>Hello</p>",
      "```",
      "```md",
      '::frame{title="Example"}',
      "```",
    ].join("\n");
    expect(richEmbedsToPlainText(message)).toBe(message);
  });

  it("keeps prose previews free of raw HTML", () => {
    expect(
      withoutAnswerSurfaceBlocks(
        `Working on it.\n::frame{title="Plan"}\n\`\`\`html\n${page}\n\`\`\``,
      ),
    ).toBe("Working on it.\n**Plan** (interactive; open this answer in CoWork to use it)");
  });

  it("runs through toPlainAnswerText with cowork-ui blocks", () => {
    const block = JSON.stringify({ type: "text", text: "Hello from a block" });
    const message = `Intro\n\n\`\`\`cowork-ui\n${block}\n\`\`\`\n\n::html{path="a/b.html" title="B"}`;
    expect(toPlainAnswerText(message)).toBe(
      "Intro\n\nHello from a block\n\n**B** (a/b.html; open this answer in CoWork to view it)",
    );
  });
});

describe("plain text for logic-backed answers", () => {
  it("leaves out values only the logic can compute and says where they live", () => {
    const block = {
      type: "card",
      title: "Revenue by region",
      data: { sales: "uploads/sales.csv", hits: { tool: "r3f9a2c41" } },
      logic: { outputs: ["total", "top"], code: "function compute() { return {}; }" },
      computed: { doubled: "total * 2" },
      children: [
        {
          type: "hero",
          title: "Total revenue",
          value: { expr: "total", prefix: "$" },
          caption: "Top region {{top}}",
        },
        {
          type: "values",
          items: [
            { label: "Twice the total", value: { expr: "doubled" } },
            { label: "Regions", value: 4 },
          ],
        },
        { type: "text", text: "Prices are before tax." },
      ],
    };
    const text = toPlainAnswerText(`\`\`\`cowork-ui\n${JSON.stringify(block)}\n\`\`\``);
    expect(text).toBe(
      [
        "**Revenue by region**",
        "**Total revenue**",
        "- Regions: 4",
        "Prices are before tax.",
        "_Some values in this answer are calculated from uploads/sales.csv, a tool result in the CoWork app._",
      ].join("\n"),
    );
    expect(text).not.toContain("—");
  });
});
