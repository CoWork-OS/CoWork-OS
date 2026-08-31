import Database from "better-sqlite3";
import { randomUUID, createHash } from "crypto";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import type {
  SubconsciousBacklogItem,
  SubconsciousDecision,
  SubconsciousRunOutcome,
  SubconsciousRun,
  SubconsciousTargetRef,
  SubconsciousTargetSummary,
} from "../../shared/subconscious";
import {
  SubconsciousBacklogRepository,
  SubconsciousDecisionRepository,
  SubconsciousRunRepository,
  SubconsciousTargetRepository,
} from "./SubconsciousRepositories";

type Any = any;

function hasTable(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return Boolean(row);
}

function codeWorkspaceTarget(workspaceId: string): SubconsciousTargetRef {
  return {
    key: `code_workspace:${workspaceId}`,
    kind: "code_workspace",
    workspaceId,
    label: `Code workspace ${workspaceId}`,
  };
}

export class SubconsciousMigrationService {
  private readonly targetRepo: SubconsciousTargetRepository;
  private readonly runRepo: SubconsciousRunRepository;
  private readonly decisionRepo: SubconsciousDecisionRepository;
  private readonly backlogRepo: SubconsciousBacklogRepository;

  constructor(private readonly db: Database.Database) {
    this.targetRepo = new SubconsciousTargetRepository(db);
    this.runRepo = new SubconsciousRunRepository(db);
    this.decisionRepo = new SubconsciousDecisionRepository(db);
    this.backlogRepo = new SubconsciousBacklogRepository(db);
  }

  runOnce(): void {
    if (
      !hasTable(this.db, "improvement_candidates") ||
      !hasTable(this.db, "improvement_campaigns")
    ) {
      this.markComplete();
      return;
    }
    if (this.isComplete()) return;
    this.migrateCandidates();
    this.migrateCampaigns();
    this.markComplete();
  }

  private isComplete(): boolean {
    if (!SecureSettingsRepository.isInitialized()) return false;
    return Boolean(SecureSettingsRepository.getInstance().load("subconscious-migration-v1"));
  }

  private markComplete(): void {
    if (!SecureSettingsRepository.isInitialized()) return;
    SecureSettingsRepository.getInstance().save("subconscious-migration-v1", {
      completedAt: Date.now(),
    });
  }

  private migrateCandidates(): void {
    const rows = this.db
      .prepare(
        `SELECT id, workspace_id, title, summary, status, priority_score, last_seen_at
         FROM improvement_candidates`,
      )
      .all() as Any[];
    for (const row of rows) {
      const target = codeWorkspaceTarget(String(row.workspace_id));
      const targetSummary: SubconsciousTargetSummary = {
        key: target.key,
        target,
        health: row.status === "parked" ? "watch" : "healthy",
        state: row.status === "running" ? "active" : "idle",
        persistence: "durable",
        missedRunPolicy: "catchUp",
        lastEvidenceAt: Number(row.last_seen_at || Date.now()),
        backlogCount: 0,
      };
      this.targetRepo.upsert(targetSummary);
      const backlogId = createHash("sha1").update(`legacy:${row.id}`).digest("hex");
      this.backlogRepo.create({
        id: backlogId,
        targetKey: target.key,
        title: String(row.title || "Legacy improvement candidate"),
        summary: String(row.summary || ""),
        status:
          row.status === "resolved" ? "done" : row.status === "dismissed" ? "rejected" : "open",
        priority: Number(row.priority_score || 0),
      });
      this.targetRepo.update(target.key, {
        backlogCount: this.backlogRepo.countOpenByTarget(target.key),
      });
    }
  }

  private migrateCampaigns(): void {
    const rows = this.db
      .prepare(
        `SELECT id, workspace_id, status, verdict_summary, promotion_error, created_at, completed_at
         FROM improvement_campaigns`,
      )
      .all() as Any[];
    for (const row of rows) {
      const target = codeWorkspaceTarget(String(row.workspace_id));
      const runId = `legacy-${String(row.id)}`;
      const migratedOutcome: SubconsciousRunOutcome =
        row.status === "failed" ? "failed" : "dispatch";
      const run: SubconsciousRun = this.runRepo.create({
        id: runId,
        targetKey: target.key,
        workspaceId: target.workspaceId,
        stage: row.status === "failed" ? "failed" : "completed",
        outcome: migratedOutcome,
        evidenceFingerprint: createHash("sha1").update(runId).digest("hex"),
        evidenceSummary: "Migrated from legacy improvement campaign.",
        artifactRoot: "",
        rejectedHypothesisIds: [],
        startedAt: Number(row.created_at || Date.now()),
        completedAt: Number(row.completed_at || row.created_at || Date.now()),
      });
      const decision: SubconsciousDecision = {
        id: randomUUID(),
        runId: run.id,
        targetKey: target.key,
        winningHypothesisId: "legacy",
        winnerSummary: String(
          row.verdict_summary || row.promotion_error || "Legacy migrated recommendation.",
        ),
        recommendation: String(row.verdict_summary || "Migrated legacy campaign recommendation."),
        rejectedHypothesisIds: [],
        rationale: "Imported from the legacy improvement campaign history.",
        nextBacklog: [],
        outcome: migratedOutcome,
        createdAt: Number(row.completed_at || row.created_at || Date.now()),
      };
      this.decisionRepo.upsert(decision);
      this.targetRepo.update(target.key, {
        lastWinner: decision.winnerSummary,
        lastRunAt: run.completedAt,
      });
    }
  }
}
