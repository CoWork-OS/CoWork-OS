import type { ExecutionMode, TaskDomain } from "../../../shared/types";
import {
  MessageCircle,
  Play,
  ListTodo,
  Search,
  Bug,
  ShieldCheck,
  Sparkles,
  Code,
  BookOpen,
  Settings,
  PenLine,
  LayoutGrid,
  Film,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { FocusedCard } from "./main-content-types";
import {
  LLM_WIKI_GUI_PROMPT,
  LLM_WIKI_EXPLORE_GUI_PROMPT,
} from "../../../shared/starter-missions";

export const EXECUTION_MODE_ORDER: ExecutionMode[] = ["chat", "execute", "plan", "analyze", "debug", "verified"];
export const TASK_DOMAIN_ORDER: TaskDomain[] = [
  "auto",
  "code",
  "research",
  "operations",
  "writing",
  "general",
  "media",
];
export const EXECUTION_MODE_LABEL: Record<ExecutionMode, string> = {
  chat: "Chat",
  execute: "Execute",
  plan: "Plan",
  analyze: "Analyze",
  debug: "Debug",
  verified: "Verified",
};
export const EXECUTION_MODE_HINT: Record<ExecutionMode, string> = {
  chat: "Direct chat, no tools",
  execute: "Full task execution with tools",
  plan: "Planning mode, no mutating tools",
  analyze: "Read-only analysis mode",
  debug: "Evidence-first debugging: instrument, reproduce, fix, clean up",
  verified: "Execute with verification after each step",
};
export const TASK_DOMAIN_LABEL: Record<TaskDomain, string> = {
  auto: "Auto",
  code: "Code",
  research: "Research",
  operations: "Operations",
  writing: "Writing",
  general: "General",
  media: "Video",
};
export const TASK_DOMAIN_HINT: Record<TaskDomain, string> = {
  auto: "Adapts orchestration automatically",
  code: "Optimized for coding and refactors",
  research: "Optimized for research and synthesis",
  operations: "Optimized for infra and operational workflows",
  writing: "Optimized for writing and editing output",
  general: "Balanced behavior for mixed tasks",
  media: "Video generation mode — uses video tools strongly",
};
export const EXECUTION_MODE_ICON: Record<ExecutionMode, LucideIcon> = {
  chat: MessageCircle,
  execute: Play,
  plan: ListTodo,
  analyze: Search,
  debug: Bug,
  verified: ShieldCheck,
};
export const TASK_DOMAIN_ICON: Record<TaskDomain, LucideIcon> = {
  auto: Sparkles,
  code: Code,
  research: BookOpen,
  operations: Settings,
  writing: PenLine,
  general: LayoutGrid,
  media: Film,
};

export const FOCUSED_CARD_POOL: FocusedCard[] = [
  // --- Task starters ---
  {
    id: "write",
    emoji: "✏️",
    iconName: "edit",
    title: "Write something",
    desc: "Emails, reports, documents, or creative content",
    action: {
      type: "prompt",
      prompt:
        "I have a writing task for you. Let me describe what I need and let's create it together.",
    },
    category: "task",
  },
  {
    id: "research",
    emoji: "🔍",
    iconName: "search",
    title: "Research a topic",
    desc: "Deep-dive into any subject and get a summary",
    action: {
      type: "prompt",
      prompt: "I need help researching a topic. Let me tell you what I'm looking into.",
    },
    category: "task",
  },
  {
    id: "analyze",
    emoji: "📊",
    iconName: "chart",
    title: "Analyze data",
    desc: "Crunch numbers, find patterns, build reports",
    action: {
      type: "prompt",
      prompt:
        "I have some data I'd like to analyze. Let me share the files and tell you what I'm looking for.",
    },
    category: "task",
  },
  {
    id: "files",
    emoji: "📁",
    iconName: "folder",
    title: "Work with files",
    desc: "Sort, rename, convert, or organize anything",
    action: {
      type: "prompt",
      prompt:
        "I need help working with some files. Let me point you to the folder and explain what I need.",
    },
    category: "task",
  },
  {
    id: "build",
    emoji: "⚡",
    iconName: "zap",
    title: "Build something",
    desc: "Code, automate, or create from scratch",
    action: {
      type: "prompt",
      prompt: "I need help building or coding something. Let me describe the project.",
    },
    category: "task",
  },
  {
    id: "chat",
    emoji: "💬",
    iconName: "message",
    title: "Just chat",
    desc: "Think out loud, brainstorm, or ask me anything",
    action: {
      type: "prompt",
      prompt: "Let's just chat. I have something on my mind I'd like to talk through.",
    },
    category: "task",
  },
  {
    id: "meeting",
    emoji: "📋",
    iconName: "clipboard",
    title: "Prep for a meeting",
    desc: "Create agendas, talking points, and notes",
    action: {
      type: "prompt",
      prompt: "Help me prepare for a meeting. I need an agenda and talking points.",
    },
    category: "task",
  },
  {
    id: "document",
    emoji: "📄",
    iconName: "filetext",
    title: "Create a document",
    desc: "Word docs, PDFs, presentations, or spreadsheets",
    action: {
      type: "prompt",
      prompt: "I need to create a document. Let me describe the format and content I need.",
    },
    category: "task",
  },
  {
    id: "email",
    emoji: "✉️",
    iconName: "edit",
    title: "Draft an email",
    desc: "Professional, clear, and on-point every time",
    action: {
      type: "prompt",
      prompt: "Help me draft an email. Here's the context and who it's for.",
    },
    category: "task",
  },
  {
    id: "summarize",
    emoji: "📝",
    iconName: "filetext",
    title: "Summarize something",
    desc: "Condense long texts, articles, or meeting notes",
    action: {
      type: "prompt",
      prompt: "I have something I need summarized. Let me share it with you.",
    },
    category: "task",
  },
  {
    id: "code",
    emoji: "💻",
    iconName: "code",
    title: "Debug or review code",
    desc: "Find bugs, explain code, or suggest improvements",
    action: {
      type: "prompt",
      prompt: "I have some code I need help with. Let me share it and explain the issue.",
    },
    category: "task",
  },
  {
    id: "translate",
    emoji: "🌐",
    iconName: "globe",
    title: "Translate content",
    desc: "Translate text between any languages",
    action: {
      type: "prompt",
      prompt: "I need something translated. Let me share the text and the target language.",
    },
    category: "task",
  },
  {
    id: "morning-brief",
    emoji: "☀️",
    iconName: "calendar",
    title: "Create a daily brief",
    desc: "Inbox, calendar, tasks, and top priorities",
    action: {
      type: "prompt",
      prompt:
        "Create a daily brief for me. Use my calendar, inbox, tasks, and workspace context if they are connected. Include today's schedule, urgent messages, open commitments, and the top 3 actions to take next.",
    },
    category: "task",
  },
  {
    id: "inbox-triage",
    emoji: "📬",
    iconName: "message",
    title: "Triage my inbox",
    desc: "Find urgent mail, drafts, and follow-ups",
    action: {
      type: "prompt",
      prompt:
        "Triage my inbox. If Gmail or another mailbox is connected, identify messages that need a reply, urgent decisions, follow-ups, waiting items, and safe archive candidates. Ask before taking any action.",
    },
    category: "task",
  },
  {
    id: "slide-deck",
    emoji: "🖥️",
    iconName: "filetext",
    title: "Make a slide deck",
    desc: "Turn notes into a polished presentation",
    action: {
      type: "prompt",
      prompt:
        "Create a slide deck from material I provide. Ask for the audience and goal first, then build a clear outline, slide copy, speaker notes, and a polished deck artifact.",
    },
    category: "task",
  },
  {
    id: "spreadsheet-model",
    emoji: "📈",
    iconName: "chart",
    title: "Build a spreadsheet",
    desc: "Create models, trackers, and summaries",
    action: {
      type: "prompt",
      prompt:
        "Build a spreadsheet for a workflow I describe. Ask for the inputs and decisions it needs to support, then create a structured workbook with formulas, summaries, and clear tabs.",
    },
    category: "task",
  },
  {
    id: "transcribe-audio",
    emoji: "🎧",
    iconName: "filetext",
    title: "Transcribe audio",
    desc: "Extract notes, decisions, and action items",
    action: {
      type: "prompt",
      prompt:
        "Transcribe an audio or video file for me. After I share it, produce a clean transcript, key points, decisions, and action items.",
    },
    category: "task",
  },
  {
    id: "build-automation",
    emoji: "🔁",
    iconName: "zap",
    title: "Automate a workflow",
    desc: "Turn repeated work into a routine",
    action: {
      type: "prompt",
      prompt:
        "Help me automate a repeated workflow. Ask what triggers it, what information it needs, what actions it should take, and where approval is required before anything sensitive happens.",
    },
    category: "task",
  },
  {
    id: "decision-memo",
    emoji: "⚖️",
    iconName: "clipboard",
    title: "Compare options",
    desc: "Tradeoffs, risks, and a recommendation",
    action: {
      type: "prompt",
      prompt:
        "Help me compare options. I'll describe the decision, constraints, and candidates. Build a decision memo with tradeoffs, risks, unknowns, and a recommendation.",
    },
    category: "task",
  },

  // --- Setup & integration suggestions ---
  {
    id: "setup-whatsapp",
    emoji: "📱",
    iconName: "message",
    title: "Connect WhatsApp",
    desc: "Chat with your AI from WhatsApp",
    action: { type: "settings", tab: "whatsapp" },
    category: "setup",
  },
  {
    id: "setup-telegram",
    emoji: "✈️",
    iconName: "message",
    title: "Connect Telegram",
    desc: "Send tasks from Telegram anytime",
    action: { type: "settings", tab: "telegram" },
    category: "setup",
  },
  {
    id: "setup-slack",
    emoji: "💼",
    iconName: "message",
    title: "Connect Slack",
    desc: "Bring your AI into your team workspace",
    action: { type: "settings", tab: "slack" },
    category: "setup",
  },
  {
    id: "setup-google-workspace",
    emoji: "📎",
    iconName: "folder",
    title: "Connect Google Workspace",
    desc: "Use Gmail, Calendar, Drive, Docs, Sheets, Slides, and Tasks",
    action: { type: "settings", tab: "integrations" },
    category: "setup",
  },
  {
    id: "setup-web-search",
    emoji: "🌐",
    iconName: "globe",
    title: "Enable web search",
    desc: "Let tasks fetch live information",
    action: { type: "settings", tab: "search" },
    category: "setup",
  },
  {
    id: "setup-more-channels",
    emoji: "💬",
    iconName: "message",
    title: "Connect more channels",
    desc: "Add Teams, email, Signal, or Google Chat",
    action: { type: "settings", tab: "morechannels" },
    category: "setup",
  },
  {
    id: "setup-connectors",
    emoji: "🧰",
    iconName: "sliders",
    title: "Add app connectors",
    desc: "Connect GitHub, Figma, Vercel, and more",
    action: { type: "settings", tab: "integrations" },
    category: "setup",
  },
  {
    id: "setup-voice",
    emoji: "🎙️",
    iconName: "sliders",
    title: "Set up voice",
    desc: "Talk to your AI using your microphone",
    action: { type: "settings", tab: "voice" },
    category: "setup",
  },
  {
    id: "setup-skills",
    emoji: "🧩",
    iconName: "zap",
    title: "Explore skills",
    desc: "Add custom skills to extend capabilities",
    action: { type: "settings", tab: "skills" },
    category: "setup",
  },
  {
    id: "setup-schedule",
    emoji: "⏰",
    iconName: "calendar",
    title: "Schedule a task",
    desc: "Set up recurring tasks that run automatically",
    action: { type: "settings", tab: "scheduled" },
    category: "setup",
  },
  {
    id: "setup-mcp",
    emoji: "🔌",
    iconName: "sliders",
    title: "Connect tools",
    desc: "Add external tools and services",
    action: { type: "settings", tab: "mcp" },
    category: "setup",
  },
  {
    id: "setup-guardrails",
    emoji: "🛡️",
    iconName: "shield",
    title: "Set safety limits",
    desc: "Control what your AI can and cannot do",
    action: { type: "settings", tab: "system" },
    category: "setup",
  },

  {
    id: "competitors",
    emoji: "🏁",
    iconName: "search",
    title: "Research competitors",
    desc: "Analyze a market and find opportunities",
    action: {
      type: "prompt",
      prompt:
        "Research the top 3-5 competitors in a market I'll describe. For each, find their positioning, key features, pricing, strengths, and weaknesses. Then identify gaps I could exploit.",
    },
    category: "task",
  },
  {
    id: "research-vault",
    emoji: "🧠",
    iconName: "book",
    title: "Build a research vault",
    desc: "Create a persistent Obsidian-friendly knowledge base",
    action: {
      type: "prompt",
      prompt: LLM_WIKI_GUI_PROMPT,
    },
    category: "task",
  },
  {
    id: "validate-idea",
    emoji: "💡",
    iconName: "zap",
    title: "Validate an idea",
    desc: "Market size, competitors, and a go/no-go call",
    action: {
      type: "prompt",
      prompt:
        "Help me validate a business idea. I'll describe the concept, and you'll assess the market size, competitors, unique angle, and give a go/no-go recommendation.",
    },
    category: "task",
  },
  {
    id: "weekly-plan",
    emoji: "📅",
    iconName: "calendar",
    title: "Plan my week",
    desc: "Build a day-by-day schedule with priorities",
    action: {
      type: "prompt",
      prompt:
        "Help me create a weekly plan. Ask about my goals, deadlines, and priorities, then build a day-by-day schedule with clear deliverables.",
    },
    category: "task",
  },

  // --- Feature discovery ---
  {
    id: "discover-memory",
    emoji: "🧠",
    iconName: "book",
    title: "I remember things",
    desc: "I learn your preferences over time",
    action: { type: "prompt", prompt: "What do you remember about me and my preferences?" },
    category: "discover",
  },
  {
    id: "discover-browse",
    emoji: "🌍",
    iconName: "globe",
    title: "I can browse the web",
    desc: "Search, read pages, and fetch live data",
    action: {
      type: "prompt",
      prompt: "Search the web for the latest news on a topic I'll describe.",
    },
    category: "discover",
  },
  {
    id: "discover-files",
    emoji: "📂",
    iconName: "folder",
    title: "I can read your files",
    desc: "Drop files here or point me to a folder",
    action: { type: "prompt", prompt: "Show me what files are in my current workspace." },
    category: "discover",
  },
  {
    id: "discover-agents",
    emoji: "🤖",
    iconName: "zap",
    title: "I work autonomously",
    desc: "Give me a goal and I'll figure out the steps",
    action: {
      type: "prompt",
      prompt:
        "I have a complex task that needs multiple steps. Let me describe the goal and you plan it out.",
    },
    category: "discover",
  },
  {
    id: "discover-documents",
    emoji: "📑",
    iconName: "filetext",
    title: "I can make files",
    desc: "Docs, PDFs, slides, and spreadsheets",
    action: {
      type: "prompt",
      prompt:
        "Show me what kinds of documents, PDFs, slide decks, and spreadsheets you can create in this workspace.",
    },
    category: "discover",
  },
  {
    id: "discover-images",
    emoji: "🖼️",
    iconName: "search",
    title: "I can inspect images",
    desc: "Upload screenshots, mockups, or photos",
    action: {
      type: "prompt",
      prompt:
        "I want to analyze an image or screenshot. Tell me what you can inspect and what details are useful to include when I upload it.",
    },
    category: "discover",
  },
  {
    id: "discover-tests",
    emoji: "✅",
    iconName: "code",
    title: "I can run checks",
    desc: "Build, lint, test, and explain failures",
    action: {
      type: "prompt",
      prompt:
        "Check this project for quality issues. Inspect the available scripts, recommend the right build, lint, or test commands, and run the safest targeted checks.",
    },
    category: "discover",
  },
  {
    id: "discover-automations",
    emoji: "⏳",
    iconName: "calendar",
    title: "I can follow up",
    desc: "Create scheduled and recurring work",
    action: { type: "settings", tab: "scheduled" },
    category: "discover",
  },
  {
    id: "discover-vault",
    emoji: "🗂️",
    iconName: "book",
    title: "I can grow a vault",
    desc: "Save research, sources, and durable notes",
    action: {
      type: "prompt",
      prompt: LLM_WIKI_EXPLORE_GUI_PROMPT,
    },
    category: "discover",
  },
  {
    id: "discover-multimodel",
    emoji: "🔄",
    iconName: "sliders",
    title: "Switch AI models",
    desc: "Use Claude, GPT, Gemini, or local models",
    action: { type: "settings", tab: "llm" },
    category: "discover",
  },
];

export const CARDS_TO_SHOW = 3;

export function shuffleArray<T>(arr: T[]): T[] {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function pickFocusedCards(pool: FocusedCard[], count: number): FocusedCard[] {
  // Ensure a good mix while respecting the requested card count.
  const tasks = shuffleArray(pool.filter((c) => c.category === "task"));
  const setup = shuffleArray(pool.filter((c) => c.category === "setup"));
  const discover = shuffleArray(pool.filter((c) => c.category === "discover"));
  const categoryPicks = [tasks[0], setup[0], discover[0]].filter(Boolean) as FocusedCard[];
  const picked = categoryPicks.slice(0, count);
  // Fill remaining from the rest
  const usedIds = new Set(picked.map((c) => c.id));
  const remaining = shuffleArray(pool.filter((c) => !usedIds.has(c.id)));
  picked.push(...remaining.slice(0, count - picked.length));
  // Shuffle final order so categories aren't grouped
  return shuffleArray(picked);
}
