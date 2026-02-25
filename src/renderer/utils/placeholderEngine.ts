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
  { text: "Summarize this PDF and extract the action items", personas: ["universal"] },
  { text: "Create a slide deck from these bullet points", personas: ["universal"] },
  { text: "Compare these two approaches and recommend one", personas: ["universal"] },
  { text: "Translate this document to Spanish", personas: ["universal"] },
  { text: "What's on my calendar for tomorrow?", personas: ["universal"] },
  { text: "Search the web for the latest on this topic", personas: ["universal"] },
  { text: "Organize this folder by date and file type", personas: ["universal"] },
  { text: "Generate my daily briefing", personas: ["universal"] },
  { text: "What goals have I set for this quarter?", personas: ["universal"] },
  { text: "Show me my open commitments", personas: ["universal"] },
  { text: "Run this task autonomously and report back", personas: ["universal"] },
  { text: "How many tasks did I complete this week?", personas: ["universal"] },
  { text: "Build a spreadsheet from this data", personas: ["universal"] },
  { text: "Proofread and tighten this text", personas: ["universal"] },
  { text: "Convert this report into an exec-friendly one-pager", personas: ["universal"] },
  { text: "Summarize this long thread into key points", personas: ["universal"] },
  { text: "Draft a follow-up email about today's meeting", personas: ["universal"] },
  { text: "Check my unread Slack messages and summarize", personas: ["universal"] },
  { text: "Create a checklist for this project", personas: ["universal"] },
  { text: "Help me plan my week", personas: ["universal"] },

  // ── Engineering ───────────────────────────────────────────────────────
  { text: "Write unit tests for the auth module", personas: ["engineering"] },
  { text: "Explain this error trace and suggest a fix", personas: ["engineering"] },
  { text: "Refactor this function for readability", personas: ["engineering"] },
  { text: "Audit this codebase for security vulnerabilities", personas: ["engineering"] },
  { text: "Design an API schema for the new feature", personas: ["engineering"] },
  { text: "Which files changed this week with no test coverage?", personas: ["engineering"] },
  { text: "Generate a migration script for the new schema", personas: ["engineering"] },
  { text: "Run the test suite and tell me what's failing", personas: ["engineering"] },
  { text: "Show me the git log for the last week", personas: ["engineering"] },
  { text: "Create a GitHub issue for this bug with repro steps", personas: ["engineering"] },
  { text: "Review this PR and summarize the changes", personas: ["engineering"] },
  { text: "Set up a CI pipeline for this repo", personas: ["engineering"] },
  { text: "Find all TODO comments in the codebase", personas: ["engineering"] },
  { text: "Write a Dockerfile for this project", personas: ["engineering"] },
  { text: "Profile this function and suggest optimizations", personas: ["engineering"] },

  // ── Trading & finance ─────────────────────────────────────────────────
  { text: "Analyze AAPL's earnings report and flag key takeaways", personas: ["trading"] },
  { text: "Compare my portfolio allocation vs the S&P 500", personas: ["trading"] },
  { text: "Summarize today's Fed meeting minutes", personas: ["trading"] },
  { text: "Backtest this moving-average crossover strategy", personas: ["trading"] },
  { text: "Pull the latest 10-K and highlight risk factors", personas: ["trading"] },
  { text: "What's the options flow on TSLA this week?", personas: ["trading"] },
  { text: "Build a DCF model from these financials", personas: ["trading"] },
  { text: "Track my open positions and flag stop-loss triggers", personas: ["trading"] },
  { text: "Summarize the macro outlook for emerging markets", personas: ["trading"] },
  { text: "Calculate the Sharpe ratio for this portfolio", personas: ["trading"] },
  { text: "Screen for stocks with P/E under 15 and growing revenue", personas: ["trading"] },
  { text: "What are the upcoming ex-dividend dates in my watchlist?", personas: ["trading"] },

  // ── Education ─────────────────────────────────────────────────────────
  { text: "Create a lesson plan for intro to probability", personas: ["education"] },
  { text: "Generate 20 practice problems on quadratic equations", personas: ["education"] },
  { text: "Explain quantum entanglement like I'm 15", personas: ["education"] },
  { text: "Build a study guide from these lecture notes", personas: ["education"] },
  { text: "Create a grading rubric for this essay assignment", personas: ["education"] },
  { text: "Quiz me on Spanish vocabulary from chapter 5", personas: ["education"] },
  { text: "Summarize this research paper in plain language", personas: ["education", "research"] },
  { text: "Design a curriculum for a 6-week Python course", personas: ["education"] },
  { text: "Create flashcards from this textbook chapter", personas: ["education"] },
  { text: "Suggest differentiated activities for mixed-level learners", personas: ["education"] },
  { text: "Write a parent newsletter about this month's progress", personas: ["education"] },
  { text: "Build an assessment aligned to these learning objectives", personas: ["education"] },

  // ── Marketing & growth ────────────────────────────────────────────────
  { text: "Draft 5 ad copy variations for this product launch", personas: ["marketing"] },
  { text: "Audit our landing page for conversion best practices", personas: ["marketing"] },
  { text: "Create a content calendar for the next 4 weeks", personas: ["marketing"] },
  { text: "Analyze our email open rates and suggest improvements", personas: ["marketing"] },
  { text: "Write social media posts for this announcement", personas: ["marketing"] },
  { text: "Compare our SEO rankings against these competitors", personas: ["marketing"] },
  { text: "Build a customer persona from this survey data", personas: ["marketing", "data"] },
  { text: "Generate A/B test ideas for the checkout flow", personas: ["marketing", "product"] },
  { text: "Write a press release draft for the new feature", personas: ["marketing"] },
  {
    text: "Map the customer journey from signup to first value",
    personas: ["marketing", "product"],
  },
  { text: "Suggest influencer outreach targets for this niche", personas: ["marketing"] },

  // ── Design & UX ───────────────────────────────────────────────────────
  { text: "Review this wireframe for accessibility issues", personas: ["design"] },
  { text: "Write a design spec for the new onboarding flow", personas: ["design", "product"] },
  { text: "Create a component inventory from this design file", personas: ["design"] },
  { text: "Suggest color palettes for a fintech dashboard", personas: ["design"] },
  { text: "Audit this page for WCAG 2.1 AA compliance", personas: ["design"] },
  { text: "Draft microcopy for the empty states in the app", personas: ["design", "writing"] },
  { text: "Create a spacing and typography scale for the design system", personas: ["design"] },
  { text: "Write alt text for all images on this page", personas: ["design"] },

  // ── Product management ────────────────────────────────────────────────
  { text: "Write a PRD for the notification system", personas: ["product"] },
  { text: "Prioritize this feature backlog using RICE scoring", personas: ["product"] },
  { text: "Draft user stories for the checkout redesign", personas: ["product"] },
  { text: "Build a competitive feature matrix", personas: ["product", "founder"] },
  {
    text: "Create a go-to-market checklist for the beta launch",
    personas: ["product", "marketing"],
  },
  { text: "Summarize last week's user feedback into themes", personas: ["product"] },
  { text: "Define success metrics for this feature launch", personas: ["product"] },
  { text: "Write release notes for v2.4", personas: ["product", "engineering"] },

  // ── Founders & startups ───────────────────────────────────────────────
  { text: "Draft a one-page investor update for this month", personas: ["founder"] },
  { text: "Estimate TAM/SAM/SOM for this market opportunity", personas: ["founder"] },
  { text: "Write the executive summary for our pitch deck", personas: ["founder"] },
  { text: "Build a financial model with 3-year projections", personas: ["founder", "trading"] },
  { text: "Analyze this term sheet and flag unusual clauses", personas: ["founder", "legal"] },
  { text: "Create a competitive landscape map for our space", personas: ["founder"] },
  { text: "Draft a board meeting agenda and talking points", personas: ["founder"] },
  { text: "Calculate our runway at current burn rate", personas: ["founder", "trading"] },

  // ── Sales ─────────────────────────────────────────────────────────────
  { text: "Research this prospect and draft personalized outreach", personas: ["sales"] },
  { text: "Build a battle card against our top competitor", personas: ["sales"] },
  { text: "Write a follow-up email after today's demo", personas: ["sales"] },
  { text: "Summarize this RFP and highlight our win themes", personas: ["sales"] },
  { text: "Draft a case study from this customer success story", personas: ["sales", "marketing"] },
  { text: "Prepare a pricing comparison for the proposal", personas: ["sales"] },
  { text: "Script the objection handling for budget concerns", personas: ["sales"] },

  // ── HR & people ops ───────────────────────────────────────────────────
  { text: "Write a job description for a senior data engineer", personas: ["hr"] },
  { text: "Create interview questions for a PM role", personas: ["hr"] },
  { text: "Draft a performance review template", personas: ["hr"] },
  { text: "Build an onboarding checklist for new hires", personas: ["hr"] },
  { text: "Summarize this employee engagement survey", personas: ["hr", "data"] },
  { text: "Write a company-wide announcement about the new policy", personas: ["hr"] },

  // ── Legal & compliance ────────────────────────────────────────────────
  { text: "Review this contract and flag non-standard clauses", personas: ["legal"] },
  { text: "Summarize our privacy policy in plain English", personas: ["legal"] },
  { text: "Draft a data processing agreement template", personas: ["legal"] },
  { text: "Check this copy for regulatory compliance issues", personas: ["legal"] },
  { text: "Compare these two license types for our use case", personas: ["legal", "engineering"] },

  // ── Data & analytics ──────────────────────────────────────────────────
  { text: "Analyze this CSV and surface the key insights", personas: ["data"] },
  { text: "Build a dashboard layout for these KPIs", personas: ["data"] },
  { text: "Write SQL queries to answer these business questions", personas: ["data"] },
  { text: "Find anomalies in this time-series dataset", personas: ["data"] },
  { text: "Create a data dictionary for this schema", personas: ["data", "engineering"] },
  { text: "Visualize the funnel drop-off from these numbers", personas: ["data", "marketing"] },
  { text: "Clean and normalize this messy spreadsheet", personas: ["data"] },
  { text: "Suggest the right chart type for this dataset", personas: ["data"] },

  // ── Research & academia ───────────────────────────────────────────────
  { text: "Summarize the latest papers on transformer architectures", personas: ["research"] },
  { text: "Write a literature review on climate adaptation", personas: ["research"] },
  { text: "Design an experiment to test this hypothesis", personas: ["research"] },
  { text: "Create an annotated bibliography from these sources", personas: ["research"] },
  { text: "Compare methodologies across these three studies", personas: ["research"] },
  { text: "Draft an abstract for this conference submission", personas: ["research"] },
  { text: "Extract key findings from these 10 papers into a table", personas: ["research"] },

  // ── Operations & logistics ────────────────────────────────────────────
  {
    text: "Draft an SOP for the incident response process",
    personas: ["operations", "engineering"],
  },
  { text: "Map out the supply chain for this product", personas: ["operations"] },
  { text: "Create a vendor evaluation scorecard", personas: ["operations"] },
  { text: "Build a capacity planning spreadsheet for Q2", personas: ["operations"] },
  { text: "Optimize this warehouse layout for faster picking", personas: ["operations"] },
  { text: "Create a risk register for this project", personas: ["operations", "product"] },

  // ── Customer support ──────────────────────────────────────────────────
  { text: "Draft a knowledge base article for this common issue", personas: ["support"] },
  { text: "Create response templates for our top 10 tickets", personas: ["support"] },
  { text: "Analyze support ticket trends from the last 30 days", personas: ["support", "data"] },
  { text: "Write an escalation playbook for critical issues", personas: ["support", "operations"] },
  { text: "Categorize these tickets by urgency and topic", personas: ["support"] },

  // ── Personal productivity ─────────────────────────────────────────────
  { text: "Plan a 7-day trip to Tokyo with a daily itinerary", personas: ["personal"] },
  { text: "Create a weekly meal plan with a grocery list", personas: ["personal"] },
  { text: "Build a monthly budget tracker from my expenses", personas: ["personal"] },
  { text: "Help me learn the basics of Rust in 30 days", personas: ["personal", "engineering"] },
  { text: "Organize my reading list by priority and topic", personas: ["personal"] },
  { text: "Draft a pros-and-cons list for this decision", personas: ["personal"] },

  // ── Healthcare ────────────────────────────────────────────────────────
  { text: "Summarize this clinical study in layman's terms", personas: ["healthcare", "research"] },
  { text: "Create a patient education handout for diabetes", personas: ["healthcare"] },
  { text: "Compare treatment options from these guidelines", personas: ["healthcare"] },
  { text: "Draft a care plan summary for the weekly review", personas: ["healthcare"] },

  // ── Real estate ───────────────────────────────────────────────────────
  { text: "Analyze comparable sales for this property address", personas: ["realestate"] },
  {
    text: "Write a compelling listing description for this home",
    personas: ["realestate", "writing"],
  },
  { text: "Build a rent-vs-buy calculator with my numbers", personas: ["realestate", "trading"] },
  {
    text: "Draft a market update newsletter for my clients",
    personas: ["realestate", "marketing"],
  },

  // ── Creative & media ──────────────────────────────────────────────────
  {
    text: "Write a video script for a 2-minute product explainer",
    personas: ["creative", "marketing"],
  },
  { text: "Create a podcast episode outline on remote work", personas: ["creative"] },
  { text: "Draft a storyboard for this ad concept", personas: ["creative", "marketing"] },
  { text: "Generate tagline options for the rebrand", personas: ["creative", "marketing"] },
  { text: "Write a short story prompt to get me started", personas: ["creative"] },
  { text: "Create a mood board brief from these references", personas: ["creative", "design"] },

  // ── Writing & content ─────────────────────────────────────────────────
  { text: "Draft a newsletter from this week's updates", personas: ["writing"] },
  { text: "Write an outline for a talk on AI in healthcare", personas: ["writing", "healthcare"] },
  { text: "Turn this transcript into a polished article", personas: ["writing"] },
  { text: "Create a brand voice guide from these examples", personas: ["writing", "marketing"] },
  { text: "Rewrite this paragraph for a non-technical audience", personas: ["writing"] },
  { text: "Generate 10 blog post title ideas for this topic", personas: ["writing", "marketing"] },
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
