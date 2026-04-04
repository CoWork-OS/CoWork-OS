import fs from "node:fs/promises";
import path from "node:path";
import type {
  SubconsciousBacklogItem,
  SubconsciousBrainSummary,
  SubconsciousCritique,
  SubconsciousDecision,
  SubconsciousDispatchRecord,
  SubconsciousEvidence,
  SubconsciousHypothesis,
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
    lines.push(`  Priority: ${item.priority} | Status: ${item.status}${item.executorKind ? ` | Executor: ${item.executorKind}` : ""}`);
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

  getTargetRoot(target: SubconsciousTargetRef): string {
    const workspacePath =
      target.codeWorkspacePath ||
      this.resolveWorkspacePath(target.workspaceId) ||
      this.resolveGlobalRoot();
    return path.join(
      workspacePath,
      ".cowork",
      "subconscious",
      "targets",
      sanitizeKey(target.key),
    );
  }

  getRunRoot(target: SubconsciousTargetRef, runId: string): string {
    return path.join(this.getTargetRoot(target), "runs", runId);
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
    decision: SubconsciousDecision;
    backlog: SubconsciousBacklogItem[];
    dispatch?: SubconsciousDispatchRecord | null;
  }): Promise<string> {
    const runRoot = this.getRunRoot(params.target, params.run.id);
    await fs.mkdir(runRoot, { recursive: true });
    await fs.writeFile(
      path.join(runRoot, "evidence.json"),
      JSON.stringify(params.evidence, null, 2),
      "utf-8",
    );
    await fs.writeFile(path.join(runRoot, "ideas.jsonl"), toJsonLines(params.hypotheses), "utf-8");
    await fs.writeFile(path.join(runRoot, "critique.jsonl"), toJsonLines(params.critiques), "utf-8");
    await fs.writeFile(
      path.join(runRoot, "decision.json"),
      JSON.stringify(params.decision, null, 2),
      "utf-8",
    );
    await fs.writeFile(
      path.join(runRoot, "winning-recommendation.md"),
      renderWinner(params.target, params.run, params.decision),
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
}
