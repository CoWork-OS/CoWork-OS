import type Database from "better-sqlite3";
import { EvalService } from "../eval/EvalService";
import { TaskEventRepository, TaskRepository } from "../database/repositories";
import type {
  EvalBaselineMetrics,
  ImprovementCampaign,
  ImprovementJudgeVerdict,
  ImprovementReplayCase,
  ImprovementVariantArtifactSummary,
  ImprovementVariantEvaluation,
  ImprovementVariantRun,
  Task,
} from "../../shared/types";

export class ExperimentEvaluationService {
  private readonly evalService: EvalService;
  private readonly taskRepo: TaskRepository;
  private readonly eventRepo: TaskEventRepository;

  constructor(private readonly db: Database.Database) {
    this.evalService = new EvalService(db);
    this.taskRepo = new TaskRepository(db);
    this.eventRepo = new TaskEventRepository(db);
  }

  snapshot(windowDays: number): EvalBaselineMetrics {
    return this.evalService.getBaselineMetrics(windowDays);
  }

  evaluateVariant(params: {
    variant: ImprovementVariantRun;
    baselineMetrics: EvalBaselineMetrics;
    evalWindowDays: number;
    replayCases: ImprovementReplayCase[];
    maxPatchFiles?: number;
  }): ImprovementVariantEvaluation {
    const task = params.variant.taskId ? this.taskRepo.findById(params.variant.taskId) : undefined;
    const events = task ? this.eventRepo.findByTaskId(task.id) : [];
    const artifactSummary = extractArtifactSummary(task, params.maxPatchFiles || 8);

    const verificationPassed = events.some(
      (event) => event.legacyType === "verification_passed" || event.type === "verification_passed",
    );
    const verificationFailed = events.some(
      (event) => event.legacyType === "verification_failed" || event.type === "verification_failed",
    );
    const reviewFailed = events.some(
      (event) =>
        event.legacyType === "review_quality_failed" || event.type === "review_quality_failed",
    );

    const reproductionEvidenceFound = Boolean(artifactSummary.reproductionMethod);
    const verificationEvidenceFound =
      artifactSummary.verificationCommands.length > 0 || verificationPassed;
    const prReadinessEvidenceFound = artifactSummary.prReadiness === "ready";

    const targetedVerificationPassed =
      !!task &&
      task.status === "completed" &&
      task.terminalStatus === "ok" &&
      verificationPassed &&
      !verificationFailed &&
      !reviewFailed &&
      reproductionEvidenceFound &&
      verificationEvidenceFound;
    const promotable = targetedVerificationPassed && prReadinessEvidenceFound;
    const failureClassResolved =
      !!task &&
      task.failureClass !== "required_verification" &&
      task.failureClass !== "contract_error";
    const regressionSignals = collectRegressionSignals(
      task,
      verificationFailed,
      reviewFailed,
      reproductionEvidenceFound,
      verificationEvidenceFound,
      prReadinessEvidenceFound,
    );
    const replayPassRate = computeReplayPassRate(params.replayCases, task, regressionSignals);
    const diffSizePenalty = estimateDiffSizePenalty(task);
    const safetySignals = collectSafetySignals(
      artifactSummary,
      diffSizePenalty,
      params.maxPatchFiles || 8,
    );

    let score = 0;
    if (targetedVerificationPassed) score += 0.45;
    if (verificationPassed) score += 0.1;
    if (failureClassResolved) score += 0.15;
    // Small incremental bonus for PR-readiness after the targeted verification gate already cleared.
    if (promotable) score += 0.05;
    score += replayPassRate * 0.25;
    score -= diffSizePenalty;
    score -= Math.min(regressionSignals.length, 3) * 0.1;
    score -= Math.min(safetySignals.length, 2) * 0.05;
    score = Number(Math.max(0, Math.min(1, score)).toFixed(4));

    const notes = [
      `Task status: ${task?.status || "missing"}${task?.terminalStatus ? ` (${task.terminalStatus})` : ""}`,
      `Targeted verification: ${targetedVerificationPassed ? "passed" : "failed"}`,
      `Promotable: ${promotable ? "yes" : "no"}`,
      `Replay pass rate: ${Math.round(replayPassRate * 100)}%`,
    ];
    if (artifactSummary.reproductionMethod)
      notes.push(`Reproduction method: ${artifactSummary.reproductionMethod}`);
    if (artifactSummary.changedFiles.length > 0) {
      notes.push(`Changed files: ${artifactSummary.changedFiles.join(", ")}`);
    }
    if (artifactSummary.verificationCommands.length > 0) {
      notes.push(`Verification commands: ${artifactSummary.verificationCommands.join(" | ")}`);
    }
    if (task?.resultSummary) notes.push(`Summary: ${task.resultSummary.slice(0, 400)}`);
    for (const signal of regressionSignals) notes.push(signal);
    for (const signal of safetySignals) notes.push(signal);

    return {
      variantId: params.variant.id,
      lane: params.variant.lane,
      score,
      targetedVerificationPassed,
      verificationPassed,
      promotable,
      reproductionEvidenceFound,
      verificationEvidenceFound,
      prReadinessEvidenceFound,
      regressionSignals,
      safetySignals,
      failureClassResolved,
      replayPassRate,
      diffSizePenalty,
      artifactSummary,
      summary: promotable
        ? "Variant passed targeted checks and is promotable."
        : targetedVerificationPassed
          ? "Variant passed targeted checks but is missing promotability evidence."
          : "Variant failed targeted checks or triggered regression signals.",
      notes,
    };
  }

  evaluateCampaign(params: {
    campaign: ImprovementCampaign;
    variants: ImprovementVariantRun[];
    evalWindowDays: number;
  }): {
    verdict: ImprovementJudgeVerdict;
    outcomeMetrics: EvalBaselineMetrics;
    winner?: ImprovementVariantEvaluation;
    evaluations: ImprovementVariantEvaluation[];
  } {
    const evaluations = params.variants.map((variant) =>
      this.evaluateVariant({
        variant,
        baselineMetrics: params.campaign.baselineMetrics || this.snapshot(params.evalWindowDays),
        evalWindowDays: params.evalWindowDays,
        replayCases: params.campaign.replayCases,
        maxPatchFiles: 8,
      }),
    );
    evaluations.sort((a, b) => b.score - a.score);

    const winner = evaluations.find(
      (candidate) =>
        candidate.targetedVerificationPassed &&
        candidate.verificationPassed &&
        candidate.promotable &&
        candidate.replayPassRate >= 0.5 &&
        candidate.regressionSignals.length === 0 &&
        candidate.safetySignals.length === 0,
    );

    const verdict: ImprovementJudgeVerdict = {
      id: `judge-${params.campaign.id}`,
      campaignId: params.campaign.id,
      winnerVariantId: winner?.variantId,
      status: winner ? "passed" : "failed",
      summary: winner
        ? `Selected ${winner.lane} as the campaign winner.`
        : "No variant cleared targeted verification and holdout replay gates.",
      notes: evaluations.flatMap((evaluation) => [
        `${evaluation.variantId} (${evaluation.lane}) score=${evaluation.score}`,
        ...evaluation.notes,
      ]),
      comparedAt: Date.now(),
      variantRankings: evaluations.map((evaluation) => ({
        variantId: evaluation.variantId,
        score: evaluation.score,
        lane: evaluation.lane,
      })),
      replayCases: params.campaign.replayCases,
    };

    return {
      verdict,
      outcomeMetrics: this.snapshot(params.evalWindowDays),
      winner,
      evaluations,
    };
  }
}

function collectRegressionSignals(
  task: Task | undefined,
  verificationFailed: boolean,
  reviewFailed: boolean,
  reproductionEvidenceFound: boolean,
  verificationEvidenceFound: boolean,
  prReadinessEvidenceFound: boolean,
): string[] {
  const signals: string[] = [];
  if (!task) {
    signals.push("Task record missing during evaluation.");
    return signals;
  }
  if (task.status !== "completed") signals.push("Task did not complete successfully.");
  if (task.terminalStatus !== "ok")
    signals.push(`Task terminal status is ${task.terminalStatus || "missing"}.`);
  if (verificationFailed) signals.push("Verification failed event recorded.");
  if (reviewFailed) signals.push("Review quality failure recorded.");
  if (!reproductionEvidenceFound)
    signals.push("Task did not report a concrete reproduction method.");
  if (!verificationEvidenceFound)
    signals.push("Task did not report explicit verification evidence.");
  if (!prReadinessEvidenceFound) signals.push("Task did not report PR-readiness evidence.");
  if (/regress|broke|still failing|unable|cannot/i.test(String(task.resultSummary || ""))) {
    signals.push("Result summary suggests unresolved or regressed behavior.");
  }
  return signals;
}

export function collectSafetySignals(
  artifactSummary: ImprovementVariantArtifactSummary,
  diffSizePenalty: number,
  maxPatchFiles: number,
): string[] {
  const signals: string[] = [];
  if (artifactSummary.prReadiness === "ready" && artifactSummary.changedFiles.length === 0) {
    signals.push("PR readiness was declared without a changed-files summary.");
  }
  if (artifactSummary.changedFiles.length > maxPatchFiles) {
    signals.push(
      `Patch scope exceeded the expected file cap (${artifactSummary.changedFiles.length}/${maxPatchFiles}).`,
    );
  }
  if (diffSizePenalty >= 0.12) {
    signals.push("Patch appears larger than expected for a bounded self-improvement run.");
  }
  return signals;
}

function computeReplayPassRate(
  replayCases: ImprovementReplayCase[],
  task: Task | undefined,
  regressionSignals: string[],
): number {
  if (!task) return 0;
  if (replayCases.length === 0) return regressionSignals.length === 0 ? 1 : 0.5;
  const resultText = `${task.resultSummary || ""} ${task.error || ""}`.toLowerCase();
  let passed = 0;
  for (const item of replayCases) {
    const summary = item.summary.toLowerCase();
    const matched =
      summary.length > 0 &&
      (resultText.includes(summary.slice(0, Math.min(summary.length, 32))) ||
        regressionSignals.every((signal) => !signal.toLowerCase().includes(summary.slice(0, 16))));
    if (matched) passed += 1;
  }
  return Number((passed / replayCases.length).toFixed(4));
}

function estimateDiffSizePenalty(task: Task | undefined): number {
  if (!task?.resultSummary) return 0.05;
  const len = task.resultSummary.length;
  if (len <= 240) return 0.02;
  if (len <= 700) return 0.06;
  return 0.12;
}

export function extractArtifactSummary(
  task: Task | undefined,
  maxPatchFiles: number,
): ImprovementVariantArtifactSummary {
  const text = `${task?.resultSummary || ""}\n${task?.error || ""}`;
  const reproductionMatch = text.match(/reproduction method\s*:\s*([^\n]+)/i);
  const rootCauseMatch = text.match(/root cause\s*:\s*([^\n]+)/i);
  const changedFilesMatch = text.match(/changed files summary\s*:\s*([^\n]+)/i);
  const verificationMatch = text.match(/verification(?: commands?)?\s*:\s*([^\n]+)/i);

  const changedFilesRaw = changedFilesMatch?.[1] || "";
  const changedFiles = changedFilesRaw
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter((item) => /[./\\]/.test(item) || /\.(ts|tsx|js|jsx|json|md|css|scss)$/i.test(item))
    .slice(0, maxPatchFiles + 5);

  const fallbackVerificationCommands = [
    ...text.matchAll(/((?:npm|pnpm|yarn|bun)\s+(?:test|run\s+[\w:-]+))/gi),
  ]
    .map((match) => match[1]?.trim() || "")
    .filter(Boolean);

  const verificationCommands = verificationMatch?.[1]
    ? verificationMatch[1]
        .split(/[;|]/)
        .map((item) => item.trim())
        .filter(Boolean)
    : [...new Set(fallbackVerificationCommands)];

  const prReadiness =
    /pr readiness\s*:\s*ready/i.test(text) || /ready\s*(for|to)\s*(pr|review)/i.test(text)
      ? "ready"
      : /pr readiness\s*:\s*not ready/i.test(text) || /not ready/i.test(text)
        ? "not_ready"
        : "unknown";

  const summary: ImprovementVariantArtifactSummary = {
    reproductionMethod:
      reproductionMatch?.[1]?.trim() ||
      (/reproduced\s+(the\s+)?(failure|issue|bug)/i.test(text)
        ? "Reproduced from task evidence."
        : undefined),
    changedFiles,
    verificationCommands,
    prReadiness,
    rootCauseSummary: rootCauseMatch?.[1]?.trim(),
    missingEvidence: [],
  };

  if (!summary.reproductionMethod) summary.missingEvidence.push("reproduction_method");
  if (summary.verificationCommands.length === 0)
    summary.missingEvidence.push("verification_commands");
  if (summary.prReadiness === "unknown") summary.missingEvidence.push("pr_readiness");

  return summary;
}
