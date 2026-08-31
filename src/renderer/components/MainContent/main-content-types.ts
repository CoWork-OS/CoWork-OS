import type {
  ExecutionMode,
  TaskDomain,
  PermissionMode,
  AgentConfig,
  IntegrationMentionSelection,
} from "../../../shared/types";
import type { AccessProfileId } from "../../../shared/access-profiles";

export type SettingsTab =
  | "appearance"
  | "llm"
  | "search"
  | "telegram"
  | "slack"
  | "whatsapp"
  | "teams"
  | "x"
  | "morechannels"
  | "integrations"
  | "updates"
  | "system"
  | "queue"
  | "skills"
  | "voice"
  | "scheduled"
  | "mcp";

export interface FocusedCard {
  id: string;
  emoji: string;
  iconName: string;
  title: string;
  desc: string;
  action: { type: "prompt"; prompt: string } | { type: "settings"; tab: SettingsTab };
  category: "task" | "setup" | "discover";
}

export interface CreateTaskOptions {
  autonomousMode?: boolean;
  permissionMode?: PermissionMode;
  shellAccess?: boolean;
  accessProfileId?: AccessProfileId;
  collaborativeMode?: boolean;
  multitaskMode?: boolean;
  multitaskLaneCount?: number;
  multitaskAssignmentMode?: "auto_split";
  multiLlmMode?: boolean;
  multiLlmConfig?: import("../../../shared/types").MultiLlmConfig;
  verificationAgent?: boolean;
  executionMode?: ExecutionMode;
  taskDomain?: TaskDomain;
  chronicleMode?: import("../../../shared/types").ChronicleTaskMode;
  videoGenerationMode?: boolean;
  agentConfig?: AgentConfig;
  integrationMentions?: IntegrationMentionSelection[];
}
