import type {
  AutomationProfile,
  CoreFailureCluster,
  CoreHarnessExperiment,
  CoreExperimentChangeKind,
  ListCoreExperimentsRequest,
} from "../../shared/types";
import { AutomationProfileRepository } from "../agents/AutomationProfileRepository";
import { SubconsciousSettingsManager } from "../subconscious/SubconsciousSettingsManager";
import { CoreFailureClusterRepository } from "./CoreFailureClusterRepository";
import { CoreHarnessExperimentRepository } from "./CoreHarnessExperimentRepository";

export class CoreHarnessExperimentService {
  constructor(
    private readonly clusterRepo: CoreFailureClusterRepository,
    private readonly experimentRepo: CoreHarnessExperimentRepository,
    private readonly automationProfileRepo: AutomationProfileRepository,
  ) {}

  listExperiments(request: ListCoreExperimentsRequest = {}) {
    return this.experimentRepo.listExperiments(request);
  }

  proposeExperimentsForCluster(clusterId: string): CoreHarnessExperiment[] {
    const cluster = this.clusterRepo.findById(clusterId);
    if (!cluster) return [];
    const existing = this.experimentRepo.listExperiments({
      clusterId,
      limit: 20,
    });
    if (existing.some((item) => ["proposed", "running", "passed_gate"].includes(item.status))) {
      return existing;
    }
    const profile = this.automationProfileRepo.findById(cluster.profileId);
    if (!profile) return [];

    const proposal = this.buildProposal(cluster, profile);
    if (!proposal) return [];
    const now = Date.now();
    const experiment = this.experimentRepo.createExperiment({
      profileId: cluster.profileId,
      workspaceId: cluster.workspaceId,
      clusterId: cluster.id,
      changeKind: proposal.changeKind,
      proposal: proposal.proposal,
      status: "proposed",
      summary: proposal.summary,
      createdAt: now,
      updatedAt: now,
    });
    this.clusterRepo.update(cluster.id, {
      linkedExperimentId: experiment.id,
      updatedAt: now,
    });
    return [experiment];
  }

  private buildProposal(
    cluster: CoreFailureCluster,
    profile: AutomationProfile,
  ): {
    changeKind: CoreExperimentChangeKind;
    proposal: Record<string, unknown>;
    summary: string;
  } | null {
    switch (cluster.category) {
      case "wake_timing":
      case "cooldown_policy_mismatch":
        return {
          changeKind: "automation_profile",
          proposal: {
            dispatchCooldownMinutes: Math.min(profile.dispatchCooldownMinutes + 30, 24 * 60),
            cadenceMinutes: Math.min(profile.cadenceMinutes + 15, 24 * 60),
          },
          summary: "Slow the heartbeat slightly and widen cooldown to reduce timing mismatches.",
        };
      case "dispatch_underreach":
        return {
          changeKind: "automation_profile",
          proposal: {
            cadenceMinutes: Math.max(profile.cadenceMinutes - 5, 5),
            dispatchCooldownMinutes: Math.max(profile.dispatchCooldownMinutes - 15, 15),
          },
          summary: "Make the operator more responsive by tightening cadence and cooldown.",
        };
      case "dispatch_overreach":
      case "budget_policy_mismatch":
        return {
          changeKind: "automation_profile",
          proposal: {
            dispatchCooldownMinutes: Math.min(profile.dispatchCooldownMinutes + 45, 24 * 60),
            maxDispatchesPerDay: Math.max(1, profile.maxDispatchesPerDay - 1),
          },
          summary: "Reduce dispatch pressure and daily volume to prevent overreach.",
        };
      case "subconscious_low_signal": {
        const settings = SubconsciousSettingsManager.loadSettings();
        return {
          changeKind: "subconscious_settings",
          proposal: {
            autonomyMode: "recommendation_first",
            maxHypothesesPerRun: Math.max(3, Math.min(settings.maxHypothesesPerRun, 3)),
          },
          summary:
            "Bias subconscious decisions toward recommendation-first mode for lower-risk outputs.",
        };
      }
      case "subconscious_duplication": {
        const settings = SubconsciousSettingsManager.loadSettings();
        return {
          changeKind: "subconscious_settings",
          proposal: {
            maxHypothesesPerRun: Math.max(3, settings.maxHypothesesPerRun - 1),
            dispatchDefaults: {
              ...settings.dispatchDefaults,
              autoDispatch: false,
            },
          },
          summary:
            "Reduce duplicate subconscious actions by lowering fan-out and preferring explicit review.",
        };
      }
      case "memory_noise":
      case "memory_staleness":
        return {
          changeKind: "memory_policy",
          proposal: {
            reviewOnly: true,
            category: cluster.category,
          },
          summary:
            "Memory-policy issue detected; this requires review-only handling in the current phase.",
        };
      default:
        return null;
    }
  }
}
