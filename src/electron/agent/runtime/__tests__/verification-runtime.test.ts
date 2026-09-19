import { describe, expect, it, vi } from "vitest";

import type { Task } from "../../../../shared/types";
import { VerificationRuntime } from "../VerificationRuntime";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Implement feature",
    prompt: "Build a release review workflow",
    workspaceId: "workspace-1",
    status: "completed",
    createdAt: 0,
    updatedAt: 0,
    agentType: "main",
    agentConfig: {
      verificationAgent: true,
    },
    ...overrides,
  } as Task;
}

describe("VerificationRuntime", () => {
  it("runs a verifier child task and passes on PASS verdicts", async () => {
    const runReadOnlyChildTaskAndWait = vi.fn().mockResolvedValue({
      childTaskId: "child-1",
      status: "completed" as const,
      summary: "VERDICT: PASS\nLooks good",
    });
    const runtime = new VerificationRuntime({ runReadOnlyChildTaskAndWait });

    const result = await runtime.run({
      parentTask: makeTask(),
      explicit: true,
      parentSummary: "Implementation finished",
    });

    expect(runReadOnlyChildTaskAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        workerRole: "verifier",
        title: expect.stringContaining("Verify:"),
      }),
    );
    expect(result.gated).toBe(true);
    expect(result.ran).toBe(true);
    expect(result.verdict).toBe("PASS");
    expect(result.shouldBlock).toBe(false);
  });

  it("asks the verifier to flag unrelated or overcomplicated changes", async () => {
    const runReadOnlyChildTaskAndWait = vi.fn().mockResolvedValue({
      childTaskId: "child-1",
      status: "completed" as const,
      summary: "VERDICT: PASS\nLooks good",
    });
    const runtime = new VerificationRuntime({ runReadOnlyChildTaskAndWait });

    await runtime.run({
      parentTask: makeTask(),
      explicit: true,
      parentSummary: "Implementation finished",
    });

    const prompt = runReadOnlyChildTaskAndWait.mock.calls[0]?.[0]?.prompt || "";
    expect(prompt).toContain("every changed file should trace to the user request");
    expect(prompt).toContain("unrelated cleanup");
    expect(prompt).toContain("speculative abstractions");
  });

  it("blocks high-risk partial verification results", async () => {
    const runtime = new VerificationRuntime({
      runReadOnlyChildTaskAndWait: vi.fn().mockResolvedValue({
        childTaskId: "child-2",
        status: "completed" as const,
        summary: "VERDICT: PARTIAL\nEnvironment limited checks",
      }),
    });

    const result = await runtime.run({
      parentTask: makeTask({ title: "Build an API", prompt: "Add backend API changes" }),
      explicit: true,
      highRisk: true,
    });

    expect(result.verdict).toBe("PARTIAL");
    expect(result.shouldBlock).toBe(true);
  });

  it("skips non-gated research-only tasks", async () => {
    const runtime = new VerificationRuntime({
      runReadOnlyChildTaskAndWait: vi.fn(),
    });

    const result = await runtime.run({
      parentTask: makeTask({
        agentConfig: { verificationAgent: false },
        title: "Research a topic",
        prompt: "Collect background information only",
      }),
    });

    expect(result.gated).toBe(false);
    expect(result.ran).toBe(false);
    expect(result.verdict).toBe("PASS");
  });
  it.each(["failed", "cancelled", "timeout", "missing"] as const)(
    "rejects a PASS summary from a %s verifier",
    async (status) => {
      const runtime = new VerificationRuntime({
        runReadOnlyChildTaskAndWait: vi.fn().mockResolvedValue({
          childTaskId: "child-incomplete",
          status,
          summary: "VERDICT: PASS\nA partial or stale summary",
        }),
      });
      const result = await runtime.run({ parentTask: makeTask(), explicit: true });
      expect(result.status).toBe(status);
      expect(result.verdict).toBe("FAIL");
      expect(result.shouldBlock).toBe(true);
    },
  );

  it("uses caller risk evidence even when task wording looks harmless", async () => {
    const runReadOnlyChildTaskAndWait = vi.fn().mockResolvedValue({
      childTaskId: "child-risk",
      status: "completed",
      summary: "VERDICT: PARTIAL\nUnable to verify all results",
    });
    const runtime = new VerificationRuntime({ runReadOnlyChildTaskAndWait });
    const result = await runtime.run({
      parentTask: makeTask({
        title: "Review the changes",
        prompt: "Check the result",
        agentConfig: { verificationAgent: false },
      }),
      highRisk: true,
    });
    expect(runReadOnlyChildTaskAndWait).toHaveBeenCalledOnce();
    expect(result.verdict).toBe("PARTIAL");
    expect(result.shouldBlock).toBe(true);
  });

  it("preserves nonblocking PARTIAL for a completed low-risk review", async () => {
    const runtime = new VerificationRuntime({
      runReadOnlyChildTaskAndWait: vi.fn().mockResolvedValue({
        childTaskId: "child-low-risk",
        status: "completed",
        summary: "VERDICT: PARTIAL\nOne optional check unavailable",
      }),
    });
    const result = await runtime.run({
      parentTask: makeTask({ title: "Review text", prompt: "Proofread the paragraph" }),
      explicit: true,
    });
    expect(result.verdict).toBe("PARTIAL");
    expect(result.shouldBlock).toBe(false);
  });
  it.each(["partial_success", "failed", "needs_user_action"] as const)(
    "rejects a completed child whose terminal outcome is %s",
    async (terminalStatus) => {
      const runtime = new VerificationRuntime({
        runReadOnlyChildTaskAndWait: vi.fn().mockResolvedValue({
          childTaskId: "incomplete-child",
          status: "completed",
          terminalStatus,
          summary: "VERDICT: PASS\nOld summary",
        }),
      });
      const result = await runtime.run({ parentTask: makeTask(), explicit: true });
      expect(result.verdict).toBe("FAIL");
      expect(result.shouldBlock).toBe(true);
    },
  );
});
