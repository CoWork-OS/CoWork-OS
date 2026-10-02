import { describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor";
import { maybeApplyQualityPasses } from "../executor-llm-turn-utils";

describe("maybeApplyQualityPasses", () => {
  it("keeps the original response when the quality pass result is not accepted", async () => {
    const response = {
      stopReason: "end_turn",
      content: [{ type: "text", text: "Original draft" }],
    };

    const result = await maybeApplyQualityPasses({
      response,
      enabled: true,
      contextLabel: "follow-up 2",
      userIntent: "Review again",
      getQualityPassCount: () => 2,
      extractTextFromLLMContent: (content) =>
        (content || [])
          .filter((item: Any) => item.type === "text")
          .map((item: Any) => item.text)
          .join("\n"),
      applyQualityPassesToDraft: vi.fn(async () => ({
        text: 'to=run_command {"command":"git status --short"}',
        accepted: false,
      })),
    });

    expect(result).toBe(response);
  });

  it("replaces the response when the quality pass result is accepted", async () => {
    const response = {
      stopReason: "end_turn",
      content: [{ type: "text", text: "Original draft" }],
    };

    const result = await maybeApplyQualityPasses({
      response,
      enabled: true,
      contextLabel: "follow-up 2",
      userIntent: "Review again",
      getQualityPassCount: () => 2,
      extractTextFromLLMContent: (content) =>
        (content || [])
          .filter((item: Any) => item.type === "text")
          .map((item: Any) => item.text)
          .join("\n"),
      applyQualityPassesToDraft: vi.fn(async () => ({
        text: "Improved draft",
        accepted: true,
      })),
    });

    expect(result).not.toBe(response);
    expect(result.content).toEqual([{ type: "text", text: "Improved draft" }]);
    expect(result.stopReason).toBe("end_turn");
  });
});

describe("maybeApplyQualityPasses guards", () => {
  const extractText = (content: Any) =>
    (content || [])
      .filter((item: Any) => item.type === "text")
      .map((item: Any) => item.text)
      .join("\n");
  const draft = [
    "The import job failed for 2 of 14 files because the CSV header changed.",
    "Fix applied in src/importers/csv-reader.ts and documented at https://example.com/runbook#csv.",
    "Rerun with `npm run import -- --since 2026-09-30` to backfill 1,250 rows.",
  ].join("\n");
  const run = (
    text: string,
    rewrite: string,
    overrides: Partial<Parameters<typeof maybeApplyQualityPasses>[0]> = {},
  ) => {
    const response = { stopReason: "end_turn", content: [{ type: "text", text }] };
    const applyQualityPassesToDraft = vi.fn(async () => ({ text: rewrite, accepted: true }));
    const result = maybeApplyQualityPasses({
      response,
      enabled: true,
      contextLabel: "step:3 Summarize",
      userIntent: "Summarize the import fix",
      getQualityPassCount: () => 2,
      extractTextFromLLMContent: extractText,
      applyQualityPassesToDraft,
      ...overrides,
    });
    return { response, result, applyQualityPassesToDraft };
  };

  it("skips quality passes for follow-up replies", async () => {
    const { response, result, applyQualityPassesToDraft } = run(draft, `${draft}\nPolished.`, {
      phase: "follow_up",
    });

    expect(await result).toBe(response);
    expect(applyQualityPassesToDraft).not.toHaveBeenCalled();
  });

  it("skips drafts longer than about 1,000 tokens", async () => {
    const longDraft = Array.from(
      { length: 120 },
      (_, index) => `Finding ${index + 1}: the importer skipped malformed rows in batch ${index}.`,
    ).join("\n");
    expect(longDraft.length / 4).toBeGreaterThan(1_000);

    const { response, result, applyQualityPassesToDraft } = run(longDraft, longDraft);

    expect(await result).toBe(response);
    expect(applyQualityPassesToDraft).not.toHaveBeenCalled();
  });

  it("budgets the rewrite to at least 1.3x the draft's tokens", async () => {
    const mediumDraft = `${draft}\n${"Additional verified context for the operator. ".repeat(60)}`;
    const draftTokens = Math.ceil(mediumDraft.length / 4);
    expect(draftTokens).toBeLessThanOrEqual(1_000);

    const { result, applyQualityPassesToDraft } = run(mediumDraft, mediumDraft);
    await result;

    expect(applyQualityPassesToDraft).toHaveBeenCalledTimes(1);
    const args = applyQualityPassesToDraft.mock.calls[0]?.[0] as Any;
    expect(args.maxTokens).toBeGreaterThanOrEqual(Math.ceil(draftTokens * 1.3));
  });

  it("keeps the draft when the rewrite is much shorter", async () => {
    const condensed =
      "Import failed for 2 of 14 files; fixed in src/importers/csv-reader.ts (https://example.com/runbook#csv). Rerun to backfill 1,250 rows since 2026-09-30.";
    expect(condensed.length).toBeLessThan(draft.length * 0.7);

    const { response, result } = run(draft, condensed);

    expect(await result).toBe(response);
  });

  it.each([
    ["a file path", "src/importers/csv-reader.ts", "the CSV reader"],
    ["a URL", "https://example.com/runbook#csv", "the runbook"],
    ["a number", "1,250 rows", "the missing rows"],
  ])("keeps the draft when the rewrite drops %s", async (_label, original, replacement) => {
    const rewrite = draft.replace(original, replacement);
    expect(rewrite).not.toBe(draft);

    const { response, result } = run(draft, rewrite);

    expect(await result).toBe(response);
  });

  it("accepts a rewrite that keeps the draft's length and details", async () => {
    const rewrite = [
      "**Import job:** 2 of 14 files failed because the CSV header changed.",
      "**Fix:** applied in src/importers/csv-reader.ts; see https://example.com/runbook#csv.",
      "**Next:** run `npm run import -- --since 2026-09-30` to backfill 1,250 rows.",
    ].join("\n");

    const { response, result } = run(draft, rewrite);
    const improved = await result;

    expect(improved).not.toBe(response);
    expect(improved.content).toEqual([{ type: "text", text: rewrite }]);
  });
});

describe("TaskExecutor quality refine calls", () => {
  it("passes the draft-sized token budget and retries at most once", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.modelId = "model-1";
    executor.logTag = "[test]";
    executor.task = { id: "task-1", title: "Task", prompt: "Prompt", agentConfig: {} };
    executor.checkBudgets = vi.fn();
    executor.resolveResearchPhaseProvider = vi.fn(() => ({ provider: {}, modelId: "model-1" }));
    executor.maybeEmitResearchWorkflowPhase = vi.fn();
    executor.updateTracking = vi.fn();
    executor.createMessageWithTimeout = vi.fn(async () => ({
      stopReason: "end_turn",
      content: [{ type: "text", text: "Polished answer with the same details." }],
    }));
    executor.callLLMWithRetry = vi.fn(async (requestFn: () => Promise<Any>) => requestFn());

    const result = await executor.applyQualityPassesToDraft({
      passes: 2,
      contextLabel: "step:1 Summarize",
      userIntent: "Summarize",
      draft: "Draft answer with the same details.",
      maxTokens: 2_100,
    });

    expect(result.accepted).toBe(true);
    expect(executor.callLLMWithRetry).toHaveBeenCalledWith(
      expect.any(Function),
      "Quality refine (step:1 Summarize)",
      1,
    );
    expect(executor.createMessageWithTimeout.mock.calls[0]?.[0]).toMatchObject({
      maxTokens: 2_100,
    });
  });
});
