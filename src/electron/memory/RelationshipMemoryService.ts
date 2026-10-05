/**
 * Commitments and contact memory, as a view of `memory_items` (docs/memory-engine.md §5).
 *
 * The SecureSettings `relationship-memory` blob is retired. What it held lives in
 * `memory_items`:
 * - commitments: kind `commitment`; open = `active`, done = `archived`; the due date is
 *   `source_ref.dueAt`. Global for the user's own commitments, contact scope for those
 *   taken from mail;
 * - facts and context about the user: global items (UserProfileService lists them);
 * - mailbox insights: contact-scope `third_party` items, private (contact id, else
 *   `company:<id>`, else `unattributed`);
 * - task-completion history is not kept: it is episodic and lives in the archive.
 *
 * The open / due-soon lists are synchronous (Awareness, AutonomyEngine) and come from the
 * facts snapshot, which every write here refreshes before it returns.
 */
import { createHash } from "crypto";
import { collapseWhitespace } from "../database/fts-query";
import { createLogger } from "../utils/logger";
import { MemoryFactsSnapshot } from "./memory-facts-snapshot";
import { reviseMemoryItem } from "./memory-item-revise";
import { MEMORY_LANE_STORES } from "./memory-items-lanes";
import type { MemoryItem, MemoryItemKind, MemoryItemStatus } from "./memory-items-types";
import { MemoryItemsHubService } from "./MemoryItemsHubService";
import { MemoryWriter } from "./MemoryWriter";

const logger = createLogger("RelationshipMemory");

export type RelationshipLayer = "identity" | "preferences" | "context" | "commitments";
/**
 * Where an item came from. "mailbox" items are third-party text (email subjects,
 * summaries, sender names, extracted commitments) and are not trusted as facts about
 * the user: they stay available to mailbox features but are never rendered into the
 * user's own prompt context.
 */
export type RelationshipSource = "conversation" | "feedback" | "task" | "mailbox";

/** A relationship-layer memory item, in the shape the commitments UI and IPC use. */
export interface RelationshipMemoryItem {
  /** The memory item id. */
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

/** Source ref store of mailbox insights (contact-scope, third-party). */
export const MAILBOX_MEMORY_STORE = "mailbox";

const MAX_TEXT_LENGTH = 220;
const LIST_LIMIT = 500;

const LAYER_KINDS: Record<RelationshipLayer, MemoryItemKind> = {
  identity: "identity",
  preferences: "preference",
  context: "insight",
  commitments: "commitment",
};

const KIND_LAYERS: Partial<Record<MemoryItemKind, RelationshipLayer>> = {
  identity: "identity",
  preference: "preferences",
  insight: "context",
  commitment: "commitments",
};

function normalizeText(value: string): string {
  return collapseWhitespace(value || "", MAX_TEXT_LENGTH);
}

function contactScopeRef(scope: { contactIdentityId?: string; companyId?: string }): string {
  if (scope.contactIdentityId) return scope.contactIdentityId;
  if (scope.companyId) return `company:${scope.companyId}`;
  return "unattributed";
}

/** Contact and company of a contact-scope item, from its scope ref and provenance. */
function contactOf(item: MemoryItem): { contactIdentityId?: string; companyId?: string } {
  if (item.scope !== "contact" || !item.scopeRef) return {};
  const companyFromRef =
    typeof item.sourceRef.companyId === "string" ? item.sourceRef.companyId : undefined;
  if (item.scopeRef.startsWith("company:")) {
    return { companyId: item.scopeRef.slice("company:".length) || companyFromRef };
  }
  if (item.scopeRef === "unattributed" || item.scopeRef.startsWith("gateway:")) {
    return companyFromRef ? { companyId: companyFromRef } : {};
  }
  return {
    contactIdentityId: item.scopeRef,
    ...(companyFromRef ? { companyId: companyFromRef } : {}),
  };
}

function dueAtOf(item: MemoryItem): number | undefined {
  const value = item.sourceRef.dueAt;
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;
}

/** A memory item as a relationship item, or null for kinds outside the relationship layers. */
export function toRelationshipItem(item: MemoryItem): RelationshipMemoryItem | null {
  const layer = KIND_LAYERS[item.kind];
  if (!layer) return null;
  const source: RelationshipSource =
    item.source === "third_party"
      ? "mailbox"
      : item.source === "user_confirmed"
        ? "feedback"
        : item.source === "system"
          ? "task"
          : "conversation";
  const dueAt = dueAtOf(item);
  return {
    id: item.id,
    layer,
    text: item.content,
    confidence: item.confidence,
    source,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.taskId ? { lastTaskId: item.taskId } : {}),
    ...(layer === "commitments" ? { status: item.status === "active" ? "open" : "done" } : {}),
    ...(dueAt !== undefined ? { dueAt } : {}),
    ...contactOf(item),
  };
}

/** Open first by due date, then confidence, then recency (the previous list order). */
function sortItems(items: RelationshipMemoryItem[]): RelationshipMemoryItem[] {
  return [...items].sort((a, b) => {
    const dueA = a.status === "open" ? (a.dueAt ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
    const dueB = b.status === "open" ? (b.dueAt ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
    if (dueA !== dueB) return dueA - dueB;
    if ((a.status === "open") !== (b.status === "open")) return a.status === "open" ? -1 : 1;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return b.updatedAt - a.updatedAt;
  });
}

/**
 * Items of a contact first, then of its company, then items about the user (global);
 * without a contact or company, every item.
 */
function filterByContact(
  items: RelationshipMemoryItem[],
  scope: { contactIdentityId?: string; companyId?: string },
): RelationshipMemoryItem[] {
  if (!scope.contactIdentityId && !scope.companyId) return items;
  const contact = scope.contactIdentityId
    ? items.filter((item) => item.contactIdentityId === scope.contactIdentityId)
    : [];
  const company = scope.companyId
    ? items.filter((item) => !item.contactIdentityId && item.companyId === scope.companyId)
    : [];
  const global = items.filter((item) => !item.contactIdentityId && !item.companyId);
  return [...contact, ...company, ...global];
}

/** Stable record id of a mailbox insight, so a repeat is an edit of the same record. */
function mailboxRecordId(scopeRef: string, kind: MemoryItemKind, text: string): string {
  return createHash("sha256")
    .update(`${scopeRef}\n${kind}\n${text.toLowerCase()}`)
    .digest("hex")
    .slice(0, 32);
}

export class RelationshipMemoryService {
  /**
   * Relationship-layer items (identity, preferences, context, commitments) from
   * `memory_items`: global items and contact items. Done commitments only with
   * `includeDone`.
   */
  static async listItems(
    params: {
      layer?: RelationshipLayer;
      includeDone?: boolean;
      limit?: number;
      contactIdentityId?: string;
      companyId?: string;
      /** Drop third-party ("mailbox") items, for callers that render into prompts. */
      excludeThirdParty?: boolean;
    } = {},
  ): Promise<RelationshipMemoryItem[]> {
    const repository = MemoryWriter.get()?.repository;
    if (!repository) return [];
    const kinds = params.layer
      ? [LAYER_KINDS[params.layer]]
      : (Object.values(LAYER_KINDS) as MemoryItemKind[]);
    const statuses: MemoryItemStatus[] = params.includeDone ? ["active", "archived"] : ["active"];
    const rows = await repository.list({
      kinds,
      statuses,
      includePrivate: true,
      limit: LIST_LIMIT,
    });
    const items = rows
      .filter((item) => item.scope === "global" || item.scope === "contact")
      // Archived non-commitments were removed (a forget, a kit line); only a done
      // commitment is a closed relationship item.
      .filter((item) => item.status === "active" || item.kind === "commitment")
      .map(toRelationshipItem)
      .filter((item): item is RelationshipMemoryItem => item !== null)
      .filter((item) => !params.excludeThirdParty || !this.isThirdPartyItem(item));
    const limit = Math.max(1, params.limit ?? 80);
    return filterByContact(sortItems(items), params).slice(0, limit);
  }

  /** Open commitments (snapshot), optionally of one contact or company. */
  static listOpenCommitments(
    limit = 20,
    scope?: { contactIdentityId?: string; companyId?: string },
  ): RelationshipMemoryItem[] {
    const items = MemoryFactsSnapshot.items()
      .filter((item) => item.kind === "commitment" && item.status === "active")
      .filter((item) => item.scope === "global" || item.scope === "contact")
      .map(toRelationshipItem)
      .filter((item): item is RelationshipMemoryItem => item !== null);
    return filterByContact(sortItems(items), scope ?? {}).slice(0, Math.max(1, limit));
  }

  /** Open commitments due within `windowHours` (overdue included), soonest first. */
  static listDueSoonCommitments(
    windowHours = 72,
    nowMs = Date.now(),
    scope?: { contactIdentityId?: string; companyId?: string },
  ): RelationshipMemoryItem[] {
    const cutoff = nowMs + Math.max(1, Math.floor(windowHours)) * 60 * 60 * 1000;
    return this.listOpenCommitments(LIST_LIMIT, scope)
      .filter((item) => typeof item.dueAt === "number" && item.dueAt <= cutoff)
      .sort((a, b) => Number(a.dueAt || 0) - Number(b.dueAt || 0));
  }

  /**
   * Change an item: text (a new revision), confidence, a commitment's status (done
   * archives it, open reopens it) or due date. Returns the item as it is now, or null when
   * it does not exist or is not a relationship item.
   */
  static async updateItem(
    id: string,
    patch: {
      text?: string;
      confidence?: number;
      status?: "open" | "done";
      dueAt?: number | null;
    },
  ): Promise<RelationshipMemoryItem | null> {
    const writer = MemoryWriter.get();
    if (!writer) return null;
    const item = await writer.repository.findById(id);
    if (!item || !toRelationshipItem(item)) return null;
    if (item.scope !== "global" && item.scope !== "contact") return null;
    if (item.status !== "active" && !(item.kind === "commitment" && item.status === "archived")) {
      return null;
    }

    let current: MemoryItem = item;
    const text = typeof patch.text === "string" ? normalizeText(patch.text) : undefined;
    if (typeof patch.text === "string" && !text) throw new Error("Item text is required");

    if (patch.status === "done" && item.kind === "commitment") {
      if (item.status === "active") {
        await writer.setStatus(item.id, "archived");
        current = (await writer.repository.findById(item.id)) ?? item;
      }
    } else {
      const reopen = patch.status === "open" && item.status === "archived";
      const sourceRefPatch: Record<string, unknown> = {};
      // null, not undefined: the cleared field must override the stored one.
      if (patch.dueAt === null) sourceRefPatch.dueAt = null;
      else if (typeof patch.dueAt === "number" && Number.isFinite(patch.dueAt)) {
        sourceRefPatch.dueAt = Math.floor(patch.dueAt);
      }
      const changes =
        reopen ||
        (text !== undefined && text !== item.content) ||
        typeof patch.confidence === "number" ||
        Object.keys(sourceRefPatch).length > 0;
      if (changes && (item.status === "active" || reopen)) {
        const result = await reviseMemoryItem(
          writer,
          item,
          {
            content: text,
            confidence:
              typeof patch.confidence === "number"
                ? Math.max(0, Math.min(1, patch.confidence))
                : undefined,
            sourceRefPatch,
          },
          MEMORY_LANE_STORES.relationship,
        );
        if (result.status === "written") current = result.item;
      }
    }
    await MemoryFactsSnapshot.refresh();
    return toRelationshipItem(current);
  }

  /** Forget an item and its older revisions (tombstones, as in the Memory Hub). */
  static async deleteItem(id: string): Promise<boolean> {
    const writer = MemoryWriter.get();
    if (!writer) return false;
    const item = await writer.repository.findById(id);
    if (!item || !toRelationshipItem(item) || item.status === "deleted") return false;
    if (item.scope !== "global" && item.scope !== "contact") return false;
    await new MemoryItemsHubService({ getWriter: () => writer }).removeItem(item, "deleted");
    await MemoryFactsSnapshot.refresh();
    return true;
  }

  /**
   * A finished task closes the open commitments its result summary reports as done. The
   * completion itself is not stored here: task history is episodic and lives in the archive.
   */
  static async recordTaskCompletion(
    title: string,
    resultSummary?: string,
    _taskId?: string,
    _taskSource?: string,
  ): Promise<void> {
    if (!String(title || "").trim()) return;
    const summary = normalizeText(String(resultSummary || "")).toLowerCase();
    if (!summary || !/\b(done|completed|finished|shipped)\b/i.test(summary)) return;
    const writer = MemoryWriter.get();
    if (!writer) return;
    const open = await writer.repository.list({
      kinds: ["commitment"],
      statuses: ["active"],
      includePrivate: true,
      limit: LIST_LIMIT,
    });
    let closed = 0;
    for (const item of open) {
      if (item.scope !== "global" && item.scope !== "contact") continue;
      const signal = normalizeText(item.content)
        .toLowerCase()
        .replace(/^remind me to\s+/, "");
      if (signal && summary.includes(signal.slice(0, Math.min(signal.length, 40)))) {
        await writer.setStatus(item.id, "archived");
        closed += 1;
      }
    }
    if (closed > 0) await MemoryFactsSnapshot.refresh();
  }

  /**
   * Mailbox facts and commitments: third-party text, so contact-scope (the contact, else
   * its company, else `unattributed`) and private. A repeat of the same text for the same
   * contact is an edit of the same record (a new due date replaces the old one; a done
   * commitment that is mailed again is reopened).
   */
  static async rememberMailboxInsights(params: {
    facts?: string[];
    commitments?: Array<{ text: string; dueAt?: number }>;
    taskId?: string;
    contactIdentityId?: string;
    companyId?: string;
  }): Promise<void> {
    const writer = MemoryWriter.get();
    if (!writer) return;
    const scopeRef = contactScopeRef(params);
    const write = async (
      kind: MemoryItemKind,
      rawText: string,
      confidence: number,
      dueAt?: number,
    ): Promise<void> => {
      const text = normalizeText(rawText);
      if (!text) return;
      try {
        await writer.ingest({
          content: text,
          kind,
          scope: "contact",
          scopeRef,
          source: "third_party",
          sourceRef: {
            store: MAILBOX_MEMORY_STORE,
            id: mailboxRecordId(scopeRef, kind, text),
            ...(typeof dueAt === "number" && Number.isFinite(dueAt)
              ? { dueAt: Math.floor(dueAt) }
              : {}),
            ...(params.companyId ? { companyId: params.companyId } : {}),
          },
          confidence,
          privacy: "private",
          taskId: params.taskId ?? null,
          originText: text,
        });
      } catch (error) {
        logger.warn("Recording a mailbox insight failed:", error);
      }
    };
    for (const fact of (Array.isArray(params.facts) ? params.facts : []).slice(0, 4)) {
      await write("insight", fact, 0.7);
    }
    const commitments = (Array.isArray(params.commitments) ? params.commitments : []).slice(0, 6);
    for (const commitment of commitments) {
      await write("commitment", commitment.text, 0.82, commitment.dueAt);
    }
    // Contact facts are not in the snapshot; commitments are (the open / due-soon lists).
    if (commitments.length > 0) await MemoryFactsSnapshot.refresh();
  }

  /** True for items whose text came from a third party (e.g. an email sender). */
  static isThirdPartyItem(item: Pick<RelationshipMemoryItem, "source">): boolean {
    return item.source === "mailbox";
  }
}
