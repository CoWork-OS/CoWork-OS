import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { evaluateIsolatedReplay } from "../src/electron/sessions/WorkSessionReplayEvaluationService";
import type { WorkSessionItem } from "../src/shared/types";

const require = createRequire(import.meta.url);
const { evaluateIsolatedEvents } = require("../scripts/qa/isolated-replay-evaluation.cjs");
const events = [
  { id: "done", seq: 1, timestamp: 1, type: "task_completed", payload: { resultSummary: "done" } },
];
const items: WorkSessionItem[] = [
  {
    id: "done",
    sessionId: "session",
    turnId: "turn",
    sequence: 1,
    kind: "status",
    actor: "agent",
    createdAt: 1,
    redactionClass: "standard",
    payload: { eventType: "task_completed", payload: { resultSummary: "done" } },
  },
];

describe("replay assertion contracts", () => {
  it.each([
    { mustUseTools: ["run_tests"] },
    { expectedTerminalStatus: "typo" },
    { mustContainAll: "missing proof" },
    { mustCreatePaths: [null] },
    { mustContainAll: [""] },
    ["invalid assertion object"],
    "invalid assertion object",
  ])("rejects unsupported or malformed assertions instead of passing: %j", (assertions) => {
    expect(evaluateIsolatedEvents(events, { assertions }).passed).toBe(false);
    expect(evaluateIsolatedReplay(items, { assertions: assertions as never }).passed).toBe(false);
  });

  it("keeps valid completion assertions compatible across both graders", () => {
    const assertions = { expectedTerminalStatus: "ok" as const, mustContainAll: ["done"] };
    expect(evaluateIsolatedEvents(events, { assertions }).passed).toBe(true);
    expect(evaluateIsolatedReplay(items, { assertions }).passed).toBe(true);
  });
});
