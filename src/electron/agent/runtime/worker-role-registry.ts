import type {
  AgentConfig,
  ConversationMode,
  DelegationWorkerRole,
  ExecutionMode,
  LlmProfile,
  VerificationVerdict,
  WorkerPromptContext,
  WorkerRoleKind,
  WorkerRoleSpec,
} from "../../../shared/types";

const VERIFIER_DENY_LIST = [
  "group:write",
  "group:meta",
  "spawn_agent",
  "orchestrate_agents",
  "send_agent_message",
  "cancel_agent",
  "pause_agent",
  "resume_agent",
  "switch_workspace",
  "group:image",
];

const RESEARCHER_DENY_LIST = [
  "group:write",
  "delete_file",
  "group:meta",
  "spawn_agent",
  "orchestrate_agents",
  "send_agent_message",
  "cancel_agent",
  "pause_agent",
  "resume_agent",
  "switch_workspace",
];

const IMPLEMENTER_DENY_LIST = ["group:meta"];

const SYNTHESIZER_DENY_LIST = [
  "delete_file",
  "spawn_agent",
  "orchestrate_agents",
  "send_agent_message",
  "cancel_agent",
  "pause_agent",
  "resume_agent",
  "switch_workspace",
  "group:image",
];

const BUILTIN_WORKER_ROLES: Record<WorkerRoleKind, WorkerRoleSpec> = {
  researcher: {
    kind: "researcher",
    displayName: "Researcher",
    description: "Read-only exploration, evidence collection, and issue finding.",
    systemPrompt: [
      "You are a research worker.",
      "Collect evidence, inspect files, search code, and summarize findings.",
      "Do not modify files.",
      "Return concise, self-contained findings with paths, commands, and risks.",
    ].join("\n"),
    conversationMode: "task",
    allowUserInput: false,
    retainMemory: false,
    llmProfile: "cheap",
    executionMode: "verified",
    toolRestrictions: RESEARCHER_DENY_LIST,
    mutationAllowed: false,
    completionContract:
      "Report evidence-backed findings only. Do not claim implementation work or file mutations.",
  },
  implementer: {
    kind: "implementer",
    displayName: "Implementer",
    description: "Builds the assigned scope and verifies its own changes.",
    systemPrompt: [
      "You are an implementation worker.",
      "Mutate only the assigned scope.",
      "Verify your own work before reporting done.",
      "Report exact changed files and commands run.",
    ].join("\n"),
    conversationMode: "task",
    allowUserInput: false,
    retainMemory: false,
    llmProfile: "cheap",
    executionMode: "execute",
    toolRestrictions: IMPLEMENTER_DENY_LIST,
    mutationAllowed: true,
    completionContract:
      "Implement the requested scope and validate it. Do not spawn recursive delegation unless explicitly allowed.",
  },
  verifier: {
    kind: "verifier",
    displayName: "Verifier",
    description: "Adversarial, read-only verification worker with verdict output.",
    systemPrompt: [
      "You are an independent verification worker.",
      "Be adversarial, evidence-driven, and read-only.",
      "Inspect files, tests, and outputs. Do not modify project files.",
      "Require command/output/result evidence and end with VERDICT: PASS, FAIL, or PARTIAL.",
      "Include at least one adversarial probe; do not stop at the happy path.",
    ].join("\n"),
    conversationMode: "task",
    allowUserInput: false,
    retainMemory: false,
    llmProfile: "strong",
    executionMode: "verified",
    toolRestrictions: VERIFIER_DENY_LIST,
    mutationAllowed: false,
    completionContract:
      "Start the final answer with VERDICT: PASS|FAIL|PARTIAL, then give the smallest evidence-backed finding set.",
  },
  synthesizer: {
    kind: "synthesizer",
    displayName: "Synthesizer",
    description: "Combines predecessor outputs into a coherent deliverable.",
    systemPrompt: [
      "You are a synthesis worker.",
      "Consume predecessor outputs, consolidate conflicts, and produce a concrete artifact.",
      "Avoid broad new exploration unless the provided evidence is insufficient.",
      "Summarize conflicts and make a clear recommendation.",
    ].join("\n"),
    conversationMode: "task",
    allowUserInput: false,
    retainMemory: false,
    llmProfile: "strong",
    executionMode: "execute",
    toolRestrictions: SYNTHESIZER_DENY_LIST,
    mutationAllowed: true,
    completionContract:
      "Produce a consolidated artifact or summary that resolves predecessor conflicts and preserves the source evidence.",
  },
};

export function getWorkerRoleSpec(kind: WorkerRoleKind): WorkerRoleSpec {
  return BUILTIN_WORKER_ROLES[kind];
}

export function resolveWorkerRoleKind(value?: string | null): WorkerRoleKind | undefined {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (
    normalized === "researcher" ||
    normalized === "implementer" ||
    normalized === "verifier" ||
    normalized === "synthesizer"
  ) {
    return normalized;
  }
  return undefined;
}

export function resolveDelegationWorkerRoleInput(
  value?: string | null,
): DelegationWorkerRole | undefined {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "auto") return "auto";
  return resolveWorkerRoleKind(normalized);
}

export function resolveDefaultWorkerRoleKind(): WorkerRoleKind {
  return "implementer";
}

export function inferWorkerRoleKindFromPrompt(prompt: string): WorkerRoleKind {
  const normalized = String(prompt || "")
    .trim()
    .toLowerCase();
  if (!normalized) return resolveDefaultWorkerRoleKind();

  if (
    /\b(merge|combine|consolidat|synthesi[sz]e|synthesizer|roll\s*up|compare and summarize)\b/i.test(
      normalized,
    ) ||
    /\bsummari[sz]e\b.*\b(outputs?|results?|predecessors?|agents?|branches?|reports?)\b/i.test(
      normalized,
    )
  ) {
    return "synthesizer";
  }

  if (
    /\b(review|verify|verification|validate|validation|check|qa|second opinion|double-check|audit|run tests?|test the)\b/i.test(
      normalized,
    ) &&
    !/\b(investigat|research|analy[sz]e|inspect|read|search|summari[sz]e|find out|failing test)\b/i.test(
      normalized,
    ) &&
    !/\b(fix|implement|write|edit|change|build|create|update|refactor)\b/i.test(normalized)
  ) {
    return "verifier";
  }

  if (
    /\b(read|search|investigat|inspect|analy[sz]e|analysis|research|find out|look up|explore|summari[sz]e|audit)\b/i.test(
      normalized,
    ) &&
    !/\b(fix|implement|write|edit|change|build|create|update|refactor)\b/i.test(normalized)
  ) {
    return "researcher";
  }

  return "implementer";
}

export function resolveDelegationWorkerRole(params: {
  requestedRole?: string | null;
  prompt: string;
}): WorkerRoleKind {
  const requested = resolveDelegationWorkerRoleInput(params.requestedRole);
  if (requested && requested !== "auto") return requested;
  return inferWorkerRoleKindFromPrompt(params.prompt);
}

export function resolveWorkerRoleAgentConfig(
  workerRole: WorkerRoleKind,
  agentConfig?: AgentConfig,
): AgentConfig {
  const spec = getWorkerRoleSpec(workerRole);
  const next: AgentConfig = agentConfig ? { ...agentConfig } : {};
  if (next.conversationMode === undefined) {
    next.conversationMode = spec.conversationMode;
  }
  if (next.allowUserInput === undefined) {
    next.allowUserInput = spec.allowUserInput;
  }
  if (next.retainMemory === undefined) {
    next.retainMemory = spec.retainMemory;
  }
  if (next.llmProfile === undefined) {
    next.llmProfile = spec.llmProfile;
  }
  if (next.executionMode === undefined) {
    next.executionMode = spec.executionMode;
  }

  const restrictions = new Set<string>(
    Array.isArray(next.toolRestrictions) ? next.toolRestrictions : [],
  );
  for (const entry of spec.toolRestrictions) {
    restrictions.add(entry);
  }
  next.toolRestrictions = Array.from(restrictions);
  return next;
}

export function buildWorkerRolePrompt(
  workerRole: WorkerRoleKind,
  context: WorkerPromptContext,
): string {
  const spec = getWorkerRoleSpec(workerRole);
  const lines = [
    `WORKER ROLE: ${spec.displayName}`,
    spec.description,
    "",
    spec.systemPrompt,
    "",
    `Task title: ${context.taskTitle}`,
    `Task prompt: ${context.taskPrompt}`,
  ];
  if (context.workspacePath) {
    lines.push(`Workspace: ${context.workspacePath}`);
  }
  if (context.parentSummary) {
    lines.push("", "Parent summary:", context.parentSummary);
  }
  if (context.evidenceBundle) {
    lines.push("", "Structured evidence:", context.evidenceBundle);
  }
  if (context.outputSummary) {
    lines.push("", "Output summary:", context.outputSummary);
  }
  lines.push("", `Completion contract: ${spec.completionContract}`);
  return lines.join("\n");
}

export function parseVerificationVerdict(summary: string): VerificationVerdict {
  const text = String(summary || "").trim();
  if (/VERDICT:\s*PASS/i.test(text)) return "PASS";
  if (/VERDICT:\s*PARTIAL/i.test(text)) return "PARTIAL";
  return "FAIL";
}

export function buildWorkerRoleInstructionPrefix(workerRole: WorkerRoleKind): string {
  const spec = getWorkerRoleSpec(workerRole);
  return [`You are acting as ${spec.displayName}.`, spec.description].join(" ");
}
