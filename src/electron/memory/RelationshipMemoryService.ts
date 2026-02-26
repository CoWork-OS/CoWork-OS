import { v4 as uuidv4 } from "uuid";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";

type RelationshipLayer = "identity" | "preferences" | "context" | "history" | "commitments";
type RelationshipSource = "conversation" | "feedback" | "task";

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
    } = {},
  ): RelationshipMemoryItem[] {
    const profile = this.load();
    const limit = Math.max(1, params.limit ?? 80);
    return this.sort(profile.items)
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
    item.updatedAt = Date.now();
    this.save(profile);
    return item;
  }

  static deleteItem(id: string): boolean {
    const profile = this.load();
    const before = profile.items.length;
    profile.items = profile.items.filter((item) => item.id !== id);
    if (profile.items.length === before) return false;
    this.save(profile);
    return true;
  }

  static listOpenCommitments(limit = 20): RelationshipMemoryItem[] {
    return this.listItems({ layer: "commitments", includeDone: false, limit });
  }

  static listDueSoonCommitments(windowHours = 72, nowMs = Date.now()): RelationshipMemoryItem[] {
    const cutoff = nowMs + Math.max(1, Math.floor(windowHours)) * 60 * 60 * 1000;
    return this.listOpenCommitments(200)
      .filter((item) => typeof item.dueAt === "number" && item.dueAt <= cutoff)
      .sort((a, b) => Number(a.dueAt || 0) - Number(b.dueAt || 0));
  }

  static ingestUserMessage(message: string, taskId?: string): void {
    const text = String(message || "").trim();
    if (!text) return;

    const candidates: Array<Omit<RelationshipMemoryItem, "id" | "createdAt" | "updatedAt">> = [];
    const _lower = text.toLowerCase();

    const nameMatch = text.match(/\b(?:my name is|call me|i am|i'm)\s+([a-z][a-z' -]{1,40})/i);
    if (nameMatch) {
      candidates.push({
        layer: "identity",
        text: `Preferred name: ${nameMatch[1].trim()}`,
        confidence: 0.9,
        source: "conversation",
        lastTaskId: taskId,
      });
    }

    const preferenceMatch = text.match(
      /\b(?:i prefer|please always|please don't|i like|i dislike)\s+([^.!?\n]{3,120})/i,
    );
    if (preferenceMatch) {
      candidates.push({
        layer: "preferences",
        text: preferenceMatch[0].trim(),
        confidence: 0.78,
        source: "conversation",
        lastTaskId: taskId,
      });
    }

    const contextMatch = text.match(
      /\b(?:i(?:'m| am) working on|for my team|for my company|we are building|this project is)\s+([^.!?\n]{3,150})/i,
    );
    if (contextMatch) {
      candidates.push({
        layer: "context",
        text: contextMatch[0].trim(),
        confidence: 0.75,
        source: "conversation",
        lastTaskId: taskId,
      });
    }

    const commitmentMatch = text.match(
      /\b(?:remind me to|i need to|i must|please remember to)\s+([^.!?\n]{3,150})/i,
    );
    if (commitmentMatch) {
      const dueAt = this.parseDueAt(text, Date.now());
      candidates.push({
        layer: "commitments",
        text: commitmentMatch[0].trim(),
        confidence: 0.82,
        source: "conversation",
        status: "open",
        dueAt,
        lastTaskId: taskId,
      });
    }

    for (const candidate of candidates.slice(0, 4)) {
      this.upsert(candidate);
    }
  }

  static ingestUserFeedback(decision?: string, reason?: string, taskId?: string): void {
    const feedback = String(reason || "").trim();
    if (!feedback) return;

    const lowered = feedback.toLowerCase();
    if (/\b(concise|shorter|brief|more detail|detailed|tone|format)\b/.test(lowered)) {
      this.upsert({
        layer: "preferences",
        text: `Feedback preference: ${feedback}`.slice(0, MAX_TEXT_LENGTH),
        confidence: 0.86,
        source: "feedback",
        lastTaskId: taskId,
      });
    }

    if (decision && /\b(reject|deny|denied)\b/i.test(decision)) {
      this.upsert({
        layer: "history",
        text: `Rejected approach: ${feedback}`.slice(0, MAX_TEXT_LENGTH),
        confidence: 0.72,
        source: "feedback",
        lastTaskId: taskId,
      });
    }
  }

  static recordTaskCompletion(title: string, resultSummary?: string, taskId?: string): void {
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

    this.upsert({
      layer: "history",
      text: text.slice(0, MAX_TEXT_LENGTH),
      confidence: 0.68,
      source: "task",
      lastTaskId: taskId,
    });

    if (/\b(done|completed|finished|shipped)\b/i.test(compactSummary)) {
      this.markMatchingCommitmentsDone(compactSummary);
    }
  }

  static buildPromptContext(options: BuildPromptContextOptions = {}): string {
    const maxPerLayer = Math.max(1, options.maxPerLayer ?? 2);
    const maxChars = Math.max(300, options.maxChars ?? 1200);
    const includeDueSoon = options.includeDueSoon !== false;
    const profile = this.load();
    if (!profile.items.length) return "";

    const lines: string[] = ["RELATIONSHIP MEMORY (continuity context, not hard constraints):"];

    const appendLayer = (label: string, layer: RelationshipLayer, openOnly = false) => {
      const selected = this.sort(profile.items)
        .filter((item) => item.layer === layer)
        .filter((item) => !openOnly || item.status !== "done")
        .slice(0, maxPerLayer);
      if (!selected.length) return;
      lines.push(`${label}:`);
      for (const item of selected) {
        lines.push(`- ${item.text}`);
      }
    };

    appendLayer("Identity", "identity");
    appendLayer("Preferences", "preferences");
    appendLayer("Current context", "context");
    appendLayer("Open commitments", "commitments", true);
    if (includeDueSoon) {
      const dueSoon = this.listDueSoonCommitments(72).slice(0, maxPerLayer);
      if (dueSoon.length > 0) {
        lines.push("Due soon reminders:");
        for (const item of dueSoon) {
          const dueText = item.dueAt ? new Date(item.dueAt).toISOString() : "soon";
          lines.push(`- ${item.text} (due: ${dueText})`);
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
        this.normalizeForMatch(item.text) === this.normalizeForMatch(normalizedText),
    );

    if (existing) {
      existing.updatedAt = now;
      existing.confidence = Math.max(existing.confidence, clamp(input.confidence, 0, 1));
      existing.source = input.source;
      existing.lastTaskId = input.lastTaskId ?? existing.lastTaskId;
      existing.status = input.status ?? existing.status;
      existing.dueAt = typeof input.dueAt === "number" ? Math.floor(input.dueAt) : existing.dueAt;
      this.save(profile);
      return;
    }

    profile.items.push({
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
    });

    if (profile.items.length > MAX_ITEMS) {
      profile.items = this.sort(profile.items).slice(0, MAX_ITEMS);
    }
    this.save(profile);
  }

  private static markMatchingCommitmentsDone(summary: string): void {
    const profile = this.load();
    const normalizedSummary = this.normalizeForMatch(summary);
    if (!normalizedSummary) return;

    let changed = false;
    for (const item of profile.items) {
      if (item.layer !== "commitments" || item.status === "done") continue;
      const signal = this.normalizeForMatch(item.text).replace(/^remind me to\s+/, "");
      if (signal && normalizedSummary.includes(signal.slice(0, Math.min(signal.length, 40)))) {
        item.status = "done";
        item.updatedAt = Date.now();
        changed = true;
      }
    }

    if (changed) {
      this.save(profile);
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

  private static parseDueAt(text: string, nowMs: number): number | undefined {
    const lower = text.toLowerCase();
    const dayMs = 24 * 60 * 60 * 1000;
    if (/\btoday\b/.test(lower)) return nowMs + 8 * 60 * 60 * 1000;
    if (/\btomorrow\b/.test(lower)) return nowMs + dayMs;
    if (/\bthis week\b/.test(lower)) return nowMs + 3 * dayMs;
    if (/\bnext week\b/.test(lower)) return nowMs + 7 * dayMs;

    const inDaysMatch = lower.match(/\bin\s+(\d{1,2})\s+days?\b/);
    if (inDaysMatch) {
      const days = Number(inDaysMatch[1]);
      if (Number.isFinite(days) && days > 0) return nowMs + days * dayMs;
    }

    const isoDateMatch = lower.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
    if (isoDateMatch) {
      const parsed = Date.parse(
        `${isoDateMatch[1]}-${isoDateMatch[2]}-${isoDateMatch[3]}T17:00:00`,
      );
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
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

    return {
      items: Array.isArray(profile.items)
        ? profile.items
            .filter(
              (item) => !!item && typeof item.id === "string" && typeof item.text === "string",
            )
            .map((item) => ({
              id: item.id,
              layer: item.layer,
              text: this.normalizeText(item.text),
              confidence: clamp(Number(item.confidence ?? 0.65), 0, 1),
              source:
                item.source === "feedback" || item.source === "task" ? item.source : "conversation",
              createdAt: Number(item.createdAt || Date.now()),
              updatedAt: Number(item.updatedAt || Date.now()),
              lastTaskId: typeof item.lastTaskId === "string" ? item.lastTaskId : undefined,
              status: item.status === "done" ? "done" : item.status === "open" ? "open" : undefined,
              dueAt:
                typeof item.dueAt === "number" && Number.isFinite(item.dueAt)
                  ? Math.floor(item.dueAt)
                  : undefined,
            }))
        : [],
      updatedAt: Number(profile.updatedAt || 0),
    };
  }

  private static save(profile: RelationshipMemoryProfile): void {
    const next: RelationshipMemoryProfile = {
      items: this.sort(profile.items).slice(0, MAX_ITEMS),
      updatedAt: Date.now(),
    };

    this.inMemoryProfile = next;
    if (!SecureSettingsRepository.isInitialized()) return;
    try {
      const repo = SecureSettingsRepository.getInstance();
      repo.save(STORAGE_KEY, next);
    } catch {
      // keep in-memory fallback only
    }
  }
}
