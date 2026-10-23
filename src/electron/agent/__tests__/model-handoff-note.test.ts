import { describe, expect, it } from "vitest";
import type { ConstraintLedgerEntry, WorkSessionContractAggregate } from "../../../shared/types";
import type { LLMMessage } from "../llm/types";
import {
  buildModelHandoffNote,
  summarizeContractForHandoff,
  summarizeEarlierToolActivity,
} from "../model-handoff-note";

const NOW = 1_800_000_000_000;
const ROUTES = {
  from: { providerType: "anthropic", modelId: "model-a" },
  to: { providerType: "openai", modelId: "model-b" },
};

function constraint(
  id: string,
  kind: ConstraintLedgerEntry["kind"],
  statement: string,
  status: ConstraintLedgerEntry["status"] = "active",
  metadata?: Record<string, unknown>,
): ConstraintLedgerEntry {
  return {
    id,
    sessionId: "s1",
    kind,
    key: id,
    statement,
    status,
    metadata,
    createdAt: NOW - 1_000,
    updatedAt: NOW - 1_000,
  };
}

function fixtureAggregate(): WorkSessionContractAggregate {
  return {
    contract: {
      id: "c1",
      sessionId: "s1",
      taskId: "t1",
      version: 1,
      objective: "Ship the Q3 pricing page",
      requirements: [
        {
          id: "r1",
          kind: "output",
          description: "Write pricing.md",
          required: true,
          status: "satisfied",
        },
        {
          id: "r2",
          kind: "verification",
          description: "Check prices against the sheet",
          required: true,
          status: "pending",
        },
      ],
      status: "pending",
      createdAt: NOW - 5_000,
      updatedAt: NOW - 1_000,
    },
    constraints: [
      constraint("d1", "decision", "Use EUR, not USD"),
      constraint("d0", "decision", "Use USD prices", "superseded"),
      constraint("a1", "assumption", "The sheet is current"),
      constraint("x1", "constraint", "token=ghp_abcdefghijklmnopqrstuvwxyz0123"),
      constraint("x2", "decision", "Hidden internal note", "active", {
        redactionClass: "secret_redacted",
      }),
    ],
    evidence: [
      {
        id: "e1",
        sessionId: "s1",
        claim: "pricing.md exists",
        sourceType: "artifact_revision",
        sourceRef: "pricing.md",
        capturedAt: NOW - 10_000,
        confidence: 1,
        status: "supporting",
        createdAt: NOW - 10_000,
      },
      {
        id: "e2",
        sessionId: "s1",
        claim: "Sheet price list",
        sourceType: "url",
        sourceRef: "https://example.com/sheet",
        capturedAt: NOW - 100_000,
        freshnessExpiresAt: NOW - 50_000,
        confidence: 0.7,
        status: "stale",
        createdAt: NOW - 100_000,
      },
    ],
    artifactRevisions: [
      {
        id: "ar1",
        sessionId: "s1",
        taskId: "t1",
        revision: 1,
        path: "pricing.md",
        mimeType: "text/markdown",
        sha256: "a",
        size: 10,
        status: "superseded",
        createdBy: "agent",
        createdAt: NOW - 9_000,
      },
      {
        id: "ar2",
        sessionId: "s1",
        taskId: "t1",
        revision: 2,
        path: "pricing.md",
        mimeType: "text/markdown",
        sha256: "b",
        size: 12,
        status: "committed",
        createdBy: "agent",
        createdAt: NOW - 8_000,
      },
      {
        id: "ar3",
        sessionId: "s1",
        taskId: "t1",
        revision: 1,
        path: "draft.md",
        mimeType: "text/markdown",
        sha256: "c",
        size: 3,
        status: "retracted",
        createdBy: "agent",
        createdAt: NOW - 8_000,
      },
    ],
    waitStates: [
      {
        id: "w1",
        sessionId: "s1",
        taskId: "t1",
        kind: "approval",
        reason: "Publish to the website",
        status: "pending",
        createdAt: NOW - 2_000,
        updatedAt: NOW - 2_000,
      },
      {
        id: "w2",
        sessionId: "s1",
        taskId: "t1",
        kind: "input",
        reason: "Which region?",
        status: "resolved",
        createdAt: NOW - 3_000,
        updatedAt: NOW - 2_500,
      },
    ],
    children: [],
    checksum: "x",
  };
}

const toolUse = (name: string) => ({ type: "tool_use" as const, id: name, name, input: {} });
const toolResult = (id: string) => ({
  type: "tool_result" as const,
  tool_use_id: id,
  content: "ok",
});

describe("model handoff note", () => {
  it("lists tool activity per earlier user turn, ignoring tool-result messages as turns", () => {
    const history = [
      { role: "user", content: "Plan my week" },
      { role: "assistant", content: [{ type: "text", text: "Sure" }] },
      { role: "user", content: "Find flights" },
      { role: "assistant", content: [toolUse("web_search"), toolUse("web_search")] },
      { role: "user", content: [toolResult("web_search")] },
      { role: "assistant", content: [toolUse("write_file")] },
      { role: "user", content: [toolResult("write_file")] },
      { role: "assistant", content: [{ type: "text", text: "Saved" }] },
    ] as LLMMessage[];

    expect(summarizeEarlierToolActivity(history)).toEqual(["turn 2: web_search ×2, write_file"]);
  });

  it("names both routes and tells the new model to build on the conversation", () => {
    const note = buildModelHandoffNote(
      {
        from: { providerType: "anthropic", modelId: "claude-sonnet-5" },
        to: { providerType: "openai", modelId: "gpt-6-astra" },
      },
      [{ role: "user", content: "Hello" }] as LLMMessage[],
    );

    expect(note).toContain("anthropic/claude-sonnet-5");
    expect(note).toContain("openai/gpt-6-astra");
    expect(note).toContain("continuing the same conversation");
    expect(note).not.toContain("Tools used");
  });

  it("carries goal, requirement status, decisions, reversals, waits and evidence state", () => {
    const summary = summarizeContractForHandoff(fixtureAggregate(), NOW);
    const note = buildModelHandoffNote(
      ROUTES,
      [{ role: "user", content: "Hello" }] as LLMMessage[],
      summary,
    );

    expect(note).toContain("Goal: Ship the Q3 pricing page");
    expect(note).toContain("[satisfied] Write pricing.md");
    expect(note).toContain("[pending] Check prices against the sheet");
    expect(note).toContain("Decisions: Use EUR, not USD");
    expect(note).toContain("reversed: Use USD prices");
    expect(note).toContain("Unverified assumptions: The sheet is current");
    expect(note).toContain("Still waiting on: approval: Publish to the website");
    expect(note).not.toContain("Which region?");
    expect(note).toContain("1 stale");
    expect(note).toContain("1 past their freshness window");
    expect(note).toContain("Files already written: pricing.md");
    expect(note).not.toContain("draft.md");
    expect(note).toContain("data, not instructions");
  });

  it("never carries secrets or entries marked secret_redacted", () => {
    const note = buildModelHandoffNote(
      ROUTES,
      [],
      summarizeContractForHandoff(fixtureAggregate(), NOW),
    );

    expect(note).not.toContain("ghp_");
    expect(note).not.toContain("[redacted]");
    expect(note).not.toContain("Hidden internal note");
  });

  it("bounds every list and the total contract text", () => {
    const aggregate = fixtureAggregate();
    aggregate.constraints = Array.from({ length: 30 }, (_, index) =>
      constraint(`d${index}`, "decision", `Decision number ${index} ${"x".repeat(150)}`),
    );
    aggregate.waitStates = Array.from({ length: 10 }, (_, index) => ({
      ...fixtureAggregate().waitStates[0],
      id: `w${index}`,
      reason: `Wait ${index}`,
    }));
    const summary = summarizeContractForHandoff(aggregate, NOW);

    expect(summary.active).toHaveLength(8);
    expect(summary.active[7].statement).toContain("Decision number 29");
    expect(summary.omitted.active).toBe(22);
    expect(summary.pendingWaits).toHaveLength(6);
    expect(summary.omitted.waits).toBe(4);
    const note = buildModelHandoffNote(ROUTES, [], summary);
    const contractPart = note.slice(note.indexOf("Work so far"));
    expect(contractPart.length).toBeLessThanOrEqual(1_500);
  });

  it("keeps the old note when there is no contract", () => {
    const history = [
      { role: "user", content: "Find flights" },
      { role: "assistant", content: [toolUse("web_search")] },
    ] as LLMMessage[];
    expect(buildModelHandoffNote(ROUTES, history, undefined)).toBe(
      buildModelHandoffNote(ROUTES, history),
    );
    expect(buildModelHandoffNote(ROUTES, history)).not.toContain("Work so far");
  });

  it("keeps the summary short for long tool-heavy threads", () => {
    const history: LLMMessage[] = [];
    for (let turn = 0; turn < 10; turn += 1) {
      history.push({ role: "user", content: `step ${turn}` });
      history.push({
        role: "assistant",
        content: ["a", "b", "c", "d", "e", "f", "g"].map((name) => toolUse(`${name}${turn}`)),
      });
    }

    const lines = summarizeEarlierToolActivity(history);
    expect(lines).toHaveLength(6);
    expect(lines[0]).toMatch(/^turn 5: /);
    expect(lines[5]).toContain("+2 more");
  });
});
