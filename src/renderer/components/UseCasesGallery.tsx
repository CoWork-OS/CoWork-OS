import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import "./use-cases-gallery.css";

export type UseCaseCategory = "cowork" | "build" | "bots";

interface UseCase {
  emoji: string;
  /** Shown on the card. */
  prompt: string;
  /** Sent to the composer instead of `prompt` when the card steers a specific skill. */
  run?: string;
}

// Example prompts are limited to things CoWork OS can actually do with its
// built-in tools, skills, connectors, channels, scheduling and bots. The Tasks
// list includes every former Ideas-panel workflow; `run` keeps its skill prompt.
const COWORK_USE_CASES: UseCase[] = [
  {
    emoji: "🔌",
    prompt:
      "Help me connect another model source — an account, API key, gateway, cloud route, or a local model — and test it.",
    run: "Help me connect another model source — an account, API key, gateway, cloud route, or a local model — and test it.",
  },
  {
    emoji: "🔀",
    prompt:
      "Review my model routes and design a fallback order by capability, latency, and cost. Don't change settings until I approve.",
    run: "Review my configured model routes and help me design a fallback order. Compare capability, latency, cost boundaries, and tool compatibility. Do not change settings until I approve the plan.",
  },
  {
    emoji: "🧠",
    prompt:
      "Plan a two-model workflow: one model drafts, a different one critiques it independently, using only the routes I've configured.",
    run: "Help me plan a two-model workflow for my next task: one route creates the draft and another independently critiques it. Ask what outcome I need, then recommend roles using only configured model routes.",
  },
  {
    emoji: "☀️",
    prompt:
      "Build my morning brief from calendar, inbox, and tasks: top priorities, calendar risks, what's due, and next actions — formatted for my phone.",
    run: "Use the chief-of-staff-briefing skill. Build my morning executive brief from calendar, inbox, and tasks. Include an executive summary (3–6 bullets), calendar risks, inbox priorities, reminders due, and recommended actions in urgency order. Flag any missing signal sources. Format for mobile reading.",
  },
  {
    emoji: "👨‍👩‍👧",
    prompt:
      "Draft tomorrow's family digest from my calendar, reminders, and scheduled tasks as a short friendly message, and stop before sending.",
    run: "Use the usecase-family-digest skill. Build a daily digest for tomorrow: calendar events, reminders, and scheduled tasks. Draft it as a short friendly message. STOP before sending and ask me to confirm.",
  },
  {
    emoji: "📥",
    prompt:
      "Triage my last 24 hours of email into urgent, today, this week, and no action. Draft replies for urgent ones and suggest cleanup — ask before acting.",
    run: "Use the usecase-inbox-manager skill. Run inbox triage for the last 24 h. Classify each message as urgent / today / this-week / no-action. Output: priority table, draft replies for urgent items, cleanup candidates with suggestions. STOP before any action — ask me what to execute.",
  },
  {
    emoji: "💬",
    prompt:
      "Pull a Slack thread from today and draft two crisp reply options I can choose from. Don't send anything.",
    run: "Use the usecase-draft-reply skill. Use channel_list_chats for channel 'slack' (since '24h', limit 20). Ask me to pick the thread, pull channel_history (limit 80), and draft two crisp reply variants. STOP before sending.",
  },
  {
    emoji: "📰",
    prompt:
      "Summarize the newsletters from the last 24 hours with links and one-line takeaways, and suggest follow-ups.",
    run: "Use the usecase-newsletter-digest skill. Ask me to pick the newsletter feed. Pull channel_history (limit 150) and produce a digest: title + link + 1–2 sentence summary per item. Propose follow-ups. No external action until I confirm.",
  },
  {
    emoji: "💳",
    prompt:
      "Scan my card and bank emails from the last two weeks and flag new merchants, repeat charges, or unusual amounts.",
    run: "Use the usecase-transaction-scan skill. Scan card/bank email notifications (last 14 days), extract transactions, flag suspicious items (new merchant, repeats, unusual amounts), and recommend next steps. Contact no one without confirmation.",
  },
  {
    emoji: "💹",
    prompt:
      "Build a DCF model for a company: WACC, free cash flow projections, terminal value, and a sensitivity table.",
    run: "Use the dcf-valuation skill. I'll give you a company or financial assumptions. Build a discounted cash flow model with WACC, FCF projections, terminal value, and a sensitivity table. Present enterprise value and equity value per share.",
  },
  {
    emoji: "📈",
    prompt:
      "Analyze a ticker: live quote, fundamentals, technicals, analyst sentiment, and a buy / hold / sell summary.",
    run: "Use the stock-analysis skill. I'll give you a ticker. Fetch real-time quote, fundamentals (P/E, EPS, margins), technical indicators, and analyst sentiment. Summarise with a buy / hold / sell recommendation.",
  },
  {
    emoji: "📉",
    prompt:
      "Break down the latest earnings report: beats and misses vs consensus, guidance changes, and new risks.",
    run: "Use the earnings-analyzer skill. I'll provide a company and reporting period. Parse the earnings release, compute revenue and EPS beat/miss vs consensus, extract management commentary and forward guidance changes, and flag risks.",
  },
  {
    emoji: "🥧",
    prompt:
      "Optimize my portfolio for my risk tolerance and give me a rebalance plan with percentage changes.",
    run: "Use the portfolio-optimizer skill. I'll share my current holdings and risk tolerance. Run mean-variance optimisation, compute the efficient frontier, and produce a rebalance plan with percentage adjustments.",
  },
  {
    emoji: "🔎",
    prompt:
      "Screen stocks against my criteria — sector, P/E range, momentum — and rank the top opportunities in a table.",
    run: "Use the market-screener skill. I'll define the screening criteria (sector, P/E range, momentum, etc.). Screen the market and present the top opportunities in a ranked table with supporting metrics.",
  },
  {
    emoji: "🧾",
    prompt:
      "Find my most valuable deductions, tax-loss harvesting opportunities, and year-end moves based on my income and investments.",
    run: "Use the tax-optimizer skill. I'll describe my income sources, investments, and jurisdiction. Identify the most valuable deductions, tax-loss harvesting opportunities, and recommended year-end moves to minimise my tax liability.",
  },
  {
    emoji: "🚀",
    prompt:
      "Compute our burn, runway, LTV/CAC, and gross margin, score our fundraising readiness, and list the top three financial risks.",
    run: "Use the startup-cfo skill. I'll share my financials or assumptions. Compute burn rate, runway, LTV/CAC, gross margin, and a fundraising readiness score. Highlight the top 3 financial risks and recommended corrections.",
  },
  {
    emoji: "🧑‍💻",
    prompt:
      "Review this pull request for bugs, security issues, and performance, with fixes labeled by severity.",
    run: "Use the code-review skill. I'll paste code or point to a file/PR. Review for correctness, security vulnerabilities, performance, and best practices. Produce a severity-labelled report with suggested fixes.",
  },
  {
    emoji: "🐞",
    prompt:
      "Here's an error and its stack trace. Find the root cause and propose a minimal fix with the exact file and line.",
    run: "Use the debug-error skill. I'll paste the error message and context. Investigate the root cause and propose a minimal fix pointing to the exact file and line.",
  },
  {
    emoji: "🔐",
    prompt:
      "Audit this codebase for OWASP top-10 issues, injection risks, auth flaws, and hardcoded secrets, ranked by severity.",
    run: "Use the security-audit skill. I'll share a codebase path or paste code. Scan for OWASP top-10 vulnerabilities, injection risks, authentication weaknesses, and hardcoded secrets. Produce a severity-ranked report with remediation steps.",
  },
  {
    emoji: "📋",
    prompt:
      "Turn the repo's high-priority open issues into an agent-ready task queue and work through them in parallel — stop before merging.",
    run: "Use the usecase-dev-task-queue skill. I'll specify a repo. Collect open high-priority issues, define acceptance criteria and dependencies, assess risk, and suggest owner. Run up to 8 tasks in parallel. STOP before merge/deploy without my approval.",
  },
  {
    emoji: "🔁",
    prompt:
      "Rename an old term to a new one across the whole codebase. Show me the grouped plan and diff before applying.",
    run: "I will specify the old term and new term. Run a batch migration: find all occurrences, group by domain, keep behaviour unchanged. Produce a per-file checklist and diff summary. STOP before applying and show me the full plan first.",
  },
  {
    emoji: "🧱",
    prompt:
      "Refactor this module for readability and less duplication without changing behavior, and explain each change.",
    run: "Use the refactor-code skill. I'll point you to code. Identify structural issues, duplication, and readability problems. Produce a refactored version with an explanation of each change. Keep external behaviour identical.",
  },
  {
    emoji: "📘",
    prompt:
      "Write a README for this project: what it does, install steps, usage examples, API reference, and how to contribute.",
    run: "Use the generate-readme skill. Analyse the project structure, entry points, and key modules. Generate a README with: description, installation, usage examples, API reference, and contribution guide.",
  },
  {
    emoji: "🥊",
    prompt:
      "Map our top five competitors' positioning, pricing, strengths, and weaknesses, and find gaps we could own.",
    run: "Use the competitive-research skill. I'll describe the market. Research the top 3–5 competitors: positioning, features, pricing, strengths, weaknesses. Identify differentiation gaps I could exploit.",
  },
  {
    emoji: "💡",
    prompt:
      "Validate my startup idea: market size, competitors, key risks, and a go / no-go call with evidence.",
    run: "Use the idea-validation skill. I'll describe my idea. Validate it with: market sizing, competitor landscape, key risks, and a go/no-go recommendation with supporting evidence.",
  },
  {
    emoji: "🛰️",
    prompt:
      "Watch these blogs and feeds and send me a ranked digest of posts relevant to my topics, with excerpts.",
    run: "Use the blogwatcher skill. I'll give you blogs or feeds to monitor. Fetch recent posts, filter by relevance to topics I specify, and produce a ranked digest with excerpts and action items.",
  },
  {
    emoji: "🧩",
    prompt:
      "Figure this out: try the direct path, switch methods if it fails, keep an attempt log, and stop before anything irreversible.",
    run: "Use the usecase-figure-it-out-agent skill. I'll describe the goal. Try the direct path first. If it fails, switch methods and keep an attempt log. Up to 3 fallback attempts. STOP before irreversible actions.",
  },
  {
    emoji: "🗞️",
    prompt:
      "What happened in AI agents in the last 14 days? Group by theme, cite sources, and add what to watch next.",
    run: "Use the research-last-days skill. I'll specify the topic and number of days. Search for significant developments, group by sub-theme, and produce a structured summary with citations and a 'what to watch next' section.",
  },
  {
    emoji: "📄",
    prompt: "Summarize this document into key points, decisions, action items, and open questions.",
    run: "Use the summarize skill. I'll share a file or paste text. Extract key points, decisions, action items, and open questions into a concise structured summary.",
  },
  {
    emoji: "✍️",
    prompt:
      "Proofread this draft for grammar and clarity while keeping my voice, and show me the changes.",
    run: "Use the proofread skill. I'll paste text. Fix grammar, spelling, punctuation, and awkward phrasing. Improve clarity without changing meaning or style. Show me a diff of changes.",
  },
  {
    emoji: "🌍",
    prompt:
      "Translate this into Japanese, keeping tone and formatting, and flag phrases that need localizing.",
    run: "Use the translate skill. I'll paste the text and specify the target language. Translate preserving tone and idioms. Flag culturally sensitive phrases and suggest localised alternatives.",
  },
  {
    emoji: "🗒️",
    prompt:
      "Write a PRD for this feature: problem, goals, user stories, requirements, and success metrics.",
    run: "Use the prd skill. I'll describe the product or feature. Write a full PRD: executive summary, problem statement, goals, user stories, functional requirements, and success metrics.",
  },
  {
    emoji: "🗣️",
    prompt:
      "Rewrite this AI-sounding text so it reads naturally, with varied rhythm, keeping the meaning and length.",
    run: "Use the humanizer skill. I'll paste AI-generated text. Rewrite it with varied sentence length, natural hedging, and personality — preserve meaning and length.",
  },
  {
    emoji: "📧",
    prompt:
      "Plan an email campaign for our launch: positioning, subject lines, a five-email nurture sequence, CTAs, and an A/B test plan.",
    run: "Use the email-marketing-bible skill. I'll describe the product and audience. Generate: positioning, subject line variants, 5-email nurture sequence, CTA copy, and an A/B testing plan.",
  },
  {
    emoji: "⚖️",
    prompt:
      "Review this contract for risky clauses — indemnity, liability, IP, termination — suggest redlines, and rate the overall risk.",
    run: "Use the legal-contract-negotiation-review skill. I'll share the contract. Review for risky clauses (indemnification, liability, IP, termination). Suggest redlines, flag missing protections, and produce an overall risk rating with negotiation priorities.",
  },
  {
    emoji: "✉️",
    prompt:
      "Draft a firm demand letter for an unpaid invoice with the facts, basis, amount, and deadline, flagging where I need a lawyer.",
    run: "Use the legal-demand-letter-response-draft skill. I'll describe the situation. Draft a formal demand letter (or response) with clear facts, legal basis, specific demand, and deadline. Flag where local legal advice is needed.",
  },
  {
    emoji: "🏛️",
    prompt:
      "Write a research memo on my legal question with a short answer, analysis, citations, and where an attorney is needed.",
    run: "Use the legal-verified-research-memo skill. I'll pose a legal question and jurisdiction. Research applicable law and produce a memo with: question, short answer, analysis, citations, and clear uncertainty flags for where an attorney is needed.",
  },
  {
    emoji: "🎨",
    prompt:
      "Generate a cover image for my blog post in a flat illustration style, then suggest three refinements.",
    run: "Use the openai-image-gen skill. I'll describe the image (subject, style, mood, aspect ratio). Generate it and show the result. If it's not right, suggest 3 prompt refinements.",
  },
  {
    emoji: "🎙️",
    prompt:
      "Transcribe this meeting recording with speaker labels and timestamps, then summarize the key points.",
    run: "Use the openai-whisper skill. I'll provide the audio or video file. Transcribe with timestamps and speaker labels. Produce a clean transcript and a summary of key points.",
  },
  {
    emoji: "🔄",
    prompt:
      "Iterate on a product mockup image until it matches my description, logging what changed each round.",
    run: "Use the agentic-image-loop skill. I'll describe the target image. Generate an initial version, critique and refine iteratively, and keep a log of each iteration with what changed.",
  },
  {
    emoji: "📸",
    prompt: "Take a screenshot of this window and tell me what's on it, including any errors.",
    run: "Use the peekaboo skill. Take a screenshot of the current screen or a window I specify. Describe UI elements, content, and any errors or anomalies in detail. Then answer any specific question I have.",
  },
  {
    emoji: "📊",
    prompt:
      "Analyze this CSV: summary stats, outliers, missing values, correlations, and which charts would show it best.",
    run: "Use the analyze-csv skill. I'll share the CSV file. Compute summary statistics, detect outliers and missing values, identify correlations, and suggest the best chart types for the key insights.",
  },
  {
    emoji: "📁",
    prompt: "Summarize every file in this folder and build a master index grouped by topic.",
    run: "Use the summarize-folder skill. I'll point you to a folder. Summarise every file: key points, type, and relevance. Group by topic and produce a master index with links to per-file summaries.",
  },
  {
    emoji: "🍽️",
    prompt:
      "Find openings at this restaurant for four in the next two weeks, check my calendar, and give me three conflict-free options.",
    run: "Use the usecase-booking-options skill. I'll give you the restaurant URL and party size. Find openings in the next 14 days between 6:30 pm and 8:30 pm. Cross-check my calendar. Propose the 3 best options. STOP before booking.",
  },
  {
    emoji: "🏡",
    prompt:
      "Turn my messy household list into Notion tasks, with Apple Reminders for anything that has a due date.",
    run: "Use the usecase-household-capture skill. I'll give you a list of household tasks. Create a Notion page per task (ask me for database_id). If Apple Reminders is available, also create reminders for due tasks. Return created page URLs and reminder IDs.",
  },
  {
    emoji: "🌙",
    prompt:
      "Plan an evening mode for my smart home as a dry run — devices, actions, rollback — and don't change anything yet.",
    run: "Use the usecase-smart-home-brain skill. I'll describe what I want (e.g. 'Set evening mode'). Produce a dry-run plan: device, action, expected effect, rollback. Respect quiet hours 22:00–07:00. STOP before any physical state change. If integrations are missing, give me a setup checklist.",
  },
  {
    emoji: "🎧",
    prompt: "Queue 15–20 tracks on Spotify for a deep-work session.",
    run: "Use the spotify-player skill. Ask me for my current mood or activity (e.g. deep work, workout, wind-down). Build a playlist of 15–20 tracks that fits and queue it in Spotify.",
  },
  {
    emoji: "🆚",
    prompt:
      "Compare these two versions of the proposal and summarize what was added, removed, and changed by section.",
    run: "Use the compare-files skill. I'll provide two file paths. Produce a structured diff highlighting added, removed, and changed lines. Group changes by section and summarise the overall scope of differences.",
  },
  {
    emoji: "📍",
    prompt:
      "Find the best-rated climbing gyms near me and rank them by rating, price, and distance.",
    run: "Use the local-websearch skill. I'll describe what I'm looking for and my location. Search for the top options nearby, compare by rating, price, and distance, and produce a ranked shortlist with links.",
  },
  {
    emoji: "🎬",
    prompt:
      "Watch this screen recording of the bug, show me the frames where it breaks, and find the code that causes it.",
  },
  {
    emoji: "🛠️",
    prompt:
      "The test suite started failing after yesterday's merge. Find the breaking commit, fix it, and open a pull request.",
  },
  {
    emoji: "🌐",
    prompt:
      "Build a landing page for our beta from this one-pager, preview it in the Browser Workbench, and check desktop and mobile.",
  },
  {
    emoji: "🧪",
    prompt:
      "Open our staging site in the Browser Workbench, run through signup and checkout, and report anything broken with screenshots.",
  },
  {
    emoji: "📚",
    prompt:
      "/llm-wiki build a research vault on EU AI Act obligations for our product, with sources I can cite.",
  },
  {
    emoji: "🚶",
    prompt:
      "I have an hour near my office. Find a pharmacy, a post office, and a coffee shop on one walking route.",
  },
  {
    emoji: "🧹",
    prompt:
      "Use unbroker to find where my personal data is listed on people-search sites and queue opt-out requests for my approval.",
  },
  {
    emoji: "☸️",
    prompt:
      "Our pods keep restarting in the staging cluster. Check the events and logs, explain why, and propose a fix.",
  },
  {
    emoji: "📐",
    prompt:
      "Write this paper's methods section in LaTeX from my notes and compile it to a PDF I can review.",
  },
  {
    emoji: "🗓️",
    prompt:
      "Every Friday at 5 p.m., log what I finished this week from my tasks and commits, and draft next week's priorities.",
  },
  {
    emoji: "🧭",
    prompt:
      "/inbox — find threads where I promised something and haven't followed up, and draft the follow-ups.",
  },
];

const BUILD_USE_CASES: UseCase[] = [
  {
    emoji: "📈",
    prompt:
      "Turn our monthly revenue spreadsheet into a dashboard with region filters, a trend chart, and KPI cards for growth and churn.",
  },
  {
    emoji: "🗳️",
    prompt:
      "Build a feature-voting board where my team can add ideas, upvote them, and sort by votes or status.",
  },
  {
    emoji: "🚦",
    prompt:
      "Make a release readiness tracker that shows each launch checklist item as on track, at risk, or blocked, with owners.",
  },
  {
    emoji: "🧮",
    prompt:
      "Build a pricing calculator for our sales team: pick a plan, seats, and term, and see the quote with discounts applied.",
  },
  {
    emoji: "🗓️",
    prompt:
      "Create an on-call rotation planner that shows who's on call each week and highlights swaps and holidays.",
  },
  {
    emoji: "📦",
    prompt:
      "Turn my supplier report into a live inventory app that flags items below reorder level.",
  },
  {
    emoji: "🎤",
    prompt:
      "Build a webinar run-of-show timer with segments, speakers, and a big countdown I can put on a second screen.",
  },
  {
    emoji: "🧾",
    prompt:
      "Make an expense splitter for our team offsite: add expenses, who paid, and see who owes whom.",
  },
  {
    emoji: "🗺️",
    prompt:
      "Plot our customer list from this CSV on a map, sized by revenue, with a click-through card for each account.",
  },
  {
    emoji: "✅",
    prompt:
      "Build a hiring pipeline board with candidate cards I can drag between stages and a summary of each stage's count.",
  },
  {
    emoji: "📝",
    prompt:
      "Create an interactive onboarding checklist for new hires with progress saved in the browser.",
  },
  {
    emoji: "🔍",
    prompt:
      "Build a log viewer for this JSONL file with search, level filters, and a timeline of errors.",
  },
  {
    emoji: "🎯",
    prompt:
      "Build an OKR tracker where each team adds objectives and key results and the progress bars roll up to a company view.",
  },
  {
    emoji: "🧑‍🤝‍🧑",
    prompt:
      "Make a meeting cost calculator: pick attendees and duration and see the cost tick up live during the meeting.",
  },
  {
    emoji: "📸",
    prompt:
      "Build a photo contact sheet app: drop in a folder of images, tag favorites, and export the picks as a list.",
  },
  {
    emoji: "💬",
    prompt:
      "Turn this customer feedback CSV into an explorer with sentiment filters, top themes, and searchable quotes.",
  },
  {
    emoji: "🏋️",
    prompt:
      "Create a habit tracker with a streak calendar, weekly goals, and a chart of my best days.",
  },
  {
    emoji: "🧭",
    prompt:
      "Build an interactive decision matrix: add options and weighted criteria and see the ranked result update as I score.",
  },
];

const BOT_USE_CASES: UseCase[] = [
  {
    emoji: "📞",
    prompt:
      "A lead bot that reads new inbound emails, works out the company and what they want, logs it in HubSpot, and pings me on Slack.",
  },
  {
    emoji: "🧑‍💻",
    prompt:
      "A code-review bot that reviews every new pull request in our repo for bugs and security issues and leaves a summary comment.",
  },
  {
    emoji: "🗓️",
    prompt:
      "A chief-of-staff bot that prepares a briefing every morning with my meetings, who I'm meeting, and what we discussed last time.",
  },
  {
    emoji: "💬",
    prompt:
      "A support bot on WhatsApp that answers customer questions from our FAQ document and hands off to me when it isn't sure.",
  },
  {
    emoji: "📈",
    prompt:
      "A research bot that watches three competitor websites and sends a weekly digest of pricing and feature changes.",
  },
  {
    emoji: "🧹",
    prompt:
      "An inbox bot that triages new email every hour, labels newsletters, and flags anything from clients as urgent.",
  },
  {
    emoji: "📚",
    prompt:
      "A study-buddy bot on Telegram that quizzes me on my course notes and tracks what I keep getting wrong.",
  },
  {
    emoji: "🤝",
    prompt:
      "A team of bots: a researcher gathers sources, a writer drafts the blog post, and an editor checks facts before it reaches me.",
  },
  {
    emoji: "🚨",
    prompt:
      "An on-call bot that reads new error alerts, checks recent deploys and logs, and posts a likely cause to the incident channel.",
  },
  {
    emoji: "🧾",
    prompt:
      "A finance bot that collects invoices from email on the 1st of every month and files them into the right Drive folders.",
  },
  {
    emoji: "🎫",
    prompt:
      "A watcher bot that follows my favorite band's account on X and messages me the moment tour dates or presales are announced near me.",
  },
  {
    emoji: "💼",
    prompt:
      "A CRM bot that each morning DMs me the contacts going cold and a one-line reminder of our last conversation.",
  },
  {
    emoji: "🔔",
    prompt:
      "A follow-up bot that, before I log off, lists Slack threads where someone is still waiting on me.",
  },
  {
    emoji: "📣",
    prompt:
      "A pipeline bot that posts a short weekly recap of new, advanced, and closed deals to our sales channel.",
  },
  {
    emoji: "🛡️",
    prompt:
      "A security bot that scans every new pull request for secrets and vulnerable dependencies and blocks merge until I approve.",
  },
  {
    emoji: "💹",
    prompt:
      "A markets bot that screens for stocks matching my criteria every morning and sends a short watchlist to Telegram.",
  },
  {
    emoji: "🍳",
    prompt:
      "A household bot that turns things I text it into Notion tasks with due dates and reminds me the evening before.",
  },
  {
    emoji: "🎧",
    prompt:
      "A focus bot that builds a Spotify queue from my mood and calendar when a deep-work block starts.",
  },
  {
    emoji: "📣",
    prompt:
      "A content bot that drafts a weekly LinkedIn post from what our team shipped and waits for my edits before posting.",
  },
  {
    emoji: "🌐",
    prompt:
      "A translation bot in our Discord that replies to non-English questions in the asker's language and logs them for support.",
  },
];

interface UseCasesGalleryProps {
  open: boolean;
  initialCategory?: UseCaseCategory;
  onClose: () => void;
  /** When provided, clicking a card hands its prompt back (e.g. to fill the composer). */
  onSelect?: (prompt: string, category: UseCaseCategory) => void;
  /** Render inside the nearest positioned ancestor (e.g. the main content pane) instead of the window. */
  contained?: boolean;
}

export function UseCasesGallery({
  open,
  initialCategory = "cowork",
  onClose,
  onSelect,
  contained = false,
}: UseCasesGalleryProps) {
  const [category, setCategory] = useState<UseCaseCategory>(initialCategory);

  useEffect(() => {
    if (open) setCategory(initialCategory);
  }, [open, initialCategory]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const items =
    category === "cowork"
      ? COWORK_USE_CASES
      : category === "build"
        ? BUILD_USE_CASES
        : BOT_USE_CASES;

  const gallery = (
    <div
      className={`use-cases-overlay${contained ? " use-cases-overlay-contained" : ""}`}
      onMouseDown={onClose}
    >
      <div
        className="use-cases-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="use-cases-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="use-cases-header">
          <h2 id="use-cases-title">See how people use CoWork OS</h2>
          <button type="button" className="use-cases-close" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </div>
        <div className="use-cases-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={category === "cowork"}
            className={category === "cowork" ? "active" : ""}
            onClick={() => setCategory("cowork")}
          >
            Tasks
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={category === "build"}
            className={category === "build" ? "active" : ""}
            onClick={() => setCategory("build")}
          >
            Build
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={category === "bots"}
            className={category === "bots" ? "active" : ""}
            onClick={() => setCategory("bots")}
          >
            Bots
          </button>
        </div>
        <div className="use-cases-grid">
          {items.map((item) => (
            <button
              key={item.prompt}
              type="button"
              className="use-cases-card"
              disabled={!onSelect}
              onClick={() => {
                onSelect?.(item.run ?? item.prompt, category);
                onClose();
              }}
            >
              <span className="use-cases-emoji" aria-hidden="true">
                {item.emoji}
              </span>
              <span className="use-cases-prompt">{item.prompt}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  return contained ? gallery : createPortal(gallery, document.body);
}
