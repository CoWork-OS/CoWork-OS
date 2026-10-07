import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  MemoryCurationChange,
  MemoryReviewState,
} from "../../../../shared/memory-review-types";
import { MemoryReviewView, type MemoryReviewViewProps } from "../MemoryReviewTab";
import {
  MEMORY_REVIEW_METHODS,
  changeLine,
  undoChange,
  type MemoryReviewApi,
} from "../memory-review-model";

const WS = "ws-1";

const EXPIRED: MemoryCurationChange = {
  id: "log-1",
  op: "expire_commitment",
  origin: "auto",
  summary: "Closed a commitment that was done",
  rationale: 'Past due for 3 day(s), and later activity says it was done: "report sent"',
  items: [
    {
      id: "c1",
      kind: "commitment",
      content: "Send the quarterly report to finance",
      before: "active",
      after: "archived",
    },
  ],
  appliedAt: Date.now() - 60_000,
  undoneAt: null,
  canUndo: true,
};

function state(overrides: Partial<MemoryReviewState> = {}): MemoryReviewState {
  return {
    recent: [EXPIRED, { ...EXPIRED, id: "log-2", canUndo: false }],
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
    onUndo: noop,
    onDismissMessage: noop,
    ...overrides,
  };
}

function mockApi(overrides: Partial<Record<keyof MemoryReviewApi, unknown>> = {}) {
  return {
    getMemoryReview: vi.fn(async () => state({ recent: [] })),
    undoMemoryChange: vi.fn(async () => ({ success: true })),
    ...overrides,
  } as unknown as MemoryReviewApi & Record<string, ReturnType<typeof vi.fn>>;
}

describe("MemoryReviewView", () => {
  it("lists closed commitments with Undo only when it is still possible", () => {
    const html = renderToStaticMarkup(<MemoryReviewView {...viewProps()} />);
    expect(html).toContain("Closed commitments");
    expect(html).toContain("Send the quarterly report to finance");
    expect(html).toContain("open → closed");
    expect(html).toContain("report sent");
    expect((html.match(/>Undo</g) ?? []).length).toBe(1);
    expect(html).toContain("Changed since; cannot be undone");
  });

  it("has no proposals, AI synthesis or manual run", () => {
    const html = renderToStaticMarkup(<MemoryReviewView {...viewProps()} />);
    expect(html).not.toMatch(/Run Dreaming now|AI synthesis|Waiting for review|>Accept</);
  });

  it("shows the empty state and disables Undo without write access", () => {
    expect(
      renderToStaticMarkup(<MemoryReviewView {...viewProps({ state: state({ recent: [] }) })} />),
    ).toContain("No commitments were closed automatically.");
    const html = renderToStaticMarkup(<MemoryReviewView {...viewProps({ canWrite: false })} />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Undo</);
  });
});

describe("memory review model", () => {
  it("needs only the read and undo host methods", () => {
    expect([...MEMORY_REVIEW_METHODS]).toEqual(["getMemoryReview", "undoMemoryChange"]);
    expect(
      changeLine({ id: "x", kind: "commitment", content: "", before: null, after: "active" }),
    ).toBe("new → open");
  });

  it("undoes through the API and reloads the state", async () => {
    const api = mockApi();
    expect(await undoChange(api, WS, "log-1")).toMatchObject({ notice: "Undone." });
    expect(api.undoMemoryChange).toHaveBeenCalledWith({ workspaceId: WS, id: "log-1" });
    expect(api.getMemoryReview).toHaveBeenCalledTimes(1);
  });

  it("reports refusals and failures", async () => {
    const refused = mockApi({
      undoMemoryChange: vi.fn(async () => ({
        success: false,
        error: "This commitment changed since; undo is no longer possible.",
      })),
    });
    expect(await undoChange(refused, WS, "log-1")).toMatchObject({
      error: "This commitment changed since; undo is no longer possible.",
    });
    const failing = mockApi({
      undoMemoryChange: vi.fn(async () => {
        throw new Error("Change not found.");
      }),
    });
    expect(await undoChange(failing, WS, "x")).toEqual({
      state: null,
      error: "Change not found.",
    });
  });
});
