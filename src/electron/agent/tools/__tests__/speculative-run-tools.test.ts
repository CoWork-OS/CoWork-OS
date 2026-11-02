import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpeculativeRun, Workspace } from "../../../../shared/types";
import { toolBoundaryClass } from "../../../../shared/tool-boundaries";
import { evaluateMontyToolPolicy } from "../../../security/monty-tool-policy";
import {
  SpeculativeFixService,
  setActiveSpeculativeFixService,
} from "../../../triggers/SpeculativeFixService";
import { MemorySpeculativeRunStore } from "../../../triggers/speculative-run-store";
import { SpeculativeRunTools } from "../speculative-run-tools";

function run(id: string, overrides: Partial<SpeculativeRun> = {}): SpeculativeRun {
  return {
    id,
    triggerId: "trigger-1",
    triggerName: "Bug reports",
    workspaceId: "ws-1",
    taskId: `task-${id}`,
    status: "discarded",
    outcome: "not_reproduced",
    delivery: "draft_only",
    destination: "origin_thread",
    maxDiffLines: 200,
    issueExcerpt: "Export crashes",
    origin: { source: "channel_message" },
    startedAt: 1_000,
    deadlineAt: 2_000,
    finishedAt: 1_500,
    note: "The worker could not reproduce the problem.",
    ...overrides,
  };
}

async function activate(runs: SpeculativeRun[]): Promise<SpeculativeFixService> {
  const service = new SpeculativeFixService({
    createTask: vi.fn(),
    getTask: vi.fn(),
    cancelTask: vi.fn(),
    logTaskEvent: vi.fn(),
    canIsolate: vi.fn(),
    worktree: {
      commit: vi.fn(),
      diffStats: vi.fn(),
      branchName: vi.fn(),
      openPullRequest: vi.fn(),
      discard: vi.fn(),
    },
    store: new MemorySpeculativeRunStore(runs),
  });
  await service.init();
  setActiveSpeculativeFixService(service);
  return service;
}

afterEach(() => setActiveSpeculativeFixService(null));

describe("SpeculativeRunTools", () => {
  it("is offered only while the speculative runtime runs", async () => {
    expect(SpeculativeRunTools.isAvailable()).toBe(false);
    await activate([]);
    expect(SpeculativeRunTools.isAvailable()).toBe(true);
    const [definition] = SpeculativeRunTools.getToolDefinitions();
    expect(definition.name).toBe("speculative_runs");
    expect(definition.description).toMatch(/^List recent speculative/);
    expect(definition.description).toMatch(/Use when/);
    expect(definition.description).toMatch(/Read-only/);
  });

  it("lists this workspace's runs, newest first, with their outcomes", async () => {
    await activate([
      run("a", { startedAt: 1_000 }),
      run("b", {
        startedAt: 3_000,
        status: "delivered",
        outcome: "draft_ready",
        report: {
          reproduced: true,
          fixed: true,
          summary: "Guard the empty export",
          diffStat: "",
          testEvidence: "export.test.ts passed",
        },
        filesChanged: 1,
        linesAdded: 4,
        linesRemoved: 1,
        branchName: "cowork/fix-export",
        worktreeKept: true,
      }),
      run("other", { workspaceId: "ws-2", startedAt: 5_000 }),
    ]);
    const tools = new SpeculativeRunTools(() => ({ id: "ws-1" }) as Workspace);

    const result = await tools.listRuns({});
    expect(result).toMatchObject({ success: true, count: 2 });
    const runs = result.runs as Array<Record<string, unknown>>;
    expect(runs.map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(runs[0]).toMatchObject({
      outcome: "draft_ready",
      reproduced: true,
      fixed: true,
      diffStat: { filesChanged: 1, linesAdded: 4, linesRemoved: 1 },
      branch: "cowork/fix-export",
      worktreeKept: true,
    });
    expect(runs[1]).toMatchObject({ outcome: "not_reproduced", note: expect.any(String) });

    const delivered = await tools.listRuns({ status: "delivered", limit: 5 });
    expect((delivered.runs as unknown[]).length).toBe(1);
  });

  it("says when the runtime is unavailable", async () => {
    const tools = new SpeculativeRunTools(() => ({ id: "ws-1" }) as Workspace);
    expect(await tools.listRuns({})).toMatchObject({ success: false });
  });

  it("is an app tool that the default tool policy passes explicitly", async () => {
    expect(toolBoundaryClass("speculative_runs")).toBe("app");
    await expect(
      evaluateMontyToolPolicy({
        workspace: { id: "ws-1", path: "" } as Workspace,
        toolName: "speculative_runs",
        toolInput: {},
      }),
    ).resolves.toEqual({ decision: "pass" });
  });
});
