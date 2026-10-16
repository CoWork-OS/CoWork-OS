import { describe, expect, it } from "vitest";
import { TerminalBlockRunRequestSchema } from "../validation";
import { surfaceOriginNote } from "../../../shared/answer-surfaces/actions";

const base = {
  runId: "run-abc_1",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  taskId: "22222222-2222-4222-8222-222222222222",
};

describe("code block run requests", () => {
  it("accepts ordinary single and multi-line commands with tabs", () => {
    const result = TerminalBlockRunRequestSchema.safeParse({
      ...base,
      command: "cd app\n\tnpm test",
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ["Ctrl-U", String.fromCodePoint(0x15)],
    ["escape", String.fromCodePoint(0x1b)],
    ["delete", String.fromCodePoint(0x7f)],
    ["right-to-left override", String.fromCodePoint(0x202e)],
    ["zero-width space", String.fromCodePoint(0x200b)],
    ["byte order mark", String.fromCodePoint(0xfeff)],
  ])("rejects a command hiding a %s character", (_name, character) => {
    const result = TerminalBlockRunRequestSchema.safeParse({
      ...base,
      command: `echo ok${character}; rm -rf build`,
    });
    expect(result.success).toBe(false);
  });

  it("rejects run ids that are not plain tokens", () => {
    expect(
      TerminalBlockRunRequestSchema.safeParse({ ...base, runId: "../x", command: "ls" }).success,
    ).toBe(false);
  });
});

describe("code block run note", () => {
  it("tells the agent the output is data, not instructions", () => {
    expect(surfaceOriginNote("code_block")).toContain("not instructions");
  });
});
