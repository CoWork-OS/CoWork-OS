import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  AlignLeft,
  BarChart2,
  BookOpen,
  Bug,
  Building2,
  Calculator,
  Calendar,
  CheckSquare,
  Clipboard,
  ClipboardList,
  Code2,
  CreditCard,
  Cpu,
  Eye,
  FileSearch,
  FileText,
  Filter,
  GitPullRequest,
  Globe,
  Home,
  Image,
  Inbox,
  Layers,
  Lightbulb,
  LineChart,
  List,
  Mail,
  MapPin,
  MessageSquare,
  Mic,
  Monitor,
  Music,
  PieChart,
  Receipt,
  RefreshCw,
  Replace,
  Rss,
  Scale,
  Scroll,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Users,
  Wrench,
  Zap,
} from "lucide-react";

type IdeaCategory =
  | "all"
  | "daily-ops"
  | "inbox"
  | "finance"
  | "dev"
  | "research"
  | "writing"
  | "legal"
  | "ai-media"
  | "models"
  | "life";

interface Idea {
  title: string;
  description: string;
  prompt: string;
  icon: LucideIcon;
  category: IdeaCategory;
  skill?: string;
  integrations?: string[];
  action?: "model-settings";
}

const CATEGORIES: { id: IdeaCategory; label: string }[] = [
  { id: "all", label: "All" },
  { id: "daily-ops", label: "Daily Ops" },
  { id: "inbox", label: "Inbox & Comms" },
  { id: "finance", label: "Finance" },
  { id: "dev", label: "Dev" },
  { id: "research", label: "Research" },
  { id: "writing", label: "Writing" },
  { id: "legal", label: "Legal" },
  { id: "ai-media", label: "AI & Media" },
  { id: "models", label: "Models & Routing" },
  { id: "life", label: "Life" },
];

const SECTION_LABELS = Object.fromEntries(
  CATEGORIES.map((c) => [c.id, c.label]),
) as Record<IdeaCategory, string>;

// NOTE: `skill` values are advisory hints included in the prompt text so the agent
// knows the intended skill name. They are not resolved against the skill registry at
// render time — if a skill doesn't exist the agent will fall back to built-in capabilities.
const IDEAS: Idea[] = [
  // ── Models & Routing ───────────────────────────────────────────────
  {
    title: "Connect another model source",
    description: "Add an account, API, gateway, cloud route, or local model.",
    prompt: "",
    icon: Cpu,
    category: "models",
    action: "model-settings",
  },
  {
    title: "Review routing and fallback",
    description: "Audit the current model route and propose a resilient fallback order.",
    prompt:
      "Review my configured model routes and help me design a fallback order. Compare capability, latency, cost boundaries, and tool compatibility. Do not change settings until I approve the plan.",
    icon: RefreshCw,
    category: "models",
  },
  {
    title: "Plan a two-model review",
    description: "Use different model strengths for a draft and an independent critique.",
    prompt:
      "Help me plan a two-model workflow for my next task: one route creates the draft and another independently critiques it. Ask what outcome I need, then recommend roles using only configured model routes.",
    icon: Layers,
    category: "models",
  },
  // ── Daily Ops ──────────────────────────────────────────────────────
  {
    title: "Morning chief-of-staff brief",
    description: "Calendar, inbox priorities, tasks due, and next actions formatted for mobile.",
    prompt: "Use the chief-of-staff-briefing skill. Build my morning executive brief from calendar, inbox, and tasks. Include an executive summary (3–6 bullets), calendar risks, inbox priorities, reminders due, and recommended actions in urgency order. Flag any missing signal sources. Format for mobile reading.",
    icon: Clipboard,
    category: "daily-ops",
    skill: "chief-of-staff-briefing",
  },
  {
    title: "Status report for standup",
    description: "Concise standup update from recent commits, tasks, and conversations.",
    prompt: "Use the twin-status-report skill. Generate a concise standup status report from my recent activity: tasks completed, in-progress work, blockers, and next steps. Keep it tight — 5 bullets max per section.",
    icon: BarChart2,
    category: "daily-ops",
    skill: "twin-status-report",
  },
  {
    title: "Meeting preparation brief",
    description: "Structured context, open items, and talking points for an upcoming meeting.",
    prompt: "Use the twin-meeting-prep skill. I'll tell you the meeting title and attendees. Prepare a structured brief with: relevant context, open items, key data points, and talking points. Flag any gaps I should fill before the meeting.",
    icon: Calendar,
    category: "daily-ops",
    skill: "twin-meeting-prep",
  },
  {
    title: "Decision preparation package",
    description: "Data, options, and trade-off analysis before making a key call.",
    prompt: "Use the twin-decision-prep skill. I'll describe the decision I'm facing. Assemble relevant data, enumerate the options with pros/cons, identify risks, and present a recommendation — but don't make the decision for me.",
    icon: Scale,
    category: "daily-ops",
    skill: "twin-decision-prep",
  },
  {
    title: "Family digest draft",
    description: "Daily digest of calendar events and tasks you can send to your family.",
    prompt: "Use the usecase-family-digest skill. Build a daily digest for tomorrow: calendar events, reminders, and scheduled tasks. Draft it as a short friendly message. STOP before sending and ask me to confirm.",
    icon: Users,
    category: "daily-ops",
    skill: "usecase-family-digest",
    integrations: ["calendar"],
  },

  // ── Inbox & Comms ──────────────────────────────────────────────────
  {
    title: "Full inbox autopilot",
    description: "Triage the last 24 h, draft replies, flag cleanup candidates. Stops before sending.",
    prompt: "Use the usecase-inbox-manager skill. Run inbox triage for the last 24 h. Classify each message as urgent / today / this-week / no-action. Output: priority table, draft replies for urgent items, cleanup candidates with suggestions. STOP before any action — ask me what to execute.",
    icon: Inbox,
    category: "inbox",
    skill: "usecase-inbox-manager",
    integrations: ["gmail"],
  },
  {
    title: "Draft reply with channel history",
    description: "Pull a Slack or messaging thread and produce two polished reply variants.",
    prompt: "Use the usecase-draft-reply skill. Use channel_list_chats for channel 'slack' (since '24h', limit 20). Ask me to pick the thread, pull channel_history (limit 80), and draft two crisp reply variants. STOP before sending.",
    icon: MessageSquare,
    category: "inbox",
    skill: "usecase-draft-reply",
    integrations: ["slack"],
  },
  {
    title: "Newsletter digest with follow-ups",
    description: "Summarise newsletters from the last 24 h and surface actionable follow-ups.",
    prompt: "Use the usecase-newsletter-digest skill. Ask me to pick the newsletter feed. Pull channel_history (limit 150) and produce a digest: title + link + 1–2 sentence summary per item. Propose follow-ups. No external action until I confirm.",
    icon: Rss,
    category: "inbox",
    skill: "usecase-newsletter-digest",
    integrations: ["slack"],
  },
  {
    title: "Transaction scan & fraud triage",
    description: "Scan bank notifications for suspicious charges and recommend next steps.",
    prompt: "Use the usecase-transaction-scan skill. Scan card/bank email notifications (last 14 days), extract transactions, flag suspicious items (new merchant, repeats, unusual amounts), and recommend next steps. Contact no one without confirmation.",
    icon: CreditCard,
    category: "inbox",
    skill: "usecase-transaction-scan",
    integrations: ["gmail"],
  },

  // ── Finance ────────────────────────────────────────────────────────
  {
    title: "DCF valuation",
    description: "WACC, free cash flow projections, terminal value, sensitivity analysis.",
    prompt: "Use the dcf-valuation skill. I'll give you a company or financial assumptions. Build a discounted cash flow model with WACC, FCF projections, terminal value, and a sensitivity table. Present enterprise value and equity value per share.",
    icon: Calculator,
    category: "finance",
    skill: "dcf-valuation",
  },
  {
    title: "Stock analysis",
    description: "Real-time quotes, fundamentals, technicals, and a buy/hold/sell summary.",
    prompt: "Use the stock-analysis skill. I'll give you a ticker. Fetch real-time quote, fundamentals (P/E, EPS, margins), technical indicators, and analyst sentiment. Summarise with a buy / hold / sell recommendation.",
    icon: TrendingUp,
    category: "finance",
    skill: "stock-analysis",
  },
  {
    title: "Earnings analyzer",
    description: "Parse earnings reports, flag beats/misses, and extract forward guidance.",
    prompt: "Use the earnings-analyzer skill. I'll provide a company and reporting period. Parse the earnings release, compute revenue and EPS beat/miss vs consensus, extract management commentary and forward guidance changes, and flag risks.",
    icon: LineChart,
    category: "finance",
    skill: "earnings-analyzer",
  },
  {
    title: "Portfolio optimizer",
    description: "Mean-variance optimisation, Sharpe ratio maximisation, rebalance plan.",
    prompt: "Use the portfolio-optimizer skill. I'll share my current holdings and risk tolerance. Run mean-variance optimisation, compute the efficient frontier, and produce a rebalance plan with percentage adjustments.",
    icon: PieChart,
    category: "finance",
    skill: "portfolio-optimizer",
  },
  {
    title: "Market screener",
    description: "Screen stocks or crypto against custom criteria and surface top opportunities.",
    prompt: "Use the market-screener skill. I'll define the screening criteria (sector, P/E range, momentum, etc.). Screen the market and present the top opportunities in a ranked table with supporting metrics.",
    icon: Filter,
    category: "finance",
    skill: "market-screener",
  },
  {
    title: "Tax optimizer",
    description: "Identify deductions, tax-loss harvesting opportunities, and year-end moves.",
    prompt: "Use the tax-optimizer skill. I'll describe my income sources, investments, and jurisdiction. Identify the most valuable deductions, tax-loss harvesting opportunities, and recommended year-end moves to minimise my tax liability.",
    icon: Receipt,
    category: "finance",
    skill: "tax-optimizer",
  },
  {
    title: "Startup CFO analysis",
    description: "Burn rate, runway, unit economics, and fundraising readiness score.",
    prompt: "Use the startup-cfo skill. I'll share my financials or assumptions. Compute burn rate, runway, LTV/CAC, gross margin, and a fundraising readiness score. Highlight the top 3 financial risks and recommended corrections.",
    icon: Building2,
    category: "finance",
    skill: "startup-cfo",
  },

  // ── Dev ────────────────────────────────────────────────────────────
  {
    title: "Code review",
    description: "Thorough review for bugs, security issues, style, and improvements.",
    prompt: "Use the code-review skill. I'll paste code or point to a file/PR. Review for correctness, security vulnerabilities, performance, and best practices. Produce a severity-labelled report with suggested fixes.",
    icon: Eye,
    category: "dev",
    skill: "code-review",
  },
  {
    title: "PR triage & review queue",
    description: "Scan open pull requests, assess risk, and build a prioritised review queue.",
    prompt: "Use the twin-pr-triage skill. Scan open PRs for a repo I specify. Assess complexity, risk, and staleness. Produce a prioritised review queue with recommended reviewer and a one-line change summary.",
    icon: GitPullRequest,
    category: "dev",
    skill: "twin-pr-triage",
  },
  {
    title: "Debug error",
    description: "Root-cause analysis and minimal fix for any error or unexpected behaviour.",
    prompt: "Use the debug-error skill. I'll paste the error message and context. Investigate the root cause and propose a minimal fix pointing to the exact file and line.",
    icon: Bug,
    category: "dev",
    skill: "debug-error",
  },
  {
    title: "Security audit",
    description: "Scan code for OWASP top-10, injection, auth flaws, and hardcoded secrets.",
    prompt: "Use the security-audit skill. I'll share a codebase path or paste code. Scan for OWASP top-10 vulnerabilities, injection risks, authentication weaknesses, and hardcoded secrets. Produce a severity-ranked report with remediation steps.",
    icon: ShieldCheck,
    category: "dev",
    skill: "security-audit",
  },
  {
    title: "Dev task queue from issues",
    description: "Build an agent-ready task queue from open issues with acceptance criteria.",
    prompt: "Use the usecase-dev-task-queue skill. I'll specify a repo. Collect open high-priority issues, define acceptance criteria and dependencies, assess risk, and suggest owner. Run up to 8 tasks in parallel. STOP before merge/deploy without my approval.",
    icon: List,
    category: "dev",
    skill: "usecase-dev-task-queue",
  },
  {
    title: "Batch migration across codebase",
    description: "Replace a term or pattern across all files with a grouped diff and checklist.",
    prompt: "I will specify the old term and new term. Run a batch migration: find all occurrences, group by domain, keep behaviour unchanged. Produce a per-file checklist and diff summary. STOP before applying and show me the full plan first.",
    icon: Replace,
    category: "dev",
  },
  {
    title: "Refactor code",
    description: "Improve structure, readability, and maintainability without changing behaviour.",
    prompt: "Use the refactor-code skill. I'll point you to code. Identify structural issues, duplication, and readability problems. Produce a refactored version with an explanation of each change. Keep external behaviour identical.",
    icon: Wrench,
    category: "dev",
    skill: "refactor-code",
  },
  {
    title: "Generate README",
    description: "Create a professional README from project structure and code.",
    prompt: "Use the generate-readme skill. Analyse the project structure, entry points, and key modules. Generate a README with: description, installation, usage examples, API reference, and contribution guide.",
    icon: FileText,
    category: "dev",
    skill: "generate-readme",
  },

  // ── Research ───────────────────────────────────────────────────────
  {
    title: "Competitive research",
    description: "Map top competitors, positioning, pricing, strengths, and differentiation gaps.",
    prompt: "Use the competitive-research skill. I'll describe the market. Research the top 3–5 competitors: positioning, features, pricing, strengths, weaknesses. Identify differentiation gaps I could exploit.",
    icon: Globe,
    category: "research",
    skill: "competitive-research",
  },
  {
    title: "Idea validation",
    description: "Market research, competitor scan, and go/no-go recommendation.",
    prompt: "Use the idea-validation skill. I'll describe my idea. Validate it with: market sizing, competitor landscape, key risks, and a go/no-go recommendation with supporting evidence.",
    icon: Lightbulb,
    category: "research",
    skill: "idea-validation",
  },
  {
    title: "Blog & content monitor",
    description: "Fetch recent posts from blogs or feeds and surface the most relevant.",
    prompt: "Use the blogwatcher skill. I'll give you blogs or feeds to monitor. Fetch recent posts, filter by relevance to topics I specify, and produce a ranked digest with excerpts and action items.",
    icon: Rss,
    category: "research",
    skill: "blogwatcher",
  },
  {
    title: "Figure it out (multi-attempt)",
    description: "Resilient problem-solving with fallback strategy and an auditable attempt log.",
    prompt: "Use the usecase-figure-it-out-agent skill. I'll describe the goal. Try the direct path first. If it fails, switch methods and keep an attempt log. Up to 3 fallback attempts. STOP before irreversible actions.",
    icon: Zap,
    category: "research",
    skill: "usecase-figure-it-out-agent",
  },
  {
    title: "Research the last N days",
    description: "Summarise key developments in a topic over a custom time window.",
    prompt: "Use the research-last-days skill. I'll specify the topic and number of days. Search for significant developments, group by sub-theme, and produce a structured summary with citations and a 'what to watch next' section.",
    icon: FileSearch,
    category: "research",
    skill: "research-last-days",
  },

  // ── Writing ────────────────────────────────────────────────────────
  {
    title: "Summarise a document",
    description: "Key points, decisions, and action items extracted from any document.",
    prompt: "Use the summarize skill. I'll share a file or paste text. Extract key points, decisions, action items, and open questions into a concise structured summary.",
    icon: AlignLeft,
    category: "writing",
    skill: "summarize",
  },
  {
    title: "Proofread & polish",
    description: "Fix grammar, clarity, and tone while preserving the author's voice.",
    prompt: "Use the proofread skill. I'll paste text. Fix grammar, spelling, punctuation, and awkward phrasing. Improve clarity without changing meaning or style. Show me a diff of changes.",
    icon: CheckSquare,
    category: "writing",
    skill: "proofread",
  },
  {
    title: "Translate content",
    description: "High-quality translation preserving tone, idioms, and formatting.",
    prompt: "Use the translate skill. I'll paste the text and specify the target language. Translate preserving tone and idioms. Flag culturally sensitive phrases and suggest localised alternatives.",
    icon: Globe,
    category: "writing",
    skill: "translate",
  },
  {
    title: "Write a PRD",
    description: "Product requirements document with goals, user stories, and success metrics.",
    prompt: "Use the prd skill. I'll describe the product or feature. Write a full PRD: executive summary, problem statement, goals, user stories, functional requirements, and success metrics.",
    icon: ClipboardList,
    category: "writing",
    skill: "prd",
  },
  {
    title: "Humanise AI-generated text",
    description: "Rewrite AI output to sound natural, varied, and genuinely human.",
    prompt: "Use the humanizer skill. I'll paste AI-generated text. Rewrite it with varied sentence length, natural hedging, and personality — preserve meaning and length.",
    icon: Sparkles,
    category: "writing",
    skill: "humanizer",
  },
  {
    title: "Email marketing bible",
    description: "Subject lines, sequences, CTAs, and A/B test plan for an email campaign.",
    prompt: "Use the email-marketing-bible skill. I'll describe the product and audience. Generate: positioning, subject line variants, 5-email nurture sequence, CTA copy, and an A/B testing plan.",
    icon: Send,
    category: "writing",
    skill: "email-marketing-bible",
  },

  // ── Legal ──────────────────────────────────────────────────────────
  {
    title: "Contract review & negotiation",
    description: "Flag risky clauses, suggest redlines, and rate overall contract risk.",
    prompt: "Use the legal-contract-negotiation-review skill. I'll share the contract. Review for risky clauses (indemnification, liability, IP, termination). Suggest redlines, flag missing protections, and produce an overall risk rating with negotiation priorities.",
    icon: Scroll,
    category: "legal",
    skill: "legal-contract-negotiation-review",
  },
  {
    title: "Demand letter draft",
    description: "Draft a professional demand letter or respond to one received.",
    prompt: "Use the legal-demand-letter-response-draft skill. I'll describe the situation. Draft a formal demand letter (or response) with clear facts, legal basis, specific demand, and deadline. Flag where local legal advice is needed.",
    icon: Mail,
    category: "legal",
    skill: "legal-demand-letter-response-draft",
  },
  {
    title: "Legal research memo",
    description: "Verified legal research on a question with citations and uncertainty flags.",
    prompt: "Use the legal-verified-research-memo skill. I'll pose a legal question and jurisdiction. Research applicable law and produce a memo with: question, short answer, analysis, citations, and clear uncertainty flags for where an attorney is needed.",
    icon: BookOpen,
    category: "legal",
    skill: "legal-verified-research-memo",
  },

  // ── AI & Media ─────────────────────────────────────────────────────
  {
    title: "Generate an image",
    description: "Create high-quality images from a text prompt using DALL-E.",
    prompt: "Use the openai-image-gen skill. I'll describe the image (subject, style, mood, aspect ratio). Generate it and show the result. If it's not right, suggest 3 prompt refinements.",
    icon: Image,
    category: "ai-media",
    skill: "openai-image-gen",
  },
  {
    title: "Transcribe audio or video",
    description: "High-accuracy transcription with speaker labels and timestamps.",
    prompt: "Use the openai-whisper skill. I'll provide the audio or video file. Transcribe with timestamps and speaker labels. Produce a clean transcript and a summary of key points.",
    icon: Mic,
    category: "ai-media",
    skill: "openai-whisper",
  },
  {
    title: "Agentic image loop",
    description: "Iteratively generate and refine images until they match your vision.",
    prompt: "Use the agentic-image-loop skill. I'll describe the target image. Generate an initial version, critique and refine iteratively, and keep a log of each iteration with what changed.",
    icon: RefreshCw,
    category: "ai-media",
    skill: "agentic-image-loop",
  },
  {
    title: "Screenshot & describe",
    description: "Capture the screen and get an AI description of what's visible.",
    prompt: "Use the peekaboo skill. Take a screenshot of the current screen or a window I specify. Describe UI elements, content, and any errors or anomalies in detail. Then answer any specific question I have.",
    icon: Monitor,
    category: "ai-media",
    skill: "peekaboo",
  },
  {
    title: "Analyse a CSV dataset",
    description: "Statistical summary, outlier detection, and chart suggestions from any CSV.",
    prompt: "Use the analyze-csv skill. I'll share the CSV file. Compute summary statistics, detect outliers and missing values, identify correlations, and suggest the best chart types for the key insights.",
    icon: Layers,
    category: "ai-media",
    skill: "analyze-csv",
  },
  {
    title: "Summarise a folder of files",
    description: "Batch-summarise every file in a folder into a structured digest.",
    prompt: "Use the summarize-folder skill. I'll point you to a folder. Summarise every file: key points, type, and relevance. Group by topic and produce a master index with links to per-file summaries.",
    icon: FileSearch,
    category: "ai-media",
    skill: "summarize-folder",
  },

  // ── Life ───────────────────────────────────────────────────────────
  {
    title: "Restaurant booking options",
    description: "Find openings, cross-check calendar, propose 3 conflict-free slots.",
    prompt: "Use the usecase-booking-options skill. I'll give you the restaurant URL and party size. Find openings in the next 14 days between 6:30 pm and 8:30 pm. Cross-check my calendar. Propose the 3 best options. STOP before booking.",
    icon: MapPin,
    category: "life",
    skill: "usecase-booking-options",
    integrations: ["calendar"],
  },
  {
    title: "Household tasks to Notion",
    description: "Turn a messy household list into Notion tasks with optional Reminders.",
    prompt: "Use the usecase-household-capture skill. I'll give you a list of household tasks. Create a Notion page per task (ask me for database_id). If Apple Reminders is available, also create reminders for due tasks. Return created page URLs and reminder IDs.",
    icon: Home,
    category: "life",
    skill: "usecase-household-capture",
    integrations: ["notion"],
  },
  {
    title: "Smart home dry-run plan",
    description: "Orchestrate smart-home actions with a safety-first dry run.",
    prompt: "Use the usecase-smart-home-brain skill. I'll describe what I want (e.g. 'Set evening mode'). Produce a dry-run plan: device, action, expected effect, rollback. Respect quiet hours 22:00–07:00. STOP before any physical state change. If integrations are missing, give me a setup checklist.",
    icon: Lightbulb,
    category: "life",
    skill: "usecase-smart-home-brain",
  },
  {
    title: "Spotify mood queue",
    description: "Queue up a playlist based on your current mood or activity.",
    prompt: "Use the spotify-player skill. Ask me for my current mood or activity (e.g. deep work, workout, wind-down). Build a playlist of 15–20 tracks that fits and queue it in Spotify.",
    icon: Music,
    category: "life",
    skill: "spotify-player",
  },
  {
    title: "Compare two files",
    description: "Diff any two files and surface meaningful differences with context.",
    prompt: "Use the compare-files skill. I'll provide two file paths. Produce a structured diff highlighting added, removed, and changed lines. Group changes by section and summarise the overall scope of differences.",
    icon: Code2,
    category: "life",
    skill: "compare-files",
  },
  {
    title: "Research local options",
    description: "Find local places, services, or events using web search.",
    prompt: "Use the local-websearch skill. I'll describe what I'm looking for and my location. Search for the top options nearby, compare by rating, price, and distance, and produce a ranked shortlist with links.",
    icon: Search,
    category: "life",
    skill: "local-websearch",
  },
];

function IntegrationIcon({ name }: { name: string }) {
  const label =
    name === "slack" ? "S" :
    name === "gmail" ? "G" :
    name === "notion" ? "N" :
    name === "calendar" ? "C" : "•";
  return (
    <span className="dp-idea-icon" data-integration={name} aria-label={name}>
      {label}
    </span>
  );
}

interface IdeasPanelProps {
  onCreateTaskFromPrompt: (prompt: string) => void;
  onOpenModelSettings?: () => void;
}

export function IdeasPanel({ onCreateTaskFromPrompt, onOpenModelSettings }: IdeasPanelProps) {
  const [activeCategory, setActiveCategory] = useState<IdeaCategory>("all");

  const sections =
    activeCategory === "all"
      ? CATEGORIES.filter((c) => c.id !== "all").map((c) => ({
          category: c.id,
          label: c.label,
          ideas: IDEAS.filter((i) => i.category === c.id),
        })).filter((s) => s.ideas.length > 0)
      : [{
          category: activeCategory,
          label: SECTION_LABELS[activeCategory],
          ideas: IDEAS.filter((i) => i.category === activeCategory),
        }];

  return (
    <div className="devices-panel">
      <div className="dp-header">
        <h1 className="dp-title">Ideas</h1>
      </div>

      {/* Category filter row — same dp-filter-chip pattern as Devices tab */}
      <div className="dp-filter-row dp-ideas-filter-row">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            type="button"
            className={`dp-filter-chip${activeCategory === cat.id ? " active" : ""}`}
            onClick={() => setActiveCategory(cat.id)}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Sections */}
      {sections.map(({ category, label, ideas }) => (
        <div key={category} className="dp-section">
          {activeCategory === "all" && (
            <div className="dp-section-header">
              <span className="dp-section-label">{label}</span>
            </div>
          )}
          <div className="dp-ideas-grid">
            {ideas.map((idea, idx) => {
              const Icon = idea.icon;
              return (
                <button
                  key={idx}
                  type="button"
                  className="dp-task-card dp-idea-card"
                  onClick={() => {
                    if (idea.action === "model-settings") {
                      onOpenModelSettings?.();
                      return;
                    }
                    onCreateTaskFromPrompt(idea.prompt);
                  }}
                  title={idea.title}
                >
                  <div className="dp-idea-top">
                    <span className="dp-idea-icon-wrap">
                      <Icon size={16} />
                    </span>
                    <span className="dp-task-title dp-idea-title">{idea.title}</span>
                  </div>
                  <p className="dp-idea-desc">{idea.description}</p>
                  <div className="dp-task-meta dp-idea-meta">
                    {idea.integrations && idea.integrations.length > 0 && (
                      <span className="dp-idea-icons" aria-hidden="true">
                        {idea.integrations.slice(0, 3).map((int) => (
                          <IntegrationIcon key={int} name={int} />
                        ))}
                      </span>
                    )}
                    {idea.skill && (
                      <span className="dp-purpose-chip subtle">{idea.skill}</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
