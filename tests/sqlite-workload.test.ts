import { describe, expect, it } from "vitest";
import { buildScenarios, createRandom, parseArgs } from "../scripts/qa/sqlite-workload.mjs";

describe("sqlite-workload", () => {
  it("defaults to the DB0 task matrix, the admission scenario, and the lock scenario", () => {
    const names = buildScenarios(parseArgs([])).map((scenario) => scenario.name);
    expect(names).toEqual([
      "active-1",
      "active-8",
      "active-20",
      "active-40",
      "admission-50x8",
      "lock-2000ms-8",
    ]);
  });

  it("parses options and skips disabled scenarios", () => {
    const options = parseArgs(["--tasks=2,4", "--submitted", "0", "--lock-ms=0", "--steps=3"]);
    expect(options).toMatchObject({ tasks: [2, 4], submitted: 0, lockMs: 0, steps: 3 });
    expect(buildScenarios(options)).toEqual([
      {
        name: "active-2",
        kind: "active",
        activeTasks: 2,
        submittedTasks: 2,
        maxConcurrent: 2,
        lockMs: 0,
      },
      {
        name: "active-4",
        kind: "active",
        activeTasks: 4,
        submittedTasks: 4,
        maxConcurrent: 4,
        lockMs: 0,
      },
    ]);
  });

  it("limits the admission scenario to the configured concurrency", () => {
    const [admission] = buildScenarios(
      parseArgs(["--tasks=", "--submitted=50", "--max-concurrent=8", "--lock-ms=0"]),
    );
    expect(admission).toMatchObject({
      kind: "admission",
      activeTasks: 8,
      submittedTasks: 50,
      maxConcurrent: 8,
    });
  });

  it("rejects unknown and invalid arguments", () => {
    expect(() => parseArgs(["--unknown"])).toThrow("Unknown argument");
    expect(() => parseArgs(["--steps=-1"])).toThrow("Invalid value");
  });

  it("produces a deterministic sequence per seed", () => {
    const first = createRandom(7);
    const second = createRandom(7);
    const values = Array.from({ length: 5 }, () => first());
    expect(Array.from({ length: 5 }, () => second())).toEqual(values);
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(createRandom(8)()).not.toBe(values[0]);
  });
});
