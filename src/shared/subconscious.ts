export type SubconsciousTargetKind =
  | "global"
  | "workspace"
  | "agent_role"
  | "code_workspace"
  | "pull_request";

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
  | "sleep"
  | "suggest"
  | "dispatch"
  | "notify"
  | "defer"
  | "dismiss"
  | "blocked"
  | "failed";

export type SubconsciousHypothesisStatus = "proposed" | "rejected" | "winner";
export type SubconsciousCritiqueVerdict = "support" | "mixed" | "reject";
export type SubconsciousBacklogStatus = "open" | "dispatched" | "done" | "rejected";
export type SubconsciousDispatchKind =
  | "task"
  | "suggestion"
  | "notify"
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
export type SubconsciousAutonomyMode =
  | "recommendation_first"
  | "balanced_autopilot"
  | "strong_autonomy";
export type SubconsciousPersistence = "sessionOnly" | "durable";
export type SubconsciousMissedRunPolicy = "skip" | "catchUp" | "reconsider";
export type SubconsciousRiskLevel = "low" | "medium" | "high";
export type SubconsciousPermissionDecision = "allowed" | "escalated" | "blocked";
export type SubconsciousNotificationIntent =
  | "input_needed"
  | "important_action_taken"
  | "completed_while_away";
export type SubconsciousMemoryBucket =
  | "user_preference"
  | "project_state"
  | "open_thread"
  | "reliable_pattern"
  | "watch_item"
  | "stale_or_invalidated";
export type SubconsciousJournalEntryKind =
  | "observation"
  | "decision"
  | "action"
  | "notification"
  | "sleep"
  | "dream";

export interface SubconsciousTargetRef {
  key: string;
  kind: SubconsciousTargetKind;
  label: string;
  workspaceId?: string;
  agentRoleId?: string;
  codeWorkspacePath?: string;
  pullRequestId?: string;
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
  confidence?: number;
  riskLevel?: SubconsciousRiskLevel;
  evidenceSources?: string[];
  evidenceFreshness?: number;
  permissionDecision?: SubconsciousPermissionDecision;
  notificationIntent?: SubconsciousNotificationIntent;
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

export interface SubconsciousJournalEntry {
  id: string;
  targetKey?: string;
  runId?: string;
  kind: SubconsciousJournalEntryKind;
  summary: string;
  details?: string;
  outcome?: SubconsciousRunOutcome;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export interface SubconsciousMemoryItem {
  id: string;
  targetKey?: string;
  bucket: SubconsciousMemoryBucket;
  summary: string;
  details?: string;
  confidence: number;
  stale: boolean;
  sourceRunIds: string[];
  createdAt: number;
  updatedAt: number;
  lastValidatedAt?: number;
  invalidatedAt?: number;
}

export interface SubconsciousDreamArtifact {
  id: string;
  targetKey?: string;
  createdAt: number;
  digest: string[];
  backlogProposals: string[];
  targetHealthSummary?: string;
  memoryUpdates: SubconsciousMemoryItem[];
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
  persistence: SubconsciousPersistence;
  missedRunPolicy: SubconsciousMissedRunPolicy;
  nextEligibleAt?: number;
  lastObservedAt?: number;
  lastActionAt?: number;
  expiresAt?: number;
  jitterMs?: number;
  lastMeaningfulOutcome?: SubconsciousRunOutcome;
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
  journal: SubconsciousJournalEntry[];
  memory: SubconsciousMemoryItem[];
  dreams: SubconsciousDreamArtifact[];
}

export interface SubconsciousBrainSummary {
  status: SubconsciousBrainStatus;
  enabled: boolean;
  autonomyMode: SubconsciousAutonomyMode;
  cadenceMinutes: number;
  targetCount: number;
  activeRunCount: number;
  lastRunAt?: number;
  lastDreamAt?: number;
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
  notify: { enabled: boolean };
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
  durableTargetKinds: SubconsciousTargetKind[];
  catchUpOnRestart: boolean;
  journalingEnabled: boolean;
  dreamsEnabled: boolean;
  dreamCadenceHours: number;
  autonomyMode: SubconsciousAutonomyMode;
  trustedTargetKeys: string[];
  phaseModels: SubconsciousModelRouting;
  dispatchDefaults: SubconsciousDispatchDefaults;
  artifactRetentionDays: number;
  maxHypothesesPerRun: number;
  notificationPolicy: {
    inputNeeded: boolean;
    importantActionTaken: boolean;
    completedWhileAway: boolean;
    throttleMinutes: number;
    quietHoursStart: number;
    quietHoursEnd: number;
  };
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
  "code_workspace",
  "pull_request",
];

export const DEFAULT_SUBCONSCIOUS_SETTINGS: SubconsciousSettings = {
  enabled: false,
  autoRun: true,
  cadenceMinutes: 24 * 60,
  enabledTargetKinds: [...SUBCONSCIOUS_TARGET_KINDS],
  durableTargetKinds: ["global", "workspace", "code_workspace", "pull_request"],
  catchUpOnRestart: false,
  journalingEnabled: true,
  dreamsEnabled: true,
  dreamCadenceHours: 24,
  autonomyMode: "recommendation_first",
  trustedTargetKeys: [],
  phaseModels: {
    ideation: "cheap",
    critique: "strong",
    synthesis: "strong",
  },
  dispatchDefaults: {
    autoDispatch: false,
    defaultKinds: {
      global: "suggestion",
      workspace: "suggestion",
      agent_role: "suggestion",
      code_workspace: "suggestion",
      pull_request: "suggestion",
    },
  },
  artifactRetentionDays: 30,
  maxHypothesesPerRun: 4,
  notificationPolicy: {
    inputNeeded: true,
    importantActionTaken: true,
    completedWhileAway: true,
    throttleMinutes: 30,
    quietHoursStart: 22,
    quietHoursEnd: 8,
  },
  perExecutorPolicy: {
    task: { enabled: true },
    suggestion: { enabled: true },
    notify: { enabled: true },
    codeChangeTask: {
      enabled: true,
      requireWorktree: true,
      strictReview: true,
      verificationRequired: true,
    },
  },
};
