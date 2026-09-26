import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: vi.fn().mockReturnValue("/tmp/test-cowork") } }));
vi.mock("../MemoryObservationService", () => ({
  MemoryObservationService: { isPromptSuppressed: () => false, initialize: vi.fn() },
}));

import { MemoryService } from "../MemoryService";

// Legacy generated Playbook rows (including false "confirmed successful again" claims)
// must not re-enter prompts through generic recall paths.
const rows = [
  {
    id: "p1",
    content: '[PLAYBOOK] Reinforced pattern: "x"\nThis approach was confirmed successful again.',
  },
  { id: "p2", content: '[PLAYBOOK] Task failed: "Reconcile invoices"' },
  { id: "p3", content: '[PLAYBOOK] Task succeeded: "Reconcile invoices"' },
  { id: "p4", content: '[PLAYBOOK] Inbox pattern: "Newsletter"' },
  { id: "u1", content: "User note: the team playbook for invoices lives in Finance/Q3" },
  { id: "u2", content: "Decided to reconcile invoices monthly" },
].map((row) => ({
  ...row,
  type: "insight",
  snippet: row.content,
  createdAt: 1,
  relevanceScore: 1,
}));

const service = MemoryService as unknown as Record<string, unknown>;
const saved = { initialized: service.initialized, memoryRepo: service.memoryRepo };

afterEach(() => {
  service.initialized = saved.initialized;
  service.memoryRepo = saved.memoryRepo;
  MemoryService.clearPromptRecallCache();
});

function install() {
  service.initialized = true;
  service.memoryRepo = {
    getRecentForWorkspace: () => rows,
    searchLocalForPromptRecall: () => rows,
    getFullDetails: (ids: string[]) => rows.filter((row) => ids.includes(row.id)),
  };
}

describe("MemoryService generic recall excludes generated Playbook rows", () => {
  it("recent recall", () => {
    install();
    expect(MemoryService.getRecentForPromptRecall("ws").map((row) => row.id)).toEqual(["u1", "u2"]);
  });

  it("fast search recall", () => {
    install();
    expect(
      MemoryService.searchForPromptRecallFast("ws", "reconcile invoices", 10).map((row) => row.id),
    ).toEqual(["u1", "u2"]);
  });
});
