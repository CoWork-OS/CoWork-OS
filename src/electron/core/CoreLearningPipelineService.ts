import { CoreEvalCaseService } from "./CoreEvalCaseService";
import { CoreFailureClusterService } from "./CoreFailureClusterService";
import { CoreFailureMiningService } from "./CoreFailureMiningService";
import { CoreHarnessExperimentService } from "./CoreHarnessExperimentService";
import { CoreLearningsService } from "./CoreLearningsService";

export class CoreLearningPipelineService {
  constructor(
    private readonly failureMining: CoreFailureMiningService,
    private readonly clusterService: CoreFailureClusterService,
    private readonly evalService: CoreEvalCaseService,
    private readonly experimentService: CoreHarnessExperimentService,
    private readonly learnings: CoreLearningsService,
  ) {}

  processTrace(traceId: string): void {
    const failures = this.failureMining.mineTrace(traceId);
    for (const failure of failures) {
      const cluster = this.clusterService.upsertClusterForRecord(failure);
      this.learnings.append({
        profileId: cluster.profileId,
        workspaceId: cluster.workspaceId,
        kind: "failure_cluster",
        summary: `Observed recurring core failure candidate: ${cluster.rootCauseSummary}`,
        relatedClusterId: cluster.id,
        createdAt: Date.now(),
      });
      const evalCases = this.evalService.syncEvalCasesForProfile(cluster.profileId, cluster.workspaceId);
      if (evalCases.some((item) => item.clusterId === cluster.id)) {
        this.learnings.append({
          profileId: cluster.profileId,
          workspaceId: cluster.workspaceId,
          kind: "eval_case",
          summary: `Maintained living eval coverage for ${cluster.category.replace(/_/g, " ")}.`,
          relatedClusterId: cluster.id,
          createdAt: Date.now(),
        });
      }
      this.experimentService.proposeExperimentsForCluster(cluster.id);
    }
  }
}
