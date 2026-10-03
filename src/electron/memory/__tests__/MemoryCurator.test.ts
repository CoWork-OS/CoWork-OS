import { describe, expect, it } from "vitest";
import {
  archiveFactText,
  contradicts,
  curateMemory,
  type CurationProposal,
} from "../MemoryCurator";
import type { ArchiveEvidenceRow } from "../memory-curation-sql";
import { MEMORY_ITEM_TRUST, type MemoryItem } from "../memory-items-types";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 400 * DAY;

let counter = 0;
function item(overrides: Partial<MemoryItem> = {}): MemoryItem {
  counter += 1;
  const source = overrides.source ?? "inferred";
  return {
    id: `item-${counter}`,
    workspaceId: "ws-1",
    scope: "workspace",
    scopeRef: null,
    kind: "preference",
    subjectKey: `preference:${String(counter).padStart(16, "0")}`,
    content: "Prefers short status updates in the morning",
    source,
    sourceRef: {},
    trust: MEMORY_ITEM_TRUST[source],
    confidence: 0.7,
    status: "active",
    pinned: false,
    reinforcedCount: 0,
    lastUsedAt: NOW - DAY,
    supersedesId: null,
    contentHash: `hash-${counter}`,
    privacy: "normal",
    taskId: null,
    expiresAt: null,
    createdAt: NOW - 2 * DAY,
    updatedAt: NOW - 2 * DAY,
    ...overrides,
  };
}

function archiveRow(overrides: Partial<ArchiveEvidenceRow> = {}): ArchiveEvidenceRow {
  counter += 1;
  return {
    id: `mem-${counter}`,
    taskId: `task-${counter}`,
    type: "insight",
    content: "Deploys must go through the staging pipeline before production release",
    createdAt: NOW - DAY,
    isPrivate: false,
    origin: "task",
    ...overrides,
  };
}

function byOp(proposals: CurationProposal[], op: string): CurationProposal[] {
  return proposals.filter((proposal) => proposal.operation.op === op);
}

describe("MemoryCurator", () => {
  describe("duplicates", () => {
    it("merges near-duplicates of the same trust automatically, keeping the strongest", () => {
      const strong = item({
        content: "Prefers short status updates every morning",
        reinforcedCount: 3,
      });
      const weak = item({ content: "prefers short status updates every morning!" });
      const [merge] = byOp(curateMemory({ now: NOW, items: [weak, strong], archive: [] }), "merge");
      expect(merge).toMatchObject({
        risk: "safe",
        reviewReason: null,
        operation: { op: "merge", keepId: strong.id, mergeIds: [weak.id] },
      });
    });

    it("sends merges that touch user-stated items to review", () => {
      const stated = item({
        source: "user_stated",
        content: "Prefers short status updates every morning",
      });
      const inferred = item({ content: "Prefers short status updates every single morning" });
      const [merge] = byOp(
        curateMemory({ now: NOW, items: [stated, inferred], archive: [] }),
        "merge",
      );
      expect(merge.risk).toBe("review");
      expect(merge.operation).toMatchObject({ keepId: stated.id });
      expect(merge.reviewReason).toMatch(/you said or confirmed/);
    });

    it("sends duplicates from sources of different trust to review", () => {
      const curated = item({
        source: "curated",
        content: "Release notes live in docs/releases folder",
      });
      const inferred = item({ content: "Release notes live in the docs/releases folder" });
      const [merge] = byOp(
        curateMemory({ now: NOW, items: [curated, inferred], archive: [] }),
        "merge",
      );
      expect(merge.risk).toBe("review");
      expect(merge.operation).toMatchObject({ keepId: curated.id });
    });

    it("proposes possible duplicates for review only", () => {
      const a = item({ content: "Weekly report goes to the finance team on Monday" });
      const b = item({ content: "Weekly report goes to the finance team on Friday" });
      const [merge] = byOp(curateMemory({ now: NOW, items: [a, b], archive: [] }), "merge");
      expect(merge.risk).toBe("review");
      expect(merge.reviewReason).toMatch(/alike/);
    });

    it("does not merge across kinds, scopes or named subjects", () => {
      const pref = item({ content: "Uses pnpm for package installs everywhere" });
      const fact = item({
        kind: "project_fact",
        content: "Uses pnpm for package installs everywhere",
      });
      const global = item({
        scope: "global",
        workspaceId: null,
        content: "Uses pnpm for package installs everywhere!",
      });
      const named = item({
        subjectKey: "response_style",
        content: "Uses pnpm for package installs everywhere.",
      });
      expect(
        byOp(curateMemory({ now: NOW, items: [pref, fact, global, named], archive: [] }), "merge"),
      ).toEqual([]);
    });
  });

  describe("contradictions", () => {
    it("detects opposite statements on the same topic", () => {
      expect(contradicts("Prefers concise answers", "Prefers detailed answers")).toBe(true);
      expect(
        contradicts("Run the tests before every commit", "Never run the tests before every commit"),
      ).toBe(true);
      expect(contradicts("Use pnpm for installs", "Do not use npm for installs")).toBe(false);
      expect(contradicts("Prefers concise answers", "Likes hiking on weekends")).toBe(false);
    });

    it("always queues a contradiction; equal trust suggests the newer item", () => {
      const older = item({ content: "Prefers concise answers", updatedAt: NOW - 10 * DAY });
      const newer = item({ content: "Prefers detailed answers", updatedAt: NOW - DAY });
      const [conflict] = byOp(
        curateMemory({ now: NOW, items: [older, newer], archive: [] }),
        "resolve_conflict",
      );
      expect(conflict).toMatchObject({
        risk: "review",
        operation: { keepId: newer.id, dropIds: [older.id] },
      });
      expect(conflict.reviewReason).toMatch(/equally trusted/);
    });

    it("suggests keeping the more trusted side of a contradiction", () => {
      const stated = item({
        source: "user_stated",
        content: "Prefers concise answers",
        updatedAt: NOW - 10 * DAY,
      });
      const inferred = item({ content: "Prefers detailed answers", updatedAt: NOW - DAY });
      const [conflict] = byOp(
        curateMemory({ now: NOW, items: [stated, inferred], archive: [] }),
        "resolve_conflict",
      );
      expect(conflict.operation).toMatchObject({ keepId: stated.id, dropIds: [inferred.id] });
      expect(conflict.risk).toBe("review");
    });
  });

  describe("decay", () => {
    const stale = {
      lastUsedAt: NOW - 400 * DAY,
      updatedAt: NOW - 400 * DAY,
      createdAt: NOW - 400 * DAY,
    };

    it("archives unused inferred items automatically", () => {
      const old = item({ ...stale, content: "Likes tabular weekly digests" });
      const [decay] = byOp(curateMemory({ now: NOW, items: [old], archive: [] }), "decay");
      expect(decay).toMatchObject({ risk: "safe", operation: { op: "decay", itemIds: [old.id] } });
    });

    it("queues imported items, and never decays pinned, rules, identity or user-stated items", () => {
      const imported = item({
        ...stale,
        source: "import",
        content: "Enjoys jazz playlists while coding",
      });
      const pinned = item({ ...stale, pinned: true, content: "Keeps a dark editor theme" });
      const rule = item({ ...stale, kind: "rule", content: "Always sign commits with gpg" });
      const identity = item({ ...stale, kind: "identity", content: "Works as a staff engineer" });
      const stated = item({
        ...stale,
        source: "user_stated",
        content: "Reads email only after lunch",
      });
      const proposals = byOp(
        curateMemory({ now: NOW, items: [imported, pinned, rule, identity, stated], archive: [] }),
        "decay",
      );
      expect(proposals).toHaveLength(1);
      expect(proposals[0]).toMatchObject({ risk: "review", operation: { itemIds: [imported.id] } });
    });

    it("keeps recently used and reinforced items", () => {
      const used = item({
        ...stale,
        lastUsedAt: NOW - 10 * DAY,
        content: "Recently used preference here",
      });
      const reinforced = item({
        ...stale,
        lastUsedAt: NOW - 200 * DAY,
        updatedAt: NOW - 200 * DAY,
        createdAt: NOW - 200 * DAY,
        reinforcedCount: 3,
        content: "Reinforced weekly digest preference",
      });
      expect(
        byOp(curateMemory({ now: NOW, items: [used, reinforced], archive: [] }), "decay"),
      ).toEqual([]);
    });
  });

  describe("commitments", () => {
    const due = NOW - 5 * DAY;

    it("expires a past-due commitment with a done signal automatically", () => {
      const commitment = item({
        kind: "commitment",
        content: "Send the quarterly report to finance",
        sourceRef: { dueAt: due },
      });
      const done = archiveRow({
        type: "decision",
        content: "Quarterly report sent to finance, task completed",
        createdAt: due + DAY,
      });
      const [expire] = byOp(
        curateMemory({ now: NOW, items: [commitment], archive: [done] }),
        "expire_commitment",
      );
      expect(expire).toMatchObject({ risk: "safe", operation: { itemIds: [commitment.id] } });
      expect(expire.evidence.some((entry) => entry.ref === `archive:${done.id}`)).toBe(true);
    });

    it("uses conversation done signals and queues the user's own commitments", () => {
      const commitment = item({
        kind: "commitment",
        source: "user_stated",
        content: "Send the quarterly report to finance",
        sourceRef: { dueAt: due },
      });
      const signal = {
        kind: "conversation" as const,
        ref: "event:e1",
        snippet: "sent",
        at: due,
        taskId: "t",
      };
      const [expire] = byOp(
        curateMemory({
          now: NOW,
          items: [commitment],
          archive: [],
          doneSignals: new Map([[commitment.id, [signal]]]),
        }),
        "expire_commitment",
      );
      expect(expire.risk).toBe("review");
      expect(expire.reviewReason).toMatch(/yourself/);
    });

    it("queues long-overdue commitments without a done signal, and ignores recent ones", () => {
      const stale = item({
        kind: "commitment",
        content: "Book the offsite venue",
        sourceRef: { dueAt: NOW - 45 * DAY },
      });
      const recent = item({
        kind: "commitment",
        content: "Reply to Dana",
        sourceRef: { dueAt: due },
      });
      const proposals = byOp(
        curateMemory({ now: NOW, items: [stale, recent], archive: [] }),
        "expire_commitment",
      );
      expect(proposals).toHaveLength(1);
      expect(proposals[0]).toMatchObject({ risk: "review", operation: { itemIds: [stale.id] } });
    });
  });

  describe("promotion", () => {
    it("promotes a correction that recurs in two tasks as a safe inferred fact", () => {
      const correction = (taskId: string, said: string) =>
        archiveRow({
          taskId,
          type: "insight",
          content: `[CORRECTION] User corrected agent during task "x"\nUser said: ${said}\nTask context: y`,
        });
      const rows = [
        correction("t1", "no, always use pnpm instead of npm for installs in this repo"),
        correction("t2", "use pnpm instead of npm for installs in this repo please"),
      ];
      const [promote] = byOp(curateMemory({ now: NOW, items: [], archive: rows }), "promote");
      expect(promote).toMatchObject({
        risk: "safe",
        operation: { op: "promote", kind: "correction" },
      });
      expect(promote.operation).toMatchObject({ taskIds: expect.arrayContaining(["t1", "t2"]) });
      expect((promote.operation as { content: string }).content).toMatch(
        /^User correction: .*pnpm/,
      );
    });

    it("needs two distinct tasks, skips private rows and what is already known", () => {
      const sameTask = [archiveRow({ taskId: "t1" }), archiveRow({ taskId: "t1" })];
      expect(byOp(curateMemory({ now: NOW, items: [], archive: sameTask }), "promote")).toEqual([]);
      const privateRows = [archiveRow({ isPrivate: true }), archiveRow({ isPrivate: true })];
      expect(byOp(curateMemory({ now: NOW, items: [], archive: privateRows }), "promote")).toEqual(
        [],
      );
      const known = item({
        kind: "project_fact",
        content: "Deploys must go through the staging pipeline before production release",
      });
      expect(
        byOp(
          curateMemory({ now: NOW, items: [known], archive: [archiveRow(), archiveRow()] }),
          "promote",
        ),
      ).toEqual([]);
    });

    it("queues new rules and promotions from imported or screen evidence", () => {
      const rules = [
        archiveRow({
          type: "constraint",
          content: "Never deploy on Fridays without approval from ops",
        }),
        archiveRow({
          type: "constraint",
          content: "Never deploy on Fridays without approval from the ops team",
        }),
      ];
      const [rule] = byOp(curateMemory({ now: NOW, items: [], archive: rules }), "promote");
      expect(rule).toMatchObject({ risk: "review", operation: { kind: "rule" } });

      const screen = [archiveRow({ origin: "chronicle" }), archiveRow()];
      const [fromScreen] = byOp(curateMemory({ now: NOW, items: [], archive: screen }), "promote");
      expect(fromScreen.risk).toBe("review");
      expect(fromScreen.reviewReason).toMatch(/imported or captured/);
    });

    it("extracts the user's words from correction rows", () => {
      expect(
        archiveFactText({
          content: "[CORRECTION] User corrected agent\nUser said: use tabs\nTask context: fmt",
        }),
      ).toBe("use tabs");
      expect(archiveFactText({ content: "[DECISION] Chose Postgres\nmore" })).toBe(
        "Chose Postgres",
      );
    });
  });

  it("never proposes two operations on the same item in one run", () => {
    const a = item({ content: "Prefers concise answers" });
    const b = item({ content: "Prefers detailed answers" });
    const c = item({ content: "prefers detailed answers!" });
    const proposals = curateMemory({ now: NOW, items: [a, b, c], archive: [] });
    const touched = proposals.flatMap((proposal) => {
      const op = proposal.operation;
      return op.op === "merge"
        ? [op.keepId, ...op.mergeIds]
        : op.op === "resolve_conflict"
          ? [op.keepId, ...op.dropIds]
          : op.op === "promote"
            ? []
            : op.itemIds;
    });
    expect(new Set(touched).size).toBe(touched.length);
  });
});
