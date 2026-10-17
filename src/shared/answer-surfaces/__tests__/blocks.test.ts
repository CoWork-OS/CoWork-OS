import { describe, expect, it } from "vitest";
import {
  answerSurfaceKey,
  splitAnswerSurfaceBlocks,
  summarizeSurfaceChanges,
  toPlainAnswerText,
  withoutAnswerSurfaceBlocks,
} from "../blocks";
import { parseAnswerSurfaceSource } from "../schema";

const BLOCK =
  '{"type":"values","title":"Shopping","items":[{"label":"Lamb","value":{"expr":"people * 0.4","decimals":1,"unit":"kg"}}],"x":1}';
const STEPPER_BLOCK =
  '{"type":"stack","children":[{"type":"stepper","id":"people","label":"People","min":1,"max":10,"default":4},{"type":"values","items":[{"label":"Lamb","value":{"expr":"people * 0.4","decimals":1,"unit":"kg"}}]},{"type":"checklist","id":"steps","title":"Timeline","items":["Prep","Roast","Rest"]}]}';
const ROUTINE_BLOCK = JSON.stringify({
  type: "stack",
  children: [
    { type: "slider", id: "minutes", label: "Duration", min: 5, max: 60, default: 20 },
    {
      type: "checklist",
      id: "routine",
      title: "{{minutes}} minute routine",
      items: [
        {
          id: "disconnect",
          time: "{{minutes / 5}} min",
          text: "Disconnect for {{minutes / 5}} minutes",
          detail: "{{minutes / 10}} minutes with dim lights",
        },
      ],
    },
  ],
});

describe("splitAnswerSurfaceBlocks", () => {
  it("splits text and blocks in order and marks unfinished blocks", () => {
    const message = `# Plan\nIntro\n\`\`\`cowork-ui\n${STEPPER_BLOCK}\n\`\`\`\nMiddle\n\`\`\`cowork-ui\n{"type":`;
    const parts = splitAnswerSurfaceBlocks(message);
    expect(parts.map((part) => part.kind)).toEqual(["text", "surface", "text", "surface"]);
    expect(parts[1]).toMatchObject({ kind: "surface", closed: true, source: STEPPER_BLOCK });
    expect(parts[3]).toMatchObject({ kind: "surface", closed: false });
  });

  it("gives identical blocks distinct keys and stable keys across renders", () => {
    const message = `\`\`\`cowork-ui\n${STEPPER_BLOCK}\n\`\`\`\n\n\`\`\`cowork-ui\n${STEPPER_BLOCK}\n\`\`\``;
    const keys = splitAnswerSurfaceBlocks(message)
      .filter((part) => part.kind === "surface")
      .map((part) => (part.kind === "surface" ? part.key : ""));
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toBe(answerSurfaceKey(STEPPER_BLOCK, 0));
    expect(splitAnswerSurfaceBlocks(message)[0]).toEqual(splitAnswerSurfaceBlocks(message)[0]);
  });

  it("leaves other fences alone", () => {
    expect(splitAnswerSurfaceBlocks("```json\n{}\n```")).toEqual([
      { kind: "text", text: "```json\n{}\n```" },
    ]);
  });
});

describe("toPlainAnswerText", () => {
  it("replaces blocks with readable text and drops invalid or unfinished ones", () => {
    const message = [
      "Here is your plan.",
      "```cowork-ui",
      STEPPER_BLOCK,
      "```",
      "```cowork-ui",
      '{"type":"nope"}',
      "```",
      "Enjoy!",
      "```cowork-ui",
      '{"type":"text"',
    ].join("\n");
    expect(toPlainAnswerText(message)).toBe(
      [
        "Here is your plan.",
        "People: 4",
        "- Lamb: 1.6 kg",
        "**Timeline**",
        "- [ ] Prep",
        "- [ ] Roast",
        "- [ ] Rest",
        "",
        "Enjoy!",
      ].join("\n"),
    );
  });

  it("returns messages without blocks unchanged", () => {
    expect(toPlainAnswerText("plain\n```js\nx\n```")).toBe("plain\n```js\nx\n```");
  });

  it("resolves checklist text, time, detail and heading in plain answers", () => {
    const text = toPlainAnswerText(`\`\`\`cowork-ui\n${ROUTINE_BLOCK}\n\`\`\``);
    expect(text).toContain("**20 minute routine**");
    expect(text).toContain("- [ ] 4 min — Disconnect for 4 minutes — 2 minutes with dim lights");
    expect(text).not.toContain("{{");
  });

  it("renders a single values block", () => {
    expect(
      toPlainAnswerText(`\`\`\`cowork-ui\n${BLOCK.replace("people * 0.4", "2")}\n\`\`\``),
    ).toBe("**Shopping**\n- Lamb: 2.0 kg");
  });
});

describe("withoutAnswerSurfaceBlocks", () => {
  it("keeps only the prose, dropping finished and unfinished blocks", () => {
    const message = `Intro\n\`\`\`cowork-ui\n${STEPPER_BLOCK}\n\`\`\`\nMiddle\n\`\`\`cowork-ui\n{"type":`;
    expect(withoutAnswerSurfaceBlocks(message)).toBe("Intro\nMiddle");
    expect(withoutAnswerSurfaceBlocks("plain text")).toBe("plain text");
  });
});

describe("summarizeSurfaceChanges", () => {
  it("resolves checked item labels using the updated control state", () => {
    const parsed = parseAnswerSurfaceSource(ROUTINE_BLOCK);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(summarizeSurfaceChanges(parsed.spec, { minutes: 30, routine: ["disconnect"] })).toEqual([
      "Duration: 30",
      "30 minute routine: 1/1 done (Disconnect for 6 minutes)",
    ]);
  });

  it("reports only what the user changed", () => {
    const parsed = parseAnswerSurfaceSource(STEPPER_BLOCK);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(summarizeSurfaceChanges(parsed.spec, { people: 4, steps: [] })).toEqual([]);
    expect(
      summarizeSurfaceChanges(parsed.spec, { people: 7, steps: ["item_1", "item_2"] }),
    ).toEqual(["People: 7", "Timeline: 2/3 done (Prep; Roast)"]);
  });
});
