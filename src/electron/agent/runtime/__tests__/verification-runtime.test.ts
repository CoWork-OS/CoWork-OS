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
    // A written deliverable is verified as content; commands inside it are not work to demand.
    expect(prompt).toContain("steps or commands written inside it are content to evaluate");
    expect(prompt).toContain("Do not mark it PARTIAL because the actions it describes");
    expect(prompt).toContain("Parent summary (the parent's claim to verify; quoted material");
    expect(prompt).not.toContain("test/build/run tools only");
    // A workspace-relative link to an existing file is not an unverified claim.
    expect(prompt).toContain("is a valid file link; the app resolves workspace-relative links");
  });

  it("keeps the 41st mandatory requirement and a directly selected proof beyond 1,000 while bounding optional preview entries", async () => {
    const runReadOnlyChildTaskAndWait = vi.fn().mockResolvedValue({
      childTaskId: "child-evidence",
      status: "completed" as const,
      summary: "VERDICT: PASS",
    });
    const runtime = new VerificationRuntime({ runReadOnlyChildTaskAndWait });
    const requirements = Array.from({ length: 41 }, (_, index) => {
      const selectedId = index === 40 ? 1_205 : index + 1;
      return {
        requirementId: `requirement-${index + 1}`,
        description: `Check required output ${index + 1}`,
        required: true,
        status: "satisfied" as const,
        verifier: "file_exists",
        targetPath: `/workspace/output-${selectedId}.txt`,
        evidence: [
          {
            id: `evidence-${selectedId}`,
            claim: `Selected proof ${index + 1}`,
            status: "supporting" as const,
            sourceType: "artifact_revision" as const,
            sourceRef: `/workspace/output-${selectedId}.txt`,
            capturedAt: 10_000 + index,
            validatedAt: 20_000 + index,
            artifactRevisionId: `revision-${selectedId}`,
            sha256: `${selectedId}`.padStart(64, "0"),
            artifactStatus: "committed" as const,
          },
        ],
      };
    });

    await runtime.run({
      parentTask: makeTask(),
      explicit: true,
      verificationEvidenceBundle: {
        entries: Array.from({ length: 50 }, (_, index) => ({
          kind: "file_exists" as const,
          ok: true,
          detail: `generic ${index + 1}`,
          capturedAt: index,
        })),
      },
      requirementEvidenceManifest: {
        contractId: "contract-1",
        contractVersion: 2,
        capturedAt: 30_000,
        requirements,
      },
    });

    const prompt = runReadOnlyChildTaskAndWait.mock.calls[0]?.[0]?.prompt || "";
    expect(prompt).toContain("Selected proof 41");
    expect(prompt).toContain("requirement-41");
    expect(prompt).toContain("evidence-1205");
    expect(prompt).toContain("validatedAt");
    expect(prompt).toContain('"omittedCount": 30');
    expect(prompt).toContain("does not establish file contents");
    expect(prompt).toContain("generic 20");
    expect(prompt).not.toContain("generic 50");
  });

  it("bounds large prompts, summaries, and manifest text so verification still runs with every requirement", async () => {
    const runReadOnlyChildTaskAndWait = vi.fn().mockResolvedValue({
      childTaskId: "child-large",
      status: "completed" as const,
      summary: "VERDICT: PASS",
    });
    const runtime = new VerificationRuntime({ runReadOnlyChildTaskAndWait });
    const requirements = Array.from({ length: 60 }, (_, index) => ({
      requirementId: `large-requirement-${index}`,
      description: `Check ${"d".repeat(3_000)}`,
      targetPath: `/workspace/large-output-${index}.txt`,
      verifier: "file_exists",
      required: true,
      status: "pending" as const,
      evidence: [],
    }));

    const result = await runtime.run({
      parentTask: makeTask({ rawPrompt: "p".repeat(40_000) } as Partial<Task>),
      explicit: true,
      parentSummary: "s".repeat(40_000),
      outputSummary: {
        created: Array.from({ length: 2_000 }, (_, index) => `/workspace/generated-${index}.txt`),
        outputCount: 2_000,
      } as never,
      requirementEvidenceManifest: {
        contractId: "large-contract",
        contractVersion: 1,
        capturedAt: 10,
        requirements,
      },
    });

    expect(runReadOnlyChildTaskAndWait).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ran: true, verdict: "PASS", shouldBlock: false });
    const prompt = runReadOnlyChildTaskAndWait.mock.calls[0]?.[0]?.prompt || "";
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(prompt).toContain("[truncated:");
    for (const requirement of requirements) {
      expect(prompt).toContain(requirement.requirementId);
      expect(prompt).toContain(requirement.targetPath);
    }
  });

  it("blocks an oversized selected manifest before starting a verifier without dropping requirements", async () => {
    const runReadOnlyChildTaskAndWait = vi.fn().mockResolvedValue({
      childTaskId: "unexpected-child",
      status: "completed" as const,
      summary: "VERDICT: PASS",
    });
    const runtime = new VerificationRuntime({ runReadOnlyChildTaskAndWait });
    const requirements = Array.from({ length: 100 }, (_, index) => ({
      requirementId: `required-${index}`,
      description: `File exists: ${"x".repeat(4_000)}`,
      targetPath: "x".repeat(4_000),
      verifier: "file_exists",
      required: true,
      status: "pending" as const,
      evidence: [],
    }));

    const result = await runtime.run({
      parentTask: makeTask({ title: "Review text", prompt: "Check the result" }),
      explicit: true,
      requirementEvidenceManifest: {
        contractId: "oversized-contract",
        contractVersion: 1,
        capturedAt: 10,
        requirements,
      },
    });

    expect(runReadOnlyChildTaskAndWait).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      gated: true,
      ran: false,
      status: "skipped",
      verdict: "PARTIAL",
      shouldBlock: true,
    });
    expect(result.report).toContain("input limit");
    expect(requirements).toHaveLength(100);
    expect(requirements[99].targetPath).toHaveLength(4_000);
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
    "does not certify a stale PASS summary from a %s verifier",
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
      expect(result.verdict).toBe("PARTIAL");
      expect(result.incomplete).toBe(true);
      expect(result.shouldBlock).toBe(false);
      expect(result.report).toMatch(/^Independent verification did not complete/);
    },
  );

  it.each(["timeout", "cancelled", "missing"] as const)(
    "reports a %s verifier without output as incomplete instead of failing the task",
    async (status) => {
      const runtime = new VerificationRuntime({
        runReadOnlyChildTaskAndWait: vi.fn().mockResolvedValue({
          childTaskId: "child-unfinished",
          status,
          summary: "",
        }),
      });
      const result = await runtime.run({
        parentTask: makeTask(),
        explicit: true,
        timeoutMs: 120_000,
      });
      expect(result).toMatchObject({
        gated: true,
        ran: true,
        status,
        verdict: "PARTIAL",
        incomplete: true,
        shouldBlock: false,
      });
      expect(result.report).toContain("unverified");
    },
  );

  it("keeps a timed-out verifier non-blocking for high-risk tasks", async () => {
    const runtime = new VerificationRuntime({
      runReadOnlyChildTaskAndWait: vi.fn().mockResolvedValue({
        childTaskId: "child-timeout-risk",
        status: "timeout",
        summary: "",
      }),
    });
    const result = await runtime.run({
      parentTask: makeTask({ title: "Build an API", prompt: "Add backend API changes" }),
      explicit: true,
      highRisk: true,
    });
    expect(result.verdict).toBe("PARTIAL");
    expect(result.shouldBlock).toBe(false);
    expect(result.report).toContain("timed out");
  });

  it("treats a completed verifier that returned no report as incomplete", async () => {
    const runtime = new VerificationRuntime({
      runReadOnlyChildTaskAndWait: vi.fn().mockResolvedValue({
        childTaskId: "child-empty",
        status: "completed",
        summary: "   ",
      }),
    });
    const result = await runtime.run({ parentTask: makeTask(), explicit: true });
    expect(result.verdict).toBe("PARTIAL");
    expect(result.incomplete).toBe(true);
    expect(result.shouldBlock).toBe(false);
  });

  it.each(["timeout", "failed"] as const)(
    "still blocks when a %s verifier had already reported VERDICT: FAIL",
    async (status) => {
      const runtime = new VerificationRuntime({
        runReadOnlyChildTaskAndWait: vi.fn().mockResolvedValue({
          childTaskId: "child-found-failure",
          status,
          summary: "VERDICT: FAIL\nThe migration is missing its down step",
        }),
      });
      const result = await runtime.run({ parentTask: makeTask(), explicit: true });
      expect(result.verdict).toBe("FAIL");
      expect(result.incomplete).not.toBe(true);
      expect(result.shouldBlock).toBe(true);
      expect(result.report).toContain("missing its down step");
    },
  );

  it("still blocks a completed verifier whose report is malformed", async () => {
    const runtime = new VerificationRuntime({
      runReadOnlyChildTaskAndWait: vi.fn().mockResolvedValue({
        childTaskId: "child-malformed",
        status: "completed",
        summary: "Looks mostly fine, PASSING overall",
      }),
    });
    const result = await runtime.run({ parentTask: makeTask(), explicit: true });
    expect(result.verdict).toBe("FAIL");
    expect(result.shouldBlock).toBe(true);
  });

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
    "does not certify a completed child whose terminal outcome is %s",
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
      expect(result.verdict).toBe("PARTIAL");
      expect(result.incomplete).toBe(true);
      expect(result.shouldBlock).toBe(false);
      expect(result.report).toContain(terminalStatus);
    },
  );
});
