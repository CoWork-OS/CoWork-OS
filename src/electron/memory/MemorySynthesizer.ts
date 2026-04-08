import { InputSanitizer } from "../agent/security/input-sanitizer";
import { KnowledgeGraphService } from "../knowledge-graph/KnowledgeGraphService";
import { MemoryService } from "./MemoryService";
import { PlaybookService } from "./PlaybookService";
import { RelationshipMemoryService } from "./RelationshipMemoryService";
import { UserProfileService } from "./UserProfileService";
import { buildWorkspaceKitContext } from "./WorkspaceKitContext";
import { DailyLogSummarizer } from "./DailyLogSummarizer";
import { CuratedMemoryService } from "./CuratedMemoryService";
import { MemoryFeaturesManager } from "../settings/memory-features-manager";
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
  | "daily_summary";

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
}

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
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
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

function sanitize(text: string): string {
  return InputSanitizer.sanitizeMemoryContent(text).trim();
}

function extractBulletLines(raw: string | null | undefined): string[] {
  if (typeof raw !== "string" || !raw.trim()) {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.startsWith("- "));
}

function categoryLabel(cat: string): string {
  const labels: Record<string, string> = {
    identity: "Identity",
    preference: "Preference",
    bio: "Profile",
    work: "Work",
    goal: "Goal",
    constraint: "Constraint",
    other: "Note",
  };
  return labels[cat] || "Note";
}

function extractCuratedFragments(workspaceId: string): MemoryFragment[] {
  try {
    return CuratedMemoryService.getPromptEntries(workspaceId, 10).map((entry) => ({
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
    return profile.facts.map((fact) => ({
      key: fingerprint(`profile:${fact.category}:${fact.value}`),
      source: "user_profile" as const,
      text: `[${categoryLabel(fact.category)}] ${fact.value}`,
      relevance: 0.72,
      confidence: fact.confidence,
      updatedAt: fact.lastUpdatedAt,
      estimatedTokens: estimateTokens(fact.value) + 3,
      category: fact.category,
    }));
  } catch {
    return [];
  }
}

function extractRelationshipFragments(): MemoryFragment[] {
  try {
    return RelationshipMemoryService.listItems({ includeDone: false, limit: 16 }).map((item) => ({
      key: fingerprint(`relationship:${item.layer}:${item.text}`),
      source: "relationship" as const,
      text: `[${item.layer}] ${item.text}`,
      relevance: item.layer === "commitments" ? 0.88 : item.layer === "preferences" ? 0.8 : 0.62,
      confidence: item.confidence,
      updatedAt: item.updatedAt,
      estimatedTokens: estimateTokens(item.text) + 3,
      category: item.layer,
    }));
  } catch {
    return [];
  }
}

function extractPlaybookFragments(workspaceId: string, taskPrompt: string): MemoryFragment[] {
  try {
    const raw = PlaybookService.getPlaybookForContext(workspaceId, taskPrompt, 5);
    return extractBulletLines(raw)
      .map((line) => {
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

function extractArchiveFragments(workspaceId: string, taskPrompt: string): MemoryFragment[] {
  try {
    const recent = MemoryService.getRecentForPromptRecall(workspaceId, 4).map((memory) => ({
      key: fingerprint(`archive:${memory.id}`),
      source: "memory" as const,
      text: `[${memory.type}] ${memory.summary || memory.content.slice(0, 180)}`,
      relevance: 0.5,
      confidence: 0.62,
      updatedAt: memory.updatedAt,
      estimatedTokens: estimateTokens(memory.summary || memory.content.slice(0, 180)) + 2,
      category: memory.type,
    }));
    const relevant = MemoryService.searchForPromptRecall(workspaceId, taskPrompt.slice(0, 2500), 5).map(
      (result) => ({
        key: fingerprint(`archive:${result.id}`),
        source: "memory" as const,
        text: `[${result.type}] ${result.snippet}`,
        relevance: 0.6,
        confidence: 0.68,
        updatedAt: result.createdAt,
        estimatedTokens: estimateTokens(result.snippet) + 2,
        category: result.type,
      }),
    );
    return [...recent, ...relevant];
  } catch {
    return [];
  }
}

function extractKnowledgeGraphFragments(workspaceId: string, taskPrompt: string): MemoryFragment[] {
  try {
    return extractBulletLines(KnowledgeGraphService.buildContextForTask(workspaceId, taskPrompt))
      .map((line) => {
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

function extractDailySummaryFragments(workspacePath: string, taskPrompt: string): MemoryFragment[] {
  try {
    return DailyLogSummarizer.getRecentSummaryFragments(workspacePath, taskPrompt, 5).map((fragment) => ({
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
  };
  for (const fragment of fragments) {
    grouped[fragment.source].push(fragment);
  }
  return grouped;
}

export class MemorySynthesizer {
  static buildHotMemoryContext(workspaceId: string, tokenBudget = 900): SynthesizedContext {
    const now = Date.now();
    const fragments = dedupeAndRank(
      [
        ...extractCuratedFragments(workspaceId),
        ...extractUserProfileFragments(),
        ...extractRelationshipFragments(),
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
    if (grouped.user_profile.length || grouped.relationship.length) {
      parts.push("\n## You & the User");
      for (const fragment of [...grouped.user_profile, ...grouped.relationship]) {
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

  static buildStructuredMemoryContext(
    workspaceId: string,
    workspacePath: string,
    taskPrompt: string,
    options: { includeKnowledgeGraph?: boolean; includeArchive?: boolean; tokenBudget?: number } = {},
  ): SynthesizedContext {
    const now = Date.now();
    const fragments = [
      ...extractPlaybookFragments(workspaceId, taskPrompt),
      ...extractDailySummaryFragments(workspacePath, taskPrompt),
    ];
    if (options.includeKnowledgeGraph !== false) {
      fragments.push(...extractKnowledgeGraphFragments(workspaceId, taskPrompt));
    }
    if (options.includeArchive) {
      fragments.push(...extractArchiveFragments(workspaceId, taskPrompt));
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

    const sourceAttribution: Record<MemorySourceKind, number> = {
      curated_memory: 0,
      user_profile: 0,
      relationship: 0,
      playbook: grouped.playbook.length,
      memory: grouped.memory.length,
      knowledge_graph: grouped.knowledge_graph.length,
      workspace_kit: 0,
      daily_summary: grouped.daily_summary.length,
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

  static buildRecallHintsContext(): string {
    const features = MemoryFeaturesManager.loadSettings();
    const hints: string[] = [];
    if (features.verbatimRecallEnabled !== false) {
      hints.push("- Use `search_quotes` for exact wording across transcripts, imported memories, and workspace notes.");
    }
    if (features.sessionRecallEnabled !== false) {
      hints.push("- Use `search_sessions` for recent transcript/task history recall.");
    }
    hints.push("- Use `search_memories` for broader archive and imported-history recall.");
    if (features.topicMemoryEnabled !== false) {
      hints.push("- Use `memory_topics_load` when the task is topical and needs a focused L2 topic pack.");
    }
    return hints.length
      ? `<cowork_recall_hints>\n## L2/L3 Recall Guidance\n${hints.join("\n")}\n</cowork_recall_hints>`
      : "";
  }

  private static buildWakeUpLayers(
    workspaceId: string,
    workspacePath: string,
    taskPrompt: string,
    options: SynthesizeOptions,
    settings: ReturnType<typeof MemoryFeaturesManager.loadSettings>,
  ): {
    l0: LayeredContextResult;
    l1: LayeredContextResult;
    recallHints: string;
  } {
    const budget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    const includeWorkspaceKit = options.includeWorkspaceKit !== false;
    const kitBudget = includeWorkspaceKit ? Math.floor(budget * 0.3) : 0;
    const remainingBudget = Math.max(320, budget - kitBudget);
    const l0Budget = Math.floor(remainingBudget * 0.55);
    const l1Budget = remainingBudget - l0Budget;

    const identity =
      settings.curatedMemoryEnabled === false
        ? {
            text: "",
            totalTokens: 0,
            fragmentCount: 0,
            sourceAttribution: emptySourceAttribution(),
            droppedCount: 0,
          }
        : this.buildHotMemoryContext(workspaceId, l0Budget);
    let kitText = "";
    if (includeWorkspaceKit) {
      try {
        const rawKit = buildWorkspaceKitContext(workspacePath, taskPrompt, new Date(), {
          agentRoleId: options.agentRoleId ?? null,
        });
        if (rawKit) {
          const kitTokens = estimateTokens(rawKit);
          kitText =
            kitTokens <= kitBudget
              ? rawKit
              : rawKit.slice(0, kitBudget * CHARS_PER_TOKEN) + "\n[... workspace context truncated]";
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

    const story = this.buildStructuredMemoryContext(workspaceId, workspacePath, taskPrompt, {
      includeKnowledgeGraph: false,
      includeArchive: false,
      tokenBudget: l1Budget,
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
    };
  }

  static buildLayerPreview(
    workspaceId: string,
    workspacePath: string,
    taskPrompt: string,
    options: SynthesizeOptions = {},
  ): MemoryLayerPreviewPayload {
    const settings = MemoryFeaturesManager.loadSettings();
    const wakeUpLayersEnabled = settings.wakeUpLayersEnabled !== false;
    const effectivePrompt = taskPrompt.trim() || "Current workspace memory preview";

    if (!wakeUpLayersEnabled) {
      const synthesized = this.synthesize(workspaceId, workspacePath, effectivePrompt, options);
      return {
        workspaceId,
        taskPrompt: effectivePrompt,
        generatedAt: Date.now(),
        injectedLayerIds: ["L0", "L1", "L2", "L3"],
        excludedLayerIds: [],
        layers: [
          {
            layer: "L0",
            title: "Legacy Combined Memory",
            description: "Wake-up layers are disabled; the prompt uses the combined synthesized memory block.",
            includedText: synthesized.text,
            budget: {
              usedTokens: synthesized.totalTokens,
              budgetTokens: options.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
              excludedCount: synthesized.droppedCount,
            },
            injectedByDefault: true,
          },
        ],
      };
    }

    const wakeUp = this.buildWakeUpLayers(workspaceId, workspacePath, effectivePrompt, options, settings);
    const l2Description =
      settings.topicMemoryEnabled !== false
        ? "Excluded from default injection. Load with `memory_topics_load` when the task needs a focused topical pack."
        : "Topic packs are currently disabled.";
    const l3Description =
      "Excluded from default injection. Use `search_quotes`, `search_sessions`, or `search_memories` when exact recall is needed.";

    const layers: MemoryLayerPreview[] = [
      {
        layer: "L0",
        title: wakeUp.l0.title,
        description: wakeUp.l0.description,
        includedText: wakeUp.l0.text,
        budget: {
          usedTokens: wakeUp.l0.totalTokens,
          budgetTokens: Math.max(wakeUp.l0.totalTokens, options.tokenBudget ?? DEFAULT_TOKEN_BUDGET),
          excludedCount: wakeUp.l0.droppedCount,
        },
        injectedByDefault: true,
      },
      {
        layer: "L1",
        title: wakeUp.l1.title,
        description: wakeUp.l1.description,
        includedText: wakeUp.l1.text,
        budget: {
          usedTokens: wakeUp.l1.totalTokens,
          budgetTokens: Math.max(wakeUp.l1.totalTokens, options.tokenBudget ?? DEFAULT_TOKEN_BUDGET),
          excludedCount: wakeUp.l1.droppedCount,
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
        description: "Unified recall and verbatim quote search across transcripts, tasks, files, and memory.",
        includedText: wakeUp.recallHints,
        excludedText: l3Description,
        budget: {
          usedTokens: estimateTokens(wakeUp.recallHints),
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
      layers,
    };
  }

  static synthesize(
    workspaceId: string,
    workspacePath: string,
    taskPrompt: string,
    options: SynthesizeOptions = {},
  ): SynthesizedContext {
    const settings = MemoryFeaturesManager.loadSettings();
    if (settings.wakeUpLayersEnabled !== false) {
      const layered = this.buildWakeUpLayers(workspaceId, workspacePath, taskPrompt, options, settings);
      const finalParts = [layered.l0.text, layered.l1.text].filter(Boolean);
      const finalText = finalParts.join("\n\n");
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
        },
        droppedCount: layered.l0.droppedCount + layered.l1.droppedCount,
      };
    }

    const budget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    const kitBudget = options.includeWorkspaceKit !== false ? Math.floor(budget * 0.35) : 0;
    const remainingBudget = Math.max(400, budget - kitBudget);
    const hotBudget = Math.floor(remainingBudget * 0.5);
    const structuredBudget = remainingBudget - hotBudget;

    const hot = settings.curatedMemoryEnabled === false
      ? {
          text: "",
          totalTokens: 0,
          fragmentCount: 0,
          sourceAttribution: emptySourceAttribution(),
          droppedCount: 0,
        }
      : this.buildHotMemoryContext(workspaceId, hotBudget);
    const structured = this.buildStructuredMemoryContext(workspaceId, workspacePath, taskPrompt, {
      includeKnowledgeGraph: options.includeKnowledgeGraph !== false,
      includeArchive: settings.defaultArchiveInjectionEnabled === true,
      tokenBudget: structuredBudget,
    });

    let kitText = "";
    if (options.includeWorkspaceKit !== false) {
      try {
        const rawKit = buildWorkspaceKitContext(workspacePath, taskPrompt, new Date(), {
          agentRoleId: options.agentRoleId ?? null,
        });
        if (rawKit) {
          const kitTokens = estimateTokens(rawKit);
          kitText =
            kitTokens <= kitBudget
              ? rawKit
              : rawKit.slice(0, kitBudget * CHARS_PER_TOKEN) + "\n[... workspace context truncated]";
        }
      } catch {
        kitText = "";
      }
    }

    const recallHints = this.buildRecallHintsContext();
    const finalParts = [kitText, hot.text, structured.text, recallHints].filter(Boolean);
    const finalText = finalParts.join("\n\n");
    const sourceAttribution: Record<MemorySourceKind, number> = {
      curated_memory: hot.sourceAttribution.curated_memory,
      user_profile: hot.sourceAttribution.user_profile,
      relationship: hot.sourceAttribution.relationship,
      playbook: structured.sourceAttribution.playbook,
      memory: structured.sourceAttribution.memory,
      knowledge_graph: structured.sourceAttribution.knowledge_graph,
      workspace_kit: kitText ? 1 : 0,
      daily_summary: structured.sourceAttribution.daily_summary,
    };

    return {
      text: finalText,
      totalTokens: estimateTokens(finalText),
      fragmentCount:
        hot.fragmentCount + structured.fragmentCount + (kitText ? 1 : 0),
      sourceAttribution,
      droppedCount: hot.droppedCount + structured.droppedCount,
    };
  }
}
