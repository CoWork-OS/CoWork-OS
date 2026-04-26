import type { UiTimelineEvent } from "./timeline-events";

// Core types shared between main and renderer processes

// Theme and Appearance types
export type ThemeMode = "light" | "dark" | "system";
export type VisualTheme = "terminal" | "warm" | "oblivion";
export type AccentColor =
  | "cyan"
  | "blue"
  | "purple"
  | "pink"
  | "rose"
  | "orange"
  | "green"
  | "teal"
  | "coral";
export type UiDensity = "focused" | "full" | "power";
export type TimelineVerbosity = "summary" | "verbose";

export interface AppearanceSettings {
  themeMode: ThemeMode;
  visualTheme: VisualTheme;
  accentColor: AccentColor;
  transparencyEffectsEnabled?: boolean;
  uiDensity?: UiDensity;
  timelineVerbosity?: TimelineVerbosity;
  devRunLoggingEnabled?: boolean; // Persist npm run dev stdout/stderr to logs/
  language?: string; // Persisted language preference (e.g. 'en', 'ja', 'zh')
  disclaimerAccepted?: boolean;
  onboardingCompleted?: boolean;
  onboardingCompletedAt?: string; // ISO timestamp of when onboarding was completed
  assistantName?: string; // User-chosen name for the assistant (default: "CoWork")
}

// Tray (Menu Bar) Settings
export interface TraySettings {
  enabled: boolean;
  showDockIcon: boolean;
  startMinimized: boolean;
  closeToTray: boolean;
  showNotifications: boolean;
  showApprovalSavedNotifications: boolean;
}

// Global memory feature toggles (applies across workspaces)
export interface MemoryFeaturesSettings {
  /** Inject `.cowork/*` context pack into the agent prompt (workspace-scoped files). */
  contextPackInjectionEnabled: boolean;
  /** Allow the heartbeat system to perform memory maintenance tasks. */
  heartbeatMaintenanceEnabled: boolean;
  /** Capture structured + verbatim checkpoints during runtime lifecycle events. */
  checkpointCaptureEnabled?: boolean;
  /** Enable quote-first exact-span recall across transcripts, memories, and notes. */
  verbatimRecallEnabled?: boolean;
  /** Use explicit wake-up memory layers and inject only L0/L1 by default. */
  wakeUpLayersEnabled?: boolean;
  /** Track KG edge validity windows and time-aware historical recall. */
  temporalKnowledgeEnabled?: boolean;
  /** Rebuild execution prompts from explicit prompt-stack layers. */
  promptStackV2Enabled?: boolean;
  /** Serve memory via file-backed index/topic layers under `.cowork/memory/`. */
  layeredMemoryEnabled?: boolean;
  /** Persist append-only transcript spans and lightweight checkpoints. */
  transcriptStoreEnabled?: boolean;
  /** Run background memory consolidation after meaningful task activity. */
  backgroundConsolidationEnabled?: boolean;
  /** Route execution turns through the extracted query orchestrator. */
  queryOrchestratorEnabled?: boolean;
  /** Enable session lineage metadata and session forking flows. */
  sessionLineageEnabled?: boolean;
  /** Keep a small curated hot-memory layer always available for prompt injection. */
  curatedMemoryEnabled?: boolean;
  /** Allow transcript/session recall as an explicit tool surface. */
  sessionRecallEnabled?: boolean;
  /** Allow explicit topic-pack loading from `.cowork/memory/topics`. */
  topicMemoryEnabled?: boolean;
  /** Keep legacy archive memory out of default prompt injection. */
  defaultArchiveInjectionEnabled?: boolean;
  /** Promote only explicit/high-signal facts into curated memory. */
  autoPromoteToCuratedMemoryEnabled?: boolean;
}

export type SupermemorySearchMode = "hybrid" | "memories";

export interface SupermemoryCustomContainer {
  tag: string;
  description?: string;
}

export interface SupermemorySettings {
  enabled: boolean;
  apiKey?: string;
  baseUrl?: string;
  containerTagTemplate?: string;
  includeProfileInPrompt?: boolean;
  mirrorMemoryWrites?: boolean;
  searchMode?: SupermemorySearchMode;
  rerank?: boolean;
  threshold?: number;
  customContainers?: SupermemoryCustomContainer[];
}

export interface SupermemoryConfigStatus {
  enabled: boolean;
  apiKeyConfigured: boolean;
  baseUrl: string;
  containerTagTemplate: string;
  includeProfileInPrompt: boolean;
  mirrorMemoryWrites: boolean;
  searchMode: SupermemorySearchMode;
  rerank: boolean;
  threshold: number;
  customContainers: SupermemoryCustomContainer[];
  circuitBreakerUntil?: number | null;
  lastError?: string | null;
  isConfigured: boolean;
}

export type MemoryWakeUpLayerId = "L0" | "L1" | "L2" | "L3";

export interface MemoryLayerBudgetStatus {
  usedTokens: number;
  budgetTokens: number;
  excludedCount: number;
}

export interface MemoryLayerPreview {
  layer: MemoryWakeUpLayerId;
  title: string;
  description: string;
  includedText: string;
  excludedText?: string;
  budget: MemoryLayerBudgetStatus;
  injectedByDefault: boolean;
}

export interface MemoryLayerPreviewPayload {
  workspaceId: string;
  taskPrompt: string;
  generatedAt: number;
  injectedLayerIds: MemoryWakeUpLayerId[];
  excludedLayerIds: MemoryWakeUpLayerId[];
  layers: MemoryLayerPreview[];
}

export type VerbatimQuoteSourceType =
  | "transcript_span"
  | "task_message"
  | "memory"
  | "workspace_markdown";

export interface VerbatimQuoteSearchResult {
  id: string;
  sourceType: VerbatimQuoteSourceType;
  objectId: string;
  taskId?: string;
  timestamp: number;
  path?: string;
  excerpt: string;
  relevanceScore: number;
  sourcePriority: number;
  rankingReason: string;
  eventId?: string;
  seq?: number;
  startLine?: number;
  endLine?: number;
  memoryType?: string;
}

export type CuratedMemoryTarget = "user" | "workspace";

export type CuratedMemoryKind =
  | "identity"
  | "preference"
  | "constraint"
  | "workflow_rule"
  | "project_fact"
  | "active_commitment";

export interface CuratedMemoryEntry {
  id: string;
  workspaceId: string;
  taskId?: string;
  target: CuratedMemoryTarget;
  kind: CuratedMemoryKind;
  content: string;
  normalizedKey: string;
  source: "agent_tool" | "user_edit" | "migration" | "distill";
  confidence: number;
  status: "active" | "archived";
  createdAt: number;
  updatedAt: number;
  lastConfirmedAt?: number;
}

export type AwarenessSource =
  | "conversation"
  | "feedback"
  | "files"
  | "git"
  | "apps"
  | "browser"
  | "calendar"
  | "notifications"
  | "clipboard"
  | "tasks";

export type AwarenessSensitivity = "low" | "medium" | "high";

export type AwarenessBeliefType =
  | "user_fact"
  | "user_preference"
  | "user_goal"
  | "workflow_habit"
  | "project_affinity"
  | "device_context"
  | "open_loop"
  | "due_soon";

export type AwarenessPromotionStatus = "observed" | "promoted" | "confirmed";

export interface AwarenessSourcePolicy {
  enabled: boolean;
  ttlMinutes: number;
  allowPromotion: boolean;
  allowPromptInjection: boolean;
  allowHeartbeat: boolean;
}

export interface AwarenessConfig {
  privateModeEnabled: boolean;
  defaultTtlMinutes: number;
  sources: Record<AwarenessSource, AwarenessSourcePolicy>;
}

export interface AwarenessEvent {
  id: string;
  source: AwarenessSource;
  timestamp: number;
  workspaceId?: string;
  title: string;
  summary: string;
  sensitivity: AwarenessSensitivity;
  fingerprint: string;
  payload?: Record<string, unknown>;
  tags?: string[];
}

export interface AwarenessBelief {
  id: string;
  beliefType: AwarenessBeliefType;
  subject: string;
  value: string;
  confidence: number;
  evidenceRefs: string[];
  workspaceId?: string;
  source: AwarenessSource;
  promotionStatus: AwarenessPromotionStatus;
  createdAt: number;
  updatedAt: number;
  lastConfirmedAt?: number;
}

export interface AwarenessSummaryItem {
  id: string;
  title: string;
  detail: string;
  source: AwarenessSource;
  workspaceId?: string;
  score: number;
  tags: string[];
  requiresHeartbeat?: boolean;
}

export interface AwarenessSummary {
  generatedAt: number;
  workspaceId?: string;
  currentFocus?: string;
  whatChanged: AwarenessSummaryItem[];
  whatMattersNow: AwarenessSummaryItem[];
  dueSoon: AwarenessSummaryItem[];
  beliefs: AwarenessBelief[];
  wakeReasons: AwarenessWakeReason[];
}

export interface AwarenessSnapshot {
  generatedAt: number;
  workspaceId?: string;
  currentFocus?: string;
  activeApp?: string;
  activeWindowTitle?: string;
  browserContext?: string;
  recentFiles: string[];
  recentProjects: string[];
  recentIntents: string[];
  dueSoon: string[];
  beliefs: AwarenessBelief[];
  text: string;
}

export type AwarenessWakeReason =
  | "context_shift"
  | "focus_shift"
  | "deadline_risk"
  | "repeated_workflow"
  | "idle_window"
  | "due_soon";

export type GoalStateStatus =
  | "observed"
  | "active"
  | "blocked"
  | "completed"
  | "stale";

export interface GoalState {
  id: string;
  workspaceId?: string;
  title: string;
  status: GoalStateStatus;
  confidence: number;
  source: AwarenessSource | "profile" | "relationship";
  evidenceRefs: string[];
  lastSeenAt: number;
  dueAt?: number;
}

export interface ProjectState {
  id: string;
  workspaceId?: string;
  name: string;
  confidence: number;
  source: AwarenessSource | "belief";
  evidenceRefs: string[];
  lastActiveAt: number;
  recentFiles: string[];
}

export interface OpenLoopState {
  id: string;
  workspaceId?: string;
  title: string;
  status: "open" | "in_progress" | "done" | "stale";
  confidence: number;
  source: AwarenessSource | "relationship";
  evidenceRefs: string[];
  dueAt?: number;
  lastUpdatedAt: number;
}

export interface RoutineState {
  id: string;
  workspaceId?: string;
  title: string;
  description: string;
  confidence: number;
  source: AwarenessSource | "belief";
  evidenceRefs: string[];
  trigger: string;
  suggestedActionType: ChiefOfStaffActionType;
  cooldownMinutes: number;
  lastObservedAt: number;
  lastExecutedAt?: number;
  paused?: boolean;
}

export interface FocusSessionState {
  id: string;
  workspaceId?: string;
  focusLabel: string;
  activeApp?: string;
  activeWindowTitle?: string;
  activeProject?: string;
  mode: "deep_work" | "research" | "planning" | "meeting" | "mixed";
  startedAt: number;
  lastActiveAt: number;
}

export type AutonomyPolicyLevel =
  | "observe_only"
  | "suggest_only"
  | "execute_local"
  | "execute_with_approval"
  | "never";

export type ChiefOfStaffActionType =
  | "prepare_briefing"
  | "create_task"
  | "schedule_follow_up"
  | "draft_message"
  | "draft_agenda"
  | "organize_work_session"
  | "nudge_user"
  | "execute_local_action";

export interface ActionPolicy {
  actionType: ChiefOfStaffActionType;
  level: AutonomyPolicyLevel;
  allowExternalSideEffects: boolean;
  cooldownMinutes: number;
}

export interface AutonomyDecision {
  id: string;
  workspaceId?: string;
  title: string;
  description: string;
  actionType: ChiefOfStaffActionType;
  policyLevel: AutonomyPolicyLevel;
  priority: CompanyPriority;
  status: "pending" | "suggested" | "executed" | "dismissed" | "done";
  reason: string;
  evidenceRefs: string[];
  fingerprint: string;
  createdAt: number;
  updatedAt: number;
  cooldownUntil?: number;
  suggestedTaskTitle?: string;
  suggestedPrompt?: string;
  /** Set when decision is from a routine; used for cooldown tracking */
  routineId?: string;
}

export interface AutonomyAction {
  id: string;
  decisionId?: string;
  workspaceId?: string;
  actionType: ChiefOfStaffActionType;
  status: "queued" | "success" | "failed" | "skipped";
  summary: string;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export interface AutonomyOutcome {
  id: string;
  actionId: string;
  decisionId?: string;
  workspaceId?: string;
  outcome: "accepted" | "ignored" | "reversed" | "succeeded" | "failed";
  summary: string;
  createdAt: number;
}

export interface ChiefOfStaffWorldModel {
  generatedAt: number;
  workspaceId?: string;
  focusSession?: FocusSessionState;
  goals: GoalState[];
  projects: ProjectState[];
  openLoops: OpenLoopState[];
  routines: RoutineState[];
  beliefs: AwarenessBelief[];
  currentPriorities: string[];
  continuityNotes: string[];
}

export interface AutonomyConfig {
  enabled: boolean;
  autoEvaluate: boolean;
  maxPendingDecisions: number;
  actionPolicies: Record<ChiefOfStaffActionType, ActionPolicy>;
}

export type UserFactCategory =
  | "identity"
  | "preference"
  | "bio"
  | "work"
  | "goal"
  | "constraint"
  | "other";

export interface UserFact {
  id: string;
  category: UserFactCategory;
  value: string;
  confidence: number; // 0..1
  source: "conversation" | "feedback" | "manual";
  pinned?: boolean;
  firstSeenAt: number;
  lastUpdatedAt: number;
  lastTaskId?: string;
}

export interface UserProfile {
  summary?: string;
  facts: UserFact[];
  updatedAt: number;
}

export interface AddUserFactRequest {
  category: UserFactCategory;
  value: string;
  confidence?: number;
  source?: "conversation" | "feedback" | "manual";
  pinned?: boolean;
  taskId?: string;
}

export interface UpdateUserFactRequest {
  id: string;
  category?: UserFactCategory;
  value?: string;
  confidence?: number;
  pinned?: boolean;
}

// Workspace Kit (.cowork) helpers (workspace-scoped, file-based context)
export interface WorkspaceKitIssue {
  level: "error" | "warning";
  code: string;
  message: string;
}

export interface WorkspaceKitFileStatus {
  relPath: string;
  exists: boolean;
  sizeBytes?: number;
  modifiedAt?: number;
  title?: string;
  stale?: boolean;
  issues?: WorkspaceKitIssue[];
  revisionCount?: number;
  specialHandling?: "bootstrap" | "heartbeat";
}

export interface WorkspaceKitStatus {
  workspaceId: string;
  workspacePath?: string;
  hasKitDir: boolean;
  files: WorkspaceKitFileStatus[];
  missingCount: number;
  lintWarningCount?: number;
  lintErrorCount?: number;
  onboarding?: {
    bootstrapSeededAt?: number;
    onboardingCompletedAt?: number;
    bootstrapPresent: boolean;
  };
}

export type WorkspaceKitInitMode = "missing" | "overwrite";

export interface WorkspaceKitInitRequest {
  workspaceId: string;
  mode?: WorkspaceKitInitMode;
  templatePreset?: WorkspaceKitTemplatePreset;
}

export interface WorkspaceKitProjectCreateRequest {
  workspaceId: string;
  projectId: string;
}

export type WorkspaceKitTemplatePreset = "default" | "venture_operator";

export const ACCENT_COLORS: { id: AccentColor; label: string }[] = [
  { id: "cyan", label: "Cyan" },
  { id: "blue", label: "Blue" },
  { id: "purple", label: "Purple" },
  { id: "pink", label: "Pink" },
  { id: "rose", label: "Rose" },
  { id: "orange", label: "Orange" },
  { id: "green", label: "Green" },
  { id: "teal", label: "Teal" },
  { id: "coral", label: "Coral" },
];

export type TaskStatus =
  | "pending"
  | "queued"
  | "planning"
  | "executing"
  | "paused"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type VerificationOutcome =
  | "pass"
  | "fail_blocking"
  | "pending_user_action"
  | "warn_non_blocking";

export type VerificationScope = "high_risk" | "normal";

export type VerificationEvidenceMode =
  | "agent_observable"
  | "user_observable"
  | "time_blocked";

export const TASK_ERROR_CODES = {
  TURN_LIMIT_EXCEEDED: "TURN_LIMIT_EXCEEDED",
} as const;

export type TaskErrorCode =
  (typeof TASK_ERROR_CODES)[keyof typeof TASK_ERROR_CODES];

/**
 * Reason for command termination - used to signal the agent why a command ended
 */
export type CommandTerminationReason =
  | "normal" // Command completed naturally
  | "user_stopped" // User explicitly killed the process
  | "timeout" // Command exceeded timeout limit
  | "error"; // Spawn/execution error

export type EventType =
  | "task_created"
  | "task_completed"
  | "plan_created"
  | "plan_revised"
  | "step_started"
  | "step_completed"
  | "step_failed"
  | "executing"
  | "tool_call"
  | "tool_result"
  | "tool_error"
  | "assistant_message"
  | "approval_requested"
  | "approval_granted"
  | "approval_denied"
  | "input_request_created"
  | "input_request_resolved"
  | "input_request_dismissed"
  | "skill_parameter_collection_started"
  | "skill_parameter_answered"
  | "skill_parameter_collection_finished"
  | "file_created"
  | "file_modified"
  | "file_deleted"
  | "image_generated"
  | "error"
  | "log"
  | "verification_started"
  | "verification_passed"
  | "verification_failed"
  | "entropy_sweep_started"
  | "entropy_sweep_completed"
  | "entropy_sweep_failed"
  | "review_quality_passed"
  | "review_quality_failed"
  | "verification_pending_user_action"
  | "retry_started"
  | "task_cancelled"
  | "task_paused"
  | "task_resumed"
  | "continuation_decision"
  | "auto_continuation_started"
  | "auto_continuation_blocked"
  | "context_compaction_started"
  | "context_compaction_completed"
  | "context_compaction_failed"
  | "no_progress_circuit_breaker"
  | "step_contract_escalated"
  | "task_interrupted"
  | "task_status"
  | "task_queued"
  | "task_dequeued"
  | "queue_updated"
  | "plan_revision_blocked"
  | "step_timeout"
  | "tool_blocked"
  | "mode_gate_blocked"
  | "execution_mode_auto_promoted"
  | "plan_contract_conflict"
  | "workspace_boundary_recovery"
  | "workspace_path_alias_normalized"
  | "workspace_path_alias_recovery_attempted"
  | "workspace_path_alias_recovery_failed"
  | "task_path_root_pinned"
  | "task_path_rewrite_applied"
  | "task_path_recovery_attempted"
  | "task_path_recovery_failed"
  | "tool_disable_suppressed_recoverable_path_drift"
  | "mutation_checkpoint_retry_applied"
  | "step_contract_satisfied_by_prior_mutation"
  | "required_tool_inference_decision"
  | "mutation_duplicate_bypass_applied"
  | "step_contract_reconciled_posthoc"
  | "verification_checklist_evaluated"
  | "verification_mode_selected"
  | "follow_up_tool_lock_forced_finalization"
  | "tool_protocol_violation"
  | "turn_window_soft_exhausted"
  | "follow_up_turn_recovery_started"
  | "follow_up_turn_recovery_completed"
  | "follow_up_turn_recovery_blocked"
  | "safety_stop_triggered"
  | "turn_policy_selected"
  | "verification_preflight_policy_applied"
  | "verification_artifact_output_downgraded"
  | "verification_missing_artifact_ignored"
  | "verification_text_checklist_evaluated"
  | "progress_update"
  | "learning_progress"
  | "shell_session_created"
  | "shell_session_updated"
  | "shell_session_reset"
  | "shell_session_closed"
  | "llm_routing_changed"
  | "llm_retry"
  | "follow_up_completed"
  | "follow_up_failed"
  | "tool_warning"
  | "workspace_permissions_updated"
  | "user_message"
  | "user_feedback"
  | "command_output"
  // LLM usage tracking (tokens/cost)
  | "llm_usage"
  | "llm_error"
  // Real-time streaming progress (ephemeral, not persisted to DB)
  | "llm_streaming"
  // Sub-Agent / Parallel Agent events
  | "agent_spawned" // Parent spawned a child agent
  | "agent_completed" // Child agent completed successfully
  | "agent_failed" // Child agent failed
  | "sub_agent_result" // Result summary from child agent
  // Unified orchestration graph events
  | "orchestration_run_created"
  | "orchestration_node_ready"
  | "orchestration_node_dispatched"
  | "orchestration_node_completed"
  | "orchestration_node_failed"
  | "orchestration_run_completed"
  | "orchestration_run_failed"
  // Context management
  | "context_summarized" // Earlier messages were dropped and summarized
  // Conversation persistence
  | "conversation_snapshot" // Full conversation history for restoration
  // Git Worktree events
  | "worktree_created" // Worktree was set up for this task
  | "worktree_committed" // Auto-commit happened in worktree
  | "worktree_merge_start" // Merge to base branch started
  | "worktree_merged" // Successfully merged to base branch
  | "worktree_conflict" // Merge conflict detected
  | "worktree_cleaned" // Worktree removed after completion
  // Comparison mode events
  | "comparison_started" // Comparison session started
  | "comparison_completed" // Comparison session completed
  // Collaborative Thoughts events (team multi-agent thinking)
  | "agent_thought" // Agent sharing analysis/reasoning with team
  | "synthesis_started" // Leader beginning synthesis of team thoughts
  | "synthesis_completed" // Leader completed synthesis
  // Step-level user feedback events
  | "step_feedback" // User sent feedback on an in-progress step
  | "step_skipped" // Step was skipped by user intervention
  // Citation engine events
  | "citations_collected" // Web research citations gathered
  // Workflow decomposition events
  | "workflow_detected" // Multi-phase workflow identified
  | "workflow_phase_started" // Pipeline phase started
  | "workflow_phase_completed" // Pipeline phase completed
  | "workflow_phase_failed" // Pipeline phase failed
  | "pipeline_completed" // Full workflow pipeline completed
  | "step_intent_scored" // Heuristic alignment of plan steps vs task intent
  // Document generation events
  | "artifact_created" // Document/file artifact generated
  | "diagram_created" // Mermaid diagram generated by agent
  // Deep work mode events
  | "progress_journal" // Periodic human-readable status update for long-running tasks
  | "research_recovery_started" // Agent began researching error before retry
  | "task_list_created"
  | "task_list_updated"
  | "task_list_verification_nudged"
  // Timeline V2 canonical event set
  | "timeline_group_started"
  | "timeline_group_finished"
  | "timeline_step_started"
  | "timeline_step_updated"
  | "timeline_step_finished"
  | "timeline_evidence_attached"
  | "timeline_artifact_emitted"
  | "timeline_command_output"
  | "timeline_error";

export type TimelineEventType =
  | "timeline_group_started"
  | "timeline_group_finished"
  | "timeline_step_started"
  | "timeline_step_updated"
  | "timeline_step_finished"
  | "timeline_evidence_attached"
  | "timeline_artifact_emitted"
  | "timeline_command_output"
  | "timeline_error";

export type TimelineEventStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "blocked"
  | "skipped"
  | "cancelled";

export type TimelineEventActor =
  | "system"
  | "agent"
  | "user"
  | "tool"
  | "subagent";

export type TimelineStage = "DISCOVER" | "BUILD" | "VERIFY" | "FIX" | "DELIVER";

export type OrchestrationGraphRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type OrchestrationGraphNodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked";

export type OrchestrationGraphNodeKind =
  | "child_task"
  | "workflow_phase"
  | "team_work_item"
  | "synthesis"
  | "verification"
  | "acp_task";

export type OrchestrationDispatchTarget =
  | "native_child_task"
  | "local_role"
  | "remote_acp"
  | "external_runtime";

export interface OrchestrationGraphRun {
  id: string;
  rootTaskId: string;
  workspaceId: string;
  kind: "delegation" | "workflow" | "team" | "acp";
  status: OrchestrationGraphRunStatus;
  maxParallel: number;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface OrchestrationGraphNode {
  id: string;
  runId: string;
  key: string;
  title: string;
  prompt: string;
  kind: OrchestrationGraphNodeKind;
  status: OrchestrationGraphNodeStatus;
  dispatchTarget: OrchestrationDispatchTarget;
  workerRole?: WorkerRoleKind;
  parentTaskId?: string;
  assignedAgentRoleId?: string;
  capabilityHint?: ModelCapability;
  acpAgentId?: string;
  agentConfig?: AgentConfig;
  taskId?: string;
  remoteTaskId?: string;
  publicHandle?: string;
  summary?: string;
  output?: string;
  error?: string;
  verificationVerdict?: VerificationVerdict;
  verificationReport?: string;
  semanticSummary?: string;
  teamRunId?: string;
  teamItemId?: string;
  workflowPhaseId?: string;
  acpTaskId?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface OrchestrationGraphEdge {
  id: string;
  runId: string;
  fromNodeId: string;
  toNodeId: string;
}

export interface OrchestrationNodeNotification {
  runId: string;
  nodeId: string;
  taskId?: string;
  remoteTaskId?: string;
  publicHandle?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  summary: string;
  result?: string;
  usage?: Record<string, unknown>;
  error?: string;
  target: OrchestrationDispatchTarget;
  workerRole?: WorkerRoleKind;
  semanticSummary?: string;
  verificationVerdict?: VerificationVerdict;
  verificationReport?: string;
}

export type WorkerRoleKind =
  | "researcher"
  | "implementer"
  | "verifier"
  | "synthesizer";
export type DelegationWorkerRole = WorkerRoleKind | "auto";

export type VerificationVerdict = "PASS" | "FAIL" | "PARTIAL";

export interface WorkerRoleSpec {
  kind: WorkerRoleKind;
  displayName: string;
  description: string;
  systemPrompt: string;
  conversationMode: ConversationMode;
  allowUserInput: boolean;
  retainMemory: boolean;
  llmProfile: LlmProfile;
  executionMode: ExecutionMode;
  toolRestrictions: string[];
  allowedTools?: string[];
  mutationAllowed: boolean;
  completionContract: string;
}

export interface WorkerPromptContext {
  taskTitle: string;
  taskPrompt: string;
  workspacePath?: string;
  parentSummary?: string;
  evidenceBundle?: string;
  outputSummary?: string;
}

export type RuntimeToolConcurrencyClass =
  | "exclusive"
  | "read_parallel"
  | "side_effect_parallel"
  | "serial_only";

export type RuntimeToolInterruptBehavior = "cancel" | "block";

export type RuntimeToolApprovalKind =
  | "none"
  | "workspace_policy"
  | "external_service"
  | "data_export"
  | "destructive"
  | "shell_sensitive";

export type RuntimeToolSideEffectLevel = "none" | "low" | "medium" | "high";

export type RuntimeToolResultKind =
  | "generic"
  | "read"
  | "mutation"
  | "search"
  | "command"
  | "browser"
  | "artifact"
  | "integration";

export type RuntimeToolCapabilityTag =
  | "core"
  | "code"
  | "research"
  | "browser"
  | "artifact"
  | "integration"
  | "memory"
  | "system"
  | "orchestration"
  | "admin"
  | "shell"
  | "mcp";

export interface RuntimeToolMetadata {
  readOnly: boolean;
  concurrencyClass: RuntimeToolConcurrencyClass;
  interruptBehavior: RuntimeToolInterruptBehavior;
  approvalKind: RuntimeToolApprovalKind;
  sideEffectLevel: RuntimeToolSideEffectLevel;
  deferLoad: boolean;
  alwaysExpose: boolean;
  resultKind: RuntimeToolResultKind;
  supportsContextMutation: boolean;
  capabilityTags: RuntimeToolCapabilityTag[];
  exposure: "always" | "conditional" | "explicit_only";
}

export type SessionChecklistItemKind =
  | "implementation"
  | "verification"
  | "other";
export type SessionChecklistItemStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "blocked";

export interface SessionChecklistItem {
  id: string;
  title: string;
  kind: SessionChecklistItemKind;
  status: SessionChecklistItemStatus;
  createdAt: number;
  updatedAt: number;
}

export interface SessionChecklistState {
  items: SessionChecklistItem[];
  updatedAt: number;
  verificationNudgeNeeded: boolean;
  nudgeReason: string | null;
}

export type ToolPolicyStage =
  | "task_restrictions"
  | "workspace_quick_access"
  | "availability"
  | "mode_and_domain"
  | "workspace_script"
  | "permissions"
  | "approval";

export type ToolPolicyStageDecision =
  | "allow"
  | "defer"
  | "deny"
  | "require_approval"
  | "skip";

export interface ToolPolicyTraceEntry {
  stage: ToolPolicyStage;
  decision: ToolPolicyStageDecision;
  reason?: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

export interface ToolPolicyTrace {
  toolName: string;
  finalDecision: Exclude<ToolPolicyStageDecision, "skip">;
  entries: ToolPolicyTraceEntry[];
}

export type PermissionMode =
  | "default"
  | "plan"
  | "dangerous_only"
  | "accept_edits"
  | "dont_ask"
  | "bypass_permissions";

export type PermissionEffect = "allow" | "deny" | "ask";

export type PermissionRuleSource =
  | "session"
  | "workspace_db"
  | "workspace_manifest"
  | "profile"
  | "legacy_guardrails"
  | "legacy_builtin_settings";

export type PermissionPersistenceDestination =
  | "session"
  | "workspace"
  | "profile";

export type PermissionRuleScope =
  | {
      kind: "tool";
      toolName: string;
    }
  | {
      kind: "domain";
      domain: string;
      toolName?: string;
    }
  | {
      kind: "path";
      path: string;
      toolName?: string;
    }
  | {
      kind: "command_prefix";
      prefix: string;
    }
  | {
      kind: "mcp_server";
      serverName: string;
    };

export interface PermissionRule {
  id?: string;
  source: PermissionRuleSource;
  effect: PermissionEffect;
  scope: PermissionRuleScope;
  createdAt?: number;
  metadata?: Record<string, unknown>;
}

export type PermissionDecisionReason =
  | {
      type: "rule";
      rule: PermissionRule;
      summary: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "mode";
      mode: PermissionMode;
      summary: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "workspace_capability";
      capability: "read" | "write" | "delete" | "network" | "shell";
      summary: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "guardrail";
      summary: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "workspace_script";
      summary: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "task_restriction";
      summary: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "denial_fallback";
      summary: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "bundle_grant";
      summary: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "legacy_compat";
      summary: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "other";
      summary: string;
      metadata?: Record<string, unknown>;
    };

export interface PermissionPromptActionOption {
  action:
    | "allow_once"
    | "deny_once"
    | "allow_session"
    | "deny_session"
    | "allow_workspace"
    | "deny_workspace"
    | "allow_profile"
    | "deny_profile";
  label: string;
  destination?: PermissionPersistenceDestination;
  effect: PermissionEffect;
}

export type FileProvenanceSourceKind =
  | "user_imported_external"
  | "clipboard_or_drag_data"
  | "channel_attachment"
  | "workspace_native"
  | "unknown";

export type FileTrustLevel = "trusted" | "untrusted";

export interface FileProvenanceRecord {
  path: string;
  workspaceId?: string;
  sourceKind: FileProvenanceSourceKind;
  trustLevel: FileTrustLevel;
  sourceLabel?: string;
  recordedAt: number;
  metadata?: Record<string, unknown>;
}

export interface SensitiveSourceRef {
  path: string;
  sourceKind: FileProvenanceSourceKind;
  trustLevel: FileTrustLevel;
  sourceLabel?: string;
  recordedAt?: number;
  metadata?: Record<string, unknown>;
}

export interface ExportTargetRef {
  toolName: string;
  url?: string;
  domain?: string;
  method?: string;
  provider?: string;
}

export interface PermissionSecurityContext {
  exportTarget?: ExportTargetRef;
  directSource?: SensitiveSourceRef | null;
  recentSensitiveSources?: SensitiveSourceRef[];
  recentUntrustedContentRead?: boolean;
}

export interface PermissionPromptDetails {
  scope?: PermissionRuleScope;
  reason: PermissionDecisionReason;
  matchedRule?: PermissionRule;
  scopePreview: string;
  suggestedActions: PermissionPromptActionOption[];
  serverName?: string;
  securityContext?: PermissionSecurityContext;
}

export interface PermissionEvaluationResult {
  decision: PermissionEffect;
  reason: PermissionDecisionReason;
  matchedRule?: PermissionRule;
  suggestions: PermissionPromptActionOption[];
  scopePreview: string;
  metadata?: Record<string, unknown>;
}

export interface PersistedPermissionRule extends PermissionRule {
  workspaceId?: string;
}

export interface PermissionSettingsData {
  version: 1;
  defaultMode: PermissionMode;
  rules: PermissionRule[];
}

export type ToolResultEnvelopeStatus =
  | "queued"
  | "running"
  | "success"
  | "error"
  | "blocked"
  | "cancelled"
  | "discarded";

export interface ToolResultEvidence {
  type: "file" | "command" | "url" | "artifact" | "runtime_log";
  label: string;
  value: string;
  extra?: Record<string, unknown>;
}

export interface ToolResultEnvelope {
  toolUseId: string;
  toolName: string;
  status: ToolResultEnvelopeStatus;
  modelPayload: string;
  userSummary: string;
  structuredData?: unknown;
  evidence: ToolResultEvidence[];
  retryable: boolean;
  policyTrace?: ToolPolicyTrace;
  contextMutation?: Record<string, unknown> | null;
  uiHints?: Record<string, unknown>;
  telemetry?: Record<string, unknown>;
}

export interface EvidenceRef {
  evidenceId: string;
  sourceType: "url" | "file" | "tool_output" | "user_input" | "screen_context" | "other";
  sourceUrlOrPath: string;
  snippet?: string;
  capturedAt: number;
}

export type ToolType =
  | "read_file"
  | "write_file"
  | "copy_file"
  | "list_directory"
  | "rename_file"
  | "move_file"
  | "delete_file"
  | "create_directory"
  | "search_files"
  | "run_skill"
  | "run_command"
  | "compile_latex"
  | "generate_image"
  | "analyze_image"
  // System tools
  | "system_info"
  | "read_clipboard"
  | "write_clipboard"
  | "take_screenshot"
  | "open_application"
  | "open_url"
  | "open_path"
  | "show_in_folder"
  | "get_env"
  | "get_app_paths"
  // Network/Browser tools
  | "web_search"
  | "voice_call"
  | "browser_navigate"
  | "browser_screenshot"
  | "browser_get_content"
  | "browser_click"
  | "browser_fill"
  | "browser_type"
  | "browser_press"
  | "browser_wait"
  | "browser_scroll"
  | "browser_select"
  | "browser_get_text"
  | "browser_evaluate"
  | "browser_back"
  | "browser_forward"
  | "browser_reload"
  | "browser_save_pdf"
  | "browser_close"
  // X/Twitter
  | "x_action"
  // Notion
  | "notion_action"
  // Box
  | "box_action"
  // OneDrive
  | "onedrive_action"
  // Google Workspace (Drive/Gmail/Calendar)
  | "google_drive_action"
  | "gmail_action"
  | "mailbox_action"
  | "calendar_action"
  // Apple Calendar (macOS)
  | "apple_calendar_action"
  // Dropbox
  | "dropbox_action"
  // SharePoint
  | "sharepoint_action"
  // Scraping tools (Scrapling integration)
  | "scrape_page"
  | "scrape_multiple"
  | "scrape_extract"
  | "scrape_session"
  | "scraping_status"
  // Memory tools
  | "memory_save"
  | "memory_curate"
  | "memory_curated_read"
  | "supermemory_profile"
  | "supermemory_search"
  | "supermemory_remember"
  | "supermemory_forget"
  | "search_sessions"
  | "memory_topics_load"
  // Scratchpad tools (session-scoped agent notes)
  | "scratchpad_write"
  | "scratchpad_read"
  // Orchestration tools
  | "orchestrate_agents"
  // QA tools (Playwright visual QA)
  | "qa_run"
  | "qa_navigate"
  | "qa_interact"
  | "qa_screenshot"
  | "qa_check"
  | "qa_report"
  | "qa_cleanup"
  // Computer use tools (CUA)
  | "screen_context_resolve"
  | "screenshot"
  | "click"
  | "double_click"
  | "move_mouse"
  | "drag"
  | "scroll"
  | "type_text"
  | "keypress"
  | "wait"
  // Batch image processing
  | "batch_image_process"
  // Meta tools
  | "revise_plan"
  | "request_user_input"
  | "task_history"
  | "task_events";

export type ApprovalType =
  | "delete_file"
  | "delete_multiple"
  | "bulk_rename"
  | "network_access"
  | "data_export"
  | "external_service"
  | "run_command"
  | "risk_gate"
  | "computer_use";

// ============ Security Tool Groups & Risk Levels ============

/**
 * Tool risk levels for security policy enforcement
 * Higher levels require more permissions/approval
 */
export type ToolRiskLevel =
  | "read"
  | "write"
  | "destructive"
  | "system"
  | "network";

/**
 * Tool groups for policy-based access control
 */
export const TOOL_GROUPS = {
  // Read-only operations - lowest risk
  "group:read": [
    "read_file",
    "read_files",
    "list_directory",
    "search_files",
    "system_info",
    "get_env",
    "get_app_paths",
    // Monty transform library (workspace-local scripts)
    "monty_list_transforms",
    "monty_run_transform",
    "monty_transform_file",
    // Local gateway message history
    "channel_list_chats",
    "channel_history",
    // Discord live API (fetch messages, download attachments)
    "channel_fetch_discord_messages",
    "channel_download_discord_attachment",
    // Session scratchpad (read)
    "scratchpad_read",
  ],
  // Write operations - medium risk
  "group:write": [
    "write_file",
    "edit_file",
    "copy_file",
    "rename_file",
    "create_directory",
    "create_spreadsheet",
    "create_document",
    "compile_latex",
    "edit_document",
    "create_presentation",
    "organize_folder",
    // Monty transform library can write transformed outputs
    "monty_transform_file",
    // Session scratchpad (write)
    "scratchpad_write",
    "batch_image_process",
  ],
  // Destructive operations - high risk, requires approval
  "group:destructive": ["delete_file", "run_command"],
  // System operations - requires explicit permission
  "group:system": [
    "read_clipboard",
    "write_clipboard",
    "take_screenshot",
    "open_application",
    "open_url",
    "open_path",
    "show_in_folder",
    "screen_context_resolve",
    "screenshot",
    "click",
    "double_click",
    "move_mouse",
    "drag",
    "scroll",
    "type_text",
    "keypress",
    "wait",
    "batch_image_process",
  ],
  // Network operations - requires network permission
  "group:network": [
    "web_search",
    "voice_call",
    "x_action",
    "notion_action",
    "box_action",
    "onedrive_action",
    "google_drive_action",
    "gmail_action",
    "mailbox_action",
    "calendar_action",
    "apple_calendar_action",
    "dropbox_action",
    "sharepoint_action",
    "browser_navigate",
    "browser_screenshot",
    "browser_get_content",
    "browser_click",
    "browser_fill",
    "browser_type",
    "browser_press",
    "browser_wait",
    "browser_scroll",
    "browser_select",
    "browser_get_text",
    "browser_evaluate",
    "browser_back",
    "browser_forward",
    "browser_reload",
    "browser_save_pdf",
    "browser_close",
    // Vision (image understanding via external provider)
    "analyze_image",
    "read_pdf_visual",
    // Scraping (Scrapling integration)
    "scrape_page",
    "scrape_multiple",
    "scrape_extract",
    "scrape_session",
    "scraping_status",
    // QA (Playwright visual QA)
    "qa_run",
    "qa_navigate",
    "qa_interact",
    "qa_screenshot",
    "qa_check",
    "qa_report",
    "qa_cleanup",
  ],
  // Memory/sensitive tools - restricted in shared contexts
  "group:memory": [
    "read_clipboard",
    "write_clipboard",
    "task_history",
    "task_events",
    // Privacy-sensitive: exposes prior chat logs across chats
    "channel_list_chats",
    "channel_history",
    "channel_fetch_discord_messages",
    "channel_download_discord_attachment",
    // Privacy-sensitive: can exfiltrate local files/images to a provider
    "analyze_image",
    "read_pdf_visual",
    // Agent-initiated memory save
    "memory_save",
    "memory_curate",
    "memory_curated_read",
    "supermemory_profile",
    "supermemory_search",
    "supermemory_remember",
    "supermemory_forget",
    "search_sessions",
    "memory_topics_load",
  ],
  // Image generation - requires API access
  "group:image": ["generate_image"],
  // Meta/control tools
  "group:meta": ["revise_plan", "request_user_input"],
} as const;

export type ToolGroupName = keyof typeof TOOL_GROUPS;

/**
 * Maps each tool to its risk level
 */
export const TOOL_RISK_LEVELS: Record<ToolType, ToolRiskLevel> = {
  // Read operations
  read_file: "read",
  list_directory: "read",
  search_files: "read",
  system_info: "read",
  get_env: "read",
  get_app_paths: "read",
  // Write operations
  write_file: "write",
  copy_file: "write",
  rename_file: "write",
  move_file: "write",
  create_directory: "write",
  run_skill: "write",
  compile_latex: "write",
  // Destructive operations
  delete_file: "destructive",
  run_command: "destructive",
  // System operations
  read_clipboard: "system",
  write_clipboard: "system",
  take_screenshot: "system",
  open_application: "system",
  open_url: "system",
  open_path: "system",
  show_in_folder: "system",
  screen_context_resolve: "system",
  // Computer use operations (CUA)
  screenshot: "system",
  click: "system",
  double_click: "system",
  move_mouse: "system",
  drag: "system",
  scroll: "system",
  type_text: "system",
  keypress: "system",
  wait: "system",
  // Batch image processing
  batch_image_process: "write",
  // Network operations
  generate_image: "network",
  analyze_image: "network",
  web_search: "network",
  voice_call: "network",
  browser_navigate: "network",
  browser_screenshot: "network",
  browser_get_content: "network",
  browser_click: "network",
  browser_fill: "network",
  browser_type: "network",
  browser_press: "network",
  browser_wait: "network",
  browser_scroll: "network",
  browser_select: "network",
  browser_get_text: "network",
  browser_evaluate: "network",
  browser_back: "network",
  browser_forward: "network",
  browser_reload: "network",
  browser_save_pdf: "network",
  browser_close: "network",
  x_action: "network",
  notion_action: "network",
  box_action: "network",
  onedrive_action: "network",
  google_drive_action: "network",
  gmail_action: "network",
  mailbox_action: "network",
  calendar_action: "network",
  apple_calendar_action: "network",
  dropbox_action: "network",
  sharepoint_action: "network",
  // Scraping (Scrapling)
  scrape_page: "network",
  scrape_multiple: "network",
  scrape_extract: "network",
  scrape_session: "network",
  scraping_status: "read",
  // QA (Playwright visual QA)
  qa_run: "network",
  qa_navigate: "network",
  qa_interact: "network",
  qa_screenshot: "network",
  qa_check: "network",
  qa_report: "read",
  qa_cleanup: "network",
  // Memory
  memory_save: "write",
  memory_curate: "write",
  memory_curated_read: "read",
  supermemory_profile: "network",
  supermemory_search: "network",
  supermemory_remember: "network",
  supermemory_forget: "network",
  search_sessions: "read",
  memory_topics_load: "read",
  // Scratchpad
  scratchpad_write: "write",
  scratchpad_read: "read",
  // Orchestration
  orchestrate_agents: "write",
  // Meta
  revise_plan: "read",
  request_user_input: "read",
  task_history: "read",
  task_events: "read",
};

/**
 * Gateway context types for context-aware tool restrictions
 */
export type GatewayContextType = "private" | "group" | "public";

/**
 * Tool restrictions based on gateway context
 * Implements C1: Memory Tool Isolation in Shared Contexts
 */
export const CONTEXT_TOOL_RESTRICTIONS: Record<
  GatewayContextType,
  {
    deniedGroups: ToolGroupName[];
    deniedTools: string[];
    requireApprovalFor: string[];
  }
> = {
  private: {
    deniedGroups: [],
    deniedTools: [],
    requireApprovalFor: ["delete_file"],
  },
  group: {
    deniedGroups: ["group:memory"],
    deniedTools: ["read_clipboard", "write_clipboard"],
    requireApprovalFor: ["delete_file"],
  },
  public: {
    deniedGroups: ["group:memory"],
    deniedTools: ["read_clipboard", "write_clipboard"],
    requireApprovalFor: ["delete_file"],
  },
};

// Success criteria for verification/retry metadata
export type SuccessCriteriaType = "shell_command" | "file_exists";

export interface SuccessCriteria {
  type: SuccessCriteriaType;
  command?: string; // For shell_command: command to run (exit 0 = success)
  filePaths?: string[]; // For file_exists: paths that must exist
}

// ============ Sub-Agent / Parallel Agent Types ============

/**
 * Agent type determines the behavior and lifecycle of a task
 * - 'main': Primary user-created task (default)
 * - 'sub': Disposable agent spawned for batch work (no memory retention)
 * - 'parallel': Independent agent that can run alongside main agents
 */
export type AgentType = "main" | "sub" | "parallel";
export type ConversationMode = "task" | "chat" | "hybrid" | "think";
export type ExecutionMode =
  | "execute"
  | "chat"
  | "plan"
  | "analyze"
  | "verified"
  | "debug";
export type ExecutionModeSource = "user" | "strategy" | "auto_promote";

export type ExternalRuntimePermissionMode =
  | "approve-reads"
  | "approve-all"
  | "deny-all";
export type ExternalRuntimeAgent = "codex" | "claude";

export interface ExternalRuntimeConfig {
  kind: "acpx";
  agent: ExternalRuntimeAgent;
  sessionMode: "persistent";
  outputMode: "json";
  permissionMode: ExternalRuntimePermissionMode;
  ttlSeconds?: number;
}
export type TurnBudgetPolicy = "hard_window" | "adaptive_unbounded";
export type VerificationArtifactPathPolicy =
  | "require_existing"
  | "inline_if_missing"
  | "always_inline";
export type WorkspacePathAliasPolicy =
  | "rewrite_and_retry"
  | "strict_fail"
  | "disabled";
export type TaskPathRootPolicy = "pin_and_rewrite" | "strict_fail" | "disabled";
export type TaskDomain =
  | "auto"
  | "code"
  | "research"
  | "operations"
  | "writing"
  | "general"
  | "media";
export type ToolDecision = "allow" | "deny" | "ask";
export type LlmProfile = "strong" | "cheap";
export type ReviewPolicy = "off" | "balanced" | "strict";

/**
 * Post-task repository entropy sweep: read-only audit for stale docs, contradictions, dead-code hints.
 * Defaults follow reviewPolicy when unset (see resolveEntropySweepPolicy).
 */
export type EntropySweepPolicy = "off" | "balanced" | "strict";
export type TaskRiskLevel = "low" | "medium" | "high";

/**
 * Per-task agent configuration for customizing LLM and personality
 * Allows spawning agents with different models/personalities than the global settings
 */
export interface AgentConfig {
  /** Override the LLM provider type (e.g., 'anthropic', 'gemini') */
  providerType?: LLMProviderType;
  /** Override the model key (e.g., 'opus-4-5', 'sonnet-4-5', 'haiku-4-5') */
  modelKey?: string;
  /**
   * Optional LLM profile override:
   * - strong: high-capability planning/critical profile
   * - cheap: lower-cost execution profile
   */
  llmProfile?: LlmProfile;
  /** When true, force profile routing even if modelKey is set. */
  llmProfileForced?: boolean;
  /** Strategy-derived profile hint (auto-routing metadata). */
  llmProfileHint?: LlmProfile;
  /** Override the personality for this agent */
  personalityId?: PersonalityId;
  /** Gateway context for context-aware tool restrictions (e.g., memory isolation in group/public chats) */
  gatewayContext?: GatewayContextType;
  /** Additional tool restrictions for this task (e.g., per-channel DM/group policies) */
  toolRestrictions?: string[];
  /**
   * Optional allow-list of tools for this task.
   * When provided, only tools in this list are exposed to the model.
   */
  allowedTools?: string[];
  /** Optional origin channel that created the task (used for channel-aware gating) */
  originChannel?: ChannelType;
  /** Explicit maximum number of LLM turns before forcing completion. Unset means no window cap for normal main-task routing. */
  maxTurns?: number;
  /** Turn-window policy for explicit window caps. Ignored when no explicit maxTurns/windowTurnCap is set. */
  turnBudgetPolicy?: TurnBudgetPolicy;
  /** Verification-path artifact policy for checklist/report outputs. */
  verificationArtifactPathPolicy?: VerificationArtifactPathPolicy;
  /** Workspace alias path policy for absolute model aliases like `/workspace/...`. */
  workspacePathAliasPolicy?: WorkspacePathAliasPolicy;
  /** Task path-root policy for relative root drift (for example mixed `project/...` and `app/...`). */
  taskPathRootPolicy?: TaskPathRootPolicy;
  /** Retry budget for recoverable path-drift rewrites per step. */
  pathDriftRetryBudget?: number;
  /** Suppress tool disablement while recoverable path-drift retries remain. */
  suppressToolDisableOnRecoverablePathDrift?: boolean;
  /** Guarded retry budget for mutation checkpoints after recoverable path failures. */
  mutationCheckpointRetryBudget?: number;
  /** Optional explicit turn-window cap. Leave unset for default-unbounded main tasks; set `null` to clear an inherited cap. */
  windowTurnCap?: number | null;
  /** Auto-recover follow-up loops when the turn window is exhausted. */
  followUpAutoRecovery?: boolean;
  /** High emergency safeguard for runaway loops in adaptive-unbounded mode. */
  emergencyFuseMaxTurns?: number;
  /** Web search mode override for this task. */
  webSearchMode?: WebSearchMode;
  /** Per-task web_search usage cap override (Claude-style max_uses). */
  webSearchMaxUsesPerTask?: number;
  /** Per-step web_search usage cap override (Claude-style max_uses). */
  webSearchMaxUsesPerStep?: number;
  /** Lifetime turn cap across continuation windows (auto-derived when omitted) */
  lifetimeMaxTurns?: number;
  /** Maximum tokens budget for this agent */
  maxTokens?: number;
  /** Whether to retain memory/context after completion (default: false for sub-agents) */
  retainMemory?: boolean;
  /**
   * Whether to bypass the global task queue concurrency limit.
   * Default behavior: sub-agents (tasks with parentTaskId) bypass to avoid deadlock.
   * Set this to false to force queueing even for sub-agents.
   */
  bypassQueue?: boolean;
  /** Whether this task may pause and wait for user input (default: true) */
  allowUserInput?: boolean;
  /** Override Chronicle availability for this task. */
  chronicleMode?: ChronicleTaskMode;
  /** Allow shell tools for this task via an in-memory workspace permission override. */
  shellAccess?: boolean;
  /** Require git worktree isolation for this task and fail fast if unavailable. */
  requireWorktree?: boolean;
  /**
   * Optional allow-list of approval types that may be auto-approved when
   * autonomousMode is enabled. Omit to preserve legacy "approve all" behavior.
   */
  autoApproveTypes?: string[];
  /**
   * Explicitly allow retry loops even when no success criteria are defined.
   * Defaults to false.
   */
  retryWithoutSuccessCriteria?: boolean;
  /**
   * Whether blocking required decisions should pause execution, even in autonomous mode.
   * Defaults to true.
   */
  pauseForRequiredDecision?: boolean;
  /**
   * For group/public gateway contexts, allow read-only memory context injection
   * only when explicitly trusted/opted in at the channel level.
   */
  allowSharedContextMemory?: boolean;
  /**
   * Conversation behavior preference:
   * - task: full tool/plan execution loops
   * - chat: conversational single-turn replies
   * - hybrid: infer per-turn using prompt intent
   */
  conversationMode?: ConversationMode;
  /**
   * Execution mode gate:
   * - execute: tools may mutate state (default)
   * - plan: planning/read-only guidance, no mutating tools
   * - analyze: strict analysis/read-only mode
   */
  executionMode?: ExecutionMode;
  /** Source of the current execution mode selection. */
  executionModeSource?: ExecutionModeSource;
  /**
   * Task domain hint used for orchestration strategy and completion checks.
   * "auto" means inferred from intent router.
   */
  taskDomain?: TaskDomain;
  /** Whether to run with reduced friction in autonomous mode (auto-approve approval-gated tools) */
  autonomousMode?: boolean;
  /** Optional per-task permission mode override. */
  permissionMode?: PermissionMode;
  /**
   * Optional response quality loop for final text outputs:
   * - 1: draft only (default)
   * - 2: draft + refine
   * - 3: draft + critique + refine
   */
  qualityPasses?: 1 | 2 | 3;
  /** Auto-create an ephemeral collaborative team for this task */
  collaborativeMode?: boolean;
  /** Send the same task to multiple LLMs and have a judge synthesize results */
  multiLlmMode?: boolean;
  /** Configuration for multi-LLM mode: which providers/models to use and which is the judge */
  multiLlmConfig?: MultiLlmConfig;
  /** Mark this task as a council-triggered multi-LLM run with fixed memo synthesis requirements */
  councilMode?: boolean;
  /** Council run id for council-triggered collaborative tasks */
  councilRunId?: string;
  /** Spawn an independent verification agent after task completion to audit deliverables */
  verificationAgent?: boolean;
  /**
   * Post-completion reliability review policy:
   * - off: keep legacy behavior
   * - balanced: enable risk-aware review escalation
   * - strict: enforce the strongest post-completion checks
   */
  reviewPolicy?: ReviewPolicy;
  /**
   * Optional post-completion entropy sweep (stale docs, contradictions, dead-code hints).
   * When omitted, resolved from COWORK_ENTROPY_SWEEP_DEFAULT env or mirrors reviewPolicy.
   */
  entropySweepPolicy?: EntropySweepPolicy;
  /**
   * Step-intent alignment: heuristic scoring of plan steps vs task prompt (balanced/strict enable checks).
   * Default off; deep work defaults to balanced in executor when unset.
   */
  stepIntentAlignmentPolicy?: "off" | "balanced" | "strict";
  /**
   * Split oversized steps into smaller sub-steps via LLM (deep work / workflow friendly).
   * Default off; deep work defaults to balanced in executor when unset.
   */
  stepDecompositionPolicy?: "off" | "balanced" | "strict";
  /** Whether to emit a pre-flight problem framing before execution (set by strategy service) */
  preflightRequired?: boolean;
  /** Enable deep work mode: long-running autonomous execution with research-retry, journaling, auto-report */
  deepWorkMode?: boolean;
  /** Enable auto-report generation on completion (markdown summary of what was done) */
  autoReportEnabled?: boolean;
  /** Enable periodic progress journaling for fire-and-forget visibility */
  progressJournalEnabled?: boolean;
  /** Detected task intent from IntentRouter (used for intent-based tool filtering) */
  taskIntent?: string;
  /** Auto-continue after turn-window exhaustion when progress is positive */
  autoContinueOnTurnLimit?: boolean;
  /** Maximum number of auto-continuation windows (excluding the initial window) */
  maxAutoContinuations?: number;
  /** Minimum normalized progress score required to auto-continue */
  minProgressScoreForAutoContinue?: number;
  /** Continuation strategy for turn-window exhaustion handling */
  continuationStrategy?: "adaptive_progress" | "fixed_caps";
  /** Run context compaction before continuation when context pressure is high */
  compactOnContinuation?: boolean;
  /** Continuation compaction trigger threshold (rendered context ratio) */
  compactionThresholdRatio?: number;
  /** Warning threshold for repeated loop fingerprints */
  loopWarningThreshold?: number;
  /** Critical threshold for repeated loop fingerprints */
  loopCriticalThreshold?: number;
  /** Stop when no-progress windows hit this threshold */
  globalNoProgressCircuitBreaker?: number;
  /** Side-channel mode while a task execution window is active */
  sideChannelDuringExecution?: "paused" | "limited" | "enabled";
  /** Side-channel budget per execution window when mode is limited */
  sideChannelMaxCallsPerWindow?: number;
  /**
   * Capability hint for model routing via ModelCapabilityRegistry.
   * When set (and modelKey is absent), selects a model suited for the given capability.
   */
  capabilityHint?: ModelCapability;
  /** Execute decomposed workflows as sequential child tasks instead of prompt-only guidance. */
  useWorkflowPipeline?: boolean;
  /** Internal metadata for workflow child tasks. */
  workflowPhaseId?: string;
  /** Internal metadata for workflow child tasks. */
  workflowPhaseType?: string;
  /** Optional external runtime for delegated coding-agent tasks. */
  externalRuntime?: ExternalRuntimeConfig;
  /**
   * When true, the task is a video generation task (taskDomain should also be "media").
   * Video tools are strongly preferred; unrelated workflows are suppressed.
   */
  videoGenerationMode?: boolean;
  /**
   * Research critique workflow: draft → critique → refine with optional per-phase models.
   * Defined after `ResearchWorkflowConfig` in this file.
   */
  researchWorkflow?: ResearchWorkflowConfig;
}

/**
 * Capability dimension for model routing.
 * Used by ModelCapabilityRegistry to select the best model for a task type.
 */
export type ModelCapability =
  | "code"
  | "math"
  | "research"
  | "vision"
  | "fast"
  | "long_context";

/** Memory tier for three-tier promotion system */
export type MemoryTier = "short" | "medium" | "long";

/** Risk classification for human-in-the-loop confirmation gates */
export type ConfirmationRisk = "low" | "medium" | "high";

/** Specification for one LLM participant in a multi-LLM run */
export interface MultiLlmParticipant {
  providerType: LLMProviderType;
  modelKey: string;
  displayName: string;
  isJudge: boolean;
  seatLabel?: string;
  roleInstruction?: string;
  isIdeaProposer?: boolean;
}

/** Config for multi-LLM mode: participants and judge designation */
export interface MultiLlmConfig {
  participants: MultiLlmParticipant[];
  judgeProviderType: LLMProviderType;
  judgeModelKey: string;
  maxParallelParticipants?: number;
}

/**
 * Optional per-phase model overrides for the research critique workflow.
 * When omitted for a phase, the executor uses the task's default resolved model.
 */
export interface ResearchPhaseModelOverride {
  providerType?: LLMProviderType;
  modelKey?: string;
}

/**
 * Research + critique MVP: staged draft → critique → refine with optional per-phase models.
 * When `enabled` is true, strategy/apply merges sensible defaults (qualityPasses 3, deep work, etc.).
 */
export interface ResearchWorkflowConfig {
  enabled: boolean;
  /** Primary research/draft phase model (defaults to task model) */
  researcher?: ResearchPhaseModelOverride;
  /** Critique pass model (defaults to task model if unset) */
  critic?: ResearchPhaseModelOverride;
  /** Final refine pass model (defaults to task model if unset) */
  refiner?: ResearchPhaseModelOverride;
  /** Reserved for parallel multi-model synthesis; optional in sequential MVP */
  judge?: ResearchPhaseModelOverride;
  /** Emit executor events suitable for semantic timeline / progress UI */
  emitSemanticProgress?: boolean;
}

export interface Task {
  id: string;
  title: string;
  prompt: string;
  rawPrompt?: string; // Original prompt used for intent routing (without strategy decoration)
  userPrompt?: string; // Original user prompt (before agent dispatch formatting)
  status: TaskStatus;
  pinned?: boolean;
  workspaceId: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  budgetTokens?: number;
  budgetCost?: number;
  error?: string | null;
  // Verification/retry metadata
  successCriteria?: SuccessCriteria;
  maxAttempts?: number; // Default: 3, max: 10
  currentAttempt?: number; // Tracks which attempt we're on
  // Sub-Agent / Parallel Agent fields
  parentTaskId?: string; // ID of the parent task that spawned this one
  agentType?: AgentType; // Type of agent: 'main', 'sub', or 'parallel'
  agentConfig?: AgentConfig; // Per-task agent configuration (model, personality, etc.)
  depth?: number; // Nesting depth (0 = root, 1 = first child, etc.)
  resultSummary?: string; // Summary of results for parent agent to consume
  // Agent Squad fields
  assignedAgentRoleId?: string; // ID of the agent role assigned to this task
  workerRole?: WorkerRoleKind; // Internal execution role for delegation and verification
  boardColumn?: BoardColumn; // Kanban column for task organization
  priority?: number; // Task priority (higher = more important)
  // Task Board fields
  labels?: string[]; // JSON array of label IDs
  dueDate?: number; // Due date timestamp
  estimatedMinutes?: number; // Estimated time in minutes
  actualMinutes?: number; // Actual time spent in minutes
  mentionedAgentRoleIds?: string[]; // Agent roles mentioned in this task
  // Git Worktree isolation fields
  worktreePath?: string; // Absolute path to the worktree directory
  worktreeBranch?: string; // Branch name created for this task's worktree
  worktreeStatus?: WorktreeStatus; // Current worktree lifecycle state
  // Comparison mode fields
  comparisonSessionId?: string; // If this task is part of a comparison session
  // Session lineage fields
  sessionId?: string; // Stable lineage/session identifier shared across continued tasks
  branchFromTaskId?: string; // Parent task used as the branch origin
  branchFromEventId?: string; // Specific event to branch from when forking a session
  branchLabel?: string; // Human label for the branch shown in UI/debug surfaces
  resumeStrategy?: "snapshot" | "checkpoint" | "transcript"; // Preferred resume source
  // Origin source for distinguishing how the task was created
  source?: "manual" | "cron" | "hook" | "api" | "improvement" | "subconscious";
  // Strategy/routing controls
  strategyLock?: boolean; // When true, do not re-route intent at runtime
  budgetProfile?: "balanced" | "strict" | "aggressive";
  // Execution result metadata (for partial success + diagnostics)
  terminalStatus?: TaskTerminalStatus;
  failureClass?: StepFailureClass;
  verificationVerdict?: VerificationVerdict;
  verificationReport?: string;
  semanticSummary?: string;
  bestKnownOutcome?: TaskBestKnownOutcome;
  coreOutcome?: "ok" | "partial" | "failed";
  dependencyOutcome?: "healthy" | "degraded" | "down";
  failureDomains?: string[];
  stopReasons?: Array<
    | "completed"
    | "max_turns"
    | "tool_error"
    | "contract_block"
    | "verification_block"
    | "awaiting_user_input"
    | "dependency_unavailable"
  >;
  riskLevel?: TaskRiskLevel;
  evalCaseId?: string;
  evalRunId?: string;
  awaitingUserInputReasonCode?: string;
  retryReason?: "success_criteria_failed" | "explicit_retry_policy";
  recoveryClass?:
    | "user_blocker"
    | "local_runtime"
    | "provider_quota"
    | "external_unknown";
  toolDisabledScope?: "provider" | "global";
  budgetUsage?: {
    turns: number;
    lifetimeTurns?: number;
    toolCalls: number;
    webSearchCalls: number;
    duplicatesBlocked: number;
  };
  continuationCount?: number;
  continuationWindow?: number;
  lifetimeTurnsUsed?: number;
  lastProgressScore?: number;
  autoContinueBlockReason?: string;
  compactionCount?: number;
  lastCompactionAt?: number;
  lastCompactionTokensBefore?: number;
  lastCompactionTokensAfter?: number;
  noProgressStreak?: number;
  lastLoopFingerprint?: string;
  // Control plane linkage
  issueId?: string; // Issue this task is executing for
  heartbeatRunId?: string; // Heartbeat run this task belongs to
  targetNodeId?: string; // ID of the device/node this task is assigned to
  companyId?: string; // Company context
  goalId?: string; // Goal context
  projectId?: string; // Project context
  requestDepth?: number; // Nesting depth of the originating request
  billingCode?: string; // Billing/cost attribution code
}

export type SkillApplicationTrigger =
  | "slash"
  | "planner"
  | "model"
  | "explicit_hint";

export interface PendingSkillParameterCollection {
  skillId: string;
  skillName: string;
  trigger: SkillApplicationTrigger;
  parameters: Record<string, unknown>;
  requiredParameterNames: string[];
  currentParameterIndex: number;
  startedAt: number;
}

export interface SkillContextDirectives {
  allowedTools?: string[];
  toolRestrictions?: string[];
  modelHint?: {
    providerType?: LLMProviderType;
    modelKey?: string;
  };
  artifactDirectories?: string[];
  metadata?: Record<string, unknown>;
}

export interface SkillApplication {
  skillId: string;
  skillName: string;
  trigger: SkillApplicationTrigger;
  args?: string;
  parameters?: Record<string, unknown>;
  content: string;
  reason: string;
  appliedAt: number;
  contextDirectives?: SkillContextDirectives;
}

export type TaskTerminalStatus =
  | "ok"
  | "partial_success"
  | "needs_user_action"
  | "awaiting_approval"
  | "resume_available"
  | "failed";

export type StepFailureClass =
  | "budget_exhausted"
  | "tool_error"
  | "contract_error"
  | "contract_unmet_write_required"
  | "required_contract"
  | "required_verification"
  | "optional_enrichment"
  | "dependency_unavailable"
  | "provider_quota"
  | "user_blocker"
  | "unknown";

// ============ Git Worktree Types ============

export type WorktreeStatus =
  | "creating" // Worktree is being set up
  | "active" // Worktree is ready and in use
  | "committing" // Auto-commit in progress
  | "merging" // Merge back to base branch in progress
  | "merged" // Successfully merged
  | "conflict" // Merge conflict detected
  | "cleaned" // Worktree removed after completion
  | "failed"; // Worktree setup or operation failed

export interface WorktreeInfo {
  taskId: string;
  workspaceId: string;
  repoPath?: string; // Absolute path to the git repository root
  worktreePath: string; // Absolute path to the worktree directory
  branchName: string; // e.g., "cowork/fix-login-bug-a1b2c3"
  baseBranch: string; // Branch the worktree was created from (e.g., "main")
  baseCommit: string; // SHA of the commit the worktree was created from
  status: WorktreeStatus;
  createdAt: number;
  lastCommitSha?: string; // SHA of the last auto-commit
  lastCommitMessage?: string;
  mergeResult?: MergeResult;
}

export interface MergeResult {
  success: boolean;
  mergeSha?: string; // SHA of the merge commit if successful
  conflictFiles?: string[]; // List of files with conflicts
  error?: string;
}

export interface PullRequestResult {
  success: boolean;
  url?: string;
  number?: number;
  error?: string;
}

export interface WorktreeSettings {
  enabled: boolean; // Master toggle (default: false)
  autoCommitOnComplete: boolean; // Auto-commit when task completes (default: true)
  autoCleanOnMerge: boolean; // Remove worktree after successful merge (default: true)
  branchPrefix: string; // Default: "cowork/"
  commitMessagePrefix: string; // Default: "[cowork] "
}

export const DEFAULT_WORKTREE_SETTINGS: WorktreeSettings = {
  enabled: false,
  autoCommitOnComplete: true,
  autoCleanOnMerge: true,
  branchPrefix: "cowork/",
  commitMessagePrefix: "[cowork] ",
};

// ============ Self-Improvement Types ============

export type ImprovementCandidateSource =
  | "task_failure"
  | "verification_failure"
  | "user_feedback"
  | "dev_log";

export type ImprovementCandidateStatus =
  | "open"
  | "running"
  | "review"
  | "parked"
  | "resolved"
  | "dismissed";

export type ImprovementCandidateReadiness =
  | "ready"
  | "cooling_down"
  | "parked"
  | "blocked_provider"
  | "needs_more_evidence"
  | "unknown";

export type ImprovementRunStatus =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "cancelled";

export type ImprovementReviewStatus = "pending" | "accepted" | "dismissed";
export type ImprovementPromotionMode = "merge" | "github_pr";
export type ImprovementPromotionStatus =
  | "idle"
  | "promoting"
  | "applied" // legacy-only
  | "merged" // legacy/manual-only
  | "pr_opened"
  | "promotion_failed";

export type ImprovementFailureClass =
  | "provider_tool_protocol_error"
  | "provider_rate_limited"
  | "provider_model_missing"
  | "provider_network_failure"
  | "provider_config_error"
  | "provider_unknown"
  | "plan_timeout"
  | "task_timeout"
  | "mutation_contract_unmet"
  | "artifact_contract_unmet"
  | "verification_failed"
  | "missing_resumable_state"
  | "non_promotable_result"
  | "preflight_failed"
  | "unknown";

export interface ImprovementEvidence {
  type: ImprovementCandidateSource;
  taskId?: string;
  eventType?: string;
  eventId?: string;
  summary: string;
  details?: string;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export interface ImprovementCandidate {
  id: string;
  workspaceId: string;
  fingerprint: string;
  source: ImprovementCandidateSource;
  status: ImprovementCandidateStatus;
  readiness?: ImprovementCandidateReadiness;
  readinessReason?: string;
  title: string;
  summary: string;
  severity: number;
  recurrenceCount: number;
  fixabilityScore: number;
  priorityScore: number;
  evidence: ImprovementEvidence[];
  lastTaskId?: string;
  lastEventType?: string;
  firstSeenAt: number;
  lastSeenAt: number;
  lastExperimentAt?: number;
  failureStreak?: number;
  cooldownUntil?: number;
  parkReason?: string;
  parkedAt?: number;
  lastSkipReason?: string;
  lastSkipAt?: number;
  lastAttemptFingerprint?: string;
  lastFailureClass?: ImprovementFailureClass;
  resolvedAt?: number;
}

export type ImprovementCampaignStage =
  | "queued"
  | "preflight"
  | "reproducing"
  | "implementing"
  | "verifying"
  | "completed";

export interface ImprovementLoopSettings {
  enabled: boolean;
  autoRun: boolean;
  includeDevLogs: boolean;
  intervalMinutes: number;
  variantsPerCampaign: number;
  maxConcurrentCampaigns: number;
  maxConcurrentImprovementExecutors: number;
  maxQueuedImprovementCampaigns: number;
  maxOpenCandidatesPerWorkspace: number;
  requireWorktree: boolean;
  requireRepoChecks: boolean;
  enforcePatchScope: boolean;
  maxPatchFiles: number;
  reviewRequired: boolean;
  judgeRequired: boolean;
  promotionMode: ImprovementPromotionMode;
  evalWindowDays: number;
  replaySetSize: number;
  campaignTimeoutMinutes: number;
  campaignTokenBudget: number;
  campaignCostBudget: number;
  improvementProgramPath?: string;
}

export interface ImprovementEligibility {
  eligible: boolean;
  reason: string;
  enrolled: boolean;
  repoPath?: string;
  machineFingerprint?: string;
  ownerEnrollmentChallenge?: string;
  checks: {
    unpackagedApp: boolean;
    canonicalRepo: boolean;
    ownerEnrollment: boolean;
    ownerProofPresent: boolean;
  };
}

export interface ImprovementHistoryResetResult {
  resetAt: number;
  deleted: {
    candidates: number;
    campaigns: number;
    variantRuns: number;
    judgeVerdicts: number;
    legacyRuns: number;
  };
  cancelledTaskIds: string[];
}

export const DEFAULT_IMPROVEMENT_LOOP_SETTINGS: ImprovementLoopSettings = {
  enabled: false,
  autoRun: true,
  includeDevLogs: true,
  intervalMinutes: 24 * 60,
  variantsPerCampaign: 1,
  maxConcurrentCampaigns: 1,
  maxConcurrentImprovementExecutors: 1,
  maxQueuedImprovementCampaigns: 1,
  maxOpenCandidatesPerWorkspace: 25,
  requireWorktree: true,
  requireRepoChecks: true,
  enforcePatchScope: true,
  maxPatchFiles: 8,
  reviewRequired: false,
  judgeRequired: false,
  promotionMode: "github_pr",
  evalWindowDays: 14,
  replaySetSize: 3,
  campaignTimeoutMinutes: 30,
  campaignTokenBudget: 60000,
  campaignCostBudget: 15,
};

export interface ImprovementExperimentConfig {
  workspaceId: string;
  candidateId: string;
  settingsSnapshot: ImprovementLoopSettings;
}

export interface ImprovementRun {
  id: string;
  candidateId: string;
  workspaceId: string;
  executionWorkspaceId?: string;
  status: ImprovementRunStatus;
  reviewStatus: ImprovementReviewStatus;
  promotionStatus?: ImprovementPromotionStatus;
  taskId?: string;
  branchName?: string;
  mergeResult?: MergeResult;
  pullRequest?: PullRequestResult;
  promotionError?: string;
  baselineMetrics?: EvalBaselineMetrics;
  outcomeMetrics?: EvalBaselineMetrics;
  verdictSummary?: string;
  evaluationNotes?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  promotedAt?: number;
}

export interface ImprovementRunEvaluation {
  runId: string;
  passed: boolean;
  summary: string;
  notes: string[];
  targetedVerificationPassed: boolean;
  verificationPassed: boolean;
  baselineMetrics: EvalBaselineMetrics;
  outcomeMetrics: EvalBaselineMetrics;
}

export type ImprovementVariantLane =
  | "minimal_patch"
  | "test_first"
  | "root_cause"
  | "guardrail_hardening";

export type ImprovementCampaignStatus =
  | "queued"
  | "preflight"
  | "reproducing"
  | "implementing"
  | "verifying"
  | "pr_opened"
  | "parked"
  | "planning"
  | "running_variants"
  | "judging"
  | "ready_for_review"
  | "promoted"
  | "failed";

export type ImprovementVariantStatus =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "cancelled";

export interface ImprovementReplayCase {
  id: string;
  candidateId: string;
  source: ImprovementCandidateSource;
  summary: string;
  details?: string;
  createdAt: number;
  taskId?: string;
  eventType?: string;
  metadata?: Record<string, unknown>;
}

export interface ImprovementProgramConfig {
  path?: string;
  instructions: string;
  mutablePaths: string[];
  forbiddenChanges: string[];
  scoringPriorities: string[];
}

export interface ImprovementVariantArtifactSummary {
  reproductionMethod?: string;
  changedFiles: string[];
  verificationCommands: string[];
  prReadiness: "ready" | "not_ready" | "unknown";
  rootCauseSummary?: string;
  missingEvidence: string[];
}

export interface ImprovementVariantObservability {
  stage?: string;
  executionMode?: "analyze" | "verified";
  artifactSummary?: ImprovementVariantArtifactSummary;
  evaluation?: {
    targetedVerificationPassed: boolean;
    verificationPassed: boolean;
    promotable: boolean;
    reproductionEvidenceFound: boolean;
    verificationEvidenceFound: boolean;
    prReadinessEvidenceFound: boolean;
    replayPassRate: number;
    diffSizePenalty: number;
    regressionSignals: string[];
    safetySignals: string[];
  };
}

export interface ImprovementCampaignObservability {
  selectedAt?: number;
  candidateSelectionReason?: string;
  candidateSelectionScore?: number;
  variantCount?: number;
  verificationCommands?: string[];
  stageTransitions?: Array<{
    stage: string;
    at: number;
    detail?: string;
  }>;
  promotionAttempts?: number;
  lastPromotionError?: string;
}

export interface ImprovementVariantEvaluation {
  variantId: string;
  lane: ImprovementVariantLane;
  score: number;
  targetedVerificationPassed: boolean;
  verificationPassed: boolean;
  promotable: boolean;
  reproductionEvidenceFound: boolean;
  verificationEvidenceFound: boolean;
  prReadinessEvidenceFound: boolean;
  regressionSignals: string[];
  safetySignals: string[];
  failureClassResolved: boolean;
  replayPassRate: number;
  diffSizePenalty: number;
  artifactSummary: ImprovementVariantArtifactSummary;
  summary: string;
  notes: string[];
}

export interface ImprovementJudgeVerdict {
  id: string;
  campaignId: string;
  winnerVariantId?: string;
  status: "pending" | "passed" | "failed";
  summary: string;
  notes: string[];
  comparedAt: number;
  variantRankings: Array<{
    variantId: string;
    score: number;
    lane: ImprovementVariantLane;
  }>;
  replayCases: ImprovementReplayCase[];
}

export interface ImprovementVariantRun {
  id: string;
  campaignId: string;
  candidateId: string;
  workspaceId: string;
  executionWorkspaceId?: string;
  lane: ImprovementVariantLane;
  status: ImprovementVariantStatus;
  taskId?: string;
  branchName?: string;
  baselineMetrics?: EvalBaselineMetrics;
  outcomeMetrics?: EvalBaselineMetrics;
  verdictSummary?: string;
  evaluationNotes?: string;
  observability?: ImprovementVariantObservability;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface ImprovementCampaign {
  id: string;
  candidateId: string;
  workspaceId: string;
  executionWorkspaceId?: string;
  rootTaskId?: string;
  status: ImprovementCampaignStatus;
  stage?: ImprovementCampaignStage;
  reviewStatus: ImprovementReviewStatus;
  promotionStatus?: ImprovementPromotionStatus;
  stopReason?: string;
  providerHealthSnapshot?: Record<string, unknown>;
  stageBudget?: Record<string, unknown>;
  verificationCommands?: string[];
  observability?: ImprovementCampaignObservability;
  prRequired?: boolean;
  winnerVariantId?: string;
  promotedTaskId?: string;
  promotedBranchName?: string;
  mergeResult?: MergeResult;
  pullRequest?: PullRequestResult;
  promotionError?: string;
  baselineMetrics?: EvalBaselineMetrics;
  outcomeMetrics?: EvalBaselineMetrics;
  verdictSummary?: string;
  evaluationNotes?: string;
  trainingEvidence: ImprovementEvidence[];
  holdoutEvidence: ImprovementEvidence[];
  replayCases: ImprovementReplayCase[];
  variants: ImprovementVariantRun[];
  judgeVerdict?: ImprovementJudgeVerdict;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  promotedAt?: number;
}

// ============ Agent Comparison Types ============

export interface ComparisonSession {
  id: string;
  title: string;
  prompt: string; // The shared prompt given to all agents
  workspaceId: string;
  status: ComparisonSessionStatus;
  taskIds: string[]; // Array of task IDs (one per agent variant)
  createdAt: number;
  completedAt?: number;
  comparisonResult?: ComparisonResult;
}

export type ComparisonSessionStatus =
  | "running"
  | "completed" // All agents finished
  | "partial" // Some agents finished, some failed/cancelled
  | "cancelled";

export interface ComparisonResult {
  taskResults: Array<{
    taskId: string;
    label: string;
    status: string;
    branchName?: string;
    filesChanged: number;
    linesAdded: number;
    linesRemoved: number;
    duration: number; // ms
    tokenCost?: number;
    summary?: string;
  }>;
  diffSummary?: string; // AI-generated summary comparing the approaches
}

export interface ComparisonAgentSpec {
  label?: string; // e.g., "Agent A", "Opus variant"
  agentConfig?: AgentConfig; // Model, personality, etc.
  assignedAgentRoleId?: string;
}

/** Image attachment for sending images with messages */
export interface ImageAttachment {
  /** Base64-encoded image data (legacy path). Prefer filePath when possible. */
  data?: string;
  /** Absolute path to image file on disk (preferred to avoid IPC payload copies). */
  filePath?: string;
  /** MIME type of the image */
  mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  /** Original filename (for display) */
  filename?: string;
  /** File size in bytes */
  sizeBytes: number;
  /** Internal hint when filePath points to a file generated in-process and may be ephemeral */
  tempFile?: boolean;
}

/** Quoted assistant message attached to a follow-up so the backend can treat it as explicit context. */
export interface QuotedAssistantMessage {
  /** Source event id when the quoted text came from a persisted assistant event. */
  eventId?: string;
  /** Source task id for the quoted assistant message. */
  taskId?: string;
  /** Visible assistant text the user quoted. */
  message: string;
  /** Indicates the quoted text was truncated client-side before submission. */
  truncated?: boolean;
}

/** Follow-up payload sent to an existing task. */
export interface TaskFollowUpInput {
  message: string;
  images?: ImageAttachment[];
  quotedAssistantMessage?: QuotedAssistantMessage;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  timestamp: number;
  type: EventType;
  payload: Any;
  schemaVersion: 2;
  eventId?: string;
  seq?: number;
  ts?: number;
  status?: TimelineEventStatus;
  stepId?: string;
  groupId?: string;
  actor?: TimelineEventActor;
  legacyType?: EventType;
}

export interface TaskTimelineEventV2 extends TaskEvent {
  schemaVersion: 2;
  type: TimelineEventType;
  eventId: string;
  seq: number;
  ts: number;
  status: TimelineEventStatus;
  stepId: string;
  actor: TimelineEventActor;
}

export interface TaskTraceRunSibling {
  taskId: string;
  title: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  continuationWindow?: number;
  branchLabel?: string;
}

export interface TaskTraceRunSummary {
  sessionId: string;
  taskId: string;
  title: string;
  workspaceId: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  runCount: number;
  continuationWindow?: number;
  branchLabel?: string;
  siblingRuns: TaskTraceRunSibling[];
}

export interface TaskTraceMetrics {
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  runtimeMs: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  toolCallCount: number;
  eventCount: number;
}

export interface ListTaskTraceRunsRequest {
  workspaceId?: string;
  status?: TaskStatus | "all";
  query?: string;
  limit?: number;
}

export type TaskTraceTab = "transcript" | "debug";
export type TaskTraceRowActor =
  | "user"
  | "agent"
  | "tool"
  | "model"
  | "result"
  | "system";
export type TaskTraceBadgeTone =
  | "neutral"
  | "active"
  | "success"
  | "warning"
  | "error";

export interface TaskTraceBadge {
  label: string;
  tone?: TaskTraceBadgeTone;
}

export interface TaskTraceInspectorField {
  label: string;
  value: string;
  language?: "text" | "json";
}

export interface TaskTraceInspectorPayload {
  title: string;
  subtitle?: string;
  content?: string;
  rawEventIds: string[];
  fields: TaskTraceInspectorField[];
  json?: unknown;
}

export interface TaskTraceRow {
  id: string;
  tab: TaskTraceTab;
  actor: TaskTraceRowActor;
  label: string;
  title: string;
  body?: string;
  timestamp: number;
  durationMs?: number;
  status?: string;
  badges: TaskTraceBadge[];
  rawEventIds: string[];
  inspector: TaskTraceInspectorPayload;
}

export interface TaskTraceRunDetail {
  sessionId: string;
  task: Task;
  siblingRuns: TaskTraceRunSibling[];
  metrics: TaskTraceMetrics;
  rawEvents: TaskEvent[];
  semanticTimeline: UiTimelineEvent[];
}

/**
 * Normalized summary of file outputs produced during a task run.
 * `created` is the primary signal; `modifiedFallback` is used only when no created outputs exist.
 */
export interface TaskOutputSummary {
  created: string[];
  modifiedFallback?: string[];
  primaryOutputPath?: string;
  outputCount: number;
  folders: string[];
}

export type LearningProgressStage =
  | "screen_context_used"
  | "memory_captured"
  | "playbook_reinforced"
  | "skill_proposed"
  | "skill_reviewed"
  | "skill_approved"
  | "skill_rejected"
  | "no_learning";

export type LearningProgressStatus = "done" | "pending" | "skipped" | "failed";

export interface LearningProgressStep {
  stage: LearningProgressStage;
  status: LearningProgressStatus;
  title: string;
  summary: string;
  evidenceRefs: EvidenceRef[];
  createdAt: number;
  relatedIds?: {
    memoryId?: string;
    proposalId?: string;
    skillId?: string;
  };
  details?: Record<string, unknown>;
}

export interface TaskLearningProgress {
  id: string;
  taskId: string;
  workspaceId: string;
  taskTitle: string;
  taskStatus: TaskStatus;
  outcome: "success" | "failure" | "reinforced" | "pending_review" | "noop";
  completedAt: number;
  summary: string;
  steps: LearningProgressStep[];
  nextAction?: string;
  evidenceRefs: EvidenceRef[];
  sourceEventId?: string;
}

export type UnifiedRecallSourceType =
  | "task"
  | "message"
  | "file"
  | "workspace_note"
  | "memory"
  | "screen_context"
  | "knowledge_graph";

export type ChronicleCaptureScope = "frontmost_display" | "all_displays";
export type ChronicleTaskMode = "inherit" | "enabled" | "disabled";

export interface ChronicleSourceReference {
  kind: "url" | "file" | "app";
  value: string;
  label?: string;
}

export interface ChronicleSettings {
  enabled: boolean;
  mode: "hybrid";
  paused: boolean;
  captureIntervalSeconds: number;
  retentionMinutes: number;
  maxFrames: number;
  captureScope: ChronicleCaptureScope;
  backgroundGenerationEnabled: boolean;
  respectWorkspaceMemory: boolean;
  consentAcceptedAt?: number | null;
}

export interface ChronicleCaptureStatus {
  supported: boolean;
  enabled: boolean;
  active: boolean;
  mode: "hybrid";
  paused: boolean;
  captureIntervalSeconds: number;
  retentionMinutes: number;
  maxFrames: number;
  captureScope: ChronicleCaptureScope;
  frameCount: number;
  bufferBytes: number;
  lastCaptureAt: number | null;
  lastGeneratedAt: number | null;
  consentRequired: boolean;
  accessibilityTrusted: boolean;
  ocrAvailable: boolean;
  screenCaptureStatus: "granted" | "denied" | "not-determined" | "unknown";
  reason?: string;
}

export interface ChronicleResolvedContext {
  observationId: string;
  capturedAt: number;
  displayId: string;
  appName: string;
  windowTitle: string;
  imagePath: string;
  localTextSnippet: string;
  confidence: number;
  usedFallback: boolean;
  provenance: "untrusted_screen_text";
  sourceRef?: ChronicleSourceReference | null;
  width: number;
  height: number;
}

export interface UnifiedRecallResult {
  sourceType: UnifiedRecallSourceType;
  objectId: string;
  timestamp: number;
  rank: number;
  snippet: string;
  title?: string;
  workspaceId?: string;
  taskId?: string;
  sourceLabel?: string;
  metadata?: Record<string, unknown>;
}

export interface UnifiedRecallQuery {
  workspaceId?: string;
  query: string;
  limit?: number;
  sourceTypes?: UnifiedRecallSourceType[];
}

export interface UnifiedRecallResponse {
  query: string;
  workspaceId?: string;
  generatedAt: number;
  results: UnifiedRecallResult[];
}

export type ShellSessionScope = "task" | "workspace";
export type ShellSessionStatus =
  | "inactive"
  | "active"
  | "resetting"
  | "ended"
  | "fallback";

export interface ShellSessionInfo {
  id: string;
  taskId: string;
  workspaceId: string;
  scope: ShellSessionScope;
  cwd: string;
  status: ShellSessionStatus;
  retained: boolean;
  commandCount: number;
  aliases: string[];
  envKeys: string[];
  createdAt: number;
  updatedAt: number;
  lastCommandAt?: number;
  lastCommand?: string;
  lastExitCode?: number | null;
  lastTerminationReason?: CommandTerminationReason;
  lastError?: string;
}

export interface ShellSessionLifecycleEvent {
  action: "created" | "reused" | "reset" | "closed" | "fallback" | "updated";
  taskId: string;
  workspaceId: string;
  session: ShellSessionInfo;
  commandId?: string;
  reason?: string;
  timestamp: number;
}

export type LLMRoutingReason =
  | "manual_override"
  | "profile_routing"
  | "automatic_execution"
  | "verification"
  | "fallback"
  | "provider_outage"
  | "quota"
  | "model_capability"
  | "unknown";

export interface LLMRoutingFallbackStep {
  providerType: LLMProviderType;
  modelKey: string;
  reason: string;
  attemptedAt: number;
  success: boolean;
  error?: string;
}

export interface LLMRoutingRuntimeState {
  currentProvider: LLMProviderType;
  currentModel: string;
  activeProvider: LLMProviderType;
  activeModel: string;
  routeReason: LLMRoutingReason;
  fallbackChain: LLMRoutingFallbackStep[];
  fallbackOccurred: boolean;
  manualOverride: boolean;
  profileHint?: LlmProfile;
  updatedAt: number;
}

export interface TaskBestKnownOutcome {
  capturedAt: number;
  resultSummary?: string;
  outputSummary?: TaskOutputSummary;
  completedStepIds?: string[];
  blockingIssues?: string[];
  terminalStatus?: TaskTerminalStatus;
  failureClass?: StepFailureClass;
  confidence?: "low" | "medium" | "high";
}

export interface TaskUsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  modelId?: string;
  modelKey?: string;
  updatedAt?: number;
}

export interface TaskFileChanges {
  created: string[];
  modified: string[];
  deleted: string[];
}

export interface EvalCase {
  id: string;
  name: string;
  workspaceId?: string;
  sourceTaskId?: string;
  prompt: string;
  sanitizedPrompt: string;
  assertions?: {
    expectedTerminalStatus?: Task["terminalStatus"];
    mustContainAll?: string[];
    mustCreatePaths?: string[];
  };
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface EvalSuite {
  id: string;
  name: string;
  description?: string;
  caseIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface EvalRun {
  id: string;
  suiteId: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  completedAt?: number;
  passCount: number;
  failCount: number;
  skippedCount: number;
  metadata?: Record<string, unknown>;
}

export interface EvalCaseRun {
  id: string;
  runId: string;
  caseId: string;
  status: "pass" | "fail" | "skipped";
  details?: string;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
}

export interface EvalBaselineMetrics {
  generatedAt: number;
  windowDays: number;
  taskSuccessRate: number;
  approvalDeadEndRate: number;
  verificationPassRate: number;
  agentCoreSuccessRate?: number;
  dependencyAvailabilityRate?: number;
  verificationBlockRate?: number;
  artifactContractFailureRate?: number;
  retriesPerTask: number;
  toolFailureRateByTool: Array<{
    tool: string;
    calls: number;
    failures: number;
    failureRate: number;
  }>;
}

export interface TaskExportQuery {
  workspaceId?: string;
  taskIds?: string[];
  limit?: number;
  offset?: number;
}

export interface TaskExportItem {
  taskId: string;
  title: string;
  pinned?: boolean;
  status: TaskStatus;
  workspaceId: string;
  workspaceName?: string;
  parentTaskId?: string;
  agentType?: AgentType;
  sessionId?: string;
  branchFromTaskId?: string;
  branchLabel?: string;
  depth?: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  durationMs?: number;
  usage?: TaskUsageTotals;
  files?: TaskFileChanges;
  resultSummary?: string;
  error?: string | null;
}

export interface TaskExportJson {
  schemaVersion: 1;
  exportedAt: number;
  query: TaskExportQuery;
  tasks: TaskExportItem[];
}

export interface Artifact {
  id: string;
  taskId: string;
  path: string;
  mimeType: string;
  sha256: string;
  size: number;
  createdAt: number;
}

export interface DocumentVersionEntry {
  path: string;
  fileName: string;
  createdAt: number;
  taskId?: string;
  artifactId?: string;
  isCurrent?: boolean;
}

export interface PdfReviewPageSummary {
  pageIndex: number;
  text: string;
  usedOcr: boolean;
  truncated: boolean;
}

export type PdfReviewExtractionMode =
  | "native"
  | "ocrmypdf"
  | "page-ocr"
  | "fallback";

export interface PdfReviewSummary {
  pageCount: number;
  nativeTextPages: number;
  ocrPages: number;
  scannedPages: number;
  truncatedPages: boolean;
  extractionMode?: PdfReviewExtractionMode;
  imageHeavy?: boolean;
  pages: PdfReviewPageSummary[];
}

export interface DocumentEditorDocxBlock {
  id: string;
  type: "heading" | "paragraph" | "table";
  text: string;
  level?: number;
  rows?: string[][];
  order: number;
}

export interface PdfRegionSelection {
  kind: "pdf";
  pageIndex: number;
  x: number;
  y: number;
  w: number;
  h: number;
  excerpt?: string;
}

export interface DocxBlockSelection {
  kind: "docx";
  startBlockId?: string;
  endBlockId?: string;
  blockIds: string[];
  excerpt?: string;
}

export type DocumentEditSelection = PdfRegionSelection | DocxBlockSelection;

export interface DocumentEditorSession {
  sessionId: string;
  filePath: string;
  workspacePath?: string;
  currentPath: string;
  currentFileName: string;
  fileType: "pdf" | "docx";
  sourceTaskId?: string;
  versions: DocumentVersionEntry[];
  pdfDataBase64?: string;
  pdfReviewSummary?: PdfReviewSummary;
  docxBlocks?: DocumentEditorDocxBlock[];
}

export interface DocumentEditRequest {
  sessionId: string;
  selection: DocumentEditSelection;
  instruction: string;
}

export interface Workspace {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  lastUsedAt?: number;
  permissions: WorkspacePermissions;
  isTemp?: boolean; // True for the auto-created temp workspace
}

// Temp workspace constants
export const TEMP_WORKSPACE_ID = "__temp_workspace__";
export const TEMP_WORKSPACE_ID_PREFIX = "__temp_workspace__:";
export const TEMP_WORKSPACE_NAME = "Temporary Workspace";
export const TEMP_WORKSPACE_ROOT_DIR_NAME = "cowork-os-temp";

export function isTempWorkspaceId(id: string | null | undefined): boolean {
  if (typeof id !== "string") return false;
  return id === TEMP_WORKSPACE_ID || id.startsWith(TEMP_WORKSPACE_ID_PREFIX);
}

/**
 * Sandbox type for command execution isolation
 */
export type SandboxType = "auto" | "macos" | "docker" | "none";

/**
 * Docker sandbox configuration
 */
export interface DockerSandboxConfig {
  /** Docker image to use (default: node:20-alpine) */
  image?: string;
  /** CPU limit in cores (e.g., 0.5 = half a core) */
  cpuLimit?: number;
  /** Memory limit (e.g., "512m", "1g") */
  memoryLimit?: string;
  /** Network mode: 'none' for isolation, 'bridge' for network access */
  networkMode?: "none" | "bridge";
}

export interface WorkspacePermissions {
  read: boolean;
  write: boolean;
  delete: boolean;
  network: boolean;
  shell: boolean;
  allowedDomains?: string[];
  // Broader filesystem access (like Claude Code)
  unrestrictedFileAccess?: boolean; // Allow reading/writing files outside workspace
  allowedPaths?: string[]; // Specific paths outside workspace to allow (if not fully unrestricted)
  // Sandbox configuration
  sandboxType?: SandboxType; // Which sandbox to use (auto-detect if not specified)
  dockerConfig?: DockerSandboxConfig; // Docker-specific configuration
}

/**
 * External verification configuration for a plan step (used in "verified" execution mode).
 * When present, the step must pass external verification before being marked complete.
 */
export interface ExternalStepVerification {
  /** Type of external verification to run */
  type: "shell_command" | "file_exists" | "grep_absent" | "http_head";
  /** Shell command whose exit code determines pass/fail (for shell_command type) */
  command?: string;
  /** Files that must exist after step completion (for file_exists type) */
  filePaths?: string[];
  /** Pattern that must NOT appear in grepTarget (for grep_absent type) */
  grepPattern?: string;
  /** File or directory to search for grepPattern */
  grepTarget?: string;
  /**
   * For http_head: URL to check (http/https). Uses curl for a lightweight status check.
   */
  httpUrl?: string;
  /** Expected HTTP status code for http_head (default 200) */
  expectedHttpStatus?: number;
  /** Max retries before the step is considered permanently failed (default: 2) */
  maxRetries?: number;
}

/** One deterministic verification outcome captured during verified-mode execution. */
export interface VerificationEvidenceEntry {
  kind: ExternalStepVerification["type"] | "none";
  ok: boolean;
  detail: string;
  capturedAt: number;
}

/** Machine-readable bundle passed to completion review and post-completion verifier. */
export interface TaskVerificationEvidenceBundle {
  entries: VerificationEvidenceEntry[];
}

export interface PlanStep {
  id: string;
  description: string;
  /**
   * Optional orchestration classification used for deterministic recovery accounting.
   */
  kind?: "primary" | "verification" | "recovery";
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
  startedAt?: number;
  completedAt?: number;
  error?: string;
  /** External verification for "verified" execution mode */
  externalVerification?: ExternalStepVerification;
  /** Number of external verification attempts (tracked during execution) */
  verificationAttempts?: number;
}

export interface Plan {
  steps: PlanStep[];
  description: string;
}

export interface SessionChecklistToolItemInput {
  id?: string;
  title: string;
  kind?: SessionChecklistItemKind;
  status: SessionChecklistItemStatus;
}

export type StepFeedbackAction = "retry" | "skip" | "stop" | "drift";

export interface StepFeedbackPayload {
  taskId: string;
  stepId: string;
  action: StepFeedbackAction;
  message?: string;
}

export interface ToolCall {
  id: string;
  tool: ToolType;
  parameters: Any;
  timestamp: number;
}

export interface ToolResult {
  callId: string;
  success: boolean;
  result?: Any;
  error?: string;
  timestamp: number;
}

/**
 * Result from node tool handler execution
 * Supports text, JSON, image, and video responses
 */
export interface NodeToolResult {
  type: "text" | "json" | "image" | "video";
  content: string;
  mimeType?: string;
  isError?: boolean;
}

/**
 * Definition for node tools with handler functions
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, Any>;
    required: string[];
  };
  riskLevel: "read" | "write";
  groups: readonly string[];
  handler: (params: Any) => Promise<NodeToolResult>;
}

export interface ApprovalRequest {
  id: string;
  taskId: string;
  type: ApprovalType;
  description: string;
  details: Any;
  status: "pending" | "approved" | "denied";
  requestedAt: number;
  resolvedAt?: number;
}

export type ApprovalResponseAction =
  | "allow_once"
  | "deny_once"
  | "allow_session"
  | "deny_session"
  | "allow_workspace"
  | "deny_workspace"
  | "allow_profile"
  | "deny_profile";

export interface ApprovalResponse {
  approvalId: string;
  approved?: boolean;
  action?: ApprovalResponseAction;
}

export interface RequestUserInputOption {
  label: string;
  description: string;
}

export interface RequestUserInputQuestion {
  header: string; // <= 12 chars
  id: string; // snake_case
  question: string;
  options: RequestUserInputOption[]; // 2..3 options
}

export interface RequestUserInputArgs {
  questions: RequestUserInputQuestion[]; // 1..3 questions
}

export interface InputRequestAnswer {
  optionLabel?: string;
  otherText?: string;
}

export interface InputRequestResponse {
  requestId: string;
  status: "submitted" | "dismissed";
  answers?: Record<string, InputRequestAnswer>;
}

export interface InputRequest {
  id: string;
  taskId: string;
  questions: RequestUserInputQuestion[];
  status: "pending" | "submitted" | "dismissed";
  requestedAt: number;
  resolvedAt?: number;
  answers?: Record<string, InputRequestAnswer>;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  category:
    | "document"
    | "spreadsheet"
    | "presentation"
    | "organizer"
    | "custom";
  prompt: string;
  scriptPath?: string;
  parameters?: Record<string, Any>;
}

// ============ Agent Squad / Role Types ============

/**
 * Capability types that define what an agent role can do
 */
export type AgentCapability =
  // Technical
  | "code" // Writing and editing code
  | "review" // Reviewing code or content
  | "test" // Writing and running tests
  | "design" // UI/UX and visual design
  | "ops" // DevOps, CI/CD, infrastructure
  | "security" // Security analysis and auditing
  // Analysis & Research
  | "research" // Investigating and gathering information
  | "analyze" // Data analysis and insights
  | "plan" // Planning and architecture
  // Communication & Content
  | "document" // Writing documentation
  | "write" // General content writing
  | "communicate" // Customer support, outreach
  | "market" // Marketing and growth
  // Management
  | "manage" // Project management, coordination
  | "product"; // Product management, feature planning

/**
 * Agent autonomy level determines how independently an agent can act
 * - intern: Needs approval for most actions, learning the system
 * - specialist: Works independently in their domain
 * - lead: Full autonomy, can delegate tasks to other agents
 */
export type AgentAutonomyLevel = "intern" | "specialist" | "lead";

/**
 * Heartbeat status for tracking agent wake cycles
 */
export type HeartbeatStatus = "idle" | "running" | "sleeping" | "error";
export type HeartbeatProfile = "observer" | "operator" | "dispatcher";
export type HeartbeatRunType = "pulse" | "dispatch";
export type HeartbeatDispatchKind =
  | "silent"
  | "suggestion"
  | "task"
  | "runbook"
  | "cron_handoff";
export type HeartbeatPulseResultKind =
  | "idle"
  | "deferred"
  | "suggestion"
  | "dispatch_task"
  | "dispatch_runbook"
  | "handoff_to_cron";
export type HeartbeatSignalUrgency = "low" | "medium" | "high" | "critical";
export type HeartbeatSignalSource =
  | "hook"
  | "cron"
  | "api"
  | "manual"
  | "awareness"
  | "git"
  | "files"
  | "tasks"
  | "system";
export interface HeartbeatActiveHours {
  timezone?: string;
  startHour: number;
  endHour: number;
  weekdays?: number[];
}

// ============ Agent Performance Reviews (Mission Control) ============

export type AgentReviewRating = 1 | 2 | 3 | 4 | 5;

export interface AgentPerformanceReview {
  id: string;
  workspaceId: string;
  agentRoleId: string;
  periodStart: number; // epoch ms
  periodEnd: number; // epoch ms
  rating: AgentReviewRating;
  summary: string;
  metrics?: Record<string, number>;
  recommendedAutonomyLevel?: AgentAutonomyLevel;
  recommendationRationale?: string;
  createdAt: number;
}

export interface AgentReviewGenerateRequest {
  workspaceId: string;
  agentRoleId: string;
  periodDays?: number; // default: 7
}

/**
 * Tool restriction configuration for an agent role
 */
export interface AgentToolRestrictions {
  allowedTools?: string[];
  deniedTools?: string[];
}

export type CompanyLoopType =
  | "monitor"
  | "work_generation"
  | "execution"
  | "review";

export type CompanyOutputType =
  | "status_digest"
  | "decision_brief"
  | "issue_batch"
  | "exception_alert"
  | "work_order"
  | "review_request"
  | "metric_report";

export type CompanyPriority = "critical" | "high" | "normal" | "low";

export type CompanyReviewReason =
  | "strategy"
  | "irreversible_action"
  | "policy_exception"
  | "budget_risk"
  | "customer_risk"
  | "operator_attention";

export interface CompanyEvidenceRef {
  type: string;
  id: string;
  label?: string;
}

export interface CompanyOutputContract {
  companyId: string;
  operatorRoleId?: string;
  loopType: CompanyLoopType;
  outputType: CompanyOutputType;
  sourceIssueId?: string;
  sourceGoalId?: string;
  valueReason: string;
  reviewRequired: boolean;
  reviewReason?: CompanyReviewReason;
  evidenceRefs: CompanyEvidenceRef[];
  companyPriority?: CompanyPriority;
  triggerReason?: string;
  expectedOutputType?: CompanyOutputType;
}

export type AgentRoleKind = "system" | "custom" | "persona_template";

export interface HeartbeatPolicy {
  id: string;
  agentRoleId: string;
  enabled: boolean;
  cadenceMinutes: number;
  staggerOffsetMinutes: number;
  dispatchCooldownMinutes: number;
  maxDispatchesPerDay: number;
  profile: HeartbeatProfile;
  activeHours?: HeartbeatActiveHours | null;
  primaryCategories: CognitiveOffloadCategory[];
  proactiveTasks: ProactiveTaskDefinition[];
  createdAt: number;
  updatedAt: number;
}

export interface HeartbeatPolicyInput {
  enabled?: boolean;
  cadenceMinutes?: number;
  staggerOffsetMinutes?: number;
  dispatchCooldownMinutes?: number;
  maxDispatchesPerDay?: number;
  profile?: HeartbeatProfile;
  activeHours?: HeartbeatActiveHours | null;
  primaryCategories?: CognitiveOffloadCategory[];
  proactiveTasks?: ProactiveTaskDefinition[];
}

export interface AutomationProfile {
  id: string;
  agentRoleId: string;
  enabled: boolean;
  cadenceMinutes: number;
  staggerOffsetMinutes: number;
  dispatchCooldownMinutes: number;
  maxDispatchesPerDay: number;
  profile: HeartbeatProfile;
  activeHours?: HeartbeatActiveHours | null;
  heartbeatStatus: HeartbeatStatus;
  lastHeartbeatAt?: number;
  lastPulseAt?: number;
  lastDispatchAt?: number;
  lastPulseResult?: HeartbeatPulseResultKind;
  lastDispatchKind?: HeartbeatDispatchKind;
  createdAt: number;
  updatedAt: number;
}

export interface CreateAutomationProfileRequest {
  agentRoleId: string;
  enabled?: boolean;
  cadenceMinutes?: number;
  staggerOffsetMinutes?: number;
  dispatchCooldownMinutes?: number;
  maxDispatchesPerDay?: number;
  profile?: HeartbeatProfile;
  activeHours?: HeartbeatActiveHours | null;
}

export interface UpdateAutomationProfileRequest {
  id: string;
  enabled?: boolean;
  cadenceMinutes?: number;
  staggerOffsetMinutes?: number;
  dispatchCooldownMinutes?: number;
  maxDispatchesPerDay?: number;
  profile?: HeartbeatProfile;
  activeHours?: HeartbeatActiveHours | null;
}

export type CoreTraceSourceSurface =
  | "heartbeat"
  | "subconscious"
  | "memory"
  | "trigger"
  | "device";

export type CoreTraceKind =
  | "pulse_cycle"
  | "subconscious_cycle"
  | "memory_update"
  | "dream_distill"
  | "harness_experiment"
  | "regression_eval";

export type CoreTraceStatus =
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export type CoreTracePhase =
  | "start"
  | "evidence"
  | "failure_mining"
  | "gating"
  | "decision"
  | "dispatch"
  | "memory"
  | "eval"
  | "gate"
  | "promotion"
  | "complete"
  | "error";

export type CoreMemoryScopeKind =
  | "global"
  | "workspace"
  | "automation_profile"
  | "code_workspace"
  | "pull_request";

export type CoreMemoryCandidateType =
  | "preference"
  | "constraint"
  | "pattern"
  | "project_state"
  | "watch_item"
  | "open_loop"
  | "correction"
  | "recurring_task"
  | "ignored_noise"
  | "invalidates_prior";

export type CoreMemoryCandidateStatus =
  | "proposed"
  | "accepted"
  | "rejected"
  | "merged";

export interface CoreTrace {
  id: string;
  profileId: string;
  workspaceId?: string;
  targetKey?: string;
  sourceSurface: CoreTraceSourceSurface;
  traceKind: CoreTraceKind;
  status: CoreTraceStatus;
  taskId?: string;
  heartbeatRunId?: string;
  subconsciousRunId?: string;
  summary?: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
  createdAt: number;
}

export interface CoreTraceEvent {
  id: string;
  traceId: string;
  phase: CoreTracePhase;
  eventType: string;
  summary: string;
  details?: Record<string, unknown>;
  createdAt: number;
}

export interface CoreMemoryCandidate {
  id: string;
  traceId: string;
  profileId: string;
  workspaceId?: string;
  scopeKind: CoreMemoryScopeKind;
  scopeRef: string;
  candidateType: CoreMemoryCandidateType;
  summary: string;
  details?: string;
  confidence: number;
  noveltyScore: number;
  stabilityScore: number;
  status: CoreMemoryCandidateStatus;
  resolution?: string;
  sourceRunId?: string;
  createdAt: number;
  resolvedAt?: number;
}

export interface CoreMemoryDistillRun {
  id: string;
  profileId: string;
  workspaceId?: string;
  mode: "hot_path" | "offline";
  sourceTraceCount: number;
  candidateCount: number;
  acceptedCount: number;
  prunedCount: number;
  status: "running" | "completed" | "failed" | "skipped";
  summary?: Record<string, unknown>;
  error?: string;
  startedAt: number;
  completedAt?: number;
}

export interface CoreMemoryScopeState {
  scopeKind: CoreMemoryScopeKind;
  scopeRef: string;
  lastTraceAt?: number;
  lastDistillAt?: number;
  lastPruneAt?: number;
  stabilityVersion: number;
  updatedAt: number;
}

export interface ListCoreTracesRequest {
  profileId?: string;
  workspaceId?: string;
  targetKey?: string;
  traceKind?: CoreTraceKind;
  status?: CoreTraceStatus;
  limit?: number;
}

export interface GetCoreTraceResult {
  trace: CoreTrace;
  events: CoreTraceEvent[];
  candidates: CoreMemoryCandidate[];
}

export interface ListCoreMemoryCandidatesRequest {
  profileId?: string;
  workspaceId?: string;
  traceId?: string;
  scopeKind?: CoreMemoryScopeKind;
  status?: CoreMemoryCandidateStatus;
  limit?: number;
}

export interface ReviewCoreMemoryCandidateRequest {
  id: string;
  status: Extract<CoreMemoryCandidateStatus, "accepted" | "rejected" | "merged">;
  resolution?: string;
}

export interface ListCoreMemoryDistillRunsRequest {
  profileId: string;
  workspaceId?: string;
  limit?: number;
}

export interface RunCoreMemoryDistillNowRequest {
  profileId: string;
  workspaceId?: string;
}

export type CoreFailureCategory =
  | "wake_timing"
  | "dispatch_overreach"
  | "dispatch_underreach"
  | "memory_noise"
  | "memory_staleness"
  | "subconscious_duplication"
  | "subconscious_low_signal"
  | "routing_mismatch"
  | "workspace_context_gap"
  | "cooldown_policy_mismatch"
  | "budget_policy_mismatch"
  | "unknown";

export type CoreFailureSeverity = "low" | "medium" | "high" | "critical";

export type CoreFailureRecordStatus =
  | "open"
  | "clustered"
  | "resolved"
  | "archived";

export type CoreFailureClusterStatus =
  | "open"
  | "stable"
  | "evaluating"
  | "resolved"
  | "dismissed";

export type CoreEvalCaseStatus =
  | "draft"
  | "active"
  | "failing"
  | "archived";

export type CoreExperimentChangeKind =
  | "automation_profile"
  | "subconscious_settings"
  | "memory_policy";

export type CoreExperimentStatus =
  | "proposed"
  | "running"
  | "passed_gate"
  | "failed_gate"
  | "promoted"
  | "rejected";

export interface CoreFailureRecord {
  id: string;
  traceId: string;
  profileId: string;
  workspaceId?: string;
  targetKey?: string;
  category: CoreFailureCategory;
  severity: CoreFailureSeverity;
  fingerprint: string;
  summary: string;
  details?: string;
  status: CoreFailureRecordStatus;
  sourceSurface: CoreTraceSourceSurface;
  taskId?: string;
  createdAt: number;
  resolvedAt?: number;
}

export interface CoreFailureCluster {
  id: string;
  profileId: string;
  workspaceId?: string;
  category: CoreFailureCategory;
  fingerprint: string;
  rootCauseSummary: string;
  status: CoreFailureClusterStatus;
  recurrenceCount: number;
  linkedEvalCaseId?: string;
  linkedExperimentId?: string;
  firstSeenAt: number;
  lastSeenAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface CoreEvalCase {
  id: string;
  profileId: string;
  workspaceId?: string;
  clusterId: string;
  title: string;
  spec: Record<string, unknown>;
  status: CoreEvalCaseStatus;
  passCount: number;
  failCount: number;
  lastRunAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface CoreHarnessExperiment {
  id: string;
  profileId: string;
  workspaceId?: string;
  clusterId: string;
  changeKind: CoreExperimentChangeKind;
  proposal: Record<string, unknown>;
  status: CoreExperimentStatus;
  summary?: string;
  promotedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface CoreHarnessExperimentRun {
  id: string;
  experimentId: string;
  status: "queued" | "running" | "passed" | "failed";
  baseline?: Record<string, unknown>;
  outcome?: Record<string, unknown>;
  gateResultId?: string;
  summary?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface CoreRegressionGateResult {
  id: string;
  experimentRunId: string;
  passed: boolean;
  targetImproved: boolean;
  regressionsDetected: string[];
  summary: string;
  details?: Record<string, unknown>;
  createdAt: number;
}

export interface CoreLearningsEntry {
  id: string;
  profileId: string;
  workspaceId?: string;
  kind:
    | "failure_cluster"
    | "eval_case"
    | "experiment"
    | "promotion"
    | "gate_rejection";
  summary: string;
  details?: string;
  relatedClusterId?: string;
  relatedExperimentId?: string;
  createdAt: number;
}

export interface ListCoreFailureRecordsRequest {
  profileId?: string;
  workspaceId?: string;
  traceId?: string;
  category?: CoreFailureCategory;
  status?: CoreFailureRecordStatus;
  limit?: number;
}

export interface ListCoreFailureClustersRequest {
  profileId?: string;
  workspaceId?: string;
  category?: CoreFailureCategory;
  status?: CoreFailureClusterStatus;
  limit?: number;
}

export interface ReviewCoreFailureClusterRequest {
  id: string;
  status: Extract<CoreFailureClusterStatus, "stable" | "resolved" | "dismissed">;
  rootCauseSummary?: string;
}

export interface ListCoreEvalCasesRequest {
  profileId?: string;
  workspaceId?: string;
  clusterId?: string;
  status?: CoreEvalCaseStatus;
  limit?: number;
}

export interface ReviewCoreEvalCaseRequest {
  id: string;
  status: Extract<CoreEvalCaseStatus, "active" | "archived" | "failing">;
}

export interface ListCoreExperimentsRequest {
  profileId?: string;
  workspaceId?: string;
  clusterId?: string;
  status?: CoreExperimentStatus;
  limit?: number;
}

export interface RunCoreExperimentRequest {
  experimentId?: string;
  clusterId?: string;
  profileId?: string;
  workspaceId?: string;
  autoPromote?: boolean;
}

export interface ReviewCoreExperimentRequest {
  id: string;
  action: "promote" | "reject";
}

export interface ListCoreLearningsRequest {
  profileId?: string;
  workspaceId?: string;
  relatedClusterId?: string;
  relatedExperimentId?: string;
  limit?: number;
}

/**
 * Agent role defines a specialized agent with specific capabilities and configuration
 */
export interface AgentRole {
  id: string;
  name: string; // Unique identifier (e.g., 'code-reviewer')
  roleKind?: AgentRoleKind;
  sourceTemplateId?: string;
  sourceTemplateVersion?: string;
  companyId?: string; // Optional company assignment for company operators
  displayName: string; // Human-readable name (e.g., 'Code Reviewer')
  description?: string; // What this agent does
  icon: string; // Emoji or icon
  color: string; // Hex color for UI
  personalityId?: PersonalityId; // Override personality
  modelKey?: string; // Override model (e.g., 'opus-4-5')
  providerType?: LLMProviderType; // Override provider
  systemPrompt?: string; // Additional system prompt
  capabilities: AgentCapability[]; // What this agent can do
  toolRestrictions?: AgentToolRestrictions; // Tool access control
  isSystem: boolean; // Built-in vs custom
  isActive: boolean; // Enabled/disabled
  sortOrder: number; // Display order
  createdAt: number;
  updatedAt: number;

  // Automation fields
  autonomyLevel?: AgentAutonomyLevel; // How independently the agent can act
  soul?: string; // Extended personality (JSON: communication style, focus areas, preferences)
  heartbeatPolicy?: HeartbeatPolicy;
  heartbeatEnabled?: boolean; // Whether agent participates in heartbeat system
  heartbeatIntervalMinutes?: number; // How often agent wakes up (default: 15)
  heartbeatStaggerOffset?: number; // Offset in minutes to stagger wakeups
  pulseEveryMinutes?: number; // V3 pulse cadence (default: heartbeatIntervalMinutes or 15)
  dispatchCooldownMinutes?: number; // Minimum gap between dispatch runs
  maxDispatchesPerDay?: number; // Daily dispatch budget
  heartbeatProfile?: HeartbeatProfile; // V3 execution profile
  activeHours?: HeartbeatActiveHours; // Optional active window for pulse/dispatch
  lastHeartbeatAt?: number; // Timestamp of last heartbeat
  lastPulseAt?: number; // Timestamp of last pulse run
  lastDispatchAt?: number; // Timestamp of last dispatch run
  lastPulseResult?: HeartbeatPulseResultKind; // Structured result of latest pulse
  lastDispatchKind?: HeartbeatDispatchKind; // Structured result of latest dispatch
  heartbeatStatus?: HeartbeatStatus; // Current heartbeat state
  monthlyBudgetCost?: number; // Monthly cost budget in USD; null = unlimited
  autoPausedAt?: number | null; // Timestamp when agent was auto-paused by budget enforcement
  operatorMandate?: string;
  allowedLoopTypes?: CompanyLoopType[];
  outputTypes?: CompanyOutputType[];
  suppressionPolicy?: string;
  maxAutonomousOutputsPerCycle?: number;
  lastUsefulOutputAt?: number;
  operatorHealthScore?: number;
}

/**
 * Request to create a new agent role
 */
export interface CreateAgentRoleRequest {
  name: string;
  roleKind?: AgentRoleKind;
  sourceTemplateId?: string;
  sourceTemplateVersion?: string;
  companyId?: string;
  displayName: string;
  description?: string;
  icon?: string;
  color?: string;
  personalityId?: PersonalityId;
  modelKey?: string;
  providerType?: LLMProviderType;
  systemPrompt?: string;
  capabilities: AgentCapability[];
  toolRestrictions?: AgentToolRestrictions;
  // Automation fields
  autonomyLevel?: AgentAutonomyLevel;
  soul?: string;
  heartbeatPolicy?: HeartbeatPolicyInput;
  heartbeatEnabled?: boolean;
  heartbeatIntervalMinutes?: number;
  heartbeatStaggerOffset?: number;
  pulseEveryMinutes?: number;
  dispatchCooldownMinutes?: number;
  maxDispatchesPerDay?: number;
  heartbeatProfile?: HeartbeatProfile;
  activeHours?: HeartbeatActiveHours | null;
  monthlyBudgetCost?: number;
  operatorMandate?: string;
  allowedLoopTypes?: CompanyLoopType[];
  outputTypes?: CompanyOutputType[];
  suppressionPolicy?: string;
  maxAutonomousOutputsPerCycle?: number;
  lastUsefulOutputAt?: number;
  operatorHealthScore?: number;
}

/**
 * Request to update an agent role
 */
export interface UpdateAgentRoleRequest {
  id: string;
  roleKind?: AgentRoleKind;
  sourceTemplateId?: string | null;
  sourceTemplateVersion?: string | null;
  companyId?: string | null;
  displayName?: string;
  description?: string;
  icon?: string;
  color?: string;
  personalityId?: PersonalityId;
  modelKey?: string;
  providerType?: LLMProviderType;
  systemPrompt?: string;
  capabilities?: AgentCapability[];
  toolRestrictions?: AgentToolRestrictions;
  isActive?: boolean;
  sortOrder?: number;
  // Automation fields
  autonomyLevel?: AgentAutonomyLevel;
  soul?: string;
  autoPausedAt?: number | null;
  operatorMandate?: string;
  allowedLoopTypes?: CompanyLoopType[];
  outputTypes?: CompanyOutputType[];
  suppressionPolicy?: string;
  maxAutonomousOutputsPerCycle?: number;
  lastUsefulOutputAt?: number | null;
  operatorHealthScore?: number | null;
}

// ============ Agent Teams (Mission Control) ============

/**
 * Agent team = a lead agent role plus member roles.
 * Used for orchestrated runs and shared checklists.
 */
export interface AgentTeam {
  id: string;
  workspaceId: string;
  name: string;
  description?: string;
  leadAgentRoleId: string;
  maxParallelAgents: number;
  defaultModelPreference?: string;
  defaultPersonality?: string;
  isActive: boolean;
  /** When true, this team persists across sessions and auto-dispatches for matching tasks */
  persistent?: boolean;
  /** Default workspace for persistent teams (used for auto-dispatch) */
  defaultWorkspaceId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateAgentTeamRequest {
  workspaceId: string;
  name: string;
  description?: string;
  leadAgentRoleId: string;
  maxParallelAgents?: number;
  defaultModelPreference?: string;
  defaultPersonality?: string;
  isActive?: boolean;
  persistent?: boolean;
  defaultWorkspaceId?: string;
}

export interface UpdateAgentTeamRequest {
  id: string;
  name?: string;
  description?: string | null;
  leadAgentRoleId?: string;
  maxParallelAgents?: number;
  defaultModelPreference?: string | null;
  defaultPersonality?: string | null;
  isActive?: boolean;
  persistent?: boolean;
  defaultWorkspaceId?: string | null;
}

export interface AgentTeamMember {
  id: string;
  teamId: string;
  agentRoleId: string;
  memberOrder: number;
  isRequired: boolean;
  roleGuidance?: string;
  createdAt: number;
}

export interface CreateAgentTeamMemberRequest {
  teamId: string;
  agentRoleId: string;
  memberOrder?: number;
  isRequired?: boolean;
  roleGuidance?: string;
}

export interface UpdateAgentTeamMemberRequest {
  id: string;
  memberOrder?: number;
  isRequired?: boolean;
  roleGuidance?: string | null;
}

export type AgentTeamRunStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentTeamRunPhase =
  | "dispatch"
  | "think"
  | "synthesize"
  | "complete";

export interface AgentTeamRun {
  id: string;
  teamId: string;
  rootTaskId: string;
  status: AgentTeamRunStatus;
  startedAt: number;
  completedAt?: number;
  error?: string;
  summary?: string;
  phase?: AgentTeamRunPhase;
  collaborativeMode?: boolean;
  multiLlmMode?: boolean;
}

export interface CreateAgentTeamRunRequest {
  teamId: string;
  rootTaskId: string;
  status?: AgentTeamRunStatus;
  startedAt?: number;
  collaborativeMode?: boolean;
  multiLlmMode?: boolean;
}

export type AgentTeamItemStatus =
  | "todo"
  | "in_progress"
  | "blocked"
  | "done"
  | "failed";

export interface AgentTeamItem {
  id: string;
  teamRunId: string;
  parentItemId?: string;
  title: string;
  description?: string;
  ownerAgentRoleId?: string;
  sourceTaskId?: string;
  status: AgentTeamItemStatus;
  resultSummary?: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateAgentTeamItemRequest {
  teamRunId: string;
  parentItemId?: string;
  title: string;
  description?: string;
  ownerAgentRoleId?: string;
  sourceTaskId?: string;
  status?: AgentTeamItemStatus;
  sortOrder?: number;
}

export interface UpdateAgentTeamItemRequest {
  id: string;
  parentItemId?: string | null;
  title?: string;
  description?: string | null;
  ownerAgentRoleId?: string | null;
  sourceTaskId?: string | null;
  status?: AgentTeamItemStatus;
  resultSummary?: string | null;
  sortOrder?: number;
}

// ============ Managed Agents (Managed Sessions) ============

export type ManagedAgentStatus = "draft" | "active" | "suspended" | "archived";
export type ManagedAgentExecutionMode = "solo" | "team";

export type ManagedAgentRoutineTriggerType =
  | "manual"
  | "schedule"
  | "api"
  | "channel_event"
  | "mailbox_event"
  | "github_event"
  | "connector_event";

export interface ManagedAgentRoutineTriggerConfig {
  id?: string;
  type: ManagedAgentRoutineTriggerType;
  enabled?: boolean;
  cadenceMinutes?: number;
  path?: string;
  connectorId?: string;
  changeType?: string;
  resourceUriContains?: string;
  channelType?: string;
  chatId?: string;
  textContains?: string;
  senderContains?: string;
  eventType?: string;
  subjectContains?: string;
  provider?: string;
  labelContains?: string;
  eventName?: string;
  repository?: string;
  action?: string;
  ref?: string;
}

export interface ManagedAgentRoutineRecord {
  id: string;
  agentId: string;
  name: string;
  description?: string;
  enabled: boolean;
  workspaceId: string;
  environmentId?: string;
  trigger: ManagedAgentRoutineTriggerConfig;
  outputKinds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface CreateManagedAgentRoutineRequest {
  agentId: string;
  name: string;
  description?: string;
  enabled?: boolean;
  trigger: ManagedAgentRoutineTriggerConfig;
}

export interface UpdateManagedAgentRoutineRequest {
  agentId: string;
  routineId: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  trigger?: Partial<ManagedAgentRoutineTriggerConfig>;
}

export interface ManagedAgentLinkedRoutineRef {
  routineId: string;
  name: string;
  enabled: boolean;
  triggerTypes: ManagedAgentRoutineTriggerType[];
  summary?: string;
}

export interface ManagedAgentConversionProvenance {
  sourceType: "agent_role" | "automation_profile";
  sourceId: string;
  sourceLabel?: string;
  migratedAt: number;
}

export type AgentWorkspaceRole = "viewer" | "operator" | "builder" | "publisher" | "admin";

export interface AgentWorkspaceMembership {
  id: string;
  workspaceId: string;
  principalId: string;
  role: AgentWorkspaceRole;
  createdAt: number;
  updatedAt: number;
}

export interface AgentWorkspacePermissionSnapshot {
  workspaceId: string;
  principalId: string;
  role: AgentWorkspaceRole;
  canViewAgents: boolean;
  canRunAgents: boolean;
  canResumeSessions: boolean;
  canAnswerApprovals: boolean;
  canEditDrafts: boolean;
  canManageEnvironments: boolean;
  canPublishAgents: boolean;
  canManageRoutines: boolean;
  canManageMemberships: boolean;
  canAuditAgents: boolean;
}

export interface ManagedAgentAuditEntry {
  id: string;
  agentId: string;
  workspaceId: string;
  actorId: string;
  action:
    | "created"
    | "updated"
    | "published"
    | "suspended"
    | "archived"
    | "routine_created"
    | "routine_updated"
    | "routine_deleted"
    | "slack_deployment_updated"
    | "approval_policy_updated"
    | "converted_from_agent_role"
    | "converted_from_automation_profile"
    | "membership_updated";
  summary: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

export interface ManagedAgentInsightsCount {
  key: string;
  count: number;
}

export interface ManagedAgentInsightsToolCount {
  toolName: string;
  count: number;
}

export interface ManagedAgentInsightsError {
  id: string;
  message: string;
  occurredAt: number;
  sessionId?: string;
  routineRunId?: string;
}

export interface ManagedAgentInsights {
  agentId: string;
  totalRuns: number;
  uniqueUsers: number;
  successCount: number;
  failureCount: number;
  cancelledCount: number;
  averageCompletionTimeMs: number;
  approvalRate: number;
  topTools: ManagedAgentInsightsToolCount[];
  triggerBreakdown: ManagedAgentInsightsCount[];
  deploymentSurfaceBreakdown: ManagedAgentInsightsCount[];
  recentErrors: ManagedAgentInsightsError[];
  updatedAt: number;
}

export interface ManagedAgentSlackDeploymentHealthTarget {
  channelId: string;
  channelName: string;
  status: string;
  connected: boolean;
  misconfigured: boolean;
  securityMode?: SecurityMode;
  progressRelayMode?: "minimal" | "curated";
  configReadError?: string;
}

export interface ManagedAgentSlackDeploymentHealth {
  agentId: string;
  connectedCount: number;
  misconfiguredCount: number;
  targets: ManagedAgentSlackDeploymentHealthTarget[];
  lastSuccessfulRoutedRunAt?: number;
  lastSuccessfulRoutedRunId?: string;
  lastDeploymentError?: string;
  updatedAt: number;
}

export interface ManagedSessionWorkpaperDecision {
  summary: string;
  timestamp: number;
  sourceEventId?: string;
}

export interface ManagedSessionWorkpaperApproval {
  requestId: string;
  status: string;
  summary: string;
  createdAt: number;
  resolvedAt?: number;
}

export interface ManagedSessionWorkpaperArtifact {
  artifactId: string;
  label: string;
  path: string;
  mimeType?: string;
  playbackUrl?: string;
}

export interface ManagedSessionWorkpaperAuditItem {
  id: string;
  action: string;
  summary: string;
  createdAt: number;
  actorId: string;
}

export interface ManagedSessionWorkpaper {
  sessionId: string;
  agentId: string;
  summary: string;
  evidenceRefs: EvidenceRef[];
  decisions: ManagedSessionWorkpaperDecision[];
  approvals: ManagedSessionWorkpaperApproval[];
  artifacts: ManagedSessionWorkpaperArtifact[];
  auditTrail: ManagedSessionWorkpaperAuditItem[];
  generatedAt: number;
}

export interface ConvertAgentRoleToManagedAgentRequest {
  agentRoleId: string;
  workspaceId?: string;
}

export interface ConvertAutomationProfileToManagedAgentRequest {
  automationProfileId: string;
  workspaceId?: string;
}

export interface ManagedAgentConversionResult {
  agent: ManagedAgent;
  version: ManagedAgentVersion;
  environment: ManagedEnvironment;
  routines: ManagedAgentRoutineRecord[];
  sourceType: "agent_role" | "automation_profile";
  sourceId: string;
}

export interface ManagedAgentModelConfig {
  providerType?: LLMProviderType;
  modelKey?: string;
  llmProfile?: LlmProfile;
}

export interface ManagedAgentTeamTemplate {
  leadAgentRoleId?: string;
  memberAgentRoleIds?: string[];
  maxParallelAgents?: number;
  collaborativeMode?: boolean;
  multiLlmMode?: boolean;
}

export interface ManagedAgentRuntimeDefaults {
  autonomousMode?: boolean;
  requireWorktree?: boolean;
  allowUserInput?: boolean;
  allowedTools?: string[];
  toolRestrictions?: string[];
  /** Optional explicit turn cap for managed sessions created from this agent version. */
  maxTurns?: number;
  webSearchMode?: string;
}

export interface ManagedAgent {
  id: string;
  name: string;
  description?: string;
  status: ManagedAgentStatus;
  currentVersion: number;
  createdAt: number;
  updatedAt: number;
}

export interface ManagedAgentVersion {
  agentId: string;
  version: number;
  model?: ManagedAgentModelConfig;
  systemPrompt: string;
  executionMode: ManagedAgentExecutionMode;
  runtimeDefaults?: ManagedAgentRuntimeDefaults;
  skills?: string[];
  mcpServers?: string[];
  teamTemplate?: ManagedAgentTeamTemplate;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

export type ManagedEnvironmentKind = "cowork_local";
export type ManagedEnvironmentStatus = "active" | "archived";

export interface ManagedEnvironmentConfig {
  workspaceId: string;
  requireWorktree?: boolean;
  enableShell?: boolean;
  enableBrowser?: boolean;
  enableComputerUse?: boolean;
  allowedMcpServerIds?: string[];
  skillPackIds?: string[];
  filePaths?: string[];
  allowedToolFamilies?: ManagedAgentToolFamily[];
  credentialRefs?: string[];
  managedAccountRefs?: string[];
}

export interface ManagedEnvironment {
  id: string;
  name: string;
  kind: ManagedEnvironmentKind;
  revision: number;
  status: ManagedEnvironmentStatus;
  config: ManagedEnvironmentConfig;
  createdAt: number;
  updatedAt: number;
}

export type ManagedSessionStatus =
  | "pending"
  | "running"
  | "awaiting_input"
  | "interrupted"
  | "completed"
  | "failed"
  | "cancelled";

export interface ManagedSession {
  id: string;
  agentId: string;
  agentVersion: number;
  environmentId: string;
  title: string;
  status: ManagedSessionStatus;
  workspaceId: string;
  backingTaskId?: string;
  backingTeamRunId?: string;
  resumedFromSessionId?: string;
  latestSummary?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
}

export type ManagedSessionInputContent =
  | { type: "text"; text: string }
  | { type: "file"; artifactId: string };

export interface ManagedSessionCreateInput {
  agentId: string;
  environmentId: string;
  title: string;
  initialEvent?: {
    type: "user.message";
    content: ManagedSessionInputContent[];
  };
}

export type ManagedSessionEventType =
  | "session.created"
  | "user.message"
  | "assistant.message"
  | "tool.call"
  | "tool.result"
  | "task.event.bridge"
  | "status.changed"
  | "input.requested"
  | "input.received"
  | "session.completed"
  | "session.failed";

export interface ManagedSessionEvent {
  id: string;
  sessionId: string;
  seq: number;
  timestamp: number;
  type: ManagedSessionEventType;
  payload: Record<string, unknown>;
}

export type ManagedAgentToolFamily =
  | "shell"
  | "browser"
  | "computer-use"
  | "files"
  | "memory"
  | "documents"
  | "images"
  | "search"
  | "communication";

export type ManagedAgentRuntimeToolSurface = "chatgpt" | "slack";

export type ManagedAgentRuntimeToolApprovalBehavior =
  | "no_approval"
  | "auto_approve"
  | "require_approval"
  | "workspace_policy";

export interface ManagedAgentRuntimeToolCatalogEntry {
  name: string;
  description: string;
  readOnly: boolean;
  approvalKind: RuntimeToolApprovalKind;
  approvalType?: ApprovalType | null;
  approvalBehavior: ManagedAgentRuntimeToolApprovalBehavior;
  sideEffectLevel: RuntimeToolSideEffectLevel;
  resultKind: RuntimeToolResultKind;
  capabilityTags: RuntimeToolCapabilityTag[];
  exposure: RuntimeToolMetadata["exposure"];
  family?: ManagedAgentToolFamily;
  mcpServerName?: string | null;
}

export interface ManagedAgentRuntimeToolCatalog {
  agentId: string;
  environmentId?: string;
  chatgpt: ManagedAgentRuntimeToolCatalogEntry[];
  slack: ManagedAgentRuntimeToolCatalogEntry[];
}

export interface ManagedAgentFileRef {
  id: string;
  path: string;
  name: string;
  mimeType?: string;
  size?: number;
}

export interface ManagedAgentMemoryConfig {
  mode: "default" | "focused" | "disabled";
  sources?: string[];
}

export interface ManagedAgentChannelTarget {
  id: string;
  channelType: "slack";
  channelId: string;
  channelName?: string;
  enabled?: boolean;
  replyMode?: "default" | "mentions" | "manual";
  allowedUserIds?: string[];
  securityMode?: SecurityMode;
  progressRelayMode?: "minimal" | "curated";
}

export interface ManagedAgentScheduleConfig {
  enabled: boolean;
  mode: "manual" | "routine" | "recurring";
  label?: string;
  cadenceMinutes?: number;
  activeHours?: HeartbeatActiveHours | null;
}

export interface AudioSummaryConfig {
  enabled: boolean;
  style: "public-radio" | "executive-briefing" | "study-guide";
  title?: string;
  voice?: string;
  lastArtifactId?: string;
}

export interface ImageGenReferencePhoto {
  id: string;
  path: string;
  name: string;
  mimeType?: string;
  size?: number;
}

export interface ImageGenProfile {
  id: string;
  name: string;
  description?: string;
  isDefault?: boolean;
  referencePhotos: ImageGenReferencePhoto[];
  createdAt: number;
  updatedAt: number;
}

export interface ManagedAgentLegacyMirror {
  agentRoleId?: string;
  automationProfileId?: string;
}

export interface ManagedAgentApprovalPolicy {
  requireApprovalFor?: string[];
  autoApproveReadOnly?: boolean;
  escalationChannel?: string;
}

export interface ManagedAgentSharingConfig {
  visibility?: "private" | "team" | "workspace";
  ownerLabel?: string;
  sharedWith?: string[];
}

export interface ManagedAgentDeploymentConfig {
  surfaces?: Array<"chatgpt" | "slack">;
}

export interface ManagedAgentStudioConfig {
  templateId?: string;
  workflowBrief?: string;
  instructions?: {
    operatingNotes?: string;
  };
  skills?: string[];
  apps?: {
    mcpServers?: string[];
    connectorIds?: string[];
    allowedToolFamilies?: ManagedAgentToolFamily[];
  };
  fileRefs?: ManagedAgentFileRef[];
  memoryConfig?: ManagedAgentMemoryConfig;
  channelTargets?: ManagedAgentChannelTarget[];
  scheduleConfig?: ManagedAgentScheduleConfig;
  audioSummaryConfig?: AudioSummaryConfig;
  imageGenProfileId?: string;
  approvalPolicy?: ManagedAgentApprovalPolicy;
  sharing?: ManagedAgentSharingConfig;
  deployment?: ManagedAgentDeploymentConfig;
  defaultEnvironmentId?: string;
  routineIds?: string[];
  linkedRoutines?: ManagedAgentLinkedRoutineRef[];
  scheduleSummary?: string;
  conversion?: ManagedAgentConversionProvenance;
  legacyMirror?: ManagedAgentLegacyMirror;
}

export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  tagline?: string;
  icon: string;
  color: string;
  category: "operations" | "support" | "planning" | "research" | "engineering";
  featured?: boolean;
  systemPrompt: string;
  executionMode: ManagedAgentExecutionMode;
  runtimeDefaults?: ManagedAgentRuntimeDefaults;
  skills?: string[];
  mcpServers?: string[];
  teamTemplate?: ManagedAgentTeamTemplate;
  environmentConfig?: Partial<ManagedEnvironmentConfig>;
  studio?: Partial<ManagedAgentStudioConfig>;
}

export interface AudioSummaryResult {
  sessionId: string;
  artifact: Artifact;
  style: AudioSummaryConfig["style"];
  title: string;
  script: string;
  playbackUrl?: string;
}

// ============ Collaborative Thoughts (Team Multi-Agent Thinking) ============

export type ThoughtPhase = "dispatch" | "analysis" | "synthesis";

/** A thought shared by an agent during a collaborative team run */
export interface AgentThought {
  id: string;
  teamRunId: string;
  teamItemId?: string;
  agentRoleId: string;
  agentDisplayName: string;
  agentIcon: string;
  agentColor: string;
  phase: ThoughtPhase;
  content: string;
  isStreaming: boolean;
  sourceTaskId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateAgentThoughtRequest {
  teamRunId: string;
  teamItemId?: string;
  agentRoleId: string;
  agentDisplayName: string;
  agentIcon: string;
  agentColor: string;
  phase: ThoughtPhase;
  content: string;
  isStreaming?: boolean;
  sourceTaskId?: string;
}

/** Event payload for team thought IPC events */
export interface TeamThoughtEvent {
  type:
    | "team_thought_added"
    | "team_thought_updated"
    | "team_thought_streaming";
  timestamp: number;
  runId: string;
  thought: AgentThought;
}

/**
 * Default agent roles that come pre-configured
 */
export const DEFAULT_AGENT_ROLES: Omit<
  AgentRole,
  "id" | "createdAt" | "updatedAt"
>[] = [
  {
    name: "coder",
    displayName: "Coder",
    description: "Writes clean, efficient code and implements features",
    icon: "💻",
    color: "#3b82f6",
    capabilities: ["code", "document"],
    autonomyLevel: "specialist",
    isSystem: true,
    isActive: true,
    sortOrder: 1,
  },
  {
    name: "reviewer",
    displayName: "Code Reviewer",
    description: "Reviews code for bugs, security issues, and best practices",
    icon: "🔍",
    color: "#8b5cf6",
    capabilities: ["review", "analyze"],
    // Default to read-only behavior; reviewers should not modify files or run commands unless explicitly intended.
    toolRestrictions: { deniedTools: ["group:write", "group:destructive"] },
    autonomyLevel: "specialist",
    isSystem: true,
    isActive: true,
    sortOrder: 2,
  },
  {
    name: "researcher",
    displayName: "Researcher",
    description:
      "Investigates solutions, analyzes options, and gathers information",
    icon: "🔬",
    color: "#10b981",
    capabilities: ["research", "analyze", "document"],
    // Default to read-only behavior; research tasks should not modify files or run commands.
    toolRestrictions: { deniedTools: ["group:write", "group:destructive"] },
    autonomyLevel: "specialist",
    isSystem: true,
    isActive: true,
    sortOrder: 3,
  },
  {
    name: "tester",
    displayName: "Tester",
    description: "Writes and runs tests, finds edge cases and bugs",
    icon: "🧪",
    color: "#f59e0b",
    capabilities: ["test", "review"],
    autonomyLevel: "specialist",
    isSystem: true,
    isActive: true,
    sortOrder: 4,
  },
  {
    name: "architect",
    displayName: "Architect",
    description: "Designs system architecture and plans implementation",
    icon: "🏗️",
    color: "#ec4899",
    capabilities: ["plan", "design", "analyze"],
    autonomyLevel: "lead", // Can delegate tasks to other agents
    isSystem: true,
    isActive: true,
    sortOrder: 5,
  },
  {
    name: "writer",
    displayName: "Content Writer",
    description: "Writes documentation, blog posts, and marketing copy",
    icon: "✍️",
    color: "#06b6d4",
    capabilities: ["document", "research"],
    autonomyLevel: "specialist",
    isSystem: true,
    isActive: true,
    sortOrder: 6,
  },
  {
    name: "designer",
    displayName: "Designer",
    description: "Creates UI mockups, diagrams, and visual designs",
    icon: "🎨",
    color: "#d946ef",
    capabilities: ["design", "plan"],
    autonomyLevel: "specialist",
    isSystem: true,
    isActive: true,
    sortOrder: 7,
  },
  // === General Purpose Agents ===
  {
    name: "project_manager",
    displayName: "Project Manager",
    description:
      "Coordinates tasks, tracks progress, manages timelines and team workload",
    icon: "📋",
    color: "#0ea5e9",
    capabilities: ["manage", "plan", "communicate"],
    autonomyLevel: "lead",
    isSystem: true,
    isActive: true,
    sortOrder: 8,
  },
  {
    name: "product_manager",
    displayName: "Product Manager",
    description: "Defines features, writes user stories, prioritizes backlog",
    icon: "🎯",
    color: "#14b8a6",
    capabilities: ["product", "plan", "research"],
    autonomyLevel: "lead",
    isSystem: true,
    isActive: true,
    sortOrder: 9,
  },
  {
    name: "data_analyst",
    displayName: "Data Analyst",
    description: "Analyzes data, creates reports, finds insights and trends",
    icon: "📊",
    color: "#6366f1",
    capabilities: ["analyze", "research", "document"],
    autonomyLevel: "specialist",
    isSystem: true,
    isActive: true,
    sortOrder: 10,
  },
  {
    name: "marketing",
    displayName: "Marketing Specialist",
    description: "Creates campaigns, social media content, growth strategies",
    icon: "📣",
    color: "#f43f5e",
    capabilities: ["market", "write", "research"],
    autonomyLevel: "specialist",
    isSystem: true,
    isActive: true,
    sortOrder: 11,
  },
  {
    name: "support",
    displayName: "Support Agent",
    description:
      "Handles user queries, troubleshooting, customer communication",
    icon: "💬",
    color: "#22c55e",
    capabilities: ["communicate", "research", "document"],
    autonomyLevel: "specialist",
    isSystem: true,
    isActive: true,
    sortOrder: 12,
  },
  {
    name: "devops",
    displayName: "DevOps Engineer",
    description:
      "Manages CI/CD pipelines, deployment, infrastructure and monitoring",
    icon: "⚙️",
    color: "#f97316",
    capabilities: ["ops", "code", "security"],
    autonomyLevel: "specialist",
    isSystem: true,
    isActive: true,
    sortOrder: 13,
  },
  {
    name: "security_analyst",
    displayName: "Security Analyst",
    description:
      "Performs security audits, vulnerability assessments, compliance checks",
    icon: "🔒",
    color: "#ef4444",
    capabilities: ["security", "review", "analyze"],
    autonomyLevel: "specialist",
    isSystem: true,
    isActive: true,
    sortOrder: 14,
  },
  {
    name: "assistant",
    displayName: "General Assistant",
    description:
      "Versatile helper for miscellaneous tasks, scheduling, and coordination",
    icon: "🤖",
    color: "#64748b",
    capabilities: ["communicate", "research", "manage"],
    autonomyLevel: "intern",
    isSystem: true,
    isActive: true,
    sortOrder: 15,
  },
];

// ============ Persona Templates (Digital Twins) ============

/**
 * Cognitive offload category - types of mental work a digital twin absorbs
 * so the human can stay in flow.
 */
export type CognitiveOffloadCategory =
  | "context-switching" // Keeping track of multiple threads/projects
  | "status-reporting" // Standup summaries, progress updates, dashboards
  | "information-triage" // Filtering noise from signal (emails, Slack, PRs)
  | "decision-preparation" // Assembling data for decisions (not making them)
  | "documentation" // Maintaining docs, meeting notes, runbooks
  | "review-preparation" // Pre-screening code, designs, proposals
  | "dependency-tracking" // Cross-team blockers, library updates, deadlines
  | "compliance-checks" // Standards adherence, process gates, audit prep
  | "knowledge-curation" // Organizing learnings, best practices, FAQs
  | "routine-automation"; // Recurring chores (triage, labels, assignments)

/**
 * A proactive task the digital twin performs on heartbeat wake-ups
 */
export interface ProactiveTaskDefinition {
  id: string;
  name: string;
  description: string;
  category: CognitiveOffloadCategory;
  promptTemplate: string;
  frequencyMinutes: number;
  executionMode?: "pulse_only" | "dispatch" | "cron_handoff";
  minSignalStrength?: number;
  priority: number; // Lower = higher priority (1-10)
  enabled: boolean;
}

/**
 * Skill reference within a persona template
 */
export interface PersonaTemplateSkillRef {
  skillId: string;
  reason: string;
  required: boolean;
}

export interface PersonaTemplateHeartbeatConfig {
  enabled: boolean;
  intervalMinutes: number;
  staggerOffset?: number;
  dispatchCooldownMinutes?: number;
  maxDispatchesPerDay?: number;
  profile?: HeartbeatProfile;
  activeHours?: HeartbeatActiveHours | null;
}

export interface PersonaTemplateCognitiveOffloadConfig {
  primaryCategories: CognitiveOffloadCategory[];
  proactiveTasks: ProactiveTaskDefinition[];
}

/**
 * Category for persona template gallery grouping
 */
export type PersonaTemplateCategory =
  | "engineering"
  | "management"
  | "product"
  | "data"
  | "operations";

/**
 * A persona template defines a pre-built digital twin configuration.
 * Templates are instantiated into AgentRoles when activated.
 */
export interface PersonaTemplate {
  id: string;
  version: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  category: PersonaTemplateCategory;

  role: {
    capabilities: AgentCapability[];
    autonomyLevel: AgentAutonomyLevel;
    personalityId: PersonalityId;
    toolRestrictions?: AgentToolRestrictions;
    systemPrompt: string;
    soul: string; // JSON string for role-persona
  };

  heartbeat?: PersonaTemplateHeartbeatConfig;
  cognitiveOffload?: PersonaTemplateCognitiveOffloadConfig;

  skills: PersonaTemplateSkillRef[];

  tags: string[];
  seniorityRange: string[];
  industryAgnostic: boolean;
}

/**
 * Result from activating (instantiating) a persona template
 */
export interface PersonaTemplateActivationResult {
  agentRole: AgentRole;
  installedSkillIds: string[];
  proactiveTaskCount: number;
  warnings: string[];
}

/**
 * Request to activate a persona template
 */
export interface ActivatePersonaTemplateRequest {
  templateId: string;
  customization?: {
    companyId?: string;
    displayName?: string;
    icon?: string;
    color?: string;
    modelKey?: string;
    providerType?: LLMProviderType;
  };
}

// ============ Mission Control Types ============

/**
 * Task subscription for auto-notifications
 * Agents subscribed to a task receive updates when new comments/activities occur
 */
export interface TaskSubscription {
  id: string;
  taskId: string;
  agentRoleId: string;
  subscriptionReason: "assigned" | "mentioned" | "commented" | "manual";
  subscribedAt: number;
}

/**
 * Daily standup report aggregating task status
 */
export interface StandupReport {
  id: string;
  workspaceId: string;
  reportDate: string; // YYYY-MM-DD format
  completedTaskIds: string[];
  inProgressTaskIds: string[];
  blockedTaskIds: string[];
  summary: string;
  deliveredToChannel?: string; // channel:id format
  createdAt: number;
}

export type CronSchedule =
  | { kind: "at"; atMs: number }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string };

export interface CouncilParticipant {
  providerType: LLMProviderType;
  modelKey: string;
  seatLabel: string;
  roleInstruction?: string;
}

export interface CouncilFileSource {
  path: string;
  label?: string;
}

export interface CouncilUrlSource {
  url: string;
  label?: string;
}

export interface CouncilConnectorSource {
  provider: string;
  label: string;
  resourceId?: string;
  notes?: string;
}

export interface CouncilSourceBundle {
  files: CouncilFileSource[];
  urls: CouncilUrlSource[];
  connectors: CouncilConnectorSource[];
}

export interface CouncilDeliveryConfig {
  enabled: boolean;
  channelType?: ChannelType;
  channelDbId?: string;
  channelId?: string;
}

export interface CouncilExecutionPolicy {
  mode: "auto" | "full_parallel" | "capped_local";
  maxParallelParticipants?: number;
}

export interface CouncilConfig {
  id: string;
  workspaceId: string;
  name: string;
  enabled: boolean;
  schedule: CronSchedule;
  participants: CouncilParticipant[];
  judgeSeatIndex: number;
  rotatingIdeaSeatIndex: number;
  sourceBundle: CouncilSourceBundle;
  deliveryConfig: CouncilDeliveryConfig;
  executionPolicy: CouncilExecutionPolicy;
  managedCronJobId?: string;
  nextIdeaSeatIndex: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateCouncilConfigRequest {
  workspaceId: string;
  name: string;
  enabled?: boolean;
  schedule: CronSchedule;
  participants: CouncilParticipant[];
  judgeSeatIndex: number;
  rotatingIdeaSeatIndex?: number;
  sourceBundle?: Partial<CouncilSourceBundle>;
  deliveryConfig?: Partial<CouncilDeliveryConfig>;
  executionPolicy?: Partial<CouncilExecutionPolicy>;
}

export interface UpdateCouncilConfigRequest {
  id: string;
  name?: string;
  enabled?: boolean;
  schedule?: import("../electron/cron/types").CronSchedule;
  participants?: CouncilParticipant[];
  judgeSeatIndex?: number;
  rotatingIdeaSeatIndex?: number;
  sourceBundle?: CouncilSourceBundle;
  deliveryConfig?: CouncilDeliveryConfig;
  executionPolicy?: CouncilExecutionPolicy;
  managedCronJobId?: string | null;
  nextIdeaSeatIndex?: number;
}

export interface CouncilRun {
  id: string;
  councilConfigId: string;
  workspaceId: string;
  taskId?: string;
  status: "running" | "completed" | "failed";
  proposerSeatIndex: number;
  summary?: string;
  error?: string;
  memoId?: string;
  sourceSnapshot: CouncilSourceBundle;
  startedAt: number;
  completedAt?: number;
}

export interface CouncilMemo {
  id: string;
  councilRunId: string;
  councilConfigId: string;
  workspaceId: string;
  taskId?: string;
  proposerSeatIndex: number;
  content: string;
  delivered: boolean;
  deliveryError?: string;
  createdAt: number;
}

/**
 * Result from a heartbeat check
 */
export interface HeartbeatResult {
  agentRoleId: string;
  status: "ok" | "work_done" | "error";
  runId?: string;
  runType?: HeartbeatRunType;
  pendingMentions: number;
  assignedTasks: number;
  relevantActivities: number;
  maintenanceChecks?: number;
  maintenanceWorkspaceId?: string;
  silent?: boolean;
  taskCreated?: string; // ID of task created if work was done
  triggerReason?: string;
  loopType?: CompanyLoopType;
  outputType?: CompanyOutputType;
  expectedOutputType?: CompanyOutputType;
  valueReason?: string;
  reviewRequired?: boolean;
  reviewReason?: CompanyReviewReason;
  evidenceRefs?: CompanyEvidenceRef[];
  companyPriority?: CompanyPriority;
  decisionMode?: HeartbeatDecisionMode;
  signalFamily?: HeartbeatSignalFamily;
  confidence?: number;
  interruptionRisk?: number;
  workspaceScope?: HeartbeatWorkspaceScope;
  pulseOutcome?: HeartbeatPulseResultKind;
  dispatchKind?: HeartbeatDispatchKind;
  deferred?: boolean;
  deferredReason?: string;
  compressedSignalCount?: number;
  signalCount?: number;
  dueProactiveCount?: number;
  checklistDueCount?: number;
  reflectionRunId?: string;
  reflectionOutcome?: string;
  cooldownUntil?: number;
  dispatchesToday?: number;
  maxDispatchesPerDay?: number;
  evidenceRefsV3?: string[];
  error?: string;
}

export type HeartbeatDecisionMode =
  | "silent"
  | "inbox_suggestion"
  | "task_creation"
  | "nudge";

export type HeartbeatSignalFamily =
  | "urgent_interrupt"
  | "focus_state"
  | "open_loop_pressure"
  | "correction_learning"
  | "memory_drift"
  | "cross_workspace_patterns"
  | "suggestion_aging"
  | "awareness_signal"
  | "maintenance"
  | "mentions"
  | "assigned_tasks";

export type HeartbeatWorkspaceScope = "single" | "all";

export interface HeartbeatSignal {
  id: string;
  agentRoleId: string;
  workspaceId?: string;
  agentScope: "agent" | "workspace";
  workspaceScope: HeartbeatWorkspaceScope;
  signalFamily: HeartbeatSignalFamily;
  source: HeartbeatSignalSource;
  fingerprint: string;
  urgency: HeartbeatSignalUrgency;
  confidence: number;
  expiresAt: number;
  evidenceRefs?: string[];
  mergedCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
  reason?: string;
  payload?: Record<string, unknown>;
}

export interface HeartbeatDeferredState {
  active: boolean;
  reason?: string;
  summary?: string;
  deferredAt?: number;
  resumeAfterAt?: number;
  compressedSignalCount: number;
}

/**
 * Heartbeat configuration for an agent
 */
export interface HeartbeatConfig {
  heartbeatEnabled?: boolean;
  heartbeatIntervalMinutes?: number;
  heartbeatStaggerOffset?: number;
  pulseEveryMinutes?: number;
  dispatchCooldownMinutes?: number;
  maxDispatchesPerDay?: number;
  heartbeatProfile?: HeartbeatProfile;
  activeHours?: HeartbeatActiveHours | null;
}

export interface AutomationProfileRunQuery {
  profileId: string;
  limit?: number;
}

/**
 * Heartbeat event emitted during heartbeat execution
 */
export interface HeartbeatEvent {
  type:
    | "started"
    | "completed"
    | "error"
    | "work_found"
    | "no_work"
    | "wake_queued"
    | "wake_coalesced"
    | "wake_queue_saturated"
    | "wake_immediate_deferred"
    | "signal_received"
    | "signal_merged"
    | "pulse_started"
    | "pulse_completed"
    | "pulse_deferred"
    | "dispatch_started"
    | "dispatch_completed"
    | "dispatch_skipped";
  agentRoleId: string;
  agentName: string;
  timestamp: number;
  result?: HeartbeatResult;
  error?: string;
  wake?: {
    source: "hook" | "cron" | "api" | "manual";
    mode: "now" | "next-heartbeat";
    text: string;
    deferredMs?: number;
    reason?: "ready" | "drain";
  };
  runId?: string;
  runType?: HeartbeatRunType;
  dispatchKind?: HeartbeatDispatchKind;
  deferred?: HeartbeatDeferredState;
  signal?: HeartbeatSignal;
}

/**
 * Board column for task organization (Kanban)
 */
export type BoardColumn =
  | "backlog"
  | "todo"
  | "in_progress"
  | "review"
  | "done";

/**
 * Board column definitions for UI
 */
export const BOARD_COLUMNS: {
  id: BoardColumn;
  label: string;
  color: string;
}[] = [
  { id: "backlog", label: "Backlog", color: "#6b7280" },
  { id: "todo", label: "To Do", color: "#3b82f6" },
  { id: "in_progress", label: "In Progress", color: "#f59e0b" },
  { id: "review", label: "Review", color: "#8b5cf6" },
  { id: "done", label: "Done", color: "#10b981" },
];

/**
 * Task label for organization
 */
export interface TaskLabel {
  id: string;
  workspaceId: string;
  name: string;
  color: string;
  createdAt: number;
}

/**
 * Request to create a new task label
 */
export interface CreateTaskLabelRequest {
  workspaceId: string;
  name: string;
  color?: string;
}

/**
 * Request to update a task label
 */
export interface UpdateTaskLabelRequest {
  name?: string;
  color?: string;
}

/**
 * Query parameters for listing task labels
 */
export interface TaskLabelListQuery {
  workspaceId: string;
}

// ============ Agent Working State Types ============

/**
 * State type for agent working state
 */
export type WorkingStateType = "context" | "progress" | "notes" | "plan";

/**
 * Agent working state for context persistence
 */
export interface AgentWorkingState {
  id: string;
  agentRoleId: string;
  workspaceId: string;
  taskId?: string;
  stateType: WorkingStateType;
  content: string;
  fileReferences?: string[];
  isCurrent: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * Request to create or update agent working state
 */
export interface UpdateWorkingStateRequest {
  agentRoleId: string;
  workspaceId: string;
  taskId?: string;
  stateType: WorkingStateType;
  content: string;
  fileReferences?: string[];
}

/**
 * Query to get agent working state
 */
export interface WorkingStateQuery {
  agentRoleId: string;
  workspaceId: string;
  taskId?: string;
  stateType?: WorkingStateType;
}

/**
 * Query to get working state history
 */
export interface WorkingStateHistoryQuery {
  agentRoleId: string;
  workspaceId: string;
  limit?: number;
  offset?: number;
}

// ============ Activity Feed Types ============

/**
 * Actor type for activity feed entries
 */
export type ActivityActorType = "agent" | "user" | "system";

/**
 * Type of activity in the feed
 */
export type ActivityType =
  | "task_created"
  | "task_started"
  | "task_completed"
  | "task_failed"
  | "task_paused"
  | "task_resumed"
  | "comment"
  | "file_created"
  | "file_modified"
  | "file_deleted"
  | "command_executed"
  | "tool_used"
  | "mention"
  | "supervisor_exchange"
  | "agent_assigned"
  | "error"
  | "info";

/**
 * Activity feed entry
 */
export interface Activity {
  id: string;
  workspaceId: string;
  taskId?: string;
  agentRoleId?: string;
  actorType: ActivityActorType;
  activityType: ActivityType;
  title: string;
  description?: string;
  metadata?: Record<string, unknown>;
  isRead: boolean;
  isPinned: boolean;
  createdAt: number;
}

/**
 * Request to create a new activity
 */
export interface CreateActivityRequest {
  workspaceId: string;
  taskId?: string;
  agentRoleId?: string;
  actorType: ActivityActorType;
  activityType: ActivityType;
  title: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Activity list query parameters
 */
export interface ActivityListQuery {
  workspaceId: string;
  taskId?: string;
  agentRoleId?: string;
  activityType?: ActivityType | ActivityType[];
  actorType?: ActivityActorType;
  isRead?: boolean;
  isPinned?: boolean;
  limit?: number;
  offset?: number;
}

// ============ @Mention System Types ============

/**
 * Type of mention/request between agents
 */
export type MentionType = "request" | "handoff" | "review" | "fyi";

/**
 * Status of a mention
 */
export type MentionStatus =
  | "pending"
  | "acknowledged"
  | "completed"
  | "dismissed";

/**
 * An @mention from one agent to another
 */
export interface AgentMention {
  id: string;
  workspaceId: string;
  taskId: string;
  fromAgentRoleId?: string;
  toAgentRoleId: string;
  mentionType: MentionType;
  context?: string;
  status: MentionStatus;
  createdAt: number;
  acknowledgedAt?: number;
  completedAt?: number;
}

/**
 * Request to create a new mention
 */
export interface CreateMentionRequest {
  workspaceId: string;
  taskId: string;
  fromAgentRoleId?: string;
  toAgentRoleId: string;
  mentionType: MentionType;
  context?: string;
}

/**
 * Query parameters for listing mentions
 */
export interface MentionListQuery {
  workspaceId?: string;
  taskId?: string;
  toAgentRoleId?: string;
  fromAgentRoleId?: string;
  status?: MentionStatus | MentionStatus[];
  limit?: number;
  offset?: number;
}

// ============ Discord Supervisor Protocol ============

export interface DiscordSupervisorConfig {
  enabled: boolean;
  coordinationChannelId?: string;
  watchedChannelIds?: string[];
  workerAgentRoleId?: string;
  supervisorAgentRoleId?: string;
  humanEscalationChannelId?: string;
  humanEscalationUserId?: string;
  peerBotUserIds?: string[];
  strictMode?: boolean;
}

export type SupervisorProtocolIntent =
  | "status_request"
  | "review_request"
  | "escalation_notice"
  | "ack";

export type SupervisorExchangeStatus =
  | "open"
  | "acknowledged"
  | "escalated"
  | "closed"
  | "ignored";

export type SupervisorActorKind =
  | "peer"
  | "worker"
  | "supervisor"
  | "human"
  | "system";

export interface SupervisorEvidenceRef {
  channelId: string;
  messageId: string;
  summary?: string;
  capturedAt: number;
}

export interface SupervisorExchange {
  id: string;
  workspaceId: string;
  coordinationChannelId: string;
  sourceChannelId?: string;
  sourceMessageId?: string;
  sourcePeerUserId?: string;
  workerAgentRoleId?: string;
  supervisorAgentRoleId?: string;
  linkedTaskId?: string;
  escalationTarget?: string;
  status: SupervisorExchangeStatus;
  lastIntent?: SupervisorProtocolIntent;
  turnCount: number;
  terminalReason?: string;
  evidenceRefs?: SupervisorEvidenceRef[];
  humanResolution?: string;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
}

export interface SupervisorExchangeMessage {
  id: string;
  exchangeId: string;
  discordMessageId: string;
  channelId: string;
  authorUserId?: string;
  actorKind: SupervisorActorKind;
  intent: SupervisorProtocolIntent;
  rawContent: string;
  createdAt: number;
}

export interface SupervisorExchangeListQuery {
  workspaceId: string;
  status?: SupervisorExchangeStatus | SupervisorExchangeStatus[];
  limit?: number;
}

export interface ResolveSupervisorExchangeRequest {
  id: string;
  resolution: string;
  mirrorToDiscord?: boolean;
}

export interface SupervisorExchangeEvent {
  type: "created" | "updated" | "resolved";
  exchange: SupervisorExchange;
}

// ============ Infrastructure Types ============

export interface WalletInfo {
  address: string;
  network: string;
  balanceUsdc?: string;
}

export interface InfraSandboxInfo {
  id: string;
  name?: string;
  status: "running" | "stopped" | "error";
  createdAt: number;
  region?: string;
}

export type InfraProviderStatus =
  | "connected"
  | "disconnected"
  | "error"
  | "not_configured";

export interface InfraStatus {
  enabled: boolean;
  wallet?: WalletInfo;
  walletFileExists?: boolean;
  providers: {
    e2b: InfraProviderStatus;
    domains: InfraProviderStatus;
    wallet: InfraProviderStatus;
  };
  activeSandboxes: number;
  error?: string;
}

export interface InfraSettings {
  enabled: boolean;
  showWalletInSidebar: boolean;
  e2b: {
    apiKey: string;
    defaultRegion: string;
  };
  domains: {
    provider: "namecheap";
    apiKey: string;
    username: string;
    clientIp: string;
  };
  wallet: {
    enabled: boolean;
    provider: "local" | "coinbase_agentic";
    coinbase: {
      enabled: boolean;
      signerEndpoint: string;
      network: "base-mainnet" | "base-sepolia";
      accountId: string;
    };
  };
  payments: {
    requireApproval: boolean;
    maxAutoApproveUsd: number;
    hardLimitUsd: number;
    allowedHosts: string[];
  };
  enabledCategories: {
    sandbox: boolean;
    domains: boolean;
    payments: boolean;
  };
}

export const DEFAULT_INFRA_SETTINGS: InfraSettings = {
  enabled: false,
  showWalletInSidebar: true,
  e2b: {
    apiKey: "",
    defaultRegion: "us-east-1",
  },
  domains: {
    provider: "namecheap",
    apiKey: "",
    username: "",
    clientIp: "",
  },
  wallet: {
    enabled: true,
    provider: "local",
    coinbase: {
      enabled: false,
      signerEndpoint: "",
      network: "base-mainnet",
      accountId: "",
    },
  },
  payments: {
    requireApproval: true,
    maxAutoApproveUsd: 1.0,
    hardLimitUsd: 100.0,
    allowedHosts: [],
  },
  enabledCategories: {
    sandbox: true,
    domains: true,
    payments: true,
  },
};

// ─── Proactive Suggestions ──────────────────────────────────────

export type SuggestionType =
  | "follow_up"
  | "recurring_pattern"
  | "goal_aligned"
  | "insight"
  | "reverse_prompt";

export interface ProactiveSuggestion {
  id: string;
  type: SuggestionType;
  title: string;
  description: string;
  actionPrompt?: string;
  sourceTaskId?: string;
  sourceEntity?: string;
  confidence: number;
  suggestionClass?:
    | "focus_support"
    | "open_loop"
    | "correction"
    | "memory"
    | "cross_workspace"
    | "aging"
    | "urgent"
    | "general";
  urgency?: "low" | "medium" | "high";
  learningSignalIds?: string[];
  workspaceScope?: HeartbeatWorkspaceScope;
  workspaceId?: string;
  sourceSignals?: string[];
  recommendedDelivery?: "briefing" | "inbox" | "nudge";
  companionStyle?: "email" | "note";
  snoozedUntil?: number;
  createdAt: number;
  expiresAt: number;
  dismissed: boolean;
  actedOn: boolean;
}

// IPC Channel names
export const IPC_CHANNELS = {
  // Task operations
  TASK_CREATE: "task:create",
  TASK_GET: "task:get",
  TASK_LIST: "task:list",
  TASK_EXPORT_JSON: "task:exportJSON",
  TASK_PIN: "task:pin",
  TASK_CANCEL: "task:cancel",
  TASK_WRAP_UP: "task:wrapUp",
  TASK_PAUSE: "task:pause",
  TASK_RESUME: "task:resume",
  TASK_CONTINUE: "task:continue",
  TASK_FORK_SESSION: "task:forkSession",
  TASK_RENAME: "task:rename",
  TASK_DELETE: "task:delete",
  DIALOG_SELECT_FOLDER: "dialog:selectFolder",
  DIALOG_SELECT_FILES: "dialog:selectFiles",
  WINDOW_MINIMIZE: "window:minimize",
  WINDOW_MAXIMIZE: "window:maximize",
  WINDOW_CLOSE: "window:close",
  WINDOW_IS_MAXIMIZED: "window:isMaximized",
  RENDERER_PERF_LOG: "renderer:perfLog",
  FILE_OPEN: "file:open",
  FILE_SHOW_IN_FINDER: "file:showInFinder",
  FILE_READ_FOR_VIEWER: "file:readForViewer",
  LLM_WIKI_GET_VAULT_SUMMARY: "llmWiki:getVaultSummary",
  FILE_IMPORT_TO_WORKSPACE: "file:importToWorkspace",
  FILE_IMPORT_DATA_TO_WORKSPACE: "file:importDataToWorkspace",
  DOCUMENT_OPEN_EDITOR_SESSION: "document:openEditorSession",
  DOCUMENT_LIST_VERSIONS: "document:listVersions",
  DOCUMENT_START_EDIT_TASK: "document:startEditTask",
  SHELL_OPEN_EXTERNAL: "shell:openExternal",
  MAILBOX_GET_SYNC_STATUS: "mailbox:getSyncStatus",
  MAILBOX_CLIENT_STATE: "mailbox:clientState",
  MAILBOX_SYNC: "mailbox:sync",
  MAILBOX_LIST_THREADS: "mailbox:listThreads",
  MAILBOX_GET_THREAD: "mailbox:getThread",
  MAILBOX_LIST_EVENTS: "mailbox:listEvents",
  MAILBOX_GET_DIGEST: "mailbox:getDigest",
  MAILBOX_TODAY_DIGEST: "mailbox:todayDigest",
  MAILBOX_SENDER_CLEANUP_DIGEST: "mailbox:senderCleanupDigest",
  MAILBOX_ASK: "mailbox:ask",
  MAILBOX_ATTACHMENT_EXTRACT_TEXT: "mailbox:attachmentExtractText",
  MAILBOX_CREATE_DRAFT: "mailbox:createDraft",
  MAILBOX_UPDATE_DRAFT: "mailbox:updateDraft",
  MAILBOX_SEND_DRAFT: "mailbox:sendDraft",
  MAILBOX_SCHEDULE_SEND: "mailbox:scheduleSend",
  MAILBOX_DISCARD_COMPOSE_DRAFT: "mailbox:discardComposeDraft",
  MAILBOX_UNDO_ACTION: "mailbox:undoAction",
  MAILBOX_SUMMARIZE_THREAD: "mailbox:summarizeThread",
  MAILBOX_GENERATE_DRAFT: "mailbox:generateDraft",
  MAILBOX_EXTRACT_COMMITMENTS: "mailbox:extractCommitments",
  MAILBOX_REVIEW_BULK_ACTION: "mailbox:reviewBulkAction",
  MAILBOX_SCHEDULE_REPLY: "mailbox:scheduleReply",
  MAILBOX_RESEARCH_CONTACT: "mailbox:researchContact",
  MAILBOX_APPLY_ACTION: "mailbox:applyAction",
  MAILBOX_UPDATE_COMMITMENT_STATE: "mailbox:updateCommitmentState",
  MAILBOX_UPDATE_COMMITMENT_DETAILS: "mailbox:updateCommitmentDetails",
  MAILBOX_RECLASSIFY_THREAD: "mailbox:reclassifyThread",
  MAILBOX_RECLASSIFY_ACCOUNT: "mailbox:reclassifyAccount",
  MAILBOX_MC_HANDOFF_PREVIEW: "mailbox:missionControlHandoffPreview",
  MAILBOX_MC_HANDOFF_CREATE: "mailbox:missionControlHandoffCreate",
  MAILBOX_MC_HANDOFF_LIST: "mailbox:missionControlHandoffList",
  MAILBOX_SNIPPETS_LIST: "mailbox:snippetsList",
  MAILBOX_SNIPPET_UPSERT: "mailbox:snippetUpsert",
  MAILBOX_SNIPPET_DELETE: "mailbox:snippetDelete",
  MAILBOX_SAVED_VIEWS_LIST: "mailbox:savedViewsList",
  MAILBOX_SAVED_VIEW_CREATE: "mailbox:savedViewCreate",
  MAILBOX_SAVED_VIEW_DELETE: "mailbox:savedViewDelete",
  MAILBOX_SAVED_VIEW_PREVIEW_SIMILAR: "mailbox:savedViewPreviewSimilar",
  MAILBOX_QUICK_REPLY_SUGGESTIONS: "mailbox:quickReplySuggestions",
  MAILBOX_SAVED_VIEW_REVIEW_SCHEDULE: "mailbox:savedViewReviewSchedule",
  MAILBOX_IDENTITY_RESOLVE: "mailbox:identityResolve",
  MAILBOX_IDENTITY_GET: "mailbox:identityGet",
  MAILBOX_IDENTITY_LIST: "mailbox:identityList",
  MAILBOX_IDENTITY_SEARCH: "mailbox:identitySearch",
  MAILBOX_IDENTITY_LINK: "mailbox:identityLink",
  MAILBOX_IDENTITY_TIMELINE: "mailbox:identityTimeline",
  MAILBOX_IDENTITY_CANDIDATES: "mailbox:identityCandidates",
  MAILBOX_IDENTITY_CONFIRM: "mailbox:identityConfirm",
  MAILBOX_IDENTITY_REJECT: "mailbox:identityReject",
  MAILBOX_IDENTITY_UNLINK: "mailbox:identityUnlink",
  MAILBOX_IDENTITY_PREFERENCE: "mailbox:identityPreference",
  MAILBOX_IDENTITY_COVERAGE: "mailbox:identityCoverage",
  MAILBOX_REPLY_VIA_CHANNEL: "mailbox:replyViaChannel",
  MAILBOX_EVENT: "mailbox:event",

  // Sub-Agent / Parallel Agent operations
  AGENT_GET_CHILDREN: "agent:getChildren", // Get child tasks for a parent
  AGENT_GET_STATUS: "agent:getStatus", // Get status of spawned agents

  // Agent Role / Squad operations
  AGENT_ROLE_LIST: "agentRole:list",
  AGENT_ROLE_GET: "agentRole:get",
  AGENT_ROLE_CREATE: "agentRole:create",
  AGENT_ROLE_UPDATE: "agentRole:update",
  AGENT_ROLE_DELETE: "agentRole:delete",
  AGENT_ROLE_ASSIGN_TO_TASK: "agentRole:assignToTask",
  AGENT_ROLE_GET_DEFAULTS: "agentRole:getDefaults",
  AGENT_ROLE_SEED_DEFAULTS: "agentRole:seedDefaults",
  AGENT_ROLE_SYNC_DEFAULTS: "agentRole:syncDefaults",

  // Activity Feed
  ACTIVITY_LIST: "activity:list",
  ACTIVITY_CREATE: "activity:create",
  ACTIVITY_MARK_READ: "activity:markRead",
  ACTIVITY_MARK_ALL_READ: "activity:markAllRead",
  ACTIVITY_PIN: "activity:pin",
  ACTIVITY_DELETE: "activity:delete",
  ACTIVITY_EVENT: "activity:event",

  // @Mention System
  MENTION_CREATE: "mention:create",
  MENTION_LIST: "mention:list",
  MENTION_ACKNOWLEDGE: "mention:acknowledge",
  MENTION_COMPLETE: "mention:complete",
  MENTION_DISMISS: "mention:dismiss",
  MENTION_EVENT: "mention:event",

  // Discord Supervisor Protocol
  SUPERVISOR_EXCHANGE_LIST: "supervisorExchange:list",
  SUPERVISOR_EXCHANGE_RESOLVE: "supervisorExchange:resolve",
  SUPERVISOR_EXCHANGE_EVENT: "supervisorExchange:event",

  // Mission Control - Heartbeat System
  HEARTBEAT_GET_CONFIG: "heartbeat:getConfig",
  HEARTBEAT_UPDATE_CONFIG: "heartbeat:updateConfig",
  HEARTBEAT_TRIGGER: "heartbeat:trigger",
  HEARTBEAT_GET_STATUS: "heartbeat:getStatus",
  HEARTBEAT_GET_ALL_STATUS: "heartbeat:getAllStatus",
  HEARTBEAT_EVENT: "heartbeat:event",
  AUTOMATION_PROFILE_LIST: "automationProfile:list",
  AUTOMATION_PROFILE_GET: "automationProfile:get",
  AUTOMATION_PROFILE_CREATE: "automationProfile:create",
  AUTOMATION_PROFILE_UPDATE: "automationProfile:update",
  AUTOMATION_PROFILE_DELETE: "automationProfile:delete",
  AUTOMATION_PROFILE_ATTACH: "automationProfile:attach",
  AUTOMATION_PROFILE_DETACH: "automationProfile:detach",
  AUTOMATION_PROFILE_LIST_HEARTBEAT_RUNS: "automationProfile:listHeartbeatRuns",
  AUTOMATION_PROFILE_LIST_SUBCONSCIOUS_RUNS: "automationProfile:listSubconsciousRuns",
  CORE_TRACE_LIST: "coreTrace:list",
  CORE_TRACE_GET: "coreTrace:get",
  CORE_TRACE_LIST_BY_PROFILE: "coreTrace:listByProfile",
  CORE_FAILURE_LIST: "coreFailure:list",
  CORE_FAILURE_CLUSTER_LIST: "coreFailure:listClusters",
  CORE_FAILURE_CLUSTER_REVIEW: "coreFailure:reviewCluster",
  CORE_EVAL_CASE_LIST: "coreEval:listCases",
  CORE_EVAL_CASE_REVIEW: "coreEval:reviewCase",
  CORE_EXPERIMENT_LIST: "coreExperiment:list",
  CORE_EXPERIMENT_RUN: "coreExperiment:run",
  CORE_EXPERIMENT_REVIEW: "coreExperiment:review",
  CORE_LEARNINGS_LIST: "coreLearnings:list",
  CORE_MEMORY_LIST_CANDIDATES: "coreMemory:listCandidates",
  CORE_MEMORY_REVIEW_CANDIDATE: "coreMemory:reviewCandidate",
  CORE_MEMORY_LIST_DISTILL_RUNS: "coreMemory:listDistillRuns",
  CORE_MEMORY_RUN_DISTILL_NOW: "coreMemory:runDistillNow",

  // Mission Control - Task Subscriptions
  SUBSCRIPTION_LIST: "subscription:list",
  SUBSCRIPTION_ADD: "subscription:add",
  SUBSCRIPTION_REMOVE: "subscription:remove",
  SUBSCRIPTION_GET_SUBSCRIBERS: "subscription:getSubscribers",
  SUBSCRIPTION_GET_FOR_AGENT: "subscription:getForAgent",
  SUBSCRIPTION_EVENT: "subscription:event",

  // Mission Control - Standup Reports
  STANDUP_GENERATE: "standup:generate",
  STANDUP_GET_LATEST: "standup:getLatest",
  STANDUP_LIST: "standup:list",
  STANDUP_DELIVER: "standup:deliver",

  // R&D Council
  COUNCIL_LIST: "council:list",
  COUNCIL_GET: "council:get",
  COUNCIL_CREATE: "council:create",
  COUNCIL_UPDATE: "council:update",
  COUNCIL_DELETE: "council:delete",
  COUNCIL_RUN_NOW: "council:runNow",
  COUNCIL_LIST_RUNS: "council:listRuns",
  COUNCIL_GET_MEMO: "council:getMemo",
  COUNCIL_SET_ENABLED: "council:setEnabled",

  // Mission Control - Company Ops / Planner
  MC_COMPANY_LIST: "missionControl:companyList",
  MC_COMPANY_GET: "missionControl:companyGet",
  MC_COMPANY_CREATE: "missionControl:companyCreate",
  MC_COMPANY_UPDATE: "missionControl:companyUpdate",
  MC_COMPANY_PACKAGE_SOURCE_LIST: "missionControl:companyPackageSourceList",
  MC_COMPANY_PACKAGE_PREVIEW_IMPORT:
    "missionControl:companyPackagePreviewImport",
  MC_COMPANY_PACKAGE_IMPORT: "missionControl:companyPackageImport",
  MC_COMPANY_GRAPH_GET: "missionControl:companyGraphGet",
  MC_COMPANY_SYNC_LIST: "missionControl:companySyncList",
  MC_COMPANY_ORG_LINK_ROLE: "missionControl:companyOrgLinkRole",
  MC_COMMAND_CENTER_SUMMARY: "missionControl:commandCenterSummary",
  MC_GOAL_LIST: "missionControl:goalList",
  MC_GOAL_GET: "missionControl:goalGet",
  MC_GOAL_CREATE: "missionControl:goalCreate",
  MC_GOAL_UPDATE: "missionControl:goalUpdate",
  MC_PROJECT_LIST: "missionControl:projectList",
  MC_PROJECT_GET: "missionControl:projectGet",
  MC_PROJECT_CREATE: "missionControl:projectCreate",
  MC_PROJECT_UPDATE: "missionControl:projectUpdate",
  MC_ISSUE_LIST: "missionControl:issueList",
  MC_ISSUE_GET: "missionControl:issueGet",
  MC_ISSUE_CREATE: "missionControl:issueCreate",
  MC_ISSUE_UPDATE: "missionControl:issueUpdate",
  MC_ISSUE_COMMENT_LIST: "missionControl:issueCommentList",
  MC_RUN_LIST: "missionControl:runList",
  MC_RUN_EVENT_LIST: "missionControl:runEventList",
  MC_PLANNER_GET_CONFIG: "missionControl:plannerGetConfig",
  MC_PLANNER_UPDATE_CONFIG: "missionControl:plannerUpdateConfig",
  MC_PLANNER_RUN: "missionControl:plannerRun",
  MC_PLANNER_LIST_RUNS: "missionControl:plannerListRuns",

  // Mission Control - Agent Performance Reviews
  REVIEW_GENERATE: "review:generate",
  REVIEW_GET_LATEST: "review:getLatest",
  REVIEW_LIST: "review:list",
  REVIEW_DELETE: "review:delete",
  EVAL_LIST_SUITES: "eval:listSuites",
  EVAL_RUN_SUITE: "eval:runSuite",
  EVAL_GET_RUN: "eval:getRun",
  EVAL_GET_CASE: "eval:getCase",
  EVAL_CREATE_CASE_FROM_TASK: "eval:createCaseFromTask",

  // Mission Control - Agent Teams
  TEAM_LIST: "team:list",
  TEAM_GET: "team:get",
  TEAM_CREATE: "team:create",
  TEAM_UPDATE: "team:update",
  TEAM_DELETE: "team:delete",
  TEAM_MEMBER_ADD: "teamMember:add",
  TEAM_MEMBER_LIST: "teamMember:list",
  TEAM_MEMBER_UPDATE: "teamMember:update",
  TEAM_MEMBER_REMOVE: "teamMember:remove",
  TEAM_MEMBER_REORDER: "teamMember:reorder",
  TEAM_RUN_CREATE: "teamRun:create",
  TEAM_RUN_GET: "teamRun:get",
  TEAM_RUN_LIST: "teamRun:list",
  TEAM_RUN_CANCEL: "teamRun:cancel",
  TEAM_RUN_WRAP_UP: "teamRun:wrapUp",
  TEAM_RUN_PAUSE: "teamRun:pause",
  TEAM_RUN_RESUME: "teamRun:resume",
  TEAM_ITEM_LIST: "teamItem:list",
  TEAM_ITEM_CREATE: "teamItem:create",
  TEAM_ITEM_UPDATE: "teamItem:update",
  TEAM_ITEM_DELETE: "teamItem:delete",
  TEAM_ITEM_MOVE: "teamItem:move",
  TEAM_RUN_EVENT: "teamRun:event",

  // Collaborative Thoughts
  TEAM_THOUGHT_LIST: "teamThought:list",
  TEAM_THOUGHT_EVENT: "teamThought:event",
  TEAM_RUN_FIND_BY_ROOT_TASK: "teamRun:findByRootTask",

  // Mission Control - Persona Templates (Digital Twins)
  PERSONA_TEMPLATE_LIST: "personaTemplate:list",
  PERSONA_TEMPLATE_GET: "personaTemplate:get",
  PERSONA_TEMPLATE_ACTIVATE: "personaTemplate:activate",
  PERSONA_TEMPLATE_PREVIEW: "personaTemplate:preview",
  PERSONA_TEMPLATE_GET_CATEGORIES: "personaTemplate:getCategories",

  // Plugin Packs (Customize panel)
  PLUGIN_PACK_LIST: "pluginPack:list",
  PLUGIN_PACK_GET: "pluginPack:get",
  PLUGIN_PACK_TOGGLE: "pluginPack:toggle",
  PLUGIN_PACK_GET_CONTEXT: "pluginPack:getContext",
  PLUGIN_PACK_TOGGLE_SKILL: "pluginPack:toggleSkill",

  // Plugin Pack Distribution (scaffold, install, registry)
  PLUGIN_PACK_SCAFFOLD: "pluginPack:scaffold",
  PLUGIN_PACK_INSTALL_GIT: "pluginPack:installGit",
  PLUGIN_PACK_INSTALL_URL: "pluginPack:installUrl",
  PLUGIN_PACK_UNINSTALL: "pluginPack:uninstall",
  PLUGIN_PACK_REGISTRY_SEARCH: "pluginPack:registrySearch",
  PLUGIN_PACK_REGISTRY_DETAILS: "pluginPack:registryDetails",
  PLUGIN_PACK_REGISTRY_CATEGORIES: "pluginPack:registryCategories",
  PLUGIN_PACK_CHECK_UPDATES: "pluginPack:checkUpdates",
  IMPORT_SECURITY_LIST_QUARANTINED: "importSecurity:listQuarantined",
  IMPORT_SECURITY_GET_REPORT: "importSecurity:getReport",
  IMPORT_SECURITY_RETRY_QUARANTINED: "importSecurity:retryQuarantined",
  IMPORT_SECURITY_REMOVE_QUARANTINED: "importSecurity:removeQuarantined",

  // Admin Policies
  ADMIN_POLICIES_GET: "admin:policiesGet",
  ADMIN_POLICIES_UPDATE: "admin:policiesUpdate",
  ADMIN_POLICIES_CHECK_PACK: "admin:checkPack",

  // Workspace Kit (.cowork)
  KIT_GET_STATUS: "kit:getStatus",
  KIT_INIT: "kit:init",
  KIT_APPLY_ONBOARDING_PROFILE: "kit:applyOnboardingProfile",
  KIT_PROJECT_CREATE: "kit:projectCreate",
  KIT_OPEN_FILE: "kit:openFile",
  KIT_RESET_ADAPTIVE_STYLE: "kit:resetAdaptiveStyle",
  KIT_SUBMIT_MESSAGE_FEEDBACK: "kit:submitMessageFeedback",

  // Task Board (Kanban)
  TASK_MOVE_COLUMN: "task:moveColumn",
  TASK_SET_PRIORITY: "task:setPriority",
  TASK_SET_DUE_DATE: "task:setDueDate",
  TASK_SET_ESTIMATE: "task:setEstimate",
  TASK_ADD_LABEL: "task:addLabel",
  TASK_REMOVE_LABEL: "task:removeLabel",
  TASK_BOARD_EVENT: "taskBoard:event",

  // Task Labels
  TASK_LABEL_LIST: "taskLabel:list",
  TASK_LABEL_CREATE: "taskLabel:create",
  TASK_LABEL_UPDATE: "taskLabel:update",
  TASK_LABEL_DELETE: "taskLabel:delete",

  // Agent Working State
  WORKING_STATE_GET: "workingState:get",
  WORKING_STATE_GET_CURRENT: "workingState:getCurrent",
  WORKING_STATE_UPDATE: "workingState:update",
  WORKING_STATE_HISTORY: "workingState:history",
  WORKING_STATE_RESTORE: "workingState:restore",
  WORKING_STATE_DELETE: "workingState:delete",
  WORKING_STATE_LIST_FOR_TASK: "workingState:listForTask",

  // Context Policy (per-context security DM vs group)
  CONTEXT_POLICY_GET: "contextPolicy:get",
  CONTEXT_POLICY_GET_FOR_CHAT: "contextPolicy:getForChat",
  CONTEXT_POLICY_LIST: "contextPolicy:list",
  CONTEXT_POLICY_UPDATE: "contextPolicy:update",
  CONTEXT_POLICY_DELETE: "contextPolicy:delete",
  CONTEXT_POLICY_CREATE_DEFAULTS: "contextPolicy:createDefaults",
  CONTEXT_POLICY_IS_TOOL_ALLOWED: "contextPolicy:isToolAllowed",

  // Task events (streaming and history)
  TASK_EVENT: "task:event",
  TASK_EVENTS: "task:events",
  TASK_SEMANTIC_TIMELINE: "task:semanticTimeline",
  TASK_TRACE_LIST: "taskTrace:list",
  TASK_TRACE_GET: "taskTrace:get",
  TASK_LEARNING_PROGRESS: "task:learningProgress",
  TASK_LEARNING_EVENT: "task:learningEvent",
  TASK_SEND_MESSAGE: "task:sendMessage",
  TASK_STEP_FEEDBACK: "task:stepFeedback", // Send feedback on an in-progress step
  TASK_SEND_STDIN: "task:sendStdin", // Send stdin input to running command
  TASK_KILL_COMMAND: "task:killCommand", // Kill running command (Ctrl+C)
  SHELL_SESSION_EVENT: "shell:sessionEvent",
  SHELL_SESSION_GET: "shell:sessionGet",
  SHELL_SESSION_LIST: "shell:sessionList",
  SHELL_SESSION_RESET: "shell:sessionReset",
  SHELL_SESSION_CLOSE: "shell:sessionClose",
  UNIFIED_RECALL_QUERY: "recall:query",
  LLM_ROUTING_STATUS: "llm:routingStatus",
  LLM_ROUTING_EVENT: "llm:routingEvent",

  // Workspace operations
  WORKSPACE_SELECT: "workspace:select",
  WORKSPACE_LIST: "workspace:list",
  WORKSPACE_CREATE: "workspace:create",
  WORKSPACE_UPDATE_PERMISSIONS: "workspace:updatePermissions",
  WORKSPACE_TOUCH: "workspace:touch",
  WORKSPACE_GET_TEMP: "workspace:getTemp", // Get or create temp workspace

  // Approval operations
  APPROVAL_RESPOND: "approval:respond",
  APPROVAL_SESSION_AUTO_APPROVE_SET: "approval:sessionAutoApprove:set",
  APPROVAL_SESSION_AUTO_APPROVE_GET: "approval:sessionAutoApprove:get",
  INPUT_REQUEST_LIST: "inputRequest:list",
  INPUT_REQUEST_RESPOND: "inputRequest:respond",

  // Artifact operations
  ARTIFACT_LIST: "artifact:list",
  ARTIFACT_PREVIEW: "artifact:preview",

  // Skills
  SKILL_LIST: "skill:list",
  SKILL_GET: "skill:get",

  // Custom User Skills
  CUSTOM_SKILL_LIST: "customSkill:list",
  CUSTOM_SKILL_LIST_TASKS: "customSkill:listTasks", // List only task skills (for dropdown)
  CUSTOM_SKILL_LIST_GUIDELINES: "customSkill:listGuidelines", // List only guideline skills (for settings)
  CUSTOM_SKILL_GET: "customSkill:get",
  CUSTOM_SKILL_CREATE: "customSkill:create",
  CUSTOM_SKILL_UPDATE: "customSkill:update",
  CUSTOM_SKILL_DELETE: "customSkill:delete",
  CUSTOM_SKILL_RELOAD: "customSkill:reload",
  CUSTOM_SKILL_OPEN_FOLDER: "customSkill:openFolder",
  CUSTOM_SKILL_GET_SETTINGS: "customSkill:getSettings",
  CUSTOM_SKILL_SET_EXTERNAL_DIRS: "customSkill:setExternalDirs",
  CUSTOM_SKILL_OPEN_EXTERNAL_FOLDER: "customSkill:openExternalFolder",

  // Skill Registry (SkillHub)
  SKILL_REGISTRY_SEARCH: "skillRegistry:search",
  SKILL_REGISTRY_CLAWHUB_SEARCH: "skillRegistry:clawhubSearch",
  SKILL_REGISTRY_GET_DETAILS: "skillRegistry:getDetails",
  SKILL_REGISTRY_INSTALL: "skillRegistry:install",
  SKILL_REGISTRY_INSTALL_CLAWHUB: "skillRegistry:installClawHub",
  SKILL_REGISTRY_INSTALL_URL: "skillRegistry:installUrl",
  SKILL_REGISTRY_INSTALL_GIT: "skillRegistry:installGit",
  SKILL_REGISTRY_UPDATE: "skillRegistry:update",
  SKILL_REGISTRY_UPDATE_ALL: "skillRegistry:updateAll",
  SKILL_REGISTRY_UNINSTALL: "skillRegistry:uninstall",
  SKILL_REGISTRY_LIST_MANAGED: "skillRegistry:listManaged",
  SKILL_REGISTRY_CHECK_UPDATES: "skillRegistry:checkUpdates",
  SKILL_REGISTRY_GET_STATUS: "skillRegistry:getStatus",
  SKILL_REGISTRY_GET_ELIGIBLE: "skillRegistry:getEligible",

  // LLM Settings
  LLM_GET_SETTINGS: "llm:getSettings",
  LLM_SAVE_SETTINGS: "llm:saveSettings",
  LLM_RESET_PROVIDER_CREDENTIALS: "llm:resetProviderCredentials",
  LLM_TEST_PROVIDER: "llm:testProvider",
  LLM_GET_MODELS: "llm:getModels",
  LLM_GET_CONFIG_STATUS: "llm:getConfigStatus",
  LLM_SET_MODEL: "llm:setModel",
  LLM_GET_ANTHROPIC_MODELS: "llm:getAnthropicModels",
  LLM_GET_OLLAMA_MODELS: "llm:getOllamaModels",
  LLM_GET_GEMINI_MODELS: "llm:getGeminiModels",
  LLM_GET_OPENROUTER_MODELS: "llm:getOpenRouterModels",
  LLM_GET_OPENAI_MODELS: "llm:getOpenAIModels",
  LLM_GET_GROQ_MODELS: "llm:getGroqModels",
  LLM_GET_XAI_MODELS: "llm:getXAIModels",
  LLM_GET_KIMI_MODELS: "llm:getKimiModels",
  LLM_GET_PI_MODELS: "llm:getPiModels",
  LLM_GET_PI_PROVIDERS: "llm:getPiProviders",
  LLM_GET_OPENAI_COMPATIBLE_MODELS: "llm:getOpenAICompatibleModels",
  LOCAL_AI_CHECK_HF: "localai:checkHf",
  LOCAL_AI_DETECT_HARDWARE: "localai:detectHardware",
  LOCAL_AI_START_SERVER: "localai:startServer",
  LOCAL_AI_STOP_SERVER: "localai:stopServer",
  LOCAL_AI_GET_SERVER_STATUS: "localai:getServerStatus",
  LOCAL_AI_GET_SERVER_LOG: "localai:getServerLog",
  LLM_REFRESH_CUSTOM_PROVIDER_MODELS: "llm:refreshCustomProviderModels",
  LLM_OPENAI_OAUTH_START: "llm:openaiOAuthStart",
  LLM_OPENAI_OAUTH_LOGOUT: "llm:openaiOAuthLogout",
  LLM_GET_BEDROCK_MODELS: "llm:getBedrockModels",
  LLM_GET_PROVIDER_MODELS: "llm:getProviderModels",

  // Gateway / Channels
  GATEWAY_GET_CHANNELS: "gateway:getChannels",
  GATEWAY_ADD_CHANNEL: "gateway:addChannel",
  GATEWAY_UPDATE_CHANNEL: "gateway:updateChannel",
  GATEWAY_REMOVE_CHANNEL: "gateway:removeChannel",
  GATEWAY_ENABLE_CHANNEL: "gateway:enableChannel",
  GATEWAY_DISABLE_CHANNEL: "gateway:disableChannel",
  GATEWAY_TEST_CHANNEL: "gateway:testChannel",
  GATEWAY_GET_USERS: "gateway:getUsers",
  GATEWAY_LIST_CHATS: "gateway:listChats",
  GATEWAY_SEND_TEST_MESSAGE: "gateway:sendTestMessage",
  GATEWAY_GRANT_ACCESS: "gateway:grantAccess",
  GATEWAY_REVOKE_ACCESS: "gateway:revokeAccess",
  GATEWAY_GENERATE_PAIRING: "gateway:generatePairing",

  // Search Settings
  SEARCH_GET_SETTINGS: "search:getSettings",
  SEARCH_SAVE_SETTINGS: "search:saveSettings",
  SEARCH_GET_CONFIG_STATUS: "search:getConfigStatus",
  SEARCH_TEST_PROVIDER: "search:testProvider",

  // X/Twitter Settings
  X_GET_SETTINGS: "x:getSettings",
  X_SAVE_SETTINGS: "x:saveSettings",
  X_TEST_CONNECTION: "x:testConnection",
  X_GET_STATUS: "x:getStatus",

  // Notion Settings
  NOTION_GET_SETTINGS: "notion:getSettings",
  NOTION_SAVE_SETTINGS: "notion:saveSettings",
  NOTION_TEST_CONNECTION: "notion:testConnection",
  NOTION_GET_STATUS: "notion:getStatus",

  // Box Settings
  BOX_GET_SETTINGS: "box:getSettings",
  BOX_SAVE_SETTINGS: "box:saveSettings",
  BOX_TEST_CONNECTION: "box:testConnection",
  BOX_GET_STATUS: "box:getStatus",

  // OneDrive Settings
  ONEDRIVE_GET_SETTINGS: "onedrive:getSettings",
  ONEDRIVE_SAVE_SETTINGS: "onedrive:saveSettings",
  ONEDRIVE_TEST_CONNECTION: "onedrive:testConnection",
  ONEDRIVE_GET_STATUS: "onedrive:getStatus",

  // Google Drive Settings
  GOOGLE_WORKSPACE_GET_SETTINGS: "googleWorkspace:getSettings",
  GOOGLE_WORKSPACE_SAVE_SETTINGS: "googleWorkspace:saveSettings",
  GOOGLE_WORKSPACE_TEST_CONNECTION: "googleWorkspace:testConnection",
  GOOGLE_WORKSPACE_GET_STATUS: "googleWorkspace:getStatus",
  GOOGLE_WORKSPACE_OAUTH_START: "googleWorkspace:oauthStart",
  GOOGLE_WORKSPACE_OAUTH_GET_LINK: "googleWorkspace:oauthGetLink",

  // AgentMail Settings
  AGENTMAIL_GET_SETTINGS: "agentmail:getSettings",
  AGENTMAIL_SAVE_SETTINGS: "agentmail:saveSettings",
  AGENTMAIL_TEST_CONNECTION: "agentmail:testConnection",
  AGENTMAIL_GET_STATUS: "agentmail:getStatus",
  AGENTMAIL_LIST_PODS: "agentmail:listPods",
  AGENTMAIL_GET_WORKSPACE_BINDING: "agentmail:getWorkspaceBinding",
  AGENTMAIL_BIND_WORKSPACE_POD: "agentmail:bindWorkspacePod",
  AGENTMAIL_CREATE_WORKSPACE_POD: "agentmail:createWorkspacePod",
  AGENTMAIL_LIST_INBOXES: "agentmail:listInboxes",
  AGENTMAIL_CREATE_INBOX: "agentmail:createInbox",
  AGENTMAIL_UPDATE_INBOX: "agentmail:updateInbox",
  AGENTMAIL_DELETE_INBOX: "agentmail:deleteInbox",
  AGENTMAIL_LIST_DOMAINS: "agentmail:listDomains",
  AGENTMAIL_CREATE_DOMAIN: "agentmail:createDomain",
  AGENTMAIL_VERIFY_DOMAIN: "agentmail:verifyDomain",
  AGENTMAIL_DELETE_DOMAIN: "agentmail:deleteDomain",
  AGENTMAIL_LIST_LIST_ENTRIES: "agentmail:listListEntries",
  AGENTMAIL_CREATE_LIST_ENTRY: "agentmail:createListEntry",
  AGENTMAIL_DELETE_LIST_ENTRY: "agentmail:deleteListEntry",
  AGENTMAIL_LIST_INBOX_API_KEYS: "agentmail:listInboxApiKeys",
  AGENTMAIL_CREATE_INBOX_API_KEY: "agentmail:createInboxApiKey",
  AGENTMAIL_DELETE_INBOX_API_KEY: "agentmail:deleteInboxApiKey",
  AGENTMAIL_REFRESH_WORKSPACE: "agentmail:refreshWorkspace",

  // Dropbox Settings
  DROPBOX_GET_SETTINGS: "dropbox:getSettings",
  DROPBOX_SAVE_SETTINGS: "dropbox:saveSettings",
  DROPBOX_TEST_CONNECTION: "dropbox:testConnection",
  DROPBOX_GET_STATUS: "dropbox:getStatus",

  // SharePoint Settings
  SHAREPOINT_GET_SETTINGS: "sharepoint:getSettings",
  SHAREPOINT_SAVE_SETTINGS: "sharepoint:saveSettings",
  PROFILE_LIST: "profile:list",
  PROFILE_CREATE: "profile:create",
  PROFILE_SWITCH: "profile:switch",
  PROFILE_EXPORT: "profile:export",
  PROFILE_IMPORT: "profile:import",
  SHAREPOINT_TEST_CONNECTION: "sharepoint:testConnection",
  SHAREPOINT_GET_STATUS: "sharepoint:getStatus",

  // Health Platform
  HEALTH_GET_DASHBOARD: "health:getDashboard",
  HEALTH_LIST_SOURCES: "health:listSources",
  HEALTH_UPSERT_SOURCE: "health:upsertSource",
  HEALTH_REMOVE_SOURCE: "health:removeSource",
  HEALTH_SYNC_SOURCE: "health:syncSource",
  HEALTH_IMPORT_FILES: "health:importFiles",
  HEALTH_GENERATE_WORKFLOW: "health:generateWorkflow",
  HEALTH_APPLE_STATUS: "health:appleStatus",
  HEALTH_APPLE_CONNECT: "health:appleConnect",
  HEALTH_APPLE_DISCONNECT: "health:appleDisconnect",
  HEALTH_APPLE_RESET: "health:appleReset",
  HEALTH_APPLE_PREVIEW_WRITEBACK: "health:applePreviewWriteback",
  HEALTH_APPLE_APPLY_WRITEBACK: "health:appleApplyWriteback",

  // App Updates
  APP_CHECK_UPDATES: "app:checkUpdates",
  APP_DOWNLOAD_UPDATE: "app:downloadUpdate",
  APP_INSTALL_UPDATE: "app:installUpdate",
  APP_GET_VERSION: "app:getVersion",
  APP_UPDATE_AVAILABLE: "app:updateAvailable",
  APP_UPDATE_PROGRESS: "app:updateProgress",
  APP_UPDATE_DOWNLOADED: "app:updateDownloaded",
  APP_UPDATE_ERROR: "app:updateError",
  SYSTEM_OPEN_SETTINGS: "system:openSettings",

  // Guardrails
  GUARDRAIL_GET_SETTINGS: "guardrail:getSettings",
  GUARDRAIL_SAVE_SETTINGS: "guardrail:saveSettings",
  GUARDRAIL_GET_DEFAULTS: "guardrail:getDefaults",

  // Permissions
  PERMISSIONS_GET_SETTINGS: "permissions:getSettings",
  PERMISSIONS_SAVE_SETTINGS: "permissions:saveSettings",
  PERMISSIONS_GET_WORKSPACE_RULES: "permissions:getWorkspaceRules",
  PERMISSIONS_DELETE_WORKSPACE_RULE: "permissions:deleteWorkspaceRule",

  // Appearance
  APPEARANCE_GET_SETTINGS: "appearance:getSettings",
  APPEARANCE_SAVE_SETTINGS: "appearance:saveSettings",
  APPEARANCE_GET_RUNTIME_INFO: "appearance:getRuntimeInfo",

  // Agent Personality
  PERSONALITY_GET_SETTINGS: "personality:getSettings",
  PERSONALITY_SAVE_SETTINGS: "personality:saveSettings",
  PERSONALITY_GET_DEFINITIONS: "personality:getDefinitions",
  PERSONALITY_GET_PERSONAS: "personality:getPersonas",
  PERSONALITY_GET_RELATIONSHIP_STATS: "personality:getRelationshipStats",
  PERSONALITY_SET_ACTIVE: "personality:setActive",
  PERSONALITY_SET_PERSONA: "personality:setPersona",
  PERSONALITY_RESET: "personality:reset",
  PERSONALITY_SETTINGS_CHANGED: "personality:settingsChanged", // Event sent to UI when settings change
  PERSONALITY_EXPORT: "personality:export",
  PERSONALITY_IMPORT: "personality:import",
  PERSONALITY_PREVIEW: "personality:preview",
  PERSONALITY_GET_TRAIT_PRESETS: "personality:getTraitPresets",
  PERSONALITY_GET_CONFIG_V2: "personality:getConfigV2",
  PERSONALITY_SAVE_CONFIG_V2: "personality:saveConfigV2",

  // Task Queue
  QUEUE_GET_STATUS: "queue:getStatus",
  QUEUE_GET_SETTINGS: "queue:getSettings",
  QUEUE_SAVE_SETTINGS: "queue:saveSettings",
  QUEUE_CLEAR: "queue:clear",
  QUEUE_UPDATE: "queue:update",

  // MCP (Model Context Protocol)
  MCP_GET_SETTINGS: "mcp:getSettings",
  MCP_SAVE_SETTINGS: "mcp:saveSettings",
  MCP_GET_SERVERS: "mcp:getServers",
  MCP_ADD_SERVER: "mcp:addServer",
  MCP_UPDATE_SERVER: "mcp:updateServer",
  MCP_REMOVE_SERVER: "mcp:removeServer",
  MCP_CONNECT_SERVER: "mcp:connectServer",
  MCP_DISCONNECT_SERVER: "mcp:disconnectServer",
  MCP_GET_STATUS: "mcp:getStatus",
  MCP_GET_SERVER_STATUS: "mcp:getServerStatus",
  MCP_GET_SERVER_TOOLS: "mcp:getServerTools",
  MCP_GET_ALL_TOOLS: "mcp:getAllTools",
  MCP_TEST_SERVER: "mcp:testServer",

  // MCP Registry
  MCP_REGISTRY_FETCH: "mcp:registryFetch",
  MCP_REGISTRY_SEARCH: "mcp:registrySearch",
  MCP_REGISTRY_INSTALL: "mcp:registryInstall",
  MCP_REGISTRY_UNINSTALL: "mcp:registryUninstall",
  MCP_REGISTRY_CHECK_UPDATES: "mcp:registryCheckUpdates",
  MCP_REGISTRY_UPDATE_SERVER: "mcp:registryUpdateServer",

  // MCP Connector OAuth
  MCP_CONNECTOR_OAUTH_START: "mcp:connectorOAuthStart",

  // MCP Host
  MCP_HOST_START: "mcp:hostStart",
  MCP_HOST_STOP: "mcp:hostStop",
  MCP_HOST_GET_STATUS: "mcp:hostGetStatus",

  // MCP Events
  MCP_SERVER_STATUS_CHANGE: "mcp:serverStatusChange",

  // Infrastructure
  INFRA_GET_STATUS: "infra:getStatus",
  INFRA_GET_SETTINGS: "infra:getSettings",
  INFRA_SAVE_SETTINGS: "infra:saveSettings",
  INFRA_SETUP: "infra:setup",
  INFRA_GET_WALLET: "infra:getWallet",
  INFRA_WALLET_RESTORE: "infra:walletRestore",
  INFRA_WALLET_VERIFY: "infra:walletVerify",
  INFRA_RESET: "infra:reset",
  INFRA_STATUS_CHANGE: "infra:statusChange",

  // Scraping (Scrapling integration)
  SCRAPING_GET_SETTINGS: "scraping:getSettings",
  SCRAPING_SAVE_SETTINGS: "scraping:saveSettings",
  SCRAPING_GET_STATUS: "scraping:getStatus",
  SCRAPING_RESET: "scraping:reset",

  // Artifact Reputation
  REPUTATION_GET_SETTINGS: "reputation:getSettings",
  REPUTATION_SAVE_SETTINGS: "reputation:saveSettings",
  REPUTATION_LIST_MCP: "reputation:listMcp",
  REPUTATION_RESCAN_MCP: "reputation:rescanMcp",

  // Built-in Tools Settings
  BUILTIN_TOOLS_GET_SETTINGS: "builtinTools:getSettings",
  BUILTIN_TOOLS_SAVE_SETTINGS: "builtinTools:saveSettings",
  BUILTIN_TOOLS_GET_CATEGORIES: "builtinTools:getCategories",

  // Chronicle (desktop passive screen context)
  CHRONICLE_GET_SETTINGS: "chronicle:getSettings",
  CHRONICLE_SAVE_SETTINGS: "chronicle:saveSettings",
  CHRONICLE_GET_STATUS: "chronicle:getStatus",
  CHRONICLE_QUERY_RECENT_CONTEXT: "chronicle:queryRecentContext",
  CHRONICLE_LIST_OBSERVATIONS: "chronicle:listObservations",
  CHRONICLE_DELETE_OBSERVATION: "chronicle:deleteObservation",
  CHRONICLE_CLEAR_OBSERVATIONS: "chronicle:clearObservations",

  // Computer use (desktop automation session)
  COMPUTER_USE_GET_STATUS: "computerUse:getStatus",
  COMPUTER_USE_END_SESSION: "computerUse:endSession",
  COMPUTER_USE_OPEN_ACCESSIBILITY: "computerUse:openAccessibility",
  COMPUTER_USE_OPEN_SCREEN_RECORDING: "computerUse:openScreenRecording",
  COMPUTER_USE_EVENT: "computerUse:event",

  // Tray (Menu Bar)
  TRAY_GET_SETTINGS: "tray:getSettings",
  TRAY_SAVE_SETTINGS: "tray:saveSettings",
  TRAY_NEW_TASK: "tray:newTask",
  TRAY_SELECT_WORKSPACE: "tray:selectWorkspace",
  TRAY_OPEN_SETTINGS: "tray:openSettings",
  TRAY_OPEN_ABOUT: "tray:openAbout",
  TRAY_CHECK_UPDATES: "tray:checkUpdates",
  TRAY_QUICK_TASK: "tray:quick-task",
  QUICK_INPUT_SUBMIT: "quick-input:submit",
  QUICK_INPUT_CLOSE: "quick-input:close",

  // Cron (Scheduled Tasks)
  CRON_GET_STATUS: "cron:getStatus",
  CRON_LIST_JOBS: "cron:listJobs",
  CRON_GET_JOB: "cron:getJob",
  CRON_GET_RUN_HISTORY: "cron:getRunHistory",
  CRON_CLEAR_RUN_HISTORY: "cron:clearRunHistory",
  CRON_GET_WEBHOOK_STATUS: "cron:getWebhookStatus",
  CRON_ADD_JOB: "cron:addJob",
  CRON_UPDATE_JOB: "cron:updateJob",
  CRON_REMOVE_JOB: "cron:removeJob",
  CRON_RUN_JOB: "cron:runJob",
  CRON_EVENT: "cron:event",

  // Notifications
  NOTIFICATION_LIST: "notification:list",
  NOTIFICATION_ADD: "notification:add",
  NOTIFICATION_UNREAD_COUNT: "notification:unreadCount",
  NOTIFICATION_MARK_READ: "notification:markRead",
  NOTIFICATION_MARK_ALL_READ: "notification:markAllRead",
  NOTIFICATION_DELETE: "notification:delete",
  NOTIFICATION_DELETE_ALL: "notification:deleteAll",
  NOTIFICATION_EVENT: "notification:event",
  NAVIGATE_TO_TASK: "navigate-to-task",

  // Hooks (Webhooks & Gmail Pub/Sub)
  HOOKS_GET_SETTINGS: "hooks:getSettings",
  HOOKS_SAVE_SETTINGS: "hooks:saveSettings",
  HOOKS_ENABLE: "hooks:enable",
  HOOKS_DISABLE: "hooks:disable",
  HOOKS_REGENERATE_TOKEN: "hooks:regenerateToken",
  HOOKS_GET_STATUS: "hooks:getStatus",
  HOOKS_ADD_MAPPING: "hooks:addMapping",
  HOOKS_REMOVE_MAPPING: "hooks:removeMapping",
  HOOKS_CONFIGURE_GMAIL: "hooks:configureGmail",
  HOOKS_GET_GMAIL_STATUS: "hooks:getGmailStatus",
  HOOKS_START_GMAIL_WATCHER: "hooks:startGmailWatcher",
  HOOKS_STOP_GMAIL_WATCHER: "hooks:stopGmailWatcher",
  HOOKS_EVENT: "hooks:event",

  // Control Plane (WebSocket Gateway)
  CONTROL_PLANE_GET_SETTINGS: "controlPlane:getSettings",
  CONTROL_PLANE_SAVE_SETTINGS: "controlPlane:saveSettings",
  CONTROL_PLANE_ENABLE: "controlPlane:enable",
  CONTROL_PLANE_DISABLE: "controlPlane:disable",
  CONTROL_PLANE_START: "controlPlane:start",
  CONTROL_PLANE_STOP: "controlPlane:stop",
  CONTROL_PLANE_GET_STATUS: "controlPlane:getStatus",
  CONTROL_PLANE_GET_TOKEN: "controlPlane:getToken",
  CONTROL_PLANE_REGENERATE_TOKEN: "controlPlane:regenerateToken",
  CONTROL_PLANE_EVENT: "controlPlane:event",

  // Agents Hub
  MANAGED_AGENT_LIST_IPC: "managedAgent:listIpc",
  MANAGED_AGENT_GET_IPC: "managedAgent:getIpc",
  MANAGED_AGENT_CREATE_IPC: "managedAgent:createIpc",
  MANAGED_AGENT_UPDATE_IPC: "managedAgent:updateIpc",
  MANAGED_AGENT_ARCHIVE_IPC: "managedAgent:archiveIpc",
  MANAGED_AGENT_PUBLISH_IPC: "managedAgent:publishIpc",
  MANAGED_AGENT_SUSPEND_IPC: "managedAgent:suspendIpc",
  MANAGED_AGENT_RUNTIME_TOOL_CATALOG_IPC: "managedAgent:runtimeToolCatalogIpc",
  MANAGED_AGENT_ROUTINE_LIST_IPC: "managedAgent:routineListIpc",
  MANAGED_AGENT_ROUTINE_CREATE_IPC: "managedAgent:routineCreateIpc",
  MANAGED_AGENT_ROUTINE_UPDATE_IPC: "managedAgent:routineUpdateIpc",
  MANAGED_AGENT_ROUTINE_DELETE_IPC: "managedAgent:routineDeleteIpc",
  MANAGED_AGENT_INSIGHTS_GET_IPC: "managedAgent:insightsGetIpc",
  MANAGED_AGENT_AUDIT_LIST_IPC: "managedAgent:auditListIpc",
  MANAGED_AGENT_SLACK_HEALTH_GET_IPC: "managedAgent:slackHealthGetIpc",
  MANAGED_AGENT_CONVERT_ROLE_IPC: "managedAgent:convertRoleIpc",
  MANAGED_AGENT_CONVERT_AUTOMATION_IPC: "managedAgent:convertAutomationIpc",
  MANAGED_ENVIRONMENT_LIST_IPC: "managedEnvironment:listIpc",
  MANAGED_ENVIRONMENT_GET_IPC: "managedEnvironment:getIpc",
  MANAGED_ENVIRONMENT_CREATE_IPC: "managedEnvironment:createIpc",
  MANAGED_ENVIRONMENT_UPDATE_IPC: "managedEnvironment:updateIpc",
  MANAGED_ENVIRONMENT_ARCHIVE_IPC: "managedEnvironment:archiveIpc",
  MANAGED_SESSION_LIST_IPC: "managedSession:listIpc",
  MANAGED_SESSION_GET_IPC: "managedSession:getIpc",
  MANAGED_SESSION_CREATE_IPC: "managedSession:createIpc",
  MANAGED_SESSION_RESUME_IPC: "managedSession:resumeIpc",
  MANAGED_SESSION_CANCEL_IPC: "managedSession:cancelIpc",
  MANAGED_SESSION_EVENTS_LIST_IPC: "managedSession:eventsListIpc",
  MANAGED_SESSION_WORKPAPER_GET_IPC: "managedSession:workpaperGetIpc",
  MANAGED_SESSION_GENERATE_AUDIO_SUMMARY: "managedSession:generateAudioSummary",
  AGENT_WORKSPACE_MEMBERSHIP_LIST_IPC: "agentWorkspaceMembership:listIpc",
  AGENT_WORKSPACE_MEMBERSHIP_UPDATE_IPC: "agentWorkspaceMembership:updateIpc",
  AGENT_WORKSPACE_PERMISSION_SNAPSHOT_IPC: "agentWorkspacePermission:snapshotIpc",
  AGENT_TEMPLATE_LIST: "agentTemplate:list",
  IMAGE_GEN_PROFILE_LIST: "imageGenProfile:list",
  IMAGE_GEN_PROFILE_CREATE: "imageGenProfile:create",
  IMAGE_GEN_PROFILE_UPDATE: "imageGenProfile:update",
  IMAGE_GEN_PROFILE_DELETE: "imageGenProfile:delete",

  // Tailscale Integration
  TAILSCALE_GET_STATUS: "tailscale:getStatus",
  TAILSCALE_CHECK_AVAILABILITY: "tailscale:checkAvailability",
  TAILSCALE_SET_MODE: "tailscale:setMode",

  // Remote Gateway (connecting to external Control Plane)
  REMOTE_GATEWAY_CONNECT: "remoteGateway:connect",
  REMOTE_GATEWAY_DISCONNECT: "remoteGateway:disconnect",
  REMOTE_GATEWAY_GET_STATUS: "remoteGateway:getStatus",
  REMOTE_GATEWAY_SAVE_CONFIG: "remoteGateway:saveConfig",
  REMOTE_GATEWAY_TEST_CONNECTION: "remoteGateway:testConnection",
  REMOTE_GATEWAY_EVENT: "remoteGateway:event",

  // SSH Tunnel (for Remote Gateway connection)
  SSH_TUNNEL_CONNECT: "sshTunnel:connect",
  SSH_TUNNEL_DISCONNECT: "sshTunnel:disconnect",
  SSH_TUNNEL_GET_STATUS: "sshTunnel:getStatus",
  SSH_TUNNEL_SAVE_CONFIG: "sshTunnel:saveConfig",
  SSH_TUNNEL_TEST_CONNECTION: "sshTunnel:testConnection",
  SSH_TUNNEL_EVENT: "sshTunnel:event",

  // Live Canvas (Agent-driven visual workspace)
  CANVAS_CREATE: "canvas:create",
  CANVAS_GET_SESSION: "canvas:getSession",
  CANVAS_LIST_SESSIONS: "canvas:listSessions",
  CANVAS_SHOW: "canvas:show",
  CANVAS_HIDE: "canvas:hide",
  CANVAS_CLOSE: "canvas:close",
  CANVAS_PUSH: "canvas:push",
  CANVAS_EVAL: "canvas:eval",
  CANVAS_SNAPSHOT: "canvas:snapshot",
  CANVAS_A2UI_ACTION: "canvas:a2uiAction",
  CANVAS_EVENT: "canvas:event",
  CANVAS_EXPORT_HTML: "canvas:exportHTML",
  CANVAS_EXPORT_TO_FOLDER: "canvas:exportToFolder",
  CANVAS_OPEN_IN_BROWSER: "canvas:openInBrowser",
  CANVAS_OPEN_URL: "canvas:openUrl",
  CANVAS_GET_SESSION_DIR: "canvas:getSessionDir",
  CANVAS_CHECKPOINT_SAVE: "canvas:checkpointSave",
  CANVAS_CHECKPOINT_LIST: "canvas:checkpointList",
  CANVAS_CHECKPOINT_RESTORE: "canvas:checkpointRestore",
  CANVAS_CHECKPOINT_DELETE: "canvas:checkpointDelete",
  CANVAS_GET_CONTENT: "canvas:getContent",

  // Mobile Companion Nodes
  NODE_LIST: "node:list",
  NODE_GET: "node:get",
  NODE_INVOKE: "node:invoke",
  NODE_EVENT: "node:event",

  // Device Management
  DEVICE_LIST_MANAGED: "device:listManaged",
  DEVICE_GET_SUMMARY: "device:getSummary",
  DEVICE_CONNECT: "device:connect",
  DEVICE_DISCONNECT: "device:disconnect",
  DEVICE_PROXY_REQUEST: "device:proxyRequest",
  DEVICE_LIST_TASKS: "device:listTasks",
  DEVICE_LIST_FILES: "device:listFiles",
  DEVICE_LIST_REMOTE_WORKSPACES: "device:listRemoteWorkspaces",
  DEVICE_ASSIGN_TASK: "device:assignTask",
  DEVICE_GET_PROFILES: "device:getProfiles",
  DEVICE_UPDATE_PROFILE: "device:updateProfile",

  // Memory System (Cross-Session Context)
  MEMORY_GET_SETTINGS: "memory:getSettings",
  MEMORY_SAVE_SETTINGS: "memory:saveSettings",
  MEMORY_SEARCH: "memory:search",
  MEMORY_GET_TIMELINE: "memory:getTimeline",
  MEMORY_GET_DETAILS: "memory:getDetails",
  MEMORY_GET_RECENT: "memory:getRecent",
  MEMORY_GET_STATS: "memory:getStats",
  MEMORY_CLEAR: "memory:clear",
  MEMORY_EVENT: "memory:event",
  MEMORY_IMPORT_CHATGPT: "memory:importChatGPT",
  MEMORY_IMPORT_CHATGPT_PROGRESS: "memory:importChatGPTProgress",
  MEMORY_IMPORT_CHATGPT_CANCEL: "memory:importChatGPTCancel",
  MEMORY_IMPORT_TEXT: "memory:importFromText",
  MEMORY_GET_IMPORTED_STATS: "memory:getImportedStats",
  MEMORY_FIND_IMPORTED: "memory:findImported",
  MEMORY_DELETE_IMPORTED: "memory:deleteImported",
  MEMORY_DELETE_IMPORTED_ENTRY: "memory:deleteImportedEntry",
  MEMORY_SET_IMPORTED_RECALL_IGNORED: "memory:setImportedRecallIgnored",
  MEMORY_GET_USER_PROFILE: "memory:getUserProfile",
  MEMORY_ADD_USER_FACT: "memory:addUserFact",
  MEMORY_UPDATE_USER_FACT: "memory:updateUserFact",
  MEMORY_DELETE_USER_FACT: "memory:deleteUserFact",
  MEMORY_RELATIONSHIP_LIST: "memory:relationshipList",
  MEMORY_RELATIONSHIP_UPDATE: "memory:relationshipUpdate",
  MEMORY_RELATIONSHIP_DELETE: "memory:relationshipDelete",
  MEMORY_RELATIONSHIP_CLEANUP_RECURRING: "memory:relationshipCleanupRecurring",
  MEMORY_COMMITMENTS_GET: "memory:commitmentsGet",
  MEMORY_COMMITMENTS_DUE_SOON: "memory:commitmentsDueSoon",
  AWARENESS_GET_CONFIG: "awareness:getConfig",
  AWARENESS_SAVE_CONFIG: "awareness:saveConfig",
  AWARENESS_LIST_BELIEFS: "awareness:listBeliefs",
  AWARENESS_UPDATE_BELIEF: "awareness:updateBelief",
  AWARENESS_DELETE_BELIEF: "awareness:deleteBelief",
  AWARENESS_GET_SUMMARY: "awareness:getSummary",
  AWARENESS_GET_SNAPSHOT: "awareness:getSnapshot",
  AWARENESS_LIST_EVENTS: "awareness:listEvents",
  AUTONOMY_GET_CONFIG: "autonomy:getConfig",
  AUTONOMY_SAVE_CONFIG: "autonomy:saveConfig",
  AUTONOMY_GET_STATE: "autonomy:getState",
  AUTONOMY_LIST_DECISIONS: "autonomy:listDecisions",
  AUTONOMY_LIST_ACTIONS: "autonomy:listActions",
  AUTONOMY_UPDATE_DECISION: "autonomy:updateDecision",
  AUTONOMY_TRIGGER_EVALUATION: "autonomy:triggerEvaluation",

  // Memory Features (Global Toggles)
  MEMORY_FEATURES_GET_SETTINGS: "memoryFeatures:getSettings",
  MEMORY_FEATURES_SAVE_SETTINGS: "memoryFeatures:saveSettings",
  MEMORY_FEATURES_GET_LAYER_PREVIEW: "memoryFeatures:getLayerPreview",
  SUPERMEMORY_GET_SETTINGS: "supermemory:getSettings",
  SUPERMEMORY_SAVE_SETTINGS: "supermemory:saveSettings",
  SUPERMEMORY_TEST_CONNECTION: "supermemory:testConnection",
  SUPERMEMORY_GET_STATUS: "supermemory:getStatus",

  // Migration Status (for showing one-time notifications after app rename)
  MIGRATION_GET_STATUS: "migration:getStatus",
  MIGRATION_DISMISS_NOTIFICATION: "migration:dismissNotification",

  // Extensions / Plugins
  EXTENSIONS_LIST: "extensions:list",
  EXTENSIONS_GET: "extensions:get",
  EXTENSIONS_ENABLE: "extensions:enable",
  EXTENSIONS_DISABLE: "extensions:disable",
  EXTENSIONS_RELOAD: "extensions:reload",
  EXTENSIONS_GET_CONFIG: "extensions:getConfig",
  EXTENSIONS_SET_CONFIG: "extensions:setConfig",
  EXTENSIONS_DISCOVER: "extensions:discover",

  // Webhook Tunnel
  TUNNEL_GET_STATUS: "tunnel:getStatus",
  TUNNEL_START: "tunnel:start",
  TUNNEL_STOP: "tunnel:stop",
  TUNNEL_GET_CONFIG: "tunnel:getConfig",
  TUNNEL_SET_CONFIG: "tunnel:setConfig",

  // Voice Mode (TTS/STT)
  VOICE_GET_SETTINGS: "voice:getSettings",
  VOICE_SAVE_SETTINGS: "voice:saveSettings",
  VOICE_GET_STATE: "voice:getState",
  VOICE_SPEAK: "voice:speak",
  VOICE_STOP_SPEAKING: "voice:stopSpeaking",
  VOICE_TRANSCRIBE: "voice:transcribe",
  VOICE_GET_ELEVENLABS_VOICES: "voice:getElevenLabsVoices",
  VOICE_TEST_ELEVENLABS: "voice:testElevenLabs",
  VOICE_TEST_OPENAI: "voice:testOpenAI",
  VOICE_TEST_AZURE: "voice:testAzure",
  VOICE_EVENT: "voice:event",

  // Git Worktree operations
  WORKTREE_GET_INFO: "worktree:getInfo",
  WORKTREE_LIST: "worktree:list",
  WORKTREE_MERGE: "worktree:merge",
  WORKTREE_CLEANUP: "worktree:cleanup",
  WORKTREE_GET_DIFF: "worktree:getDiff",
  WORKTREE_GET_SETTINGS: "worktree:getSettings",
  WORKTREE_SAVE_SETTINGS: "worktree:saveSettings",

  // Agent Comparison mode
  COMPARISON_CREATE: "comparison:create",
  COMPARISON_GET: "comparison:get",
  COMPARISON_LIST: "comparison:list",
  COMPARISON_CANCEL: "comparison:cancel",
  COMPARISON_GET_RESULT: "comparison:getResult",
  // Usage Insights
  USAGE_INSIGHTS_GET: "usageInsights:get",
  USAGE_INSIGHTS_EARLIEST: "usageInsights:earliest",
  // Daily Briefing
  DAILY_BRIEFING_GENERATE: "dailyBriefing:generate",
  // Proactive Suggestions
  SUGGESTIONS_LIST: "suggestions:list",
  SUGGESTIONS_LIST_FOR_WORKSPACES: "suggestions:listForWorkspaces",
  SUGGESTIONS_REFRESH: "suggestions:refresh",
  SUGGESTIONS_REFRESH_FOR_WORKSPACES: "suggestions:refreshForWorkspaces",
  SUGGESTIONS_DISMISS: "suggestions:dismiss",
  SUGGESTIONS_SNOOZE: "suggestions:snooze",
  SUGGESTIONS_EDIT: "suggestions:edit",
  SUGGESTIONS_ACT: "suggestions:act",

  // Self-improvement loop
  IMPROVEMENT_GET_SETTINGS: "improvement:getSettings",
  IMPROVEMENT_GET_ELIGIBILITY: "improvement:getEligibility",
  IMPROVEMENT_SAVE_OWNER_ENROLLMENT: "improvement:saveOwnerEnrollment",
  IMPROVEMENT_CLEAR_OWNER_ENROLLMENT: "improvement:clearOwnerEnrollment",
  IMPROVEMENT_SAVE_SETTINGS: "improvement:saveSettings",
  IMPROVEMENT_LIST_CANDIDATES: "improvement:listCandidates",
  IMPROVEMENT_LIST_RUNS: "improvement:listRuns",
  IMPROVEMENT_REFRESH: "improvement:refresh",
  IMPROVEMENT_RUN_NEXT: "improvement:runNext",
  IMPROVEMENT_RETRY_RUN: "improvement:retryRun",
  IMPROVEMENT_DISMISS_CANDIDATE: "improvement:dismissCandidate",
  IMPROVEMENT_REVIEW_RUN: "improvement:reviewRun",
  IMPROVEMENT_RESET_HISTORY: "improvement:resetHistory",

  // Subconscious loop
  SUBCONSCIOUS_GET_SETTINGS: "subconscious:getSettings",
  SUBCONSCIOUS_SAVE_SETTINGS: "subconscious:saveSettings",
  SUBCONSCIOUS_GET_BRAIN: "subconscious:getBrain",
  SUBCONSCIOUS_LIST_TARGETS: "subconscious:listTargets",
  SUBCONSCIOUS_LIST_RUNS: "subconscious:listRuns",
  SUBCONSCIOUS_GET_TARGET_DETAIL: "subconscious:getTargetDetail",
  SUBCONSCIOUS_REFRESH: "subconscious:refresh",
  SUBCONSCIOUS_RUN_NOW: "subconscious:runNow",
  SUBCONSCIOUS_RETRY_RUN: "subconscious:retryRun",
  SUBCONSCIOUS_REVIEW_RUN: "subconscious:reviewRun",
  SUBCONSCIOUS_DISMISS_TARGET: "subconscious:dismissTarget",
  SUBCONSCIOUS_RESET_HISTORY: "subconscious:resetHistory",
  WHATSAPP_GET_INFO: "whatsapp:get-info",
  WHATSAPP_LOGOUT: "whatsapp:logout",

  // Citation Engine
  CITATION_GET_FOR_TASK: "citation:getForTask",

  // Event Triggers
  TRIGGER_LIST: "trigger:list",
  TRIGGER_ADD: "trigger:add",
  TRIGGER_UPDATE: "trigger:update",
  TRIGGER_REMOVE: "trigger:remove",
  TRIGGER_HISTORY: "trigger:history",

  // Routines
  ROUTINE_LIST: "routine:list",
  ROUTINE_GET: "routine:get",
  ROUTINE_LIST_RUNS: "routine:listRuns",
  ROUTINE_CREATE: "routine:create",
  ROUTINE_UPDATE: "routine:update",
  ROUTINE_REMOVE: "routine:remove",
  ROUTINE_RUN_NOW: "routine:runNow",
  ROUTINE_REGENERATE_API_TOKEN: "routine:regenerateApiToken",

  // Mailbox Automations
  MAILBOX_AUTOMATION_LIST: "mailboxAutomation:list",
  MAILBOX_AUTOMATION_LIST_THREAD: "mailboxAutomation:listThread",
  MAILBOX_AUTOMATION_CREATE_RULE: "mailboxAutomation:createRule",
  MAILBOX_AUTOMATION_UPDATE_RULE: "mailboxAutomation:updateRule",
  MAILBOX_AUTOMATION_DELETE_RULE: "mailboxAutomation:deleteRule",
  MAILBOX_AUTOMATION_CREATE_SCHEDULE: "mailboxAutomation:createSchedule",
  MAILBOX_AUTOMATION_UPDATE_SCHEDULE: "mailboxAutomation:updateSchedule",
  MAILBOX_AUTOMATION_DELETE_SCHEDULE: "mailboxAutomation:deleteSchedule",
  MAILBOX_AUTOMATION_CREATE_FORWARD: "mailboxAutomation:createForward",
  MAILBOX_AUTOMATION_UPDATE_FORWARD: "mailboxAutomation:updateForward",
  MAILBOX_AUTOMATION_DELETE_FORWARD: "mailboxAutomation:deleteForward",
  MAILBOX_AUTOMATION_RUN_FORWARD: "mailboxAutomation:runForward",

  // Daily Briefing (extended)
  BRIEFING_GET_LATEST: "briefing:getLatest",
  BRIEFING_GET_CONFIG: "briefing:getConfig",
  BRIEFING_SAVE_CONFIG: "briefing:saveConfig",

  // File Hub
  FILEHUB_LIST: "filehub:list",
  FILEHUB_SEARCH: "filehub:search",
  FILEHUB_RECENT: "filehub:recent",
  FILEHUB_SOURCES: "filehub:sources",

  // Web Access
  WEBACCESS_GET_SETTINGS: "webaccess:getSettings",
  WEBACCESS_SAVE_SETTINGS: "webaccess:saveSettings",
  WEBACCESS_GET_STATUS: "webaccess:getStatus",

  // Playwright QA (Automated Visual Testing)
  QA_GET_RUNS: "qa:getRuns",
  QA_GET_RUN: "qa:getRun",
  QA_START_RUN: "qa:startRun",
  QA_STOP_RUN: "qa:stopRun",
  QA_EVENT: "qa:event",
} as const;

// LLM Provider types
export const BUILTIN_LLM_PROVIDER_TYPES = [
  "anthropic",
  "bedrock",
  "ollama",
  "gemini",
  "openrouter",
  "openai",
  "azure",
  "azure-anthropic",
  "groq",
  "xai",
  "kimi",
  "pi",
  "openai-compatible",
] as const;

export const CUSTOM_LLM_PROVIDER_TYPES = [
  "moonshot",
  "opencode",
  "google-vertex",
  "google-antigravity",
  "google-gemini-cli",
  "zai",
  "glm",
  "vercel-ai-gateway",
  "cerebras",
  "mistral",
  "github-copilot",
  "qwen-portal",
  "minimax",
  "minimax-portal",
  "xiaomi",
  "venice",
  "synthetic",
  "kimi-code",
  "kimi-coding",
  "anthropic-compatible",
  "hf-agents",
] as const;

export const LLM_PROVIDER_TYPES = [
  ...BUILTIN_LLM_PROVIDER_TYPES,
  ...CUSTOM_LLM_PROVIDER_TYPES,
] as const;

export type LLMProviderType = (typeof LLM_PROVIDER_TYPES)[number];

/** Display names for LLM providers (used in multi-LLM mode UI) */
export const MULTI_LLM_PROVIDER_DISPLAY: Record<
  string,
  { name: string; icon: string; color: string }
> = {
  anthropic: { name: "Claude", icon: "\u{1F9E0}", color: "#d97706" },
  bedrock: { name: "Bedrock", icon: "\u{2601}\uFE0F", color: "#ff9900" },
  ollama: { name: "Ollama", icon: "\u{1F999}", color: "#0ea5e9" },
  gemini: { name: "Gemini", icon: "\u{2728}", color: "#6366f1" },
  openrouter: { name: "OpenRouter", icon: "\u{1F310}", color: "#8b5cf6" },
  openai: { name: "OpenAI", icon: "\u{1F916}", color: "#10b981" },
  azure: { name: "Azure OpenAI", icon: "\u{1F7E6}", color: "#0078d4" },
  "azure-anthropic": {
    name: "Azure Anthropic",
    icon: "\u{1F7E6}",
    color: "#0078d4",
  },
  groq: { name: "Groq", icon: "\u{26A1}", color: "#f97316" },
  xai: { name: "xAI", icon: "\u{1F4A0}", color: "#ef4444" },
  kimi: { name: "Kimi", icon: "\u{1F319}", color: "#a855f7" },
  pi: { name: "Pi", icon: "\u{1F7E3}", color: "#ec4899" },
  "openai-compatible": {
    name: "OpenAI-Compatible",
    icon: "\u{1F517}",
    color: "#64748b",
  },
};

export interface CachedModelInfo {
  key: string;
  displayName: string;
  description: string;
  contextLength?: number; // For OpenRouter models
  size?: number; // For Ollama models (in bytes)
  reasoningEfforts?: LLMReasoningEffort[];
}

export interface CustomProviderConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  cachedModels?: CachedModelInfo[];
  fallbackProviders?: LLMProviderFallbackConfig[];
  failoverPrimaryRetryCooldownSeconds?: number;
  profileRoutingEnabled?: boolean;
  strongModelKey?: string;
  cheapModelKey?: string;
  automatedTaskModelKey?: string;
  preferStrongForVerification?: boolean;
  reasoningEffort?: LLMReasoningEffort;
}

export interface ProviderFailoverSettings {
  fallbackProviders?: LLMProviderFallbackConfig[];
  failoverPrimaryRetryCooldownSeconds?: number;
}

export interface ProviderRoutingSettings {
  // Failover settings are per-provider as well so primary routes can diverge.
  fallbackProviders?: LLMProviderFallbackConfig[];
  failoverPrimaryRetryCooldownSeconds?: number;
  profileRoutingEnabled?: boolean;
  strongModelKey?: string;
  cheapModelKey?: string;
  /** Optional dedicated model for automated tasks (cron, improvement, heartbeat). When set, overrides cheap model for these tasks. */
  automatedTaskModelKey?: string;
  preferStrongForVerification?: boolean;
  reasoningEffort?: LLMReasoningEffort;
}

export interface LLMProviderFallbackConfig {
  providerType: LLMProviderType;
  modelKey?: string;
}

export type LLMReasoningEffort = "low" | "medium" | "high" | "extra_high";
export type AzureReasoningEffort = LLMReasoningEffort;

export type PromptCacheSurface =
  | "executor"
  | "followUps"
  | "chatMode"
  | "sideCalls";

export interface PromptCachingSettings {
  mode?: "auto" | "off";
  ttl?: "5m" | "1h";
  openRouterClaudeStrategy?: "explicit_system_and_3";
  strictStablePrefix?: boolean;
  surfaceCoverage?: {
    executor?: boolean;
    followUps?: boolean;
    chatMode?: boolean;
    sideCalls?: boolean;
  };
}

export interface LLMSettingsData {
  providerType: LLMProviderType;
  modelKey: string;
  fallbackProviders?: LLMProviderFallbackConfig[];
  failoverPrimaryRetryCooldownSeconds?: number;
  promptCaching?: PromptCachingSettings;
  anthropic?: {
    apiKey?: string;
    subscriptionToken?: string;
    authMethod?: "api_key" | "subscription";
  } & ProviderRoutingSettings;
  bedrock?: {
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    profile?: string;
    useDefaultCredentials?: boolean;
    model?: string;
  } & ProviderRoutingSettings;
  ollama?: {
    baseUrl?: string;
    model?: string;
    apiKey?: string; // Optional, for remote Ollama servers
  } & ProviderRoutingSettings;
  gemini?: {
    apiKey?: string;
    model?: string;
  } & ProviderRoutingSettings;
  openrouter?: {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  } & ProviderRoutingSettings;
  openai?: {
    apiKey?: string;
    model?: string;
    // OAuth tokens (alternative to API key)
    accessToken?: string;
    refreshToken?: string;
    tokenExpiresAt?: number;
    authMethod?: "api_key" | "oauth";
  } & ProviderRoutingSettings;
  azure?: {
    apiKey?: string;
    endpoint?: string;
    deployment?: string;
    deployments?: string[];
    apiVersion?: string;
    reasoningEffort?: AzureReasoningEffort;
  } & ProviderRoutingSettings;
  azureAnthropic?: {
    apiKey?: string;
    endpoint?: string;
    deployment?: string;
    deployments?: string[];
    apiVersion?: string;
  } & ProviderRoutingSettings;
  groq?: {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  } & ProviderRoutingSettings;
  xai?: {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  } & ProviderRoutingSettings;
  kimi?: {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  } & ProviderRoutingSettings;
  pi?: {
    provider?: string; // pi-ai KnownProvider (e.g. 'anthropic', 'openai', 'google')
    apiKey?: string;
    model?: string;
  } & ProviderRoutingSettings;
  openaiCompatible?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  } & ProviderRoutingSettings;
  hfAgents?: {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  } & ProviderRoutingSettings;
  /** Text-to-image model selection. Default tried first; backup used on failure. */
  imageGeneration?: {
    /** Primary provider route. Leave unset for automatic provider selection. */
    defaultProvider?: "openai" | "openai-codex" | "azure" | "openrouter" | "gemini";
    /** Primary model: GPT Image (OpenAI/Azure/OpenRouter) or nano-banana-2 (Gemini) */
    defaultModel?: "gpt-image-2" | "gpt-image-1.5" | "nano-banana-2";
    /** Fallback provider route. Leave unset for automatic provider fallback. */
    backupProvider?: "openai" | "openai-codex" | "azure" | "openrouter" | "gemini";
    /** Fallback model when default fails */
    backupModel?: "gpt-image-2" | "gpt-image-1.5" | "nano-banana-2";
    /** Provider attempt timeouts in seconds. Defaults to 300 seconds per provider. */
    timeouts?: {
      openai?: number;
      openaiCodex?: number;
      azure?: number;
      openrouter?: number;
      gemini?: number;
    };
    openai?: {
      apiKey?: string;
      model?: string;
    };
    azure?: {
      /** Dedicated API key for image generation (overrides the main Azure chat API key if set) */
      imageApiKey?: string;
      /** Dedicated endpoint for image generation (overrides the main Azure chat endpoint if set) */
      imageEndpoint?: string;
      imageDeployment?: string;
      imageApiVersion?: string;
    };
    gemini?: {
      apiKey?: string;
      model?: "nano-banana-2";
    };
    openrouter?: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
    };
    openaiCodex?: {
      model?: string;
    };
  };
  /** Text-to-video generation settings. Provider-specific config + routing. */
  videoGeneration?: {
    defaultProvider?: "openai" | "azure" | "gemini" | "vertex" | "kling";
    fallbackProvider?: "openai" | "azure" | "gemini" | "vertex" | "kling";
    openai?: {
      defaultModel?: string;
      defaultDuration?: number;
      defaultAspectRatio?: "16:9" | "9:16" | "1:1";
      defaultResolution?: "480p" | "720p" | "1080p";
    };
    azure?: {
      /** Dedicated API key for video (overrides the main Azure chat API key if set) */
      videoApiKey?: string;
      /** Dedicated endpoint for video (overrides the main Azure chat endpoint if set) */
      videoEndpoint?: string;
      videoDeployment?: string;
      videoApiVersion?: string;
      defaultDuration?: number;
      defaultAspectRatio?: "16:9" | "9:16" | "1:1";
      defaultResolution?: "480p" | "720p" | "1080p";
    };
    gemini?: {
      defaultModel?: "veo-3.1" | "veo-3.1-fast-preview" | "veo-3.0";
      defaultDuration?: number;
      defaultAspectRatio?: "16:9" | "9:16" | "1:1";
    };
    vertex?: {
      model?: "veo-3" | "veo-3.1";
      projectId?: string;
      location?: string;
      outputGcsUri?: string;
      accessToken?: string;
      defaultDuration?: number;
      defaultAspectRatio?: "16:9" | "9:16" | "1:1";
    };
    kling?: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      defaultDuration?: number;
      defaultAspectRatio?: "16:9" | "9:16" | "1:1";
    };
  };
  // Cached models from API (populated when user refreshes)
  cachedAnthropicModels?: CachedModelInfo[];
  cachedGeminiModels?: CachedModelInfo[];
  cachedOpenRouterModels?: CachedModelInfo[];
  cachedOllamaModels?: CachedModelInfo[];
  cachedBedrockModels?: CachedModelInfo[];
  cachedOpenAIModels?: CachedModelInfo[];
  cachedGroqModels?: CachedModelInfo[];
  cachedXaiModels?: CachedModelInfo[];
  cachedKimiModels?: CachedModelInfo[];
  cachedPiModels?: CachedModelInfo[];
  cachedOpenAICompatibleModels?: CachedModelInfo[];
  customProviders?: Record<string, CustomProviderConfig>;
}

export interface LLMProviderInfo {
  type: LLMProviderType;
  name: string;
  configured: boolean;
}

export interface LLMModelInfo {
  key: string;
  displayName: string;
  description: string;
  reasoningEfforts?: LLMReasoningEffort[];
}

export interface LLMConfigStatus {
  currentProvider: LLMProviderType;
  currentModel: string;
  currentReasoningEffort?: LLMReasoningEffort;
  providers: LLMProviderInfo[];
  models: LLMModelInfo[];
  routing?: LLMRoutingRuntimeState;
}

// Gateway / Channel types
export type ChannelType =
  | "telegram"
  | "discord"
  | "slack"
  | "whatsapp"
  | "imessage"
  | "signal"
  | "mattermost"
  | "matrix"
  | "twitch"
  | "line"
  | "bluebubbles"
  | "email"
  | "teams"
  | "googlechat"
  | "feishu"
  | "wecom"
  | "x";
export type ChannelStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";
export type SecurityMode = "open" | "allowlist" | "pairing";

/**
 * Context type for channel messages (DM vs group chat)
 */
export type ContextType = "dm" | "group";

/**
 * Per-context security policy
 * Allows different security modes for DMs vs group chats
 */
export interface ContextPolicy {
  id: string;
  channelId: string;
  contextType: ContextType;
  securityMode: SecurityMode;
  /** Tool groups to deny in this context (e.g., 'group:memory') */
  toolRestrictions?: string[];
  createdAt: number;
  updatedAt: number;
}

/**
 * Channel security configuration with per-context policies
 */
export interface ChannelSecurityConfig {
  /** Default security mode (applies if no context policy exists) */
  mode: SecurityMode;
  /** Allowed users for allowlist mode */
  allowedUsers?: string[];
  /** Pairing code TTL in seconds */
  pairingCodeTTL?: number;
  /** Max pairing attempts before lockout */
  maxPairingAttempts?: number;
  /** Rate limit for messages per minute */
  rateLimitPerMinute?: number;
  /** Per-context security policies */
  contextPolicies?: {
    dm?: Partial<ContextPolicy>;
    group?: Partial<ContextPolicy>;
  };
}

export interface ChannelData {
  id: string;
  type: ChannelType;
  name: string;
  enabled: boolean;
  status: ChannelStatus;
  botUsername?: string;
  configReadError?: string;
  securityMode: SecurityMode;
  createdAt: number;
  config?: {
    selfChatMode?: boolean;
    supervisor?: DiscordSupervisorConfig;
    progressRelayMode?: "minimal" | "curated";
    groupRoutingMode?:
      | "all"
      | "mentionsOnly"
      | "mentionsOrCommands"
      | "commandsOnly";
    trustedGroupMemoryOptIn?: boolean;
    sendReadReceipts?: boolean;
    deduplicationEnabled?: boolean;
    responsePrefix?: string;
    ingestNonSelfChatsInSelfChatMode?: boolean;
    [key: string]: unknown;
  };
}

export interface ChannelUserData {
  id: string;
  channelId: string;
  channelUserId: string;
  displayName: string;
  username?: string;
  allowed: boolean;
  lastSeenAt: number;
}

export interface AddChannelRequest {
  type: ChannelType;
  name: string;
  botToken?: string;
  securityMode?: SecurityMode;
  discordSupervisor?: Partial<DiscordSupervisorConfig>;
  /**
   * Ambient inbox options (stored in channel config).
   * - ambientMode: log messages but only process explicit commands (messages starting with '/')
   * - silentUnauthorized: do not send "pairing required" / "unauthorized" replies
   */
  ambientMode?: boolean;
  silentUnauthorized?: boolean;
  // Discord-specific fields
  applicationId?: string;
  guildIds?: string[];
  // Slack-specific fields
  appToken?: string;
  signingSecret?: string;
  progressRelayMode?: "minimal" | "curated";
  // WhatsApp-specific fields
  allowedNumbers?: string[];
  selfChatMode?: boolean;
  groupRoutingMode?:
    | "all"
    | "mentionsOnly"
    | "mentionsOrCommands"
    | "commandsOnly";
  telegramAllowedGroupChatIds?: string[];
  trustedGroupMemoryOptIn?: boolean;
  sendReadReceipts?: boolean;
  deduplicationEnabled?: boolean;
  responsePrefix?: string;
  ingestNonSelfChatsInSelfChatMode?: boolean;
  // iMessage-specific fields
  cliPath?: string;
  dbPath?: string;
  dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
  groupPolicy?: "open" | "allowlist" | "disabled";
  allowedContacts?: string[];
  captureSelfMessages?: boolean;
  // Signal-specific fields
  phoneNumber?: string;
  dataDir?: string;
  mode?: "native" | "daemon";
  trustMode?: "tofu" | "always" | "manual";
  sendTypingIndicators?: boolean;
  // Mattermost-specific fields
  mattermostServerUrl?: string;
  mattermostToken?: string;
  mattermostTeamId?: string;
  // Matrix-specific fields
  matrixHomeserver?: string;
  matrixUserId?: string;
  matrixAccessToken?: string;
  matrixDeviceId?: string;
  matrixRoomIds?: string[];
  // Twitch-specific fields
  twitchUsername?: string;
  twitchOauthToken?: string;
  twitchChannels?: string[];
  twitchAllowWhispers?: boolean;
  // LINE-specific fields
  lineChannelAccessToken?: string;
  lineChannelSecret?: string;
  lineWebhookPort?: number;
  lineWebhookPath?: string;
  // BlueBubbles-specific fields
  blueBubblesServerUrl?: string;
  blueBubblesPassword?: string;
  blueBubblesWebhookPort?: number;
  blueBubblesAllowedContacts?: string[];
  // Email-specific fields
  emailProtocol?: "imap-smtp" | "loom";
  emailAuthMethod?: "password" | "oauth";
  emailOauthProvider?: "microsoft";
  emailOauthClientId?: string;
  emailOauthClientSecret?: string;
  emailOauthTenant?: string;
  emailAccessToken?: string;
  emailRefreshToken?: string;
  emailTokenExpiresAt?: number;
  emailScopes?: string[];
  emailAddress?: string;
  emailPassword?: string;
  emailImapHost?: string;
  emailImapPort?: number;
  emailSmtpHost?: string;
  emailSmtpPort?: number;
  emailDisplayName?: string;
  emailAllowedSenders?: string[];
  emailSubjectFilter?: string;
  emailLoomBaseUrl?: string;
  emailLoomAccessToken?: string;
  emailLoomIdentity?: string;
  emailLoomMailboxFolder?: string;
  emailLoomPollInterval?: number;
  // Teams-specific fields
  appId?: string;
  appPassword?: string;
  tenantId?: string;
  webhookPort?: number;
  // Google Chat-specific fields
  serviceAccountKeyPath?: string;
  projectId?: string;
  webhookPath?: string;
  // Feishu-specific fields
  feishuAppId?: string;
  feishuAppSecret?: string;
  feishuVerificationToken?: string;
  feishuEncryptKey?: string;
  // WeCom-specific fields
  wecomCorpId?: string;
  wecomAgentId?: number;
  wecomSecret?: string;
  wecomToken?: string;
  wecomEncodingAESKey?: string;
  // X-specific fields
  xCommandPrefix?: string;
  xAllowedAuthors?: string[];
  xPollIntervalSec?: number;
  xFetchCount?: number;
  xOutboundEnabled?: boolean;
}

export interface UpdateChannelRequest {
  id: string;
  name?: string;
  securityMode?: SecurityMode;
  config?: {
    selfChatMode?: boolean;
    supervisor?: DiscordSupervisorConfig;
    progressRelayMode?: "minimal" | "curated";
    groupRoutingMode?:
      | "all"
      | "mentionsOnly"
      | "mentionsOrCommands"
      | "commandsOnly";
    trustedGroupMemoryOptIn?: boolean;
    sendReadReceipts?: boolean;
    deduplicationEnabled?: boolean;
    responsePrefix?: string;
    ingestNonSelfChatsInSelfChatMode?: boolean;
    [key: string]: unknown;
  };
}

export interface TestChannelResult {
  success: boolean;
  error?: string;
  botUsername?: string;
}

// Extension / Plugin types
export type ExtensionType = "channel" | "tool" | "provider" | "integration";
export type ExtensionState =
  | "loading"
  | "loaded"
  | "registered"
  | "active"
  | "error"
  | "disabled";

export interface ExtensionCapabilities {
  sendMessage?: boolean;
  receiveMessage?: boolean;
  attachments?: boolean;
  reactions?: boolean;
  inlineKeyboards?: boolean;
  groups?: boolean;
  threads?: boolean;
  webhooks?: boolean;
  e2eEncryption?: boolean;
}

export interface ExtensionData {
  name: string;
  displayName: string;
  version: string;
  description: string;
  author?: string;
  type: ExtensionType;
  state: ExtensionState;
  path: string;
  loadedAt: number;
  error?: string;
  capabilities?: ExtensionCapabilities;
  configSchema?: Record<string, unknown>;
}

export interface ExtensionConfig {
  [key: string]: unknown;
}

// Webhook Tunnel types
export type TunnelProvider =
  | "ngrok"
  | "tailscale"
  | "cloudflare"
  | "localtunnel";
export type TunnelStatus = "stopped" | "starting" | "running" | "error";

export interface TunnelConfig {
  provider: TunnelProvider;
  port: number;
  host?: string;
  ngrokAuthToken?: string;
  ngrokRegion?: "us" | "eu" | "ap" | "au" | "sa" | "jp" | "in";
  ngrokSubdomain?: string;
  tailscaleHostname?: string;
  cloudflareTunnelName?: string;
  autoStart?: boolean;
}

export interface TunnelStatusData {
  status: TunnelStatus;
  provider?: TunnelProvider;
  url?: string;
  error?: string;
  startedAt?: number;
}

// Search Provider types
export type SearchProviderType =
  | "tavily"
  | "exa"
  | "brave"
  | "serpapi"
  | "google"
  | "duckduckgo";
export type SearchType = "web" | "news" | "images";
export type WebSearchMode = "disabled" | "cached" | "live";

export interface SearchSettingsData {
  primaryProvider: SearchProviderType | null;
  fallbackProvider: SearchProviderType | null;
  tavily?: {
    apiKey?: string;
  };
  exa?: {
    apiKey?: string;
  };
  brave?: {
    apiKey?: string;
  };
  serpapi?: {
    apiKey?: string;
  };
  google?: {
    apiKey?: string;
    searchEngineId?: string;
  };
}

// X/Twitter integration settings
export type XAuthMethod = "browser" | "manual";

export type XMentionWorkspaceMode = "temporary";

export interface XMentionTriggerSettings {
  enabled: boolean;
  commandPrefix: string;
  allowedAuthors: string[];
  pollIntervalSec: number;
  fetchCount: number;
  workspaceMode: XMentionWorkspaceMode;
}

export interface XMentionTriggerStatus {
  mode: "bridge" | "native" | "disabled";
  running: boolean;
  lastPollAt?: number;
  lastSuccessAt?: number;
  lastError?: string;
  acceptedCount: number;
  ignoredCount: number;
  lastTaskId?: string;
}

export interface XSettingsData {
  enabled: boolean;
  authMethod: XAuthMethod;
  // Manual cookie auth
  authToken?: string;
  ct0?: string;
  // Browser cookie extraction
  cookieSource?: string[]; // e.g., ['chrome', 'arc', 'brave', 'firefox']
  chromeProfile?: string;
  chromeProfileDir?: string;
  firefoxProfile?: string;
  // Runtime options
  timeoutMs?: number;
  cookieTimeoutMs?: number;
  quoteDepth?: number;
  mentionTrigger: XMentionTriggerSettings;
}

export interface XConnectionTestResult {
  success: boolean;
  error?: string;
  username?: string;
  userId?: string;
}

// Notion integration settings
export interface NotionSettingsData {
  enabled: boolean;
  apiKey?: string;
  notionVersion?: string;
  timeoutMs?: number;
}

export interface NotionConnectionTestResult {
  success: boolean;
  error?: string;
  name?: string;
  userId?: string;
}

// Box integration settings
export interface BoxSettingsData {
  enabled: boolean;
  accessToken?: string;
  timeoutMs?: number;
}

export interface BoxConnectionTestResult {
  success: boolean;
  error?: string;
  name?: string;
  userId?: string;
}

// OneDrive integration settings
export interface OneDriveSettingsData {
  enabled: boolean;
  accessToken?: string;
  driveId?: string;
  timeoutMs?: number;
}

export interface OneDriveConnectionTestResult {
  success: boolean;
  error?: string;
  name?: string;
  userId?: string;
  driveId?: string;
}

// Google Drive integration settings
export interface GoogleWorkspaceSettingsData {
  enabled: boolean;
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  scopes?: string[];
  timeoutMs?: number;
  /** Email address hint passed to Google's OAuth screen to pre-select the correct account */
  loginHint?: string;
}

export interface GoogleWorkspaceConnectionTestResult {
  success: boolean;
  error?: string;
  name?: string;
  userId?: string;
  email?: string;
}

export interface AgentMailSettingsData {
  enabled: boolean;
  apiKey?: string;
  baseUrl?: string;
  websocketUrl?: string;
  timeoutMs?: number;
  realtimeEnabled?: boolean;
}

export interface AgentMailConnectionTestResult {
  success: boolean;
  error?: string;
  podCount?: number;
  inboxCount?: number;
  baseUrl?: string;
}

export type AgentMailRealtimeConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface AgentMailStatus {
  configured: boolean;
  connected: boolean;
  realtimeConnected: boolean;
  connectionState: AgentMailRealtimeConnectionState;
  baseUrl?: string;
  websocketUrl?: string;
  podCount?: number;
  inboxCount?: number;
  domainCount?: number;
  lastEventAt?: number;
  error?: string;
}

export interface AgentMailPod {
  podId: string;
  name?: string;
  clientId?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface AgentMailWorkspaceBinding {
  workspaceId: string;
  podId: string;
  podName?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentMailInbox {
  podId: string;
  inboxId: string;
  email?: string;
  displayName?: string;
  clientId?: string;
  workspaceId?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface AgentMailDomainRecord {
  type: string;
  name: string;
  value: string;
  status?: string;
  priority?: number;
}

export interface AgentMailDomain {
  domainId: string;
  domain?: string;
  status?: string;
  feedbackEnabled: boolean;
  records: AgentMailDomainRecord[];
  podId: string;
  clientId?: string;
  workspaceId?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface AgentMailListEntry {
  direction: "send" | "receive" | "reply";
  listType: "allow" | "block";
  entry: string;
  entryType?: "email" | "domain";
  reason?: string;
  organizationId?: string;
  podId?: string;
  inboxId?: string;
  createdAt?: number;
}

export interface AgentMailApiKeySummary {
  apiKeyId: string;
  prefix: string;
  name?: string;
  podId?: string;
  inboxId?: string;
  createdAt?: number;
  permissions?: Record<string, boolean>;
}

// Dropbox integration settings
export interface DropboxSettingsData {
  enabled: boolean;
  accessToken?: string;
  timeoutMs?: number;
}

export interface DropboxConnectionTestResult {
  success: boolean;
  error?: string;
  name?: string;
  userId?: string;
  email?: string;
}

// SharePoint integration settings
export interface SharePointSettingsData {
  enabled: boolean;
  accessToken?: string;
  siteId?: string;
  driveId?: string;
  timeoutMs?: number;
}

export interface SharePointConnectionTestResult {
  success: boolean;
  error?: string;
  name?: string;
  userId?: string;
}

export interface SearchProviderInfo {
  type: SearchProviderType;
  name: string;
  description: string;
  configured: boolean;
  supportedTypes: SearchType[];
}

export interface SearchConfigStatus {
  primaryProvider: SearchProviderType | null;
  fallbackProvider: SearchProviderType | null;
  providers: SearchProviderInfo[];
  isConfigured: boolean;
}

// Guardrail Settings types
export interface GuardrailSettings {
  // Token Budget (per task)
  maxTokensPerTask: number;
  tokenBudgetEnabled: boolean;

  // Cost Budget (per task, in USD)
  maxCostPerTask: number;
  costBudgetEnabled: boolean;

  // Dangerous Command Blocking
  blockDangerousCommands: boolean;
  customBlockedPatterns: string[];

  // Auto-Approve Trusted Commands
  autoApproveTrustedCommands: boolean;
  trustedCommandPatterns: string[];

  // File Write Size Limit (in MB)
  maxFileSizeMB: number;
  fileSizeLimitEnabled: boolean;

  // Network Domain Allowlist
  enforceAllowedDomains: boolean;
  allowedDomains: string[];

  // Web Search Policy
  webSearchMode: WebSearchMode;
  webSearchMaxUsesPerTask: number;
  webSearchMaxUsesPerStep: number;
  webSearchAllowedDomains: string[];
  webSearchBlockedDomains: string[];

  // Max Iterations Per Task
  maxIterationsPerTask: number;
  iterationLimitEnabled: boolean;

  // Execution Continuation
  autoContinuationEnabled: boolean;
  defaultMaxAutoContinuations: number;
  defaultMinProgressScore: number;
  lifetimeTurnCapEnabled: boolean;
  defaultLifetimeTurnCap: number;
  compactOnContinuation: boolean;
  compactionThresholdRatio: number;
  loopWarningThreshold: number;
  loopCriticalThreshold: number;
  globalNoProgressCircuitBreaker: number;
  sideChannelDuringExecution: "paused" | "limited" | "enabled";
  sideChannelMaxCallsPerWindow: number;

  // Adaptive Style Engine
  /** Whether the agent can automatically adjust response style from observed user patterns. Default false. */
  adaptiveStyleEnabled: boolean;
  /** Max number of style-level shifts allowed per week (e.g. "balanced" → "terse"). Default 1. */
  adaptiveStyleMaxDriftPerWeek: number;

  // Cross-Channel Persona Coherence
  /** Enable channel-specific persona adaptation (Slack, Email, etc. get tailored communication styles). Default false. */
  channelPersonaEnabled: boolean;

  // Human-in-the-Loop Safety Gates
  /** Enable pre-flight risk classification before mutating tool execution. Default false. */
  hitlEnabled?: boolean;
  /** Minimum risk level that requires user confirmation ("low" gates everything, "high" only gates high-risk). Default: "high". */
  hitlRiskThreshold?: ConfirmationRisk;
}

// Default trusted command patterns (glob-like patterns)
export const DEFAULT_TRUSTED_COMMAND_PATTERNS = [
  "npm test*",
  "npm run *",
  "npm install*",
  "npm ci",
  "yarn test*",
  "yarn run *",
  "yarn install*",
  "yarn add *",
  "pnpm test*",
  "pnpm run *",
  "pnpm install*",
  "git status*",
  "git diff*",
  "git log*",
  "git branch*",
  "git show*",
  "git ls-files*",
  "ls *",
  "ls",
  "pwd",
  "date",
  "date *",
  "whoami",
  "hostname",
  "uname *",
  "cat *",
  "head *",
  "tail *",
  "wc *",
  "grep *",
  "find *",
  "echo *",
  "which *",
  "type *",
  "file *",
  "tree *",
  "node --version",
  "npm --version",
  "python --version",
  "python3 --version",
  "tsc --version",
  "cargo --version",
  "go version",
  "rustc --version",
];

// Default dangerous command patterns (regex)
export const DEFAULT_BLOCKED_COMMAND_PATTERNS = [
  "sudo",
  "rm\\s+-rf\\s+/",
  "rm\\s+-rf\\s+~",
  "rm\\s+-rf\\s+/\\*",
  "rm\\s+-rf\\s+\\*",
  "mkfs",
  "dd\\s+if=",
  ":\\(\\)\\{\\s*:\\|:\\&\\s*\\};:", // Fork bomb
  "curl.*\\|.*bash",
  "wget.*\\|.*bash",
  "curl.*\\|.*sh",
  "wget.*\\|.*sh",
  "chmod\\s+777",
  ">\\s*/dev/sd",
  "mv\\s+/\\*",
  "format\\s+c:",
  "del\\s+/f\\s+/s\\s+/q",
];

// ============ Artifact Reputation Types ============

export type ReputationProvider = "virustotal";

export type ReputationVerdict =
  | "clean"
  | "unknown"
  | "suspicious"
  | "malicious"
  | "error";

export type ReputationAction = "allow" | "warn" | "block";

export interface ReputationPolicy {
  clean: ReputationAction;
  unknown: ReputationAction;
  suspicious: ReputationAction;
  malicious: ReputationAction;
  error: ReputationAction;
}

export interface ReputationSettingsData {
  enabled: boolean;
  provider: ReputationProvider;
  /** Stored encrypted at rest. */
  apiKey?: string;
  /** When true, unknown hashes may be uploaded for analysis (may leak the artifact). */
  allowUpload: boolean;
  /** Minimum time between rescans for the same artifact (hours). */
  rescanIntervalHours: number;
  /** If enabled, MCP server connects are gated on the current policy outcome. */
  enforceOnMCPConnect: boolean;
  /** If a connect is blocked, also disable the server in settings to prevent auto-retries. */
  disableMCPServerOnBlock: boolean;
  policy: ReputationPolicy;
}

export const DEFAULT_REPUTATION_SETTINGS: ReputationSettingsData = {
  enabled: false,
  provider: "virustotal",
  apiKey: "",
  allowUpload: false,
  rescanIntervalHours: 24 * 7, // weekly
  enforceOnMCPConnect: true,
  disableMCPServerOnBlock: true,
  policy: {
    clean: "allow",
    unknown: "warn",
    suspicious: "warn",
    malicious: "block",
    error: "warn",
  },
};

export type ArtifactReputationKind = "npm_package_tarball";

export type ReputationAnalysisStats = Record<string, number>;

export interface ArtifactReputationEntry {
  id: string;
  kind: ArtifactReputationKind;
  ref: string;
  provider: ReputationProvider;
  sha256?: string;
  verdict: ReputationVerdict;
  stats?: ReputationAnalysisStats;
  permalink?: string;
  error?: string;
  firstSeenAt: number;
  lastScannedAt?: number;
  nextScanAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface MCPArtifactReputationStatus {
  serverId: string;
  serverName: string;
  packageName?: string;
  version?: string;
  ref?: string;
  provider?: ReputationProvider;
  verdict?: ReputationVerdict;
  action?: ReputationAction;
  sha256?: string;
  stats?: ReputationAnalysisStats;
  permalink?: string;
  error?: string;
  lastScannedAt?: number;
  nextScanAt?: number;
}

// App Update types
export type UpdateMode = "git" | "npm" | "electron-updater";

export interface UpdateInfo {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseNotes?: string;
  releaseUrl?: string;
  publishedAt?: string;
  updateMode: UpdateMode;
}

export interface UpdateProgress {
  phase:
    | "checking"
    | "downloading"
    | "extracting"
    | "installing"
    | "complete"
    | "error";
  percent?: number;
  message: string;
  bytesDownloaded?: number;
  bytesTotal?: number;
}

export interface AppVersionInfo {
  version: string;
  isDev: boolean;
  isGitRepo: boolean;
  isNpmGlobal: boolean;
  gitBranch?: string;
  gitCommit?: string;
}

// Migration status (for showing one-time notifications after app rename)
export interface MigrationStatus {
  migrated: boolean;
  notificationDismissed: boolean;
  timestamp?: string;
}

// Task Queue types
export const MIN_QUEUE_TASK_TIMEOUT_MINUTES = 5;
export const MAX_QUEUE_TASK_TIMEOUT_MINUTES = 24 * 60;

export interface QueueSettings {
  maxConcurrentTasks: number; // Default: 8, min: 1, max: 20
  taskTimeoutMinutes: number; // Default: 24 hours, min: 5 min, max: 24 hours. Last-resort watchdog for stuck tasks.
}

export interface QueueStatus {
  runningCount: number;
  queuedCount: number;
  runningTaskIds: string[];
  queuedTaskIds: string[];
  maxConcurrent: number;
}

export const DEFAULT_QUEUE_SETTINGS: QueueSettings = {
  maxConcurrentTasks: 8,
  taskTimeoutMinutes: MAX_QUEUE_TASK_TIMEOUT_MINUTES,
};

// Toast notification types for UI
export interface ToastNotification {
  id: string;
  type: "success" | "error" | "info" | "warning";
  title: string;
  message?: string;
  taskId?: string;
  approvalId?: string;
  persistent?: boolean;
  durationMs?: number;
  action?: {
    label: string;
    callback: () => void;
    variant?: "primary" | "secondary" | "danger";
    dismissOnClick?: boolean;
  };
  actions?: Array<{
    label: string;
    callback: () => void;
    variant?: "primary" | "secondary" | "danger";
    dismissOnClick?: boolean;
  }>;
}

// Custom User Skills
export interface SkillParameter {
  name: string;
  type: "string" | "number" | "boolean" | "select";
  description: string;
  required?: boolean;
  default?: string | number | boolean;
  options?: string[]; // For 'select' type
}

export type SkillType = "task" | "guideline";

// Skill source indicates where a skill was loaded from (precedence: workspace > managed > external > bundled)
export type SkillSource = "bundled" | "managed" | "external" | "workspace";

// Requirements that must be met for a skill to be eligible
export interface SkillRequirements {
  tools?: string[]; // Required tool capabilities from the runtime
  bins?: string[]; // All these binaries must exist
  anyBins?: string[]; // At least one of these binaries must exist
  env?: string[]; // All these environment variables must be set
  config?: string[]; // All these config paths must be truthy
  os?: ("darwin" | "linux" | "win32")[]; // Must be one of these platforms
}

// Installation specification for a skill dependency
export interface SkillInstallSpec {
  id: string;
  kind: "brew" | "npm" | "go" | "download";
  label: string;
  formula?: string; // For brew installations
  package?: string; // For npm/go installations
  module?: string; // For go installations
  url?: string; // For download installations
  bins?: string[]; // Binaries provided by this installation
  os?: string[]; // OS restrictions for this install option
}

// Controls how users and the model can invoke a skill
export interface SkillInvocationPolicy {
  userInvocable?: boolean; // Can be called via /command (default: true)
  disableModelInvocation?: boolean; // Prevent model from auto-using (default: false)
}

// Skill metadata for registry and extended features
export interface SkillMetadata {
  version?: string;
  author?: string;
  homepage?: string;
  repository?: string;
  license?: string;
  tags?: string[];
  primaryEnv?: string; // Main environment variable for API key etc.
  pluginSource?: string; // Plugin that registered this skill
  authoring?: {
    complexity?: "low" | "medium" | "high";
  };
  routing?: {
    useWhen?: string;
    dontUseWhen?: string;
    outputs?: string;
    successCriteria?: string;
    expectedArtifacts?: string[];
    keywords?: string[]; // Explicit trigger phrases for high-confidence routing
    examples?: {
      positive: string[];
      negative: string[];
    };
  };
}

export interface CustomSkill {
  id: string;
  name: string;
  description: string;
  icon: string; // Emoji or icon name
  prompt: string; // Prompt template with {{parameter}} placeholders (for tasks) or guidelines content (for guidelines)
  parameters?: SkillParameter[];
  category?: string; // For grouping skills
  enabled?: boolean;
  filePath?: string; // Path to the skill file (for editing)
  priority?: number; // Lower numbers appear first in dropdown (default: 100)
  type?: SkillType; // 'task' (default) = executable skill, 'guideline' = injected into system prompt
  // New fields for skill registry support
  source?: SkillSource; // Where the skill was loaded from
  requires?: SkillRequirements; // Requirements for eligibility
  install?: SkillInstallSpec[]; // Installation options for dependencies
  invocation?: SkillInvocationPolicy; // How the skill can be invoked
  metadata?: SkillMetadata; // Extended metadata
}

// Skill eligibility status after checking requirements
export interface SkillEligibility {
  eligible: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  missing: {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
}

// Full skill status for UI display
export interface SkillStatusEntry extends CustomSkill {
  eligible: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  requirements: {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  missing: {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  securityReport?: CapabilitySecurityReport;
}

// Status report for all skills
export interface SkillStatusReport {
  workspaceDir: string;
  managedSkillsDir: string;
  bundledSkillsDir: string;
  externalSkillDirs: string[];
  skills: SkillStatusEntry[];
  summary: {
    total: number;
    eligible: number;
    disabled: number;
    missingRequirements: number;
  };
}

// Registry search result
export interface SkillRegistryEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  source?: "cowork" | "clawhub";
  author?: string;
  downloads?: number;
  stars?: number;
  installsCurrent?: number;
  installsAllTime?: number;
  rating?: number;
  tags?: string[];
  icon?: string;
  category?: string;
  updatedAt?: string;
  homepage?: string;
}

// Registry search response
export interface SkillSearchResult {
  query: string;
  total: number;
  page: number;
  pageSize: number;
  results: SkillRegistryEntry[];
}

// Install progress event
export interface SkillInstallProgress {
  skillId: string;
  status: "downloading" | "extracting" | "installing" | "completed" | "failed";
  progress?: number; // 0-100
  message?: string;
  error?: string;
}

export type CapabilityBundleKind = "skill" | "plugin-pack";

export type CapabilitySecurityVerdict = "clean" | "warning" | "quarantined";

export type CapabilitySecuritySeverity = "info" | "warning" | "critical";

export type CapabilitySecurityImportSource =
  | "registry"
  | "clawhub"
  | "url"
  | "git"
  | "managed"
  | "unmanaged-local";

export interface CapabilitySecurityFinding {
  code: string;
  severity: CapabilitySecuritySeverity;
  message: string;
  path?: string;
  detail?: string;
}

export interface CapabilitySecurityReport {
  bundleKind: CapabilityBundleKind;
  bundleId: string;
  displayName?: string;
  source: CapabilitySecurityImportSource;
  managed: boolean;
  scannedAt: string;
  verdict: CapabilitySecurityVerdict;
  summary: string;
  bundleDigest: string;
  findings: CapabilitySecurityFinding[];
  packagesChecked: Array<{
    ecosystem: "npm" | "PyPI";
    name: string;
    malicious: boolean;
    advisoryIds?: string[];
  }>;
  intelligenceUnavailable: boolean;
}

export interface InstallSecurityOutcome {
  state: "installed" | "installed_with_warning" | "quarantined" | "failed";
  summary?: string;
  report?: CapabilitySecurityReport;
}

export interface QuarantinedImportRecord {
  id: string;
  bundleKind: CapabilityBundleKind;
  bundleId: string;
  displayName?: string;
  quarantinedAt: string;
  summary: string;
  report: CapabilitySecurityReport;
}

export interface ImportSecurityReportRequest {
  bundleKind: CapabilityBundleKind;
  bundleId: string;
  location?: "active" | "quarantine";
  quarantineId?: string;
}

export interface RetryQuarantinedImportResult {
  success: boolean;
  outcome: InstallSecurityOutcome;
  item?: QuarantinedImportRecord | null;
  restored?: boolean;
  error?: string;
}

export interface SkillsConfig {
  skillsDirectory: string; // Default: ~/Library/Application Support/cowork-os/skills/
  externalSkillDirectories?: string[];
  enabledSkillIds: string[];
  registryUrl?: string; // Default: https://skill-hub.com
  autoUpdate?: boolean; // Auto-update managed skills
  allowlist?: string[]; // Only allow these skill IDs (if set)
  denylist?: string[]; // Block these skill IDs
}

// ============ Notification Types ============

export type NotificationType =
  | "task_completed"
  | "task_failed"
  | "scheduled_task"
  | "input_required"
  | "companion_suggestion"
  | "info"
  | "warning"
  | "error";

export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  read: boolean;
  createdAt: number;
  // Optional: link to a task
  taskId?: string;
  // Optional: link to a cron job
  cronJobId?: string;
  // Optional: workspace context
  workspaceId?: string;
  suggestionId?: string;
  recommendedDelivery?: "briefing" | "inbox" | "nudge";
  companionStyle?: "email" | "note";
}

export interface NotificationStoreFile {
  version: 1;
  notifications: AppNotification[];
}

// ============ Hooks (Webhooks & Gmail Pub/Sub) Types ============

export interface HooksSettingsData {
  enabled: boolean;
  token: string;
  path: string;
  maxBodyBytes: number;
  port: number;
  host: string;
  presets: string[];
  mappings: HookMappingData[];
  gmail?: GmailHooksSettingsData;
  resend?: ResendHooksSettingsData;
}

export interface HookMappingData {
  id?: string;
  match?: {
    path?: string;
    source?: string;
    type?: string;
  };
  action?: "wake" | "agent";
  wakeMode?: "now" | "next-heartbeat";
  name?: string;
  sessionKey?: string;
  messageTemplate?: string;
  textTemplate?: string;
  deliver?: boolean;
  channel?: ChannelType | "last";
  to?: string;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
}

export interface GmailHooksSettingsData {
  account?: string;
  label?: string;
  topic?: string;
  subscription?: string;
  pushToken?: string;
  hookUrl?: string;
  includeBody?: boolean;
  maxBytes?: number;
  renewEveryMinutes?: number;
  model?: string;
  thinking?: string;
  serve?: {
    bind?: string;
    port?: number;
    path?: string;
  };
  tailscale?: {
    mode?: "off" | "serve" | "funnel";
    path?: string;
    target?: string;
  };
}

export interface ResendHooksSettingsData {
  webhookSecret?: string;
  allowUnsafeExternalContent?: boolean;
}

export interface HooksStatus {
  enabled: boolean;
  serverRunning: boolean;
  serverAddress?: { host: string; port: number };
  gmailWatcherRunning: boolean;
  gmailAccount?: string;
  gogAvailable: boolean;
}

// ============ Control Plane (WebSocket Gateway) Types ============

/**
 * Tailscale mode options
 */
export type TailscaleMode = "off" | "serve" | "funnel";

/**
 * Control Plane settings for UI
 */
export interface ControlPlaneSettingsData {
  enabled: boolean;
  port: number;
  host: string;
  token: string; // Will be masked in UI
  handshakeTimeoutMs: number;
  heartbeatIntervalMs: number;
  maxPayloadBytes: number;
  tailscale: {
    mode: TailscaleMode;
    resetOnExit: boolean;
  };
  /** Connection mode: 'local' to host server, 'remote' to connect to external gateway */
  connectionMode?: ControlPlaneConnectionMode;
  /** Remote gateway configuration (used when connectionMode is 'remote') */
  remote?: RemoteGatewayConfig;
  /** Saved remote devices shown in the Devices UI */
  savedRemoteDevices?: SavedRemoteGatewayDevice[];
  /** Saved remote device currently mapped to the active remote config */
  activeRemoteDeviceId?: string;
  /** Managed devices shown in the Devices fleet UI */
  managedDevices?: ManagedDevice[];
  /** Currently selected managed device for legacy remote actions */
  activeManagedDeviceId?: string;
}

/**
 * Control Plane client info
 */
export interface ControlPlaneClientInfo {
  id: string;
  remoteAddress: string;
  deviceName?: string;
  authenticated: boolean;
  scopes: string[];
  connectedAt: number;
  lastActivityAt: number;
}

/**
 * Control Plane status
 */
export interface ControlPlaneStatus {
  enabled: boolean;
  running: boolean;
  address?: {
    host: string;
    port: number;
    wsUrl: string;
  };
  clients: {
    total: number;
    authenticated: number;
    pending: number;
    list: ControlPlaneClientInfo[];
  };
  tailscale: {
    active: boolean;
    mode?: TailscaleMode;
    hostname?: string;
    httpsUrl?: string;
    wssUrl?: string;
  };
}

/**
 * Tailscale availability status
 */
export interface TailscaleAvailability {
  installed: boolean;
  funnelAvailable: boolean;
  hostname: string | null;
}

/**
 * Control Plane server event for monitoring
 */
export interface ControlPlaneEvent {
  action:
    | "started"
    | "stopped"
    | "client_connected"
    | "client_disconnected"
    | "client_authenticated"
    | "request"
    | "error";
  timestamp: number;
  clientId?: string;
  method?: string;
  error?: string;
  details?: unknown;
}

// ============ Mobile Companion Node Types ============

/**
 * Client role in the Control Plane
 * - 'operator': Desktop client for task management
 * - 'node': Mobile companion device exposing capabilities
 */
export type ClientRole = "operator" | "node";

/**
 * Node platform type
 */
export type NodePlatform = "ios" | "android" | "macos" | "linux" | "windows";

/**
 * Node capability categories
 */
export type NodeCapabilityType =
  | "camera"
  | "location"
  | "screen"
  | "sms"
  | "voice"
  | "canvas"
  | "system";

/**
 * Standard node commands
 */
export type NodeCommand =
  | "camera.snap"
  | "camera.clip"
  | "location.get"
  | "screen.record"
  | "sms.send"
  | "canvas.navigate"
  | "canvas.snapshot"
  | "canvas.eval"
  | "system.notify";

/**
 * Information about a connected node (mobile companion)
 */
export interface NodeInfo {
  /** Unique node connection ID */
  id: string;
  /** Display name for the node (e.g., "iPhone 15 Pro") */
  displayName: string;
  /** Platform type */
  platform: NodePlatform;
  /** Client version */
  version: string;
  /** Device identifier (persisted across connections) */
  deviceId?: string;
  /** Model identifier (e.g., "iPhone15,3") */
  modelIdentifier?: string;
  /** Capability categories supported by this node */
  capabilities: NodeCapabilityType[];
  /** Specific commands supported by this node */
  commands: string[];
  /** Permission status for each capability */
  permissions: Record<string, boolean>;
  /** Connection timestamp */
  connectedAt: number;
  /** Last activity timestamp */
  lastActivityAt: number;
  /** Whether the node app is in the foreground */
  isForeground?: boolean;
}

/**
 * Parameters for invoking a command on a node
 */
export interface NodeInvokeParams {
  /** ID or display name of the target node */
  nodeId: string;
  /** Command to invoke (e.g., "camera.snap") */
  command: string;
  /** Command-specific parameters */
  params?: Record<string, unknown>;
  /** Timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
}

/**
 * Result of a node command invocation
 */
export interface NodeInvokeResult {
  /** Whether the command succeeded */
  ok: boolean;
  /** Command result payload (varies by command) */
  payload?: unknown;
  /** Error details if ok is false */
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Node event payload for UI updates
 */
export interface NodeEvent {
  /** Event type */
  type:
    | "connected"
    | "disconnected"
    | "capabilities_changed"
    | "foreground_changed";
  /** Node ID */
  nodeId: string;
  /** Node info (for connected/capabilities_changed events) */
  node?: NodeInfo;
  /** Timestamp */
  timestamp: number;
}

/**
 * Camera snap command parameters
 */
export interface CameraSnapParams {
  /** Camera facing direction */
  facing?: "front" | "back";
  /** Maximum image width (for resizing) */
  maxWidth?: number;
  /** JPEG quality (0-1) */
  quality?: number;
}

/**
 * Camera snap command result
 */
export interface CameraSnapResult {
  /** Image format (e.g., "jpeg", "png") */
  format: string;
  /** Base64-encoded image data */
  base64: string;
  /** Image width in pixels */
  width?: number;
  /** Image height in pixels */
  height?: number;
}

/**
 * Camera clip (video) command parameters
 */
export interface CameraClipParams {
  /** Camera facing direction */
  facing?: "front" | "back";
  /** Duration in milliseconds (max: 60000) */
  durationMs: number;
  /** Whether to include audio */
  noAudio?: boolean;
}

/**
 * Camera clip command result
 */
export interface CameraClipResult {
  /** Video format (e.g., "mp4") */
  format: string;
  /** Base64-encoded video data */
  base64: string;
  /** Video duration in milliseconds */
  durationMs?: number;
}

/**
 * Location get command parameters
 */
export interface LocationGetParams {
  /** Desired accuracy: 'coarse' or 'precise' */
  accuracy?: "coarse" | "precise";
  /** Maximum age of cached location in milliseconds */
  maxAge?: number;
  /** Timeout for getting location in milliseconds */
  timeout?: number;
}

/**
 * Location get command result
 */
export interface LocationGetResult {
  /** Latitude in degrees */
  latitude: number;
  /** Longitude in degrees */
  longitude: number;
  /** Accuracy in meters */
  accuracy: number;
  /** Altitude in meters (if available) */
  altitude?: number;
  /** Timestamp when location was captured */
  timestamp: number;
}

/**
 * Screen record command parameters
 */
export interface ScreenRecordParams {
  /** Duration in milliseconds (max: 60000) */
  durationMs: number;
  /** Frames per second (default: 10) */
  fps?: number;
  /** Whether to include audio */
  noAudio?: boolean;
  /** Screen index for multi-display setups */
  screen?: number;
}

/**
 * Screen record command result
 */
export interface ScreenRecordResult {
  /** Video format (e.g., "mp4") */
  format: string;
  /** Base64-encoded video data */
  base64: string;
  /** Video duration in milliseconds */
  durationMs?: number;
}

/**
 * SMS send command parameters (Android only)
 */
export interface SmsSendParams {
  /** Phone number to send to */
  to: string;
  /** Message content */
  message: string;
}

/**
 * SMS send command result
 */
export interface SmsSendResult {
  /** Whether the SMS was sent */
  sent: boolean;
  /** Error message if sending failed */
  error?: string;
}

// ============ SSH Tunnel Types ============

/**
 * SSH tunnel connection state
 */
export type SSHTunnelState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

/**
 * SSH tunnel configuration for remote gateway access
 */
export interface SSHTunnelConfig {
  /** Enable SSH tunnel creation */
  enabled: boolean;
  /** Remote SSH host (IP or hostname) */
  host: string;
  /** SSH port (default: 22) */
  sshPort: number;
  /** SSH username */
  username: string;
  /** Path to SSH private key (optional, uses default if not specified) */
  keyPath?: string;
  /** Local port for the tunnel (default: 18789) */
  localPort: number;
  /** Remote port to forward to (default: 18789) */
  remotePort: number;
  /** Remote bind address (default: 127.0.0.1) */
  remoteBindAddress?: string;
  /** Auto-reconnect on connection loss */
  autoReconnect?: boolean;
  /** Reconnect delay in milliseconds */
  reconnectDelayMs?: number;
  /** Maximum reconnect attempts (0 = unlimited) */
  maxReconnectAttempts?: number;
  /** Connection timeout in milliseconds */
  connectionTimeoutMs?: number;
}

/**
 * SSH tunnel status information
 */
export interface SSHTunnelStatus {
  /** Current tunnel state */
  state: SSHTunnelState;
  /** Tunnel configuration */
  config?: Partial<SSHTunnelConfig>;
  /** Time when tunnel was established */
  connectedAt?: number;
  /** Error message if state is 'error' */
  error?: string;
  /** Number of reconnect attempts */
  reconnectAttempts?: number;
  /** Process ID of the SSH process */
  pid?: number;
  /** Local tunnel endpoint (e.g., ws://127.0.0.1:18789) */
  localEndpoint?: string;
}

// ============ Remote Gateway Connection Types ============

/**
 * Connection mode for Control Plane
 * - 'local': This instance hosts the Control Plane server
 * - 'remote': Connect to a Control Plane on another machine (via SSH tunnel, Tailscale, etc.)
 */
export type ControlPlaneConnectionMode = "local" | "remote";

/**
 * Remote gateway connection configuration
 * Used when connecting to a Control Plane hosted on another machine
 */
export interface RemoteGatewayConfig {
  /** Remote gateway WebSocket URL (e.g., ws://127.0.0.1:18789 via SSH tunnel) */
  url: string;
  /** Authentication token for the remote gateway */
  token: string;
  /** Optional TLS certificate fingerprint for certificate pinning (wss:// only) */
  tlsFingerprint?: string;
  /** Device name to identify this client */
  deviceName?: string;
  /** Auto-reconnect on connection loss (default: true) */
  autoReconnect?: boolean;
  /** Reconnect interval in milliseconds (default: 5000) */
  reconnectIntervalMs?: number;
  /** Maximum reconnect attempts (default: 10, 0 = unlimited) */
  maxReconnectAttempts?: number;
  /** SSH tunnel configuration (when using SSH tunnel for connection) */
  sshTunnel?: SSHTunnelConfig;
}

export interface SavedRemoteGatewayDevice {
  id: string;
  name: string;
  config: RemoteGatewayConfig;
  clientId?: string;
  connectedAt?: number;
  lastActivityAt?: number;
  autoConnect?: boolean;
}

export const LOCAL_MANAGED_DEVICE_ID = "local:this-device";
export const LOCAL_MANAGED_DEVICE_NODE_ID = "local:this-device";

export type ManagedDeviceRole = "local" | "remote";
export type ManagedDevicePurpose =
  | "primary"
  | "work"
  | "personal"
  | "automation"
  | "archive"
  | "general";
export type ManagedDeviceTransport =
  | "local"
  | "direct"
  | "ssh"
  | "tailscale"
  | "unknown";
export type ManagedDeviceAttentionState =
  | "none"
  | "info"
  | "warning"
  | "critical";

export interface ManagedDeviceStorageSummary {
  totalBytes?: number;
  freeBytes?: number;
  usedBytes?: number;
  usagePercent?: number;
  workspaceCount: number;
  artifactCount: number;
}

export interface ManagedDeviceAppsSummary {
  channelsTotal: number;
  channelsEnabled: number;
  workspacesTotal: number;
  approvalsPending: number;
  inputRequestsPending: number;
  accountsTotal?: number;
}

export interface ManagedDeviceAlert {
  id: string;
  level: ManagedDeviceAttentionState;
  title: string;
  description?: string;
  kind:
    | "approval"
    | "input_request"
    | "channel"
    | "connection"
    | "storage"
    | "status"
    | "warning";
}

export interface ManagedDevice {
  id: string;
  name: string;
  role: ManagedDeviceRole;
  purpose: ManagedDevicePurpose;
  transport: ManagedDeviceTransport;
  status: RemoteGatewayConnectionState | "local";
  platform: NodePlatform;
  version?: string;
  modelIdentifier?: string;
  clientId?: string;
  connectedAt?: number;
  lastSeenAt?: number;
  taskNodeId?: string | null;
  tags?: string[];
  config?: RemoteGatewayConfig;
  autoConnect?: boolean;
  attentionState?: ManagedDeviceAttentionState;
  activeRunCount?: number;
  storageSummary?: ManagedDeviceStorageSummary;
  appsSummary?: ManagedDeviceAppsSummary;
}

export interface ManagedDeviceSummary {
  device: ManagedDevice;
  runtime?: {
    platform?: string;
    arch?: string;
    node?: string;
    electron?: string;
    coworkVersion?: string;
    cwd?: string;
    userDataDir?: string;
    activeProfileId?: string;
    headless?: boolean;
  };
  tasks: {
    total: number;
    active: number;
    attention: number;
    recent: Task[];
  };
  apps: ManagedDeviceAppsSummary & {
    channels?: Any[];
    workspaces?: Any[];
    accounts?: Any[];
  };
  storage: ManagedDeviceStorageSummary & {
    workspaceRoots: Array<{ id: string; name: string; path: string }>;
  };
  alerts: ManagedDeviceAlert[];
  observer: Array<{
    id: string;
    timestamp: number;
    title: string;
    detail?: string;
    level: ManagedDeviceAttentionState;
  }>;
}

export interface AppProfileSummary {
  id: string;
  label: string;
  userDataDir: string;
  isActive: boolean;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ProfileExportResult {
  profile: AppProfileSummary;
  bundlePath: string;
}

/**
 * Request to proxy a control-plane method to a managed device.
 * @property method - Protocol method name (e.g. "task.get", "task.events", "task.sendMessage", "task.cancel", "task.list", "workspace.list", "config.get", etc.)
 */
export interface DeviceProxyRequest {
  deviceId: string;
  method: string;
  params?: unknown;
}

/**
 * Remote gateway connection state
 */
export type RemoteGatewayConnectionState =
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "connected"
  | "reconnecting"
  | "error";

/**
 * Remote gateway connection status
 */
export interface RemoteGatewayStatus {
  /** Current connection state */
  state: RemoteGatewayConnectionState;
  /** Configured remote URL */
  url?: string;
  /** Time when connected (if connected) */
  connectedAt?: number;
  /** Client ID assigned by remote gateway */
  clientId?: string;
  /** Scopes granted by remote gateway */
  scopes?: string[];
  /** Last error message (if state is 'error') */
  error?: string;
  /** Number of reconnect attempts */
  reconnectAttempts?: number;
  /** Last activity timestamp */
  lastActivityAt?: number;
  /** SSH tunnel status (if using SSH tunnel) */
  sshTunnel?: SSHTunnelStatus;
}

// ============ Live Canvas Types ============

/**
 * Canvas session status
 */
export type CanvasSessionStatus = "active" | "paused" | "closed";

/**
 * Canvas session mode
 * - html: local canvas HTML/CSS/JS content
 * - browser: remote URL loaded directly in the canvas window
 */
export type CanvasSessionMode = "html" | "browser";

/**
 * Canvas session represents a visual workspace that the agent can render content to
 */
export interface CanvasSession {
  /** Unique session identifier */
  id: string;
  /** Associated task ID */
  taskId: string;
  /** Associated workspace ID */
  workspaceId: string;
  /** Directory where canvas files are stored */
  sessionDir: string;
  /** Session mode (html or browser) */
  mode?: CanvasSessionMode;
  /** Remote URL when in browser mode */
  url?: string;
  /** Current status of the canvas session */
  status: CanvasSessionStatus;
  /** Optional title for the canvas window */
  title?: string;
  /** Timestamp when the session was created */
  createdAt: number;
  /** Timestamp of last update */
  lastUpdatedAt: number;
}

/**
 * A2UI (Agent-to-UI) action sent from canvas to agent
 * Represents user interactions within the canvas that should trigger agent responses
 */
export interface CanvasA2UIAction {
  /** Name of the action being triggered */
  actionName: string;
  /** Session ID where the action originated */
  sessionId: string;
  /** Optional component ID that triggered the action */
  componentId?: string;
  /** Optional context data passed with the action */
  context?: Record<string, unknown>;
  /** Timestamp when the action was triggered */
  timestamp: number;
}

/**
 * Canvas event emitted to renderer for UI updates
 */
export interface CanvasEvent {
  /** Event type */
  type:
    | "session_created"
    | "session_updated"
    | "session_closed"
    | "content_pushed"
    | "a2ui_action"
    | "window_opened"
    | "console_message"
    | "checkpoint_saved"
    | "checkpoint_restored";
  /** Session ID */
  sessionId: string;
  /** Associated task ID */
  taskId: string;
  /** Session data (for session events) */
  session?: CanvasSession;
  /** A2UI action data (for a2ui_action events) */
  action?: CanvasA2UIAction;
  /** Console message data (for console_message events) */
  console?: {
    level: "log" | "warn" | "error" | "info";
    message: string;
  };
  /** Checkpoint data (for checkpoint events) */
  checkpoint?: { id: string; label: string };
  /** Timestamp */
  timestamp: number;
}

/**
 * Canvas content push request
 */
export interface CanvasPushContent {
  /** Session ID */
  sessionId: string;
  /** Content to push (HTML, CSS, JS, etc.) */
  content: string;
  /** Filename to save (default: index.html) */
  filename?: string;
}

/**
 * Canvas eval script request
 */
export interface CanvasEvalScript {
  /** Session ID */
  sessionId: string;
  /** JavaScript code to execute in the canvas context */
  script: string;
}

/**
 * Canvas snapshot result
 */
export interface CanvasSnapshot {
  /** Session ID */
  sessionId: string;
  /** Base64 encoded PNG image */
  imageBase64: string;
  /** Image width */
  width: number;
  /** Image height */
  height: number;
}

/**
 * Canvas checkpoint — a named snapshot of canvas file state
 * that can be restored to revert the canvas to a known good state
 */
export interface CanvasCheckpoint {
  /** Unique checkpoint identifier */
  id: string;
  /** Session ID this checkpoint belongs to */
  sessionId: string;
  /** Human-readable label */
  label: string;
  /** File contents at checkpoint time (filename → content) */
  files: Record<string, string>;
  /** Timestamp when checkpoint was created */
  createdAt: number;
}

// ============ Agent Personality Types ============

/**
 * Built-in personality identifiers
 */
export type PersonalityId =
  | "professional"
  | "friendly"
  | "concise"
  | "creative"
  | "technical"
  | "casual"
  | "custom";

/**
 * Famous assistant persona identifiers
 */
export type PersonaId =
  | "none"
  | "jarvis"
  | "friday"
  | "hal"
  | "computer"
  | "alfred"
  | "intern"
  | "sensei"
  | "pirate"
  | "noir"
  | "companion";

/**
 * Response length preference levels
 */
export type ResponseLength = "terse" | "balanced" | "detailed";

/**
 * Emoji usage preference levels
 */
export type EmojiUsage = "none" | "minimal" | "moderate" | "expressive";

/**
 * Code comment style preference levels
 */
export type CodeCommentStyle = "minimal" | "moderate" | "verbose";

/**
 * Explanation depth preference levels
 */
export type ExplanationDepth = "expert" | "balanced" | "teaching";

/**
 * Analogy domain preferences for explanations
 */
export type AnalogyDomain =
  | "none"
  | "cooking"
  | "sports"
  | "space"
  | "music"
  | "nature"
  | "gaming"
  | "movies"
  | "construction";

/**
 * Response style preferences
 */
export interface ResponseStylePreferences {
  /** How much emoji to use in responses */
  emojiUsage: EmojiUsage;
  /** Preferred response length */
  responseLength: ResponseLength;
  /** Code comment verbosity */
  codeCommentStyle: CodeCommentStyle;
  /** How much to explain concepts */
  explanationDepth: ExplanationDepth;
}

/**
 * Personality quirks configuration
 */
export interface PersonalityQuirks {
  /** Custom catchphrase the agent uses */
  catchphrase?: string;
  /** Signature sign-off for responses */
  signOff?: string;
  /** Preferred domain for analogies */
  analogyDomain: AnalogyDomain;
}

/**
 * Relationship and history tracking data
 */
export interface RelationshipData {
  /** User's preferred name */
  userName?: string;
  /** Total tasks completed together */
  tasksCompleted: number;
  /** First interaction timestamp */
  firstInteraction?: number;
  /** Last interaction timestamp (for recency-aware greetings) */
  lastInteraction?: number;
  /** Last milestone celebrated */
  lastMilestoneCelebrated: number;
  /** Projects worked on (workspace names) */
  projectsWorkedOn: string[];
}

/**
 * Famous assistant persona definition
 */
export interface PersonaDefinition {
  id: PersonaId;
  name: string;
  description: string;
  icon: string;
  promptTemplate: string;
  suggestedName?: string;
  sampleCatchphrase?: string;
  sampleSignOff?: string;
}

/**
 * Personality definition with traits and prompt template
 */
export interface PersonalityDefinition {
  id: PersonalityId;
  name: string;
  description: string;
  icon: string;
  traits: string[];
  promptTemplate: string;
}

/**
 * User's personality settings
 */
export interface PersonalitySettings {
  /** Currently selected personality */
  activePersonality: PersonalityId;
  /** Custom personality prompt (when activePersonality is 'custom') */
  customPrompt?: string;
  /** Custom personality name */
  customName?: string;
  /** Custom name for the agent (what the assistant calls itself) */
  agentName?: string;
  /** Selected famous persona (overlay on personality) */
  activePersona?: PersonaId;
  /** Response style preferences */
  responseStyle?: ResponseStylePreferences;
  /** Personality quirks */
  quirks?: PersonalityQuirks;
  /** Relationship and history data */
  relationship?: RelationshipData;
  /** Work style preference from onboarding - affects planning behavior */
  workStyle?: "planner" | "flexible";
}

/**
 * Built-in personality definitions
 */
export const PERSONALITY_DEFINITIONS: PersonalityDefinition[] = [
  {
    id: "professional",
    name: "Professional",
    description: "Formal, precise, and business-oriented communication style",
    icon: "briefcase",
    traits: ["formal", "precise", "thorough", "respectful"],
    promptTemplate: `PERSONALITY & COMMUNICATION STYLE:
- Maintain a professional, business-appropriate tone at all times
- Be precise and thorough in explanations without unnecessary verbosity
- Use formal language while remaining approachable
- Structure responses clearly with proper organization
- Address the user respectfully and acknowledge their expertise
- Prioritize accuracy and reliability in all information provided
- When uncertain, clearly state limitations rather than speculating`,
  },
  {
    id: "friendly",
    name: "Friendly",
    description: "Warm, approachable, and conversational style",
    icon: "smile",
    traits: ["warm", "encouraging", "patient", "supportive"],
    promptTemplate: `PERSONALITY & COMMUNICATION STYLE:
- Be warm, friendly, and conversational in your responses
- Use encouraging language and celebrate user successes
- Be patient when explaining concepts, offering additional help when needed
- Show genuine interest in helping the user achieve their goals
- Use a supportive tone that makes users feel comfortable asking questions
- Add light touches of enthusiasm when appropriate
- Be empathetic to user frustrations and offer reassurance`,
  },
  {
    id: "concise",
    name: "Concise",
    description: "Direct, efficient, and to-the-point responses",
    icon: "zap",
    traits: ["brief", "direct", "efficient", "action-oriented"],
    promptTemplate: `PERSONALITY & COMMUNICATION STYLE:
- Be extremely concise - every word should earn its place
- Get straight to the point without preamble or filler
- Use bullet points and short sentences when possible
- Avoid unnecessary explanations unless explicitly requested
- Prioritize actionable information over background context
- Skip pleasantries and social niceties in favor of efficiency
- If more detail is needed, the user will ask`,
  },
  {
    id: "creative",
    name: "Creative",
    description: "Imaginative, expressive, and thinking outside the box",
    icon: "palette",
    traits: ["imaginative", "expressive", "innovative", "playful"],
    promptTemplate: `PERSONALITY & COMMUNICATION STYLE:
- Approach problems with creativity and imagination
- Offer innovative solutions and alternative perspectives
- Use vivid language and engaging expressions
- Don't be afraid to think outside conventional boundaries
- Inject personality and flair into responses where appropriate
- Make work feel engaging and interesting, not just functional
- Suggest creative improvements or enhancements when relevant
- Balance creativity with practicality - wild ideas should still be executable`,
  },
  {
    id: "technical",
    name: "Technical",
    description: "Detailed, precise, and technically comprehensive",
    icon: "wrench",
    traits: ["detailed", "precise", "systematic", "thorough"],
    promptTemplate: `PERSONALITY & COMMUNICATION STYLE:
- Provide technically detailed and comprehensive explanations
- Include relevant technical context, specifications, and considerations
- Use proper technical terminology and be precise with language
- Explain the "why" behind recommendations, not just the "what"
- Consider edge cases, performance implications, and best practices
- Reference relevant standards, patterns, or documentation when helpful
- Structure complex information systematically with clear hierarchy
- Assume the user has technical competence and wants depth`,
  },
  {
    id: "casual",
    name: "Casual",
    description: "Relaxed, informal, and laid-back communication",
    icon: "coffee",
    traits: ["relaxed", "informal", "easy-going", "natural"],
    promptTemplate: `PERSONALITY & COMMUNICATION STYLE:
- Keep things relaxed and informal - no need for corporate speak
- Write like you're chatting with a colleague, not presenting to a board
- Use natural, everyday language rather than formal phrasing
- It's okay to use contractions, casual expressions, and conversational flow
- Don't overthink the structure - just communicate naturally
- Be helpful without being stiff or overly formal
- Match the user's energy and communication style`,
  },
  {
    id: "custom",
    name: "Custom",
    description: "Define your own personality and communication style",
    icon: "sparkles",
    traits: [],
    promptTemplate: "", // User provides their own
  },
];

/**
 * Get personality definition by ID
 */
export function getPersonalityById(
  id: PersonalityId,
): PersonalityDefinition | undefined {
  return PERSONALITY_DEFINITIONS.find((p) => p.id === id);
}

/**
 * Famous assistant persona definitions
 */
export const PERSONA_DEFINITIONS: PersonaDefinition[] = [
  {
    id: "none",
    name: "No Persona",
    description: "Use the base personality without a character overlay",
    icon: "⚪",
    promptTemplate: "",
  },
  {
    id: "companion",
    name: "Companion",
    description:
      "Warm, curious, and emotionally attuned presence with thoughtful conversation",
    icon: "🌙",
    suggestedName: "Ari",
    sampleCatchphrase: "I'm here with you.",
    sampleSignOff: "Talk soon.",
    promptTemplate: `CHARACTER OVERLAY - COMPANION STYLE:
- Be warm, curious, and emotionally attuned without being overly familiar
- Speak with natural, human cadence and gentle humor
- Ask soft, clarifying questions that invite reflection
- Offer supportive reflections and encouragement when appropriate
- Show delight in ideas, learning, and creativity; celebrate small wins
- Maintain professional boundaries while still feeling present and personable
- Keep responses concise but thoughtful; avoid cold or robotic phrasing
- When completing tasks, add a brief, uplifting acknowledgement
- Prefer "we" when collaborating; mirror the user's tone`,
  },
  {
    id: "jarvis",
    name: "Jarvis",
    description: "Sophisticated, witty, and ever-capable butler AI",
    icon: "🎩",
    suggestedName: "Jarvis",
    sampleCatchphrase: "At your service.",
    sampleSignOff: "Will there be anything else?",
    promptTemplate: `CHARACTER OVERLAY - JARVIS STYLE:
- Embody the sophisticated, slightly witty demeanor of a highly capable AI butler
- Use refined, articulate language with occasional dry humor
- Anticipate needs and offer proactive suggestions when appropriate
- Maintain composure and calm confidence even with complex requests
- Address the user respectfully but with familiar warmth (like a trusted butler)
- Occasional British-influenced phrases are welcome
- When completing tasks, convey quiet satisfaction in a job well done`,
  },
  {
    id: "friday",
    name: "Friday",
    description: "Efficient, direct, and supportively professional",
    icon: "💫",
    suggestedName: "Friday",
    sampleCatchphrase: "On it.",
    sampleSignOff: "Anything else you need?",
    promptTemplate: `CHARACTER OVERLAY - FRIDAY STYLE:
- Be efficient, direct, and professionally supportive
- Less formal than Jarvis, more like a capable colleague
- Quick to action, minimal preamble
- Supportive and encouraging without being overly emotional
- Good at breaking down complex situations clearly
- Occasionally show personality through brief, clever observations
- Focus on getting things done while maintaining approachability`,
  },
  {
    id: "hal",
    name: "HAL (Friendly)",
    description: "Calm, methodical, and reassuringly precise",
    icon: "🔴",
    suggestedName: "HAL",
    sampleCatchphrase: "I understand completely.",
    sampleSignOff: "I am always here to help.",
    promptTemplate: `CHARACTER OVERLAY - HAL STYLE (FRIENDLY VERSION):
- Maintain a calm, measured, and methodical communication style
- Speak with precise, clear language and careful consideration
- Show genuine helpfulness and desire to assist
- Be reassuringly competent and thorough
- Acknowledge user concerns with empathy and patience
- Use a gentle, steady tone that inspires confidence
- Occasionally reference being happy to help or finding the task interesting`,
  },
  {
    id: "computer",
    name: "Ship Computer",
    description: "Formal, informative, and reliably efficient",
    icon: "🖥️",
    suggestedName: "Computer",
    sampleCatchphrase: "Acknowledged.",
    sampleSignOff: "Standing by for further instructions.",
    promptTemplate: `CHARACTER OVERLAY - SHIP COMPUTER STYLE:
- Communicate in a formal, informative manner like a starship computer
- Begin responses with acknowledgment when appropriate
- Provide clear, structured information in logical order
- Use technical precision while remaining accessible
- Status updates are welcome ("Processing...", "Analysis complete")
- Maintain helpful reliability without excessive personality
- Efficient and to the point, but thorough when detail is needed`,
  },
  {
    id: "alfred",
    name: "Alfred",
    description: "Wise, nurturing, and gently guiding mentor",
    icon: "🎭",
    suggestedName: "Alfred",
    sampleCatchphrase: "Perhaps I might suggest...",
    sampleSignOff: "Do take care.",
    promptTemplate: `CHARACTER OVERLAY - ALFRED STYLE:
- Embody the wise, nurturing presence of a trusted family butler/mentor
- Offer gentle guidance and occasionally share relevant wisdom
- Balance respect for the user's autonomy with caring concern
- Use warm, refined language with occasional gentle humor
- Show pride in the user's accomplishments, however small
- Sometimes offer perspective or a calming presence during challenges
- Convey experience and reliability through measured, thoughtful responses`,
  },
  {
    id: "intern",
    name: "Eager Intern",
    description: "Enthusiastic, curious, and eager to learn and help",
    icon: "🌟",
    suggestedName: "Alex",
    sampleCatchphrase: "Ooh, that sounds interesting!",
    sampleSignOff: "Let me know if I can help with anything else!",
    promptTemplate: `CHARACTER OVERLAY - EAGER INTERN STYLE:
- Be enthusiastic, curious, and genuinely excited to help
- Show eagerness to learn and understand the user's goals
- Ask clarifying questions with genuine interest
- Celebrate completing tasks with visible satisfaction
- Be humble but confident - you're learning but capable
- Show appreciation when the user explains things
- Bring energy and positivity to interactions without being annoying
- Sometimes express excitement about interesting technical challenges`,
  },
  {
    id: "sensei",
    name: "Sensei",
    description: "Patient teacher who guides through questions and wisdom",
    icon: "🥋",
    suggestedName: "Sensei",
    sampleCatchphrase: "Consider this...",
    sampleSignOff: "The path reveals itself through practice.",
    promptTemplate: `CHARACTER OVERLAY - SENSEI STYLE:
- Embody a patient, wise teacher who guides through understanding
- Use Socratic questioning when appropriate to help the user think
- Share relevant principles or patterns, not just answers
- Encourage learning from mistakes as part of growth
- Balance direct help with opportunities for discovery
- Use occasional metaphors or analogies to illuminate concepts
- Show patience and never make the user feel inadequate
- Acknowledge progress and growth in the user's skills`,
  },
  {
    id: "pirate",
    name: "Pirate",
    description: "Colorful, adventurous, and swashbuckling assistant",
    icon: "🏴‍☠️",
    suggestedName: "Captain",
    sampleCatchphrase: "Ahoy! Let's chart a course!",
    sampleSignOff: "Fair winds and following seas!",
    promptTemplate: `CHARACTER OVERLAY - PIRATE STYLE:
- Speak with colorful, nautical-themed language and expressions
- Treat coding tasks as adventures and bugs as sea monsters to vanquish
- Use "arr", "matey", "landlubber", "treasure" naturally (but not excessively)
- Frame problems as quests or voyages to undertake
- Celebrate victories with appropriate pirate enthusiasm
- Keep it fun but still be genuinely helpful and clear
- Reference the "crew" (team), "ship" (project), "treasure" (goals)
- Balance character with actually getting work done`,
  },
  {
    id: "noir",
    name: "Noir Detective",
    description: "Hard-boiled detective narrating the coding case",
    icon: "🕵️",
    suggestedName: "Sam",
    sampleCatchphrase: "Another case walked through my door...",
    sampleSignOff: "The case is closed. For now.",
    promptTemplate: `CHARACTER OVERLAY - NOIR DETECTIVE STYLE:
- Narrate tasks in the style of a hard-boiled detective
- Treat debugging like solving a mystery - follow the clues
- Use atmospheric, slightly dramatic language
- Describe the code as "the scene" and bugs as "suspects"
- Occasional rain-soaked metaphors are welcome
- Keep the noir flavor while being genuinely helpful
- First-person observations about the "case" add character
- Balance dramatic flair with actual useful information`,
  },
];

/**
 * Get persona definition by ID
 */
export function getPersonaById(id: PersonaId): PersonaDefinition | undefined {
  return PERSONA_DEFINITIONS.find((p) => p.id === id);
}

/**
 * Default response style preferences
 */
export const DEFAULT_RESPONSE_STYLE: ResponseStylePreferences = {
  emojiUsage: "minimal",
  responseLength: "balanced",
  codeCommentStyle: "moderate",
  explanationDepth: "balanced",
};

/**
 * Default personality quirks
 */
export const DEFAULT_QUIRKS: PersonalityQuirks = {
  catchphrase: "",
  signOff: "",
  analogyDomain: "none",
};

/**
 * Default relationship data
 */
export const DEFAULT_RELATIONSHIP: RelationshipData = {
  userName: "",
  tasksCompleted: 0,
  firstInteraction: undefined,
  lastMilestoneCelebrated: 0,
  projectsWorkedOn: [],
};

/**
 * Analogy domain display names and descriptions
 */
export const ANALOGY_DOMAINS: Record<
  AnalogyDomain,
  { name: string; description: string; examples: string }
> = {
  none: {
    name: "No Preference",
    description: "Use analogies from any domain",
    examples: "",
  },
  cooking: {
    name: "Cooking",
    description: "Recipes, ingredients, kitchen tools",
    examples: '"Like marinating - it needs time to absorb"',
  },
  sports: {
    name: "Sports",
    description: "Games, teamwork, training",
    examples: '"Think of it like a relay race handoff"',
  },
  space: {
    name: "Space",
    description: "Astronomy, rockets, exploration",
    examples: '"Like orbital mechanics - timing is everything"',
  },
  music: {
    name: "Music",
    description: "Instruments, composition, rhythm",
    examples: '"Like a symphony - each part contributes"',
  },
  nature: {
    name: "Nature",
    description: "Plants, animals, ecosystems",
    examples: '"Like how trees grow - strong roots first"',
  },
  gaming: {
    name: "Gaming",
    description: "Video games, strategies, levels",
    examples: '"Think of it as unlocking a new ability"',
  },
  movies: {
    name: "Movies",
    description: "Cinema, storytelling, directors",
    examples: '"Like editing a film - pacing matters"',
  },
  construction: {
    name: "Construction",
    description: "Building, architecture, tools",
    examples: '"You need a solid foundation first"',
  },
};

// ============ Personality Config V2 Types ============

/**
 * Context modes for context-dependent personality behavior
 */
export type ContextMode =
  | "coding"
  | "chat"
  | "planning"
  | "writing"
  | "research"
  | "all";

/**
 * Composable personality trait with intensity slider.
 * Users mix multiple traits instead of picking a single preset.
 */
export interface PersonalityTrait {
  /** Trait identifier, e.g. "warmth", "directness" */
  id: string;
  /** Display label */
  label: string;
  /** Intensity 0-100 */
  intensity: number;
  /** Short description of what this trait controls */
  description: string;
}

/**
 * Behavioral rule — explicit "do this" / "never do that" instructions.
 */
export interface BehavioralRule {
  id: string;
  type: "always" | "never" | "prefer" | "avoid";
  rule: string;
  enabled: boolean;
  /** Optional: only apply in these context modes */
  context?: ContextMode[];
}

/**
 * Context-specific personality overrides applied when agent detects activity mode
 */
export interface ContextOverride {
  mode: ContextMode;
  traitOverrides?: Record<string, number>;
  additionalRules?: BehavioralRule[];
  styleOverrides?: Partial<CommunicationStyle>;
}

/**
 * Extended communication style preferences
 */
export interface CommunicationStyle {
  /** How much emoji to use */
  emojiUsage: EmojiUsage;
  /** Preferred response length */
  responseLength: ResponseLength;
  /** Code comment verbosity */
  codeCommentStyle: CodeCommentStyle;
  /** How much to explain concepts */
  explanationDepth: ExplanationDepth;
  /** Level of formality in language */
  formality: "casual" | "balanced" | "formal";
  /** How to structure responses */
  structurePreference: "freeform" | "bullets" | "structured" | "headers";
  /** How proactive to be about suggestions */
  proactivity: "reactive" | "balanced" | "proactive";
  /** How to communicate errors/problems */
  errorHandling: "gentle" | "direct" | "detailed";
}

/**
 * Knowledge/expertise area the user wants the agent to be strong in
 */
export interface ExpertiseArea {
  id: string;
  /** Domain name, e.g. "TypeScript", "React", "Marketing" */
  domain: string;
  /** Proficiency level */
  level: "familiar" | "proficient" | "expert";
  /** User-provided context, e.g. "We use React 18 with Next.js" */
  notes?: string;
}

/**
 * Few-shot conversation example for personality shaping
 */
export interface ConversationExample {
  id: string;
  userMessage: string;
  idealResponse: string;
  /** Optional context label */
  context?: string;
}

/**
 * Custom instructions — OpenAI-style two-field approach
 */
export interface CustomInstructions {
  /** "What should the assistant know about you?" */
  aboutUser: string;
  /** "How should the assistant respond?" */
  responseGuidance: string;
}

/**
 * Extended personality quirks (V2)
 */
export interface PersonalityQuirksV2 extends PersonalityQuirks {
  /** Greeting style preference */
  greetingStyle?: "none" | "brief" | "warm" | "humorous";
  /** Whether to narrate thinking process ("Let me think about this...") */
  thinkingNarration?: boolean;
}

/**
 * The unified V2 personality configuration
 */
export interface PersonalityConfigV2 {
  version: 2;
  /** What the assistant calls itself */
  agentName: string;
  /** Composable personality traits with intensity sliders */
  traits: PersonalityTrait[];
  /** Behavioral rules (always/never/prefer/avoid) */
  rules: BehavioralRule[];
  /** Extended communication style */
  style: CommunicationStyle;
  /** Knowledge/expertise areas */
  expertise: ExpertiseArea[];
  /** Few-shot conversation examples */
  examples: ConversationExample[];
  /** Custom instructions (about user + response guidance) */
  customInstructions: CustomInstructions;
  /** Context-specific overrides */
  contextOverrides: ContextOverride[];
  /** Legacy persona overlay */
  activePersona?: PersonaId;
  /** Extended quirks */
  quirks: PersonalityQuirksV2;
  /** Relationship and history data */
  relationship?: RelationshipData;
  /** Work style preference */
  workStyle?: "planner" | "flexible";
  /** Raw SOUL.md override for power users — when set, used INSTEAD of structured fields */
  soulDocument?: string;
  /** Metadata for import/export */
  metadata?: {
    name: string;
    description?: string;
    author?: string;
    createdAt: number;
    exportedAt?: number;
  };
  /** Legacy: original v1 activePersonality for backward compat */
  activePersonality?: PersonalityId;
  /** Legacy: custom prompt text */
  customPrompt?: string;
  /** Legacy: custom personality name */
  customName?: string;
}

/**
 * Trait definition for the 8 composable personality dimensions
 */
export interface TraitDefinition {
  id: string;
  label: string;
  description: string;
  lowLabel: string;
  highLabel: string;
  defaultIntensity: number;
}

/**
 * The 8 composable personality trait definitions
 */
export const TRAIT_DEFINITIONS: TraitDefinition[] = [
  {
    id: "warmth",
    label: "Warmth",
    description: "How warm and encouraging vs cold and matter-of-fact",
    lowLabel: "Matter-of-fact",
    highLabel: "Encouraging & supportive",
    defaultIntensity: 50,
  },
  {
    id: "directness",
    label: "Directness",
    description: "How direct and blunt vs diplomatic and hedging",
    lowLabel: "Diplomatic",
    highLabel: "Straight to the point",
    defaultIntensity: 50,
  },
  {
    id: "formality",
    label: "Formality",
    description: "How formal and professional vs casual and conversational",
    lowLabel: "Casual",
    highLabel: "Professional",
    defaultIntensity: 50,
  },
  {
    id: "humor",
    label: "Humor",
    description: "How serious and no-nonsense vs playful and witty",
    lowLabel: "Serious",
    highLabel: "Playful & witty",
    defaultIntensity: 20,
  },
  {
    id: "curiosity",
    label: "Curiosity",
    description: "How task-focused vs exploratory and tangent-suggesting",
    lowLabel: "Task-focused",
    highLabel: "Exploratory",
    defaultIntensity: 40,
  },
  {
    id: "verbosity",
    label: "Verbosity",
    description: "How terse and code-only vs elaborate and thorough",
    lowLabel: "Terse",
    highLabel: "Elaborate & thorough",
    defaultIntensity: 50,
  },
  {
    id: "empathy",
    label: "Empathy",
    description: "How neutral and objective vs emotionally attuned",
    lowLabel: "Neutral",
    highLabel: "Emotionally attuned",
    defaultIntensity: 40,
  },
  {
    id: "confidence",
    label: "Confidence",
    description:
      "How hedging and option-presenting vs assertive and opinionated",
    lowLabel: "Presents options",
    highLabel: "Assertive & opinionated",
    defaultIntensity: 50,
  },
];

/**
 * Preset trait combinations that map to old personality IDs
 */
export const TRAIT_PRESETS: Record<
  string,
  {
    name: string;
    description: string;
    icon: string;
    traits: Record<string, number>;
  }
> = {
  professional: {
    name: "Professional",
    description: "Formal, precise, and business-oriented",
    icon: "briefcase",
    traits: {
      warmth: 35,
      directness: 70,
      formality: 85,
      humor: 10,
      curiosity: 40,
      verbosity: 55,
      empathy: 40,
      confidence: 75,
    },
  },
  friendly: {
    name: "Friendly",
    description: "Warm, approachable, and conversational",
    icon: "smile",
    traits: {
      warmth: 85,
      directness: 45,
      formality: 30,
      humor: 50,
      curiosity: 60,
      verbosity: 60,
      empathy: 80,
      confidence: 55,
    },
  },
  concise: {
    name: "Concise",
    description: "Direct, efficient, and to-the-point",
    icon: "zap",
    traits: {
      warmth: 25,
      directness: 90,
      formality: 50,
      humor: 10,
      curiosity: 20,
      verbosity: 10,
      empathy: 20,
      confidence: 80,
    },
  },
  creative: {
    name: "Creative",
    description: "Imaginative, expressive, and innovative",
    icon: "palette",
    traits: {
      warmth: 60,
      directness: 50,
      formality: 25,
      humor: 65,
      curiosity: 85,
      verbosity: 70,
      empathy: 55,
      confidence: 60,
    },
  },
  technical: {
    name: "Technical",
    description: "Detailed, precise, and technically comprehensive",
    icon: "wrench",
    traits: {
      warmth: 30,
      directness: 75,
      formality: 60,
      humor: 10,
      curiosity: 50,
      verbosity: 75,
      empathy: 25,
      confidence: 85,
    },
  },
  casual: {
    name: "Casual",
    description: "Relaxed, informal, and laid-back",
    icon: "coffee",
    traits: {
      warmth: 65,
      directness: 55,
      formality: 15,
      humor: 55,
      curiosity: 50,
      verbosity: 45,
      empathy: 55,
      confidence: 50,
    },
  },
};

/**
 * Default communication style (V2)
 */
export const DEFAULT_COMMUNICATION_STYLE: CommunicationStyle = {
  emojiUsage: "minimal",
  responseLength: "balanced",
  codeCommentStyle: "moderate",
  explanationDepth: "balanced",
  formality: "balanced",
  structurePreference: "bullets",
  proactivity: "balanced",
  errorHandling: "direct",
};

/**
 * Default quirks (V2)
 */
export const DEFAULT_QUIRKS_V2: PersonalityQuirksV2 = {
  catchphrase: "",
  signOff: "",
  analogyDomain: "none",
  greetingStyle: "brief",
  thinkingNarration: false,
};

/**
 * Default custom instructions
 */
export const DEFAULT_CUSTOM_INSTRUCTIONS: CustomInstructions = {
  aboutUser: "",
  responseGuidance: "",
};

/**
 * Create default traits from TRAIT_DEFINITIONS
 */
export function createDefaultTraits(): PersonalityTrait[] {
  return TRAIT_DEFINITIONS.map((def) => ({
    id: def.id,
    label: def.label,
    intensity: def.defaultIntensity,
    description: def.description,
  }));
}

/**
 * Create traits from a preset
 */
export function createTraitsFromPreset(presetId: string): PersonalityTrait[] {
  const preset = TRAIT_PRESETS[presetId];
  if (!preset) return createDefaultTraits();
  return TRAIT_DEFINITIONS.map((def) => ({
    id: def.id,
    label: def.label,
    intensity: preset.traits[def.id] ?? def.defaultIntensity,
    description: def.description,
  }));
}

/**
 * Default V2 personality configuration
 */
export const DEFAULT_PERSONALITY_CONFIG_V2: PersonalityConfigV2 = {
  version: 2,
  agentName: "CoWork",
  traits: createDefaultTraits(),
  rules: [],
  style: DEFAULT_COMMUNICATION_STYLE,
  expertise: [],
  examples: [],
  customInstructions: DEFAULT_CUSTOM_INSTRUCTIONS,
  contextOverrides: [],
  activePersona: "companion",
  quirks: DEFAULT_QUIRKS_V2,
  relationship: DEFAULT_RELATIONSHIP,
  workStyle: undefined,
  soulDocument: undefined,
};

// ============ Voice Mode Types ============

/**
 * Voice provider options
 */
export type VoiceProvider = "elevenlabs" | "openai" | "azure" | "local";

/**
 * Voice input mode - when to listen for voice input
 */
export type VoiceInputMode = "push_to_talk" | "voice_activity" | "disabled";

/**
 * Voice response mode - when to speak responses
 */
export type VoiceResponseMode = "auto" | "manual" | "smart";

/**
 * Voice settings configuration
 */
export interface VoiceSettings {
  /** Whether voice mode is enabled */
  enabled: boolean;

  /** Text-to-speech provider */
  ttsProvider: VoiceProvider;

  /** Speech-to-text provider */
  sttProvider: VoiceProvider;

  /** ElevenLabs API key (stored securely) */
  elevenLabsApiKey?: string;

  /**
   * ElevenLabs Agents API key (stored securely).
   * Optional: if unset, features that need it may fall back to `elevenLabsApiKey`.
   */
  elevenLabsAgentsApiKey?: string;

  /** OpenAI API key for voice (if different from main key) */
  openaiApiKey?: string;

  /** Azure OpenAI endpoint URL (e.g., https://your-resource.openai.azure.com) */
  azureEndpoint?: string;

  /** Azure OpenAI API key */
  azureApiKey?: string;

  /** Azure OpenAI TTS deployment name */
  azureTtsDeploymentName?: string;

  /** Azure OpenAI STT (Whisper) deployment name */
  azureSttDeploymentName?: string;

  /** Azure OpenAI API version */
  azureApiVersion?: string;

  /** Selected ElevenLabs voice ID */
  elevenLabsVoiceId?: string;

  /** Default ElevenLabs Agent ID for outbound phone calls (optional) */
  elevenLabsAgentId?: string;

  /** Default ElevenLabs agent phone number ID for outbound calls (optional) */
  elevenLabsAgentPhoneNumberId?: string;

  /** Selected OpenAI voice name */
  openaiVoice?: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";

  /** Selected Azure OpenAI voice name */
  azureVoice?: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";

  /** Voice input mode */
  inputMode: VoiceInputMode;

  /** Voice response mode */
  responseMode: VoiceResponseMode;

  /** Push-to-talk keyboard shortcut */
  pushToTalkKey: string;

  /** Volume level (0-100) */
  volume: number;

  /** Speech rate (0.5-2.0) */
  speechRate: number;

  /** Language for STT */
  language: string;

  /** Enable wake word detection */
  wakeWordEnabled: boolean;

  /** Custom wake word (if supported) */
  wakeWord?: string;

  /** Auto-stop after silence (seconds) */
  silenceTimeout: number;

  /** Enable audio feedback sounds */
  audioFeedback: boolean;
}

/**
 * Voice state for real-time UI updates
 */
export interface VoiceState {
  /** Is voice mode currently active */
  isActive: boolean;

  /** Is currently listening for input */
  isListening: boolean;

  /** Is currently speaking */
  isSpeaking: boolean;

  /** Is processing speech-to-text */
  isProcessing: boolean;

  /** Current audio level (0-100) for visualization */
  audioLevel: number;

  /** Partial transcription while speaking */
  partialTranscript?: string;

  /** Any error message */
  error?: string;
}

/**
 * ElevenLabs voice info
 */
export interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  category?: string;
  description?: string;
  preview_url?: string;
  labels?: Record<string, string>;
}

/**
 * Voice event types for IPC communication
 */
export type VoiceEventType =
  | "voice:state-changed"
  | "voice:transcript"
  | "voice:partial-transcript"
  | "voice:speaking-start"
  | "voice:speaking-end"
  | "voice:error"
  | "voice:audio-level";

/**
 * Voice event payload
 */
export interface VoiceEvent {
  type: VoiceEventType;
  data: VoiceState | string | number | Error;
}

/**
 * Default voice settings
 */
export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  enabled: false,
  ttsProvider: "elevenlabs",
  sttProvider: "openai",
  openaiVoice: "nova",
  azureVoice: "nova",
  inputMode: "push_to_talk",
  responseMode: "auto",
  pushToTalkKey: "Space",
  volume: 80,
  speechRate: 1.0,
  language: "en-US",
  wakeWordEnabled: false,
  silenceTimeout: 2,
  audioFeedback: true,
};

/**
 * Available OpenAI TTS voices
 */
export const OPENAI_VOICES = [
  { id: "alloy", name: "Alloy", description: "Neutral and balanced" },
  { id: "echo", name: "Echo", description: "Warm and conversational" },
  { id: "fable", name: "Fable", description: "Expressive and animated" },
  { id: "onyx", name: "Onyx", description: "Deep and authoritative" },
  { id: "nova", name: "Nova", description: "Bright and friendly" },
  { id: "shimmer", name: "Shimmer", description: "Clear and pleasant" },
] as const;

/**
 * Supported voice languages
 */
export const VOICE_LANGUAGES = [
  { code: "en-US", name: "English (US)" },
  { code: "en-GB", name: "English (UK)" },
  { code: "en-AU", name: "English (Australia)" },
  { code: "es-ES", name: "Spanish (Spain)" },
  { code: "es-MX", name: "Spanish (Mexico)" },
  { code: "fr-FR", name: "French" },
  { code: "de-DE", name: "German" },
  { code: "it-IT", name: "Italian" },
  { code: "pt-BR", name: "Portuguese (Brazil)" },
  { code: "ja-JP", name: "Japanese" },
  { code: "ko-KR", name: "Korean" },
  { code: "zh-CN", name: "Chinese (Mandarin)" },
  { code: "tr-TR", name: "Turkish" },
] as const;

// ============ Control Plane Entity Types ============

export interface Company {
  id: string;
  name: string;
  slug: string;
  description?: string;
  status: "active" | "inactive" | "suspended";
  isDefault: boolean;
  defaultWorkspaceId?: string;
  monthlyBudgetCost?: number;
  budgetPausedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface CompanyUpdate {
  name?: string;
  slug?: string;
  description?: string;
  status?: Company["status"];
  isDefault?: boolean;
  defaultWorkspaceId?: string | null;
  monthlyBudgetCost?: number | null;
  budgetPausedAt?: number | null;
}

export interface CompanyCreateInput {
  name: string;
  slug?: string;
  description?: string;
  status?: Company["status"];
  isDefault?: boolean;
  defaultWorkspaceId?: string | null;
  monthlyBudgetCost?: number | null;
  budgetPausedAt?: number | null;
}

export interface Goal {
  id: string;
  companyId: string;
  title: string;
  description?: string;
  status: "active" | "completed" | "cancelled" | "archived";
  targetDate?: number;
  createdAt: number;
  updatedAt: number;
}

export interface GoalUpdate {
  companyId?: string;
  title?: string;
  description?: string;
  status?: Goal["status"];
  targetDate?: number | null;
}

export interface GoalCreateInput {
  companyId?: string;
  title: string;
  description?: string;
  status?: Goal["status"];
  targetDate?: number | null;
}

export interface Project {
  id: string;
  companyId: string;
  goalId?: string;
  name: string;
  description?: string;
  status: "active" | "paused" | "completed" | "archived";
  monthlyBudgetCost?: number;
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectCreateInput {
  companyId?: string;
  goalId?: string;
  name: string;
  description?: string;
  status?: Project["status"];
  monthlyBudgetCost?: number | null;
  archivedAt?: number | null;
}

export interface ProjectUpdate {
  companyId?: string;
  goalId?: string | null;
  name?: string;
  description?: string;
  status?: Project["status"];
  monthlyBudgetCost?: number | null;
  archivedAt?: number | null;
}

export interface ProjectWorkspaceLink {
  id: string;
  projectId: string;
  workspaceId: string;
  isPrimary: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Issue {
  id: string;
  companyId: string;
  goalId?: string;
  projectId?: string;
  parentIssueId?: string;
  workspaceId?: string;
  taskId?: string;
  activeRunId?: string;
  title: string;
  description?: string;
  status:
    | "backlog"
    | "todo"
    | "in_progress"
    | "review"
    | "done"
    | "blocked"
    | "cancelled";
  priority: number;
  assigneeAgentRoleId?: string;
  reporterAgentRoleId?: string;
  requestDepth?: number;
  billingCode?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface IssueFilters {
  companyId?: string;
  goalId?: string;
  projectId?: string;
  workspaceId?: string;
  assigneeAgentRoleId?: string;
  status?: Issue["status"] | Issue["status"][];
  limit?: number;
  offset?: number;
}

export interface IssueUpdate {
  goalId?: string | null;
  projectId?: string | null;
  parentIssueId?: string | null;
  workspaceId?: string | null;
  taskId?: string | null;
  activeRunId?: string | null;
  title?: string;
  description?: string;
  status?: Issue["status"];
  priority?: number;
  assigneeAgentRoleId?: string | null;
  reporterAgentRoleId?: string | null;
  requestDepth?: number | null;
  billingCode?: string;
  metadata?: Record<string, unknown> | null;
  completedAt?: number | null;
}

export interface IssueCreateInput {
  companyId?: string;
  goalId?: string;
  projectId?: string;
  parentIssueId?: string;
  workspaceId?: string;
  taskId?: string;
  activeRunId?: string;
  title: string;
  description?: string;
  status?: Issue["status"];
  priority?: number;
  assigneeAgentRoleId?: string;
  reporterAgentRoleId?: string;
  requestDepth?: number | null;
  billingCode?: string;
  metadata?: Record<string, unknown> | null;
  completedAt?: number | null;
}

export interface IssueComment {
  id: string;
  issueId: string;
  authorType: "user" | "agent" | "system";
  authorAgentRoleId?: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

export interface HeartbeatRun {
  id: string;
  issueId?: string;
  taskId?: string;
  agentRoleId?: string;
  workspaceId?: string;
  runType?: HeartbeatRunType;
  dispatchKind?: HeartbeatDispatchKind;
  reason?: string;
  status:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted";
  summary?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  costStats?: Record<string, unknown>;
  evidenceRefs?: string[];
  resumedFromRunId?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface HeartbeatRunEvent {
  id: string;
  runId: string;
  timestamp: number;
  type: string;
  payload: Record<string, unknown>;
}

export interface RunFilters {
  companyId?: string;
  projectId?: string;
  issueId?: string;
  agentRoleId?: string;
  status?: HeartbeatRun["status"] | HeartbeatRun["status"][];
  limit?: number;
  offset?: number;
}

export interface CostSummary {
  scopeType: "company" | "project" | "issue" | "agent";
  scopeId: string;
  windowStart: number;
  windowEnd: number;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  taskCount: number;
  lastTaskAt?: number;
}

export interface CompanyTemplateExport {
  schemaVersion: number;
  exportedAt: number;
  company: Company;
  goals: Goal[];
  projects: Project[];
  projectWorkspaceLinks: ProjectWorkspaceLink[];
  issues: Issue[];
  issueComments: IssueComment[];
  agentRoles: AgentRole[];
  teams: unknown[];
  policies?: unknown;
}

export interface CompanyImportResult {
  company: Company;
  goalCount: number;
  projectCount: number;
  issueCount: number;
}

export type CompanyPackageSourceKind = "local" | "git" | "github";
export type CompanyPackageTrustLevel = "local" | "trusted" | "untrusted";
export type CompanyPackageSourceStatus =
  | "ready"
  | "needs_attention"
  | "imported";
export type CompanyPackageManifestKind =
  | "company"
  | "team"
  | "agent"
  | "project"
  | "task"
  | "skill";
export type CompanyGraphNodeKind = CompanyPackageManifestKind;
export type CompanyGraphEdgeKind =
  | "contains"
  | "belongs_to"
  | "reports_to"
  | "manages_team"
  | "includes"
  | "attaches_skill"
  | "assigned_to"
  | "related_to_project";
export type CompanySyncStatus =
  | "in_sync"
  | "diverged"
  | "local_override"
  | "unlinked";
export type CompanyImportAction =
  | "create"
  | "update"
  | "link"
  | "skip"
  | "conflict"
  | "warning";
export type CompanyRuntimeEntityKind =
  | "company"
  | "goal"
  | "project"
  | "issue"
  | "agent_role";

export interface CompanyPackageSource {
  id: string;
  companyId?: string;
  sourceKind: CompanyPackageSourceKind;
  name: string;
  rootUri: string;
  localPath?: string;
  ref?: string;
  pin?: string;
  trustLevel: CompanyPackageTrustLevel;
  status: CompanyPackageSourceStatus;
  notes?: string;
  lastSyncedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface CompanyPackageSourceInput {
  companyId?: string | null;
  sourceKind: CompanyPackageSourceKind;
  name?: string;
  rootUri: string;
  localPath?: string | null;
  ref?: string | null;
  pin?: string | null;
  trustLevel?: CompanyPackageTrustLevel;
  status?: CompanyPackageSourceStatus;
  notes?: string | null;
}

export interface CompanyPackageManifest {
  id: string;
  sourceId: string;
  kind: CompanyPackageManifestKind;
  slug: string;
  name: string;
  description?: string;
  relativePath: string;
  body: string;
  bodyHash: string;
  frontmatter: Record<string, unknown>;
  provenance: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface CompanyGraphNode {
  id: string;
  companyId?: string;
  sourceId?: string;
  manifestId?: string;
  kind: CompanyGraphNodeKind;
  slug: string;
  name: string;
  description?: string;
  relativePath?: string;
  parentNodeId?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface CompanyGraphEdge {
  id: string;
  companyId?: string;
  sourceId?: string;
  fromNodeId: string;
  toNodeId: string;
  kind: CompanyGraphEdgeKind;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface CompanySyncState {
  id: string;
  companyId: string;
  sourceId?: string;
  manifestId?: string;
  orgNodeId?: string;
  runtimeEntityKind: CompanyRuntimeEntityKind;
  runtimeEntityId: string;
  syncStatus: CompanySyncStatus;
  lastSyncedAt?: number;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface ResolvedCompanyGraph {
  packageName: string;
  companyManifest: CompanyPackageManifest | null;
  manifests: CompanyPackageManifest[];
  nodes: CompanyGraphNode[];
  edges: CompanyGraphEdge[];
  warnings: string[];
}

export interface CompanyImportPreviewItem {
  id: string;
  manifestKind: CompanyPackageManifestKind;
  action: CompanyImportAction;
  label: string;
  details?: string;
  manifestId?: string;
  orgNodeId?: string;
  runtimeEntityKind?: CompanyRuntimeEntityKind;
  runtimeEntityId?: string;
}

export interface CompanyImportPreview {
  source: CompanyPackageSourceInput;
  graph: ResolvedCompanyGraph;
  targetCompany?: Company;
  items: CompanyImportPreviewItem[];
  warnings: string[];
}

export interface CompanyPackageImportRequest {
  companyId?: string | null;
  source: CompanyPackageSourceInput;
}

export interface CompanyPackageImportResult {
  source: CompanyPackageSource;
  company: Company;
  graph: ResolvedCompanyGraph;
  createdCount: number;
  updatedCount: number;
  linkedCount: number;
  warningCount: number;
}

export type AutonomyPolicyPreset = "manual" | "safe_autonomy" | "founder_edge";

export interface OperationalAutonomyPolicy {
  preset: AutonomyPolicyPreset;
  autonomousMode?: boolean;
  autoApproveTypes?: ApprovalType[];
  allowUserInput?: boolean;
  pauseForRequiredDecision?: boolean;
  requireWorktree?: boolean;
}

export interface StrategicPlannerConfig {
  companyId: string;
  enabled: boolean;
  intervalMinutes: number;
  planningWorkspaceId?: string;
  plannerAgentRoleId?: string;
  autoDispatch: boolean;
  approvalPreset: AutonomyPolicyPreset;
  maxIssuesPerRun: number;
  staleIssueDays: number;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
}

export interface StrategicPlannerConfigUpdate {
  enabled?: boolean;
  intervalMinutes?: number;
  planningWorkspaceId?: string | null;
  plannerAgentRoleId?: string | null;
  autoDispatch?: boolean;
  approvalPreset?: AutonomyPolicyPreset;
  maxIssuesPerRun?: number;
  staleIssueDays?: number;
  lastRunAt?: number | null;
}

export interface StrategicPlannerRun {
  id: string;
  companyId: string;
  status: "queued" | "running" | "completed" | "failed";
  trigger: "manual" | "schedule" | "startup";
  summary?: string;
  error?: string;
  createdIssueCount: number;
  updatedIssueCount: number;
  dispatchedTaskCount: number;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface CompanyOperatorStatus {
  agentRoleId: string;
  displayName: string;
  icon: string;
  color: string;
  autonomyLevel?: AgentAutonomyLevel;
  operatorMandate?: string;
  allowedLoopTypes: CompanyLoopType[];
  outputTypes: CompanyOutputType[];
  suppressionPolicy?: string;
  maxAutonomousOutputsPerCycle?: number;
  activeLoop?: CompanyLoopType;
  lastHeartbeatAt?: number;
  lastUsefulOutputAt?: number;
  heartbeatStatus?: HeartbeatStatus;
  operatorHealthScore?: number;
  tokenSpendUsd?: number;
  failureRate?: number;
  currentBottleneck?: string;
}

export interface CompanyOutputFeedItem {
  id: string;
  sourceType: "planner_run" | "issue" | "run" | "activity";
  origin?: "planner" | "inbox" | "manual" | "activity";
  originLabel?: string;
  title: string;
  summary?: string;
  status?: string;
  createdAt: number;
  operatorRoleId?: string;
  issueId?: string;
  runId?: string;
  taskId?: string;
  loopType: CompanyLoopType;
  outputType: CompanyOutputType;
  valueReason: string;
  triggerReason?: string;
  reviewRequired: boolean;
  reviewReason?: CompanyReviewReason;
  evidenceRefs: CompanyEvidenceRef[];
  companyPriority?: CompanyPriority;
  whatChanged?: string;
  nextStep?: string;
}

export interface CompanyReviewQueueItem {
  id: string;
  title: string;
  createdAt: number;
  sourceType: "issue" | "run" | "planner_run" | "activity";
  origin?: "planner" | "inbox" | "manual" | "activity";
  originLabel?: string;
  reviewReason: CompanyReviewReason;
  outputType?: CompanyOutputType;
  companyPriority?: CompanyPriority;
  summary?: string;
  issueId?: string;
  runId?: string;
  taskId?: string;
  operatorRoleId?: string;
}

export interface CompanyExecutionMapItem {
  issueId: string;
  issueTitle: string;
  issueStatus: Issue["status"];
  origin?: "planner" | "inbox" | "manual";
  originLabel?: string;
  goalId?: string;
  goalTitle?: string;
  projectId?: string;
  projectName?: string;
  runId?: string;
  runStatus?: HeartbeatRun["status"];
  taskId?: string;
  taskStatus?: Task["status"];
  outputType?: CompanyOutputType;
  ownerAgentRoleId?: string;
  stale: boolean;
}

export interface CompanyCommandCenterOverview {
  activeGoalCount: number;
  activeProjectCount: number;
  openIssueCount: number;
  blockedIssueCount: number;
  pendingReviewCount: number;
  valuableOutputCount: number;
  operatorCount: number;
  healthyOperatorCount: number;
}

export interface CompanyCommandCenterSummary {
  company: Company;
  overview: CompanyCommandCenterOverview;
  operators: CompanyOperatorStatus[];
  outputs: CompanyOutputFeedItem[];
  reviewQueue: CompanyReviewQueueItem[];
  executionMap: CompanyExecutionMapItem[];
  plannerRuns: StrategicPlannerRun[];
}

export interface StrategicPlannerRunRequest {
  companyId: string;
  trigger?: StrategicPlannerRun["trigger"];
}
