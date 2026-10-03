import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MemoryHubItem } from "../../../../shared/memory-hub-types";
import type {
  MemoryCurationChange,
  MemoryReviewProposal,
  MemoryReviewState,
} from "../../../../shared/memory-review-types";
import { MemoryReviewView, type MemoryReviewViewProps } from "../MemoryReviewTab";
import {
  acceptProposal,
  changeLine,
  proposalItemRole,
  rejectProposal,
  runCurationNow,
  setLlmSynthesis,
  undoChange,
  type MemoryReviewApi,
} from "../memory-review-model";

const WS = "ws-1";

function item(overrides: Partial<MemoryHubItem>): MemoryHubItem {
  return {
    id: "item",
    workspaceId: WS,
    scope: "workspace",
    scopeRef: null,
    kind: "preference",
    subjectKey: "preference:0000000000000000",
    content: "Prefers concise answers",
    source: "inferred",
    trust: 0.5,
    confidence: 0.7,
    status: "active",
    pinned: false,
    private: false,
    reinforcedCount: 0,
    lastUsedAt: null,
    supersedesId: null,
    taskId: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const CONFLICT: MemoryReviewProposal = {
  id: "cand-1",
  runId: "run-1",
  op: "resolve_conflict",
  title: "Resolve conflicting preferences",
  rationale: "These say opposite things about the same topic.",
  reviewReason: "It changes something you said or confirmed.",
  confidence: 0.7,
  origin: "heuristic",
  items: [
    item({ id: "keep", content: "Prefers concise answers", source: "user_stated" }),
    item({ id: "drop", content: "Prefers detailed answers" }),
  ],
  keepId: "keep",
  proposedContent: null,
  proposedKind: null,
  evidence: [],
  createdAt: 1,
};

const PROMOTION: MemoryReviewProposal = {
  ...CONFLICT,
  id: "cand-2",
  op: "promote",
  title: "Remember a recurring fact",
  rationale: "Came up in 2 separate tasks.",
  reviewReason: "Suggested by AI synthesis; nothing changes until you accept it.",
  origin: "llm",
  items: [],
  keepId: null,
  proposedContent: "Never deploy on Fridays",
  proposedKind: "rule",
  evidence: [
    {
      kind: "archive",
      ref: "archive:m1",
      snippet: "Deploy on Friday broke prod",
      at: Date.now() - 3600_000,
      taskId: "t1",
    },
  ],
};

const MERGED: MemoryCurationChange = {
  id: "log-1",
  op: "merge",
  origin: "auto",
  summary: "Merged 2 near-duplicate items",
  rationale: "Same kind and scope.",
  items: [
    { id: "a", kind: "preference", content: "Prefers tabs", before: "active", after: "active" },
    {
      id: "b",
      kind: "preference",
      content: "prefers tabs!",
      before: "active",
      after: "superseded",
    },
  ],
  appliedAt: Date.now() - 60_000,
  undoneAt: null,
  canUndo: true,
};

function state(overrides: Partial<MemoryReviewState> = {}): MemoryReviewState {
  return {
    pending: [CONFLICT, PROMOTION],
    recent: [MERGED, { ...MERGED, id: "log-2", canUndo: false }],
    pendingCount: 2,
    lastRun: {
      id: "run-1",
      status: "completed",
      startedAt: Date.now() - 120_000,
      completedAt: Date.now() - 119_000,
      applied: 1,
      queued: 2,
      llmTokens: 0,
      summary: null,
    },
    llm: { enabled: true, dailyTokenBudget: 20000, tokensUsedToday: 1200 },
    ...overrides,
  };
}

function viewProps(overrides: Partial<MemoryReviewViewProps> = {}): MemoryReviewViewProps {
  const noop = () => {};
  return {
    state: state(),
    loading: false,
    error: null,
    notice: null,
    busyId: null,
    canWrite: true,
    onAccept: noop,
    onReject: noop,
    onUndo: noop,
    onRunNow: noop,
    onToggleLlm: noop,
    onDismissMessage: noop,
    ...overrides,
  };
}

function mockApi(overrides: Partial<Record<keyof MemoryReviewApi, unknown>> = {}) {
  return {
    getMemoryReview: vi.fn(async () => state({ pending: [], pendingCount: 0 })),
    getMemoryReviewCount: vi.fn(async () => 0),
    acceptMemoryProposal: vi.fn(async () => ({ success: true, message: "Applied." })),
    rejectMemoryProposal: vi.fn(async () => ({ success: true })),
    undoMemoryChange: vi.fn(async () => ({ success: true })),
    runMemoryCuration: vi.fn(async () => ({
      success: true,
      status: "completed",
      applied: 2,
      queued: 1,
    })),
    setMemoryCurationLlmEnabled: vi.fn(async () => ({ success: true })),
    ...overrides,
  } as unknown as MemoryReviewApi & Record<string, ReturnType<typeof vi.fn>>;
}

describe("MemoryReviewView", () => {
  it("lists pending proposals with their items, why, review reason and evidence", () => {
    const html = renderToStaticMarkup(<MemoryReviewView {...viewProps()} />);
    expect(html).toContain("Waiting for review");
    expect(html).toContain('data-proposal-id="cand-1"');
    expect(html).toContain("Resolve conflicting preferences");
    expect(html).toContain("Prefers detailed answers");
    expect(html).toContain("Retire");
    expect(html).toContain("Needs your review:");
    expect(html).toContain("It changes something you said or confirmed.");
    expect(html).toContain("Never deploy on Fridays");
    expect(html).toContain("AI suggestion");
    expect(html).toContain("Evidence (1)");
    expect(html).toContain("Deploy on Friday broke prod");
    expect((html.match(/>Accept</g) ?? []).length).toBe(2);
    expect((html.match(/>Reject</g) ?? []).length).toBe(2);
  });

  it("shows recent automatic changes with Undo only when it is still possible", () => {
    const html = renderToStaticMarkup(<MemoryReviewView {...viewProps()} />);
    expect(html).toContain("Recent automatic changes");
    expect(html).toContain("Merged 2 near-duplicate items");
    expect(html).toContain("active → merged away");
    expect((html.match(/>Undo</g) ?? []).length).toBe(1);
    expect(html).toContain("Changed since; cannot be undone");
  });

  it("shows budget usage, last run and empty states", () => {
    const html = renderToStaticMarkup(
      <MemoryReviewView
        {...viewProps({
          state: state({ pending: [], recent: [], pendingCount: 0 }),
        })}
      />,
    );
    expect(html).toContain("Nothing to review.");
    expect(html).toContain("No changes yet.");
    expect(html).toContain("1,200 / 20,000 tokens today");
    expect(html).toContain("1 applied, 2 queued");
  });

  it("disables actions without write access", () => {
    const html = renderToStaticMarkup(<MemoryReviewView {...viewProps({ canWrite: false })} />);
    expect(html).not.toMatch(/<button[^>]*(?<!disabled="")>Accept</);
    expect(html.match(/disabled=""/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
  });
});

describe("memory review model", () => {
  it("labels what happens to each item", () => {
    expect(proposalItemRole(CONFLICT, { id: "keep" })).toBe("keep");
    expect(proposalItemRole(CONFLICT, { id: "drop" })).toBe("drop");
    expect(proposalItemRole({ op: "merge", keepId: "a" }, { id: "b" })).toBe("merge");
    expect(proposalItemRole({ op: "decay", keepId: null }, { id: "b" })).toBe("archive");
    expect(changeLine({ id: "x", kind: "rule", content: "", before: null, after: "active" })).toBe(
      "new → active",
    );
  });

  it("accepts, rejects and undoes through the API and reloads the state", async () => {
    const api = mockApi();
    expect(await acceptProposal(api, WS, "cand-1")).toMatchObject({ notice: "Applied." });
    expect(api.acceptMemoryProposal).toHaveBeenCalledWith({ workspaceId: WS, id: "cand-1" });
    await rejectProposal(api, WS, "cand-2");
    expect(api.rejectMemoryProposal).toHaveBeenCalledWith({ workspaceId: WS, id: "cand-2" });
    await undoChange(api, WS, "log-1");
    expect(api.undoMemoryChange).toHaveBeenCalledWith({ workspaceId: WS, id: "log-1" });
    expect(api.getMemoryReview).toHaveBeenCalledTimes(3);
  });

  it("reports refusals and failures", async () => {
    const refused = mockApi({
      undoMemoryChange: vi.fn(async () => ({
        success: false,
        error: "These memories changed since; undo is no longer possible.",
      })),
    });
    expect(await undoChange(refused, WS, "log-1")).toMatchObject({
      error: "These memories changed since; undo is no longer possible.",
    });
    const failing = mockApi({
      acceptMemoryProposal: vi.fn(async () => {
        throw new Error("Proposal not found.");
      }),
    });
    expect(await acceptProposal(failing, WS, "x")).toEqual({
      state: null,
      error: "Proposal not found.",
    });
  });

  it("runs Dreaming and toggles AI synthesis", async () => {
    const api = mockApi();
    expect(await runCurationNow(api, WS)).toMatchObject({
      notice: "Dreaming applied 2 change(s) and queued 1 for review.",
    });
    const busy = mockApi({
      runMemoryCuration: vi.fn(async () => ({
        success: true,
        status: "completed",
        applied: 0,
        queued: 0,
        skipped: "in_flight",
      })),
    });
    expect((await runCurationNow(busy, WS)).notice).toMatch(/already running/);
    expect(await setLlmSynthesis(api, WS, true)).toMatchObject({ notice: "AI synthesis is on." });
    expect(api.setMemoryCurationLlmEnabled).toHaveBeenCalledWith({
      workspaceId: WS,
      enabled: true,
    });
  });
});
