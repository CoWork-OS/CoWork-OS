import { v4 as uuidv4 } from "uuid";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import type { Task } from "../../shared/types";
import { InputSanitizer } from "../agent/security/input-sanitizer";
import { bumpHotMemoryVersion } from "./hot-memory-version";
import { sanitizePreferredNameMemoryLine } from "../utils/preferred-name";
import { MemoryWriter } from "./MemoryWriter";
import { MEMORY_LANE_STORES, relationshipItemCandidate } from "./memory-items-lanes";

type RelationshipLayer = "identity" | "preferences" | "context" | "history" | "commitments";
/**
 * Where an item came from. "mailbox" items are third-party text (email subjects,
 * summaries, sender names, extracted commitments) and are not trusted as facts
 * about the user: they stay available to mailbox features but are never rendered
 * into the user-profile / relationship prompt context.
 */
type RelationshipSource = "conversation" | "feedback" | "task" | "mailbox";
type TaskSource = NonNullable<Task["source"]>;

export interface RelationshipMemoryItem {
  id: string;
  layer: RelationshipLayer;
  text: string;
  confidence: number;
  source: RelationshipSource;
  createdAt: number;
  updatedAt: number;
  lastTaskId?: string;
  status?: "open" | "done";
  dueAt?: number;
  contactIdentityId?: string;
  companyId?: string;
}

interface RelationshipMemoryProfile {
  items: RelationshipMemoryItem[];
  updatedAt: number;
}

const MAX_ITEMS = 300;
const MAX_TEXT_LENGTH = 220;
const STORAGE_KEY = "relationship-memory";

const EMPTY_PROFILE: RelationshipMemoryProfile = {
  items: [],
  updatedAt: 0,
};

interface BuildPromptContextOptions {
  maxPerLayer?: number;
  maxChars?: number;
  includeDueSoon?: boolean;
  contactIdentityId?: string;
  companyId?: string;
  /**
   * Include third-party ("mailbox") items. Off by default: the result feeds the
   * pinned user-profile block and task prompts, where sender-controlled text must
   * not appear. Only mailbox features that already handle the sender's content
   * should opt in.
   */
  includeThirdParty?: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class RelationshipMemoryService {
  private static inMemoryProfile: RelationshipMemoryProfile = { ...EMPTY_PROFILE };

  static listItems(
    params: {
      layer?: RelationshipLayer;
      includeDone?: boolean;
      limit?: number;
      contactIdentityId?: string;
      companyId?: string;
      /** Drop third-party ("mailbox") items, for callers that render into prompts. */
      excludeThirdParty?: boolean;
    } = {},
  ): RelationshipMemoryItem[] {
    const profile = this.load();
    const limit = Math.max(1, params.limit ?? 80);
    return this.sort(this.filterByScope(profile.items, params.contactIdentityId, params.companyId))
      .filter((item) => !params.excludeThirdParty || !this.isThirdPartyItem(item))
      .filter((item) => !params.layer || item.layer === params.layer)
      .filter((item) => params.includeDone === true || item.status !== "done")
      .slice(0, limit);
  }

  static updateItem(
    id: string,
    patch: {
      text?: string;
      confidence?: number;
      status?: "open" | "done";
      dueAt?: number | null;
      contactIdentityId?: string | null;
      companyId?: string | null;
    },
  ): RelationshipMemoryItem | null {
    const profile = this.load();
    const item = profile.items.find((entry) => entry.id === id);
    if (!item) return null;

    if (typeof patch.text === "string") {
      const nextText = this.normalizeText(patch.text);
      if (!nextText) throw new Error("Item text is required");
      item.text = nextText;
    }
    if (typeof patch.confidence === "number") {
      item.confidence = clamp(patch.confidence, 0, 1);
    }
    if (patch.status === "open" || patch.status === "done") {
      item.status = patch.status;
    }
    if (patch.dueAt === null) {
      delete item.dueAt;
    } else if (typeof patch.dueAt === "number" && Number.isFinite(patch.dueAt)) {
      item.dueAt = Math.floor(patch.dueAt);
    }
    if (patch.contactIdentityId === null) {
      delete item.contactIdentityId;
    } else if (typeof patch.contactIdentityId === "string") {
      item.contactIdentityId = patch.contactIdentityId;
    }
    if (patch.companyId === null) {
      delete item.companyId;
    } else if (typeof patch.companyId === "string") {
      item.companyId = patch.companyId;
    }
    item.updatedAt = Date.now();
    this.save(profile);
    this.mirrorItem(item);
    return item;
  }

  static deleteItem(id: string): boolean {
    const profile = this.load();
    const before = profile.items.length;
    profile.items = profile.items.filter((item) => item.id !== id);
    if (profile.items.length === before) return false;
    this.save(profile);
    MemoryWriter.dualWriteStatus(
      MEMORY_LANE_STORES.relationship,
      id,
      "deleted",
      "relationship delete",
    );
    return true;
  }

  static listOpenCommitments(
    limit = 20,
    scope?: { contactIdentityId?: string; companyId?: string },
  ): RelationshipMemoryItem[] {
    return this.listItems({
      layer: "commitments",
      includeDone: false,
      limit,
      contactIdentityId: scope?.contactIdentityId,
      companyId: scope?.companyId,
    });
  }

  static listDueSoonCommitments(
    windowHours = 72,
    nowMs = Date.now(),
    scope?: { contactIdentityId?: string; companyId?: string },
  ): RelationshipMemoryItem[] {
    const cutoff = nowMs + Math.max(1, Math.floor(windowHours)) * 60 * 60 * 1000;
    return this.listOpenCommitments(200, scope)
      .filter((item) => typeof item.dueAt === "number" && item.dueAt <= cutoff)
      .sort((a, b) => Number(a.dueAt || 0) - Number(b.dueAt || 0));
  }

  static recordTaskCompletion(
    title: string,
    resultSummary?: string,
    taskId?: string,
    taskSource: TaskSource = "manual",
  ): void {
    const normalizedTitle = String(title || "").trim();
    if (!normalizedTitle) return;

    const compactSummary = String(resultSummary || "")
      .trim()
      .replace(/\s+/g, " ");
    const excerpt =
      compactSummary.length > 90 ? `${compactSummary.slice(0, 90)}...` : compactSummary;
    const text = excerpt
      ? `Completed task: ${normalizedTitle}. Outcome: ${excerpt}`
      : `Completed task: ${normalizedTitle}`;

    if (taskSource === "cron") {
      this.upsertRecurringTaskHistory({
        title: normalizedTitle,
        text,
        taskId,
      });
    } else {
      this.upsert({
        layer: "history",
        text: text.slice(0, MAX_TEXT_LENGTH),
        confidence: 0.68,
        source: "task",
        lastTaskId: taskId,
      });
    }

    if (/\b(done|completed|finished|shipped)\b/i.test(compactSummary)) {
      this.markMatchingCommitmentsDone(compactSummary);
    }
  }

  static rememberMailboxInsights(params: {
    facts?: string[];
    commitments?: Array<{ text: string; dueAt?: number }>;
    taskId?: string;
    contactIdentityId?: string;
    companyId?: string;
  }): void {
    const facts = Array.isArray(params.facts) ? params.facts : [];
    const commitments = Array.isArray(params.commitments) ? params.commitments : [];

    for (const fact of facts.slice(0, 4)) {
      const text = this.normalizeText(fact);
      if (!text) continue;
      this.upsert({
        layer: "context",
        text,
        confidence: 0.7,
        source: "mailbox",
        lastTaskId: params.taskId,
        contactIdentityId: params.contactIdentityId,
        companyId: params.companyId,
      });
    }

    for (const commitment of commitments.slice(0, 6)) {
      const text = this.normalizeText(commitment.text);
      if (!text) continue;
      this.upsert({
        layer: "commitments",
        text,
        confidence: 0.82,
        source: "mailbox",
        lastTaskId: params.taskId,
        status: "open",
        dueAt: commitment.dueAt,
        contactIdentityId: params.contactIdentityId,
        companyId: params.companyId,
      });
    }
  }

  static cleanupRecurringTaskHistory(): {
    collapsed: number;
    groupsCollapsed: number;
  } {
    const profile = this.load();
    const byTitle = new Map<string, number[]>();

    for (let i = 0; i < profile.items.length; i++) {
      const item = profile.items[i];
      if (item.layer !== "history" || item.source !== "task") continue;
      const title = this.extractCompletedTaskTitle(item.text);
      if (!title) continue;
      const key = this.normalizeForMatch(title);
      const bucket = byTitle.get(key);
      if (bucket) bucket.push(i);
      else byTitle.set(key, [i]);
    }

    const indexesToDelete = new Set<number>();
    let groupsCollapsed = 0;
    for (const indexes of byTitle.values()) {
      if (indexes.length <= 1) continue;
      groupsCollapsed += 1;
      const keepIndex = indexes.reduce((best, idx) => {
        const candidate = profile.items[idx];
        const currentBest = profile.items[best];
        if (candidate.updatedAt !== currentBest.updatedAt) {
          return candidate.updatedAt > currentBest.updatedAt ? idx : best;
        }
        if (candidate.createdAt !== currentBest.createdAt) {
          return candidate.createdAt > currentBest.createdAt ? idx : best;
        }
        return idx > best ? idx : best;
      });
      for (const idx of indexes) {
        if (idx !== keepIndex) indexesToDelete.add(idx);
      }
    }

    const collapsed = indexesToDelete.size;
    if (collapsed > 0) {
      profile.items = profile.items.filter((_, idx) => !indexesToDelete.has(idx));
      this.save(profile);
    }

    return { collapsed, groupsCollapsed };
  }

  static buildPromptContext(options: BuildPromptContextOptions = {}): string {
    const maxPerLayer = Math.max(1, options.maxPerLayer ?? 2);
    const maxChars = Math.max(300, options.maxChars ?? 1200);
    const includeDueSoon = options.includeDueSoon !== false;
    const includeThirdParty = options.includeThirdParty === true;
    const profile = this.load();
    const scopedItems = this.filterByScope(
      profile.items,
      options.contactIdentityId,
      options.companyId,
    ).filter((item) => includeThirdParty || !this.isThirdPartyItem(item));
    if (!scopedItems.length) return "";
    // Stored text is rendered inside tagged prompt blocks; keep each item on one
    // line and unable to close or open tags.
    const render = (text: string) => InputSanitizer.sanitizeInlineMemoryLine(text);

    const lines: string[] = ["RELATIONSHIP MEMORY (continuity context, not hard constraints):"];

    const appendLayer = (label: string, layer: RelationshipLayer, openOnly = false) => {
      const selected = this.sort(profile.items)
        .filter((item) => scopedItems.some((entry) => entry.id === item.id))
        .filter((item) => item.layer === layer)
        .filter((item) => !openOnly || item.status !== "done")
        .slice(0, maxPerLayer);
      if (!selected.length) return;
      lines.push(`${label}:`);
      for (const item of selected) {
        lines.push(`- ${render(item.text)}`);
      }
    };

    appendLayer("Identity", "identity");
    appendLayer("Preferences", "preferences");
    appendLayer("Current context", "context");
    appendLayer("Open commitments", "commitments", true);
    if (includeDueSoon) {
      const dueSoon = this.listDueSoonCommitments(72, Date.now(), {
        contactIdentityId: options.contactIdentityId,
        companyId: options.companyId,
      })
        .filter((item) => includeThirdParty || !this.isThirdPartyItem(item))
        .slice(0, maxPerLayer);
      if (dueSoon.length > 0) {
        lines.push("Due soon reminders:");
        for (const item of dueSoon) {
          const dueText = item.dueAt ? new Date(item.dueAt).toISOString() : "soon";
          lines.push(`- ${render(item.text)} (due: ${dueText})`);
        }
      }
    }
    appendLayer("Recent history", "history");

    let text = lines.join("\n");
    if (text.length > maxChars) {
      text = `${text.slice(0, maxChars - 16)}\n[... truncated]`;
    }
    return text;
  }

  /** True for items whose text came from a third party (e.g. an email sender). */
  static isThirdPartyItem(item: Pick<RelationshipMemoryItem, "source">): boolean {
    return item.source === "mailbox";
  }

  private static upsert(
    input: Omit<RelationshipMemoryItem, "id" | "createdAt" | "updatedAt">,
  ): void {
    const normalizedText = this.normalizeText(input.text);
    if (!normalizedText) return;

    const profile = this.load();
    const now = Date.now();
    const existing = profile.items.find(
      (item) =>
        item.layer === input.layer &&
        this.normalizeForMatch(item.text) === this.normalizeForMatch(normalizedText) &&
        item.contactIdentityId === input.contactIdentityId &&
        item.companyId === input.companyId,
    );

    if (existing) {
      existing.updatedAt = now;
      existing.confidence = Math.max(existing.confidence, clamp(input.confidence, 0, 1));
      // A mailbox write of the same text must not demote an item the user
      // stated themselves; any other source re-labels as before.
      if (!(input.source === "mailbox" && existing.source !== "mailbox")) {
        existing.source = input.source;
      }
      existing.lastTaskId = input.lastTaskId ?? existing.lastTaskId;
      existing.status = input.status ?? existing.status;
      existing.dueAt = typeof input.dueAt === "number" ? Math.floor(input.dueAt) : existing.dueAt;
      existing.contactIdentityId = input.contactIdentityId ?? existing.contactIdentityId;
      existing.companyId = input.companyId ?? existing.companyId;
      this.save(profile);
      this.mirrorItem(existing);
      return;
    }

    const created: RelationshipMemoryItem = {
      id: uuidv4(),
      layer: input.layer,
      text: normalizedText,
      confidence: clamp(input.confidence, 0, 1),
      source: input.source,
      createdAt: now,
      updatedAt: now,
      lastTaskId: input.lastTaskId,
      status: input.status,
      dueAt: typeof input.dueAt === "number" ? Math.floor(input.dueAt) : undefined,
      contactIdentityId: input.contactIdentityId,
      companyId: input.companyId,
    };
    profile.items.push(created);

    if (profile.items.length > MAX_ITEMS) {
      profile.items = this.sort(profile.items).slice(0, MAX_ITEMS);
    }
    this.save(profile);
    this.mirrorItem(created);
  }

  /**
   * Dual write (memory engine Phase 2): this store stays the system of record for reads
   * this wave; each change is mirrored into `memory_items` in the background. History
   * items are episodic and are not mirrored; a done commitment is archived.
   */
  private static mirrorItem(item: RelationshipMemoryItem): void {
    if (item.status === "done") {
      MemoryWriter.dualWriteStatus(
        MEMORY_LANE_STORES.relationship,
        item.id,
        "archived",
        "relationship commitment done",
      );
      return;
    }
    MemoryWriter.dualWrite(relationshipItemCandidate({ ...item }), "relationship item");
  }

  private static markMatchingCommitmentsDone(summary: string): void {
    const profile = this.load();
    const normalizedSummary = this.normalizeForMatch(summary);
    if (!normalizedSummary) return;

    let changed = false;
    const closed: RelationshipMemoryItem[] = [];
    for (const item of profile.items) {
      if (item.layer !== "commitments" || item.status === "done") continue;
      const signal = this.normalizeForMatch(item.text).replace(/^remind me to\s+/, "");
      if (signal && normalizedSummary.includes(signal.slice(0, Math.min(signal.length, 40)))) {
        item.status = "done";
        item.updatedAt = Date.now();
        changed = true;
        closed.push(item);
      }
    }

    if (changed) {
      this.save(profile);
      for (const item of closed) this.mirrorItem(item);
    }
  }

  private static sort(items: RelationshipMemoryItem[]): RelationshipMemoryItem[] {
    return [...items].sort((a, b) => {
      const dueA =
        a.status === "open" ? (a.dueAt ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
      const dueB =
        b.status === "open" ? (b.dueAt ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
      if (dueA !== dueB) return dueA - dueB;
      if ((a.status === "open") !== (b.status === "open")) {
        return a.status === "open" ? -1 : 1;
      }
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.updatedAt - a.updatedAt;
    });
  }

  private static normalizeText(value: string): string {
    return String(value || "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, MAX_TEXT_LENGTH);
  }

  private static normalizeForMatch(value: string): string {
    return this.normalizeText(value).toLowerCase();
  }

  private static extractCompletedTaskTitle(text: string): string | null {
    const normalized = this.normalizeText(text);
    const match = normalized.match(/^completed task:\s*(.+?)(?:\.\s*outcome:|$)/i);
    if (!match) return null;
    const title = this.normalizeText(match[1]);
    return title || null;
  }

  private static upsertRecurringTaskHistory(params: {
    title: string;
    text: string;
    taskId?: string;
  }): void {
    const profile = this.load();
    const now = Date.now();
    const titleKey = this.normalizeForMatch(params.title);

    const matchingIndexes: number[] = [];
    for (let i = 0; i < profile.items.length; i++) {
      const item = profile.items[i];
      if (item.layer !== "history" || item.source !== "task") continue;
      const existingTitle = this.extractCompletedTaskTitle(item.text);
      if (!existingTitle) continue;
      if (this.normalizeForMatch(existingTitle) === titleKey) {
        matchingIndexes.push(i);
      }
    }

    if (matchingIndexes.length > 0) {
      const keepIndex = matchingIndexes.reduce((best, idx) =>
        profile.items[idx].updatedAt > profile.items[best].updatedAt ? idx : best,
      );
      const keepItem = profile.items[keepIndex];
      keepItem.text = this.normalizeText(params.text);
      keepItem.updatedAt = now;
      keepItem.confidence = Math.max(keepItem.confidence, 0.48);
      keepItem.lastTaskId = params.taskId ?? keepItem.lastTaskId;

      if (matchingIndexes.length > 1) {
        const indexesToDelete = new Set(matchingIndexes.filter((idx) => idx !== keepIndex));
        profile.items = profile.items.filter((_, idx) => !indexesToDelete.has(idx));
      }

      this.save(profile);
      return;
    }

    profile.items.push({
      id: uuidv4(),
      layer: "history",
      text: this.normalizeText(params.text),
      confidence: 0.48,
      source: "task",
      createdAt: now,
      updatedAt: now,
      lastTaskId: params.taskId,
    });

    if (profile.items.length > MAX_ITEMS) {
      profile.items = this.sort(profile.items).slice(0, MAX_ITEMS);
    }
    this.save(profile);
  }

  private static load(): RelationshipMemoryProfile {
    let profile: RelationshipMemoryProfile | undefined;
    if (SecureSettingsRepository.isInitialized()) {
      try {
        const repo = SecureSettingsRepository.getInstance();
        profile = repo.load<RelationshipMemoryProfile>(STORAGE_KEY);
      } catch {
        // fallback to in-memory
      }
    }

    if (!profile || !Array.isArray(profile.items)) {
      profile = this.inMemoryProfile;
    }

    let profileWasSanitized = false;
    const normalizedProfile: RelationshipMemoryProfile = {
      items: Array.isArray(profile.items)
        ? profile.items
            .filter(
              (item) => !!item && typeof item.id === "string" && typeof item.text === "string",
            )
            .map((item): RelationshipMemoryItem | null => {
              const normalizedText = this.normalizeText(item.text);
              if (normalizedText !== item.text) profileWasSanitized = true;
              const cleanedIdentityText =
                item.layer === "identity"
                  ? sanitizePreferredNameMemoryLine(normalizedText)
                  : normalizedText;
              if (!cleanedIdentityText) {
                profileWasSanitized = true;
                return null;
              }
              if (cleanedIdentityText !== normalizedText) profileWasSanitized = true;

              const sanitizedItem: RelationshipMemoryItem = {
                id: item.id,
                layer: item.layer,
                text: cleanedIdentityText,
                confidence: clamp(Number(item.confidence ?? 0.65), 0, 1),
                source: this.normalizeSource(item),
                createdAt: Number(item.createdAt || Date.now()),
                updatedAt: Number(item.updatedAt || Date.now()),
              };

              if (sanitizedItem.source !== item.source) profileWasSanitized = true;
              if (typeof item.lastTaskId === "string") {
                sanitizedItem.lastTaskId = item.lastTaskId;
              }
              if (item.status === "open" || item.status === "done") {
                sanitizedItem.status = item.status;
              }
              if (typeof item.dueAt === "number" && Number.isFinite(item.dueAt)) {
                sanitizedItem.dueAt = Math.floor(item.dueAt);
              }
              if (typeof item.contactIdentityId === "string") {
                sanitizedItem.contactIdentityId = item.contactIdentityId;
              }
              if (typeof item.companyId === "string") {
                sanitizedItem.companyId = item.companyId;
              }

              return sanitizedItem;
            })
            .filter((item): item is RelationshipMemoryItem => item !== null)
        : [],
      updatedAt: Number(profile.updatedAt || 0),
    };

    this.inMemoryProfile = normalizedProfile;
    if (profileWasSanitized) {
      this.save(normalizedProfile);
    }

    return normalizedProfile;
  }

  /**
   * Older builds stored mailbox insights with source "task". Only mailbox writes
   * ever produced "task" items outside the history layer (task completion writes
   * history only), so those are re-labelled "mailbox" on load.
   */
  private static normalizeSource(item: RelationshipMemoryItem): RelationshipSource {
    if (item.source === "mailbox" || item.source === "feedback") return item.source;
    if (item.source === "task") {
      return item.layer === "context" || item.layer === "commitments" ? "mailbox" : "task";
    }
    return "conversation";
  }

  private static save(profile: RelationshipMemoryProfile): void {
    const next: RelationshipMemoryProfile = {
      items: this.sort(profile.items).slice(0, MAX_ITEMS),
      updatedAt: Date.now(),
    };

    this.inMemoryProfile = next;
    bumpHotMemoryVersion();
    if (!SecureSettingsRepository.isInitialized()) return;
    try {
      const repo = SecureSettingsRepository.getInstance();
      repo.save(STORAGE_KEY, next);
    } catch {
      // keep in-memory fallback only
    }
  }

  private static filterByScope(
    items: RelationshipMemoryItem[],
    contactIdentityId?: string,
    companyId?: string,
  ): RelationshipMemoryItem[] {
    if (!contactIdentityId && !companyId) return items;
    const scoped = items.filter((item) => item.contactIdentityId === contactIdentityId);
    const companyScoped = items.filter(
      (item) =>
        !item.contactIdentityId &&
        companyId &&
        item.companyId === companyId &&
        !scoped.some((entry) => entry.id === item.id),
    );
    const global = items.filter(
      (item) =>
        !item.contactIdentityId &&
        !item.companyId &&
        !scoped.some((entry) => entry.id === item.id) &&
        !companyScoped.some((entry) => entry.id === item.id),
    );
    return [...scoped, ...companyScoped, ...global];
  }
}
