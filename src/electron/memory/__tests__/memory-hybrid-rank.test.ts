/**
 * Hybrid memory ranking scales (audit RECALL-8): lexical-only scores are rank-based like
 * the hybrid stage, imported matches count half, and a lexical match outside the semantic
 * top K keeps its own semantic score.
 */
import { describe, expect, it } from "vitest";
import { createLocalEmbedding } from "../local-embedding";
import {
  IMPORTED_LEXICAL_FACTOR,
  hybridSemanticK,
  mergeLexicalOnly,
  planHybridMemories,
  type HybridCandidateRow,
} from "../memory-hybrid-rank";

function row(id: string, content: string): HybridCandidateRow {
  return { id, content, summary: null, type: "insight", createdAt: 1 };
}

describe("mergeLexicalOnly", () => {
  it("replaces raw bm25 scores with rank-based ones and halves imports", () => {
    const merged = mergeLexicalOnly(
      [
        { id: "a", relevanceScore: 14.2 },
        { id: "b", relevanceScore: 9.7 },
      ],
      [
        { id: "b", relevanceScore: 30 },
        { id: "c", relevanceScore: 25 },
      ],
      10,
    );
    expect(merged).toEqual([
      { id: "a", relevanceScore: 1 },
      { id: "b", relevanceScore: 0.5 },
      { id: "c", relevanceScore: IMPORTED_LEXICAL_FACTOR / 2 },
    ]);
  });

  it("leaves results without a score untouched", () => {
    expect(mergeLexicalOnly([{ id: "a" }], [], 5)).toEqual([{ id: "a" }]);
  });
});

describe("planHybridMemories", () => {
  const query = "sqlite migration plan";

  it("ranks an imported match below the same-rank local match", () => {
    const plan = planHybridMemories({
      query,
      limit: 5,
      lexicalLocal: [{ id: "local" }],
      lexicalImportedGlobal: [{ id: "imported" }],
      workspaceEmbeddings: null,
      importedEmbeddings: null,
    });
    if ("results" in plan) throw new Error("expected the hybrid stage");
    const ranked = plan.rank([row("imported", "x"), row("local", "x")]);
    expect(ranked.map((result) => result.id)).toEqual(["local", "imported"]);
    expect(ranked[1].relevanceScore).toBeCloseTo(ranked[0].relevanceScore! * 0.5);
  });

  it("keeps the semantic score of a lexical match outside the semantic top K", () => {
    const limit = 1;
    const fillers = Array.from({ length: hybridSemanticK(limit) + 5 }, (_, idx) => [
      `filler-${idx}`,
      { embedding: createLocalEmbedding(query) },
    ]) as Array<[string, { embedding: number[] }]>;
    const lexicalOnly = createLocalEmbedding("sqlite migration notes");
    const plan = planHybridMemories({
      query,
      limit,
      lexicalLocal: [{ id: "lexical" }],
      lexicalImportedGlobal: [],
      workspaceEmbeddings: [...fillers, ["lexical", { embedding: lexicalOnly }]],
      importedEmbeddings: null,
    });
    if ("results" in plan) throw new Error("expected the hybrid stage");
    const [result] = plan.rank([row("lexical", "sqlite migration notes")]);
    // 0.45 is the lexical baseline alone; a semantic share lifts it above.
    expect(result.relevanceScore!).toBeGreaterThan(0.45);
  });
});
