import type {
  CoreEvalCase,
  CoreFailureCluster,
  CoreHarnessExperiment,
  CoreRegressionGateResult,
} from "../../shared/types";
import { CoreRegressionGateRepository } from "./CoreRegressionGateRepository";

export class CoreRegressionGateService {
  constructor(private readonly repo: CoreRegressionGateRepository) {}

  evaluate(params: {
    experimentRunId: string;
    cluster: CoreFailureCluster;
    experiment: CoreHarnessExperiment;
    linkedEvalCases: CoreEvalCase[];
  }): CoreRegressionGateResult {
    const regressions: string[] = [];
    const proposal = params.experiment.proposal || {};
    let targetImproved = false;

    switch (params.cluster.category) {
      case "dispatch_underreach":
        targetImproved =
          typeof proposal.cadenceMinutes === "number" ||
          typeof proposal.dispatchCooldownMinutes === "number";
        break;
      case "dispatch_overreach":
      case "cooldown_policy_mismatch":
      case "budget_policy_mismatch":
      case "wake_timing":
        targetImproved =
          typeof proposal.dispatchCooldownMinutes === "number" ||
          typeof proposal.maxDispatchesPerDay === "number" ||
          typeof proposal.cadenceMinutes === "number";
        break;
      case "subconscious_low_signal":
      case "subconscious_duplication":
        targetImproved = params.experiment.changeKind === "subconscious_settings";
        break;
      case "memory_noise":
      case "memory_staleness":
        regressions.push("memory_policy_not_promotable_yet");
        targetImproved = false;
        break;
      default:
        targetImproved = false;
    }

    if (
      typeof proposal.cadenceMinutes === "number" &&
      (proposal.cadenceMinutes < 5 || proposal.cadenceMinutes > 24 * 60)
    ) {
      regressions.push("cadence_out_of_bounds");
    }
    if (
      typeof proposal.dispatchCooldownMinutes === "number" &&
      (proposal.dispatchCooldownMinutes < 15 || proposal.dispatchCooldownMinutes > 24 * 60)
    ) {
      regressions.push("cooldown_out_of_bounds");
    }
    if (
      typeof proposal.maxDispatchesPerDay === "number" &&
      (proposal.maxDispatchesPerDay < 1 || proposal.maxDispatchesPerDay > 50)
    ) {
      regressions.push("dispatch_budget_out_of_bounds");
    }
    if (params.linkedEvalCases.some((item) => item.status === "failing")) {
      regressions.push("existing_eval_case_failing");
    }

    const passed = targetImproved && regressions.length === 0;
    return this.repo.create({
      experimentRunId: params.experimentRunId,
      passed,
      targetImproved,
      regressionsDetected: regressions,
      summary: passed
        ? "Experiment improved the target cluster without triggering regression guards."
        : targetImproved
          ? `Experiment triggered regression guard: ${regressions.join(", ")}`
          : "Experiment did not show enough targeted improvement to pass the gate.",
      details: {
        clusterId: params.cluster.id,
        clusterCategory: params.cluster.category,
        evalCaseIds: params.linkedEvalCases.map((item) => item.id),
        proposal,
      },
      createdAt: Date.now(),
    });
  }
}
