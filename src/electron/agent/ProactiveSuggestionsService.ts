import { v4 as uuidv4 } from "uuid";
import { MemoryService } from "../memory/MemoryService";
import { PlaybookService } from "../memory/PlaybookService";
import {
  getProactiveSuggestionStore,
  type ProactiveSuggestionStore,
} from "../memory/ProactiveSuggestionStore";
import {
  parseSuggestionFeedbackContent,
  renderSuggestionFeedbackContent,
  type StoredSuggestion,
  type StoredSuggestionStatus,
} from "../memory/suggestions-sql";
import { UserProfileService } from "../memory/UserProfileService";
import { KnowledgeGraphService } from "../knowledge-graph/KnowledgeGraphService";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import { getAwarenessService } from "../awareness/AwarenessService";
import type {
  HeartbeatWorkspaceScope,
  ProactiveSuggestion,
  SuggestionType,
} from "../../shared/types";
import {
  commitmentEntityKey,
  getSuggestionSink,
  normalizeSuggestionEntityKey,
  setSuggestionSinkStore,
  type SuggestionCreateInput,
  type SuggestionProposal,
  type SuggestionProposalResult,
  type SuggestionSinkStore,
  type SuggestionSource,
} from "./SuggestionSink";

const SUGGESTION_MARKER = "[SUGGESTION]";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ACTIVE_SUGGESTIONS = 10;
const MIN_RECURRING_COUNT = 3;
const SURFACE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const MAX_TELEMETRY_EVENTS = 1000;
/** A dismissed or acted-on entity is not re-proposed by any producer for this long. */
const ENTITY_SUPPRESSION_MS = SEVEN_DAYS_MS;
const MAX_MERGED_SOURCE_ENTRIES = 200;

type SuggestionTelemetryEventType =
  | "created"
  | "surfaced"
  | "dismissed"
  | "snoozed"
  | "edited"
  | "ignored"
  | "acted_on";

interface SuggestionFeedbackStats {
  actedOn: number;
  dismissed: number;
  snoozed: number;
  edited: number;
  ignored: number;
  surfaced: number;
  lastAt: number;
}

interface SuggestionTelemetryEvent {
  workspaceId: string;
  suggestionId: string;
  type: SuggestionTelemetryEventType;
  at: number;
  hour: number;
}

interface PersistedSuggestionState {
  dismissed: string[];
  actedOn: string[];
  snoozedUntil: Record<string, number>;
  surfacedAt: Record<string, number>;
  telemetryEvents: SuggestionTelemetryEvent[];
  feedbackByKey?: Record<string, SuggestionFeedbackStats>;
  /** Sources/evidence merged into an existing suggestion by the SuggestionSink. */
  mergedSources?: Record<string, { sources: string[]; evidence: string[] }>;
  /** `${workspaceId}::${entityKey}` -> suppressed until (ms). */
  suppressedEntities?: Record<string, number>;
}

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
  private static snoozedUntil: Map<string, number> = new Map();
  private static surfacedAt: Map<string, number> = new Map();
  private static telemetryEvents: SuggestionTelemetryEvent[] = [];
  private static feedbackByKey: Map<string, SuggestionFeedbackStats> = new Map();
  private static mergedSources: Map<string, { sources: string[]; evidence: string[] }> = new Map();
  private static suppressedEntities: Map<string, number> = new Map();
  private static loaded = false;

  // ─── Persistence Helpers ────────────────────────────────────────

  private static loadDismissed(): void {
    if (this.loaded) return;
    this.loaded = true;

    if (!SecureSettingsRepository.isInitialized()) return;
    try {
      const repo = SecureSettingsRepository.getInstance();
      const data = repo.load<PersistedSuggestionState>("proactive-suggestions-state");
      if (data) {
        this.dismissedIds = new Set(data.dismissed || []);
        this.actedOnIds = new Set(data.actedOn || []);
        this.snoozedUntil = new Map(Object.entries(data.snoozedUntil || {}));
        this.surfacedAt = new Map(Object.entries(data.surfacedAt || {}));
        this.telemetryEvents = Array.isArray(data.telemetryEvents) ? data.telemetryEvents : [];
        this.feedbackByKey = new Map(Object.entries(data.feedbackByKey || {}));
        this.mergedSources = new Map(Object.entries(data.mergedSources || {}));
        this.suppressedEntities = new Map(Object.entries(data.suppressedEntities || {}));
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
        snoozedUntil: Object.fromEntries(this.snoozedUntil),
        surfacedAt: Object.fromEntries(this.surfacedAt),
        telemetryEvents: this.telemetryEvents.slice(-MAX_TELEMETRY_EVENTS),
        feedbackByKey: Object.fromEntries(this.feedbackByKey),
        mergedSources: Object.fromEntries(
          [...this.mergedSources].slice(-MAX_MERGED_SOURCE_ENTRIES),
        ),
        suppressedEntities: Object.fromEntries(
          [...this.suppressedEntities].filter(([, until]) => until > Date.now()),
        ),
      });
    } catch {
      // best-effort
    }
  }

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * List active (non-expired, non-dismissed) suggestions for a workspace.
   */
  static async listActive(
    workspaceId: string,
    opts?: { includeDeferred?: boolean; recordSurface?: boolean },
    workspaceIds?: string[],
  ): Promise<ProactiveSuggestion[]> {
    this.loadDismissed();

    try {
      const searchWorkspaceIds =
        Array.isArray(workspaceIds) && workspaceIds.length > 0 ? workspaceIds : [workspaceId];
      const results = (
        await Promise.all(searchWorkspaceIds.map((id) => this.readStoredSuggestions(id)))
      ).flat();
      const now = Date.now();
      const suggestions: ProactiveSuggestion[] = [];

      for (const parsed of results) {
        const originWorkspaceId = parsed.workspaceId || workspaceId;
        if (parsed.expiresAt < now) continue;
        if ((parsed.snoozedUntil || 0) > now) continue;
        if (this.dismissedIds.has(parsed.id)) continue;
        if (this.actedOnIds.has(parsed.id)) continue;
        if (opts?.recordSurface !== false) {
          this.maybeRecordIgnoredSuggestion(originWorkspaceId, parsed, now);
        }
        suggestions.push(parsed);
      }

      const ranked = suggestions
        .map((suggestion) => ({
          suggestion,
          score:
            suggestion.confidence +
            this.getTimingAdjustment(suggestion.workspaceId || workspaceId, suggestion) +
            this.getFeedbackAdjustment(suggestion.workspaceId || workspaceId, suggestion),
        }))
        .sort((a, b) => b.score - a.score)
        .map((entry) => entry.suggestion);

      const visible = (
        opts?.includeDeferred
          ? ranked
          : ranked.filter((s) => !this.shouldDefer(s.workspaceId || workspaceId, s))
      ).slice(0, MAX_ACTIVE_SUGGESTIONS);

      if (opts?.recordSurface !== false) {
        for (const suggestion of visible) {
          this.recordSurface(suggestion.workspaceId || workspaceId, suggestion.id);
        }
      }

      return visible;
    } catch {
      return [];
    }
  }

  /**
   * Dismiss a suggestion.
   */
  static async dismiss(workspaceId: string, suggestionId: string): Promise<boolean> {
    this.loadDismissed();
    this.dismissedIds.add(suggestionId);
    await this.persistStatus(workspaceId, suggestionId, "dismissed");
    this.recordTelemetry(workspaceId, suggestionId, "dismissed");
    const suggestion = await this.findSuggestionById(workspaceId, suggestionId);
    if (suggestion) {
      this.recordSuggestionFeedback(workspaceId, suggestion, "dismissed");
      this.captureSuggestionFeedbackMemory(workspaceId, suggestion, "dismissed");
      this.suppressEntity(workspaceId, suggestion);
    }
    this.saveDismissed();
    return true;
  }

  static async snooze(
    workspaceId: string,
    suggestionId: string,
    snoozedUntil: number,
  ): Promise<boolean> {
    this.loadDismissed();
    const until = Number.isFinite(snoozedUntil) ? snoozedUntil : Date.now() + 24 * 60 * 60 * 1000;
    this.snoozedUntil.set(suggestionId, until);
    await this.withSuggestionStore((store) =>
      store.setSnoozedUntil(workspaceId, suggestionId, until),
    );
    this.recordTelemetry(workspaceId, suggestionId, "snoozed");
    const suggestion = await this.findSuggestionById(workspaceId, suggestionId);
    if (suggestion) {
      this.recordSuggestionFeedback(workspaceId, suggestion, "snoozed");
      this.captureSuggestionFeedbackMemory(workspaceId, suggestion, "snoozed");
    }
    this.saveDismissed();
    return true;
  }

  static async recordEditedAction(
    workspaceId: string,
    suggestionId: string,
    editedPrompt: string,
  ): Promise<boolean> {
    this.loadDismissed();
    const suggestion = await this.findSuggestionById(workspaceId, suggestionId);
    if (!suggestion) return false;
    this.recordTelemetry(workspaceId, suggestionId, "edited");
    this.recordSuggestionFeedback(workspaceId, suggestion, "edited");
    this.captureSuggestionFeedbackMemory(workspaceId, suggestion, "edited", editedPrompt);
    this.saveDismissed();
    return true;
  }

  /**
   * Mark a suggestion as acted-on and return its actionPrompt.
   */
  static async actOn(workspaceId: string, suggestionId: string): Promise<string | null> {
    this.loadDismissed();

    try {
      const parsed = await this.findSuggestionById(workspaceId, suggestionId);
      if (parsed) {
        this.actedOnIds.add(suggestionId);
        await this.persistStatus(workspaceId, suggestionId, "acted_on");
        this.recordTelemetry(workspaceId, suggestionId, "acted_on");
        this.recordSuggestionFeedback(workspaceId, parsed, "acted_on");
        this.captureSuggestionFeedbackMemory(workspaceId, parsed, "acted_on");
        this.suppressEntity(workspaceId, parsed);
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
  static async getTopForBriefing(workspaceId: string, limit = 3): Promise<ProactiveSuggestion[]> {
    return (
      await this.listActive(workspaceId, {
        includeDeferred: true,
        recordSurface: false,
      })
    ).slice(0, limit);
  }

  static async getTopForBriefingForWorkspaces(
    workspaceId: string,
    workspaceIds: string[],
    limit = 3,
  ): Promise<ProactiveSuggestion[]> {
    return (
      await this.listActive(
        workspaceId,
        {
          includeDeferred: true,
          recordSurface: false,
        },
        workspaceIds,
      )
    ).slice(0, limit);
  }

  // ─── Generators ─────────────────────────────────────────────────

  /**
   * Run all suggestion generators. Called from DailyBriefingService.
   */
  static async generateAll(workspaceId: string): Promise<void> {
    // Cross-generator dedupe happens in the SuggestionSink (entity key + normalized title).
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
    try {
      await this.generateAwarenessSuggestions(workspaceId);
    } catch {
      /* best-effort */
    }
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

    // Pick the first template that does not merge into an existing suggestion
    for (const tmpl of templates) {
      const result = await this.propose({
        workspaceId,
        source: "follow_up",
        type: "follow_up",
        title: tmpl.title,
        why: tmpl.description,
        actionPrompt: `${tmpl.promptSuffix} in task "${taskTitle}".`,
        sourceTaskId: taskId,
        confidence: 0.8,
      });
      if (result.created) break; // One follow-up per task completion
    }
  }

  /**
   * Propose a suggestion through the shared SuggestionSink: proposals for the same entity merge
   * into one suggestion (with every proposing source recorded) instead of creating another one.
   */
  static propose(proposal: SuggestionProposal): Promise<SuggestionProposalResult> {
    return getSuggestionSink().propose(proposal);
  }

  /**
   * Companion suggestion entry point (Heartbeat dispatch, Workflow Intelligence). Routes through
   * the SuggestionSink and returns null when the proposal merged into an existing suggestion or
   * was suppressed, so callers do not notify twice.
   */
  static async createCompanionSuggestion(
    workspaceId: string,
    suggestion: {
      type?: SuggestionType;
      title: string;
      description: string;
      actionPrompt?: string;
      sourceTaskId?: string;
      sourceEntity?: string;
      confidence: number;
      suggestionClass?: ProactiveSuggestion["suggestionClass"];
      urgency?: ProactiveSuggestion["urgency"];
      learningSignalIds?: string[];
      workspaceScope?: HeartbeatWorkspaceScope;
      sourceSignals?: string[];
      recommendedDelivery?: ProactiveSuggestion["recommendedDelivery"];
      companionStyle?: ProactiveSuggestion["companionStyle"];
      entityKey?: string;
      source?: SuggestionSource;
    },
  ): Promise<ProactiveSuggestion | null> {
    const result = await this.propose({
      workspaceId,
      entityKey: suggestion.entityKey,
      source: suggestion.source || "companion",
      type: suggestion.type || "insight",
      title: suggestion.title,
      why: suggestion.description,
      evidence: suggestion.sourceSignals,
      actionPrompt: suggestion.actionPrompt,
      sourceTaskId: suggestion.sourceTaskId,
      sourceEntity: suggestion.sourceEntity,
      confidence: suggestion.confidence,
      suggestionClass: suggestion.suggestionClass,
      urgency: suggestion.urgency,
      learningSignalIds: suggestion.learningSignalIds,
      workspaceScope: suggestion.workspaceScope,
      recommendedDelivery: suggestion.recommendedDelivery,
      companionStyle: suggestion.companionStyle,
    });
    if (!result.created || !result.suggestion) {
      return null;
    }
    return {
      ...result.suggestion,
      dismissed: this.dismissedIds.has(result.suggestion.id),
      actedOn: this.actedOnIds.has(result.suggestion.id),
    };
  }

  static async generateAwarenessSuggestions(workspaceId: string): Promise<void> {
    const summary = getAwarenessService().getSummary(workspaceId);
    const dueSoon = summary.dueSoon[0];
    if (dueSoon) {
      await this.propose({
        workspaceId,
        // Due-soon items are relationship commitments: one entity key across producers.
        entityKey: dueSoon.tags.includes("commitment")
          ? commitmentEntityKey(dueSoon.id)
          : undefined,
        source: "awareness",
        type: "follow_up",
        title: `Review due soon: ${dueSoon.title}`.slice(0, 80),
        why: dueSoon.detail || "An awareness signal suggests this needs attention soon.",
        actionPrompt: `Review this due-soon item and decide the next action: ${dueSoon.title}`,
        sourceEntity: dueSoon.id,
        evidence: [dueSoon.id],
        confidence: Math.max(0.72, dueSoon.score || 0.72),
      });
    }

    const contextShift = summary.whatMattersNow.find(
      (item) => item.tags.includes("focus") || item.tags.includes("context"),
    );
    if (contextShift) {
      await this.propose({
        workspaceId,
        source: "awareness",
        type: "reverse_prompt",
        title: `Capture current focus: ${contextShift.title}`.slice(0, 80),
        why:
          contextShift.detail ||
          "CoWork detected a context shift and can turn it into a concrete next step.",
        actionPrompt: `Use my current computer context and recent work to propose the best next action for: ${contextShift.title}`,
        sourceEntity: contextShift.id,
        confidence: Math.max(0.64, contextShift.score || 0.64),
      });
    }
  }

  /**
   * Detect recurring task patterns from playbook entries.
   */
  static async detectRecurringPatterns(workspaceId: string): Promise<void> {
    // Recorded successful executions (playbook_entries), newest first; private ones skipped.
    const playbookEntries = await PlaybookService.listEntries(workspaceId, {
      kinds: ["success"],
      limit: 30,
    });

    const groups = new Map<string, { count: number; titles: string[]; tools: string }>();

    for (const entry of playbookEntries) {
      const raw = entry.title;
      if (!raw) continue;
      const key = this.normalizeTitle(raw);
      if (!key) continue;

      const existing = groups.get(key) || { count: 0, titles: [], tools: "" };
      existing.count++;
      existing.titles.push(raw);
      if (entry.toolsUsed.length > 0) existing.tools = entry.toolsUsed.join(", ");
      groups.set(key, existing);
    }

    for (const [, group] of groups) {
      if (group.count < MIN_RECURRING_COUNT) continue;
      const representativeTitle = group.titles[0];
      await this.propose({
        workspaceId,
        source: "proactive",
        type: "recurring_pattern",
        title: `Automate "${representativeTitle}"`.slice(0, 80),
        why: `You've done this ${group.count} times. I can create an automated workflow.`,
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
      await this.propose({
        workspaceId,
        source: "proactive",
        type: "goal_aligned",
        title: matched.title(goalValue).slice(0, 80),
        why: `Your goal: "${goalValue}"`.slice(0, 250),
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
      const results = await KnowledgeGraphService.search(workspaceId, query, 5);

      for (const result of results) {
        if (seenEntityIds.has(result.entity.id)) continue;
        seenEntityIds.add(result.entity.id);

        const observations = await KnowledgeGraphService.getObservations(
          workspaceId,
          result.entity.id,
          10,
        );
        const actionableObs = observations.filter((o) => ACTION_KEYWORDS.test(o.content || ""));

        if (actionableObs.length < 1) continue;

        const entityName = result.entity.name;
        const obsPreview = actionableObs[0].content?.slice(0, 100) || "";
        await this.propose({
          workspaceId,
          entityKey: `kg:${result.entity.id}`,
          source: "proactive",
          type: "insight",
          title: `Investigate ${entityName}`.slice(0, 80),
          why: `${actionableObs.length} observation(s) flagged: "${obsPreview}"`.slice(0, 250),
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

    // Count recent playbook entries (outcomes recorded in the last 30 days, at most 30)
    try {
      ctx.recentPlaybookCount = (
        await PlaybookService.listEntries(workspaceId, {
          kinds: ["success", "failure"],
          since: Date.now() - 30 * 24 * 60 * 60 * 1000,
          limit: 30,
        })
      ).length;
    } catch {
      // best-effort
    }

    for (const rp of REVERSE_PROMPTS) {
      if (!rp.condition(ctx)) continue;
      await this.propose({
        workspaceId,
        source: "proactive",
        type: "reverse_prompt",
        title: rp.title,
        why: rp.description,
        actionPrompt: rp.prompt,
        confidence: rp.confidence,
      });
    }
  }

  // ─── Storage Helpers ────────────────────────────────────────────

  /** Storage behind the SuggestionSink. Producers go through `propose()`, never this. */
  private static async storeSuggestion(
    workspaceId: string,
    suggestion: SuggestionCreateInput,
  ): Promise<ProactiveSuggestion | null> {
    // Enforce max active count
    const active = await this.listActive(workspaceId, {
      includeDeferred: true,
      recordSurface: false,
    });
    if (active.length >= MAX_ACTIVE_SUGGESTIONS) {
      // Evict lowest-confidence to make room
      const lowest = active[active.length - 1]; // already sorted desc
      if (lowest && suggestion.confidence <= lowest.confidence) return null; // new one wouldn't rank
      if (lowest) {
        this.dismissedIds.add(lowest.id);
        await this.persistStatus(lowest.workspaceId || workspaceId, lowest.id, "dismissed");
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
    if (suggestion.suggestionClass) payload.suggestionClass = suggestion.suggestionClass;
    if (suggestion.urgency) payload.urgency = suggestion.urgency;
    if (suggestion.learningSignalIds?.length)
      payload.learningSignalIds = suggestion.learningSignalIds;
    if (suggestion.workspaceScope) payload.workspaceScope = suggestion.workspaceScope;
    if (suggestion.sourceSignals?.length) payload.sourceSignals = suggestion.sourceSignals;
    if (suggestion.recommendedDelivery)
      payload.recommendedDelivery = suggestion.recommendedDelivery;
    if (suggestion.companionStyle) payload.companionStyle = suggestion.companionStyle;
    if (suggestion.entityKey) payload.entityKey = suggestion.entityKey;
    if (suggestion.sources?.length) payload.sources = suggestion.sources;

    const createdAt = Date.now();
    const expiresAt = createdAt + SEVEN_DAYS_MS;

    try {
      if (!(await this.persistSuggestion(workspaceId, id, payload, createdAt, expiresAt))) {
        return null;
      }
      this.recordTelemetry(workspaceId, id, "created");
      return {
        id,
        type: suggestion.type,
        title: suggestion.title,
        description: suggestion.description,
        actionPrompt: suggestion.actionPrompt,
        sourceTaskId: suggestion.sourceTaskId,
        sourceEntity: suggestion.sourceEntity,
        confidence: suggestion.confidence,
        suggestionClass: suggestion.suggestionClass,
        urgency: suggestion.urgency,
        learningSignalIds: suggestion.learningSignalIds,
        workspaceScope: suggestion.workspaceScope,
        workspaceId,
        sourceSignals: suggestion.sourceSignals,
        recommendedDelivery: suggestion.recommendedDelivery,
        companionStyle: suggestion.companionStyle,
        entityKey: suggestion.entityKey,
        sources: suggestion.sources,
        createdAt,
        expiresAt,
        dismissed: false,
        actedOn: false,
        snoozedUntil: this.snoozedUntil.get(id),
      };
    } catch {
      return null;
    }
  }

  // ─── Suggestion table persistence (suggestions / suggestion_feedback) ─────

  /** Run `action` on the suggestion store; a missing store or a failure is a no-op. */
  private static async withSuggestionStore<T>(
    action: (store: ProactiveSuggestionStore) => Promise<T>,
  ): Promise<T | null> {
    try {
      const store = await getProactiveSuggestionStore();
      return store ? await action(store) : null;
    } catch {
      return null;
    }
  }

  /**
   * Store a new suggestion in the `suggestions` table. Memory settings stay authoritative,
   * as when suggestions were archive rows: nothing is stored when they do not allow it, and
   * the payload text is privacy-redacted first. Returns false when nothing was stored.
   */
  private static async persistSuggestion(
    workspaceId: string,
    id: string,
    payload: Record<string, unknown>,
    createdAt: number,
    expiresAt: number,
  ): Promise<boolean> {
    const prepared = await MemoryService.prepareDerivedRecord(
      workspaceId,
      `${SUGGESTION_MARKER} ${JSON.stringify(payload)}`,
    );
    if (!prepared) return false;
    let stored: Record<string, unknown>;
    try {
      stored = JSON.parse(prepared.content.slice(SUGGESTION_MARKER.length).trim());
    } catch {
      // Redaction broke the JSON (a secret inside a string value spanning quotes); keep it out.
      return false;
    }
    return (
      (await this.withSuggestionStore((store) =>
        store.insert({
          id,
          workspaceId,
          payload: { ...stored, id },
          isPrivate: prepared.isPrivate,
          createdAt,
          expiresAt,
        }),
      )) === true
    );
  }

  private static async persistStatus(
    workspaceId: string,
    suggestionId: string,
    status: StoredSuggestionStatus,
  ): Promise<void> {
    await this.withSuggestionStore((store) => store.setStatus(workspaceId, suggestionId, status));
  }

  /** Decode a stored row through the same payload decoder legacy archive rows used. */
  private static fromStored(row: StoredSuggestion): ProactiveSuggestion | null {
    const parsed = this.parseSuggestion(
      `${SUGGESTION_MARKER} ${JSON.stringify(row.payload)}`,
      row.id,
      row.createdAt,
      row.workspaceId,
    );
    if (!parsed) return null;
    const snoozedUntil = Math.max(parsed.snoozedUntil || 0, row.snoozedUntil || 0);
    return {
      ...parsed,
      expiresAt: row.expiresAt,
      snoozedUntil: snoozedUntil > 0 ? snoozedUntil : undefined,
      dismissed: parsed.dismissed || row.status === "dismissed",
      actedOn: parsed.actedOn || row.status === "acted_on",
    };
  }

  /** Active, unexpired suggestions of one workspace, newest first. */
  private static async readStoredSuggestions(workspaceId: string): Promise<ProactiveSuggestion[]> {
    const rows =
      (await this.withSuggestionStore((store) => store.listActive(workspaceId, 50))) ?? [];
    return rows
      .map((row) => this.fromStored(row))
      .filter((suggestion): suggestion is ProactiveSuggestion => suggestion !== null);
  }

  private static parseSuggestion(
    snippet: string,
    memoryId: string,
    createdAt: number,
    workspaceId?: string,
  ): ProactiveSuggestion | null {
    const idx = snippet.indexOf(SUGGESTION_MARKER);
    if (idx === -1) return null;

    const jsonStr = snippet.slice(idx + SUGGESTION_MARKER.length).trim();
    try {
      const data = JSON.parse(jsonStr);
      const merged = this.mergedSources.get(data.id || memoryId);
      const storedSources = Array.isArray(data.sources)
        ? data.sources.filter((value: unknown): value is string => typeof value === "string")
        : [];
      const storedSignals = Array.isArray(data.sourceSignals)
        ? data.sourceSignals.filter((value: unknown): value is string => typeof value === "string")
        : [];
      const sources = Array.from(new Set([...storedSources, ...(merged?.sources || [])]));
      const sourceSignals = Array.from(new Set([...storedSignals, ...(merged?.evidence || [])]));
      return {
        id: data.id || memoryId,
        type: data.type || "follow_up",
        title: data.title || "",
        description: data.description || "",
        actionPrompt: data.actionPrompt,
        sourceTaskId: data.sourceTaskId,
        sourceEntity: data.sourceEntity,
        confidence: typeof data.confidence === "number" ? data.confidence : 0.5,
        suggestionClass: data.suggestionClass,
        urgency: data.urgency,
        learningSignalIds: Array.isArray(data.learningSignalIds)
          ? data.learningSignalIds.filter(
              (value: unknown): value is string => typeof value === "string",
            )
          : undefined,
        workspaceScope: data.workspaceScope === "all" ? "all" : "single",
        workspaceId,
        sourceSignals: sourceSignals.length > 0 ? sourceSignals : undefined,
        entityKey: typeof data.entityKey === "string" ? data.entityKey : undefined,
        sources: sources.length > 0 ? sources : undefined,
        recommendedDelivery:
          data.recommendedDelivery === "briefing" ||
          data.recommendedDelivery === "inbox" ||
          data.recommendedDelivery === "nudge"
            ? data.recommendedDelivery
            : undefined,
        companionStyle:
          data.companionStyle === "email"
            ? "email"
            : data.companionStyle === "note"
              ? "note"
              : undefined,
        createdAt,
        expiresAt: createdAt + SEVEN_DAYS_MS,
        snoozedUntil: this.snoozedUntil.get(data.id || memoryId),
        dismissed: this.dismissedIds.has(data.id || memoryId),
        actedOn: this.actedOnIds.has(data.id || memoryId),
      };
    } catch {
      return null;
    }
  }

  /** Storage adapter used by the shared SuggestionSink. */
  static sinkStore(): SuggestionSinkStore {
    return {
      listActive: (workspaceId) =>
        this.listActive(workspaceId, { includeDeferred: true, recordSurface: false }),
      create: (workspaceId, input) => this.storeSuggestion(workspaceId, input),
      mergeSources: (_workspaceId, suggestionId, sources, evidence) => {
        this.loadDismissed();
        const current = this.mergedSources.get(suggestionId) || { sources: [], evidence: [] };
        this.mergedSources.delete(suggestionId);
        this.mergedSources.set(suggestionId, {
          sources: Array.from(new Set([...current.sources, ...sources])).slice(0, 12),
          evidence: Array.from(new Set([...current.evidence, ...evidence])).slice(-24),
        });
        this.saveDismissed();
      },
      isEntitySuppressed: (workspaceId, entityKey) => {
        this.loadDismissed();
        const until = this.suppressedEntities.get(`${workspaceId}::${entityKey}`) || 0;
        return until > Date.now();
      },
    };
  }

  /** A dismissed or acted-on suggestion keeps every producer from re-proposing its entity. */
  private static suppressEntity(workspaceId: string, suggestion: ProactiveSuggestion): void {
    const entityKey = normalizeSuggestionEntityKey(suggestion.entityKey, suggestion.title);
    this.suppressedEntities.set(`${workspaceId}::${entityKey}`, Date.now() + ENTITY_SUPPRESSION_MS);
    getSuggestionSink().forget(workspaceId);
  }

  private static pruneExpired(_workspaceId: string): void {
    // Expired suggestions are filtered out on retrieval (expiresAt check),
    // so no explicit cleanup needed. MemoryRetentionService prunes old `suggestions` rows.
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

  private static recordSurface(workspaceId: string, suggestionId: string): void {
    const now = Date.now();
    const lastSurfacedAt = this.surfacedAt.get(suggestionId) || 0;
    if (lastSurfacedAt && now - lastSurfacedAt < SURFACE_COOLDOWN_MS) {
      return;
    }
    this.surfacedAt.set(suggestionId, now);
    this.recordTelemetry(workspaceId, suggestionId, "surfaced", now, false);
    this.saveDismissed();
  }

  private static recordTelemetry(
    workspaceId: string,
    suggestionId: string,
    type: SuggestionTelemetryEventType,
    at = Date.now(),
    save = true,
  ): void {
    this.loadDismissed();
    this.telemetryEvents.push({
      workspaceId,
      suggestionId,
      type,
      at,
      hour: new Date(at).getHours(),
    });
    if (this.telemetryEvents.length > MAX_TELEMETRY_EVENTS) {
      this.telemetryEvents = this.telemetryEvents.slice(-MAX_TELEMETRY_EVENTS);
    }
    if (save) {
      this.saveDismissed();
    }
  }

  private static async findSuggestionById(
    workspaceId: string,
    suggestionId: string,
  ): Promise<ProactiveSuggestion | null> {
    const row = await this.withSuggestionStore((store) => store.get(workspaceId, suggestionId));
    return row && !row.isPrivate ? this.fromStored(row) : null;
  }

  private static getSuggestionFeedbackKey(
    workspaceId: string,
    suggestion: ProactiveSuggestion,
  ): string {
    const titleKey = this.normalizeTitle(
      suggestion.title || suggestion.description || "suggestion",
    );
    return [
      workspaceId,
      suggestion.suggestionClass || suggestion.type || "general",
      suggestion.sourceEntity || suggestion.sourceTaskId || titleKey,
      titleKey,
    ].join("::");
  }

  private static recordSuggestionFeedback(
    workspaceId: string,
    suggestion: ProactiveSuggestion,
    action: "acted_on" | "dismissed" | "snoozed" | "edited" | "ignored",
  ): void {
    const key = this.getSuggestionFeedbackKey(workspaceId, suggestion);
    const current = this.feedbackByKey.get(key) || {
      actedOn: 0,
      dismissed: 0,
      snoozed: 0,
      edited: 0,
      ignored: 0,
      surfaced: 0,
      lastAt: 0,
    };
    current.actedOn ||= 0;
    current.dismissed ||= 0;
    current.snoozed ||= 0;
    current.edited ||= 0;
    current.ignored ||= 0;
    current.surfaced ||= 0;
    if (action === "acted_on") current.actedOn += 1;
    if (action === "dismissed") current.dismissed += 1;
    if (action === "snoozed") current.snoozed += 1;
    if (action === "edited") current.edited += 1;
    if (action === "ignored") current.ignored += 1;
    current.lastAt = Date.now();
    this.feedbackByKey.set(key, current);
  }

  private static captureSuggestionFeedbackMemory(
    workspaceId: string,
    suggestion: ProactiveSuggestion,
    action: "acted_on" | "dismissed" | "snoozed" | "edited" | "ignored",
    editedPrompt?: string,
  ): void {
    // A learning signal in `suggestion_feedback` (no longer an archive memory row), under
    // the same memory settings and privacy redaction an archive capture had. Best-effort.
    const record = {
      action,
      title: suggestion.title,
      suggestionClass: suggestion.suggestionClass || suggestion.type || "general",
      sourceEntity: suggestion.sourceEntity || null,
      actionPrompt: suggestion.actionPrompt || null,
      editedPrompt: editedPrompt || null,
    };
    void (async () => {
      const prepared = await MemoryService.prepareDerivedRecord(
        workspaceId,
        renderSuggestionFeedbackContent(record),
      );
      const fields = prepared ? parseSuggestionFeedbackContent(prepared.content) : null;
      if (!prepared || !fields) return;
      await this.withSuggestionStore((store) =>
        store.insertFeedback({
          id: uuidv4(),
          workspaceId,
          suggestionId: suggestion.id,
          ...fields,
          isPrivate: prepared.isPrivate,
          createdAt: Date.now(),
        }),
      );
    })().catch(() => {
      // best-effort learning signal
    });
  }

  private static getFeedbackAdjustment(
    workspaceId: string,
    suggestion: ProactiveSuggestion,
  ): number {
    const stats = this.feedbackByKey.get(this.getSuggestionFeedbackKey(workspaceId, suggestion));
    if (!stats) return 0;
    const positive = Math.min(0.45, stats.actedOn * 0.15 + (stats.edited || 0) * 0.08);
    const negative = Math.min(
      0.45,
      stats.dismissed * 0.16 + stats.snoozed * 0.1 + (stats.ignored || 0) * 0.08,
    );
    return positive - negative;
  }

  private static maybeRecordIgnoredSuggestion(
    workspaceId: string,
    suggestion: ProactiveSuggestion,
    at: number,
  ): void {
    const surfacedAt = this.surfacedAt.get(suggestion.id) || 0;
    if (!surfacedAt || at - surfacedAt < 24 * 60 * 60 * 1000) return;
    const alreadyRecorded = this.telemetryEvents.some(
      (event) => event.suggestionId === suggestion.id && event.type === "ignored",
    );
    if (alreadyRecorded) return;
    this.recordTelemetry(workspaceId, suggestion.id, "ignored", at, false);
    this.recordSuggestionFeedback(workspaceId, suggestion, "ignored");
    this.captureSuggestionFeedbackMemory(workspaceId, suggestion, "ignored");
    this.saveDismissed();
  }

  private static getTimingAdjustment(
    workspaceId: string,
    suggestion: ProactiveSuggestion,
    now = new Date(),
  ): number {
    const currentHour = now.getHours();
    const workspaceEvents = this.telemetryEvents.filter(
      (event) => event.workspaceId === workspaceId && event.suggestionId !== suggestion.id,
    );
    if (workspaceEvents.length === 0) return 0;

    let score = 0;
    for (const event of workspaceEvents) {
      const distance = Math.min(
        Math.abs(event.hour - currentHour),
        24 - Math.abs(event.hour - currentHour),
      );
      const proximity = Math.max(0, 1 - distance / 6);
      if (event.type === "acted_on") score += 0.35 * proximity;
      if (event.type === "dismissed") score -= 0.2 * proximity;
    }
    return score;
  }

  private static shouldDefer(workspaceId: string, suggestion: ProactiveSuggestion): boolean {
    const workspaceEvents = this.telemetryEvents.filter(
      (event) => event.workspaceId === workspaceId,
    );
    const acted = workspaceEvents.filter((event) => event.type === "acted_on");
    if (acted.length < 3) return false;
    const adjustment = this.getTimingAdjustment(workspaceId, suggestion);
    const ageMs = Date.now() - suggestion.createdAt;
    return adjustment < -0.1 && ageMs < 24 * 60 * 60 * 1000;
  }
}

// The shared SuggestionSink stores suggestions through this service.
setSuggestionSinkStore(() => ProactiveSuggestionsService.sinkStore());
