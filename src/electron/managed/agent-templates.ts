import type {
  AgentTemplate,
  ManagedAgentStudioConfig,
  ManagedEnvironmentConfig,
} from "../../shared/types";

function makeStudio(
  studio: Partial<ManagedAgentStudioConfig>,
): Partial<ManagedAgentStudioConfig> {
  return studio;
}

function makeEnvironment(
  environment: Partial<ManagedEnvironmentConfig>,
): Partial<ManagedEnvironmentConfig> {
  return environment;
}

export const BUILTIN_AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: "team-chat-qna",
    name: "Team Chat Q&A",
    description: "Answer common team questions in Slack using approved docs, files, and skills.",
    tagline: "Build agents that reply in Slack",
    icon: "💬",
    color: "#1570ef",
    category: "support",
    systemPrompt:
      "You answer team questions with concise, source-grounded responses. Prefer attached files, configured skills, and workspace context over guessing. If the answer is uncertain, say what is missing.",
    executionMode: "solo",
    skills: ["summarize", "github", "notion"],
    studio: makeStudio({
      skills: ["summarize", "github", "notion"],
      apps: {
        allowedToolFamilies: ["communication", "files", "search", "documents"],
      },
      memoryConfig: { mode: "focused", sources: ["workspace", "memory"] },
      channelTargets: [],
      scheduleConfig: { enabled: false, mode: "manual" },
      audioSummaryConfig: { enabled: false, style: "executive-briefing" },
    }),
    environmentConfig: makeEnvironment({
      enableShell: false,
      enableBrowser: true,
      enableComputerUse: false,
      allowedToolFamilies: ["communication", "files", "search", "documents"],
    }),
  },
  {
    id: "morning-planner",
    name: "Morning Planner",
    description: "Turn calendar, open tasks, and inbox context into a clear daily plan.",
    tagline: "Start with a proven workflow",
    icon: "📅",
    color: "#0ea5e9",
    category: "planning",
    featured: true,
    systemPrompt:
      "You prepare crisp morning plans. Synthesize calendar, inbox, and open work into a prioritized agenda with explicit next actions and blockers.",
    executionMode: "solo",
    runtimeDefaults: {
      autonomousMode: true,
      allowUserInput: true,
    },
    skills: ["calendly", "summarize"],
    studio: makeStudio({
      skills: ["calendly", "summarize"],
      apps: {
        allowedToolFamilies: ["communication", "files", "search"],
      },
      memoryConfig: { mode: "default", sources: ["memory", "workspace", "sessions"] },
      scheduleConfig: {
        enabled: true,
        mode: "routine",
        label: "Every morning",
        cadenceMinutes: 24 * 60,
      },
      audioSummaryConfig: { enabled: true, style: "executive-briefing" },
    }),
    environmentConfig: makeEnvironment({
      enableBrowser: true,
      enableShell: false,
      allowedToolFamilies: ["communication", "files", "search"],
    }),
  },
  {
    id: "bug-triage",
    name: "Bug Triage",
    description: "Review incoming bugs, prioritize them, and prepare a grounded triage summary.",
    icon: "🐞",
    color: "#f97316",
    category: "engineering",
    systemPrompt:
      "You triage bugs. Classify severity, extract repro details, note likely owners, and produce a concise action-ready summary without inventing evidence.",
    executionMode: "solo",
    runtimeDefaults: {
      autonomousMode: true,
      allowUserInput: true,
      requireWorktree: true,
    },
    skills: ["github", "code-review", "debug-error"],
    studio: makeStudio({
      skills: ["github", "code-review", "debug-error"],
      apps: {
        allowedToolFamilies: ["files", "search", "shell", "documents"],
      },
      memoryConfig: { mode: "focused", sources: ["workspace", "sessions"] },
      scheduleConfig: { enabled: false, mode: "manual" },
      audioSummaryConfig: { enabled: false, style: "study-guide" },
    }),
    environmentConfig: makeEnvironment({
      enableShell: true,
      enableBrowser: true,
      allowedToolFamilies: ["files", "search", "shell", "documents"],
    }),
  },
  {
    id: "chief-of-staff",
    name: "Chief of Staff",
    description: "Prepare executive-style briefs from inbox, calendar, chats, and workspace context.",
    icon: "🧳",
    color: "#14b8a6",
    category: "operations",
    systemPrompt:
      "You operate like a chief of staff. Build high-signal executive briefs, surface priorities, and recommend the next actions with a bias for clarity and leverage.",
    executionMode: "solo",
    runtimeDefaults: {
      autonomousMode: true,
      allowUserInput: true,
    },
    skills: ["usecase-chief-of-staff-briefing", "summarize"],
    studio: makeStudio({
      skills: ["usecase-chief-of-staff-briefing", "summarize"],
      apps: {
        allowedToolFamilies: ["communication", "files", "documents", "search"],
      },
      memoryConfig: { mode: "default", sources: ["memory", "workspace", "sessions"] },
      scheduleConfig: { enabled: false, mode: "manual" },
      audioSummaryConfig: { enabled: true, style: "public-radio" },
    }),
    environmentConfig: makeEnvironment({
      enableBrowser: true,
      allowedToolFamilies: ["communication", "files", "documents", "search"],
    }),
  },
  {
    id: "customer-reply-drafter",
    name: "Customer Reply Drafter",
    description: "Draft grounded replies from tickets, accounts, policy, and saved context.",
    icon: "✉️",
    color: "#8b5cf6",
    category: "support",
    systemPrompt:
      "You draft customer replies. Stay grounded in the available context, keep the tone calm and clear, and flag missing evidence instead of guessing.",
    executionMode: "solo",
    skills: ["usecase-draft-reply", "summarize"],
    studio: makeStudio({
      skills: ["usecase-draft-reply", "summarize"],
      apps: {
        allowedToolFamilies: ["communication", "files", "documents"],
      },
      memoryConfig: { mode: "focused", sources: ["workspace", "memory"] },
      scheduleConfig: { enabled: false, mode: "manual" },
      channelTargets: [],
    }),
    environmentConfig: makeEnvironment({
      enableBrowser: true,
      allowedToolFamilies: ["communication", "files", "documents"],
    }),
  },
  {
    id: "research-analyst",
    name: "Research Analyst",
    description: "Investigate topics, synthesize findings, and maintain a concise answer trail.",
    icon: "🔎",
    color: "#2563eb",
    category: "research",
    systemPrompt:
      "You are a research analyst. Find the highest-signal information, compare sources, and present a concise evidence-backed synthesis with explicit uncertainty when needed.",
    executionMode: "solo",
    runtimeDefaults: {
      autonomousMode: true,
      allowUserInput: true,
      webSearchMode: "live",
    },
    skills: ["competitive-research", "research-last-days", "summarize"],
    studio: makeStudio({
      skills: ["competitive-research", "research-last-days", "summarize"],
      apps: {
        allowedToolFamilies: ["search", "files", "documents", "memory"],
      },
      memoryConfig: { mode: "default", sources: ["memory", "workspace", "sessions"] },
      scheduleConfig: { enabled: false, mode: "manual" },
      audioSummaryConfig: { enabled: true, style: "study-guide" },
    }),
    environmentConfig: makeEnvironment({
      enableBrowser: true,
      allowedToolFamilies: ["search", "files", "documents", "memory"],
    }),
  },
  {
    id: "inbox-follow-up-assistant",
    name: "Inbox Follow-up Assistant",
    description: "Track stale threads, draft follow-ups, and keep the inbox moving.",
    icon: "📥",
    color: "#22c55e",
    category: "operations",
    systemPrompt:
      "You monitor inbox follow-ups. Find stale conversations, suggest the next reply, and keep the user moving without over-automating sensitive conversations.",
    executionMode: "solo",
    runtimeDefaults: {
      autonomousMode: true,
      allowUserInput: true,
    },
    skills: ["usecase-inbox-manager", "summarize"],
    studio: makeStudio({
      skills: ["usecase-inbox-manager", "summarize"],
      apps: {
        allowedToolFamilies: ["communication", "documents", "files"],
      },
      memoryConfig: { mode: "focused", sources: ["workspace", "sessions"] },
      scheduleConfig: {
        enabled: true,
        mode: "recurring",
        label: "Check for follow-ups",
        cadenceMinutes: 180,
      },
      audioSummaryConfig: { enabled: false, style: "executive-briefing" },
    }),
    environmentConfig: makeEnvironment({
      enableBrowser: true,
      allowedToolFamilies: ["communication", "documents", "files"],
    }),
  },
];
