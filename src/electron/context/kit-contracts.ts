export type KitScope =
  | "task"
  | "main-session"
  | "role"
  | "company-ops"
  | "heartbeat"
  | "bootstrap";

export type KitMutability =
  | "system_locked"
  | "user_owned"
  | "agent_suggested"
  | "agent_maintained";

export type KitParser = "freeform" | "sectioned" | "kv-lines" | "checklist" | "decision-log";

export interface KitContract {
  file: string;
  title: string;
  scope: KitScope[];
  parser: KitParser;
  maxChars: number;
  freshnessDays?: number;
  mutability: KitMutability;
  belongsHere: string[];
  notHere: string[];
  specialHandling?: "bootstrap" | "heartbeat";
}

const BASE_CONTRACTS = {
  "AGENTS.md": {
    file: "AGENTS.md",
    title: "Workspace Rules",
    scope: ["task", "main-session"] as KitScope[],
    parser: "sectioned" as KitParser,
    maxChars: 3000,
    freshnessDays: 90,
    mutability: "system_locked" as KitMutability,
    belongsHere: [
      "workspace-wide operating guidance",
      "coordination rules",
      "quality bar",
      "default collaboration expectations",
    ],
    notHere: ["secrets", "temporary task notes", "company metrics", "heartbeat-only checks"],
  },
  "MEMORY.md": {
    file: "MEMORY.md",
    title: "Long-Term Memory",
    scope: ["task", "main-session"] as KitScope[],
    parser: "decision-log" as KitParser,
    maxChars: 3500,
    freshnessDays: 120,
    mutability: "agent_maintained" as KitMutability,
    belongsHere: [
      "durable rules",
      "durable preferences",
      "long-lived constraints",
      "compounding learnings",
    ],
    notHere: ["temporary priorities", "current mood", "heartbeat checklist"],
  },
  "USER.md": {
    file: "USER.md",
    title: "User Profile",
    scope: ["task", "main-session"] as KitScope[],
    parser: "kv-lines" as KitParser,
    maxChars: 2000,
    freshnessDays: 180,
    mutability: "user_owned" as KitMutability,
    belongsHere: ["preferences", "timezone", "communication style", "personal defaults"],
    notHere: ["hard safety rules", "company strategy", "secrets"],
  },
  "SOUL.md": {
    file: "SOUL.md",
    title: "Workspace Persona",
    scope: ["task", "main-session", "role"] as KitScope[],
    parser: "sectioned" as KitParser,
    maxChars: 3000,
    freshnessDays: 90,
    mutability: "user_owned" as KitMutability,
    belongsHere: [
      "tone",
      "collaboration style",
      "execution philosophy",
      "default communication style",
    ],
    notHere: [
      "permissions",
      "irreversible approval rules",
      "company KPIs",
      "temporary priorities",
      "manipulation tactics",
    ],
  },
  "IDENTITY.md": {
    file: "IDENTITY.md",
    title: "Workspace Identity",
    scope: ["task", "main-session", "role"] as KitScope[],
    parser: "kv-lines" as KitParser,
    maxChars: 2000,
    freshnessDays: 180,
    mutability: "user_owned" as KitMutability,
    belongsHere: [
      "who the agent is",
      "what scope it owns",
      "what it does not own",
      "what always requires confirmation",
    ],
    notHere: ["tone manifesto", "workflow checklists", "marketing strategy"],
  },
  "RULES.md": {
    file: "RULES.md",
    title: "Operational Rules",
    scope: ["task", "main-session", "role", "company-ops"] as KitScope[],
    parser: "checklist" as KitParser,
    maxChars: 2500,
    freshnessDays: 90,
    mutability: "system_locked" as KitMutability,
    belongsHere: [
      "must",
      "must not",
      "requires approval",
      "default safety behavior",
    ],
    notHere: ["personality", "historical notes", "preferences", "reasons from past incidents"],
  },
  "TOOLS.md": {
    file: "TOOLS.md",
    title: "Local Setup Notes",
    scope: ["task", "main-session"] as KitScope[],
    parser: "sectioned" as KitParser,
    maxChars: 1800,
    freshnessDays: 60,
    mutability: "user_owned" as KitMutability,
    belongsHere: ["environment notes", "common commands", "tooling conventions"],
    notHere: ["raw secrets", "identity", "company strategy"],
  },
  "VIBES.md": {
    file: "VIBES.md",
    title: "Current Operating Mode",
    scope: ["task", "role"] as KitScope[],
    parser: "sectioned" as KitParser,
    maxChars: 1200,
    freshnessDays: 14,
    mutability: "agent_suggested" as KitMutability,
    belongsHere: ["current mode", "current emphasis", "urgency", "what to optimize for now"],
    notHere: ["identity", "permanent rules", "long-term history"],
  },
  "MISTAKES.md": {
    file: "MISTAKES.md",
    title: "Recurring Mistakes",
    scope: ["task", "main-session", "role"] as KitScope[],
    parser: "decision-log" as KitParser,
    maxChars: 2500,
    freshnessDays: 60,
    mutability: "agent_maintained" as KitMutability,
    belongsHere: ["recurring failure patterns", "corrections", "lessons"],
    notHere: ["one-off anecdotes", "tone rules", "general company strategy"],
  },
  "LORE.md": {
    file: "LORE.md",
    title: "Durable Context",
    scope: ["task", "main-session"] as KitScope[],
    parser: "decision-log" as KitParser,
    maxChars: 2500,
    freshnessDays: 120,
    mutability: "agent_maintained" as KitMutability,
    belongsHere: ["important historical decisions", "milestones", "durable background context"],
    notHere: ["active rules", "today's priorities", "temporary experiments"],
  },
  "COMPANY.md": {
    file: "COMPANY.md",
    title: "Company Context",
    scope: ["company-ops"] as KitScope[],
    parser: "sectioned" as KitParser,
    maxChars: 2500,
    freshnessDays: 60,
    mutability: "user_owned" as KitMutability,
    belongsHere: ["mission", "offer", "customer", "constraints", "non-goals"],
    notHere: ["temporary tasks", "heartbeat checklist"],
  },
  "OPERATIONS.md": {
    file: "OPERATIONS.md",
    title: "Operating Model",
    scope: ["company-ops"] as KitScope[],
    parser: "sectioned" as KitParser,
    maxChars: 3000,
    freshnessDays: 30,
    mutability: "user_owned" as KitMutability,
    belongsHere: [
      "auto-allowed actions",
      "approval-required actions",
      "escalation paths",
      "owners",
    ],
    notHere: ["tone", "marketing hooks", "history dump"],
  },
  "KPIS.md": {
    file: "KPIS.md",
    title: "Business Metrics",
    scope: ["company-ops"] as KitScope[],
    parser: "sectioned" as KitParser,
    maxChars: 1800,
    freshnessDays: 14,
    mutability: "user_owned" as KitMutability,
    belongsHere: ["metrics", "targets", "guardrails", "freshness date"],
    notHere: ["strategy essay", "task list"],
  },
  "PRIORITIES.md": {
    file: "PRIORITIES.md",
    title: "Current Priorities",
    scope: ["company-ops", "task"] as KitScope[],
    parser: "checklist" as KitParser,
    maxChars: 1200,
    freshnessDays: 7,
    mutability: "agent_suggested" as KitMutability,
    belongsHere: ["top current priorities", "why now", "owner", "review date"],
    notHere: ["long-term history", "permanent rules"],
  },
  "CROSS_SIGNALS.md": {
    file: "CROSS_SIGNALS.md",
    title: "Cross-Agent Signals",
    scope: ["task", "main-session", "company-ops"] as KitScope[],
    parser: "decision-log" as KitParser,
    maxChars: 1800,
    freshnessDays: 14,
    mutability: "agent_maintained" as KitMutability,
    belongsHere: ["cross-agent signals", "contradictions", "amplified opportunities"],
    notHere: ["hard rules", "identity", "secrets"],
  },
  "HEARTBEAT.md": {
    file: "HEARTBEAT.md",
    title: "Heartbeat Checklist",
    scope: ["heartbeat"] as KitScope[],
    parser: "checklist" as KitParser,
    maxChars: 1200,
    freshnessDays: 14,
    mutability: "agent_suggested" as KitMutability,
    belongsHere: ["periodic checks", "monitoring tasks", "proposal triggers", "quiet hours"],
    notHere: ["general workspace context", "identity", "all-day strategy memo"],
    specialHandling: "heartbeat" as const,
  },
  "SUPERVISOR.md": {
    file: "SUPERVISOR.md",
    title: "Supervisor Protocol Policy",
    scope: ["task", "main-session", "role"] as KitScope[],
    parser: "sectioned" as KitParser,
    maxChars: 2400,
    freshnessDays: 30,
    mutability: "user_owned" as KitMutability,
    belongsHere: [
      "supervisor review thresholds",
      "escalation rules",
      "freshness windows",
      "channel-specific quality checks",
    ],
    notHere: ["tokens", "channel ids", "credentials", "generic personality prose"],
  },
  "BOOTSTRAP.md": {
    file: "BOOTSTRAP.md",
    title: "Bootstrap Instructions",
    scope: ["bootstrap"] as KitScope[],
    parser: "checklist" as KitParser,
    maxChars: 1800,
    freshnessDays: 30,
    mutability: "system_locked" as KitMutability,
    belongsHere: ["one-time onboarding", "initial setup ritual", "seed tasks"],
    notHere: ["durable context", "heartbeat tasks", "long-term memory"],
    specialHandling: "bootstrap" as const,
  },
  "ACCESS.md": {
    file: "ACCESS.md",
    title: "Project Access Rules",
    scope: ["task", "role"] as KitScope[],
    parser: "sectioned" as KitParser,
    maxChars: 1500,
    freshnessDays: 60,
    mutability: "system_locked" as KitMutability,
    belongsHere: ["allow rules", "deny rules", "role access boundaries"],
    notHere: ["credentials", "API keys", "customer secrets"],
  },
  "CONTEXT.md": {
    file: "CONTEXT.md",
    title: "Project Context",
    scope: ["task"] as KitScope[],
    parser: "sectioned" as KitParser,
    maxChars: 2200,
    freshnessDays: 30,
    mutability: "user_owned" as KitMutability,
    belongsHere: ["project goals", "project constraints", "decisions", "notes"],
    notHere: ["global identity", "heartbeat routines", "credentials"],
  },
} satisfies Record<string, KitContract>;

export const WORKSPACE_KIT_CONTRACTS: Record<string, KitContract> = BASE_CONTRACTS;

export const ROLE_KIT_FILES = ["IDENTITY.md", "RULES.md", "SOUL.md", "VIBES.md"] as const;

export const WORKSPACE_PROMPT_ORDER = [
  "IDENTITY.md",
  "RULES.md",
  "AGENTS.md",
  "USER.md",
  "COMPANY.md",
  "OPERATIONS.md",
  "KPIS.md",
  "PRIORITIES.md",
  "CONTEXT.md",
  "ACCESS.md",
  "TOOLS.md",
  "SOUL.md",
  "SUPERVISOR.md",
  "VIBES.md",
  "CROSS_SIGNALS.md",
  "MISTAKES.md",
  "LORE.md",
  "MEMORY.md",
  "HEARTBEAT.md",
] as const;

export const WORKSPACE_HEALTH_FILES = [
  "AGENTS.md",
  "MEMORY.md",
  "USER.md",
  "SOUL.md",
  "SUPERVISOR.md",
  "IDENTITY.md",
  "RULES.md",
  "TOOLS.md",
  "BOOTSTRAP.md",
  "VIBES.md",
  "LORE.md",
  "HEARTBEAT.md",
  "PRIORITIES.md",
  "COMPANY.md",
  "OPERATIONS.md",
  "KPIS.md",
  "CROSS_SIGNALS.md",
  "MISTAKES.md",
] as const;

export function getKitContract(file: string): KitContract | undefined {
  return WORKSPACE_KIT_CONTRACTS[file];
}

export function isRoleKitFile(file: string): boolean {
  return (ROLE_KIT_FILES as readonly string[]).includes(file);
}
