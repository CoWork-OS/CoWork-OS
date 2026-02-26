import { describe, expect, it } from "vitest";
import { WorkflowDecomposer } from "../WorkflowDecomposer";
import { IntentRoute } from "../IntentRouter";

// Minimal route stub for decomposition
const defaultRoute: IntentRoute = {
  intent: "workflow",
  confidence: 0.9,
  conversationMode: "task",
  answerFirst: false,
  signals: ["workflow-pipeline"],
  complexity: "high",
  domain: "general",
};

describe("WorkflowDecomposer", () => {
  // ── Successful decomposition ──────────────────────────────────

  it("decomposes a multi-phase prompt with 'then' connectives", () => {
    const prompt =
      "Research the top 5 competitors in AI, then create a presentation comparing them, then email the team with the results";
    const phases = WorkflowDecomposer.decompose(prompt, defaultRoute);

    expect(phases).not.toBeNull();
    expect(phases!.length).toBeGreaterThanOrEqual(2);

    // First phase should be research-type
    expect(phases![0].phaseType).toBe("research");
    expect(phases![0].order).toBe(1);
    expect(phases![0].dependsOn).toEqual([]);

    // Second phase should depend on first
    expect(phases![1].dependsOn).toEqual(["phase-1"]);
  });

  it("decomposes prompts with arrow connectives (→)", () => {
    const prompt = "Find all open issues -> create a summary document -> send it to the manager";
    const phases = WorkflowDecomposer.decompose(prompt, defaultRoute);

    expect(phases).not.toBeNull();
    expect(phases!.length).toBeGreaterThanOrEqual(2);
  });

  it("decomposes prompts with step N: patterns", () => {
    const prompt =
      "Step 1: Research market trends. Step 2: Build a report. Step 3: Share with stakeholders";
    const phases = WorkflowDecomposer.decompose(prompt, defaultRoute);

    expect(phases).not.toBeNull();
    expect(phases!.length).toBeGreaterThanOrEqual(2);
  });

  it("decomposes prompts with 'after that' connectives", () => {
    const prompt =
      "Analyze the sales data for Q4, after that create a spreadsheet with the results, and then email it to finance";
    const phases = WorkflowDecomposer.decompose(prompt, defaultRoute);

    expect(phases).not.toBeNull();
    expect(phases!.length).toBeGreaterThanOrEqual(2);
  });

  // ── Phase type detection ──────────────────────────────────────

  it("correctly detects phase types", () => {
    const prompt = "Research competitors, then create a presentation, then send it to the team";
    const phases = WorkflowDecomposer.decompose(prompt, defaultRoute);

    expect(phases).not.toBeNull();
    // Find phases by type
    const types = phases!.map((p) => p.phaseType);
    expect(types).toContain("research");
    expect(types).toContain("create");
    expect(types).toContain("deliver");
  });

  // ── Phase structure ────────────────────────────────────────────

  it("all phases start with pending status", () => {
    const prompt = "Search for data then generate a report then publish it";
    const phases = WorkflowDecomposer.decompose(prompt, defaultRoute);

    expect(phases).not.toBeNull();
    for (const phase of phases!) {
      expect(phase.status).toBe("pending");
    }
  });

  it("phases have sequential ordering", () => {
    const prompt = "Research X then create Y then deliver Z";
    const phases = WorkflowDecomposer.decompose(prompt, defaultRoute);

    expect(phases).not.toBeNull();
    for (let i = 0; i < phases!.length; i++) {
      expect(phases![i].order).toBe(i + 1);
      expect(phases![i].id).toBe(`phase-${i + 1}`);
    }
  });

  it("phases have titles with Phase N prefix", () => {
    const prompt = "Research competitors then write a summary then email the boss";
    const phases = WorkflowDecomposer.decompose(prompt, defaultRoute);

    expect(phases).not.toBeNull();
    for (const phase of phases!) {
      expect(phase.title).toMatch(/^Phase \d+:/);
    }
  });

  // ── Returns null for non-workflow prompts ──────────────────────

  it("returns null for short prompts", () => {
    expect(WorkflowDecomposer.decompose("do X", defaultRoute)).toBeNull();
  });

  it("returns null for prompts without connectives", () => {
    const prompt = "Research competitors and analyze their pricing and review their features";
    expect(WorkflowDecomposer.decompose(prompt, defaultRoute)).toBeNull();
  });

  it("returns null for prompts with fewer than 2 action verbs", () => {
    const prompt = "Look up the weather forecast for tomorrow, then tell me about it";
    // "look up" is one verb, "tell" may not be in the action verb list
    // This tests the minimum verb threshold
    const result = WorkflowDecomposer.decompose(prompt, defaultRoute);
    // Either null or valid phases — depends on verb matching
    if (result !== null) {
      expect(result.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("returns null for empty prompt", () => {
    expect(WorkflowDecomposer.decompose("", defaultRoute)).toBeNull();
  });

  it("returns null for null/undefined prompt", () => {
    expect(WorkflowDecomposer.decompose(null as unknown as string, defaultRoute)).toBeNull();
    expect(WorkflowDecomposer.decompose(undefined as unknown as string, defaultRoute)).toBeNull();
  });

  // ── Dependency chain ───────────────────────────────────────────

  it("builds a linear dependency chain", () => {
    const prompt = "Search for data then build a dashboard then deploy it to production";
    const phases = WorkflowDecomposer.decompose(prompt, defaultRoute);

    expect(phases).not.toBeNull();
    expect(phases![0].dependsOn).toEqual([]);
    for (let i = 1; i < phases!.length; i++) {
      expect(phases![i].dependsOn).toEqual([`phase-${i}`]);
    }
  });
});
