import { v4 as uuidv4 } from "uuid";
import { MemoryService } from "../memory/MemoryService";
import { UserProfileService } from "../memory/UserProfileService";
import { KnowledgeGraphService } from "../knowledge-graph/KnowledgeGraphService";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import type { ProactiveSuggestion, SuggestionType } from "../../shared/types";

const SUGGESTION_MARKER = "[SUGGESTION]";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ACTIVE_SUGGESTIONS = 10;
const MIN_RECURRING_COUNT = 3;

// ─── Follow-Up Templates ──────────────────────────────────────────

interface FollowUpTemplate {
  title: string;
  description: string;
  promptSuffix: string;
}

const FOLLOW_UP_TEMPLATES: Record<string, FollowUpTemplate[]> = {
  build: [
    {
      title: "Write tests for the new code",
      description: "Add unit or integration tests to validate the implementation.",
      promptSuffix: "Write comprehensive tests for the code I just built",
    },
    {
      title: "Add documentation",
      description: "Document the new feature or module.",
      promptSuffix: "Write documentation for what I just built",
    },
  ],
  fix: [
    {
      title: "Add regression tests",
      description: "Prevent this bug from recurring with targeted tests.",
      promptSuffix: "Write regression tests for the bug I just fixed",
    },
    {
      title: "Check for similar issues",
      description: "The same pattern might exist elsewhere in the codebase.",
      promptSuffix: "Search for similar bugs or patterns to the one I just fixed",
    },
  ],
  research: [
    {
      title: "Create an action plan",
      description: "Turn research findings into concrete next steps.",
      promptSuffix: "Create an action plan based on the research I just completed",
    },
  ],
  api: [
    {
      title: "Add error handling",
      description: "Ensure the API handles edge cases gracefully.",
      promptSuffix: "Add comprehensive error handling to the API I just built",
    },
  ],
};

// ─── Goal Templates ────────────────────────────────────────────────

interface GoalTemplate {
  pattern: RegExp;
  title: (goal: string) => string;
  prompt: (goal: string) => string;
}

const GOAL_TEMPLATES: GoalTemplate[] = [
  {
    pattern: /\b(launch|ship|release|deploy)\b/i,
    title: (g) => `Create a launch checklist for "${g}"`,
    prompt: (g) => `Create a detailed launch checklist with milestones and deadlines for: ${g}`,
  },
  {
    pattern: /\b(learn|study|master|understand)\b/i,
    title: (g) => `Build a learning plan for "${g}"`,
    prompt: (g) => `Create a structured learning plan with resources and milestones for: ${g}`,
  },
  {
    pattern: /\b(automat|streamline|optimize)\b/i,
    title: (_g) => "Identify automation opportunities",
    prompt: (g) =>
      `Identify the top 3 most repetitive tasks that could be automated, related to: ${g}`,
  },
  {
    pattern: /\b(grow|scale|e_xpand)\b/i,
    title: (g) => `Create a growth plan for "${g}"`,
    prompt: (g) => `Create a growth metrics dashboard and plan for: ${g}`,
  },
];

const DEFAULT_GOAL_TEMPLATE = {
  title: (g: string) => `Break down "${g}" into tasks`,
  prompt: (g: string) => `Break down this goal into actionable tasks: ${g}`,
};

// ─── Reverse Prompt Templates ──────────────────────────────────────

interface ReversePromptTemplate {
  condition: (ctx: ReversePromptContext) => boolean;
  title: string;
  description: string;
  prompt: string;
  confidence: number;
}

interface ReversePromptContext {
  hasWorkContext: boolean;
  hasGoals: boolean;
  hasPreferences: boolean;
  recentPlaybookCount: number;
}

const REVERSE_PROMPTS: ReversePromptTemplate[] = [
  {
    condition: (ctx) => ctx.hasWorkContext && ctx.recentPlaybookCount >= 5,
    title: "I could create SOPs from your patterns",
    description:
      "You have multiple proven workflows. I can formalize them into standard operating procedures.",
    prompt:
      "Review my recent task patterns and playbook entries, then create standard operating procedures (SOPs) for the most common workflows.",
    confidence: 0.8,
  },
  {
    condition: (ctx) => ctx.hasGoals && ctx.recentPlaybookCount >= 3,
    title: "I could build a progress dashboard",
    description: "Track progress toward your goals with a structured status report.",
    prompt:
      "Review my goals and recent completed tasks, then create a progress report showing how my work aligns with my goals.",
    confidence: 0.7,
  },
  {
    condition: (ctx) => ctx.hasPreferences,
    title: "I could set up personalized templates",
    description: "Based on your preferences, I can create reusable task templates.",
    prompt:
      "Based on my user preferences and common task patterns, create a set of reusable task templates I can use for recurring work.",
    confidence: 0.65,
  },
  {
    condition: (ctx) => ctx.recentPlaybookCount >= 8,
    title: "I could generate a weekly standup summary",
    description: "Automatic summary of what you accomplished and what's next.",
    prompt:
      "Generate a weekly standup-style summary of my recent completed tasks, in-progress work, and suggested next steps.",
    confidence: 0.7,
  },
];

// ─── Action Keywords for KG Insights ──────────────────────────────

const ACTION_KEYWORDS =
  /\b(latency|error|slow|fail|deprecated|security|performance|bottleneck|issue|warning|critical|outage|vulnerability)\b/i;

// ─── Service ──────────────────────────────────────────────────────

export class ProactiveSuggestionsService {
  private static dismissedIds: Set<string> = new Set();
  private static actedOnIds: Set<string> = new Set();
  private static loaded = false;
  /** Tracks titles generated within the current generateAll() cycle for cross-generator dedup */
  private static pendingTitles: Set<string> = new Set();

  // ─── Persistence Helpers ────────────────────────────────────────

  private static loadDismissed(): void {
    if (this.loaded) return;
    this.loaded = true;

    if (!SecureSettingsRepository.isInitialized()) return;
    try {
      const repo = SecureSettingsRepository.getInstance();
      const data = repo.load<{ dismissed: string[]; actedOn: string[] }>(
        "proactive-suggestions-state",
      );
      if (data) {
        this.dismissedIds = new Set(data.dismissed || []);
        this.actedOnIds = new Set(data.actedOn || []);
      }
    } catch {
      // best-effort
    }
  }

  private static saveDismissed(): void {
    if (!SecureSettingsRepository.isInitialized()) return;
    try {
      const repo = SecureSettingsRepository.getInstance();
      repo.save("proactive-suggestions-state", {
        dismissed: [...this.dismissedIds].slice(-200), // cap stored IDs
        actedOn: [...this.actedOnIds].slice(-200),
      });
    } catch {
      // best-effort
    }
  }

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * List active (non-expired, non-dismissed) suggestions for a workspace.
   */
  static listActive(workspaceId: string): ProactiveSuggestion[] {
    this.loadDismissed();

    try {
      const results = MemoryService.search(workspaceId, SUGGESTION_MARKER, 50);
      const now = Date.now();
      const suggestions: ProactiveSuggestion[] = [];

      for (const r of results) {
        if (r.type !== "insight" || !r.snippet.includes(SUGGESTION_MARKER)) continue;
        const parsed = this.parseSuggestion(r.snippet, r.id, r.createdAt);
        if (!parsed) continue;
        if (parsed.expiresAt < now) continue;
        if (this.dismissedIds.has(parsed.id)) continue;
        if (this.actedOnIds.has(parsed.id)) continue;
        suggestions.push(parsed);
      }

      return suggestions
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, MAX_ACTIVE_SUGGESTIONS);
    } catch {
      return [];
    }
  }

  /**
   * Dismiss a suggestion.
   */
  static dismiss(workspaceId: string, suggestionId: string): boolean {
    this.loadDismissed();
    this.dismissedIds.add(suggestionId);
    this.saveDismissed();
    return true;
  }

  /**
   * Mark a suggestion as acted-on and return its actionPrompt.
   */
  static actOn(workspaceId: string, suggestionId: string): string | null {
    this.loadDismissed();

    try {
      const results = MemoryService.search(workspaceId, SUGGESTION_MARKER, 50);
      for (const r of results) {
        if (r.type !== "insight" || !r.snippet.includes(SUGGESTION_MARKER)) continue;
        const parsed = this.parseSuggestion(r.snippet, r.id, r.createdAt);
        if (!parsed || parsed.id !== suggestionId) continue;

        this.actedOnIds.add(suggestionId);
        this.saveDismissed();
        return parsed.actionPrompt || null;
      }
    } catch {
      // best-effort
    }

    return null;
  }

  /**
   * Get top N suggestions for inclusion in daily briefing.
   */
  static getTopForBriefing(workspaceId: string, limit = 3): ProactiveSuggestion[] {
    return this.listActive(workspaceId).slice(0, limit);
  }

  // ─── Generators ─────────────────────────────────────────────────

  /**
   * Run all suggestion generators. Called from DailyBriefingService.
   */
  static async generateAll(workspaceId: string): Promise<void> {
    this.pendingTitles.clear();
    try {
      await this.detectRecurringPatterns(workspaceId);
    } catch {
      /* best-effort */
    }
    try {
      await this.generateGoalAlignedSuggestions(workspaceId);
    } catch {
      /* best-effort */
    }
    try {
      await this.generateKnowledgeInsights(workspaceId);
    } catch {
      /* best-effort */
    }
    try {
      await this.generateReversePrompts(workspaceId);
    } catch {
      /* best-effort */
    }
    this.pendingTitles.clear();
    try {
      this.pruneExpired(workspaceId);
    } catch {
      /* best-effort */
    }
  }

  /**
   * Generate follow-up suggestions after a successful task completion.
   */
  static async generateFollowUpSuggestions(
    workspaceId: string,
    taskId: string,
    taskTitle: string,
    taskPrompt: string,
    _toolsUsed: string[],
    _resultSummary: string,
  ): Promise<void> {
    const category = this.detectTaskCategory(taskTitle, taskPrompt);
    if (!category) return;

    const templates = FOLLOW_UP_TEMPLATES[category];
    if (!templates || templates.length === 0) return;

    // Pick the first template that isn't already a duplicate
    for (const tmpl of templates) {
      if (this.isDuplicate(workspaceId, tmpl.title)) continue;

      await this.storeSuggestion(workspaceId, {
        type: "follow_up",
        title: tmpl.title,
        description: tmpl.description,
        actionPrompt: `${tmpl.promptSuffix} in task "${taskTitle}".`,
        sourceTaskId: taskId,
        confidence: 0.8,
      });
      break; // One follow-up per task completion
    }
  }

  /**
   * Detect recurring task patterns from playbook entries.
   */
  static async detectRecurringPatterns(workspaceId: string): Promise<void> {
    const results = MemoryService.search(workspaceId, "[PLAYBOOK] Task succeeded", 50);
    const playbookEntries = results
      .filter((r) => r.type === "insight" && r.snippet.includes("[PLAYBOOK]"))
      .slice(0, 30);

    const groups = new Map<string, { count: number; titles: string[]; tools: string }>();

    for (const entry of playbookEntries) {
      const titleMatch = entry.snippet.match(/Task succeeded: "([^"]+)"/);
      if (!titleMatch) continue;
      const raw = titleMatch[1];
      const key = this.normalizeTitle(raw);
      if (!key) continue;

      const existing = groups.get(key) || { count: 0, titles: [], tools: "" };
      existing.count++;
      existing.titles.push(raw);
      const toolsMatch = entry.snippet.match(/Key tools: ([^\n]+)/);
      if (toolsMatch) existing.tools = toolsMatch[1];
      groups.set(key, existing);
    }

    for (const [, group] of groups) {
      if (group.count < MIN_RECURRING_COUNT) continue;
      const representativeTitle = group.titles[0];
      const title = `Automate "${representativeTitle}"`.slice(0, 80);
      if (this.isDuplicate(workspaceId, title)) continue;

      await this.storeSuggestion(workspaceId, {
        type: "recurring_pattern",
        title,
        description: `You've done this ${group.count} times. I can create an automated workflow.`,
        actionPrompt: `Create an automated workflow or script for the recurring task: "${representativeTitle}". Tools typically used: ${group.tools || "various"}.`,
        confidence: Math.min(0.95, 0.6 + group.count * 0.05),
      });
    }
  }

  /**
   * Generate goal-aligned suggestions from user profile.
   */
  static async generateGoalAlignedSuggestions(workspaceId: string): Promise<void> {
    const profile = UserProfileService.getProfile();
    const goals = profile.facts.filter((f) => f.category === "goal").slice(0, 5);

    for (const goal of goals) {
      const goalValue = goal.value.replace(/^Goal:\s*/i, "").trim();
      if (!goalValue) continue;

      const matched =
        GOAL_TEMPLATES.find((t) => t.pattern.test(goalValue)) || DEFAULT_GOAL_TEMPLATE;
      const title = matched.title(goalValue).slice(0, 80);
      if (this.isDuplicate(workspaceId, title)) continue;

      await this.storeSuggestion(workspaceId, {
        type: "goal_aligned",
        title,
        description: `Your goal: "${goalValue}"`.slice(0, 250),
        actionPrompt: matched.prompt(goalValue),
        confidence: 0.75,
      });
    }
  }

  /**
   * Generate insight suggestions from knowledge graph entities
   * that have actionable observations.
   */
  static async generateKnowledgeInsights(workspaceId: string): Promise<void> {
    if (!KnowledgeGraphService.isInitialized()) return;

    const problemQueries = ["error performance issue", "latency slow", "security deprecated"];
    const seenEntityIds = new Set<string>();

    for (const query of problemQueries) {
      const results = KnowledgeGraphService.search(workspaceId, query, 5);

      for (const result of results) {
        if (seenEntityIds.has(result.entity.id)) continue;
        seenEntityIds.add(result.entity.id);

        const observations = KnowledgeGraphService.getObservations(result.entity.id, 10);
        const actionableObs = observations.filter((o) => ACTION_KEYWORDS.test(o.content || ""));

        if (actionableObs.length < 1) continue;

        const entityName = result.entity.name;
        const title = `Investigate ${entityName}`.slice(0, 80);
        if (this.isDuplicate(workspaceId, title)) continue;

        const obsPreview = actionableObs[0].content?.slice(0, 100) || "";
        await this.storeSuggestion(workspaceId, {
          type: "insight",
          title,
          description: `${actionableObs.length} observation(s) flagged: "${obsPreview}"`.slice(
            0,
            250,
          ),
          actionPrompt: `Investigate the entity "${entityName}" which has ${actionableObs.length} observations about potential issues. Review the observations and recommend fixes.`,
          sourceEntity: entityName,
          confidence: Math.min(0.9, 0.6 + actionableObs.length * 0.1),
        });
      }
    }
  }

  /**
   * Generate reverse prompts — capability surfacing based on user context.
   */
  static async generateReversePrompts(workspaceId: string): Promise<void> {
    const profile = UserProfileService.getProfile();
    const ctx: ReversePromptContext = {
      hasWorkContext: profile.facts.some((f) => f.category === "work"),
      hasGoals: profile.facts.some((f) => f.category === "goal"),
      hasPreferences: profile.facts.some((f) => f.category === "preference"),
      recentPlaybookCount: 0,
    };

    // Count recent playbook entries
    try {
      const recentMemories = MemoryService.getRecent(workspaceId, 30);
      ctx.recentPlaybookCount = recentMemories.filter(
        (m) => m.type === "insight" && m.content.includes("[PLAYBOOK]"),
      ).length;
    } catch {
      // best-effort
    }

    for (const rp of REVERSE_PROMPTS) {
      if (!rp.condition(ctx)) continue;
      if (this.isDuplicate(workspaceId, rp.title)) continue;

      await this.storeSuggestion(workspaceId, {
        type: "reverse_prompt",
        title: rp.title,
        description: rp.description,
        actionPrompt: rp.prompt,
        confidence: rp.confidence,
      });
    }
  }

  // ─── Storage Helpers ────────────────────────────────────────────

  private static async storeSuggestion(
    workspaceId: string,
    suggestion: {
      type: SuggestionType;
      title: string;
      description: string;
      actionPrompt?: string;
      sourceTaskId?: string;
      sourceEntity?: string;
      confidence: number;
    },
  ): Promise<void> {
    // Enforce max active count
    const active = this.listActive(workspaceId);
    if (active.length >= MAX_ACTIVE_SUGGESTIONS) {
      // Evict lowest-confidence to make room
      const lowest = active[active.length - 1]; // already sorted desc
      if (lowest && suggestion.confidence <= lowest.confidence) return; // new one wouldn't rank
      if (lowest) {
        this.dismissedIds.add(lowest.id);
        this.saveDismissed();
      }
    }

    const id = uuidv4();
    const payload: Record<string, unknown> = {
      id,
      type: suggestion.type,
      title: suggestion.title,
      description: suggestion.description,
      confidence: suggestion.confidence,
    };
    if (suggestion.actionPrompt) payload.actionPrompt = suggestion.actionPrompt;
    if (suggestion.sourceTaskId) payload.sourceTaskId = suggestion.sourceTaskId;
    if (suggestion.sourceEntity) payload.sourceEntity = suggestion.sourceEntity;

    const content = `${SUGGESTION_MARKER} ${JSON.stringify(payload)}`;

    // Track title as pending so same-cycle generators can dedup
    this.pendingTitles.add(suggestion.title.toLowerCase().trim().slice(0, 60));

    try {
      await MemoryService.capture(workspaceId, undefined, "insight", content);
    } catch {
      /* best-effort */
    }
  }

  private static parseSuggestion(
    snippet: string,
    memoryId: string,
    createdAt: number,
  ): ProactiveSuggestion | null {
    const idx = snippet.indexOf(SUGGESTION_MARKER);
    if (idx === -1) return null;

    const jsonStr = snippet.slice(idx + SUGGESTION_MARKER.length).trim();
    try {
      const data = JSON.parse(jsonStr);
      return {
        id: data.id || memoryId,
        type: data.type || "follow_up",
        title: data.title || "",
        description: data.description || "",
        actionPrompt: data.actionPrompt,
        sourceTaskId: data.sourceTaskId,
        sourceEntity: data.sourceEntity,
        confidence: typeof data.confidence === "number" ? data.confidence : 0.5,
        createdAt,
        expiresAt: createdAt + SEVEN_DAYS_MS,
        dismissed: this.dismissedIds.has(data.id || memoryId),
        actedOn: this.actedOnIds.has(data.id || memoryId),
      };
    } catch {
      return null;
    }
  }

  private static isDuplicate(workspaceId: string, title: string): boolean {
    const normalizedNew = title.toLowerCase().trim().slice(0, 60);
    // Check in-memory pending titles from current generation cycle
    if (this.pendingTitles.has(normalizedNew)) return true;
    // Check already-persisted suggestions
    const active = this.listActive(workspaceId);
    return active.some((s) => s.title.toLowerCase().trim().slice(0, 60) === normalizedNew);
  }

  private static pruneExpired(_workspaceId: string): void {
    // Expired suggestions are filtered out on retrieval (expiresAt check),
    // so no explicit cleanup needed. MemoryService retention handles old entries.
  }

  private static normalizeTitle(title: string): string {
    return title
      .toLowerCase()
      .replace(/[0-9]+/g, "")
      .replace(/\b\d{4}[-/]\d{2}[-/]\d{2}\b/g, "")
      .replace(/[^a-z\s]/g, "")
      .trim()
      .split(/\s+/)
      .slice(0, 3)
      .join(" ");
  }

  private static detectTaskCategory(title: string, prompt: string): string | null {
    const combined = `${title} ${prompt}`.toLowerCase();
    if (/\b(build|create|implement|add|develop|scaffold)\b/.test(combined)) return "build";
    if (/\b(fix|debug|repair|resolve|patch|hotfix)\b/.test(combined)) return "fix";
    if (/\b(research|analyze|investigate|explore|compare)\b/.test(combined)) return "research";
    if (/\b(api|endpoint|route|rest|graphql)\b/.test(combined)) return "api";
    return null;
  }
}
