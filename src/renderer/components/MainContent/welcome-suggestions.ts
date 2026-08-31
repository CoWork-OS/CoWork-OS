import type {
  Workspace,
  ProactiveSuggestion,
  UserProfile,
  AppNotification,
  InputRequest,
} from "../../../shared/types";
import { isTempWorkspaceId } from "../../../shared/types";
import { Clock, Settings, Link as LinkIcon, ListTodo, Sparkles, MessageCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { SettingsTab } from "./main-content-types";
import {
  WELCOME_TASK_SUGGESTION_LIMIT,
  WELCOME_SUGGESTION_TEXT_MAX,
} from "./main-content-constants";

export type WelcomeTaskSuggestionSource = "heartbeat" | "memory" | "insight";
export type WelcomeTaskSuggestionModule =
  | "Memory"
  | "Heartbeat"
  | "Reflection"
  | "Recent work"
  | "Inbox"
  | "Project";

export type WelcomeTaskSuggestionAction =
  | { type: "prompt"; prompt: string }
  | { type: "task"; taskId: string; focus: "input_request" }
  | { type: "settings"; tab: SettingsTab }
  | { type: "url"; url: string };

export interface WelcomeTaskSuggestion {
  id: string;
  title: string;
  description?: string;
  whyNow: string;
  action: WelcomeTaskSuggestionAction;
  confidence?: number;
  evidence?: string[];
  source: WelcomeTaskSuggestionSource;
  modules: WelcomeTaskSuggestionModule[];
  priority: number;
  createdAt?: number;
  feedback?: {
    kind: "proactive";
    workspaceId: string;
    suggestionId: string;
  };
}

export interface ActiveWelcomeSuggestionDraft {
  workspaceId: string;
  suggestionId: string;
  originalPrompt: string;
}

export function normalizeSuggestionText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export function truncateSuggestionText(
  value: string,
  maxLength = WELCOME_SUGGESTION_TEXT_MAX,
): string {
  const text = normalizeSuggestionText(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function getWorkspaceStatusFolderLabel(workspace?: Workspace | null): string {
  if (workspace?.isTemp || isTempWorkspaceId(workspace?.id)) return "Work in a folder";
  const workspacePath = workspace?.path?.trim();
  if (workspacePath) {
    const folderName = workspacePath.split(/[/\\]/).filter(Boolean).pop();
    return folderName || workspacePath;
  }
  return workspace?.name?.trim() || "No folder selected";
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function getRecordString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = normalizeSuggestionText(record[key]);
    if (value) return value;
  }
  return "";
}

function getRecordNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function isConcreteMemorySignal(value: string): boolean {
  const text = normalizeSuggestionText(value);
  if (text.length < 24) return false;
  if (/^[{[]/.test(text)) return false;
  if (/^(none|unknown|not set|n\/a|no context|no memory)$/i.test(text)) return false;
  if (/^(ready to help|i can help|ask me anything)/i.test(text)) return false;
  return true;
}

function formatProfileFactSignal(fact: UserProfile["facts"][number]): string | null {
  const value = normalizeSuggestionText(fact.value);
  if (!isConcreteMemorySignal(value)) return null;
  if (typeof fact.confidence === "number" && fact.confidence < 0.45 && !fact.pinned) {
    return null;
  }
  const label =
    fact.category === "goal"
      ? "Goal"
      : fact.category === "work"
        ? "Work"
        : fact.category === "preference"
          ? "Preference"
          : fact.category === "constraint"
            ? "Constraint"
            : "Memory";
  return `${label}: ${truncateSuggestionText(value, 360)}`;
}

function getRecentMemorySignal(item: unknown): string | null {
  const record = asRecord(item);
  if (!record) return null;
  const text = getRecordString(record, ["summary", "content", "snippet", "text", "value"]);
  if (!isConcreteMemorySignal(text)) return null;
  const type = getRecordString(record, ["type"]);
  const prefix = type ? `Recent ${type.replace(/_/g, " ")}` : "Recent work";
  return `${prefix}: ${truncateSuggestionText(text, 360)}`;
}

function buildEvidencePrompt(args: {
  opening: string;
  evidence: string[];
  instruction: string;
}): string {
  const evidenceLines = args.evidence.map((item, index) => `${index + 1}. ${item}`).join("\n");
  return `${args.opening}\n\nRemembered context:\n${evidenceLines}\n\n${args.instruction}`;
}

function extractFirstUrl(value: string): string | null {
  const match = value.match(/\bhttps?:\/\/[^\s<>"')\]]+/i);
  return match ? match[0] : null;
}

export function resolveSettingsActionFromSuggestionText(value: string): SettingsTab | null {
  const text = normalizeSuggestionText(value).toLowerCase();
  if (!text) return null;
  const setupIntent =
    /\b(enable|turn on|connect|configure|set up|setup|setting|settings|permission|authorize|login|log in|sign in)\b/.test(
      text,
    );
  if (!setupIntent) return null;
  if (/\b(model|llm|provider|api key|openai|anthropic|ollama|gemini)\b/.test(text)) return "llm";
  if (/\b(search|web search|browser search)\b/.test(text)) return "search";
  if (/\b(skill|skills)\b/.test(text)) return "skills";
  if (/\b(queue|queued|concurrency)\b/.test(text)) return "queue";
  if (/\b(schedule|scheduled|automation|automations|recurring|cron)\b/.test(text))
    return "scheduled";
  if (
    /\b(mcp|connector|connectors|integration|integrations|gmail|calendar|drive|github)\b/.test(text)
  ) {
    return "integrations";
  }
  if (/\b(slack|telegram|whatsapp|teams)\b/.test(text)) return "morechannels";
  if (/\b(voice|microphone|speech)\b/.test(text)) return "voice";
  if (/\b(update|updates)\b/.test(text)) return "updates";
  return /\b(setting|settings|permission|enable|turn on|configure)\b/.test(text) ? "system" : null;
}

export function buildSuggestionAction(args: {
  title?: string;
  description?: string;
  prompt: string;
}): WelcomeTaskSuggestionAction {
  const actionText = [args.title, args.description, args.prompt].filter(Boolean).join(" ");
  const url = extractFirstUrl(actionText);
  if (url && /\b(click|open|visit|go to|log in|login|sign in|confirm|paste)\b/i.test(actionText)) {
    return { type: "url", url };
  }
  const settingsTab = resolveSettingsActionFromSuggestionText(actionText);
  if (settingsTab) return { type: "settings", tab: settingsTab };
  return { type: "prompt", prompt: args.prompt };
}

export function labelForWelcomeAction(action: WelcomeTaskSuggestionAction): string {
  if (action.type === "task") return "Needs response";
  if (action.type === "settings") return "Setting";
  if (action.type === "url") return "Link";
  return "Ask CoWork";
}

export function iconForWelcomeAction(suggestion: WelcomeTaskSuggestion): LucideIcon {
  if (suggestion.action.type === "task") return Clock;
  if (suggestion.action.type === "settings") return Settings;
  if (suggestion.action.type === "url") return LinkIcon;
  if (suggestion.source === "memory") return ListTodo;
  if (suggestion.source === "insight") return Sparkles;
  return MessageCircle;
}

export function formatWelcomeModules(
  modules: WelcomeTaskSuggestionModule[],
): WelcomeTaskSuggestionModule[] {
  return Array.from(new Set(modules)).slice(0, 3);
}

export function modulesForProactiveSuggestion(
  suggestion: ProactiveSuggestion,
): WelcomeTaskSuggestionModule[] {
  const modules: WelcomeTaskSuggestionModule[] = ["Heartbeat"];
  if (suggestion.suggestionClass === "memory" || suggestion.type === "reverse_prompt") {
    modules.push("Memory");
  }
  if (
    suggestion.suggestionClass === "open_loop" ||
    suggestion.suggestionClass === "urgent" ||
    suggestion.sourceSignals?.some((signal) => /mail|inbox|reply/i.test(signal))
  ) {
    modules.push("Inbox");
  }
  if (/^workflow intelligence:|^continuity:|^reflection:|^subconscious:/i.test(suggestion.title)) {
    modules.push("Reflection");
  }
  if (suggestion.sourceTaskId) modules.push("Recent work");
  return formatWelcomeModules(modules);
}

export function whyNowForProactiveSuggestion(suggestion: ProactiveSuggestion): string {
  if (suggestion.urgency === "high") return "A current signal looks urgent enough to review now.";
  if (suggestion.suggestionClass === "open_loop")
    return "Memory found an open loop that may need closure.";
  if (suggestion.suggestionClass === "memory")
    return "This is based on remembered goals or preferences.";
  if (suggestion.suggestionClass === "urgent")
    return "Recent activity suggests this should not wait.";
  if (suggestion.sourceSignals?.length) {
    return `Triggered by ${suggestion.sourceSignals.length} recent signal(s).`;
  }
  return truncateSuggestionText(
    suggestion.description || "Recent context suggests this may be useful.",
    120,
  );
}

export function buildHeartbeatWelcomeSuggestion(
  suggestion: ProactiveSuggestion,
  index: number,
): WelcomeTaskSuggestion | null {
  const prompt = normalizeSuggestionText(suggestion.actionPrompt || suggestion.description);
  const rawTitle = normalizeSuggestionText(suggestion.title || prompt);
  const title = rawTitle.replace(
    /^(workflow intelligence|subconscious|reflection|continuity):\s*/i,
    "",
  );
  if (!title || !prompt) return null;

  const urgencyBoost =
    suggestion.urgency === "high" ? 30 : suggestion.urgency === "medium" ? 15 : 0;
  return {
    id: `heartbeat:${suggestion.id}`,
    title: truncateSuggestionText(title),
    description: truncateSuggestionText(suggestion.description, 120),
    whyNow: whyNowForProactiveSuggestion(suggestion),
    action: buildSuggestionAction({ title, description: suggestion.description, prompt }),
    confidence: suggestion.confidence,
    evidence: suggestion.sourceSignals,
    source: "heartbeat",
    modules: modulesForProactiveSuggestion(suggestion),
    priority: 300 + urgencyBoost + Math.round((suggestion.confidence || 0) * 100) - index,
    createdAt: suggestion.createdAt,
    feedback: suggestion.workspaceId
      ? {
          kind: "proactive",
          workspaceId: suggestion.workspaceId,
          suggestionId: suggestion.id,
        }
      : undefined,
  };
}

export function buildCompanionNotificationWelcomeSuggestion(
  notification: AppNotification,
  matchingSuggestion?: ProactiveSuggestion,
): WelcomeTaskSuggestion | null {
  if (notification.type !== "companion_suggestion") return null;
  const title = normalizeSuggestionText(notification.title);
  const message = normalizeSuggestionText(notification.message);
  if (!title && !message) return null;

  const prompt =
    normalizeSuggestionText(matchingSuggestion?.actionPrompt) ||
    `Review this Workflow Intelligence recommendation and decide the next action.\n\nTitle: ${
      title || "Companion suggestion"
    }\nContext: ${message || "No additional context provided."}`;
  const isNudge = notification.recommendedDelivery === "nudge";
  const modules: WelcomeTaskSuggestionModule[] = ["Heartbeat", "Reflection"];
  if (/mail|inbox|reply/i.test(`${title} ${message}`)) modules.push("Inbox");

  return {
    id: `notification:${notification.suggestionId || notification.id}`,
    title: truncateSuggestionText(title || message),
    description: truncateSuggestionText(message, 120),
    whyNow: isNudge
      ? "Workflow Intelligence sent this as a timely nudge."
      : "A recent companion signal is waiting in the automation inbox.",
    action: buildSuggestionAction({ title, description: message, prompt }),
    confidence: matchingSuggestion?.confidence ?? (isNudge ? 0.82 : 0.68),
    evidence: message ? [message] : undefined,
    source: "heartbeat",
    modules: formatWelcomeModules(modules),
    priority: (isNudge ? 285 : 235) + (notification.read ? 0 : 10),
    createdAt: notification.createdAt,
    feedback:
      notification.workspaceId && notification.suggestionId
        ? {
            kind: "proactive",
            workspaceId: notification.workspaceId,
            suggestionId: notification.suggestionId,
          }
        : undefined,
  };
}

export function buildMemoryCommitmentSuggestion(
  item: unknown,
  index: number,
): WelcomeTaskSuggestion | null {
  const record = asRecord(item);
  if (!record) return null;
  const text = getRecordString(record, ["text", "title", "summary", "description"]);
  if (!text) return null;
  const dueAt = getRecordNumber(record, ["dueAt", "due_at", "dueDate"]);
  const dueText = dueAt
    ? ` Due ${new Date(dueAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}.`
    : "";
  return {
    id: `memory:commitment:${getRecordString(record, ["id"]) || index}`,
    title: truncateSuggestionText(text),
    description: dueText.trim() || "Open commitment",
    whyNow: dueText.trim() || "Memory has this as an open commitment.",
    action: buildSuggestionAction({
      title: text,
      description: dueText.trim() || "Open commitment",
      prompt: `Help me make progress on this commitment: ${text}.${dueText} Start by identifying the next concrete action and any message or artifact I should prepare.`,
    }),
    source: "memory",
    modules: ["Memory"],
    priority: 260 - index,
    createdAt: getRecordNumber(record, ["createdAt", "updatedAt"]),
  };
}

export function buildProfileWelcomeSuggestion(
  profile: UserProfile | null,
  recentMemories: unknown[],
): WelcomeTaskSuggestion | null {
  if (!profile) return null;
  const factSignals = (Array.isArray(profile.facts) ? profile.facts : [])
    .filter(
      (fact) => ["goal", "work", "preference", "constraint"].includes(fact.category) || fact.pinned,
    )
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        b.lastUpdatedAt - a.lastUpdatedAt ||
        b.confidence - a.confidence,
    )
    .map(formatProfileFactSignal)
    .filter((value): value is string => Boolean(value));
  const profileSummary = normalizeSuggestionText(profile.summary);
  const summary = isConcreteMemorySignal(profileSummary)
    ? `Profile summary: ${truncateSuggestionText(profileSummary, 360)}`
    : null;
  const recentSignals = recentMemories
    .map(getRecentMemorySignal)
    .filter((value): value is string => Boolean(value));
  const evidence = Array.from(
    new Set(
      [summary, ...factSignals, ...recentSignals].filter((value): value is string =>
        Boolean(value),
      ),
    ),
  ).slice(0, 6);
  if (evidence.length < 2) return null;
  return {
    id: "memory:profile-focus",
    title: "Use memory to choose the next priority",
    description: truncateSuggestionText(evidence[0], 120),
    whyNow: `${evidence.length} remembered signals can narrow what to do next.`,
    action: {
      type: "prompt",
      prompt: buildEvidencePrompt({
        opening: "Use the remembered context below to recommend the best next task for me.",
        evidence,
        instruction:
          "Give me 3 concrete options that directly reference this context, explain the tradeoffs, and recommend one. Do not start the task or ask whether to proceed; end with the recommendation so I can choose in a follow-up. If the context is not enough, ask one focused clarifying question instead of giving generic advice.",
      }),
    },
    evidence,
    source: "memory",
    modules: recentSignals.length ? ["Memory", "Recent work"] : ["Memory"],
    priority: 120,
    createdAt: profile.updatedAt,
  };
}

export function buildRecentMemorySuggestion(
  item: unknown,
  index: number,
): WelcomeTaskSuggestion | null {
  const record = asRecord(item);
  if (!record) return null;
  const text = getRecordString(record, ["summary", "content", "snippet", "text", "value"]);
  if (!text) return null;
  const evidence = [`Recent work: ${text}`];
  return {
    id: `memory:recent:${getRecordString(record, ["id"]) || index}`,
    title: "Pick up a recent thread",
    description: truncateSuggestionText(text, 120),
    whyNow: "Recent work left context that may be worth continuing.",
    action: {
      type: "prompt",
      prompt: buildEvidencePrompt({
        opening: "Pick up from this recent memory and suggest the most useful next step.",
        evidence,
        instruction:
          "Explain why this is the right next step and name any tradeoffs. Do not start the task or ask whether to proceed; end with the recommendation so I can choose in a follow-up.",
      }),
    },
    evidence,
    source: "memory",
    modules: ["Memory", "Recent work"],
    priority: 90 - index,
    createdAt: getRecordNumber(record, ["updatedAt", "createdAt"]),
  };
}

export function buildInputRequestWelcomeSuggestion(
  request: InputRequest,
  index: number,
): WelcomeTaskSuggestion | null {
  if (request.status !== "pending") return null;
  const firstQuestion = request.questions[0];
  const questionText = normalizeSuggestionText(firstQuestion?.question || firstQuestion?.header);
  const title = questionText ? truncateSuggestionText(questionText, 96) : "Answer a waiting task";
  return {
    id: `input-request:${request.id}`,
    title,
    description: `${request.questions.length} question${request.questions.length === 1 ? "" : "s"} waiting`,
    whyNow: "An automated task is paused until you respond.",
    action: { type: "task", taskId: request.taskId, focus: "input_request" },
    evidence: questionText ? [questionText] : undefined,
    source: "heartbeat",
    modules: ["Heartbeat", "Recent work"],
    priority: 390 - index,
    createdAt: request.requestedAt,
  };
}

export function dedupeWelcomeTaskSuggestions(
  suggestions: WelcomeTaskSuggestion[],
): WelcomeTaskSuggestion[] {
  const seen = new Set<string>();
  const out: WelcomeTaskSuggestion[] = [];
  for (const suggestion of suggestions.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return (b.createdAt || 0) - (a.createdAt || 0);
  })) {
    const key = normalizeSuggestionText(`${suggestion.source}:${suggestion.title}`).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(suggestion);
    if (out.length >= WELCOME_TASK_SUGGESTION_LIMIT) break;
  }
  return out;
}
