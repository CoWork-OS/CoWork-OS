import { describe, expect, it, vi } from "vitest";
import {
  CommitmentExpiryService,
  MAX_CONVERSATION_LOOKUPS,
  archiveDoneSignals,
  conversationDoneSignals,
  isExpiryCandidate,
} from "../CommitmentExpiryService";
import type { MemoryWriter } from "../MemoryWriter";
import type { ConversationHit } from "../conversation-index-sql";
import type { ArchiveEvidenceRow } from "../memory-curation-sql";
import { MEMORY_ITEM_TRUST, type MemoryItem } from "../memory-items-types";

// The pure checks and the sweep's control flow, with fakes (memory-curation.test.ts runs
// the sweep over SQLite).

const DAY = 24 * 60 * 60 * 1000;
const NOW = 400 * DAY;

let counter = 0;
function commitment(overrides: Partial<MemoryItem> = {}): MemoryItem {
  counter += 1;
  const source = overrides.source ?? "inferred";
  return {
    id: `c-${counter}`,
    workspaceId: "ws-1",
    scope: "workspace",
    scopeRef: null,
    kind: "commitment",
    subjectKey: `commitment:${String(counter).padStart(16, "0")}`,
    content: "Send the quarterly report to finance",
    source,
    sourceRef: { dueAt: NOW - 5 * DAY },
    trust: MEMORY_ITEM_TRUST[source],
    confidence: 0.8,
    status: "active",
    pinned: false,
    reinforcedCount: 0,
    lastUsedAt: null,
    supersedesId: null,
    contentHash: `hash-${counter}`,
    privacy: "normal",
    taskId: null,
    expiresAt: null,
    createdAt: NOW - 10 * DAY,
    updatedAt: NOW - 10 * DAY,
    ...overrides,
  };
}

function archiveRow(overrides: Partial<ArchiveEvidenceRow> = {}): ArchiveEvidenceRow {
  return {
    id: "m1",
    taskId: "t1",
    type: "decision",
    content: "Quarterly report sent to finance, task completed",
    createdAt: NOW - 4 * DAY,
    isPrivate: false,
    origin: "task",
    ...overrides,
  };
}

function hit(snippet: string, timestamp = NOW - DAY): ConversationHit {
  return {
    id: "dce_1",
    kind: "event",
    workspaceId: "ws-1",
    taskId: "t2",
    type: "assistant_message",
    role: "assistant",
    timestamp,
    snippet,
    eventId: "e1",
  };
}

describe("commitment expiry checks", () => {
  it("only considers active, past-due commitments the user did not state", () => {
    expect(isExpiryCandidate(commitment(), NOW)).toBe(true);
    expect(isExpiryCandidate(commitment({ source: "user_stated" }), NOW)).toBe(false);
    expect(isExpiryCandidate(commitment({ source: "user_confirmed" }), NOW)).toBe(false);
    expect(isExpiryCandidate(commitment({ sourceRef: {} }), NOW)).toBe(false);
    expect(isExpiryCandidate(commitment({ sourceRef: { dueAt: NOW - DAY / 2 } }), NOW)).toBe(
      false,
    );
    expect(isExpiryCandidate(commitment({ status: "archived" }), NOW)).toBe(false);
    expect(isExpiryCandidate(commitment({ scope: "contact", scopeRef: "c" }), NOW)).toBe(false);
    expect(isExpiryCandidate(commitment({ kind: "preference" }), NOW)).toBe(false);
  });

  it("needs a done word, shared words and a date after the due window", () => {
    const item = commitment();
    expect(archiveDoneSignals(item, [archiveRow()])).toEqual([
      expect.objectContaining({ kind: "archive", ref: "archive:m1", taskId: "t1" }),
    ]);
    expect(archiveDoneSignals(item, [archiveRow({ content: "Quarterly report to finance" })])).toEqual(
      [],
    );
    expect(archiveDoneSignals(item, [archiveRow({ content: "Dinner done" })])).toEqual([]);
    expect(archiveDoneSignals(item, [archiveRow({ createdAt: NOW - 30 * DAY })])).toEqual([]);
    expect(conversationDoneSignals(item, [hit("The quarterly report was sent")])).toEqual([
      expect.objectContaining({ kind: "conversation", ref: "event:e1" }),
    ]);
    expect(conversationDoneSignals(item, [hit("Started the quarterly report")])).toEqual([]);
  });
});

describe("CommitmentExpiryService", () => {
  function setup(items: MemoryItem[], options: { hits?: ConversationHit[] } = {}) {
    const applyCuration = vi.fn(async (input: { operation: { itemIds: string[] } }) => ({
      status: "applied" as const,
      log: { id: `log-${input.operation.itemIds[0]}` },
      changedIds: input.operation.itemIds,
    }));
    const list = vi.fn(async () => items);
    const writer = {
      supportsCuration: true,
      applyCuration,
      repository: { list, isLaneMigrationComplete: async () => true },
    } as unknown as MemoryWriter;
    const search = vi.fn(async () => options.hits ?? []);
    const service = new CommitmentExpiryService({
      now: () => NOW,
      getWriter: () => writer,
      curation: {
        archiveEvidence: vi.fn(async () => []),
        undoneFingerprints: vi.fn(async () => []),
      },
      searchConversation: search,
      listWorkspaceIds: () => ["ws-1"],
    });
    return { service, applyCuration, list, search };
  }

  it("applies expiries as automatic, unprotected expire_commitment operations", async () => {
    const item = commitment();
    const { service, applyCuration } = setup([item], {
      hits: [hit("The quarterly report was sent")],
    });
    expect(await service.sweep()).toEqual({
      checked: 1,
      expired: 1,
      logIds: [`log-${item.id}`],
      refused: {},
    });
    expect(applyCuration).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        origin: "auto",
        allowProtected: false,
        fingerprint: `expire_commitment:${item.id}`,
        operation: { op: "expire_commitment", itemIds: [item.id] },
      }),
    );
  });

  it("bounds conversation lookups per sweep and rotates through the rest", async () => {
    const items = Array.from({ length: MAX_CONVERSATION_LOOKUPS + 5 }, (_, index) =>
      commitment({ content: `Send report number${index} to finance` }),
    );
    let now = NOW;
    const { search, applyCuration } = setup(items);
    const service = new CommitmentExpiryService({
      now: () => now,
      getWriter: () =>
        ({
          supportsCuration: true,
          applyCuration,
          repository: { list: async () => items, isLaneMigrationComplete: async () => true },
        }) as unknown as MemoryWriter,
      curation: { archiveEvidence: async () => [], undoneFingerprints: async () => [] },
      searchConversation: search,
    });
    await service.sweep();
    expect(search).toHaveBeenCalledTimes(MAX_CONVERSATION_LOOKUPS);
    const first = new Set(search.mock.calls.map((call) => JSON.stringify(call)));
    now += DAY;
    await service.sweep();
    const second = search.mock.calls.slice(MAX_CONVERSATION_LOOKUPS).map((call) => JSON.stringify(call));
    // The five commitments not searched last time come first.
    expect(second.slice(0, 5).every((call) => !first.has(call))).toBe(true);
    expect(applyCuration).not.toHaveBeenCalled();
  });
});
