import type {
  AddUserFactRequest,
  LLMProviderType,
  PersonaId,
  PersonalityId,
  ResponseStylePreferences,
} from "./types";

export type OnboardingAssistantTraitId = "sharp" | "friendly" | "witty" | "adaptive";
export type OnboardingTimeDrainId =
  | "planning"
  | "research"
  | "writing"
  | "busywork"
  | "email"
  | "meetings"
  | "other";
export type OnboardingPriorityId =
  | "email"
  | "research"
  | "writing"
  | "automation"
  | "planning"
  | "focus"
  | "other";
export type OnboardingResponseStyleId = "short" | "detailed" | "depends" | "custom";

export interface OnboardingOption<T extends string> {
  id: T;
  title: string;
  description: string;
}

export interface OnboardingProfileData {
  assistantName: string;
  assistantTraits: OnboardingAssistantTraitId[];
  userName: string;
  userContext: string;
  timeDrains: OnboardingTimeDrainId[];
  timeDrainsOther: string;
  priorities: OnboardingPriorityId[];
  prioritiesOther: string;
  workflowTools: string;
  responseStyle: OnboardingResponseStyleId | null;
  responseStyleCustom: string;
  additionalGuidance: string;
  voiceEnabled: boolean | null;
  workStyle: "planner" | "flexible" | null;
  memoryEnabled: boolean;
  selectedProvider: LLMProviderType | null;
  detectedOllamaModel: string | null;
}

export interface ApplyOnboardingProfileRequest {
  workspaceId?: string | null;
  data: OnboardingProfileData;
}

export interface ApplyOnboardingProfileResult {
  success: boolean;
  workspaceId?: string;
}

export const ONBOARDING_ASSISTANT_TRAITS: OnboardingOption<OnboardingAssistantTraitId>[] = [
  {
    id: "sharp",
    title: "Sharp and efficient",
    description: "Direct, fast, and focused on execution.",
  },
  {
    id: "friendly",
    title: "Friendly and encouraging",
    description: "Warm when it helps, supportive without fluff.",
  },
  {
    id: "witty",
    title: "Witty with restraint",
    description: "A little edge and personality when it fits.",
  },
  {
    id: "adaptive",
    title: "Adapts to the task",
    description: "Switches tone and depth based on the work.",
  },
];

export const ONBOARDING_TIME_DRAINS: OnboardingOption<OnboardingTimeDrainId>[] = [
  {
    id: "planning",
    title: "Planning and organizing",
    description: "Structuring work, sequencing, and keeping priorities straight.",
  },
  {
    id: "research",
    title: "Research",
    description: "Finding, comparing, and distilling information quickly.",
  },
  {
    id: "writing",
    title: "Writing and editing",
    description: "Drafting, revising, and polishing documents or messages.",
  },
  {
    id: "busywork",
    title: "Repetitive busywork",
    description: "Low-leverage admin work that keeps coming back.",
  },
  {
    id: "email",
    title: "Inbox and follow-ups",
    description: "Triaging messages, replies, and open communication loops.",
  },
  {
    id: "meetings",
    title: "Meetings and context switching",
    description: "Losing time to fragmented attention and scattered updates.",
  },
  {
    id: "other",
    title: "Something else",
    description: "Capture a custom time drain in your own words.",
  },
];

export const ONBOARDING_PRIORITIES: OnboardingOption<OnboardingPriorityId>[] = [
  {
    id: "email",
    title: "Triage and draft replies",
    description: "Keep inbox pressure low and responses moving.",
  },
  {
    id: "research",
    title: "Research and synthesize",
    description: "Turn big topics into clear, usable takeaways.",
  },
  {
    id: "writing",
    title: "Write and edit",
    description: "Draft faster and tighten final copy.",
  },
  {
    id: "automation",
    title: "Automate repetitive tasks",
    description: "Reduce recurring manual work where possible.",
  },
  {
    id: "planning",
    title: "Plan and prioritize",
    description: "Keep the next best action obvious.",
  },
  {
    id: "focus",
    title: "Protect focus time",
    description: "Reduce noise and keep momentum on important work.",
  },
  {
    id: "other",
    title: "Something else",
    description: "Capture a custom priority in your own words.",
  },
];

export const ONBOARDING_RESPONSE_STYLES: OnboardingOption<OnboardingResponseStyleId>[] = [
  {
    id: "short",
    title: "Short and direct",
    description: "Get to the point without extra framing.",
  },
  {
    id: "detailed",
    title: "Detailed with context",
    description: "Include reasoning, tradeoffs, and supporting context.",
  },
  {
    id: "depends",
    title: "Depends on the task",
    description: "Default to concise, expand when complexity actually requires it.",
  },
  {
    id: "custom",
    title: "Something else",
    description: "Use a custom response style preference.",
  },
];

export const ONBOARDING_COMMAND_OPTIONS = [
  {
    id: "builtin-onboard",
    name: "onboard",
    description: "Run onboarding again and update your setup.",
    icon: "✨",
  },
  {
    id: "builtin-start",
    name: "start",
    description: "Start the onboarding flow.",
    icon: "🚀",
  },
] as const;

const ONBOARDING_SLASH_COMMANDS = new Set(["/start", "/onboard", "/begin", "/cowork-os:begin"]);

export function getOnboardingOptionTitle<T extends string>(
  options: OnboardingOption<T>[],
  value: T,
): string {
  return options.find((option) => option.id === value)?.title || value;
}

export function uniqueOnboardingIds<T extends string>(values: T[]): T[] {
  return Array.from(new Set(values));
}

export function parseOnboardingSlashCommand(value: string): { matched: boolean; command?: string } {
  const trimmed = String(value || "")
    .trim()
    .toLowerCase();
  if (!trimmed.startsWith("/")) return { matched: false };
  const [command, ...rest] = trimmed.split(/\s+/);
  if (!ONBOARDING_SLASH_COMMANDS.has(command)) return { matched: false };
  if (rest.length > 0) return { matched: false };
  return { matched: true, command };
}

export function getResolvedResponseStyleLabel(data: OnboardingProfileData): string {
  switch (data.responseStyle) {
    case "short":
      return "Short and direct";
    case "detailed":
      return "Detailed with context";
    case "depends":
      return "Depends on the task";
    case "custom":
      return data.responseStyleCustom.trim() || "Custom";
    default:
      return "Not set yet";
  }
}

export function getAssistantTraitsSummary(data: OnboardingProfileData): string {
  const selected = uniqueOnboardingIds(data.assistantTraits);
  if (selected.length === 0) {
    return "Direct, capable, and adaptive to the work.";
  }

  const labels = selected.map((id) => getOnboardingOptionTitle(ONBOARDING_ASSISTANT_TRAITS, id));
  if (labels.length === 1) {
    return `${labels[0]}.`;
  }
  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}.`;
  }
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}.`;
}

export function deriveOnboardingPersonalityPreset(data: OnboardingProfileData): PersonalityId {
  const traits = new Set(data.assistantTraits);
  const responseStyle = data.responseStyle;

  if (traits.has("friendly")) return "friendly";
  if (traits.has("witty")) return "casual";
  if (traits.has("sharp") && responseStyle === "short") return "concise";
  if (responseStyle === "detailed") return "technical";
  return "professional";
}

export function deriveOnboardingPersona(data: OnboardingProfileData): PersonaId {
  return data.assistantTraits.includes("friendly") ? "companion" : "none";
}

export function deriveResponseStylePreferences(
  data: OnboardingProfileData,
): ResponseStylePreferences {
  switch (data.responseStyle) {
    case "short":
      return {
        emojiUsage: "none",
        responseLength: "terse",
        codeCommentStyle: "minimal",
        explanationDepth: "expert",
      };
    case "detailed":
      return {
        emojiUsage: "minimal",
        responseLength: "detailed",
        codeCommentStyle: "moderate",
        explanationDepth: "teaching",
      };
    case "custom":
      return {
        emojiUsage: "minimal",
        responseLength: "balanced",
        codeCommentStyle: "moderate",
        explanationDepth: "balanced",
      };
    case "depends":
    default:
      return {
        emojiUsage: "none",
        responseLength: "balanced",
        codeCommentStyle: "minimal",
        explanationDepth: "balanced",
      };
  }
}

function listSelectedTitles<T extends string>(
  options: OnboardingOption<T>[],
  selected: T[],
  otherId?: T,
  otherText?: string,
): string[] {
  const unique = uniqueOnboardingIds(selected);
  const titles = unique
    .filter((value) => value !== otherId)
    .map((value) => getOnboardingOptionTitle(options, value))
    .filter((value) => value.trim().length > 0);

  if (otherId && unique.includes(otherId) && otherText?.trim()) {
    titles.push(otherText.trim());
  }

  return titles;
}

export function getTimeDrainTitles(data: OnboardingProfileData): string[] {
  return listSelectedTitles(ONBOARDING_TIME_DRAINS, data.timeDrains, "other", data.timeDrainsOther);
}

export function getPriorityTitles(data: OnboardingProfileData): string[] {
  return listSelectedTitles(ONBOARDING_PRIORITIES, data.priorities, "other", data.prioritiesOther);
}

export function buildOnboardingUserSummary(data: OnboardingProfileData): string {
  const context = data.userContext.trim();
  const drains = getTimeDrainTitles(data);
  const priorities = getPriorityTitles(data);
  const tools = data.workflowTools.trim();
  const responseStyle = getResolvedResponseStyleLabel(data);

  const parts: string[] = [];
  if (context) parts.push(context);
  if (drains.length > 0) parts.push(`Biggest drains: ${drains.join(", ")}.`);
  if (priorities.length > 0) parts.push(`Top priorities: ${priorities.join(", ")}.`);
  if (tools) parts.push(`Core tools: ${tools}.`);
  parts.push(`Preferred response style: ${responseStyle}.`);

  if (data.additionalGuidance.trim()) {
    parts.push(`Always keep in mind: ${data.additionalGuidance.trim()}.`);
  }

  return parts.join(" ");
}

export function buildOnboardingProfileFacts(data: OnboardingProfileData): AddUserFactRequest[] {
  const facts: AddUserFactRequest[] = [];
  const userName = data.userName.trim();
  const userContext = data.userContext.trim();
  const tools = data.workflowTools.trim();
  const additionalGuidance = data.additionalGuidance.trim();
  const responseStyle = getResolvedResponseStyleLabel(data);
  const drains = getTimeDrainTitles(data);
  const priorities = getPriorityTitles(data);

  if (userName) {
    facts.push({
      category: "identity",
      value: `Preferred name: ${userName}`,
      confidence: 1,
      source: "manual",
      pinned: true,
    });
  }

  if (userContext) {
    facts.push({
      category: "work",
      value: `Current work context: ${userContext}`,
      confidence: 0.95,
      source: "manual",
      pinned: true,
    });
  }

  if (drains.length > 0) {
    facts.push({
      category: "work",
      value: `Main time drains: ${drains.join(", ")}.`,
      confidence: 0.9,
      source: "manual",
    });
  }

  if (priorities.length > 0) {
    facts.push({
      category: "goal",
      value: `Main priorities: ${priorities.join(", ")}.`,
      confidence: 0.9,
      source: "manual",
      pinned: true,
    });
  }

  if (tools) {
    facts.push({
      category: "work",
      value: `Core tools: ${tools}.`,
      confidence: 0.85,
      source: "manual",
    });
  }

  facts.push({
    category: "preference",
    value: `Preferred response style: ${responseStyle}.`,
    confidence: 0.95,
    source: "manual",
    pinned: true,
  });

  if (additionalGuidance) {
    facts.push({
      category: "preference",
      value: `Onboarding guidance: ${additionalGuidance}`,
      confidence: 0.9,
      source: "manual",
      pinned: true,
    });
  }

  if (data.memoryEnabled) {
    facts.push({
      category: "preference",
      value: "Memory is enabled for useful recurring context.",
      confidence: 0.9,
      source: "manual",
    });
  }

  return facts;
}

export function buildOnboardingWorkspaceSummary(data: OnboardingProfileData): {
  assistantStyle: string;
  userSummary: string;
  priorities: string[];
  timeDrains: string[];
  responseStyle: string;
} {
  return {
    assistantStyle: getAssistantTraitsSummary(data),
    userSummary: buildOnboardingUserSummary(data),
    priorities: getPriorityTitles(data),
    timeDrains: getTimeDrainTitles(data),
    responseStyle: getResolvedResponseStyleLabel(data),
  };
}
