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
  ) {}

  getBrainRoot(): string {
    return path.join(this.resolveGlobalRoot(), ".cowork", "subconscious", "brain");
  }

  getJournalRoot(): string {
    return path.join(this.resolveGlobalRoot(), ".cowork", "subconscious", "journal");
  }

  getTargetRoot(target: SubconsciousTargetRef): string {
    const workspacePath =
      target.codeWorkspacePath ||
      this.resolveWorkspacePath(target.workspaceId) ||
      this.resolveGlobalRoot();
    return path.join(workspacePath, ".cowork", "subconscious", "targets", sanitizeKey(target.key));
  }

  getRunRoot(target: SubconsciousTargetRef, runId: string): string {
    return path.join(this.getTargetRoot(target), "runs", runId);
  }

  private async canWriteTargetArtifacts(target: SubconsciousTargetRef | null): Promise<boolean> {
    if (!target) return true;
    const workspacePath = target.codeWorkspacePath || this.resolveWorkspacePath(target.workspaceId);
    if (!workspacePath) return true;
    try {
      return (await fs.stat(workspacePath)).isDirectory();
    } catch {
      return false;
    }
  }

  async writeBrainState(
    summary: SubconsciousBrainSummary,
    targets: SubconsciousTargetSummary[],
  ): Promise<void> {
    const brainRoot = this.getBrainRoot();
    await fs.mkdir(brainRoot, { recursive: true });
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
    if (!(await this.canWriteTargetArtifacts(target.target))) {
      return;
    }
    const targetRoot = this.getTargetRoot(target.target);
    await fs.mkdir(targetRoot, { recursive: true });
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
    if (!(await this.canWriteTargetArtifacts(params.target))) {
      return runRoot;
    }
    await fs.mkdir(runRoot, { recursive: true });
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
    await fs.mkdir(journalRoot, { recursive: true });
    const day = new Date(entry.createdAt).toISOString().slice(0, 10);
    await fs.appendFile(
      path.join(journalRoot, `${day}.jsonl`),
      `${JSON.stringify(entry)}\n`,
      "utf-8",
    );
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
    if (!(await this.canWriteTargetArtifacts(target))) {
      return;
    }
    const root = target ? this.getTargetRoot(target) : this.getBrainRoot();
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(
      path.join(root, "memory-index.json"),
      JSON.stringify(items, null, 2),
      "utf-8",
    );
  }

  async readMemoryIndex(
    targetKey?: string,
    target?: SubconsciousTargetRef,
  ): Promise<SubconsciousMemoryItem[]> {
    const root = targetKey && target ? this.getTargetRoot(target) : this.getBrainRoot();
    const content = await fs
      .readFile(path.join(root, "memory-index.json"), "utf-8")
      .catch(() => "[]");
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
    if (!(await this.canWriteTargetArtifacts(target))) {
      return;
    }
    const root = target
      ? path.join(this.getTargetRoot(target), "dreams")
      : path.join(this.getBrainRoot(), "dreams");
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(
      path.join(root, `${artifact.createdAt}-${sanitizeKey(artifact.id)}.json`),
      JSON.stringify(artifact, null, 2),
      "utf-8",
    );
    await fs.writeFile(path.join(root, "latest.json"), JSON.stringify(artifact, null, 2), "utf-8");
  }

  async readDreamArtifacts(
    target?: SubconsciousTargetRef,
    limit = 5,
  ): Promise<SubconsciousDreamArtifact[]> {
    const root = target
      ? path.join(this.getTargetRoot(target), "dreams")
      : path.join(this.getBrainRoot(), "dreams");
    const files = await fs.readdir(root).catch(() => []);
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
