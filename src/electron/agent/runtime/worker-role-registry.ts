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
  // Verification is an explicitly read-only lane. Keep the destructive group
  // denied even when a parent task was created with bypass permissions; the
  // verifier must not inherit that parent's shell/delete capability.
  "group:destructive",
  "group:system",
  "group:memory",
  "group:meta",
  "spawn_agent",
  "orchestrate_agents",
  "send_agent_message",
  "cancel_agent",
  "pause_agent",
  "resume_agent",
  "switch_workspace",
  "group:image",
  // Connector actions can mutate external accounts even though they are
  // classified as network tools rather than workspace writes.
  "x_action",
  "notion_action",
  "box_action",
  "onedrive_action",
  "google_drive_action",
  "gmail_action",
  "gmail_create_draft",
  "gmail_update_draft",
  "gmail_send_draft",
  "gmail_send_email",
  "gmail_apply_labels_to_emails",
  "gmail_bulk_label_matching_emails",
  "gmail_forward_emails",
  "mailbox_action",
  "calendar_action",
  "apple_calendar_action",
  "apple_reminders_action",
  "dropbox_action",
  "sharepoint_action",
  "voice_call",
  "generate_video",
  "cancel_video_generation_job",
  // Browser/QA actions can submit forms, upload data, or alter the browser
  // profile. The effective read-only profile also disables external access.
  "browser_click",
  "browser_drag",
  "browser_fill",
  "browser_type",
  "browser_press",
  "browser_select",
  "browser_upload_file",
  "browser_handle_dialog",
  "browser_evaluate",
  "browser_storage",
  "browser_emulate",
  "browser_downloads",
  "browser_trace_start",
  "browser_trace_stop",
  "browser_save_pdf",
  "browser_act_batch",
  "browser_close_tab",
  "browser_close",
  "qa_interact",
  "qa_cleanup",
  // Mutating built-ins that are not currently in group:write.
  "git_commit",
  "git_merge_to_base",
  "schedule_task",
  "create_issue",
  "canvas_create",
  "canvas_push",
  "canvas_eval",
  "canvas_hide",
  "canvas_close",
  "canvas_restore",
  "canvas_checkpoint",
  "visual_update_annotator",
  "run_applescript",
  "terminate_macos_app_processes",
  "disable_macos_launch_agents",
  "mention_agent",
  "acknowledge_mention",
  "complete_mention",
];

/**
 * Tool restrictions shared by read-only child helpers regardless of their
 * worker prompt. The helper may retain a researcher role while still using
 * the verifier's hard execution boundary.
 */
export function getReadOnlyExecutionToolRestrictions(): string[] {
  return [...VERIFIER_DENY_LIST];
}

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
      "Inspect files, tests, and supplied or already-captured outputs. Do not modify project files.",
      "This role cannot invoke shell, destructive, system, memory, connector, or browser interaction tools; report VERDICT: PARTIAL or VERDICT: FAIL when fresh command or build evidence is required but not supplied.",
      "Require command/output/result evidence and start the final answer with VERDICT: PASS, VERDICT: FAIL, or VERDICT: PARTIAL.",
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

  // A role-level read-only contract must survive caller-supplied overrides.
  // The daemon also enforces this while merging parent permissions so a
  // bypassed parent cannot turn a verifier/helper back into an executing
  // worker. `readOnlyExecution` is an internal child-helper boundary and may
  // be combined with a researcher prompt without changing that role.
  const readOnlyExecution = workerRole === "verifier" || next.readOnlyExecution === true;
  if (readOnlyExecution) {
    next.readOnlyExecution = true;
    next.permissionMode = "plan";
    next.shellAccess = false;
    // ACP/external runtimes execute outside this process's ToolRegistry and
    // cannot inherit the read-only guarantees. A read-only child must use the
    // local, policy-wrapped runtime only.
    delete next.externalRuntime;
  }

  const restrictions = new Set<string>(
    Array.isArray(next.toolRestrictions) ? next.toolRestrictions : [],
  );
  for (const entry of readOnlyExecution ? VERIFIER_DENY_LIST : spec.toolRestrictions) {
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
  // The completion contract requires a standalone verdict on the first line.
  // Quoted examples and substrings such as PASSING are not verdicts.
  const header = /^VERDICT:[ \t]*(PASS|FAIL|PARTIAL)[ \t]*(?:\r?\n|$)/i.exec(text);
  if (!header) return "FAIL";
  const verdict = header[1].toUpperCase() as VerificationVerdict;
  const markers = text.matchAll(/^VERDICT:[ \t]*(PASS|FAIL|PARTIAL)[ \t]*\r?$/gim);
  for (const marker of markers) {
    if (marker[1].toUpperCase() !== verdict) return "FAIL";
  }
  return verdict;
}

export function buildWorkerRoleInstructionPrefix(workerRole: WorkerRoleKind): string {
  const spec = getWorkerRoleSpec(workerRole);
  return [`You are acting as ${spec.displayName}.`, spec.description].join(" ");
}
