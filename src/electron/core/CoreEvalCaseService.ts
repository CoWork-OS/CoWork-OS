import type {
  CoreEvalCase,
  CoreFailureCluster,
  ListCoreEvalCasesRequest,
  ReviewCoreEvalCaseRequest,
} from "../../shared/types";
import { CoreEvalCaseRepository } from "./CoreEvalCaseRepository";
import { CoreFailureClusterRepository } from "./CoreFailureClusterRepository";

export class CoreEvalCaseService {
  constructor(
    private readonly clusterRepo: CoreFailureClusterRepository,
    private readonly evalRepo: CoreEvalCaseRepository,
  ) {}

  syncEvalCasesForProfile(profileId: string, workspaceId?: string): CoreEvalCase[] {
    const clusters = this.clusterRepo.list({
      profileId,
      workspaceId,
      limit: 500,
    });
    const created: CoreEvalCase[] = [];
    for (const cluster of clusters) {
      if (!this.shouldPromoteToEval(cluster)) continue;
      const existing = this.evalRepo.findByClusterId(cluster.id);
      if (existing) {
        if (cluster.linkedEvalCaseId !== existing.id) {
          this.clusterRepo.update(cluster.id, {
            linkedEvalCaseId: existing.id,
            status: cluster.status === "open" ? "stable" : cluster.status,
            updatedAt: Date.now(),
          });
        }
        created.push(existing);
        continue;
      }
      const now = Date.now();
      const evalCase = this.evalRepo.create({
        profileId: cluster.profileId,
        workspaceId: cluster.workspaceId,
        clusterId: cluster.id,
        title: `Regression guard: ${cluster.category.replace(/_/g, " ")}`,
        spec: {
          clusterId: cluster.id,
          category: cluster.category,
          fingerprint: cluster.fingerprint,
          expected: "Avoid recurrence of this failure mode while preserving prior stable behavior.",
          rootCauseSummary: cluster.rootCauseSummary,
        },
        status: "active",
        passCount: 0,
        failCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      this.clusterRepo.update(cluster.id, {
        linkedEvalCaseId: evalCase.id,
        status: "stable",
        updatedAt: now,
      });
      created.push(evalCase);
    }
    return created;
  }

  listEvalCases(request: ListCoreEvalCasesRequest = {}) {
    return this.evalRepo.list(request);
  }

  reviewEvalCase(request: ReviewCoreEvalCaseRequest) {
    return this.evalRepo.update(request.id, {
      status: request.status,
      updatedAt: Date.now(),
    });
  }

  shouldPromoteToEval(cluster: CoreFailureCluster): boolean {
    return cluster.status === "stable" || cluster.recurrenceCount >= 2;
  }
}
