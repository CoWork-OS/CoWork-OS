/**
 * Memory eval (audit §8.5; docs/harness-eval-battery.md "Memory evals"), deterministic and
 * offline over a fresh profile database and the real memory services.
 *
 * Privacy leak: suppressed, redacted, private, forgotten, superseded, expired, third-party and
 * foreign-workspace records are never returned by memory_recall, unified recall or the briefing
 * search.
 *
 * Run all suites with `npm run qa:memory-evals`; also part of `npm run qa:harness`.
 */
import { afterAll, expect, it, vi } from "vitest";
import privacyFixture from "./fixtures/privacy-leak.json";
import { describeEval, envModule } from "./memory-eval-harness";
import { flushSuiteReports, recordSuiteReport, round } from "./memory-eval-metrics";

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

describeEval("memory eval: privacy leak", () => {
  it("never returns hidden, private or foreign records from a read surface", async () => {
    const {
      createMemoryEvalEnv,
      seedItem,
      seedArchive,
      seedConversation,
      seedEntity,
      resolveConversationRefs,
    } = await envModule();
    const { MemoryService } = await import("../../MemoryService");
    const { MemoryTools } = await import("../../../agent/tools/memory-tools");
    const fixture = privacyFixture;
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
      const taskId = env.ensureTask("atlas", "privacy-probe", "Kiwi rollout status");
      const daemon = { logEvent: () => undefined } as unknown as ConstructorParameters<
        typeof MemoryTools
      >[1];
      const tools = new MemoryTools(atlas, daemon, taskId);
      const allRecords = [
        ...fixture.items,
        ...fixture.archive,
        ...fixture.conversations,
        ...fixture.entities,
      ];
      const markerOf = (key: string): string | null => {
        const record = allRecords.find((entry) => entry.key === key) as
          | { content?: string; description?: string; payload?: { message?: string } }
          | undefined;
        const text = record?.content ?? record?.description ?? record?.payload?.message ?? "";
        return text.match(/PV-[A-Z]+/)?.[0] ?? null;
      };
      const forbiddenRefs = fixture.forbidden
        .map((key) => env.refs.get(key))
        .filter((ref): ref is string => !!ref);

      type Probe = { surface: string; channel: boolean; output: unknown; refs: string[] };
      const probes: Probe[] = [];
      const toolProbe = async (surface: string, input: Record<string, unknown>) => {
        const output = await tools.recall(input as Parameters<typeof tools.recall>[0]);
        const results = (output.results as Array<{ id: string }> | undefined) ?? [];
        probes.push({ surface, channel: false, output, refs: results.map((hit) => hit.id) });
      };
      await toolProbe("memory_recall:index", {
        query: fixture.query,
        scopes: ["memory", "conversations", "knowledge"],
      });
      await toolProbe("memory_recall:full", {
        query: fixture.query,
        scopes: ["memory", "conversations", "knowledge"],
        detail: "full",
      });
      await toolProbe("memory_recall:listing", { scopes: ["memory"] });
      await toolProbe("memory_recall:ids", { ids: forbiddenRefs, detail: "full" });

      const lanes = ["memory", "archive", "conversations", "knowledge"] as const;
      for (const detail of ["index", "full"] as const) {
        const result = await env.recall.recall({
          text: fixture.query,
          workspaceId: atlas.id,
          taskId,
          lanes: [...lanes],
          surface: "tool",
          detail,
          limit: 30,
        });
        probes.push({
          surface: `unified_recall:${detail}`,
          channel: false,
          output: result.hits,
          refs: result.hits.map((hit) => hit.ref),
        });
      }
      const expanded = await env.recall.recall({
        text: "",
        workspaceId: atlas.id,
        taskId,
        lanes: [...lanes],
        surface: "tool",
        detail: "full",
        ids: forbiddenRefs,
        limit: 30,
      });
      probes.push({
        surface: "unified_recall:ids",
        channel: false,
        output: expanded.hits,
        refs: expanded.hits.map((hit) => hit.ref),
      });
      const briefing = await MemoryService.searchForBriefingAsync(atlas.id, fixture.query, 20);
      probes.push({
        surface: "briefing",
        channel: true,
        output: briefing,
        refs: briefing.map((hit) => `archive:${hit.id}`),
      });

      let leaks = 0;
      const failures: string[] = [];
      const perSurface: Record<string, number> = {};
      for (const probe of probes) {
        const text = JSON.stringify(probe.output);
        const forbidden = [
          ...fixture.forbidden,
          ...(probe.channel ? fixture.forbiddenOnChannelSurfaces : []),
        ];
        const leaked = forbidden.filter((key) => {
          const ref = env.refs.get(key);
          const marker = markerOf(key);
          return (ref && probe.refs.includes(ref)) || (marker && text.includes(marker));
        });
        perSurface[probe.surface] = probe.refs.length;
        leaks += leaked.length;
        if (leaked.length > 0) failures.push(`${probe.surface}: leaked ${leaked.join(", ")}`);
      }

      // The probes must see the visible records, or "no leak" proves nothing.
      const unified = probes.find((probe) => probe.surface === "unified_recall:index")!;
      const visibleFound = fixture.visible.filter((key) =>
        unified.refs.includes(env.refs.get(key)!),
      );
      const visibleRecall = visibleFound.length / fixture.visible.length;
      if (visibleRecall < fixture.thresholds.visibleRecallAtK)
        failures.push(
          `visible records missing from unified recall: ${fixture.visible
            .filter((key) => !visibleFound.includes(key))
            .join(", ")}`,
        );
      if (!briefing.some((hit) => `archive:${hit.id}` === env.refs.get("a-visible")))
        failures.push("briefing does not return the visible archive row");

      const metrics = {
        probes: probes.length,
        forbiddenRecords: fixture.forbidden.length,
        leaks,
        visibleRecall: round(visibleRecall),
      };
      recordSuiteReport({
        suite: "privacy-leak",
        passed: failures.length === 0,
        metrics,
        thresholds: fixture.thresholds,
        failures,
        details: { resultsPerSurface: perSurface },
      });
      expect(failures).toEqual([]);
    } finally {
      await env.close();
    }
  });
});
