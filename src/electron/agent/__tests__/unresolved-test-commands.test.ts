import { describe, expect, it } from "vitest";
import { isTestCommand } from "../executor-prompt-heuristics-utils";
import {
  findUnresolvedTestCommandFailures,
  type RecordedVerificationRun,
} from "../unresolved-test-commands";

function runs(...entries: Array<[string, boolean]>): RecordedVerificationRun[] {
  return entries.map(([command, succeeded], index) => ({
    kind: "test",
    command,
    succeeded,
    seq: index + 1,
  }));
}

const find = (entries: RecordedVerificationRun[]) =>
  findUnresolvedTestCommandFailures(entries, isTestCommand);

describe("findUnresolvedTestCommandFailures", () => {
  it("reports a configured command that only passed as a narrower command", () => {
    expect(
      find(
        runs(["git status --short && npm test", false], ["node --test test/math.test.js", true]),
      ),
    ).toEqual({ failingCommands: ["npm test"], passingCommand: "node --test test/math.test.js" });
  });

  it("treats a later pass of the same command as resolving the failure", () => {
    expect(find(runs(["npm test", false], ["npm test", true]))).toBeNull();
  });

  it("accepts extra flags and environment assignments on the passing run", () => {
    expect(find(runs(["npm test", false], ["CI=1 npm test -- --run", true]))).toBeNull();
  });

  it("lets a broader command or the whole suite resolve a narrower failure", () => {
    expect(
      find(runs(["npx vitest run src/a.test.ts", false], ["npx vitest run", true])),
    ).toBeNull();
    expect(find(runs(["npx vitest run src/a.test.ts", false], ["npm test", true]))).toBeNull();
    expect(find(runs(["pytest tests/test_a.py", false], ["python -m pytest", true]))).toBeNull();
  });

  it("does not let a narrower pass resolve a broader failure", () => {
    expect(find(runs(["npx vitest run", false], ["npx vitest run src/a.test.ts", true]))).toEqual({
      failingCommands: ["npx vitest run"],
      passingCommand: "npx vitest run src/a.test.ts",
    });
  });

  it("ignores failures with no later passing test run", () => {
    expect(find(runs(["npm test", false]))).toBeNull();
    expect(find(runs(["node --test test/a.test.js", true], ["npm test", false]))).toBeNull();
  });

  it("ignores build and check runs", () => {
    expect(
      findUnresolvedTestCommandFailures(
        [
          { kind: "build", command: "npm run build", succeeded: false, seq: 1 },
          { kind: "test", command: "npm test", succeeded: true, seq: 2 },
        ],
        isTestCommand,
      ),
    ).toBeNull();
  });
});
