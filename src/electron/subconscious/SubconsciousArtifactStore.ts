import { ensureWorkspaceDirectory } from "../utils/workspace-directory";
import { createLogger } from "../utils/logger";
import {
  evaluateConfinedInternalWrite,
  type BackgroundWriteWorkspace,
} from "../security/background-write-guard";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  SubconsciousBacklogItem,
  SubconsciousBrainSummary,
  SubconsciousCritique,
  SubconsciousDecision,
  SubconsciousDispatchRecord,
  SubconsciousDreamArtifact,
  SubconsciousEvidence,
  SubconsciousHypothesis,
  SubconsciousJournalEntry,
  SubconsciousMemoryItem,
  SubconsciousRun,
  SubconsciousTargetRef,
  SubconsciousTargetSummary,
} from "../../shared/subconscious";

const logger = createLogger("SubconsciousArtifacts");

/** Every artifact write stays inside `<root>/.cowork/subconscious`. */
const ARTIFACT_DIR = path.join(".cowork", "subconscious");

export interface SubconsciousArtifactStoreOptions {
  /**
   * Registered workspace whose path is `root`, so its access profile governs the
   * write. Roots that are not workspaces (the user data dir) are only confined.
   */
  findWorkspaceByRoot?: (root: string) => BackgroundWriteWorkspace | undefined;
  /** Artifacts are written only while this returns true (Workflow Intelligence enabled). */
  writesEnabled?: () => boolean;
}

function sanitizeKey(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function toJsonLines(items: unknown[]): string {
  return `${items.map((item) => JSON.stringify(item)).join("\n")}\n`;
}

function renderBacklog(items: SubconsciousBacklogItem[]): string {
  if (!items.length) {
    return "# Backlog\n\nNo backlog items.\n";
  }
  const lines = ["# Backlog", ""];
  for (const item of items) {
    lines.push(`- [${item.status === "done" ? "x" : " "}] ${item.title}`);
    lines.push(
      `  Priority: ${item.priority} | Status: ${item.status}${item.executorKind ? ` | Executor: ${item.executorKind}` : ""}`,
    );
    lines.push(`  ${item.summary}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderWinner(
  target: SubconsciousTargetRef,
  run: SubconsciousRun,
  decision: SubconsciousDecision,
): string {
  const lines = [
    `# Winning Recommendation`,
    "",
    `Target: ${target.label}`,
    `Run: ${run.id}`,
    `Outcome: ${decision.outcome}`,
    "",
    `## Winner`,
    decision.winnerSummary,
    "",
    `## Recommendation`,
    decision.recommendation,
    "",
    `## Rationale`,
    decision.rationale,
  ];
  return `${lines.join("\n")}\n`;
}

export class SubconsciousArtifactStore {
  constructor(
    private readonly resolveWorkspacePath: (workspaceId?: string) => string | undefined,
    private readonly resolveGlobalRoot: () => string,
    private readonly options: SubconsciousArtifactStoreOptions = {},
  ) {}

  getBrainRoot(): string {
    return path.join(this.resolveGlobalRoot(), ARTIFACT_DIR, "brain");
  }

  getJournalRoot(): string {
    return path.join(this.resolveGlobalRoot(), ARTIFACT_DIR, "journal");
  }

  /**
   * Target artifacts live in the target workspace's own `.cowork`. A code
   * target's `codeWorkspacePath` can be an enclosing git root, which is not
   * the workspace and may not be covered by its access profile, so it is
   * never used as a write root.
   */
  getTargetRoot(target: SubconsciousTargetRef): string {
    return path.join(
      this.targetWorkspaceRoot(target),
      ARTIFACT_DIR,
      "targets",
      sanitizeKey(target.key),
    );
  }

  getRunRoot(target: SubconsciousTargetRef, runId: string): string {
    return path.join(this.getTargetRoot(target), "runs", runId);
  }

  private targetWorkspaceRoot(target: SubconsciousTargetRef | null): string {
    if (!target) return this.resolveGlobalRoot();
    return this.resolveWorkspacePath(target.workspaceId) || this.resolveGlobalRoot();
  }

  /** Pre-fix location (repo root) of a code target's artifacts; read-only fallback. */
  private legacyTargetRoot(target: SubconsciousTargetRef): string | null {
    if (!target.codeWorkspacePath) return null;
    const legacy = path.join(
      target.codeWorkspacePath,
      ARTIFACT_DIR,
      "targets",
      sanitizeKey(target.key),
    );
    return path.resolve(legacy) === path.resolve(this.getTargetRoot(target)) ? null : legacy;
  }

  /**
   * Gate and prepare one artifact write: Workflow Intelligence must be enabled,
   * the root must exist, and every path must stay inside `<root>/.cowork/subconscious`
   * with no symlink on the way and the workspace access profile allowing the write.
   * A denied write is logged and skipped; it never throws into the loop.
   */
  private async prepareWrite(root: string, dir: string, files: string[]): Promise<boolean> {
    if (this.options.writesEnabled && !this.options.writesEnabled()) return false;
    const decision = evaluateConfinedInternalWrite({
      root,
      confineTo: ARTIFACT_DIR,
      targets: [dir, ...files],
      workspace: this.options.findWorkspaceByRoot?.(root),
    });
    if (!decision.allowed) {
      if (decision.reason !== "root_missing") {
        logger.warn("Skipping artifact write", { root, dir, reason: decision.reason });
      }
      return false;
    }
    await ensureWorkspaceDirectory(root, dir);
    return true;
  }

  async writeBrainState(
    summary: SubconsciousBrainSummary,
    targets: SubconsciousTargetSummary[],
  ): Promise<void> {
    const brainRoot = this.getBrainRoot();
    const files = [path.join(brainRoot, "state.json"), path.join(brainRoot, "memory.jsonl")];
    if (!(await this.prepareWrite(this.resolveGlobalRoot(), brainRoot, files))) return;
    await fs.writeFile(
      path.join(brainRoot, "state.json"),
      JSON.stringify({ summary, targets }, null, 2),
      "utf-8",
    );
    await fs.appendFile(
      path.join(brainRoot, "memory.jsonl"),
      `${JSON.stringify({
        type: "brain_snapshot",
        capturedAt: Date.now(),
        summary,
        targetCount: targets.length,
      })}\n`,
      "utf-8",
    );
  }

  async writeTargetState(
    target: SubconsciousTargetSummary,
    evidence: SubconsciousEvidence[],
    backlog: SubconsciousBacklogItem[],
  ): Promise<void> {
    const targetRoot = this.getTargetRoot(target.target);
    const files = ["state.json", "memory.jsonl", "backlog.md"].map((file) =>
      path.join(targetRoot, file),
    );
    if (!(await this.prepareWrite(this.targetWorkspaceRoot(target.target), targetRoot, files))) {
      return;
    }
    await fs.writeFile(
      path.join(targetRoot, "state.json"),
      JSON.stringify({ target, latestEvidence: evidence }, null, 2),
      "utf-8",
    );
    await fs.appendFile(
      path.join(targetRoot, "memory.jsonl"),
      `${JSON.stringify({
        type: "target_snapshot",
        capturedAt: Date.now(),
        targetKey: target.key,
        evidenceCount: evidence.length,
        backlogCount: backlog.length,
      })}\n`,
      "utf-8",
    );
    await fs.writeFile(path.join(targetRoot, "backlog.md"), renderBacklog(backlog), "utf-8");
  }

  async writeRunArtifacts(params: {
    target: SubconsciousTargetRef;
    run: SubconsciousRun;
    evidence: SubconsciousEvidence[];
    hypotheses: SubconsciousHypothesis[];
    critiques: SubconsciousCritique[];
    decision?: SubconsciousDecision;
    backlog: SubconsciousBacklogItem[];
    dispatch?: SubconsciousDispatchRecord | null;
  }): Promise<string> {
    const runRoot = this.getRunRoot(params.target, params.run.id);
    const files = [
      "evidence.json",
      "ideas.jsonl",
      "critique.jsonl",
      "decision.json",
      "winning-recommendation.md",
      "next-backlog.md",
      "dispatch.json",
    ].map((file) => path.join(runRoot, file));
    if (!(await this.prepareWrite(this.targetWorkspaceRoot(params.target), runRoot, files))) {
      return runRoot;
    }
    await fs.writeFile(
      path.join(runRoot, "evidence.json"),
      JSON.stringify(params.evidence, null, 2),
      "utf-8",
    );
    await fs.writeFile(path.join(runRoot, "ideas.jsonl"), toJsonLines(params.hypotheses), "utf-8");
    await fs.writeFile(
      path.join(runRoot, "critique.jsonl"),
      toJsonLines(params.critiques),
      "utf-8",
    );
    await fs.writeFile(
      path.join(runRoot, "decision.json"),
      JSON.stringify(params.decision || null, null, 2),
      "utf-8",
    );
    await fs.writeFile(
      path.join(runRoot, "winning-recommendation.md"),
      params.decision
        ? renderWinner(params.target, params.run, params.decision)
        : `# Run Outcome\n\nTarget: ${params.target.label}\nRun: ${params.run.id}\nOutcome: ${params.run.outcome || "unknown"}\n`,
      "utf-8",
    );
    await fs.writeFile(
      path.join(runRoot, "next-backlog.md"),
      renderBacklog(params.backlog.filter((item) => item.sourceRunId === params.run.id)),
      "utf-8",
    );
    await fs.writeFile(
      path.join(runRoot, "dispatch.json"),
      JSON.stringify(params.dispatch || null, null, 2),
      "utf-8",
    );
    return runRoot;
  }

  async appendJournalEntry(entry: SubconsciousJournalEntry): Promise<void> {
    const journalRoot = this.getJournalRoot();
    const day = new Date(entry.createdAt).toISOString().slice(0, 10);
    const journalFile = path.join(journalRoot, `${day}.jsonl`);
    if (!(await this.prepareWrite(this.resolveGlobalRoot(), journalRoot, [journalFile]))) return;
    await fs.appendFile(journalFile, `${JSON.stringify(entry)}\n`, "utf-8");
  }

  async readJournalEntries(targetKey?: string, limit = 50): Promise<SubconsciousJournalEntry[]> {
    const journalRoot = this.getJournalRoot();
    const files = await fs.readdir(journalRoot).catch(() => []);
    const ordered = files
      .filter((file) => file.endsWith(".jsonl"))
      .sort()
      .reverse();
    const collected: SubconsciousJournalEntry[] = [];
    for (const file of ordered) {
      const content = await fs.readFile(path.join(journalRoot, file), "utf-8").catch(() => "");
      const entries = content
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as SubconsciousJournalEntry;
          } catch {
            return null;
          }
        })
        .filter((entry): entry is SubconsciousJournalEntry => Boolean(entry));
      for (const entry of entries.reverse()) {
        if (targetKey && entry.targetKey && entry.targetKey !== targetKey) continue;
        if (targetKey && !entry.targetKey) continue;
        collected.push(entry);
        if (collected.length >= limit) {
          return collected.sort((a, b) => b.createdAt - a.createdAt);
        }
      }
    }
    return collected.sort((a, b) => b.createdAt - a.createdAt);
  }

  async writeMemoryIndex(
    target: SubconsciousTargetRef | null,
    items: SubconsciousMemoryItem[],
  ): Promise<void> {
    const root = target ? this.getTargetRoot(target) : this.getBrainRoot();
    const indexFile = path.join(root, "memory-index.json");
    if (!(await this.prepareWrite(this.targetWorkspaceRoot(target), root, [indexFile]))) return;
    await fs.writeFile(indexFile, JSON.stringify(items, null, 2), "utf-8");
  }

  async readMemoryIndex(
    targetKey?: string,
    target?: SubconsciousTargetRef,
  ): Promise<SubconsciousMemoryItem[]> {
    const roots =
      targetKey && target
        ? [this.getTargetRoot(target), this.legacyTargetRoot(target)]
        : [this.getBrainRoot()];
    let content = "[]";
    for (const root of roots) {
      if (!root) continue;
      const found = await fs
        .readFile(path.join(root, "memory-index.json"), "utf-8")
        .catch(() => null);
      if (found !== null) {
        content = found;
        break;
      }
    }
    try {
      return JSON.parse(content) as SubconsciousMemoryItem[];
    } catch {
      return [];
    }
  }

  async writeDreamArtifact(
    target: SubconsciousTargetRef | null,
    artifact: SubconsciousDreamArtifact,
  ): Promise<void> {
    const root = target
      ? path.join(this.getTargetRoot(target), "dreams")
      : path.join(this.getBrainRoot(), "dreams");
    const artifactFile = path.join(root, `${artifact.createdAt}-${sanitizeKey(artifact.id)}.json`);
    const latestFile = path.join(root, "latest.json");
    if (
      !(await this.prepareWrite(this.targetWorkspaceRoot(target), root, [artifactFile, latestFile]))
    ) {
      return;
    }
    await fs.writeFile(artifactFile, JSON.stringify(artifact, null, 2), "utf-8");
    await fs.writeFile(latestFile, JSON.stringify(artifact, null, 2), "utf-8");
  }

  async readDreamArtifacts(
    target?: SubconsciousTargetRef,
    limit = 5,
  ): Promise<SubconsciousDreamArtifact[]> {
    let root = target
      ? path.join(this.getTargetRoot(target), "dreams")
      : path.join(this.getBrainRoot(), "dreams");
    let files = await fs.readdir(root).catch(() => [] as string[]);
    const legacyRoot = target ? this.legacyTargetRoot(target) : null;
    if (!files.length && legacyRoot) {
      root = path.join(legacyRoot, "dreams");
      files = await fs.readdir(root).catch(() => [] as string[]);
    }
    const ordered = files
      .filter((file) => file.endsWith(".json") && file !== "latest.json")
      .sort()
      .reverse()
      .slice(0, limit);
    const results: SubconsciousDreamArtifact[] = [];
    for (const file of ordered) {
      const content = await fs.readFile(path.join(root, file), "utf-8").catch(() => "");
      try {
        results.push(JSON.parse(content) as SubconsciousDreamArtifact);
      } catch {
        // Ignore malformed dream artifacts.
      }
    }
    return results.sort((a, b) => b.createdAt - a.createdAt);
  }
}
