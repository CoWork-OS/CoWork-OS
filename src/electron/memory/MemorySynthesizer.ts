import { InputSanitizer } from "../agent/security/input-sanitizer";
import { truncateAtFragmentBoundary } from "../agent/content/fragment-truncation";
import { KnowledgeGraphService } from "../knowledge-graph/KnowledgeGraphService";
import { MemoryService } from "./MemoryService";
import { PlaybookService } from "./PlaybookService";
import { RelationshipMemoryService } from "./RelationshipMemoryService";
import { UserProfileService } from "./UserProfileService";
import { buildWorkspaceKitContext } from "./WorkspaceKitContext";
import { DailyLogSummarizer } from "./DailyLogSummarizer";
import { CuratedMemoryService } from "./CuratedMemoryService";
import { MemoryFeaturesManager } from "../settings/memory-features-manager";
import { BoxSettingsManager } from "../settings/box-manager";
import { BOX_BRAIN_IMPORT_HEADER } from "./BoxBrainService";
import { MEMORY_TOOL_ROUTES, buildMemoryToolRoutingHint } from "./memory-tool-routing";
import type { MarkdownMemoryReadGuard } from "./MarkdownMemoryIndexService";
import { MemoryContextBuilderService, type MemoryContextLayers } from "./MemoryContextBuilder";
import { resolveMemoryInjection, type MemoryLayerDecision } from "./MemoryInjectionPolicy";
import { PINNED_CONTEXT_TAGS } from "../agent/pinned-context-blocks";
import {
  MEMORY_CONTEXT_SECTION_TOKENS,
  MEMORY_L0_TOKENS,
  MEMORY_L1_ITEMS_TOKENS,
} from "../agent/content/prompt-budgets";
import type { MemorySearchResult } from "../database/repositories";
import type {
  MemoryLayerPreview,
  MemoryLayerPreviewPayload,
  MemoryWakeUpLayerId,
} from "../../shared/types";

export type MemorySourceKind =
  | "curated_memory"
  | "user_profile"
  | "relationship"
  | "playbook"
  | "memory"
  | "knowledge_graph"
  | "workspace_kit"
  | "daily_summary"
  | "box_brain";

export interface MemoryFragment {
  key: string;
  source: MemorySourceKind;
  text: string;
  relevance: number;
  confidence: number;
  updatedAt: number;
  estimatedTokens: number;
  category?: string;
}

export interface SynthesizedContext {
  text: string;
  totalTokens: number;
  fragmentCount: number;
  sourceAttribution: Record<MemorySourceKind, number>;
  droppedCount: number;
}

export interface SynthesizeOptions {
  tokenBudget?: number;
  includeWorkspaceKit?: boolean;
  includeKnowledgeGraph?: boolean;
  agentRoleId?: string | null;
  filesystemReadGuard?: MarkdownMemoryReadGuard;
  /**
   * Box Brain search results fetched ahead with `prefetchBoxBrainHits`, so the memory
   * search runs asynchronously (off the host with the FTS worker) instead of inside
   * this synchronous build. Without it, Box Brain falls back to the synchronous search.
   */
  boxBrainHits?: MemorySearchResult[];
  /**
   * Names of the tools the model can call this turn. When given, the default
   * wake-up path adds a short memory-tool routing hint that names only these tools.
   */
  visibleToolNames?: Iterable<string>;
  /**
   * Include the hot-memory block (curated workspace items, profile facts, open
   * commitments; all from memory_items). Prompt surfaces pass false: MemoryContextBuilder
   * renders L0 once (the pinned profile block), so hot memory here would repeat it
   * (PROMPT-5).
   */
  includeHotMemory?: boolean;
  /** MemoryContextBuilder's L1 block (memory_items recall), rendered in the L0/L1 slot. */
  memoryItemsContext?: string;
  /**
   * DESIGN.md in the kit slice (default: when the task looks like UI work). The executor
   * passes false because it injects the design system in its own section (PROMPT-11).
   */
  includeDesignSystem?: boolean;
  /**
   * Drop the generated curated auto-blocks of `.cowork/USER.md` / `MEMORY.md` from the kit
   * slice: they are views of memory_items that L0/L1 already carry.
   */
  excludeGeneratedMemoryBlocks?: boolean;
  /** Kit files carried by another section (the pinned shared context), left out here. */
  excludeKitFiles?: readonly string[];
}

export interface HotMemoryOptions {
  /** Include user profile facts (default true). Chat surfaces that pin the profile block pass false. */
  includeUserProfile?: boolean;
  /** Include relationship items (default true). */
  includeRelationships?: boolean;
}

/** Kit files rendered by the pinned shared-context block instead of the kit slice. */
export const SHARED_CONTEXT_KIT_FILES = [
  "PRIORITIES.md",
  "CROSS_SIGNALS.md",
  "MISTAKES.md",
] as const;

export interface LayerPreviewOptions extends SynthesizeOptions {
  /** Workspace read permission (the kit and shared-context layers need it). Default true. */
  workspaceCanRead?: boolean;
  /** Test seam: the builder that renders L0/L1 (default: a fresh MemoryContextBuilderService). */
  contextBuilder?: Pick<MemoryContextBuilderService, "buildLayers">;
}

const LAYER_REASON_TEXT: Record<string, string> = {
  memory_off: "Memory is turned off for this workspace.",
  no_memory_directive: "The request carries <no-memory>.",
  scope_mismatch: "Memory is not retained for this kind of task.",
  group_channel: "Not injected in group or public channels.",
  read_only_denied: "The workspace cannot be read or the context pack is off.",
};

function layerReasonText(decision: MemoryLayerDecision, layer: "l0" | "l1"): string {
  const reason = decision.reasons[layer];
  return (reason && LAYER_REASON_TEXT[reason]) || "Not injected for this workspace.";
}

/** Upper bound for the routing hint added to the default wake-up path. */
const ROUTING_HINT_MAX_TOKENS = 120;

interface LayeredContextResult extends SynthesizedContext {
  layer: MemoryWakeUpLayerId;
  title: string;
  description: string;
  injectedByDefault: boolean;
}

function emptySourceAttribution(): Record<MemorySourceKind, number> {
  return {
    curated_memory: 0,
    user_profile: 0,
    relationship: 0,
    playbook: 0,
    memory: 0,
    knowledge_graph: 0,
    workspace_kit: 0,
    daily_summary: 0,
    box_brain: 0,
  };
}

const DEFAULT_TOKEN_BUDGET = 2800;
const CHARS_PER_TOKEN = 4;
const RECENCY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
const SCORE_WEIGHTS = {
  relevance: 0.45,
  confidence: 0.3,
  recency: 0.25,
} as const;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function fingerprint(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 160);
}

function recencyScore(updatedAt: number, now: number): number {
  const age = Math.max(0, now - updatedAt);
  return Math.exp((-Math.LN2 * age) / RECENCY_HALF_LIFE_MS);
}

function compositeScore(f: MemoryFragment, now: number): number {
  return (
    SCORE_WEIGHTS.relevance * f.relevance +
    SCORE_WEIGHTS.confidence * f.confidence +
    SCORE_WEIGHTS.recency * recencyScore(f.updatedAt, now)
  );
}

function fitToBudget(text: string, tokenBudget: number, marker: string): string {
  if (!text || estimateTokens(text) <= tokenBudget) return text;
  return truncateAtFragmentBoundary(text, tokenBudget, marker);
}

function sanitize(text: string): string {
  return InputSanitizer.sanitizeMemoryContent(text).trim();
}

function extractBulletLines(raw: string | null | undefined): string[] {
  if (typeof raw !== "string" || !raw.trim()) {
    return [];
  }
  return raw.split("\n").filter((line) => line.startsWith("- "));
}

function categoryLabel(cat: string): string {
  const labels: Record<string, string> = {
    identity: "Identity",
    preference: "Preference",
    bio: "Profile",
    work: "Work",
    goal: "Goal",
    operating: "Operating style",
    voice: "Voice",
    accountability: "Accountability",
    constraint: "Constraint",
    other: "Note",
  };
  return labels[cat] || "Note";
}

function isOperatingManualCategory(category?: string): boolean {
  return category === "operating" || category === "voice" || category === "accountability";
}

function isReviewedOperatingManualFact(fact: {
  category?: string;
  confidence?: number;
  source?: string;
  pinned?: boolean;
}): boolean {
  if (!isOperatingManualCategory(fact.category)) return true;
  return fact.pinned === true || fact.source === "manual" || (fact.confidence ?? 0) >= 0.85;
}

async function extractCuratedFragments(workspaceId: string): Promise<MemoryFragment[]> {
  try {
    return (await CuratedMemoryService.getPromptEntries(workspaceId, 10)).map((entry) => ({
      key: fingerprint(`curated:${entry.target}:${entry.kind}:${entry.content}`),
      source: "curated_memory" as const,
      text: `[${entry.target}/${entry.kind}] ${entry.content}`,
      relevance: entry.target === "user" ? 0.93 : 0.9,
      confidence: entry.confidence,
      updatedAt: entry.updatedAt,
      estimatedTokens: estimateTokens(entry.content) + 4,
      category: entry.kind,
    }));
  } catch {
    return [];
  }
}

function extractUserProfileFragments(): MemoryFragment[] {
  try {
    const profile = UserProfileService.getProfile();
    if (!profile.facts.length) return [];
    return profile.facts
      .filter((fact) => isReviewedOperatingManualFact(fact))
      .map((fact) => ({
        key: fingerprint(`profile:${fact.category}:${fact.value}`),
        source: "user_profile" as const,
        text: `[${categoryLabel(fact.category)}] ${fact.value}`,
        relevance: isOperatingManualCategory(fact.category) ? 0.86 : 0.72,
        confidence: fact.confidence,
        updatedAt: fact.lastUpdatedAt,
        estimatedTokens: estimateTokens(fact.value) + 3,
        category: fact.category,
      }));
  } catch {
    return [];
  }
}

/** The user's own open commitments (not third-party ones from mail). */
function extractRelationshipFragments(): MemoryFragment[] {
  try {
    return RelationshipMemoryService.listOpenCommitments(16)
      // Mailbox-sourced items are sender-controlled text, not facts about the user.
      .filter((item) => !RelationshipMemoryService.isThirdPartyItem(item))
      .map((item) => ({
        key: fingerprint(`relationship:${item.layer}:${item.text}`),
        source: "relationship" as const,
        text: `[${item.layer}] ${item.text}`,
        relevance: 0.88,
        confidence: item.confidence,
        updatedAt: item.updatedAt,
        estimatedTokens: estimateTokens(item.text) + 3,
        category: item.layer,
      }));
  } catch {
    return [];
  }
}

async function extractPlaybookFragments(
  workspaceId: string,
  taskPrompt: string,
): Promise<MemoryFragment[]> {
  try {
    const raw = await PlaybookService.getPlaybookForContext(workspaceId, taskPrompt, 5);
    return extractBulletLines(raw).map((line) => {
      const text = line.replace(/^-\s*/, "");
      return {
        key: fingerprint(`playbook:${text}`),
        source: "playbook" as const,
        text: `[Playbook] ${text}`,
        relevance: 0.77,
        confidence: 0.85,
        updatedAt: Date.now() - 7 * 24 * 60 * 60 * 1000,
        estimatedTokens: estimateTokens(text) + 3,
        category: "playbook",
      };
    });
  } catch {
    return [];
  }
}

async function extractArchiveFragments(
  workspaceId: string,
  taskPrompt: string,
): Promise<MemoryFragment[]> {
  try {
    const recent = (await MemoryService.getRecentForPromptRecall(workspaceId, 4)).map((memory) => ({
      key: fingerprint(`archive:${memory.id}`),
      source: "memory" as const,
      text: `[${memory.type}] ${memory.summary || memory.content.slice(0, 180)}`,
      relevance: 0.5,
      confidence: 0.62,
      updatedAt: memory.updatedAt,
      estimatedTokens: estimateTokens(memory.summary || memory.content.slice(0, 180)) + 2,
      category: memory.type,
    }));
    return recent;
  } catch {
    return [];
  }
}

function isBoxBrainRecallEnabled(taskPrompt: string): boolean {
  const settings = BoxSettingsManager.loadSettings();
  return settings.enabled && settings.brain?.enabled === true && Boolean(taskPrompt.trim());
}

const BOX_BRAIN_QUERY_CHARS = 2500;
const BOX_BRAIN_RESULT_LIMIT = 8;

async function extractBoxBrainFragments(
  workspaceId: string,
  taskPrompt: string,
  prefetched?: MemorySearchResult[],
): Promise<MemoryFragment[]> {
  try {
    if (!isBoxBrainRecallEnabled(taskPrompt)) return [];

    // MemoryService.search intentionally includes private local memories and
    // imported-global memories. Box Brain entries are marked as imported so a
    // single selected workspace can still serve company-wide recall without
    // mirroring document bodies to an external memory provider.
    const hits =
      prefetched ??
      (await MemoryService.search(
        workspaceId,
        taskPrompt.slice(0, BOX_BRAIN_QUERY_CHARS),
        BOX_BRAIN_RESULT_LIMIT,
      ));
    return hits
      .filter((result) => result.snippet.trimStart().startsWith(BOX_BRAIN_IMPORT_HEADER))
      .map((result) => ({
        key: fingerprint(`box-brain:${result.id}`),
        source: "box_brain" as const,
        text: `[Box Brain] ${result.snippet}`,
        relevance: Math.min(0.98, 0.72 + result.relevanceScore * 0.2),
        confidence: 0.82,
        updatedAt: result.createdAt,
        estimatedTokens: estimateTokens(result.snippet) + 4,
        category: "box_brain",
      }));
  } catch {
    return [];
  }
}

async function extractKnowledgeGraphFragments(
  workspaceId: string,
  taskPrompt: string,
): Promise<MemoryFragment[]> {
  try {
    return extractBulletLines(
      await KnowledgeGraphService.buildContextForTask(workspaceId, taskPrompt),
    ).map((line) => {
      const text = line.replace(/^-\s*/, "");
      return {
        key: fingerprint(`kg:${text}`),
        source: "knowledge_graph" as const,
        text: `[KG] ${text}`,
        relevance: 0.6,
        confidence: 0.84,
        updatedAt: Date.now(),
        estimatedTokens: estimateTokens(text) + 3,
        category: "knowledge_graph",
      };
    });
  } catch {
    return [];
  }
}

function extractDailySummaryFragments(
  workspacePath: string,
  taskPrompt: string,
  readGuard?: MarkdownMemoryReadGuard,
): MemoryFragment[] {
  try {
    return DailyLogSummarizer.getRecentSummaryFragments(
      workspacePath,
      taskPrompt,
      5,
      readGuard,
    ).map((fragment) => ({
      ...fragment,
      source: "daily_summary" as const,
    }));
  } catch {
    return [];
  }
}

function dedupeAndRank(fragments: MemoryFragment[], now: number): MemoryFragment[] {
  const deduped = new Map<string, MemoryFragment>();
  for (const fragment of fragments) {
    const existing = deduped.get(fragment.key);
    if (
      !existing ||
      fragment.confidence > existing.confidence ||
      (fragment.confidence === existing.confidence && fragment.updatedAt > existing.updatedAt)
    ) {
      deduped.set(fragment.key, fragment);
    }
  }
  return [...deduped.values()].sort((a, b) => compositeScore(b, now) - compositeScore(a, now));
}

function selectFragments(
  fragments: MemoryFragment[],
  tokenBudget: number,
): { selected: MemoryFragment[]; droppedCount: number } {
  const selected: MemoryFragment[] = [];
  let used = 0;
  let dropped = 0;
  for (const fragment of fragments) {
    if (used + fragment.estimatedTokens > tokenBudget) {
      dropped += 1;
      continue;
    }
    selected.push(fragment);
    used += fragment.estimatedTokens;
  }
  return { selected, droppedCount: dropped };
}

function groupBySource(fragments: MemoryFragment[]): Record<MemorySourceKind, MemoryFragment[]> {
  const grouped: Record<MemorySourceKind, MemoryFragment[]> = {
    curated_memory: [],
    user_profile: [],
    relationship: [],
    playbook: [],
    memory: [],
    knowledge_graph: [],
    workspace_kit: [],
    daily_summary: [],
    box_brain: [],
  };
  for (const fragment of fragments) {
    grouped[fragment.source].push(fragment);
  }
  return grouped;
}

/**
 * The builder's L1 block in the slot the hot-memory block used to fill. Already sanitized,
 * deduplicated and budgeted by MemoryContextBuilder; only clamped to the slot here.
 */
function memoryItemsSlice(text: string | undefined, tokenBudget: number): SynthesizedContext {
  const clamped = fitToBudget((text ?? "").trim(), tokenBudget, "[... memory truncated]");
  return {
    text: clamped,
    totalTokens: estimateTokens(clamped),
    fragmentCount: clamped ? clamped.split("\n").filter((line) => line.startsWith("- ")).length : 0,
    sourceAttribution: emptySourceAttribution(),
    droppedCount: 0,
  };
}

export class MemorySynthesizer {
  static async buildHotMemoryContext(
    workspaceId: string,
    tokenBudget = 900,
    options: HotMemoryOptions = {},
  ): Promise<SynthesizedContext> {
    const now = Date.now();
    const fragments = dedupeAndRank(
      [
        ...(await extractCuratedFragments(workspaceId)),
        ...(options.includeUserProfile === false ? [] : extractUserProfileFragments()),
        ...(options.includeRelationships === false ? [] : extractRelationshipFragments()),
      ],
      now,
    );
    const { selected, droppedCount } = selectFragments(fragments, tokenBudget);
    const grouped = groupBySource(selected);
    const parts: string[] = [];

    if (grouped.curated_memory.length) {
      parts.push("## Curated Hot Memory");
      for (const fragment of grouped.curated_memory) {
        parts.push(`- ${sanitize(fragment.text)}`);
      }
    }
    const operatingManual = grouped.user_profile.filter((fragment) =>
      isOperatingManualCategory(fragment.category),
    );
    const otherUserProfile = grouped.user_profile.filter(
      (fragment) => !isOperatingManualCategory(fragment.category),
    );

    if (operatingManual.length) {
      parts.push("\n## Personal Operating Manual");
      for (const fragment of operatingManual) {
        parts.push(`- ${sanitize(fragment.text)}`);
      }
    }

    if (otherUserProfile.length || grouped.relationship.length) {
      parts.push("\n## You & the User");
      for (const fragment of [...otherUserProfile, ...grouped.relationship]) {
        parts.push(`- ${sanitize(fragment.text)}`);
      }
    }

    const sourceAttribution: Record<MemorySourceKind, number> = {
      curated_memory: grouped.curated_memory.length,
      user_profile: grouped.user_profile.length,
      relationship: grouped.relationship.length,
      playbook: 0,
      memory: 0,
      knowledge_graph: 0,
      workspace_kit: 0,
      daily_summary: 0,
      box_brain: grouped.box_brain.length,
    };

    const text = parts.length
      ? `<cowork_hot_memory>\n${parts.join("\n")}\n</cowork_hot_memory>`
      : "";
    return {
      text,
      totalTokens: estimateTokens(text),
      fragmentCount: selected.length,
      sourceAttribution,
      droppedCount,
    };
  }

  static async buildStructuredMemoryContext(
    workspaceId: string,
    workspacePath: string,
    taskPrompt: string,
    options: {
      includeKnowledgeGraph?: boolean;
      includeArchive?: boolean;
      tokenBudget?: number;
      filesystemReadGuard?: MarkdownMemoryReadGuard;
      boxBrainHits?: MemorySearchResult[];
    } = {},
  ): Promise<SynthesizedContext> {
    const now = Date.now();
    const fragments = [
      ...(await extractPlaybookFragments(workspaceId, taskPrompt)),
      ...extractDailySummaryFragments(workspacePath, taskPrompt, options.filesystemReadGuard),
      ...(await extractBoxBrainFragments(workspaceId, taskPrompt, options.boxBrainHits)),
    ];
    if (options.includeKnowledgeGraph !== false) {
      fragments.push(...(await extractKnowledgeGraphFragments(workspaceId, taskPrompt)));
    }
    if (options.includeArchive) {
      fragments.push(...(await extractArchiveFragments(workspaceId, taskPrompt)));
    }
    const ranked = dedupeAndRank(fragments, now);
    const { selected, droppedCount } = selectFragments(ranked, options.tokenBudget ?? 1000);
    const grouped = groupBySource(selected);
    const parts: string[] = [];

    if (grouped.playbook.length) {
      parts.push("## Past Task Patterns");
      for (const fragment of grouped.playbook) {
        parts.push(`- ${sanitize(fragment.text)}`);
      }
    }
    if (grouped.knowledge_graph.length) {
      parts.push("\n## Known Entities");
      for (const fragment of grouped.knowledge_graph) {
        parts.push(`- ${sanitize(fragment.text)}`);
      }
    }
    if (grouped.daily_summary.length) {
      parts.push("\n## Recent Summaries");
      for (const fragment of grouped.daily_summary) {
        parts.push(sanitize(fragment.text));
      }
    }
    if (grouped.memory.length) {
      parts.push("\n## Archived Recall");
      for (const fragment of grouped.memory) {
        parts.push(`- ${sanitize(fragment.text)}`);
      }
    }
    if (grouped.box_brain.length) {
      parts.push("\n## Box Brain (source-backed)");
      for (const fragment of grouped.box_brain) {
        parts.push(`- ${sanitize(fragment.text)}`);
      }
    }

    const sourceAttribution: Record<MemorySourceKind, number> = {
      curated_memory: 0,
      user_profile: 0,
      relationship: 0,
      playbook: grouped.playbook.length,
      memory: grouped.memory.length,
      knowledge_graph: grouped.knowledge_graph.length,
      workspace_kit: 0,
      daily_summary: grouped.daily_summary.length,
      box_brain: grouped.box_brain.length,
    };

    const text = parts.length
      ? `<cowork_structured_memory>\n${parts.join("\n")}\n</cowork_structured_memory>`
      : "";
    return {
      text,
      totalTokens: estimateTokens(text),
      fragmentCount: selected.length,
      sourceAttribution,
      droppedCount,
    };
  }

  /**
   * Compact memory-tool routing hint for the default wake-up path (at most
   * ROUTING_HINT_MAX_TOKENS): the four memory tools (audit §8.3) and when to use each.
   * Only tools in `visibleToolNames` are named, so the hint never points at a tool the
   * model cannot call.
   */
  static buildMemoryRoutingHint(visibleToolNames: Iterable<string>): string {
    return fitToBudget(buildMemoryToolRoutingHint(visibleToolNames), ROUTING_HINT_MAX_TOKENS, "");
  }

  /**
   * The same hint for callers without the visible tool list (the legacy synthesis path):
   * the memory tools are always exposed unless a policy removes them.
   */
  static buildRecallHintsContext(): string {
    return this.buildMemoryRoutingHint(MEMORY_TOOL_ROUTES.map(([tool]) => tool));
  }

  private static async buildWakeUpLayers(
    workspaceId: string,
    workspacePath: string,
    taskPrompt: string,
    options: SynthesizeOptions,
    settings: ReturnType<typeof MemoryFeaturesManager.loadSettings>,
  ): Promise<{
    l0: LayeredContextResult;
    l1: LayeredContextResult;
    recallHints: string;
    routingHint: string;
  }> {
    const fullBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    const routingHint = options.visibleToolNames
      ? this.buildMemoryRoutingHint(options.visibleToolNames)
      : "";
    // The routing hint is part of the requested budget, not on top of it.
    const budget = Math.max(320, fullBudget - estimateTokens(routingHint));
    const includeWorkspaceKit = options.includeWorkspaceKit !== false;
    const kitBudget = includeWorkspaceKit ? Math.floor(budget * 0.3) : 0;
    const remainingBudget = Math.max(320, budget - kitBudget);
    const l0Budget = Math.floor(remainingBudget * 0.55);
    const l1Budget = remainingBudget - l0Budget;

    const identity =
      options.includeHotMemory === false
        ? memoryItemsSlice(options.memoryItemsContext, l0Budget)
        : settings.curatedMemoryEnabled === false
          ? {
              text: "",
              totalTokens: 0,
              fragmentCount: 0,
              sourceAttribution: emptySourceAttribution(),
              droppedCount: 0,
            }
          : await this.buildHotMemoryContext(workspaceId, l0Budget);
    let kitText = "";
    if (includeWorkspaceKit) {
      try {
        // Repo-level project instructions and docs maps have their own prompt
        // section; this slice carries the `.cowork` kit, memory files first.
        const rawKit = buildWorkspaceKitContext(workspacePath, taskPrompt, new Date(), {
          agentRoleId: options.agentRoleId ?? null,
          readGuard: options.filesystemReadGuard,
          includeProjectGuidance: false,
          includeDesignSystem: options.includeDesignSystem,
          excludeGeneratedMemoryBlocks: options.excludeGeneratedMemoryBlocks,
          excludeFiles: options.excludeKitFiles,
        });
        if (rawKit) {
          kitText = fitToBudget(rawKit, kitBudget, "[... workspace context truncated]");
        }
      } catch {
        kitText = "";
      }
    }

    const l0Text = [kitText, identity.text].filter(Boolean).join("\n\n");
    const l0: LayeredContextResult = {
      ...identity,
      text: l0Text,
      totalTokens: estimateTokens(l0Text),
      fragmentCount: identity.fragmentCount + (kitText ? 1 : 0),
      sourceAttribution: {
        ...identity.sourceAttribution,
        workspace_kit: kitText ? 1 : 0,
      },
      layer: "L0",
      title: "L0 Identity",
      description: "Curated identity, user/workspace essentials, and stable rules.",
      injectedByDefault: true,
    };

    const story = await this.buildStructuredMemoryContext(workspaceId, workspacePath, taskPrompt, {
      includeKnowledgeGraph: false,
      includeArchive: false,
      tokenBudget: l1Budget,
      filesystemReadGuard: options.filesystemReadGuard,
      boxBrainHits: options.boxBrainHits,
    });
    const l1: LayeredContextResult = {
      ...story,
      layer: "L1",
      title: "L1 Essential Story",
      description: "Durable decisions, recent summaries, and active commitments.",
      injectedByDefault: true,
    };

    return {
      l0,
      l1,
      recallHints: this.buildRecallHintsContext(),
      routingHint,
    };
  }

  /**
   * Memory Hub preview: what a private task in this workspace would receive, built the way
   * the executor builds a plan step. MemoryInjectionPolicy decides the layers (private
   * gateway, this workspace's memory settings); MemoryContextBuilder renders L0 (the pinned
   * profile block) and L1 (memory_items recall for the prompt) from memory_items; the
   * synthesizer adds the kit slice,
   * playbook and summaries around L1, as in the `memory_context` section.
   */
  static async buildLayerPreview(
    workspaceId: string,
    workspacePath: string,
    taskPrompt: string,
    options: LayerPreviewOptions = {},
  ): Promise<MemoryLayerPreviewPayload> {
    const settings = MemoryFeaturesManager.loadSettings();
    const effectivePrompt = taskPrompt.trim() || "Current workspace memory preview";
    const { workspaceCanRead, contextBuilder, ...synthesizeOptions } = options;

    let workspaceSettings: {
      enabled: boolean;
      privacyMode?: "normal" | "strict" | "disabled";
    } | null = null;
    try {
      const stored = await MemoryService.getSettings(workspaceId);
      workspaceSettings = stored
        ? { enabled: stored.enabled !== false, privacyMode: stored.privacyMode }
        : null;
    } catch {
      workspaceSettings = null;
    }
    const decision = resolveMemoryInjection({
      gatewayContext: "private",
      workspaceSettings,
      curatedMemoryEnabled: settings.curatedMemoryEnabled !== false,
      contextPackInjectionEnabled: !!settings.contextPackInjectionEnabled,
      workspaceCanRead: workspaceCanRead !== false,
      // External providers are a network call; the preview shows local memory only.
      externalNetworkAllowed: false,
    });

    let layers: MemoryContextLayers = { l0: null, l1: null, source: "none" };
    if (decision.memory) {
      try {
        layers = await (contextBuilder ?? new MemoryContextBuilderService()).buildLayers({
          workspaceId,
          decision,
          focus: effectivePrompt,
          include: { l0: true, l1: true },
          budgets: { l0Tokens: MEMORY_L0_TOKENS, l1Tokens: MEMORY_L1_ITEMS_TOKENS },
        });
      } catch {
        layers = { l0: null, l1: null, source: "none" };
      }
    }

    const l0Text = layers.l0
      ? [
          PINNED_CONTEXT_TAGS.userProfile.open,
          layers.l0.text,
          PINNED_CONTEXT_TAGS.userProfile.close,
        ].join("\n")
      : "";
    const l1ItemsText = layers.l1
      ? `<cowork_relevant_memory>\n${layers.l1.text}\n</cowork_relevant_memory>`
      : "";

    const contextBudget = synthesizeOptions.tokenBudget ?? MEMORY_CONTEXT_SECTION_TOKENS;
    let memoryContext: SynthesizedContext = {
      text: "",
      totalTokens: 0,
      fragmentCount: 0,
      sourceAttribution: emptySourceAttribution(),
      droppedCount: 0,
    };
    if (decision.layers.l1 || decision.layers.workspaceKit) {
      memoryContext = await this.synthesize(workspaceId, workspacePath, effectivePrompt, {
        ...synthesizeOptions,
        tokenBudget: contextBudget,
        includeWorkspaceKit:
          synthesizeOptions.includeWorkspaceKit !== false && decision.layers.workspaceKit,
        includeHotMemory: false,
        memoryItemsContext: l1ItemsText,
        includeDesignSystem: false,
        excludeGeneratedMemoryBlocks: true,
        excludeKitFiles: decision.layers.sharedContext ? SHARED_CONTEXT_KIT_FILES : [],
        includeKnowledgeGraph: synthesizeOptions.includeKnowledgeGraph !== false,
      });
    }

    const sourceNote =
      layers.source === "none" ? " Memory is not available yet (the memory engine is not running)." : "";
    const recallHints = this.buildRecallHintsContext();
    const l2Description =
      settings.topicMemoryEnabled !== false
        ? "Excluded from default injection. `memory_recall` (scope knowledge) returns matching topic packs when the task needs them."
        : "Topic packs are currently disabled.";
    const l3Description =
      'Excluded from default injection. Use `memory_recall` (index, then detail "full") when exact recall is needed.';

    const previewLayers: MemoryLayerPreview[] = [
      {
        layer: "L0",
        title: "L0 Pinned profile",
        description:
          "Identity, rules, pinned and user-stated preferences, open commitments and curated facts from memory_items, pinned to every turn of a private task." +
          sourceNote,
        includedText: l0Text,
        ...(l0Text
          ? {}
          : {
              excludedText: decision.layers.l0
                ? "Nothing to pin yet."
                : layerReasonText(decision, "l0"),
            }),
        budget: {
          usedTokens: estimateTokens(l0Text),
          budgetTokens: MEMORY_L0_TOKENS,
          excludedCount: layers.l0?.truncated ? 1 : 0,
        },
        injectedByDefault: true,
      },
      {
        layer: "L1",
        title: "L1 Memory context",
        description:
          "memory_items recall for the request, with the .cowork kit slice, past task patterns and recent summaries (the plan step's memory section)." +
          sourceNote,
        includedText: memoryContext.text,
        ...(memoryContext.text
          ? {}
          : {
              excludedText: decision.layers.l1
                ? "Nothing relevant to this request yet."
                : layerReasonText(decision, "l1"),
            }),
        budget: {
          usedTokens: memoryContext.totalTokens,
          budgetTokens: Math.max(memoryContext.totalTokens, contextBudget),
          excludedCount: memoryContext.droppedCount,
        },
        injectedByDefault: true,
      },
      {
        layer: "L2",
        title: "L2 Topic Packs",
        description: "Topic-focused packs built from layered memory files.",
        includedText: "",
        excludedText: l2Description,
        budget: {
          usedTokens: 0,
          budgetTokens: 0,
          excludedCount: 0,
        },
        injectedByDefault: false,
      },
      {
        layer: "L3",
        title: "L3 Deep Recall",
        description:
          "On-demand recall across memory, the archive, past conversations and workspace knowledge.",
        includedText: recallHints,
        excludedText: l3Description,
        budget: {
          usedTokens: estimateTokens(recallHints),
          budgetTokens: 0,
          excludedCount: 0,
        },
        injectedByDefault: false,
      },
    ];

    return {
      workspaceId,
      taskPrompt: effectivePrompt,
      generatedAt: Date.now(),
      injectedLayerIds: ["L0", "L1"],
      excludedLayerIds: ["L2", "L3"],
      layers: previewLayers,
    };
  }

  /**
   * The Box Brain memory search for `synthesize`, run asynchronously; pass the result
   * as `boxBrainHits`. Resolves to an empty list when Box Brain recall is off.
   */
  static async prefetchBoxBrainHits(
    workspaceId: string,
    taskPrompt: string,
  ): Promise<MemorySearchResult[]> {
    if (!isBoxBrainRecallEnabled(taskPrompt)) return [];
    return MemoryService.searchAsync(
      workspaceId,
      taskPrompt.slice(0, BOX_BRAIN_QUERY_CHARS),
      BOX_BRAIN_RESULT_LIMIT,
    );
  }

  static async synthesize(
    workspaceId: string,
    workspacePath: string,
    taskPrompt: string,
    options: SynthesizeOptions = {},
  ): Promise<SynthesizedContext> {
    const settings = MemoryFeaturesManager.loadSettings();
    if (settings.wakeUpLayersEnabled !== false) {
      const layered = await this.buildWakeUpLayers(
        workspaceId,
        workspacePath,
        taskPrompt,
        options,
        settings,
      );
      const budget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
      const finalParts = [layered.l0.text, layered.l1.text, layered.routingHint].filter(Boolean);
      // Fragment budgets ignore headers and wrappers; keep the whole block within
      // the requested budget so the prompt section cap never cuts it again.
      const finalText = fitToBudget(
        finalParts.join("\n\n"),
        budget,
        "[... memory truncated for budget]",
      );
      return {
        text: finalText,
        totalTokens: estimateTokens(finalText),
        fragmentCount: layered.l0.fragmentCount + layered.l1.fragmentCount,
        sourceAttribution: {
          curated_memory: layered.l0.sourceAttribution.curated_memory,
          user_profile: layered.l0.sourceAttribution.user_profile,
          relationship: layered.l0.sourceAttribution.relationship,
          playbook: layered.l1.sourceAttribution.playbook,
          memory: 0,
          knowledge_graph: 0,
          workspace_kit: layered.l0.sourceAttribution.workspace_kit,
          daily_summary: layered.l1.sourceAttribution.daily_summary,
          box_brain: layered.l1.sourceAttribution.box_brain,
        },
        droppedCount: layered.l0.droppedCount + layered.l1.droppedCount,
      };
    }

    const budget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    const kitBudget = options.includeWorkspaceKit !== false ? Math.floor(budget * 0.35) : 0;
    const remainingBudget = Math.max(400, budget - kitBudget);
    const hotBudget = Math.floor(remainingBudget * 0.5);
    const structuredBudget = remainingBudget - hotBudget;

    const hot =
      options.includeHotMemory === false
        ? memoryItemsSlice(options.memoryItemsContext, hotBudget)
        : settings.curatedMemoryEnabled === false
          ? {
              text: "",
              totalTokens: 0,
              fragmentCount: 0,
              sourceAttribution: emptySourceAttribution(),
              droppedCount: 0,
            }
          : await this.buildHotMemoryContext(workspaceId, hotBudget);
    const structured = await this.buildStructuredMemoryContext(
      workspaceId,
      workspacePath,
      taskPrompt,
      {
        includeKnowledgeGraph: options.includeKnowledgeGraph !== false,
        includeArchive: settings.defaultArchiveInjectionEnabled === true,
        tokenBudget: structuredBudget,
        filesystemReadGuard: options.filesystemReadGuard,
        boxBrainHits: options.boxBrainHits,
      },
    );

    let kitText = "";
    if (options.includeWorkspaceKit !== false) {
      try {
        // Repo-level project instructions and docs maps have their own prompt
        // section; this slice carries the `.cowork` kit, memory files first.
        const rawKit = buildWorkspaceKitContext(workspacePath, taskPrompt, new Date(), {
          agentRoleId: options.agentRoleId ?? null,
          readGuard: options.filesystemReadGuard,
          includeProjectGuidance: false,
          includeDesignSystem: options.includeDesignSystem,
          excludeGeneratedMemoryBlocks: options.excludeGeneratedMemoryBlocks,
          excludeFiles: options.excludeKitFiles,
        });
        if (rawKit) {
          kitText = fitToBudget(rawKit, kitBudget, "[... workspace context truncated]");
        }
      } catch {
        kitText = "";
      }
    }

    const recallHints = this.buildRecallHintsContext();
    const finalParts = [kitText, hot.text, structured.text, recallHints].filter(Boolean);
    const finalText = fitToBudget(
      finalParts.join("\n\n"),
      budget,
      "[... memory truncated for budget]",
    );
    const sourceAttribution: Record<MemorySourceKind, number> = {
      curated_memory: hot.sourceAttribution.curated_memory,
      user_profile: hot.sourceAttribution.user_profile,
      relationship: hot.sourceAttribution.relationship,
      playbook: structured.sourceAttribution.playbook,
      memory: structured.sourceAttribution.memory,
      knowledge_graph: structured.sourceAttribution.knowledge_graph,
      workspace_kit: kitText ? 1 : 0,
      daily_summary: structured.sourceAttribution.daily_summary,
      box_brain: structured.sourceAttribution.box_brain,
    };

    return {
      text: finalText,
      totalTokens: estimateTokens(finalText),
      fragmentCount: hot.fragmentCount + structured.fragmentCount + (kitText ? 1 : 0),
      sourceAttribution,
      droppedCount: hot.droppedCount + structured.droppedCount,
    };
  }
}
