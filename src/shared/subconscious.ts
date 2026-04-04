export type SubconsciousTargetKind =
  | "global"
  | "workspace"
  | "agent_role"
  | "mailbox_thread"
  | "scheduled_task"
  | "event_trigger"
  | "briefing"
  | "code_workspace";

export type SubconsciousRunStage =
  | "collecting_evidence"
  | "ideating"
  | "critiquing"
  | "synthesizing"
  | "dispatching"
  | "completed"
  | "blocked"
  | "failed";

export type SubconsciousRunOutcome =
  | "completed"
  | "completed_no_dispatch"
  | "blocked"
  | "failed";

export type SubconsciousHypothesisStatus = "proposed" | "rejected" | "winner";
export type SubconsciousCritiqueVerdict = "support" | "mixed" | "reject";
export type SubconsciousBacklogStatus = "open" | "dispatched" | "done" | "rejected";
export type SubconsciousDispatchKind =
  | "task"
  | "suggestion"
  | "scheduled_task"
  | "briefing"
  | "event_trigger_update"
  | "mailbox_automation"
  | "code_change_task";
export type SubconsciousDispatchStatus =
  | "queued"
  | "dispatched"
  | "completed"
  | "failed"
  | "skipped";
export type SubconsciousHealth = "healthy" | "watch" | "blocked";
export type SubconsciousTargetState = "idle" | "active" | "stale";
export type SubconsciousBrainStatus = "idle" | "running" | "paused";

export interface SubconsciousTargetRef {
  key: string;
  kind: SubconsciousTargetKind;
  label: string;
  workspaceId?: string;
  agentRoleId?: string;
  mailboxThreadId?: string;
  scheduledTaskId?: string;
  eventTriggerId?: string;
  briefingId?: string;
  codeWorkspacePath?: string;
  metadata?: Record<string, unknown>;
}

export interface SubconsciousEvidence {
  id: string;
  targetKey: string;
  type: string;
  summary: string;
  details?: string;
  fingerprint: string;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export interface SubconsciousRun {
  id: string;
  targetKey: string;
  workspaceId?: string;
  stage: SubconsciousRunStage;
  outcome?: SubconsciousRunOutcome;
  evidenceFingerprint: string;
  evidenceSummary: string;
  artifactRoot: string;
  dispatchKind?: SubconsciousDispatchKind;
  dispatchStatus?: SubconsciousDispatchStatus;
  blockedReason?: string;
  error?: string;
  rejectedHypothesisIds: string[];
  startedAt: number;
  completedAt?: number;
  createdAt: number;
}

export interface SubconsciousHypothesis {
  id: string;
  runId: string;
  targetKey: string;
  title: string;
  summary: string;
  rationale: string;
  confidence: number;
  evidenceRefs: string[];
  status: SubconsciousHypothesisStatus;
  createdAt: number;
}

export interface SubconsciousCritique {
  id: string;
  runId: string;
  targetKey: string;
  hypothesisId: string;
  verdict: SubconsciousCritiqueVerdict;
  objection: string;
  response?: string;
  evidenceRefs: string[];
  createdAt: number;
}

export interface SubconsciousDecision {
  id: string;
  runId: string;
  targetKey: string;
  winningHypothesisId: string;
  winnerSummary: string;
  recommendation: string;
  rejectedHypothesisIds: string[];
  rationale: string;
  nextBacklog: string[];
  outcome: SubconsciousRunOutcome;
  createdAt: number;
}

export interface SubconsciousBacklogItem {
  id: string;
  targetKey: string;
  title: string;
  summary: string;
  status: SubconsciousBacklogStatus;
  priority: number;
  executorKind?: SubconsciousDispatchKind;
  sourceRunId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SubconsciousDispatchRecord {
  id: string;
  runId: string;
  targetKey: string;
  kind: SubconsciousDispatchKind;
  status: SubconsciousDispatchStatus;
  taskId?: string;
  externalRefId?: string;
  summary: string;
  error?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  completedAt?: number;
}

export interface SubconsciousTargetSummary {
  key: string;
  target: SubconsciousTargetRef;
  health: SubconsciousHealth;
  state: SubconsciousTargetState;
  lastWinner?: string;
  lastRunAt?: number;
  lastEvidenceAt?: number;
  backlogCount: number;
  evidenceFingerprint?: string;
  lastDispatchKind?: SubconsciousDispatchKind;
  lastDispatchStatus?: SubconsciousDispatchStatus;
}

export interface SubconsciousTargetDetail {
  target: SubconsciousTargetSummary;
  latestEvidence: SubconsciousEvidence[];
  recentRuns: SubconsciousRun[];
  latestHypotheses: SubconsciousHypothesis[];
  latestCritiques: SubconsciousCritique[];
  latestDecision?: SubconsciousDecision;
  backlog: SubconsciousBacklogItem[];
  dispatchHistory: SubconsciousDispatchRecord[];
}

export interface SubconsciousBrainSummary {
  status: SubconsciousBrainStatus;
  enabled: boolean;
  cadenceMinutes: number;
  targetCount: number;
  activeRunCount: number;
  lastRunAt?: number;
  updatedAt: number;
}

export interface SubconsciousModelRouting {
  collectingEvidence?: string;
  ideation?: string;
  critique?: string;
  synthesis?: string;
}

export interface SubconsciousDispatchDefaults {
  autoDispatch: boolean;
  defaultKinds: Partial<Record<SubconsciousTargetKind, SubconsciousDispatchKind>>;
}

export interface SubconsciousExecutorPolicy {
  task: { enabled: boolean };
  suggestion: { enabled: boolean };
  scheduledTask: { enabled: boolean };
  briefing: { enabled: boolean };
  eventTriggerUpdate: { enabled: boolean };
  mailboxAutomation: { enabled: boolean };
  codeChangeTask: {
    enabled: boolean;
    requireWorktree: boolean;
    strictReview: boolean;
    verificationRequired: boolean;
  };
}

export interface SubconsciousSettings {
  enabled: boolean;
  autoRun: boolean;
  cadenceMinutes: number;
  enabledTargetKinds: SubconsciousTargetKind[];
  phaseModels: SubconsciousModelRouting;
  dispatchDefaults: SubconsciousDispatchDefaults;
  artifactRetentionDays: number;
  maxHypothesesPerRun: number;
  perExecutorPolicy: SubconsciousExecutorPolicy;
}

export interface SubconsciousRefreshResult {
  targetCount: number;
  evidenceCount: number;
}

export interface SubconsciousHistoryResetResult {
  resetAt: number;
  deleted: {
    targets: number;
    runs: number;
    hypotheses: number;
    critiques: number;
    decisions: number;
    backlogItems: number;
    dispatchRecords: number;
  };
}

export const SUBCONSCIOUS_TARGET_KINDS: SubconsciousTargetKind[] = [
  "global",
  "workspace",
  "agent_role",
  "mailbox_thread",
  "scheduled_task",
  "event_trigger",
  "briefing",
  "code_workspace",
];

export const DEFAULT_SUBCONSCIOUS_SETTINGS: SubconsciousSettings = {
  enabled: false,
  autoRun: true,
  cadenceMinutes: 24 * 60,
  enabledTargetKinds: [...SUBCONSCIOUS_TARGET_KINDS],
  phaseModels: {
    ideation: "cheap",
    critique: "strong",
    synthesis: "strong",
  },
  dispatchDefaults: {
    autoDispatch: true,
    defaultKinds: {
      global: "suggestion",
      workspace: "task",
      agent_role: "task",
      mailbox_thread: "mailbox_automation",
      scheduled_task: "scheduled_task",
      event_trigger: "event_trigger_update",
      briefing: "briefing",
      code_workspace: "code_change_task",
    },
  },
  artifactRetentionDays: 30,
  maxHypothesesPerRun: 4,
  perExecutorPolicy: {
    task: { enabled: true },
    suggestion: { enabled: true },
    scheduledTask: { enabled: true },
    briefing: { enabled: true },
    eventTriggerUpdate: { enabled: true },
    mailboxAutomation: { enabled: true },
    codeChangeTask: {
      enabled: true,
      requireWorktree: true,
      strictReview: true,
      verificationRequired: true,
    },
  },
};
