import type {
  AgentConfig,
  Task,
  TaskOutputSummary,
  TaskVerificationEvidenceBundle,
  RequirementEvidenceManifest,
} from "../../../shared/types";
import { buildWorkerRolePrompt, parseVerificationVerdict } from "./worker-role-registry";
import type { WorkerRoleKind, VerificationVerdict } from "../../../shared/types";

export interface VerificationRuntimeChildResult {
  childTaskId: string;
  status: "completed" | "failed" | "cancelled" | "timeout" | "missing";
  terminalStatus?: Task["terminalStatus"];
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
  requirementEvidenceManifest?: RequirementEvidenceManifest;
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

const OPTIONAL_VERIFICATION_EVIDENCE_PREVIEW_LIMIT = 20;
const OPTIONAL_VERIFICATION_EVIDENCE_DETAIL_LIMIT = 1_000;
const MAX_VERIFICATION_INPUT_BYTES = 64 * 1024;
// Variable-size prompt inputs are bounded so ordinary large tasks still fit under the
// input cap; the cap itself remains only as a last resort.
const VERIFICATION_TASK_PROMPT_CHAR_LIMIT = 8_000;
const VERIFICATION_PARENT_SUMMARY_CHAR_LIMIT = 8_000;
const VERIFICATION_OUTPUT_SUMMARY_CHAR_LIMIT = 6_000;
const VERIFICATION_REQUIREMENT_DESCRIPTION_CHAR_LIMIT = 400;
const VERIFICATION_EVIDENCE_CLAIM_CHAR_LIMIT = 200;

function truncateForVerification(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[truncated: ${value.length - limit} of ${value.length} characters omitted]`;
}

/**
 * Compacts the manifest for the verifier prompt. Every requirement and evidence entry is kept
 * with its identifiers, paths, status, and hashes intact; only free-text descriptions and
 * claims are shortened, with an explicit truncation marker.
 */
function compactRequirementEvidenceManifest(manifest: RequirementEvidenceManifest): string {
  return JSON.stringify({
    ...manifest,
    requirements: manifest.requirements.map((requirement) => ({
      ...requirement,
      description: truncateForVerification(
        requirement.description,
        VERIFICATION_REQUIREMENT_DESCRIPTION_CHAR_LIMIT,
      ),
      evidence: requirement.evidence.map((entry) => ({
        ...entry,
        claim: truncateForVerification(entry.claim, VERIFICATION_EVIDENCE_CLAIM_CHAR_LIMIT),
      })),
    })),
  });
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

    const prompt = this.buildVerificationPrompt(request);
    const inputBytes = Buffer.byteLength(prompt, "utf8");
    if (inputBytes > MAX_VERIFICATION_INPUT_BYTES) {
      return {
        gated: true,
        ran: false,
        status: "skipped",
        verdict: "PARTIAL",
        report: `Independent verification was not started: its ${inputBytes}-byte prompt exceeds the ${MAX_VERIFICATION_INPUT_BYTES}-byte input limit. Narrow or split the requested review. Mandatory requirements and evidence were not discarded.`,
        shouldBlock: true,
      };
    }

    const result = await this.deps.runReadOnlyChildTaskAndWait({
      parentTask: request.parentTask,
      title: `Verify: ${request.parentTask.title}`.slice(0, 200),
      prompt,
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
    // A stale/partial summary cannot certify an unfinished verification run.
    const completedSuccessfully =
      result.status === "completed" && (!result.terminalStatus || result.terminalStatus === "ok");
    const verdict = completedSuccessfully ? parseVerificationVerdict(report) : "FAIL";
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
    if (request.highRisk) return true;
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
    const optionalEntries = request.verificationEvidenceBundle?.entries || [];
    const evidenceBlock = optionalEntries.length
      ? JSON.stringify(
          {
            semantics:
              "Optional execution observations only. The requirement-selected manifest below contains mandatory proof; omitted preview entries are not dropped mandatory requirements.",
            totalCount: optionalEntries.length,
            includedCount: Math.min(
              optionalEntries.length,
              OPTIONAL_VERIFICATION_EVIDENCE_PREVIEW_LIMIT,
            ),
            omittedCount: Math.max(
              0,
              optionalEntries.length - OPTIONAL_VERIFICATION_EVIDENCE_PREVIEW_LIMIT,
            ),
            entries: optionalEntries
              .slice(0, OPTIONAL_VERIFICATION_EVIDENCE_PREVIEW_LIMIT)
              .map((entry) => ({
                kind: entry.kind,
                ok: entry.ok,
                detail: String(entry.detail || "").slice(
                  0,
                  OPTIONAL_VERIFICATION_EVIDENCE_DETAIL_LIMIT,
                ),
                capturedAt: entry.capturedAt,
              })),
          },
          null,
          2,
        )
      : "(no optional structured execution evidence — rely on files, summary, and the selected manifest)";
    const requirementEvidenceBlock = request.requirementEvidenceManifest
      ? compactRequirementEvidenceManifest(request.requirementEvidenceManifest)
      : "(no requirement-selected evidence manifest)";
    return [
      buildWorkerRolePrompt("verifier", {
        taskTitle: task.title,
        taskPrompt: truncateForVerification(
          String(task.rawPrompt || task.userPrompt || task.prompt || ""),
          VERIFICATION_TASK_PROMPT_CHAR_LIMIT,
        ),
        workspacePath: task.workspaceId,
        parentSummary: request.parentSummary
          ? truncateForVerification(request.parentSummary, VERIFICATION_PARENT_SUMMARY_CHAR_LIMIT)
          : undefined,
        evidenceBundle: evidenceBlock,
        outputSummary: request.outputSummary
          ? truncateForVerification(
              JSON.stringify(request.outputSummary),
              VERIFICATION_OUTPUT_SUMMARY_CHAR_LIMIT,
            )
          : undefined,
      }),
      "",
      "## Instructions",
      "## Requirement-selected evidence",
      requirementEvidenceBlock,
      "A file_exists proof establishes only that the exact file existed when the server inspected and hashed it; it does not establish file contents or semantic correctness.",
      "Do not treat generic PASS prose or unlinked evidence as proof that an outcome requirement is satisfied.",
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
