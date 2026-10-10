import { describe, expect, it, vi } from "vitest";
import {
  answerSurfaceProblem,
  extractRepairedBlock,
  findAnswerSurfaceProblems,
  repairAnswerSurfaces,
  replaceAnswerSurfaceBlock,
} from "../repair";

const fence = (body: string) => "```cowork-ui\n" + body + "\n```";
const good = JSON.stringify({ type: "text", text: "Hello" });
const blankFormula = JSON.stringify({
  type: "card",
  children: [
    { type: "slider", id: "rate", label: "Rate", min: 0, max: 10, default: 0 },
    { type: "hero", title: "Monthly", value: { expr: "1000 * rate / (pow(1 + rate, 12) - 1)" } },
  ],
});
const fixedFormula = JSON.stringify({
  type: "card",
  children: [
    { type: "slider", id: "rate", label: "Rate", min: 0, max: 10, default: 0 },
    {
      type: "hero",
      title: "Monthly",
      value: { expr: "rate == 0 ? 1000 / 12 : 1000 * rate / (pow(1 + rate, 12) - 1)" },
    },
  ],
});

describe("answer block problems", () => {
  it("finds bad JSON, schema errors, cut-off fences and blank formulas", () => {
    expect(answerSurfaceProblem(good)).toBeNull();
    expect(answerSurfaceProblem('{"type":"card",')).toMatch(/not valid JSON/);
    expect(answerSurfaceProblem('{"type":"spinner"}')).toBeTruthy();
    expect(answerSurfaceProblem(blankFormula)).toMatch(/no value with the default inputs/);
    expect(answerSurfaceProblem(good, false)).toMatch(/cut off/);
    const message = `Intro\n${fence(good)}\nMiddle\n${fence(blankFormula)}\nEnd\n\`\`\`cowork-ui\n{"type":`;
    expect(findAnswerSurfaceProblems(message).map((problem) => problem.blockIndex)).toEqual([1, 2]);
  });

  it("does not judge values only the logic can compute", () => {
    const withLogic = JSON.stringify({
      type: "hero",
      title: "Total",
      value: { expr: "total" },
      logic: { outputs: ["total"], code: "function compute() { return { total: 1 }; }" },
    });
    expect(answerSurfaceProblem(withLogic)).toBeNull();
  });

  it("replaces one block and closes a cut-off fence", () => {
    const message = `A\n${fence(good)}\nB\n\`\`\`cowork-ui\n{"type":`;
    expect(replaceAnswerSurfaceBlock(message, 1, good)).toBe(
      `A\n${fence(good)}\nB\n${fence(good)}`,
    );
    expect(replaceAnswerSurfaceBlock(message, 0, fixedFormula)).toBe(
      `A\n${fence(fixedFormula)}\nB\n\`\`\`cowork-ui\n{"type":`,
    );
  });

  it("extracts the JSON object from a bare or fenced reply", () => {
    expect(extractRepairedBlock(good)).toBe(good);
    expect(extractRepairedBlock(`Here you go:\n\`\`\`json\n${good}\n\`\`\``)).toBe(good);
    expect(extractRepairedBlock("Sorry, I cannot.")).toBeNull();
  });
});

describe("repairAnswerSurfaces", () => {
  it("swaps in a fix that checks out and leaves good blocks alone", async () => {
    const ask = vi.fn(async (_prompt: string) => fixedFormula);
    const message = `Plan\n${fence(good)}\n${fence(blankFormula)}`;
    const outcome = await repairAnswerSurfaces(message, ask);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toContain("no value with the default inputs");
    expect(outcome).toEqual({
      text: `Plan\n${fence(good)}\n${fence(fixedFormula)}`,
      repaired: 1,
      kept: [],
    });
  });

  it("keeps the original when the reply is still broken or the call fails", async () => {
    const message = `x\n${fence('{"type":"card",')}`;
    const broken = await repairAnswerSurfaces(message, async () => '{"type":"card",');
    expect(broken.text).toBe(message);
    expect(broken.kept).toHaveLength(1);
    const failed = await repairAnswerSurfaces(message, async () => {
      throw new Error("timeout");
    });
    expect(failed).toEqual({ text: message, repaired: 0, kept: ["timeout"] });
  });

  it("asks at most twice per answer and never for a healthy one", async () => {
    const ask = vi.fn(async (_prompt: string) => good);
    const message = [1, 2, 3].map(() => fence('{"type":"nope"}')).join("\n");
    const outcome = await repairAnswerSurfaces(message, ask);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(outcome.repaired).toBe(2);
    const healthy = vi.fn(async (_prompt: string) => good);
    expect((await repairAnswerSurfaces(fence(good), healthy)).repaired).toBe(0);
    expect(healthy).not.toHaveBeenCalled();
  });
});
