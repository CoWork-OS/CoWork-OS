/**
 * How each legacy memory lane maps onto memory items (docs/memory-engine.md, "Legacy
 * lanes"). Used by the one-time lane migration, and by the services that now write
 * `memory_items` directly in the same shape (profile facts, awareness beliefs, response
 * style, user name), so a fact maps the same way whichever path wrote it.
 *
 * Every candidate carries `sourceRef: { store, id }` naming the record: the migration uses
 * it to stay idempotent, and live edits use it to supersede the previous revision of the
 * same record.
 */
import type {
  AwarenessBelief,
  CuratedMemoryEntry,
  ResponseStylePreferences,
  UserFact,
  UserFactCategory,
} from "../../shared/types";
import {
  sanitizePreferredNameMemoryLine,
  sanitizeStoredPreferredName,
} from "../utils/preferred-name";
import type { MemoryCandidate } from "./MemoryWriter";
import type { MemoryItemKind, MemoryItemSource } from "./memory-items-types";

/**
 * One item of the retired SecureSettings `relationship-memory` blob, as the lane migration
 * reads it (`MemoryItemsLaneMigration.ts`).
 */
export interface LegacyRelationshipItem {
  id: string;
  layer: "identity" | "preferences" | "context" | "history" | "commitments";
  text: string;
  confidence: number;
  source: "conversation" | "feedback" | "task" | "mailbox";
  createdAt: number;
  updatedAt: number;
  lastTaskId?: string;
  status?: "open" | "done";
  dueAt?: number;
  contactIdentityId?: string;
  companyId?: string;
}

export const MEMORY_LANE_STORES = {
  curated: "curated",
  userProfile: "user_profile",
  relationship: "relationship",
  awareness: "awareness",
  adaptiveStyle: "adaptive_style",
  personality: "personality",
} as const;

type Mode = MemoryCandidate["mode"];

const CURATED_KINDS: Record<CuratedMemoryEntry["kind"], MemoryItemKind> = {
  identity: "identity",
  preference: "preference",
  constraint: "rule",
  workflow_rule: "rule",
  project_fact: "project_fact",
  active_commitment: "commitment",
};

/** The memory kind of a curated kind (`constraint` and `workflow_rule` are rules). */
export function memoryKindForCuratedKind(kind: CuratedMemoryEntry["kind"]): MemoryItemKind {
  return CURATED_KINDS[kind] ?? "project_fact";
}

/** Curated entries (Memory Hub, kit edits, distilled promotions): workspace scope. */
export function curatedEntryCandidate(
  entry: Pick<
    CuratedMemoryEntry,
    "id" | "workspaceId" | "target" | "kind" | "content" | "source" | "confidence"
  > & { taskId?: string | null; createdAt?: number },
  mode: Mode = "live",
): MemoryCandidate {
  return {
    content: entry.content,
    kind: CURATED_KINDS[entry.kind] ?? "project_fact",
    scope: "workspace",
    workspaceId: entry.workspaceId,
    // Distiller promotions are machine inferences, not curation by the user or agent.
    source: entry.source === "distill" ? "inferred" : "curated",
    sourceRef: {
      store: MEMORY_LANE_STORES.curated,
      id: entry.id,
      target: entry.target,
      curatedKind: entry.kind,
    },
    confidence: entry.confidence,
    pinned: entry.target === "user",
    taskId: entry.taskId ?? null,
    mode,
    ...(mode === "migration" && entry.createdAt ? { createdAt: entry.createdAt } : {}),
  };
}

const PROFILE_KINDS: Record<UserFactCategory, MemoryItemKind> = {
  identity: "identity",
  bio: "identity",
  work: "identity",
  preference: "preference",
  operating: "preference",
  voice: "preference",
  goal: "preference",
  accountability: "preference",
  other: "preference",
  constraint: "rule",
};

const PROFILE_SOURCES: Record<UserFact["source"], MemoryItemSource> = {
  manual: "user_stated",
  feedback: "user_confirmed",
  conversation: "inferred",
};

/**
 * User profile facts (global). Identity values that fail the preferred-name sanitizer are
 * dropped, as the profile itself drops them on load. Returns null for those.
 */
export function userFactCandidate(
  fact: UserFact,
  options: { mode?: Mode; subjectKey?: string | null } = {},
): MemoryCandidate | null {
  const value =
    fact.category === "identity" ? sanitizePreferredNameMemoryLine(fact.value) : fact.value;
  if (!value) return null;
  return {
    content: value,
    kind: PROFILE_KINDS[fact.category] ?? "preference",
    scope: "global",
    subjectKey: options.subjectKey ?? null,
    source: PROFILE_SOURCES[fact.source] ?? "inferred",
    sourceRef: { store: MEMORY_LANE_STORES.userProfile, id: fact.id, category: fact.category },
    confidence: fact.confidence,
    pinned: fact.pinned === true,
    taskId: fact.lastTaskId ?? null,
    mode: options.mode ?? "live",
    ...(options.mode === "migration" ? { createdAt: fact.firstSeenAt } : {}),
  };
}

const RELATIONSHIP_KINDS: Record<LegacyRelationshipItem["layer"], MemoryItemKind | null> = {
  identity: "identity",
  preferences: "preference",
  context: "insight",
  commitments: "commitment",
  // Task-completion history is episodic: it belongs in the archive, not the fact store.
  history: null,
};

const RELATIONSHIP_SOURCES: Record<LegacyRelationshipItem["source"], MemoryItemSource> = {
  conversation: "inferred",
  feedback: "user_confirmed",
  task: "system",
  mailbox: "third_party",
};

/**
 * Relationship items. Mailbox items are third-party text: contact scope (the contact id,
 * else `company:<id>`, else `unattributed`), private. Everything else is a global fact.
 * Done commitments are recorded as archived. History items return null.
 */
export function relationshipItemCandidate(
  item: LegacyRelationshipItem,
  mode: Mode = "live",
): MemoryCandidate | null {
  const kind = RELATIONSHIP_KINDS[item.layer];
  if (!kind) return null;
  const text = item.layer === "identity" ? sanitizePreferredNameMemoryLine(item.text) : item.text;
  if (!text) return null;
  const thirdParty = item.source === "mailbox";
  const contactRef = item.contactIdentityId
    ? item.contactIdentityId
    : item.companyId
      ? `company:${item.companyId}`
      : "unattributed";
  return {
    content: text,
    kind,
    scope: thirdParty ? "contact" : "global",
    scopeRef: thirdParty ? contactRef : null,
    source: RELATIONSHIP_SOURCES[item.source] ?? "inferred",
    sourceRef: {
      store: MEMORY_LANE_STORES.relationship,
      id: item.id,
      layer: item.layer,
      ...(typeof item.dueAt === "number" ? { dueAt: item.dueAt } : {}),
      ...(item.companyId ? { companyId: item.companyId } : {}),
    },
    confidence: item.confidence,
    privacy: thirdParty ? "private" : "normal",
    taskId: item.lastTaskId ?? null,
    status: item.status === "done" ? "archived" : "active",
    mode,
    ...(mode === "migration" ? { createdAt: item.createdAt } : {}),
  };
}

/** Awareness belief subjects that are single-valued memory subjects. */
const BELIEF_SUBJECTS: Record<string, string> = {
  preferred_name: "preferred_name",
  response_length: "response_length",
};

const BELIEF_KINDS: Partial<Record<AwarenessBelief["beliefType"], MemoryItemKind>> = {
  user_fact: "identity",
  user_preference: "preference",
  user_goal: "preference",
};

/** The memory subject for an awareness belief subject, when it is single-valued. */
export function beliefSubjectKey(subject: string): string | null {
  return BELIEF_SUBJECTS[subject] ?? null;
}

/**
 * Awareness beliefs about the user: inferred (user-confirmed once the user confirmed
 * them, or when they came from the user's feedback), global. AwarenessService writes
 * them live through this mapping; the lane migration copied the stored ones. Other belief
 * types (device context, habits, open loops) are signals, not facts, and return null.
 */
export function beliefCandidate(
  belief: AwarenessBelief,
  mode: Mode = "live",
): MemoryCandidate | null {
  const kind = BELIEF_KINDS[belief.beliefType];
  if (!kind) return null;
  const value = kind === "identity" ? sanitizePreferredNameMemoryLine(belief.value) : belief.value;
  if (!value) return null;
  return {
    content: value,
    kind,
    scope: "global",
    subjectKey: beliefSubjectKey(belief.subject),
    // Confirmed by the user, or learned from their explicit feedback.
    source:
      belief.promotionStatus === "confirmed" || belief.source === "feedback"
        ? "user_confirmed"
        : "inferred",
    sourceRef: {
      store: MEMORY_LANE_STORES.awareness,
      id: belief.id,
      beliefType: belief.beliefType,
      subject: belief.subject,
    },
    confidence: belief.confidence,
    originWorkspaceId: belief.workspaceId ?? null,
    mode,
    ...(mode === "migration" ? { createdAt: belief.createdAt } : {}),
  };
}

const LENGTH_LABEL: Record<string, string> = {
  terse: "short",
  balanced: "balanced",
  detailed: "detailed",
};

const RESPONSE_STYLE_KEYS = [
  "responseLength",
  "explanationDepth",
  "emojiUsage",
  "codeCommentStyle",
] as const;

/** The style dimensions that are set, as plain strings (stored in `source_ref.style`). */
export function pickResponseStyle(
  style: Partial<ResponseStylePreferences>,
): Partial<Record<(typeof RESPONSE_STYLE_KEYS)[number], string>> {
  const picked: Partial<Record<(typeof RESPONSE_STYLE_KEYS)[number], string>> = {};
  for (const key of RESPONSE_STYLE_KEYS) {
    const value = style[key];
    if (typeof value === "string" && value) picked[key] = value;
  }
  return picked;
}

/** One line describing the full response style, the value of the `response_style` subject. */
export function renderResponseStyle(style: Partial<ResponseStylePreferences>): string {
  const parts = [
    style.responseLength
      ? `${LENGTH_LABEL[style.responseLength] ?? style.responseLength} answers`
      : null,
    style.explanationDepth ? `${style.explanationDepth} explanation depth` : null,
    style.emojiUsage ? `${style.emojiUsage} emoji` : null,
    style.codeCommentStyle ? `${style.codeCommentStyle} code comments` : null,
  ].filter(Boolean);
  return parts.length ? `Response style: ${parts.join(", ")}.` : "";
}

/**
 * The single `response_style` subject. `adaptive_style` writes are inferred from message
 * patterns and feedback; a style the user set explicitly is user-stated and outranks them.
 */
export function responseStyleCandidate(
  style: Partial<ResponseStylePreferences>,
  origin: { source: MemoryItemSource; store: string; reason?: string; mode?: Mode },
): MemoryCandidate | null {
  const content = renderResponseStyle(style);
  if (!content) return null;
  return {
    content,
    kind: "preference",
    scope: "global",
    subjectKey: "response_style",
    source: origin.source,
    sourceRef: {
      store: origin.store,
      id: "response_style",
      ...(origin.reason ? { reason: origin.reason.slice(0, 200) } : {}),
      // The structured style (legacy lane migration; PersonalityManager is the source of truth).
      style: pickResponseStyle(style),
    },
    confidence: origin.source === "inferred" ? 0.6 : 0.95,
    mode: origin.mode ?? "live",
  };
}

/** The user's name as set with `set_user_name` or in settings. */
export function preferredNameCandidate(
  name: string,
  origin: { source: MemoryItemSource; mode?: Mode },
): MemoryCandidate | null {
  const clean = sanitizeStoredPreferredName(name);
  if (!clean) return null;
  return {
    content: `Preferred name: ${clean}`,
    kind: "identity",
    scope: "global",
    subjectKey: "preferred_name",
    source: origin.source,
    sourceRef: { store: MEMORY_LANE_STORES.personality, id: "user_name" },
    confidence: 1,
    pinned: true,
    mode: origin.mode ?? "live",
  };
}
