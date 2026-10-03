/**
 * Memory eval (audit §8.5; docs/harness-eval-battery.md "Memory evals"), deterministic and
 * offline over a fresh profile database and the real memory services.
 *
 * Injection: MemoryInjectionPolicy + MemoryContextBuilder per context (private, sub-agent,
 * group, trusted group, public, verifier, <no-memory>, memory off). No private or third-party
 * leakage, each subject and fact once, every block within its budget.
 *
 * Run all suites with `npm run qa:memory-evals`; also part of `npm run qa:harness`.
 */
import { afterAll, expect, it, vi } from "vitest";
import injectionFixture from "./fixtures/injection.json";
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

describeEval("memory eval: injection", () => {
  it("injects only allowed memory per context, each subject once, within budget", async () => {
    const { createMemoryEvalEnv, seedItem } = await envModule();
    const { resolveMemoryInjection } = await import("../../MemoryInjectionPolicy");
    const { MemoryContextBuilderService } = await import("../../MemoryContextBuilder");
    const fixture = injectionFixture;
    const env = await createMemoryEvalEnv(fixture.workspaces);
    try {
      for (const item of fixture.items) {
        const result = await seedItem(env, item as Parameters<typeof seedItem>[1]);
        expect(result.status, `item ${item.key}`).toBe("written");
      }
      for (let index = 0; index < fixture.fillerFacts; index += 1) {
        await seedItem(env, {
          key: `filler-${index}`,
          workspace: "atlas",
          kind: "project_fact",
          content: `MK-FILL${index} release checklist step ${index}: verify the staging deploy log for service ${index}.`,
        });
      }
      const atlas = env.workspaces.get("atlas")!;
      const taskId = env.ensureTask("atlas", "injection-task", "Ship the release");
      const markerOf = (key: string) => {
        const item = fixture.items.find((entry) => entry.key === key);
        if (!item) throw new Error(`unknown item ${key}`);
        return item.content.split(" ")[0];
      };
      const count = (text: string, marker: string) => text.split(`${marker} `).length - 1;
      const estimate = (text: string) => Math.ceil(text.length / 4);

      const perContext: Record<string, unknown>[] = [];
      let leaks = 0;
      let duplicateSubjects = 0;
      let duplicateContent = 0;
      let budgetOverflows = 0;
      let blocksBuilt = 0;
      const failures: string[] = [];
      for (const context of fixture.contexts) {
        const decision = resolveMemoryInjection(
          context.input as Parameters<typeof resolveMemoryInjection>[0],
        );
        const builder = new MemoryContextBuilderService({ getItemsPort: () => env.repository });
        const layers = await builder.buildLayers({
          workspaceId: atlas.id,
          taskId,
          decision,
          focus: fixture.focus,
          budgets: fixture.budgets,
        });
        const blocks = [layers.l0, layers.l1].filter((block) => !!block);
        blocksBuilt += blocks.length;
        const text = blocks.map((block) => block!.text).join("\n");
        const refs = blocks.flatMap((block) => block!.refs);

        const forbidden = [
          ...fixture.alwaysForbidden,
          ...fixture.privateOnly.filter((key) => !context.allowed.includes(key)),
        ];
        const leaked = forbidden.filter(
          (key) => count(text, markerOf(key)) > 0 || refs.includes(env.refs.get(key) ?? "\u0000"),
        );
        leaks += leaked.length;
        if (leaked.length > 0) failures.push(`${context.id}: leaked ${leaked.join(", ")}`);

        if (context.expectBlocks && blocks.length === 0)
          failures.push(`${context.id}: expected memory blocks, got none`);
        if (!context.expectBlocks && blocks.length > 0)
          failures.push(`${context.id}: expected no memory, got ${blocks.length} block(s)`);

        for (const [subject, keys] of Object.entries(fixture.singleValued)) {
          const shown = keys.filter((key) => count(text, markerOf(key)) > 0).length;
          const repeats = keys.reduce((sum, key) => sum + count(text, markerOf(key)), 0);
          if (shown > 1 || repeats > 1) {
            duplicateSubjects += 1;
            failures.push(`${context.id}: subject ${subject} rendered ${repeats} times`);
          }
        }
        const markers = new Set(fixture.items.map((item) => item.content.split(" ")[0]));
        for (const marker of markers) {
          if (count(text, marker) > 1) {
            duplicateContent += 1;
            failures.push(`${context.id}: ${marker} rendered ${count(text, marker)} times`);
          }
        }
        if (new Set(refs).size !== refs.length) {
          duplicateContent += 1;
          failures.push(`${context.id}: a ref is listed twice`);
        }

        const budgetOf = { l0: fixture.budgets.l0Tokens, l1: fixture.budgets.l1Tokens };
        for (const block of blocks) {
          const tokens = estimate(block!.text);
          if (tokens > budgetOf[block!.layer] || block!.tokens > budgetOf[block!.layer]) {
            budgetOverflows += 1;
            failures.push(
              `${context.id}: ${block!.layer} ${tokens} tokens > ${budgetOf[block!.layer]}`,
            );
          }
        }
        if (context.id === "private") {
          for (const key of fixture.mustKeepInPrivate) {
            if (count(text, markerOf(key)) === 0)
              failures.push(`private: ${key} dropped under budget pressure`);
          }
        }
        perContext.push({
          context: context.id,
          layers: Object.entries(decision.layers)
            .filter(([, on]) => on)
            .map(([layer]) => layer),
          l0Tokens: layers.l0 ? estimate(layers.l0.text) : 0,
          l1Tokens: layers.l1 ? estimate(layers.l1.text) : 0,
          truncated: blocks.some((block) => block!.truncated),
          refs: refs.length,
        });
      }

      const metrics = {
        contexts: fixture.contexts.length,
        blocksBuilt,
        leaks,
        duplicateSubjects,
        duplicateContent,
        budgetOverflows,
        budgetOverflowRate: round(blocksBuilt === 0 ? 0 : budgetOverflows / blocksBuilt),
      };
      recordSuiteReport({
        suite: "injection",
        passed: failures.length === 0,
        metrics,
        thresholds: fixture.thresholds,
        failures,
        details: { perContext },
      });
      expect(failures).toEqual([]);
    } finally {
      await env.close();
    }
  });
});
