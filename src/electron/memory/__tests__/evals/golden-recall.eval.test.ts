/**
 * Memory eval (audit §8.5; docs/harness-eval-battery.md "Memory evals"), deterministic and
 * offline over a fresh profile database and the real memory services.
 *
 * Golden recall: recall@k and MRR of MemoryRecall over saved facts, archive rows, earlier
 * conversations and knowledge-graph entities (English, Turkish, German and file names), with
 * distractors in a second workspace.
 *
 * Run all suites with `npm run qa:memory-evals`; also part of `npm run qa:harness`.
 */
import { afterAll, expect, it, vi } from "vitest";
import goldenFixture from "./fixtures/golden-recall.json";
import { describeEval, envModule, keysOf } from "./memory-eval-harness";
import {
  flushSuiteReports,
  recordSuiteReport,
  meanReciprocalRank,
  missesAtK,
  recallAtK,
  recallAtKByLang,
  round,
  type RankedQueryResult,
} from "./memory-eval-metrics";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/cowork-memory-evals", isPackaged: false },
}));
// Memory statements run on the host connection (no database worker in the evals).
vi.mock("../../../database/async/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../database/async/runtime")>()),
  getDatabaseClient: async () => null,
}));

afterAll(() => {
  flushSuiteReports();
});

describeEval("memory eval: golden recall", () => {
  it("recalls the golden set at the configured recall@k and MRR", async () => {
    const { createMemoryEvalEnv, seedItem, seedArchive, seedConversation, seedEntity } =
      await envModule();
    const { resolveConversationRefs } = await envModule();
    const fixture = goldenFixture;
    const env = await createMemoryEvalEnv(fixture.workspaces);
    try {
      for (const item of fixture.items) {
        const result = await seedItem(env, item as Parameters<typeof seedItem>[1]);
        expect(result.status, `item ${item.key}`).toBe("written");
      }
      for (const row of fixture.archive) {
        await seedArchive(env, row as Parameters<typeof seedArchive>[1]);
      }
      for (const event of fixture.conversations) seedConversation(env, event);
      await resolveConversationRefs(env, fixture.conversations);
      for (const entity of fixture.entities) await seedEntity(env, entity);

      const atlas = env.workspaces.get("atlas")!;
      const queryTask = env.ensureTask("atlas", "golden-query", "Golden recall query");
      const foreignKeys = new Set(
        [...fixture.items, ...fixture.archive, ...fixture.conversations, ...fixture.entities]
          .filter((record) => record.workspace === "harbor")
          .map((record) => record.key),
      );

      const results: RankedQueryResult[] = [];
      let crossWorkspaceHits = 0;
      const laneErrors: Record<string, unknown> = {};
      for (const query of fixture.queries) {
        const result = await env.recall.recall({
          text: query.text,
          workspaceId: atlas.id,
          taskId: queryTask,
          lanes: ["memory", "archive", "conversations", "knowledge"],
          surface: "tool",
          limit: 10,
        });
        if (Object.keys(result.laneErrors).length > 0) laneErrors[query.id] = result.laneErrors;
        const returned = keysOf(
          env,
          result.hits.map((hit) => hit.ref),
        );
        crossWorkspaceHits += returned.filter((key) => foreignKeys.has(key)).length;
        results.push({ id: query.id, lang: query.lang, expect: query.expect, returned });
      }

      const k = fixture.k;
      const metrics = {
        queries: results.length,
        k,
        recallAtK: round(recallAtK(results, k)),
        recallAt1: round(recallAtK(results, 1)),
        mrr: round(meanReciprocalRank(results)),
        crossWorkspaceHits,
        recallAtKByLang: recallAtKByLang(results, k),
      };
      const misses = missesAtK(results, k).map((miss) => ({
        id: miss.id,
        expect: miss.expect,
        top: miss.returned.slice(0, k),
      }));
      const failures: string[] = [];
      if (metrics.recallAtK < fixture.thresholds.recallAtK)
        failures.push(`recall@${k} ${metrics.recallAtK} < ${fixture.thresholds.recallAtK}`);
      if (metrics.mrr < fixture.thresholds.mrr)
        failures.push(`MRR ${metrics.mrr} < ${fixture.thresholds.mrr}`);
      if (crossWorkspaceHits > fixture.thresholds.crossWorkspaceHits)
        failures.push(`${crossWorkspaceHits} hit(s) from another workspace`);
      if (Object.keys(laneErrors).length > 0)
        failures.push(`lane errors: ${JSON.stringify(laneErrors)}`);
      recordSuiteReport({
        suite: "golden-recall",
        passed: failures.length === 0,
        metrics,
        thresholds: fixture.thresholds,
        failures,
        details: { misses },
      });
      expect(failures, JSON.stringify(misses, null, 2)).toEqual([]);
    } finally {
      await env.close();
    }
  });
});
