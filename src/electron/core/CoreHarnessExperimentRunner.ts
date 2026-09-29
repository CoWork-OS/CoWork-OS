import {
  CoreEvalCaseRepository,
  CoreFailureClusterRepository,
  CoreHarnessExperimentRepository,
} from "./core-repository-facades";
import { AutomationProfileRepository } from "../agents/agent-repository-facades";
import type {
  CoreHarnessExperiment,
  CoreHarnessExperimentRun,
  CoreRegressionGateResult,
  ReviewCoreExperimentRequest,
  RunCoreExperimentRequest,
} from "../../shared/types";

import { SubconsciousSettingsManager } from "../subconscious/SubconsciousSettingsManager";

import { CoreHarnessExperimentService } from "./CoreHarnessExperimentService";
import { CoreLearningsService } from "./CoreLearningsService";
import { CoreRegressionGateService } from "./CoreRegressionGateService";

export class CoreHarnessExperimentRunner {
  constructor(
    private readonly experimentRepo: CoreHarnessExperimentRepository,
    private readonly experimentService: CoreHarnessExperimentService,
    private readonly clusterRepo: CoreFailureClusterRepository,
    private readonly evalRepo: CoreEvalCaseRepository,
    private readonly automationProfileRepo: AutomationProfileRepository,
    private readonly gateService: CoreRegressionGateService,
    private readonly learnings: CoreLearningsService,
  ) {}

  async run(request: RunCoreExperimentRequest): Promise<{
    experiment: CoreHarnessExperiment;
    run: CoreHarnessExperimentRun;
    gate: CoreRegressionGateResult;
  }> {
    const experiment = await this.resolveExperiment(request);
    if (!experiment) {
      throw new Error("No core harness experiment available for the requested target");
    }
    const cluster = await this.clusterRepo.findById(experiment.clusterId);
    if (!cluster) {
      throw new Error("Core failure cluster not found");
    }
    const linkedEval = await this.evalRepo.findByClusterId(cluster.id);
    const otherEvals = await this.evalRepo.list({
      profileId: cluster.profileId,
      workspaceId: cluster.workspaceId,
      limit: 100,
    });
    const now = Date.now();
    const run = await this.experimentRepo.createRun({
      experimentId: experiment.id,
      status: "running",
      baseline: {
        recurrenceCount: cluster.recurrenceCount,
        clusterStatus: cluster.status,
        linkedEvalStatus: linkedEval?.status || null,
      },
      createdAt: now,
      startedAt: now,
    });
    const gate = await this.gateService.evaluate({
      experimentRunId: run.id,
      cluster,
      experiment,
      linkedEvalCases: otherEvals,
    });
    const outcome = {
      projectedRecurrenceDelta: gate.targetImproved ? -1 : 0,
      regressionsDetected: gate.regressionsDetected,
      passed: gate.passed,
    };
    const completedRun = (await this.experimentRepo.updateRun(run.id, {
      status: gate.passed ? "passed" : "failed",
      outcome,
      gateResultId: gate.id,
      summary: gate.summary,
      completedAt: Date.now(),
    }))!;
    const updatedExperiment = (await this.experimentRepo.updateExperiment(experiment.id, {
      status: gate.passed ? "passed_gate" : "failed_gate",
      summary: gate.summary,
      updatedAt: Date.now(),
    }))!;
    if (linkedEval) {
      await this.evalRepo.recordRun(linkedEval.id, {
        passed: gate.passed,
        summary: gate.summary,
        details: outcome,
      });
    }
    await this.learnings.append({
      profileId: updatedExperiment.profileId,
      workspaceId: updatedExperiment.workspaceId,
      kind: gate.passed ? "experiment" : "gate_rejection",
      summary: gate.summary,
      details: JSON.stringify(outcome),
      relatedClusterId: updatedExperiment.clusterId,
      relatedExperimentId: updatedExperiment.id,
      createdAt: Date.now(),
    });
    if (request.autoPromote && gate.passed) {
      await this.promote({ id: updatedExperiment.id, action: "promote" });
    }
    return {
      experiment: (await this.experimentRepo.findExperimentById(updatedExperiment.id))!,
      run: completedRun,
      gate,
    };
  }

  async review(request: ReviewCoreExperimentRequest): Promise<CoreHarnessExperiment | undefined> {
    if (request.action === "reject") {
      const updated = await this.experimentRepo.updateExperiment(request.id, {
        status: "rejected",
        updatedAt: Date.now(),
      });
      if (updated) {
        await this.learnings.append({
          profileId: updated.profileId,
          workspaceId: updated.workspaceId,
          kind: "gate_rejection",
          summary: "Core harness experiment was rejected before promotion.",
          relatedClusterId: updated.clusterId,
          relatedExperimentId: updated.id,
          createdAt: Date.now(),
        });
      }
      return updated;
    }
    return this.promote(request);
  }

  private async promote(
    request: ReviewCoreExperimentRequest,
  ): Promise<CoreHarnessExperiment | undefined> {
    const experiment = await this.experimentRepo.findExperimentById(request.id);
    if (!experiment) return undefined;
    if (experiment.status !== "passed_gate") {
      throw new Error("Only passed-gate experiments can be promoted");
    }
    if (experiment.changeKind === "automation_profile") {
      await this.automationProfileRepo.update({
        id: experiment.profileId,
        ...(experiment.proposal as Record<string, unknown>),
      } as any);
    } else if (experiment.changeKind === "subconscious_settings") {
      const current = SubconsciousSettingsManager.loadSettings();
      SubconsciousSettingsManager.saveSettings({
        ...current,
        ...(experiment.proposal as Record<string, unknown>),
      } as any);
    } else {
      throw new Error("Memory-policy experiments are review-only in the current phase");
    }
    const updated = await this.experimentRepo.updateExperiment(experiment.id, {
      status: "promoted",
      promotedAt: Date.now(),
      updatedAt: Date.now(),
    });
    if (updated) {
      await this.learnings.append({
        profileId: updated.profileId,
        workspaceId: updated.workspaceId,
        kind: "promotion",
        summary: "Promoted a core harness experiment into live automation settings.",
        relatedClusterId: updated.clusterId,
        relatedExperimentId: updated.id,
        createdAt: Date.now(),
      });
    }
    return updated;
  }

  private async resolveExperiment(
    request: RunCoreExperimentRequest,
  ): Promise<CoreHarnessExperiment | undefined> {
    if (request.experimentId) {
      return this.experimentRepo.findExperimentById(request.experimentId);
    }
    if (!request.clusterId) return undefined;
    const existing = await this.experimentRepo.listExperiments({
      clusterId: request.clusterId,
      limit: 20,
    });
    if (existing.length > 0) {
      return existing[0];
    }
    return (await this.experimentService.proposeExperimentsForCluster(request.clusterId))[0];
  }
}
