import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseManager } from "../../../database/schema";
import { recordJevCall } from "../decision-usage-telemetry";

describe("Jev decision usage telemetry", () => {
  const run = vi.fn();
  const prepare = vi.fn(() => ({ run }));
  const db = { prepare } as Any;

  beforeEach(() => {
    vi.spyOn(DatabaseManager, "getInstance").mockReturnValue({
      getDatabase: () => db,
    } as Any);
    prepare.mockClear();
    run.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stores provider-reported Jev tokens and cost in the separate ledger", () => {
    recordJevCall({
      workspaceId: "workspace-1",
      taskId: "task-1",
      sourceKind: "tool-review",
      sourceId: "call-1",
      providerType: "typesafe",
      modelId: "jev-latest",
      purpose: "tool-review",
      status: "success",
      latencyMs: 321,
      usage: { input_tokens: 11, output_tokens: 7, cost: 0.0004 },
    });

    const args = run.mock.calls[0];
    expect(args?.[2]).toBe("workspace-1");
    expect(args?.[3]).toBe("task-1");
    expect(args?.[6]).toBe("typesafe");
    expect(args?.[9]).toBe(11);
    expect(args?.[10]).toBe(7);
    expect(args?.[11]).toBe(0.0004);
    expect(args?.[12]).toBe(321);
    expect(args?.[13]).toBe("success");
    expect(args?.[15]).toBe(1);
  });

  it("does not double-charge cached decisions", () => {
    recordJevCall({
      sourceKind: "task-strategy",
      purpose: "task-strategy",
      status: "success",
      fromCache: true,
      usage: { input_tokens: 100, output_tokens: 20, cost: 4 },
    });

    const args = run.mock.calls[0];
    expect(args?.[9]).toBe(0);
    expect(args?.[10]).toBe(0);
    expect(args?.[11]).toBe(0);
    expect(args?.[14]).toBe(1);
  });
});
