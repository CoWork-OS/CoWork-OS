import { describe, expect, it } from "vitest";
import type { ProactiveSuggestion } from "../../../shared/types";
import {
  SuggestionSink,
  commitmentEntityKey,
  normalizeSuggestionEntityKey,
  normalizeSuggestionTitleKey,
  type SuggestionCreateInput,
  type SuggestionSinkStore,
} from "../SuggestionSink";

function createFakeStore() {
  const rows: ProactiveSuggestion[] = [];
  const merges: Array<{ id: string; sources: string[]; evidence: string[] }> = [];
  const suppressed = new Set<string>();
  let listCalls = 0;
  const store: SuggestionSinkStore = {
    listActive: async (workspaceId) => {
      listCalls += 1;
      return rows.filter((row) => row.workspaceId === workspaceId);
    },
    create: async (workspaceId, input: SuggestionCreateInput) => {
      const row: ProactiveSuggestion = {
        id: `s-${rows.length + 1}`,
        type: input.type,
        title: input.title,
        description: input.description,
        confidence: input.confidence,
        workspaceId,
        entityKey: input.entityKey,
        sources: input.sources,
        sourceSignals: input.sourceSignals,
        createdAt: Date.now(),
        expiresAt: Date.now() + 1000,
        dismissed: false,
        actedOn: false,
      };
      rows.push(row);
      return row;
    },
    mergeSources: (_workspaceId, id, sources, evidence) => {
      merges.push({ id, sources, evidence });
      const row = rows.find((entry) => entry.id === id);
      if (row) {
        row.sources = Array.from(new Set([...(row.sources || []), ...sources]));
        row.sourceSignals = Array.from(new Set([...(row.sourceSignals || []), ...evidence]));
      }
    },
    isEntitySuppressed: (workspaceId, entityKey) => suppressed.has(`${workspaceId}::${entityKey}`),
  };
  return { store, rows, merges, suppressed, listCalls: () => listCalls };
}

describe("SuggestionSink", () => {
  it("merges every producer's proposal for one commitment into one suggestion", async () => {
    const { store, rows } = createFakeStore();
    const sink = new SuggestionSink(() => store);
    const entityKey = commitmentEntityKey("c-1");

    const autonomy = await sink.propose({
      workspaceId: "ws-1",
      entityKey,
      title: "Follow up on: send the contract",
      why: "Due soon",
      source: "autonomy",
      evidence: ["c-1"],
      confidence: 0.8,
    });
    const awareness = await sink.propose({
      workspaceId: "ws-1",
      entityKey,
      title: "Review due soon: send the contract",
      why: "Due tomorrow",
      source: "awareness",
      evidence: ["c-1", "event-7"],
      confidence: 0.9,
    });
    const heartbeat = await sink.propose({
      workspaceId: "ws-1",
      entityKey,
      title: "Heartbeat review: contract follow-up",
      why: "Signals",
      source: "heartbeat",
      confidence: 0.8,
    });

    expect(autonomy).toMatchObject({ created: true, merged: false, entityKey });
    expect(awareness).toMatchObject({ created: false, merged: true });
    expect(heartbeat).toMatchObject({ created: false, merged: true });
    expect(rows).toHaveLength(1);
    expect(rows[0].sources).toEqual(["autonomy", "awareness", "heartbeat"]);
    expect(rows[0].sourceSignals).toEqual(["c-1", "event-7"]);
    expect(heartbeat.suggestion?.id).toBe(autonomy.suggestion?.id);
  });

  it("falls back to the normalized title, ignoring producer prefixes", async () => {
    const { store, rows } = createFakeStore();
    const sink = new SuggestionSink(() => store);

    await sink.propose({
      workspaceId: "ws-1",
      title: "Follow up on: Ship the launch checklist!",
      why: "a",
      source: "autonomy",
      confidence: 0.7,
    });
    const second = await sink.propose({
      workspaceId: "ws-1",
      title: "Review due soon: ship the launch checklist",
      why: "b",
      source: "awareness",
      confidence: 0.7,
    });

    expect(second.merged).toBe(true);
    expect(rows).toHaveLength(1);
    expect(normalizeSuggestionTitleKey("Decision needed: Ship  the launch-checklist")).toBe(
      "ship the launch checklist",
    );
    expect(normalizeSuggestionEntityKey(undefined, "Follow up: X")).toBe("title:x");
  });

  it("keeps different entities and workspaces apart", async () => {
    const { store, rows } = createFakeStore();
    const sink = new SuggestionSink(() => store);
    await sink.propose({
      workspaceId: "ws-1",
      entityKey: "task:1",
      title: "Review task one",
      why: "a",
      source: "heartbeat",
      confidence: 0.7,
    });
    await sink.propose({
      workspaceId: "ws-1",
      entityKey: "task:2",
      title: "Review task two",
      why: "b",
      source: "heartbeat",
      confidence: 0.7,
    });
    await sink.propose({
      workspaceId: "ws-2",
      entityKey: "task:1",
      title: "Review task one",
      why: "c",
      source: "heartbeat",
      confidence: 0.7,
    });
    expect(rows).toHaveLength(3);
  });

  it("does not re-propose an entity the user dismissed", async () => {
    const { store, rows, suppressed } = createFakeStore();
    const sink = new SuggestionSink(() => store);
    suppressed.add(`ws-1::${commitmentEntityKey("c-9")}`);
    const result = await sink.propose({
      workspaceId: "ws-1",
      entityKey: commitmentEntityKey("c-9"),
      title: "Follow up on: invoice",
      why: "Due",
      source: "autonomy",
      confidence: 0.9,
    });
    expect(result).toMatchObject({ created: false, merged: false, suppressed: true });
    expect(rows).toHaveLength(0);
  });

  it("serializes concurrent proposals so the same entity is created once", async () => {
    const { store, rows } = createFakeStore();
    const sink = new SuggestionSink(() => store);
    const results = await Promise.all(
      ["autonomy", "awareness", "workflow_intelligence"].map((source) =>
        sink.propose({
          workspaceId: "ws-1",
          entityKey: "wi:target-1",
          title: "Workflow Intelligence: target",
          why: "x",
          source: source as "autonomy",
          confidence: 0.7,
        }),
      ),
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].sources).toEqual(["autonomy", "awareness", "workflow_intelligence"]);
  });

  it("does not record a merge when the source and evidence are already known", async () => {
    const { store, merges } = createFakeStore();
    const sink = new SuggestionSink(() => store);
    const proposal = {
      workspaceId: "ws-1",
      entityKey: "task:1",
      title: "Review task",
      why: "a",
      source: "heartbeat" as const,
      evidence: ["task:1"],
      confidence: 0.7,
    };
    await sink.propose(proposal);
    const again = await sink.propose(proposal);
    expect(again.merged).toBe(true);
    expect(merges).toHaveLength(0);
  });
});
