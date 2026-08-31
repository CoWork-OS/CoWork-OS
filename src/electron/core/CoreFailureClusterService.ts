import type { CoreFailureCluster, CoreFailureRecord } from "../../shared/types";
import { CoreFailureClusterRepository } from "./CoreFailureClusterRepository";
import { CoreFailureRecordRepository } from "./CoreFailureRecordRepository";

export class CoreFailureClusterService {
  constructor(
    private readonly failureRepo: CoreFailureRecordRepository,
    private readonly clusterRepo: CoreFailureClusterRepository,
  ) {}

  clusterFailures(profileId?: string, workspaceId?: string): CoreFailureCluster[] {
    const records = this.failureRepo.list({
      profileId,
      workspaceId,
      status: "open",
      limit: 500,
    });
    const clusters: CoreFailureCluster[] = [];
    for (const record of records) {
      clusters.push(this.upsertClusterForRecord(record));
    }
    return clusters;
  }

  upsertClusterForRecord(record: CoreFailureRecord): CoreFailureCluster {
    const now = Date.now();
    const existing = this.clusterRepo.findByFingerprint(
      record.profileId,
      record.workspaceId,
      record.fingerprint,
    );
    if (existing) {
      const nextRecurrence = existing.recurrenceCount + 1;
      const updated = this.clusterRepo.update(existing.id, {
        recurrenceCount: nextRecurrence,
        lastSeenAt: record.createdAt,
        updatedAt: now,
        status: nextRecurrence >= 2 ? "stable" : existing.status,
        rootCauseSummary: this.mergeRootCause(existing.rootCauseSummary, record.summary),
      })!;
      this.clusterRepo.addMember(updated.id, record.id, now);
      this.failureRepo.update(record.id, { status: "clustered" });
      return updated;
    }

    const cluster = this.clusterRepo.create({
      profileId: record.profileId,
      workspaceId: record.workspaceId,
      category: record.category,
      fingerprint: record.fingerprint,
      rootCauseSummary: record.summary,
      status: record.severity === "critical" ? "stable" : "open",
      recurrenceCount: 1,
      firstSeenAt: record.createdAt,
      lastSeenAt: record.createdAt,
      createdAt: now,
      updatedAt: now,
    });
    this.clusterRepo.addMember(cluster.id, record.id, now);
    this.failureRepo.update(record.id, { status: "clustered" });
    return cluster;
  }

  private mergeRootCause(existing: string, incoming: string): string {
    if (!existing) return incoming;
    if (existing.toLowerCase() === incoming.toLowerCase()) return existing;
    return existing.length >= incoming.length ? existing : incoming;
  }
}
