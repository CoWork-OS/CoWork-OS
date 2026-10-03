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

  async processTrace(traceId: string): Promise<void> {
    const failures = await this.failureMining.mineTrace(traceId);
    for (const failure of failures) {
      const cluster = await this.clusterService.upsertClusterForRecord(failure);
      await this.learnings.appendIfNovel({
        profileId: cluster.profileId,
        workspaceId: cluster.workspaceId,
        kind: "failure_cluster",
        summary: `Observed recurring core failure candidate: ${cluster.rootCauseSummary}`,
        relatedClusterId: cluster.id,
        createdAt: Date.now(),
      });
      const evalCases = await this.evalService.syncEvalCasesForProfile(
        cluster.profileId,
        cluster.workspaceId,
      );
      if (evalCases.some((item) => item.clusterId === cluster.id)) {
        await this.learnings.appendIfNovel({
          profileId: cluster.profileId,
          workspaceId: cluster.workspaceId,
          kind: "eval_case",
          summary: `Maintained living eval coverage for ${cluster.category.replace(/_/g, " ")}.`,
          relatedClusterId: cluster.id,
          createdAt: Date.now(),
        });
      }
      await this.experimentService.proposeExperimentsForCluster(cluster.id);
    }
  }
}
