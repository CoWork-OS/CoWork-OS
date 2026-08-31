/**
 * Placeholder Engine
 *
 * Produces a ranked list of input-box placeholders tailored to the current
 * user.  The system works in three progressive tiers:
 *
 *  1. **Cold start** – no user data yet → only "universal" prompts that make
 *     sense for every persona.
 *  2. **Persona-detected** – we matched the user to one or more personas via
 *     profile facts, task history, and skill usage → mix universal + persona-
 *     specific prompts, weighted toward the detected personas.
 *  3. **Fully personalized** – we also inject dynamic prompts synthesised from
 *     the user's own goals, commitments, and recent tasks.
 *
 * The engine is pure data + functions – no React, no side-effects.
 */

// ─── Persona taxonomy ────────────────────────────────────────────────────────

export type Persona =
  | "universal"
  | "engineering"
  | "trading"
  | "education"
  | "marketing"
  | "design"
  | "product"
  | "founder"
  | "sales"
  | "hr"
  | "legal"
  | "data"
  | "research"
  | "operations"
  | "support"
  | "personal"
  | "healthcare"
  | "realestate"
  | "creative"
  | "writing";

// ─── Tagged placeholder pool ────────────────────────────────────────────────

interface TaggedPlaceholder {
  text: string;
  personas: Persona[];
}

const POOL: TaggedPlaceholder[] = [
  // ── Universal (shown to everyone, especially cold-start) ──────────────
  {
    text: "Summarize this PDF, extract action items, and draft the follow-up",
    personas: ["universal"],
  },
  {
    text: "Turn these bullet points into a slide deck with a clear story",
    personas: ["universal"],
  },
  { text: "Compare these two approaches and recommend one", personas: ["universal"] },
  { text: "Translate this document and preserve the formatting", personas: ["universal"] },
  { text: "Review tomorrow's calendar and tell me what needs prep", personas: ["universal"] },
  { text: "Research the latest on this topic and cite the best sources", personas: ["universal"] },
  { text: "Organize this folder and rename files consistently", personas: ["universal"] },
  {
    text: "Generate my daily briefing from inbox, calendar, and commitments",
    personas: ["universal"],
  },
  {
    text: "Review my goals for this quarter and suggest the next best step",
    personas: ["universal"],
  },
  { text: "Show my open commitments and flag anything at risk this week", personas: ["universal"] },
  {
    text: "Dispatch agents to research this and synthesize one recommendation",
    personas: ["universal"],
  },
  { text: "Run this task autonomously and report back with outcomes", personas: ["universal"] },
  { text: "Tell me what I finished this week and what is still blocked", personas: ["universal"] },
  {
    text: "Build a spreadsheet from this data and surface the main trends",
    personas: ["universal"],
  },
  { text: "Proofread this and tighten the writing", personas: ["universal"] },
  { text: "Convert this report into an exec-ready one-pager", personas: ["universal"] },
  {
    text: "Summarize this thread, extract decisions, and list next steps",
    personas: ["universal"],
  },
  { text: "Review my inbox, highlight urgent threads, and draft replies", personas: ["universal"] },
  { text: "Turn this into a recurring automation or reminder", personas: ["universal"] },
  {
    text: "Turn this conversation into a Mission Control issue and suggest an owner",
    personas: ["universal"],
  },
  { text: "Plan my week around deadlines, meetings, and follow-ups", personas: ["universal"] },

  // ── Engineering ───────────────────────────────────────────────────────
  { text: "Read the dev logs, explain the failure, and suggest a fix", personas: ["engineering"] },
  { text: "Compare these two implementations and recommend one", personas: ["engineering"] },
  { text: "Refactor this function without changing behavior", personas: ["engineering"] },
  { text: "Audit this codebase for security and reliability risks", personas: ["engineering"] },
  {
    text: "Design the API contract and sample payloads for this feature",
    personas: ["engineering"],
  },
  { text: "Find recent code changes that still lack test coverage", personas: ["engineering"] },
  {
    text: "Generate the migration and rollout plan for this schema change",
    personas: ["engineering"],
  },
  {
    text: "Run the test suite, group the failures, and identify the root cause",
    personas: ["engineering"],
  },
  {
    text: "Summarize the last week of git activity and notable changes",
    personas: ["engineering"],
  },
  { text: "Open a GitHub issue with repro steps and impacted files", personas: ["engineering"] },
  { text: "Review this PR for bugs, regressions, and missing tests", personas: ["engineering"] },
  { text: "Set up CI checks for build, test, and lint", personas: ["engineering"] },
  { text: "Find TODOs, FIXMEs, and dead code worth cleaning up", personas: ["engineering"] },
  { text: "Write the Dockerfile and call out runtime assumptions", personas: ["engineering"] },
  { text: "Run a browser QA pass on this flow and capture failures", personas: ["engineering"] },

  // ── Trading & finance ─────────────────────────────────────────────────
  { text: "Analyze the latest AAPL earnings and flag the key takeaways", personas: ["trading"] },
  { text: "Compare my portfolio allocation against the S&P 500", personas: ["trading"] },
  { text: "Summarize the latest Fed signals and likely market impact", personas: ["trading"] },
  {
    text: "Backtest this moving-average crossover strategy and show the tradeoffs",
    personas: ["trading"],
  },
  { text: "Pull the latest 10-K and highlight the major risk factors", personas: ["trading"] },
  { text: "Review TSLA options flow this week and flag unusual activity", personas: ["trading"] },
  {
    text: "Build a DCF model from these financials and stress-test the assumptions",
    personas: ["trading"],
  },
  {
    text: "Track my open positions and flag stop-loss or take-profit triggers",
    personas: ["trading"],
  },
  { text: "Summarize the macro outlook for emerging markets this week", personas: ["trading"] },
  { text: "Calculate Sharpe, drawdown, and volatility for this portfolio", personas: ["trading"] },
  { text: "Screen for stocks with low P/E and accelerating revenue", personas: ["trading"] },
  { text: "List the upcoming ex-dividend dates for my watchlist", personas: ["trading"] },

  // ── Education ─────────────────────────────────────────────────────────
  { text: "Create a lesson plan for intro to probability", personas: ["education"] },
  {
    text: "Generate 20 practice problems on quadratic equations with solutions",
    personas: ["education"],
  },
  { text: "Explain quantum entanglement like I'm 15", personas: ["education"] },
  { text: "Turn these lecture notes into a study guide", personas: ["education"] },
  { text: "Create a grading rubric for this essay assignment", personas: ["education"] },
  { text: "Quiz me on Spanish vocabulary from chapter 5", personas: ["education"] },
  { text: "Summarize this research paper in plain language", personas: ["education", "research"] },
  { text: "Design a 6-week Python curriculum with weekly milestones", personas: ["education"] },
  { text: "Create flashcards from this textbook chapter", personas: ["education"] },
  { text: "Suggest differentiated activities for mixed-level learners", personas: ["education"] },
  { text: "Draft a parent newsletter about this month's progress", personas: ["education"] },
  { text: "Build an assessment aligned to these learning objectives", personas: ["education"] },

  // ── Marketing & growth ────────────────────────────────────────────────
  { text: "Draft five ad variations and pick the strongest angle", personas: ["marketing"] },
  { text: "Audit this landing page for conversion issues and quick wins", personas: ["marketing"] },
  { text: "Create a four-week content calendar with themes and owners", personas: ["marketing"] },
  {
    text: "Analyze our email performance and suggest the next experiments",
    personas: ["marketing"],
  },
  { text: "Write launch posts for LinkedIn, X, and email", personas: ["marketing"] },
  { text: "Compare our SEO position against these competitors", personas: ["marketing"] },
  { text: "Build a customer persona from this survey data", personas: ["marketing", "data"] },
  { text: "Generate A/B test ideas for the checkout flow", personas: ["marketing", "product"] },
  { text: "Draft a press release for this launch", personas: ["marketing"] },
  {
    text: "Map the customer journey from signup to first value",
    personas: ["marketing", "product"],
  },
  { text: "Suggest influencer outreach targets for this niche", personas: ["marketing"] },

  // ── Design & UX ───────────────────────────────────────────────────────
  { text: "Review this flow for usability and accessibility issues", personas: ["design"] },
  { text: "Write a design spec for the new onboarding flow", personas: ["design", "product"] },
  { text: "Create a component inventory from this design file", personas: ["design"] },
  { text: "Suggest a color system for this fintech dashboard", personas: ["design"] },
  { text: "Audit this page for WCAG 2.1 AA issues", personas: ["design"] },
  { text: "Draft empty-state microcopy that helps users act", personas: ["design", "writing"] },
  { text: "Create a spacing and type scale for the design system", personas: ["design"] },
  { text: "Write alt text for every image on this page", personas: ["design"] },

  // ── Product management ────────────────────────────────────────────────
  { text: "Write a PRD for this feature and define the open questions", personas: ["product"] },
  { text: "Prioritize this backlog using RICE and explain the tradeoffs", personas: ["product"] },
  {
    text: "Draft user stories and acceptance criteria for the checkout redesign",
    personas: ["product"],
  },
  { text: "Build a competitive feature matrix for this market", personas: ["product", "founder"] },
  {
    text: "Create a go-to-market checklist for the beta launch",
    personas: ["product", "marketing"],
  },
  { text: "Summarize last week's user feedback into clear themes", personas: ["product"] },
  { text: "Define success metrics, guardrails, and launch criteria", personas: ["product"] },
  {
    text: "Write release notes and a rollout summary for this version",
    personas: ["product", "engineering"],
  },

  // ── Founders & startups ───────────────────────────────────────────────
  { text: "Draft this month's investor update with key metrics and asks", personas: ["founder"] },
  { text: "Estimate TAM/SAM/SOM for this market opportunity", personas: ["founder"] },
  { text: "Write the executive summary for our pitch deck", personas: ["founder"] },
  {
    text: "Build a three-year financial model with best and worst cases",
    personas: ["founder", "trading"],
  },
  { text: "Analyze this term sheet and flag unusual clauses", personas: ["founder", "legal"] },
  { text: "Create a competitive landscape map for our space", personas: ["founder"] },
  { text: "Draft a board meeting agenda and talking points", personas: ["founder"] },
  { text: "Calculate our runway at the current burn rate", personas: ["founder", "trading"] },

  // ── Sales ─────────────────────────────────────────────────────────────
  { text: "Research this prospect and draft personalized outreach", personas: ["sales"] },
  { text: "Build a battle card against our top competitor", personas: ["sales"] },
  { text: "Write a follow-up email after today's demo", personas: ["sales"] },
  { text: "Summarize this RFP and highlight our win themes", personas: ["sales"] },
  { text: "Turn this customer story into a case study outline", personas: ["sales", "marketing"] },
  { text: "Prepare a pricing comparison for the proposal", personas: ["sales"] },
  { text: "Script responses to budget and timing objections", personas: ["sales"] },

  // ── HR & people ops ───────────────────────────────────────────────────
  { text: "Write a job description for a senior data engineer", personas: ["hr"] },
  { text: "Create interview questions and a scorecard for this PM role", personas: ["hr"] },
  { text: "Draft a performance review template with clear criteria", personas: ["hr"] },
  { text: "Build an onboarding checklist for new hires", personas: ["hr"] },
  {
    text: "Summarize this employee engagement survey and highlight risks",
    personas: ["hr", "data"],
  },
  { text: "Draft a company-wide announcement about the new policy", personas: ["hr"] },

  // ── Legal & compliance ────────────────────────────────────────────────
  { text: "Review this contract and flag non-standard clauses", personas: ["legal"] },
  { text: "Summarize this privacy policy in plain English", personas: ["legal"] },
  { text: "Draft a data processing agreement template", personas: ["legal"] },
  { text: "Check this copy for regulatory or compliance issues", personas: ["legal"] },
  {
    text: "Compare these two license options for our use case",
    personas: ["legal", "engineering"],
  },

  // ── Data & analytics ──────────────────────────────────────────────────
  { text: "Analyze this CSV and surface the key insights", personas: ["data"] },
  { text: "Design a dashboard layout for these KPIs", personas: ["data"] },
  { text: "Write SQL to answer these business questions", personas: ["data"] },
  { text: "Find anomalies in this time-series dataset", personas: ["data"] },
  { text: "Create a data dictionary for this schema", personas: ["data", "engineering"] },
  {
    text: "Visualize the funnel drop-off and explain the likely causes",
    personas: ["data", "marketing"],
  },
  { text: "Clean and normalize this spreadsheet", personas: ["data"] },
  { text: "Recommend the right chart for this dataset", personas: ["data"] },

  // ── Research & academia ───────────────────────────────────────────────
  { text: "Summarize the latest papers on transformer architectures", personas: ["research"] },
  { text: "Write a literature review on climate adaptation", personas: ["research"] },
  { text: "Design an experiment to test this hypothesis", personas: ["research"] },
  { text: "Create an annotated bibliography from these sources", personas: ["research"] },
  { text: "Compare the methodologies across these studies", personas: ["research"] },
  { text: "Draft an abstract for this conference submission", personas: ["research"] },
  { text: "Extract key findings from these papers into a table", personas: ["research"] },

  // ── Operations & logistics ────────────────────────────────────────────
  {
    text: "Draft an SOP for incident response",
    personas: ["operations", "engineering"],
  },
  { text: "Map out the supply chain for this product", personas: ["operations"] },
  { text: "Create a vendor evaluation scorecard", personas: ["operations"] },
  { text: "Build a Q2 capacity planning sheet", personas: ["operations"] },
  {
    text: "Turn this operational issue into an escalation plan with owners",
    personas: ["operations"],
  },
  { text: "Create a risk register for this project", personas: ["operations", "product"] },

  // ── Customer support ──────────────────────────────────────────────────
  { text: "Draft a knowledge base article for this common issue", personas: ["support"] },
  { text: "Create response templates for our top ticket types", personas: ["support"] },
  { text: "Analyze support trends from the last 30 days", personas: ["support", "data"] },
  { text: "Write an escalation playbook for critical issues", personas: ["support", "operations"] },
  { text: "Triage these tickets by urgency, topic, and next action", personas: ["support"] },

  // ── Personal productivity ─────────────────────────────────────────────
  { text: "Plan a seven-day Tokyo itinerary with travel times and budget", personas: ["personal"] },
  { text: "Create a weekly meal plan with a grocery list", personas: ["personal"] },
  { text: "Build a monthly budget tracker from my expenses", personas: ["personal"] },
  {
    text: "Help me learn Rust in 30 days with a weekly plan",
    personas: ["personal", "engineering"],
  },
  { text: "Organize my reading list by priority and topic", personas: ["personal"] },
  { text: "Make a pros-and-cons decision memo from these notes", personas: ["personal"] },

  // ── Healthcare ────────────────────────────────────────────────────────
  { text: "Summarize this clinical study in plain language", personas: ["healthcare", "research"] },
  { text: "Create a patient education handout for diabetes", personas: ["healthcare"] },
  { text: "Compare treatment options from these guidelines", personas: ["healthcare"] },
  { text: "Draft a care plan summary for the weekly review", personas: ["healthcare"] },

  // ── Real estate ───────────────────────────────────────────────────────
  { text: "Analyze comparable sales for this property", personas: ["realestate"] },
  {
    text: "Write a listing description for this home",
    personas: ["realestate", "writing"],
  },
  { text: "Build a rent-vs-buy calculator with my numbers", personas: ["realestate", "trading"] },
  {
    text: "Draft a market update newsletter for my clients",
    personas: ["realestate", "marketing"],
  },

  // ── Creative & media ──────────────────────────────────────────────────
  {
    text: "Write a two-minute product explainer script",
    personas: ["creative", "marketing"],
  },
  { text: "Create a podcast episode outline on remote work", personas: ["creative"] },
  {
    text: "Draft a storyboard and shot list for this ad concept",
    personas: ["creative", "marketing"],
  },
  { text: "Generate tagline options for the rebrand", personas: ["creative", "marketing"] },
  { text: "Give me three short story prompts to get started", personas: ["creative"] },
  { text: "Create a mood board brief from these references", personas: ["creative", "design"] },

  // ── Writing & content ─────────────────────────────────────────────────
  { text: "Draft a newsletter from this week's updates", personas: ["writing"] },
  { text: "Write a talk outline on AI in healthcare", personas: ["writing", "healthcare"] },
  { text: "Turn this transcript into a polished article", personas: ["writing"] },
  { text: "Create a brand voice guide from these examples", personas: ["writing", "marketing"] },
  { text: "Rewrite this paragraph for a non-technical audience", personas: ["writing"] },
  { text: "Generate ten blog post titles for this topic", personas: ["writing", "marketing"] },
];

// ─── Persona detection ──────────────────────────────────────────────────────

/** Keyword → persona mapping used for signal detection */
const SIGNAL_KEYWORDS: Record<Persona, string[]> = {
  universal: [],
  engineering: [
    "code",
    "bug",
    "deploy",
    "api",
    "test",
    "ci",
    "cd",
    "git",
    "docker",
    "kubernetes",
    "backend",
    "frontend",
    "database",
    "schema",
    "migration",
    "refactor",
    "debug",
    "lint",
    "build",
    "compile",
    "repo",
    "pull request",
    "merge",
    "branch",
    "typescript",
    "python",
    "rust",
    "java",
    "devops",
    "infrastructure",
    "server",
    "endpoint",
    "sdk",
    "cli",
    "webpack",
    "npm",
  ],
  trading: [
    "stock",
    "trade",
    "portfolio",
    "market",
    "earnings",
    "dividend",
    "option",
    "equity",
    "bond",
    "etf",
    "crypto",
    "bitcoin",
    "forex",
    "hedge",
    "short",
    "long",
    "bull",
    "bear",
    "dcf",
    "valuation",
    "p/e",
    "revenue",
    "sec",
    "10-k",
    "10-q",
    "filing",
    "ticker",
    "sharpe",
    "alpha",
    "beta",
    "backtest",
    "ipo",
    "yield",
    "fed",
    "interest rate",
    "balance sheet",
  ],
  education: [
    "lesson",
    "student",
    "teach",
    "curriculum",
    "syllabus",
    "grade",
    "rubric",
    "assignment",
    "quiz",
    "exam",
    "lecture",
    "course",
    "class",
    "tutor",
    "learn",
    "homework",
    "flashcard",
    "study",
    "school",
    "university",
    "professor",
    "pedagogy",
    "lms",
    "canvas",
    "moodle",
  ],
  marketing: [
    "campaign",
    "seo",
    "sem",
    "ctr",
    "conversion",
    "funnel",
    "lead",
    "content",
    "brand",
    "social media",
    "ad copy",
    "email marketing",
    "newsletter",
    "audience",
    "engagement",
    "influencer",
    "analytics",
    "impression",
    "reach",
    "cpc",
    "roas",
    "retention",
    "churn",
    "landing page",
    "a/b test",
    "copy",
    "growth",
    "acquisition",
  ],
  design: [
    "figma",
    "sketch",
    "wireframe",
    "mockup",
    "prototype",
    "ui",
    "ux",
    "typography",
    "color palette",
    "spacing",
    "component",
    "design system",
    "accessibility",
    "wcag",
    "responsive",
    "layout",
    "icon",
    "illustration",
    "animation",
    "interaction",
    "user flow",
    "persona",
  ],
  product: [
    "prd",
    "roadmap",
    "backlog",
    "sprint",
    "user story",
    "feature",
    "prioritize",
    "okr",
    "kpi",
    "metric",
    "launch",
    "release",
    "beta",
    "mvp",
    "product-market fit",
    "user research",
    "feedback",
    "nps",
    "onboarding",
    "adoption",
    "retention",
    "activation",
  ],
  founder: [
    "startup",
    "investor",
    "pitch",
    "fundraise",
    "seed",
    "series a",
    "venture",
    "cap table",
    "term sheet",
    "burn rate",
    "runway",
    "board",
    "co-founder",
    "pivot",
    "tam",
    "sam",
    "som",
    "incorporation",
    "equity",
    "dilution",
    "valuation",
    "accelerator",
    "yc",
  ],
  sales: [
    "prospect",
    "pipeline",
    "deal",
    "close",
    "quota",
    "crm",
    "salesforce",
    "hubspot",
    "demo",
    "proposal",
    "rfp",
    "objection",
    "negotiation",
    "account",
    "territory",
    "commission",
    "outreach",
    "cold email",
    "discovery call",
    "champion",
    "decision maker",
  ],
  hr: [
    "hire",
    "recruit",
    "candidate",
    "interview",
    "offer",
    "onboarding",
    "performance review",
    "compensation",
    "benefits",
    "culture",
    "policy",
    "employee",
    "headcount",
    "attrition",
    "engagement survey",
    "dei",
    "job description",
    "pto",
    "payroll",
  ],
  legal: [
    "contract",
    "clause",
    "liability",
    "compliance",
    "gdpr",
    "hipaa",
    "terms of service",
    "privacy policy",
    "nda",
    "ip",
    "patent",
    "trademark",
    "copyright",
    "regulation",
    "dispute",
    "litigation",
    "amendment",
    "indemnity",
    "license",
    "agreement",
  ],
  data: [
    "sql",
    "query",
    "dashboard",
    "etl",
    "pipeline",
    "warehouse",
    "visualization",
    "tableau",
    "power bi",
    "looker",
    "dbt",
    "bigquery",
    "snowflake",
    "redshift",
    "pandas",
    "jupyter",
    "notebook",
    "csv",
    "metric",
    "kpi",
    "anomaly",
    "regression",
    "forecast",
  ],
  research: [
    "paper",
    "study",
    "hypothesis",
    "experiment",
    "methodology",
    "peer review",
    "citation",
    "abstract",
    "journal",
    "conference",
    "literature review",
    "bibliography",
    "thesis",
    "dissertation",
    "grant",
    "arxiv",
    "pubmed",
    "meta-analysis",
    "sample size",
    "control group",
  ],
  operations: [
    "sop",
    "process",
    "supply chain",
    "logistics",
    "vendor",
    "procurement",
    "inventory",
    "warehouse",
    "fulfillment",
    "capacity",
    "incident",
    "runbook",
    "escalation",
    "sla",
    "downtime",
    "postmortem",
    "risk register",
    "continuity",
  ],
  support: [
    "ticket",
    "support",
    "helpdesk",
    "knowledge base",
    "faq",
    "escalation",
    "sla",
    "csat",
    "nps",
    "response time",
    "resolution",
    "zendesk",
    "intercom",
    "freshdesk",
    "triage",
    "queue",
    "macro",
  ],
  personal: [
    "travel",
    "trip",
    "itinerary",
    "recipe",
    "meal plan",
    "budget",
    "fitness",
    "habit",
    "journal",
    "goal",
    "hobby",
    "reading list",
    "move",
    "apartment",
    "wedding",
    "vacation",
    "grocery",
  ],
  healthcare: [
    "patient",
    "clinical",
    "diagnosis",
    "treatment",
    "care plan",
    "medical",
    "health",
    "ehr",
    "fhir",
    "hipaa",
    "pharmacy",
    "prescription",
    "symptom",
    "lab result",
    "vitals",
    "icd",
    "procedure",
    "triage",
    "referral",
  ],
  realestate: [
    "property",
    "listing",
    "mortgage",
    "appraisal",
    "closing",
    "inspection",
    "mls",
    "comps",
    "zoning",
    "escrow",
    "hoa",
    "rental",
    "lease",
    "tenant",
    "landlord",
    "cap rate",
  ],
  creative: [
    "video",
    "podcast",
    "script",
    "storyboard",
    "animation",
    "film",
    "edit",
    "shoot",
    "production",
    "post-production",
    "music",
    "audio",
    "voiceover",
    "thumbnail",
    "youtube",
    "tiktok",
    "instagram",
    "reel",
  ],
  writing: [
    "blog",
    "article",
    "essay",
    "draft",
    "copy",
    "edit",
    "proofread",
    "tone",
    "voice",
    "headline",
    "outline",
    "chapter",
    "manuscript",
    "publish",
    "medium",
    "substack",
    "ghostwrite",
  ],
};

/** Signals we extract from user data to detect personas */
export interface UserSignals {
  /** User-profile facts (all categories) */
  profileFacts: Array<{ category: string; value: string }>;
  /** Titles of recently completed tasks */
  recentTaskTitles: string[];
  /** Names of most-used skills */
  topSkills: string[];
  /** Prompts from enabled plugin packs */
  pluginPrompts: string[];
  /** User's open commitments */
  openCommitments: string[];
}

export interface PersonaScores {
  scores: Record<Persona, number>;
  /** true when we have enough signal to be confident */
  hasSignal: boolean;
}

/**
 * Score each persona based on keyword matches across all user signals.
 * Returns a map of persona → score (0+), and a flag indicating whether
 * we have enough signal to personalise.
 */
export function detectPersonas(signals: UserSignals): PersonaScores {
  const scores: Record<Persona, number> = {} as Record<Persona, number>;
  const allPersonas = Object.keys(SIGNAL_KEYWORDS) as Persona[];
  for (const p of allPersonas) scores[p] = 0;

  // Build one big bag of words from all signal sources
  const corpus = [
    ...signals.profileFacts.map((f) => f.value),
    ...signals.recentTaskTitles,
    ...signals.topSkills,
    ...signals.pluginPrompts,
    ...signals.openCommitments,
  ]
    .join(" ")
    .toLowerCase();

  if (!corpus.trim()) {
    return { scores, hasSignal: false };
  }

  for (const persona of allPersonas) {
    if (persona === "universal") continue;
    const keywords = SIGNAL_KEYWORDS[persona];
    for (const kw of keywords) {
      if (corpus.includes(kw)) {
        scores[persona] += 1;
      }
    }
  }

  // Weight profile goal/work facts more heavily (user stated these explicitly)
  for (const fact of signals.profileFacts) {
    if (fact.category === "goal" || fact.category === "work") {
      const val = fact.value.toLowerCase();
      for (const persona of allPersonas) {
        if (persona === "universal") continue;
        for (const kw of SIGNAL_KEYWORDS[persona]) {
          if (val.includes(kw)) scores[persona] += 2; // extra weight
        }
      }
    }
  }

  const totalSignal = Object.values(scores).reduce((a, b) => a + b, 0);
  return { scores, hasSignal: totalSignal >= 3 };
}

// ─── Placeholder selection ──────────────────────────────────────────────────

/**
 * Build the final ordered list of placeholders.
 *
 * Strategy:
 *  - **Cold start** (`!hasSignal`): return only universal placeholders,
 *    shuffled randomly.
 *  - **Warm** (`hasSignal`): collect universal + all matched-persona
 *    placeholders, with matched ones repeated proportionally to their
 *    persona score so they appear more often.  Then add dynamic prompts
 *    at the front.
 */
export function buildPlaceholders(
  personaResult: PersonaScores,
  dynamicPrompts: string[],
  pluginPrompts: string[],
): string[] {
  const { scores, hasSignal } = personaResult;

  // ── Cold start: universal only ──
  if (!hasSignal) {
    const universal = POOL.filter((p) => p.personas.includes("universal")).map((p) => p.text);
    // Add plugin prompts
    const combined = [...universal, ...pluginPrompts];
    return shuffle(combined);
  }

  // ── Warm: weighted selection ──
  // Find the top personas (score > 0), sorted descending
  const ranked = (Object.entries(scores) as [Persona, number][])
    .filter(([p, s]) => p !== "universal" && s > 0)
    .sort((a, b) => b[1] - a[1]);

  const topPersonas = new Set(ranked.slice(0, 5).map(([p]) => p));

  // Always include universal
  const result: string[] = [];
  const seen = new Set<string>();

  const add = (text: string) => {
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(text);
  };

  // 1. Dynamic (personalised) prompts first
  for (const d of dynamicPrompts) add(d);

  // 2. Collect persona-matched placeholders
  const matched: string[] = [];
  const universal: string[] = [];

  for (const entry of POOL) {
    const isUniversal = entry.personas.includes("universal");
    const isMatched = entry.personas.some((p) => topPersonas.has(p));

    if (isMatched) matched.push(entry.text);
    else if (isUniversal) universal.push(entry.text);
    // Non-matched persona-specific entries are excluded
  }

  // Shuffle both buckets
  shuffle(matched);
  shuffle(universal);

  // Interleave: ~3 matched for every 1 universal
  let mi = 0;
  let ui = 0;
  while (mi < matched.length || ui < universal.length) {
    // Add up to 3 matched
    for (let k = 0; k < 3 && mi < matched.length; k++, mi++) {
      add(matched[mi]);
    }
    // Add 1 universal
    if (ui < universal.length) {
      add(universal[ui]);
      ui++;
    }
  }

  // 3. Plugin prompts at the end
  for (const p of pluginPrompts) add(p);

  return result;
}

// ─── Dynamic prompt generators ──────────────────────────────────────────────

/**
 * Build personalised prompts from the user's own data:
 * goals, commitments, and recent tasks.
 */
export function buildDynamicPrompts(signals: UserSignals): string[] {
  const prompts: string[] = [];

  // Goals → actionable prompts
  const goals = signals.profileFacts.filter((f) => f.category === "goal");
  for (const g of goals.slice(0, 3)) {
    prompts.push(`Help me make progress on: ${g.value}`);
  }

  // Work context → awareness prompts
  const work = signals.profileFacts.filter((f) => f.category === "work");
  for (const w of work.slice(0, 2)) {
    prompts.push(`Anything new I should know about ${w.value}?`);
  }

  // Open commitments → remind
  for (const c of signals.openCommitments.slice(0, 3)) {
    prompts.push(`Follow up on: ${c}`);
  }

  // Recent tasks → continue
  for (const t of signals.recentTaskTitles.slice(0, 3)) {
    prompts.push(`Continue from: ${t}`);
  }

  return prompts;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
