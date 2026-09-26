// Shared starter mission templates used across Onboarding and MainContent welcome screen

interface StarterMissionBase {
  id: string;
  title: string;
  icon: string;
  category: "productivity" | "code" | "research" | "writing" | "planning";
}

export type StarterMission =
  | (StarterMissionBase & { kind: "prompt"; prompt: string })
  | (StarterMissionBase & { kind: "bundled"; fixtureId: "release-brief-v1"; version: 1 });

export const LLM_WIKI_GUI_PROMPT =
  "Build a persistent Obsidian-friendly research vault in this workspace. If I have not given the topic yet, ask me for it first. Preserve raw sources, create linked notes, keep the index, inbox, and log current, and file durable answers or visuals back into the vault.";

export const LLM_WIKI_QUERY_GUI_PROMPT =
  "Use the research vault in this workspace to answer a question. If I have not asked the question yet, ask me for it first. Search the vault before branching outward and file durable syntheses back into queries/ or comparisons/.";

export const LLM_WIKI_AUDIT_GUI_PROMPT =
  "Audit the research vault in this workspace for broken links, orphan notes, weak pages, stale content, missing source capture, and missing output opportunities. Put concrete follow-up work into inbox.md.";

export const LLM_WIKI_EXPLORE_GUI_PROMPT =
  "Use the research vault in this workspace to identify the 5 most interesting unexplored connections between existing topics. Explain why each connection matters, what evidence already exists in the vault, what is still missing, and file durable follow-up ideas into inbox.md or queries/.";

export const LLM_WIKI_BRIEF_GUI_PROMPT =
  "Use the research vault in this workspace to write an executive briefing on a topic I give you. If I have not named the topic yet, ask me for it first. Answer from the vault first, cite the relevant vault pages, and save the briefing back into outputs/ or queries/ if it is worth keeping.";

/**
 * Starter missions shown during onboarding and on the welcome screen.
 * Each mission provides an actionable, one-click task that demonstrates
 * CoWork OS capabilities immediately.
 */
export const STARTER_MISSIONS: StarterMission[] = [
  {
    kind: "bundled",
    id: "release-brief-v1",
    title: "Turn a messy release folder into a launch brief",
    fixtureId: "release-brief-v1",
    version: 1,
    icon: "📦",
    category: "writing",
  },
  {
    kind: "prompt",
    id: "plan-30min",
    title: "Plan my next 30 minutes",
    prompt:
      "Plan my next 30 minutes. Ask me what I'm working on, then create a focused, realistic schedule with specific tasks and time blocks.",
    icon: "⏱️",
    category: "productivity",
  },
  {
    kind: "prompt",
    id: "landing-page",
    title: "Build a landing page",
    prompt:
      "Help me build a landing page for my idea. I'll describe the concept and you'll create a clean HTML/CSS page with a hero section, features list, and call to action.",
    icon: "🚀",
    category: "code",
  },
  {
    kind: "prompt",
    id: "competitor-research",
    title: "Research my competitors",
    prompt:
      "Research the top 3-5 competitors in a market I'll describe. For each, find their positioning, key features, pricing, strengths, and weaknesses. Then identify gaps I could exploit.",
    icon: "🔍",
    category: "research",
  },
  {
    kind: "prompt",
    id: "autoresearch-report",
    title: "Research a science question",
    prompt:
      "Use the autoresearch-report skill to research a scientific question I give you. Build a scope, gather evidence, and produce a cited report with an uncertainty section and artifact manifest.",
    icon: "🔬",
    category: "research",
  },
  {
    kind: "prompt",
    id: "llm-wiki",
    title: "Build a research vault",
    prompt: LLM_WIKI_GUI_PROMPT,
    icon: "🧠",
    category: "research",
  },
  {
    kind: "prompt",
    id: "review-commit",
    title: "Review my last commit",
    prompt:
      "Review the most recent Git commit in this workspace. Check for bugs, security issues, code quality, and suggest improvements.",
    icon: "🔎",
    category: "code",
  },
  {
    kind: "prompt",
    id: "draft-brief",
    title: "Draft a project brief",
    prompt:
      "Help me draft a project brief. I'll describe the project and you'll create a structured document with goals, scope, timeline, risks, and success criteria.",
    icon: "📋",
    category: "writing",
  },
  {
    kind: "prompt",
    id: "novelist",
    title: "Write a novel end-to-end",
    prompt: "/novelist",
    icon: "📚",
    category: "writing",
  },
  {
    kind: "prompt",
    id: "summarize-pdf",
    title: "Summarize a document",
    prompt:
      "Summarize a document for me. I'll share the file and you'll extract the key points, action items, and decisions into a concise summary.",
    icon: "📄",
    category: "writing",
  },
  {
    kind: "prompt",
    id: "weekly-plan",
    title: "Create a weekly plan",
    prompt:
      "Help me create a weekly plan. Ask about my goals, deadlines, and priorities, then build a day-by-day schedule with clear deliverables.",
    icon: "📅",
    category: "planning",
  },
  {
    kind: "prompt",
    id: "debug-error",
    title: "Debug an error",
    prompt:
      "Help me debug an error. I'll paste the error message and describe what I was doing, and you'll investigate the root cause and suggest a fix.",
    icon: "🐛",
    category: "code",
  },
  {
    kind: "prompt",
    id: "follow-up-email",
    title: "Draft a follow-up email",
    prompt:
      "Help me draft a professional follow-up email. I'll describe the context and recipient, and you'll write something clear, warm, and actionable.",
    icon: "✉️",
    category: "writing",
  },
  {
    kind: "prompt",
    id: "focus-today",
    title: "What should I focus on today?",
    prompt:
      "Help me decide what to focus on today. Ask about my current projects, deadlines, and energy level, then recommend my top 3 priorities with reasoning.",
    icon: "🎯",
    category: "planning",
  },
  {
    kind: "prompt",
    id: "daily-brief",
    title: "Create a daily brief",
    prompt:
      "Create a daily brief for me. Use my calendar, inbox, tasks, and workspace context if they are connected. Include today's schedule, urgent messages, open commitments, and the top 3 actions to take next.",
    icon: "☀️",
    category: "productivity",
  },
  {
    kind: "prompt",
    id: "inbox-triage",
    title: "Triage my inbox",
    prompt:
      "Triage my inbox. If Gmail or another mailbox is connected, identify messages that need a reply, urgent decisions, follow-ups, waiting items, and safe archive candidates. Ask before taking any action.",
    icon: "📬",
    category: "productivity",
  },
  {
    kind: "prompt",
    id: "slide-deck",
    title: "Make a slide deck",
    prompt:
      "Create a slide deck from material I provide. Ask for the audience and goal first, then build a clear outline, slide copy, speaker notes, and a polished deck artifact.",
    icon: "🖥️",
    category: "writing",
  },
  {
    kind: "prompt",
    id: "spreadsheet-model",
    title: "Build a spreadsheet",
    prompt:
      "Build a spreadsheet for a workflow I describe. Ask for the inputs and decisions it needs to support, then create a structured workbook with formulas, summaries, and clear tabs.",
    icon: "📈",
    category: "planning",
  },
  {
    kind: "prompt",
    id: "transcribe-audio",
    title: "Transcribe audio",
    prompt:
      "Transcribe an audio or video file for me. After I share it, produce a clean transcript, key points, decisions, and action items.",
    icon: "🎧",
    category: "writing",
  },
  {
    kind: "prompt",
    id: "build-automation",
    title: "Automate a workflow",
    prompt:
      "Help me automate a repeated workflow. Ask what triggers it, what information it needs, what actions it should take, and where approval is required before anything sensitive happens.",
    icon: "🔁",
    category: "productivity",
  },
  {
    kind: "prompt",
    id: "decision-memo",
    title: "Compare options",
    prompt:
      "Help me compare options. I'll describe the decision, constraints, and candidates. Build a decision memo with tradeoffs, risks, unknowns, and a recommendation.",
    icon: "⚖️",
    category: "planning",
  },
];
