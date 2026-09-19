import { describe, expect, it, vi } from "vitest";
import type { DecisionRequestOptions, JevRequest, JevResponse } from "../../decisions";
import {
  BROWSER_ACTION_DECISION_QUESTION_IDS,
  selectBrowserActions,
  type BrowserActionCandidate,
  type BrowserActionDecisionCallback,
  type BrowserActionSelectorInput,
} from "../browser-action-decision";

const snapshot = { identity: "tab-1", digest: "digest-1" } as const;

function candidate(
  action: Record<string, unknown>,
  overrides: Partial<BrowserActionCandidate> = {},
): BrowserActionCandidate {
  return {
    action,
    snapshot,
    ...overrides,
  };
}

function response(
  choice: string,
  indexes: readonly number[] = [0, 1],
  values: Partial<{
    choiceConfidence: number;
    choiceProbability: number;
    stateSufficient: number;
    snapshotCurrent: number;
    sensitiveAction: number;
    destructiveAction: number;
    candidateProbabilities: Record<number, number>;
  }> = {},
): JevResponse {
  const candidateProbabilities = values.candidateProbabilities ?? {};
  return {
    model: "jev-test",
    answers: {
      [BROWSER_ACTION_DECISION_QUESTION_IDS.action]: {
        type: "choice",
        choice,
        probabilities: { [choice]: values.choiceProbability ?? 0.96 },
        confidence: values.choiceConfidence ?? 0.95,
      },
      [BROWSER_ACTION_DECISION_QUESTION_IDS.stateSufficient]: {
        type: "noul",
        noul: values.stateSufficient ?? 0.95,
      },
      [BROWSER_ACTION_DECISION_QUESTION_IDS.snapshotCurrent]: {
        type: "noul",
        noul: values.snapshotCurrent ?? 1,
      },
      [BROWSER_ACTION_DECISION_QUESTION_IDS.sensitiveAction]: {
        type: "noul",
        noul: values.sensitiveAction ?? 0.01,
      },
      [BROWSER_ACTION_DECISION_QUESTION_IDS.destructiveAction]: {
        type: "noul",
        noul: values.destructiveAction ?? 0.01,
      },
      ...Object.fromEntries(
        indexes.map((index) => [
          `include_${index}`,
          { type: "noul", noul: candidateProbabilities[index] ?? (index === 0 ? 0.95 : 0.05) },
        ]),
      ),
    },
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function input(
  provider: BrowserActionDecisionCallback,
  candidates: readonly BrowserActionCandidate[] = [
    candidate({ kind: "click", ref: "button-save" }),
    candidate({ kind: "fill", ref: "search", value: "invoices" }),
  ],
  options?: BrowserActionSelectorInput["options"],
): BrowserActionSelectorInput {
  return { provider, candidates, snapshot, options };
}

describe("Jev browser action selector", () => {
  it("selects a valid bounded allowlist of original indexes", async () => {
    let request: JevRequest | undefined;
    const provider = vi.fn(async (value: JevRequest, _options?: DecisionRequestOptions) => {
      request = value;
      return response("candidate_7", [4, 7], { candidateProbabilities: { 4: 0.05, 7: 0.96 } });
    });
    const candidates = [
      candidate({ kind: "click", ref: "button-save" }, { index: 4 }),
      candidate({ kind: "fill", ref: "search", value: "invoices" }, { index: 7 }),
    ];

    await expect(selectBrowserActions(input(provider, candidates))).resolves.toEqual({
      status: "selected",
      allowedCandidateIndexes: [7],
    });
    expect(candidates[1]?.action).toEqual({ kind: "fill", ref: "search", value: "invoices" });
    expect(request?.questions[BROWSER_ACTION_DECISION_QUESTION_IDS.action].type).toBe("choice");
    expect(request?.questions.include_7?.type).toBe("noul");
    if (!request) throw new Error("The provider request was not captured.");
    const stateCandidates = (request.state as { candidates: Array<{ action: unknown }> })
      .candidates;
    expect(stateCandidates[1]?.action).toEqual({
      kind: "fill",
      ref: "search",
      value: "invoices",
    });
    expect(stateCandidates[1]?.action).not.toBe(candidates[1]?.action);
  });

  it("abstains for missing or stale snapshot bindings", async () => {
    const provider = vi.fn(async () => response("candidate_0"));
    const stale = await selectBrowserActions(
      input(provider, [
        candidate(
          { kind: "click", ref: "button" },
          {
            snapshot: { identity: "tab-1", digest: "old-digest" },
          },
        ),
      ]),
    );
    expect(stale).toEqual({
      status: "abstain",
      allowedCandidateIndexes: [],
      reason: "stale_snapshot",
    });

    const missing = await selectBrowserActions(
      input(provider, [{ action: { kind: "click", ref: "button" } } as BrowserActionCandidate]),
    );
    expect(missing).toEqual({
      status: "abstain",
      allowedCandidateIndexes: [],
      reason: "missing_snapshot",
    });
    expect(provider).not.toHaveBeenCalled();

    const missingInputSnapshot = await selectBrowserActions({
      ...input(provider),
      snapshot: undefined,
    } as unknown as BrowserActionSelectorInput);
    expect(missingInputSnapshot).toMatchObject({ status: "abstain", reason: "missing_snapshot" });
  });

  it("rejects invalid or invented candidate indexes", async () => {
    const provider = vi.fn(async () => response("candidate_99", [0]));

    await expect(selectBrowserActions(input(provider))).resolves.toEqual({
      status: "abstain",
      allowedCandidateIndexes: [],
      reason: "invalid_decision",
    });
  });

  it("abstains when the injected provider fails", async () => {
    const provider = vi.fn(async () => {
      throw new Error("upstream unavailable");
    });

    await expect(selectBrowserActions(input(provider))).resolves.toEqual({
      status: "abstain",
      allowedCandidateIndexes: [],
      reason: "provider_failure",
    });
  });

  it.each([
    ["sensitive_action", { sensitive: true }],
    ["destructive_action", { destructive: true }],
  ] as const)("abstains from explicitly marked %s actions", async (reason, flags) => {
    const provider = vi.fn(async () => response("candidate_0"));
    const result = await selectBrowserActions(
      input(provider, [candidate({ kind: "click", ref: "danger" }, flags)]),
    );

    expect(result).toEqual({
      status: "abstain",
      allowedCandidateIndexes: [],
      reason,
    });
    expect(provider).not.toHaveBeenCalled();
  });

  it("abstains when Jev's Noul safety assessment is above threshold", async () => {
    const provider = vi.fn(async () => response("candidate_0", [0, 1], { sensitiveAction: 0.8 }));

    await expect(selectBrowserActions(input(provider))).resolves.toMatchObject({
      status: "abstain",
      reason: "sensitive_action",
    });
  });

  it("honors cancellation and bounds provider time", async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    const provider = vi.fn(async () => response("candidate_0"));
    await expect(
      selectBrowserActions(input(provider, undefined, { signal: cancelled.signal })),
    ).resolves.toMatchObject({ status: "abstain", reason: "cancelled" });
    expect(provider).not.toHaveBeenCalled();

    const pending = vi.fn(
      async (_request: JevRequest, options?: DecisionRequestOptions) =>
        new Promise<JevResponse>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    await expect(
      selectBrowserActions(input(pending, undefined, { timeoutMs: 5 })),
    ).resolves.toMatchObject({ status: "abstain", reason: "timeout" });
  });
});
