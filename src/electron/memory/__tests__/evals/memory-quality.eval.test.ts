import { afterAll, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import fixture from "./fixtures/memory-quality.json";
import { describeEval } from "./memory-eval-harness";
import { flushSuiteReports, recordSuiteReport } from "./memory-eval-metrics";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/cowork-memory-quality", isPackaged: false },
}));
afterAll(flushSuiteReports);

describeEval("memory quality: paired history replay", () => {
  it("improves held-out command probes through the real memory-folder pipeline", async () => {
    const { runMemoryQualityBenchmark } = await import("./memory-quality-benchmark");
    const report = await runMemoryQualityBenchmark(fixture);
    recordSuiteReport({
      suite: "memory-quality",
      passed: report.passed,
      metrics: {
        cases: report.enabled.cases,
        enabledSuccessRate: report.enabled.successRate,
        disabledSuccessRate: report.disabled.successRate,
        successGain: report.successGain,
        recallAt5: report.enabled.recallAt5,
        unsupportedRate: report.enabled.unsupportedRate,
        staleRate: report.enabled.staleRate,
        exposures: report.enabled.exposures,
        meanEstimatedMemoryTokens: report.enabled.meanEstimatedMemoryTokens,
      },
      thresholds: report.thresholds,
      failures: report.failures,
      details: {
        responder: report.responder,
        enabled: report.enabled,
        disabled: report.disabled,
        pairs: report.pairs,
      },
    });
    expect(report.failures, JSON.stringify(report, null, 2)).toEqual([]);
    expect(report.enabled.cases).toBe(fixture.cases.length);
    expect(
      report.pairs.every(
        (pair) =>
          !pair.disabled.context &&
          !pair.disabled.recalled.length &&
          !pair.disabled.estimatedMemoryTokens,
      ),
    ).toBe(true);
    expect(
      report.pairs.find((pair) => pair.id === "current-request-control")?.disabled.command,
    ).toBe("npm run verify:request");
    const pressure = report.pairs.find((pair) => pair.id === "recall-under-budget-pressure")!;
    expect(pressure.enabled.context).not.toContain("npm run verify:budget");
    expect(pressure.enabled.recalled.join("\n")).toContain("npm run verify:budget");
  }, 60000);

  it("keeps answer keys and earlier conversation text out of the responder input", async () => {
    const { replayQualityCase, QualityCorpus, commandSelectionProbe } =
      await import("./memory-quality-benchmark");
    const testCase = QualityCorpus.parse(fixture).cases[0];
    const requests: unknown[] = [];
    const pair = await replayQualityCase(testCase, async (request) => {
      requests.push(request);
      expect(Object.keys(request).sort()).toEqual(["context", "question", "recalled"]);
      expect(JSON.stringify(request)).not.toContain("expectedCommand");
      return commandSelectionProbe(request);
    });
    expect(requests).toHaveLength(2);
    expect(pair.enabled.command).toBe(testCase.expectedCommand);
    expect(pair.disabled.command).toBeNull();
  }, 30000);

  it("rejects malformed corpus definitions and inconsistent answer keys", async () => {
    const { QualityCorpus } = await import("./memory-quality-benchmark");
    expect(QualityCorpus.safeParse({ ...fixture, cases: [] }).success).toBe(false);
    expect(
      QualityCorpus.safeParse({ ...fixture, cases: [fixture.cases[0], fixture.cases[0]] }).success,
    ).toBe(false);
    expect(
      QualityCorpus.safeParse({
        ...fixture,
        cases: [{ ...fixture.cases[0], supportedCommands: [] }],
      }).success,
    ).toBe(false);
  });

  it("does not let a custom responder change the evidence being graded", async () => {
    const { replayQualityCase, QualityCorpus } = await import("./memory-quality-benchmark");
    const pair = await replayQualityCase(QualityCorpus.parse(fixture).cases[0], async (request) => {
      request.context = "forged context";
      request.recalled.push("forged recall");
      return null;
    });
    expect(pair.enabled.context).not.toBe("forged context");
    expect(pair.enabled.recalled).not.toContain("forged recall");
    expect(pair.disabled.recalled).toEqual([]);
  }, 30000);

  it("cleans up temporary repositories and service instances when a responder fails", async () => {
    const { replayQualityCase, QualityCorpus } = await import("./memory-quality-benchmark");
    const { MemoryRepoService } = await import("../../repo/MemoryRepoService");
    let root = "";
    await expect(
      replayQualityCase(QualityCorpus.parse(fixture).cases[0], async () => {
        root = MemoryRepoService.get()!.root;
        throw new Error("probe failure");
      }),
    ).rejects.toThrow("probe failure");
    expect(MemoryRepoService.get()).toBeNull();
    await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30000);
});
