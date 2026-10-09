/**
 * Memory eval (audit §8.5; docs/harness-eval-battery.md "Memory evals"), deterministic and
 * offline over a fresh profile database and the real memory services.
 *
 * Write hygiene: a synthetic task event stream through capture salience and
 * MemoryService.capture, and a fact stream through MemoryWriter. No telemetry rows, duplicates
 * under 1%, contradictions superseded, secrets redacted everywhere text is stored.
 *
 * Run all suites with `npm run qa:memory-evals`; also part of `npm run qa:harness`.
 */
import { afterAll, expect, it, vi } from "vitest";
import hygieneFixture from "./fixtures/write-hygiene.json";
import { describeEval, envModule } from "./memory-eval-harness";
import { flushSuiteReports, recordSuiteReport, duplicateRate, round } from "./memory-eval-metrics";

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

describeEval("memory eval: write hygiene", () => {
  it("keeps telemetry, duplicates, stale contradictions and secrets out of storage", async () => {
    const { createMemoryEvalEnv, seedItem } = await envModule();
    const { buildSalientTaskEventCapture } = await import("../../memory-capture-salience");
    const { MemoryService } = await import("../../MemoryService");
    const { RAW_TELEMETRY_CONTENT_PATTERNS } = await import("../../memory-cleanup-sql");
    const { observationContentHash } = await import("../../memory-observation-sql");
    const fixture = hygieneFixture;
    const env = await createMemoryEvalEnv(fixture.workspaces);
    try {
      const atlas = env.workspaces.get("atlas")!;
      let eventsIn = 0;
      let salientEvents = 0;
      // Archive capture as the daemon does it (agent/daemon.ts captureToMemory): only
      // salient events, with task context, through MemoryService.capture.
      for (let round = 0; round < fixture.repeat; round += 1) {
        for (const task of fixture.tasks) {
          const taskId = env.ensureTask("atlas", task.key, task.title);
          for (const event of task.events) {
            eventsIn += 1;
            const capture = buildSalientTaskEventCapture(event.type, event.payload, {
              title: task.title,
              prompt: task.title,
            });
            if (!capture) continue;
            salientEvents += 1;
            await MemoryService.capture(
              atlas.id,
              taskId,
              capture.memoryType,
              capture.content,
              false,
            );
          }
        }
      }
      // Fact stream through MemoryWriter, replayed the same number of times.
      const skipped: Record<string, string> = {};
      for (let round = 0; round < fixture.repeat; round += 1) {
        for (const fact of fixture.facts) {
          const result = await seedItem(env, fact as Parameters<typeof seedItem>[1]);
          if (result.status === "skipped" && round === 0) skipped[fact.key] = result.reason;
        }
      }
      await env.writer.flush();

      const archive = env.db
        .prepare(
          "SELECT id, task_id, type, content, COALESCE(summary, '') AS summary FROM memories WHERE workspace_id = ?",
        )
        .all(atlas.id) as Array<{
        id: string;
        task_id: string | null;
        type: string;
        content: string;
        summary: string;
      }>;
      const items = env.db
        .prepare(
          `SELECT id, workspace_id, scope, scope_ref, kind, subject_key, content, content_hash, status
           FROM memory_items`,
        )
        .all() as Array<Record<string, string | null>>;
      const active = items.filter((item) => item.status === "active");

      const likes = RAW_TELEMETRY_CONTENT_PATTERNS.map(() => "content LIKE ?").join(" OR ");
      const telemetryArchive = (
        env.db
          .prepare(`SELECT COUNT(*) AS n FROM memories WHERE ${likes}`)
          .get(...RAW_TELEMETRY_CONTENT_PATTERNS) as { n: number }
      ).n;
      const telemetryItems = (
        env.db
          .prepare(`SELECT COUNT(*) AS n FROM memory_items WHERE ${likes}`)
          .get(...RAW_TELEMETRY_CONTENT_PATTERNS) as { n: number }
      ).n;

      const archiveDup = duplicateRate(
        archive.map((row) => `${row.type}|${observationContentHash(row.content)}`),
      );
      const itemDup = duplicateRate(
        active.map((item) =>
          [item.workspace_id, item.scope, item.scope_ref, item.kind, item.content_hash].join("|"),
        ),
      );

      const contradictions: string[] = [];
      for (const [subject, value] of Object.entries(fixture.expect.subjects)) {
        const holders = active.filter((item) => item.subject_key === subject);
        if (holders.length !== 1 || holders[0].content !== value) {
          contradictions.push(
            `${subject}: ${holders.length} active (${holders.map((item) => item.content).join(" | ")})`,
          );
        }
      }
      const superseded = items.filter((item) => item.status === "superseded").length;

      // Every place stored text can surface: archive content and summaries, observation
      // metadata, memory items and the archive FTS index.
      const stored = [
        ...archive.flatMap((row) => [row.content, row.summary]),
        ...(
          env.db
            .prepare(
              "SELECT title || ' ' || narrative || ' ' || facts AS text FROM memory_observation_metadata",
            )
            .all() as Array<{ text: string }>
        ).map((row) => row.text),
        ...items.map((item) => String(item.content ?? "")),
      ].join("\n");
      const secretLeaks = fixture.secrets.filter((secret) => stored.includes(secret));
      const ftsLeaks = fixture.secrets.filter(
        (secret) =>
          (
            env.db
              .prepare("SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH ?")
              .get(`"${secret.replace(/"/g, '""')}"`) as { n: number }
          ).n > 0,
      );

      const rowsPerTask: Record<string, number> = {};
      for (const task of fixture.tasks) {
        rowsPerTask[task.key] = archive.filter(
          (row) => row.task_id === env.taskId(task.key),
        ).length;
      }

      const metrics = {
        eventsIn,
        salientEvents,
        archiveRows: archive.length,
        noiseRatio: round(archive.length === 0 ? 0 : telemetryArchive / archive.length),
        telemetryRows: telemetryArchive + telemetryItems,
        archiveDuplicateRate: round(archiveDup),
        itemsActive: active.length,
        itemsSuperseded: superseded,
        itemDuplicateRate: round(itemDup),
        unsupersededContradictions: contradictions.length,
        secretLeaks: secretLeaks.length + ftsLeaks.length,
      };
      const t = fixture.thresholds;
      const failures: string[] = [];
      if (metrics.telemetryRows > t.telemetryRows)
        failures.push(`${metrics.telemetryRows} telemetry row(s) stored`);
      if (metrics.archiveDuplicateRate > t.archiveDuplicateRate)
        failures.push(`archive duplicate rate ${metrics.archiveDuplicateRate}`);
      if (metrics.itemDuplicateRate > t.itemDuplicateRate)
        failures.push(`memory item duplicate rate ${metrics.itemDuplicateRate}`);
      if (metrics.unsupersededContradictions > t.unsupersededContradictions)
        failures.push(`contradictions not superseded: ${contradictions.join("; ")}`);
      if (metrics.secretLeaks > t.secretLeaks)
        failures.push(`secrets stored: ${[...secretLeaks, ...ftsLeaks].length}`);
      for (const [key, reason] of Object.entries(fixture.expect.skipped)) {
        if (skipped[key] !== reason)
          failures.push(`fact ${key}: expected skip ${reason}, got ${skipped[key] ?? "written"}`);
      }
      for (const [key, expected] of Object.entries(fixture.expect.archiveRowsPerTask)) {
        if (rowsPerTask[key] !== expected)
          failures.push(`task ${key}: ${rowsPerTask[key]} archive rows, expected ${expected}`);
      }
      recordSuiteReport({
        suite: "write-hygiene",
        passed: failures.length === 0,
        metrics,
        thresholds: t,
        failures,
        details: { skipped, rowsPerTask },
      });
      expect(failures).toEqual([]);
    } finally {
      await env.close();
    }
  });
});
