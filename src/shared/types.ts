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

export interface AppearanceSettings {
  themeMode: ThemeMode;
  visualTheme: VisualTheme;
  accentColor: AccentColor;
  uiDensity?: UiDensity;
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
}

// Global memory feature toggles (applies across workspaces)
export interface MemoryFeaturesSettings {
  /** Inject `.cowork/*` context pack into the agent prompt (workspace-scoped files). */
  contextPackInjectionEnabled: boolean;
  /** Allow the heartbeat system to perform memory maintenance tasks. */
  heartbeatMaintenanceEnabled: boolean;
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
export interface WorkspaceKitFileStatus {
  relPath: string;
  exists: boolean;
  sizeBytes?: number;
  modifiedAt?: number;
}

export interface WorkspaceKitStatus {
  workspaceId: string;
  workspacePath?: string;
  hasKitDir: boolean;
  files: WorkspaceKitFileStatus[];
  missingCount: number;
}

export type WorkspaceKitInitMode = "missing" | "overwrite";

export interface WorkspaceKitInitRequest {
  workspaceId: string;
  mode?: WorkspaceKitInitMode;
}

export interface WorkspaceKitProjectCreateRequest {
  workspaceId: string;
  projectId: string;
}

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
  | "file_created"
  | "file_modified"
  | "file_deleted"
  | "image_generated"
  | "error"
  | "log"
  | "verification_started"
  | "verification_passed"
  | "verification_failed"
  | "retry_started"
  | "task_cancelled"
  | "task_paused"
  | "task_resumed"
  | "task_interrupted"
  | "task_status"
  | "task_queued"
  | "task_dequeued"
  | "queue_updated"
  | "plan_revision_blocked"
  | "step_timeout"
  | "tool_blocked"
  | "progress_update"
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
  // Real-time streaming progress (ephemeral, not persisted to DB)
  | "llm_streaming"
  // Sub-Agent / Parallel Agent events
  | "agent_spawned" // Parent spawned a child agent
  | "agent_completed" // Child agent completed successfully
  | "agent_failed" // Child agent failed
  | "sub_agent_result" // Result summary from child agent
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
  | "synthesis_completed"; // Leader completed synthesis

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
  // Meta tools
  | "revise_plan"
  | "task_history"
  | "task_events";

export type ApprovalType =
  | "delete_file"
  | "delete_multiple"
  | "bulk_rename"
  | "network_access"
  | "external_service"
  | "run_command";

// ============ Security Tool Groups & Risk Levels ============

/**
 * Tool risk levels for security policy enforcement
 * Higher levels require more permissions/approval
 */
export type ToolRiskLevel = "read" | "write" | "destructive" | "system" | "network";

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
    "edit_document",
    "create_presentation",
    "organize_folder",
    // Monty transform library can write transformed outputs
    "monty_transform_file",
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
    // Scraping (Scrapling integration)
    "scrape_page",
    "scrape_multiple",
    "scrape_extract",
    "scrape_session",
    "scraping_status",
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
    // Privacy-sensitive: can exfiltrate local files/images to a provider
    "analyze_image",
    // Agent-initiated memory save
    "memory_save",
  ],
  // Image generation - requires API access
  "group:image": ["generate_image"],
  // Meta/control tools
  "group:meta": ["revise_plan"],
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
  // Memory
  memory_save: "write",
  // Meta
  revise_plan: "read",
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

/**
 * Per-task agent configuration for customizing LLM and personality
 * Allows spawning agents with different models/personalities than the global settings
 */
export interface AgentConfig {
  /** Override the LLM provider type (e.g., 'anthropic', 'gemini') */
  providerType?: LLMProviderType;
  /** Override the model key (e.g., 'opus-4-5', 'sonnet-4-5', 'haiku-4-5') */
  modelKey?: string;
  /** Override the personality for this agent */
  personalityId?: PersonalityId;
  /** Gateway context for context-aware tool restrictions (e.g., memory isolation in group/public chats) */
  gatewayContext?: GatewayContextType;
  /** Additional tool restrictions for this task (e.g., per-channel DM/group policies) */
  toolRestrictions?: string[];
  /** Optional origin channel that created the task (used for channel-aware gating) */
  originChannel?: ChannelType;
  /** Maximum number of LLM turns before forcing completion (for sub-agents) */
  maxTurns?: number;
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
  /** Whether to run with reduced friction in autonomous mode (auto-approve approval-gated tools) */
  autonomousMode?: boolean;
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
  /** Spawn an independent verification agent after task completion to audit deliverables */
  verificationAgent?: boolean;
  /** Whether to emit a pre-flight problem framing before execution (set by strategy service) */
  preflightRequired?: boolean;
}

/** Specification for one LLM participant in a multi-LLM run */
export interface MultiLlmParticipant {
  providerType: LLMProviderType;
  modelKey: string;
  displayName: string;
  isJudge: boolean;
}

/** Config for multi-LLM mode: participants and judge designation */
export interface MultiLlmConfig {
  participants: MultiLlmParticipant[];
  judgeProviderType: LLMProviderType;
  judgeModelKey: string;
}

export interface Task {
  id: string;
  title: string;
  prompt: string;
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
}

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

export interface TaskEvent {
  id: string;
  taskId: string;
  timestamp: number;
  type: EventType;
  payload: any;
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

export interface PlanStep {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

export interface Plan {
  steps: PlanStep[];
  description: string;
}

export interface ToolCall {
  id: string;
  tool: ToolType;
  parameters: any;
  timestamp: number;
}

export interface ToolResult {
  callId: string;
  success: boolean;
  result?: any;
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
    properties: Record<string, any>;
    required: string[];
  };
  riskLevel: "read" | "write";
  groups: readonly string[];
  handler: (params: any) => Promise<NodeToolResult>;
}

export interface ApprovalRequest {
  id: string;
  taskId: string;
  type: ApprovalType;
  description: string;
  details: any;
  status: "pending" | "approved" | "denied";
  requestedAt: number;
  resolvedAt?: number;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  category: "document" | "spreadsheet" | "presentation" | "organizer" | "custom";
  prompt: string;
  scriptPath?: string;
  parameters?: Record<string, any>;
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

/**
 * Agent role defines a specialized agent with specific capabilities and configuration
 */
export interface AgentRole {
  id: string;
  name: string; // Unique identifier (e.g., 'code-reviewer')
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

  // Mission Control fields
  autonomyLevel?: AgentAutonomyLevel; // How independently the agent can act
  soul?: string; // Extended personality (JSON: communication style, focus areas, preferences)
  heartbeatEnabled?: boolean; // Whether agent participates in heartbeat system
  heartbeatIntervalMinutes?: number; // How often agent wakes up (default: 15)
  heartbeatStaggerOffset?: number; // Offset in minutes to stagger wakeups
  lastHeartbeatAt?: number; // Timestamp of last heartbeat
  heartbeatStatus?: HeartbeatStatus; // Current heartbeat state
}

/**
 * Request to create a new agent role
 */
export interface CreateAgentRoleRequest {
  name: string;
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
  // Mission Control fields
  autonomyLevel?: AgentAutonomyLevel;
  soul?: string;
  heartbeatEnabled?: boolean;
  heartbeatIntervalMinutes?: number;
  heartbeatStaggerOffset?: number;
}

/**
 * Request to update an agent role
 */
export interface UpdateAgentRoleRequest {
  id: string;
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
  // Mission Control fields
  autonomyLevel?: AgentAutonomyLevel;
  soul?: string;
  heartbeatEnabled?: boolean;
  heartbeatIntervalMinutes?: number;
  heartbeatStaggerOffset?: number;
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

export type AgentTeamRunPhase = "dispatch" | "think" | "synthesize" | "complete";

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

export type AgentTeamItemStatus = "todo" | "in_progress" | "blocked" | "done" | "failed";

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
  type: "team_thought_added" | "team_thought_updated" | "team_thought_streaming";
  timestamp: number;
  runId: string;
  thought: AgentThought;
}

/**
 * Default agent roles that come pre-configured
 */
export const DEFAULT_AGENT_ROLES: Omit<AgentRole, "id" | "createdAt" | "updatedAt">[] = [
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
    description: "Investigates solutions, analyzes options, and gathers information",
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
    description: "Coordinates tasks, tracks progress, manages timelines and team workload",
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
    description: "Handles user queries, troubleshooting, customer communication",
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
    description: "Manages CI/CD pipelines, deployment, infrastructure and monitoring",
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
    description: "Performs security audits, vulnerability assessments, compliance checks",
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
    description: "Versatile helper for miscellaneous tasks, scheduling, and coordination",
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

  heartbeat: {
    enabled: boolean;
    intervalMinutes: number;
    staggerOffset: number;
  };

  cognitiveOffload: {
    primaryCategories: CognitiveOffloadCategory[];
    proactiveTasks: ProactiveTaskDefinition[];
  };

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
    displayName?: string;
    icon?: string;
    color?: string;
    modelKey?: string;
    providerType?: LLMProviderType;
    heartbeatIntervalMinutes?: number;
    enabledProactiveTasks?: string[];
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

/**
 * Result from a heartbeat check
 */
export interface HeartbeatResult {
  agentRoleId: string;
  status: "ok" | "work_done" | "error";
  pendingMentions: number;
  assignedTasks: number;
  relevantActivities: number;
  taskCreated?: string; // ID of task created if work was done
  error?: string;
}

/**
 * Heartbeat configuration for an agent
 */
export interface HeartbeatConfig {
  heartbeatEnabled?: boolean;
  heartbeatIntervalMinutes?: number;
  heartbeatStaggerOffset?: number;
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
    | "wake_immediate_deferred";
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
}

/**
 * Board column for task organization (Kanban)
 */
export type BoardColumn = "backlog" | "todo" | "in_progress" | "review" | "done";

/**
 * Board column definitions for UI
 */
export const BOARD_COLUMNS: { id: BoardColumn; label: string; color: string }[] = [
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
export type MentionStatus = "pending" | "acknowledged" | "completed" | "dismissed";

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

export type InfraProviderStatus = "connected" | "disconnected" | "error" | "not_configured";

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
  };
  payments: {
    requireApproval: boolean;
    maxAutoApproveUsd: number;
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
  },
  payments: {
    requireApproval: true,
    maxAutoApproveUsd: 1.0,
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
  TASK_RENAME: "task:rename",
  TASK_DELETE: "task:delete",

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

  // Mission Control - Heartbeat System
  HEARTBEAT_GET_CONFIG: "heartbeat:getConfig",
  HEARTBEAT_UPDATE_CONFIG: "heartbeat:updateConfig",
  HEARTBEAT_TRIGGER: "heartbeat:trigger",
  HEARTBEAT_GET_STATUS: "heartbeat:getStatus",
  HEARTBEAT_GET_ALL_STATUS: "heartbeat:getAllStatus",
  HEARTBEAT_EVENT: "heartbeat:event",

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

  // Mission Control - Agent Performance Reviews
  REVIEW_GENERATE: "review:generate",
  REVIEW_GET_LATEST: "review:getLatest",
  REVIEW_LIST: "review:list",
  REVIEW_DELETE: "review:delete",

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

  // Admin Policies
  ADMIN_POLICIES_GET: "admin:policiesGet",
  ADMIN_POLICIES_UPDATE: "admin:policiesUpdate",
  ADMIN_POLICIES_CHECK_PACK: "admin:checkPack",

  // Workspace Kit (.cowork)
  KIT_GET_STATUS: "kit:getStatus",
  KIT_INIT: "kit:init",
  KIT_PROJECT_CREATE: "kit:projectCreate",

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
  TASK_SEND_MESSAGE: "task:sendMessage",
  TASK_SEND_STDIN: "task:sendStdin", // Send stdin input to running command
  TASK_KILL_COMMAND: "task:killCommand", // Kill running command (Ctrl+C)

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

  // Skill Registry (SkillHub)
  SKILL_REGISTRY_SEARCH: "skillRegistry:search",
  SKILL_REGISTRY_GET_DETAILS: "skillRegistry:getDetails",
  SKILL_REGISTRY_INSTALL: "skillRegistry:install",
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
  LLM_TEST_PROVIDER: "llm:testProvider",
  LLM_GET_MODELS: "llm:getModels",
  LLM_GET_CONFIG_STATUS: "llm:getConfigStatus",
  LLM_SET_MODEL: "llm:setModel",
  LLM_GET_OLLAMA_MODELS: "llm:getOllamaModels",
  LLM_GET_GEMINI_MODELS: "llm:getGeminiModels",
  LLM_GET_OPENROUTER_MODELS: "llm:getOpenRouterModels",
  LLM_GET_OPENAI_MODELS: "llm:getOpenAIModels",
  LLM_GET_GROQ_MODELS: "llm:getGroqModels",
  LLM_GET_XAI_MODELS: "llm:getXAIModels",
  LLM_GET_KIMI_MODELS: "llm:getKimiModels",
  LLM_GET_PI_MODELS: "llm:getPiModels",
  LLM_GET_PI_PROVIDERS: "llm:getPiProviders",
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

  // Dropbox Settings
  DROPBOX_GET_SETTINGS: "dropbox:getSettings",
  DROPBOX_SAVE_SETTINGS: "dropbox:saveSettings",
  DROPBOX_TEST_CONNECTION: "dropbox:testConnection",
  DROPBOX_GET_STATUS: "dropbox:getStatus",

  // SharePoint Settings
  SHAREPOINT_GET_SETTINGS: "sharepoint:getSettings",
  SHAREPOINT_SAVE_SETTINGS: "sharepoint:saveSettings",
  SHAREPOINT_TEST_CONNECTION: "sharepoint:testConnection",
  SHAREPOINT_GET_STATUS: "sharepoint:getStatus",

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

  // Appearance
  APPEARANCE_GET_SETTINGS: "appearance:getSettings",
  APPEARANCE_SAVE_SETTINGS: "appearance:saveSettings",

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
  CRON_ADD_JOB: "cron:addJob",
  CRON_UPDATE_JOB: "cron:updateJob",
  CRON_REMOVE_JOB: "cron:removeJob",
  CRON_RUN_JOB: "cron:runJob",
  CRON_EVENT: "cron:event",

  // Notifications
  NOTIFICATION_LIST: "notification:list",
  NOTIFICATION_ADD: "notification:add",
  NOTIFICATION_MARK_READ: "notification:markRead",
  NOTIFICATION_MARK_ALL_READ: "notification:markAllRead",
  NOTIFICATION_DELETE: "notification:delete",
  NOTIFICATION_DELETE_ALL: "notification:deleteAll",
  NOTIFICATION_EVENT: "notification:event",

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
  CONTROL_PLANE_REGENERATE_TOKEN: "controlPlane:regenerateToken",
  CONTROL_PLANE_EVENT: "controlPlane:event",

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
  MEMORY_GET_IMPORTED_STATS: "memory:getImportedStats",
  MEMORY_FIND_IMPORTED: "memory:findImported",
  MEMORY_DELETE_IMPORTED: "memory:deleteImported",
  MEMORY_GET_USER_PROFILE: "memory:getUserProfile",
  MEMORY_ADD_USER_FACT: "memory:addUserFact",
  MEMORY_UPDATE_USER_FACT: "memory:updateUserFact",
  MEMORY_DELETE_USER_FACT: "memory:deleteUserFact",
  MEMORY_RELATIONSHIP_LIST: "memory:relationshipList",
  MEMORY_RELATIONSHIP_UPDATE: "memory:relationshipUpdate",
  MEMORY_RELATIONSHIP_DELETE: "memory:relationshipDelete",
  MEMORY_COMMITMENTS_GET: "memory:commitmentsGet",
  MEMORY_COMMITMENTS_DUE_SOON: "memory:commitmentsDueSoon",

  // Memory Features (Global Toggles)
  MEMORY_FEATURES_GET_SETTINGS: "memoryFeatures:getSettings",
  MEMORY_FEATURES_SAVE_SETTINGS: "memoryFeatures:saveSettings",

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
  // Daily Briefing
  DAILY_BRIEFING_GENERATE: "dailyBriefing:generate",
  // Proactive Suggestions
  SUGGESTIONS_LIST: "suggestions:list",
  SUGGESTIONS_DISMISS: "suggestions:dismiss",
  SUGGESTIONS_ACT: "suggestions:act",
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
  "groq",
  "xai",
  "kimi",
  "pi",
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
  "openai-compatible",
  "anthropic-compatible",
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
  anthropic: { name: "Anthropic", icon: "\u{1F9E0}", color: "#d97706" },
  bedrock: { name: "Bedrock", icon: "\u{2601}\uFE0F", color: "#ff9900" },
  ollama: { name: "Ollama", icon: "\u{1F999}", color: "#0ea5e9" },
  gemini: { name: "Gemini", icon: "\u{2728}", color: "#6366f1" },
  openrouter: { name: "OpenRouter", icon: "\u{1F310}", color: "#8b5cf6" },
  openai: { name: "OpenAI", icon: "\u{1F916}", color: "#10b981" },
  azure: { name: "Azure", icon: "\u{1F7E6}", color: "#0078d4" },
  groq: { name: "Groq", icon: "\u{26A1}", color: "#f97316" },
  xai: { name: "xAI", icon: "\u{1F4A0}", color: "#ef4444" },
  kimi: { name: "Kimi", icon: "\u{1F319}", color: "#a855f7" },
  pi: { name: "Pi", icon: "\u{1F7E3}", color: "#ec4899" },
};

export interface CachedModelInfo {
  key: string;
  displayName: string;
  description: string;
  contextLength?: number; // For OpenRouter models
  size?: number; // For Ollama models (in bytes)
}

export interface CustomProviderConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export interface LLMSettingsData {
  providerType: LLMProviderType;
  modelKey: string;
  anthropic?: {
    apiKey?: string;
  };
  bedrock?: {
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    profile?: string;
    useDefaultCredentials?: boolean;
    model?: string;
  };
  ollama?: {
    baseUrl?: string;
    model?: string;
    apiKey?: string; // Optional, for remote Ollama servers
  };
  gemini?: {
    apiKey?: string;
    model?: string;
  };
  openrouter?: {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  };
  openai?: {
    apiKey?: string;
    model?: string;
    // OAuth tokens (alternative to API key)
    accessToken?: string;
    refreshToken?: string;
    tokenExpiresAt?: number;
    authMethod?: "api_key" | "oauth";
  };
  azure?: {
    apiKey?: string;
    endpoint?: string;
    deployment?: string;
    deployments?: string[];
    apiVersion?: string;
  };
  groq?: {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  };
  xai?: {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  };
  kimi?: {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  };
  pi?: {
    provider?: string; // pi-ai KnownProvider (e.g. 'anthropic', 'openai', 'google')
    apiKey?: string;
    model?: string;
  };
  // Cached models from API (populated when user refreshes)
  cachedGeminiModels?: CachedModelInfo[];
  cachedOpenRouterModels?: CachedModelInfo[];
  cachedOllamaModels?: CachedModelInfo[];
  cachedBedrockModels?: CachedModelInfo[];
  cachedOpenAIModels?: CachedModelInfo[];
  cachedGroqModels?: CachedModelInfo[];
  cachedXaiModels?: CachedModelInfo[];
  cachedKimiModels?: CachedModelInfo[];
  cachedPiModels?: CachedModelInfo[];
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
}

export interface LLMConfigStatus {
  currentProvider: LLMProviderType;
  currentModel: string;
  providers: LLMProviderInfo[];
  models: LLMModelInfo[];
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
  | "googlechat";
export type ChannelStatus = "disconnected" | "connecting" | "connected" | "error";
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
  securityMode: SecurityMode;
  createdAt: number;
  config?: {
    selfChatMode?: boolean;
    groupRoutingMode?: "all" | "mentionsOnly" | "mentionsOrCommands" | "commandsOnly";
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
  // WhatsApp-specific fields
  allowedNumbers?: string[];
  selfChatMode?: boolean;
  groupRoutingMode?: "all" | "mentionsOnly" | "mentionsOrCommands" | "commandsOnly";
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
}

export interface UpdateChannelRequest {
  id: string;
  name?: string;
  securityMode?: SecurityMode;
  config?: {
    selfChatMode?: boolean;
    groupRoutingMode?: "all" | "mentionsOnly" | "mentionsOrCommands" | "commandsOnly";
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
export type ExtensionState = "loading" | "loaded" | "registered" | "active" | "error" | "disabled";

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
export type TunnelProvider = "ngrok" | "tailscale" | "cloudflare" | "localtunnel";
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
export type SearchProviderType = "tavily" | "brave" | "serpapi" | "google";
export type SearchType = "web" | "news" | "images";

export interface SearchSettingsData {
  primaryProvider: SearchProviderType | null;
  fallbackProvider: SearchProviderType | null;
  tavily?: {
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
}

export interface GoogleWorkspaceConnectionTestResult {
  success: boolean;
  error?: string;
  name?: string;
  userId?: string;
  email?: string;
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

  // Max Iterations Per Task
  maxIterationsPerTask: number;
  iterationLimitEnabled: boolean;
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

export type ReputationVerdict = "clean" | "unknown" | "suspicious" | "malicious" | "error";

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
  /** Stored encrypted at rest; typically masked as "***configured***" in the UI when set. */
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
  phase: "checking" | "downloading" | "extracting" | "installing" | "complete" | "error";
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
export interface QueueSettings {
  maxConcurrentTasks: number; // Default: 8, min: 1, max: 20
  taskTimeoutMinutes: number; // Default: 60, min: 5, max: 240 (4 hours). Auto-clear stuck tasks after this time.
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
  taskTimeoutMinutes: 60,
};

// Toast notification types for UI
export interface ToastNotification {
  id: string;
  type: "success" | "error" | "info";
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

// Skill source indicates where a skill was loaded from (precedence: workspace > managed > bundled)
export type SkillSource = "bundled" | "managed" | "workspace";

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
  routing?: {
    useWhen?: string;
    dontUseWhen?: string;
    outputs?: string;
    successCriteria?: string;
    expectedArtifacts?: string[];
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
}

// Status report for all skills
export interface SkillStatusReport {
  workspaceDir: string;
  managedSkillsDir: string;
  bundledSkillsDir: string;
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
  author?: string;
  downloads?: number;
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

export interface SkillsConfig {
  skillsDirectory: string; // Default: ~/Library/Application Support/cowork-os/skills/
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
export type NodePlatform = "ios" | "android" | "macos";

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
  type: "connected" | "disconnected" | "capabilities_changed" | "foreground_changed";
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
export type SSHTunnelState = "disconnected" | "connecting" | "connected" | "reconnecting" | "error";

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
export function getPersonalityById(id: PersonalityId): PersonalityDefinition | undefined {
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
    description: "Warm, curious, and emotionally attuned presence with thoughtful conversation",
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
  none: { name: "No Preference", description: "Use analogies from any domain", examples: "" },
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
