import {
  cosineSimilarity,
  createLocalEmbedding,
  tokenizeForLocalEmbedding,
} from "./local-embedding";

/**
 * The hybrid (BM25 + local embedding) memory ranking, as a pure function so the host
 * and the FTS worker rank identically (async SQLite migration plan, DB4). Callers supply
 * the lexical candidates, the embedding caches, and a loader for full rows.
 */

export interface HybridLexicalResult {
  id: string;
  snippet: string;
  type: string;
  relevanceScore?: number;
  createdAt: number;
  taskId?: string;
  source: "db";
}

export interface HybridCandidateRow {
  id: string;
  summary?: string | null;
  content: string;
  type: string;
  createdAt: number;
  taskId?: string | null;
}

export type EmbeddingEntries = Iterable<[string, { embedding: ArrayLike<number> }]>;

export function hybridSemanticK(limit: number): number {
  return Math.min(Math.max(limit * 3, 30), 120);
}

export function truncateMemorySnippet(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

export function mergeLexicalOnly<T extends { id: string }>(
  local: T[],
  imported: T[],
  limit: number,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of [...local, ...imported]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
    if (out.length >= limit) return out;
  }
  return out;
}

/** True when the query carries enough signal for the semantic stage. */
export function wantsSemanticStage(query: string): boolean {
  return tokenizeForLocalEmbedding(query).length >= 2;
}

interface HybridRankInput<T extends { id: string }> {
  query: string;
  limit: number;
  lexicalLocal: T[];
  lexicalImportedGlobal: T[];
  workspaceEmbeddings: EmbeddingEntries | null | undefined;
  importedEmbeddings: EmbeddingEntries | null | undefined;
}

/**
 * The first phase of hybrid ranking: either the final lexical-only results, or the
 * candidate ids whose full rows the second phase, `rank`, scores. Callers that read rows
 * asynchronously load them between the phases.
 */
export type HybridRankPlan<T> =
  | { results: Array<T | HybridLexicalResult> }
  | { candidateIds: string[]; rank(rows: HybridCandidateRow[]): HybridLexicalResult[] };

/**
 * Lexical-only queries return the lexical candidates themselves; otherwise every result
 * is rebuilt from its full row.
 */
export function rankHybridMemories<T extends { id: string }>(
  params: HybridRankInput<T> & { loadRows(ids: string[]): HybridCandidateRow[] },
): Array<T | HybridLexicalResult> {
  const plan = planHybridMemories(params);
  return "results" in plan ? plan.results : plan.rank(params.loadRows(plan.candidateIds));
}

export function planHybridMemories<T extends { id: string }>(
  params: HybridRankInput<T>,
): HybridRankPlan<T> {
  const { query, limit, lexicalLocal, lexicalImportedGlobal } = params;
  if (!wantsSemanticStage(query)) {
    return { results: mergeLexicalOnly(lexicalLocal, lexicalImportedGlobal, limit) };
  }
  const queryEmbedding = createLocalEmbedding(query);
  if (queryEmbedding.every((v) => v === 0)) {
    return { results: mergeLexicalOnly(lexicalLocal, lexicalImportedGlobal, limit) };
  }

  const candidateIds = new Set<string>();
  for (const r of lexicalLocal) candidateIds.add(r.id);
  for (const r of lexicalImportedGlobal) candidateIds.add(r.id);

  // Semantic candidate set: scan local, then imported-global embeddings; keep top K.
  const semanticK = hybridSemanticK(limit);
  const semanticCandidates: Array<{ id: string; score: number }> = [];
  for (const source of [params.workspaceEmbeddings, params.importedEmbeddings]) {
    if (!source) continue;
    for (const [memoryId, entry] of source) {
      const score = cosineSimilarity(queryEmbedding, entry.embedding);
      if (!Number.isFinite(score) || score <= 0) continue;
      semanticCandidates.push({ id: memoryId, score });
    }
  }
  semanticCandidates.sort((a, b) => b.score - a.score);
  const semanticScoreById = new Map<string, number>();
  for (const cand of semanticCandidates.slice(0, semanticK)) {
    candidateIds.add(cand.id);
    semanticScoreById.set(cand.id, cand.score);
  }

  const lexicalRankLocal = new Map<string, number>();
  lexicalLocal.forEach((r, idx) => lexicalRankLocal.set(r.id, idx));
  const lexicalRankImported = new Map<string, number>();
  lexicalImportedGlobal.forEach((r, idx) => lexicalRankImported.set(r.id, idx));

  const rank = (rows: HybridCandidateRow[]): HybridLexicalResult[] => {
    const scored: Array<{ result: HybridLexicalResult; score: number }> = [];
    for (const mem of rows) {
      const semantic = semanticScoreById.get(mem.id) ?? 0;
      const idxLocal = lexicalRankLocal.get(mem.id);
      const idxImported = lexicalRankImported.get(mem.id);
      const baselineLocal = idxLocal === undefined ? 0 : 1 / (1 + idxLocal);
      const baselineImported = idxImported === undefined ? 0 : 1 / (1 + idxImported);
      const baseline = Math.max(baselineLocal, baselineImported);
      // Weighted hybrid score. Favor lexical when present but allow semantic to lift matches.
      const hybrid = 0.55 * semantic + 0.45 * baseline;
      scored.push({
        result: {
          id: mem.id,
          snippet: mem.summary || truncateMemorySnippet(mem.content, 200),
          type: mem.type,
          relevanceScore: hybrid,
          createdAt: mem.createdAt,
          taskId: mem.taskId || undefined,
          source: "db",
        },
        score: hybrid,
      });
    }
    scored.sort((a, b) => b.score - a.score || b.result.createdAt - a.result.createdAt);
    return scored.slice(0, limit).map((s) => s.result);
  };
  return { candidateIds: Array.from(candidateIds), rank };
}
