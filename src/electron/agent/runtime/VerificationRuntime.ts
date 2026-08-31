import type {
  AgentConfig,
  Task,
  TaskOutputSummary,
  TaskVerificationEvidenceBundle,
} from "../../../shared/types";
import { buildWorkerRolePrompt, parseVerificationVerdict } from "./worker-role-registry";
import type { WorkerRoleKind, VerificationVerdict } from "../../../shared/types";

export interface VerificationRuntimeChildResult {
  childTaskId: string;
  status: "completed" | "failed" | "cancelled" | "timeout" | "missing";
  summary: string;
}

export interface VerificationRuntimeDeps {
  runReadOnlyChildTaskAndWait: (params: {
    parentTask: Task;
    title: string;
    prompt: string;
    timeoutMs?: number;
    agentConfig?: AgentConfig;
    workerRole?: WorkerRoleKind;
  }) => Promise<VerificationRuntimeChildResult>;
}

export interface VerificationRuntimeRequest {
  parentTask: Task;
  parentSummary?: string;
  verificationEvidenceBundle?: TaskVerificationEvidenceBundle;
  outputSummary?: TaskOutputSummary;
  timeoutMs?: number;
  explicit?: boolean;
  highRisk?: boolean;
}

export interface VerificationRuntimeResult {
  gated: boolean;
  ran: boolean;
  childTaskId?: string;
  status: VerificationRuntimeChildResult["status"] | "skipped";
  verdict: VerificationVerdict;
  report: string;
  shouldBlock: boolean;
}

export class VerificationRuntime {
  constructor(private readonly deps: VerificationRuntimeDeps) {}

  shouldGateTask(request: VerificationRuntimeRequest): boolean {
    const task = request.parentTask;
    if (request.explicit) return true;
    if (task.parentTaskId || (task.agentType ?? "main") !== "main") return false;
    if (task.agentConfig?.verificationAgent === true) return true;
    if (task.agentConfig?.verificationAgent === false) {
      return this.isHighRiskTask(task, request);
    }
    if (task.agentConfig?.reviewPolicy === "strict") return true;
    if (task.agentConfig?.reviewPolicy === "balanced") {
      return this.isLikelyImplementationTask(task, request) || this.isHighRiskTask(task, request);
    }
    if (this.isHighRiskTask(task, request)) return true;
    return this.isLikelyImplementationTask(task, request);
  }

  async run(request: VerificationRuntimeRequest): Promise<VerificationRuntimeResult> {
    const gated = this.shouldGateTask(request);
    if (!gated) {
      return {
        gated: false,
        ran: false,
        status: "skipped",
        verdict: "PASS",
        report: "",
        shouldBlock: false,
      };
    }

    const result = await this.deps.runReadOnlyChildTaskAndWait({
      parentTask: request.parentTask,
      title: `Verify: ${request.parentTask.title}`.slice(0, 200),
      prompt: this.buildVerificationPrompt(request),
      timeoutMs: request.timeoutMs ?? 120_000,
      workerRole: "verifier",
      agentConfig: {
        maxTurns: 12,
        llmProfile: "strong",
        llmProfileForced: true,
        verificationAgent: false,
        reviewPolicy: "off",
        entropySweepPolicy: "off",
        conversationMode: "task",
        allowUserInput: false,
        retainMemory: false,
      },
    });

    const report = String(result.summary || "").trim();
    const verdict = parseVerificationVerdict(report);
    const highRisk = this.isHighRiskTask(request.parentTask, request);
    const shouldBlock = verdict === "FAIL" || (highRisk && verdict !== "PASS");

    return {
      gated: true,
      ran: true,
      childTaskId: result.childTaskId,
      status: result.status,
      verdict,
      report,
      shouldBlock,
    };
  }

  private isLikelyImplementationTask(task: Task, request: VerificationRuntimeRequest): boolean {
    const text = this.getTaskText(task, request.parentSummary);
    const outputSummary = request.outputSummary;
    const mutatedCount =
      (outputSummary?.created?.length ?? 0) + (outputSummary?.modifiedFallback?.length ?? 0);
    if (mutatedCount >= 3) return true;
    if ((outputSummary?.outputCount ?? 0) >= 3) return true;
    return /\b(implement|build|fix|create|update|refactor|website|app|portal|api|database|infra|config|auth|deploy|ship)\b/i.test(
      text,
    );
  }

  private isHighRiskTask(task: Task, request: VerificationRuntimeRequest): boolean {
    const text = this.getTaskText(task, request.parentSummary);
    const outputSummary = request.outputSummary;
    const mutatedCount =
      (outputSummary?.created?.length ?? 0) + (outputSummary?.modifiedFallback?.length ?? 0);
    if (mutatedCount >= 3) return true;
    return /\b(api|backend|database|schema|auth|security|privacy|payment|billing|infra|deployment|production|release)\b/i.test(
      text,
    );
  }

  private getTaskText(task: Task, parentSummary?: string): string {
    return [task.title, task.rawPrompt || task.userPrompt || task.prompt, parentSummary || ""]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
  }

  private buildVerificationPrompt(request: VerificationRuntimeRequest): string {
    const task = request.parentTask;
    const evidenceBlock =
      request.verificationEvidenceBundle && request.verificationEvidenceBundle.entries.length > 0
        ? JSON.stringify(request.verificationEvidenceBundle.entries.slice(0, 40), null, 2)
        : "(no structured verification evidence — rely on files and summary)";
    return [
      buildWorkerRolePrompt("verifier", {
        taskTitle: task.title,
        taskPrompt: task.rawPrompt || task.userPrompt || task.prompt,
        workspacePath: task.workspaceId,
        parentSummary: request.parentSummary,
        evidenceBundle: evidenceBlock,
        outputSummary: request.outputSummary
          ? JSON.stringify(request.outputSummary, null, 2)
          : undefined,
      }),
      "",
      "## Instructions",
      "1. Use read/search/browser/test/build/run tools only.",
      "2. Be adversarial: try to falsify the claim that the task is complete.",
      "3. Inspect files and outputs using command/file evidence, not just prose.",
      "4. Check completeness, correctness, and whether anything was missed.",
      "5. Check scope control: every changed file should trace to the user request; flag unrelated cleanup, broad rewrites, renames, or speculative abstractions.",
      "6. Start the final answer with exactly VERDICT: PASS, VERDICT: FAIL, or VERDICT: PARTIAL.",
      "7. Then provide concise bullet findings focused on gaps and evidence.",
      "8. Do not modify project files.",
      "9. Include at least one adversarial probe.",
    ].join("\n");
  }
}

export function createVerificationRuntime(deps: VerificationRuntimeDeps): VerificationRuntime {
  return new VerificationRuntime(deps);
}

export function normalizeVerificationVerdict(value: string): VerificationVerdict {
  return parseVerificationVerdict(value);
}
