/**
 * MemoryCurator — Dreaming's deterministic curation heuristics over `memory_items`
 * (docs/memory-engine.md §9, audit §8.2 "Dreaming as the only curator").
 *
 * Pure: given the workspace's active items, recent archive outcomes and "done" signals, it
 * returns proposals. Each proposal is one operation from a fixed set (merge, resolve
 * conflict, promote, decay, expire commitment) and is classified:
 *
 *   safe   — applied automatically, logged, undoable: near-duplicate merges within the
 *            same trust, decay of unused `inferred` items, expiry of done commitments,
 *            promotion of first-party corrections/preferences/project facts seen in at
 *            least two tasks;
 *   review — queued for the user: anything touching what the user stated or confirmed,
 *            new rules, contradictions, weaker duplicates, imported or screen evidence.
 *
 * Items the user stated or confirmed are never changed automatically.
 */
import { createHash } from "crypto";
import type {
  MemoryCurationOperation,
  MemoryCurationOrigin,
  MemoryCurationPromotionKind,
  MemoryReviewEvidence,
} from "../../shared/memory-review-types";
import type { ArchiveEvidenceRow } from "./memory-curation-sql";
import { isDerivedSubjectKey, type MemoryItem, type MemoryItemKind } from "./memory-items-types";

export type CurationRisk = "safe" | "review";

export interface CurationProposal {
  operation: MemoryCurationOperation;
  fingerprint: string;
  risk: CurationRisk;
  /** Why the proposal needs review (null when safe). */
  reviewReason: string | null;
  title: string;
  rationale: string;
  confidence: number;
  evidence: MemoryReviewEvidence[];
  origin: MemoryCurationOrigin;
}

export interface CuratorInput {
  now: number;
  /** Active global and workspace items of one workspace. */
  items: MemoryItem[];
  /** Recent archive outcomes of the workspace, newest first. */
  archive: ArchiveEvidenceRow[];
  /** Conversation evidence that a commitment was done, by item id. */
  doneSignals?: Map<string, MemoryReviewEvidence[]>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Similarity at which two items of one kind say the same thing. */
export const NEAR_DUPLICATE_SIMILARITY = 0.75;
/** Similarity at which a merge is worth proposing for review. */
export const POSSIBLE_DUPLICATE_SIMILARITY = 0.6;
/** Topic overlap (polarity words removed) at which opposite statements contradict. */
export const CONTRADICTION_OVERLAP = 0.5;
/** Archive outcomes must recur in this many distinct tasks to become a fact. */
export const PROMOTION_MIN_TASKS = 2;
const PROMOTION_SIMILARITY = 0.5;
const PROMOTION_MAX_CHARS = 300;
/** Commitments this long past due are proposed for expiry even without a done signal. */
export const STALE_COMMITMENT_DAYS = 30;
/** Largest group compared pairwise (most recently updated first). */
const MAX_GROUP = 300;

/**
 * Days without use after which a low-trust item decays, by kind. Identity and rules
 * never decay automatically; commitments with a due date are handled by expiry.
 */
export const DECAY_DAYS: Readonly<Partial<Record<MemoryItemKind, number>>> = {
  preference: 180,
  project_fact: 120,
  decision: 180,
  correction: 180,
  insight: 90,
  outcome: 60,
  commitment: 90,
};

/** Trust at or below which an unused item may decay (inferred 0.5, import 0.6). */
const DECAY_MAX_TRUST = 0.6;

const PROTECTED_SOURCES = new Set(["user_stated", "user_confirmed"]);

const STOPWORDS = new Set(
  (
    "a an the and or but if then else of to in on at by for with from as is are was were be been " +
    "being it its this that these those there here i me my we our you your he she they them their " +
    "his her do does did done has have had will would should could can may might must shall so " +
    "than too very just also about into over under up down out off again more most some any all " +
    "each other such only own same what which who whom when where why how use uses used using user"
  ).split(" "),
);

const NEGATIONS = new Set([
  "not",
  "never",
  "no",
  "dont",
  "doesnt",
  "didnt",
  "isnt",
  "arent",
  "wasnt",
  "shouldnt",
  "cant",
  "cannot",
  "wont",
  "avoid",
  "stop",
  "without",
  "nor",
  "longer",
]);

/** Pairs of words that make two otherwise similar statements disagree. */
const ANTONYMS: ReadonlyArray<readonly [string, string]> = [
  ["concise", "detailed"],
  ["concise", "verbose"],
  ["short", "long"],
  ["brief", "detailed"],
  ["formal", "casual"],
  ["light", "dark"],
  ["tabs", "spaces"],
  ["enable", "disable"],
  ["enabled", "disabled"],
  ["always", "never"],
  ["allow", "forbid"],
  ["include", "exclude"],
  ["sync", "async"],
  ["before", "after"],
  ["morning", "evening"],
];
const ANTONYM_WORDS = new Set(ANTONYMS.flat());

const DONE_WORDS =
  /\b(done|completed?|finished|sent|shipped|resolved|delivered|submitted|closed|merged|paid)\b/i;

/** Lower-cased Unicode word tokens, apostrophes dropped ("don't" → "dont"). */
export function tokenize(text: string): string[] {
  return (
    String(text || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/['’`]/g, "")
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

/** Content words: stopwords and one-letter tokens removed. */
export function contentWords(text: string): Set<string> {
  return new Set(tokenize(text).filter((token) => token.length > 1 && !STOPWORDS.has(token)));
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

function sharedCount(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared;
}

function without(words: ReadonlySet<string>, drop: ReadonlySet<string>): Set<string> {
  return new Set([...words].filter((word) => !drop.has(word)));
}

function isNegated(text: string): boolean {
  return tokenize(text).some((token) => NEGATIONS.has(token));
}

function antonymConflict(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return ANTONYMS.some(
    ([x, y]) =>
      (a.has(x) && b.has(y) && !a.has(y) && !b.has(x)) ||
      (a.has(y) && b.has(x) && !a.has(x) && !b.has(y)),
  );
}

/**
 * Two statements contradict when they are about the same thing (topic overlap with
 * polarity words removed) and disagree in polarity or by an antonym pair.
 */
export function contradicts(a: string, b: string): boolean {
  const wordsA = contentWords(a);
  const wordsB = contentWords(b);
  const polarity = new Set([...NEGATIONS, ...ANTONYM_WORDS]);
  const topicA = without(wordsA, polarity);
  const topicB = without(wordsB, polarity);
  if (topicA.size === 0 || topicB.size === 0) return false;
  const overlap = jaccard(topicA, topicB);
  if (sharedCount(topicA, topicB) < 1 || overlap < CONTRADICTION_OVERLAP) return false;
  if (antonymConflict(wordsA, wordsB)) return true;
  return isNegated(a) !== isNegated(b) && sharedCount(topicA, topicB) >= 2;
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function scopeKey(item: MemoryItem): string {
  return `${item.workspaceId ?? ""}|${item.scope}|${item.scopeRef ?? ""}`;
}

function isProtected(item: MemoryItem): boolean {
  return PROTECTED_SOURCES.has(item.source);
}

function lastActivity(item: MemoryItem): number {
  return Math.max(item.lastUsedAt ?? 0, item.updatedAt, item.createdAt);
}

/** The strongest item of a group: trust, pin, reinforcement, confidence, use, recency. */
export function strongestItem(items: MemoryItem[]): MemoryItem {
  return [...items].sort(
    (a, b) =>
      b.trust - a.trust ||
      Number(b.pinned) - Number(a.pinned) ||
      b.reinforcedCount - a.reinforcedCount ||
      b.confidence - a.confidence ||
      (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) ||
      b.updatedAt - a.updatedAt ||
      a.id.localeCompare(b.id),
  )[0];
}

export function itemOperationFingerprint(operation: MemoryCurationOperation): string {
  switch (operation.op) {
    case "merge":
      return `merge:${[operation.keepId, ...operation.mergeIds].sort().join(",")}`;
    case "resolve_conflict":
      return `resolve_conflict:${[operation.keepId, ...operation.dropIds].sort().join(",")}`;
    case "decay":
    case "expire_commitment":
      return `${operation.op}:${[...operation.itemIds].sort().join(",")}`;
    case "promote":
      return `promote:${operation.kind}:${sha([...contentWords(operation.content)].sort().join(" "))}`;
  }
}

function itemEvidence(item: MemoryItem): MemoryReviewEvidence {
  return {
    kind: "item",
    ref: `memory:${item.id}`,
    snippet: clip(item.content, 240),
    at: item.updatedAt,
    taskId: item.taskId,
  };
}

function archiveEvidence(row: ArchiveEvidenceRow, text: string): MemoryReviewEvidence {
  return {
    kind: "archive",
    ref: `archive:${row.id}`,
    snippet: clip(text, 240),
    at: row.createdAt,
    taskId: row.taskId,
  };
}

export function clip(text: string, max: number): string {
  const normalized = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= max) return normalized;
  const cut = normalized.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const KIND_LABEL: Record<MemoryItemKind, string> = {
  preference: "preferences",
  identity: "identity facts",
  rule: "rules",
  project_fact: "project facts",
  decision: "decisions",
  commitment: "commitments",
  correction: "corrections",
  insight: "insights",
  outcome: "outcomes",
};

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

// ---- Duplicates and contradictions ----

function duplicateAndConflictProposals(items: MemoryItem[]): CurationProposal[] {
  const groups = new Map<string, MemoryItem[]>();
  for (const item of items) {
    // Named single-valued subjects (preferred name, response style) are unique per scope
    // already; their history is supersession, not duplication.
    if (!isDerivedSubjectKey(item.subjectKey)) continue;
    if (item.scope !== "global" && item.scope !== "workspace") continue;
    const key = `${scopeKey(item)}|${item.kind}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  const proposals: CurationProposal[] = [];
  for (const group of groups.values()) {
    const members = group.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_GROUP);
    const words = new Map(members.map((item) => [item.id, contentWords(item.content)]));
    const parent = new Map(members.map((item) => [item.id, item.id]));
    const find = (id: string): string => {
      let root = id;
      while (parent.get(root) !== root) root = parent.get(root) as string;
      parent.set(id, root);
      return root;
    };
    const similarity = new Map<string, number>();
    const possible: Array<[MemoryItem, MemoryItem, number]> = [];
    const conflicting = new Set<string>();

    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        const a = members[i];
        const b = members[j];
        const wordsA = words.get(a.id) as Set<string>;
        const wordsB = words.get(b.id) as Set<string>;
        if (Math.min(wordsA.size, wordsB.size) < 2) continue;
        if (contradicts(a.content, b.content)) {
          conflicting.add(a.id);
          conflicting.add(b.id);
          proposals.push(conflictProposal(a, b));
          continue;
        }
        const score = jaccard(wordsA, wordsB);
        if (score >= NEAR_DUPLICATE_SIMILARITY) {
          similarity.set(`${a.id}|${b.id}`, score);
          similarity.set(`${b.id}|${a.id}`, score);
          parent.set(find(a.id), find(b.id));
        } else if (score >= POSSIBLE_DUPLICATE_SIMILARITY) {
          possible.push([a, b, score]);
        }
      }
    }

    const clusters = new Map<string, MemoryItem[]>();
    for (const item of members) {
      if (conflicting.has(item.id)) continue;
      const root = find(item.id);
      const cluster = clusters.get(root) ?? [];
      cluster.push(item);
      clusters.set(root, cluster);
    }
    const merged = new Set<string>();
    for (const cluster of clusters.values()) {
      if (cluster.length < 2) continue;
      for (const item of cluster) merged.add(item.id);
      proposals.push(mergeProposal(cluster, similarity));
    }
    for (const [a, b, score] of possible) {
      if (merged.has(a.id) || merged.has(b.id) || conflicting.has(a.id) || conflicting.has(b.id)) {
        continue;
      }
      const proposal = mergeProposal([a, b], new Map([[`${a.id}|${b.id}`, score]]));
      proposals.push({
        ...proposal,
        risk: "review",
        reviewReason: `These are only ${percent(score)} alike; check they mean the same thing.`,
        confidence: score,
      });
    }
  }
  return proposals;
}

function mergeProposal(cluster: MemoryItem[], similarity: Map<string, number>): CurationProposal {
  const keep = strongestItem(cluster);
  const others = cluster.filter((item) => item.id !== keep.id);
  const scores = others.map(
    (item) =>
      similarity.get(`${keep.id}|${item.id}`) ??
      jaccard(contentWords(keep.content), contentWords(item.content)),
  );
  const minScore = Math.min(...scores);
  const operation: MemoryCurationOperation = {
    op: "merge",
    keepId: keep.id,
    mergeIds: others.map((item) => item.id),
  };
  let reviewReason: string | null = null;
  if (cluster.some(isProtected)) {
    reviewReason = "It changes something you said or confirmed.";
  } else if (new Set(cluster.map((item) => item.trust)).size > 1) {
    reviewReason = "The duplicates come from sources with different trust.";
  } else if (minScore < NEAR_DUPLICATE_SIMILARITY) {
    reviewReason = `Some of these are only ${percent(minScore)} alike.`;
  }
  return {
    operation,
    fingerprint: itemOperationFingerprint(operation),
    risk: reviewReason ? "review" : "safe",
    reviewReason,
    title: `Merge ${cluster.length} similar ${KIND_LABEL[keep.kind]}`,
    rationale:
      `Same kind and scope, ${percent(minScore)}+ word overlap. ` +
      "Keeps the strongest item (trust, pin, reinforcement) and folds the others into it.",
    confidence: Math.min(0.99, minScore),
    evidence: cluster.map(itemEvidence),
    origin: "heuristic",
  };
}

function conflictProposal(a: MemoryItem, b: MemoryItem): CurationProposal {
  const keep =
    a.trust !== b.trust ? (a.trust > b.trust ? a : b) : a.updatedAt >= b.updatedAt ? a : b;
  const drop = keep.id === a.id ? b : a;
  const operation: MemoryCurationOperation = {
    op: "resolve_conflict",
    keepId: keep.id,
    dropIds: [drop.id],
  };
  const reviewReason =
    a.trust === b.trust
      ? "Both come from equally trusted sources; you decide which one holds (the newer one is suggested)."
      : isProtected(drop) || isProtected(keep)
        ? "It changes something you said or confirmed."
        : "Resolving a contradiction changes what CoWork believes; the more trusted item is suggested.";
  return {
    operation,
    fingerprint: itemOperationFingerprint(operation),
    risk: "review",
    reviewReason,
    title: `Resolve conflicting ${KIND_LABEL[keep.kind]}`,
    rationale:
      a.trust === b.trust
        ? "These say opposite things about the same topic. Suggested: keep the newer one."
        : "These say opposite things about the same topic. Suggested: keep the more trusted one.",
    confidence: 0.7,
    evidence: [itemEvidence(keep), itemEvidence(drop)],
    origin: "heuristic",
  };
}

// ---- Decay and commitment expiry ----

function decayProposals(items: MemoryItem[], now: number): CurationProposal[] {
  const proposals: CurationProposal[] = [];
  for (const item of items) {
    if (item.pinned || isProtected(item) || item.trust > DECAY_MAX_TRUST) continue;
    if (item.kind === "commitment" && typeof item.sourceRef.dueAt === "number") continue;
    const days = DECAY_DAYS[item.kind];
    if (!days) continue;
    const allowance = days * DAY_MS * (1 + Math.min(item.reinforcedCount, 3) * 0.5);
    const idle = now - lastActivity(item);
    if (idle < allowance) continue;
    const operation: MemoryCurationOperation = { op: "decay", itemIds: [item.id] };
    const reviewReason =
      item.source === "inferred"
        ? null
        : "It was imported or recorded by the system, not inferred.";
    proposals.push({
      operation,
      fingerprint: itemOperationFingerprint(operation),
      risk: reviewReason ? "review" : "safe",
      reviewReason,
      title: `Archive an unused ${KIND_LABEL[item.kind].replace(/s$/, "")}`,
      rationale: `Not used or updated for ${Math.floor(idle / DAY_MS)} days, and it was never confirmed.`,
      confidence: 0.8,
      evidence: [itemEvidence(item)],
      origin: "heuristic",
    });
  }
  return proposals;
}

function commitmentKeywords(item: MemoryItem): Set<string> {
  return without(contentWords(item.content), new Set(["follow", "send", "reply", "commitment"]));
}

/** Archive rows after the due window that mention the commitment and a "done" word. */
function archiveDoneSignals(
  item: MemoryItem,
  dueAt: number,
  archive: ArchiveEvidenceRow[],
): MemoryReviewEvidence[] {
  const keywords = commitmentKeywords(item);
  if (keywords.size === 0) return [];
  return archive
    .filter(
      (row) =>
        row.createdAt >= dueAt - 7 * DAY_MS &&
        DONE_WORDS.test(row.content) &&
        sharedCount(keywords, contentWords(row.content)) >= Math.min(2, keywords.size),
    )
    .slice(0, 3)
    .map((row) => archiveEvidence(row, row.content));
}

function commitmentProposals(input: CuratorInput): CurationProposal[] {
  const proposals: CurationProposal[] = [];
  for (const item of input.items) {
    if (item.kind !== "commitment") continue;
    const dueAt = typeof item.sourceRef.dueAt === "number" ? item.sourceRef.dueAt : null;
    if (dueAt === null || dueAt > input.now - DAY_MS) continue;
    const done = [
      ...(input.doneSignals?.get(item.id) ?? []),
      ...archiveDoneSignals(item, dueAt, input.archive),
    ];
    const overdueDays = Math.floor((input.now - dueAt) / DAY_MS);
    if (done.length === 0 && overdueDays < STALE_COMMITMENT_DAYS) continue;
    const operation: MemoryCurationOperation = { op: "expire_commitment", itemIds: [item.id] };
    let reviewReason: string | null = null;
    if (isProtected(item)) reviewReason = "You made this commitment yourself.";
    else if (done.length === 0) {
      reviewReason = `It is ${overdueDays} days past due, but nothing shows it was done.`;
    }
    proposals.push({
      operation,
      fingerprint: itemOperationFingerprint(operation),
      risk: reviewReason ? "review" : "safe",
      reviewReason,
      title: "Close a past-due commitment",
      rationale:
        done.length > 0
          ? `Past due for ${overdueDays} day(s), and later activity says it was done.`
          : `Past due for ${overdueDays} days.`,
      confidence: done.length > 0 ? 0.8 : 0.55,
      evidence: [itemEvidence(item), ...done],
      origin: "heuristic",
    });
  }
  return proposals;
}

// ---- Promotion of recurring archive outcomes ----

const CORRECTION_MARKER = /^\s*\[CORRECTION\]/i;
const IMPORTED_PREFIX = /^\s*(?:\[cowork:prompt_recall=ignore\]\s*)?\[Imported from /i;
const FIRST_PARTY_ORIGINS = new Set(["task", "tool", "playbook", "unknown"]);

interface PromotionSource {
  row: ArchiveEvidenceRow;
  kind: MemoryCurationPromotionKind;
  text: string;
  words: Set<string>;
  thirdParty: boolean;
}

/** The user's words of a correction row, or the first meaningful line of an outcome. */
export function archiveFactText(row: Pick<ArchiveEvidenceRow, "content">): string {
  const content = String(row.content || "");
  if (CORRECTION_MARKER.test(content)) {
    const said = content.match(/User said:\s*([\s\S]*?)(?:\n\s*Task context:|$)/i);
    return clip(said?.[1] ?? "", PROMOTION_MAX_CHARS);
  }
  const line =
    content
      .split(/\r?\n/)
      .map((entry) => entry.replace(/^\s*(?:\[[A-Z_ ]+\]\s*)+/, "").trim())
      .find((entry) => /[\p{L}\p{N}]/u.test(entry)) ?? "";
  return clip(line, PROMOTION_MAX_CHARS);
}

function promotionKind(row: ArchiveEvidenceRow): MemoryCurationPromotionKind | null {
  if (CORRECTION_MARKER.test(row.content) || row.type === "correction_rule") return "correction";
  switch (row.type) {
    case "preference":
    case "timing_preference":
      return "preference";
    case "constraint":
      return "rule";
    case "decision":
    case "insight":
    case "workflow_pattern":
    case "error":
      return "project_fact";
    default:
      return null;
  }
}

function promotionProposals(input: CuratorInput): CurationProposal[] {
  const sources: PromotionSource[] = [];
  for (const row of input.archive) {
    if (row.isPrivate || !row.taskId) continue;
    const kind = promotionKind(row);
    if (!kind) continue;
    const text = archiveFactText(row);
    const words = contentWords(text);
    if (words.size < 3) continue;
    sources.push({
      row,
      kind,
      text,
      words,
      thirdParty: !FIRST_PARTY_ORIGINS.has(row.origin) || IMPORTED_PREFIX.test(row.content),
    });
  }
  const parent = sources.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    parent[index] = root;
    return root;
  };
  for (let i = 0; i < sources.length; i += 1) {
    for (let j = i + 1; j < sources.length; j += 1) {
      if (sources[i].kind !== sources[j].kind) continue;
      if (sharedCount(sources[i].words, sources[j].words) < 3) continue;
      if (jaccard(sources[i].words, sources[j].words) >= PROMOTION_SIMILARITY) {
        parent[find(i)] = find(j);
      }
    }
  }
  const clusters = new Map<number, PromotionSource[]>();
  sources.forEach((source, index) => {
    const cluster = clusters.get(find(index)) ?? [];
    cluster.push(source);
    clusters.set(find(index), cluster);
  });

  const known = input.items.map((item) => contentWords(item.content));
  const proposals: CurationProposal[] = [];
  for (const cluster of clusters.values()) {
    const taskIds = [...new Set(cluster.map((source) => source.row.taskId as string))];
    if (taskIds.length < PROMOTION_MIN_TASKS) continue;
    // The member most like the others states the fact.
    const representative = [...cluster].sort(
      (a, b) =>
        cluster.reduce((sum, other) => sum + jaccard(b.words, other.words), 0) -
          cluster.reduce((sum, other) => sum + jaccard(a.words, other.words), 0) ||
        a.text.length - b.text.length,
    )[0];
    if (
      known.some((words) => jaccard(words, representative.words) >= POSSIBLE_DUPLICATE_SIMILARITY)
    ) {
      continue;
    }
    const kind = representative.kind;
    const content =
      kind === "correction" ? `User correction: ${representative.text}` : representative.text;
    const operation: MemoryCurationOperation = {
      op: "promote",
      kind,
      content,
      evidenceIds: cluster.map((source) => source.row.id).slice(0, 12),
      taskIds: taskIds.slice(0, 12),
    };
    const thirdParty = cluster.some((source) => source.thirdParty);
    const reviewReason =
      kind === "rule"
        ? "New rules change how CoWork behaves."
        : thirdParty
          ? "Some evidence was imported or captured from the screen, not said in a task."
          : null;
    proposals.push({
      operation,
      fingerprint: itemOperationFingerprint(operation),
      risk: reviewReason ? "review" : "safe",
      reviewReason,
      title: `Remember a recurring ${kind === "project_fact" ? "project fact" : kind}`,
      rationale: `Came up in ${taskIds.length} separate tasks; saved as an inferred fact.`,
      confidence: Math.min(0.85, 0.5 + 0.1 * taskIds.length),
      evidence: cluster.slice(0, 6).map((source) => archiveEvidence(source.row, source.text)),
      origin: "heuristic",
    });
  }
  return proposals;
}

/** Every deterministic proposal for one workspace, deduplicated by fingerprint. */
export function curateMemory(input: CuratorInput): CurationProposal[] {
  const active = input.items.filter((item) => item.status === "active");
  const all = [
    ...duplicateAndConflictProposals(active),
    ...commitmentProposals({ ...input, items: active }),
    ...decayProposals(active, input.now),
    ...promotionProposals({ ...input, items: active }),
  ];
  const seen = new Set<string>();
  // One operation per item per run: a later proposal touching an item already used is dropped,
  // so applying them in order never acts on a stale view.
  const claimed = new Set<string>();
  const result: CurationProposal[] = [];
  for (const proposal of all) {
    if (seen.has(proposal.fingerprint)) continue;
    const ids = proposalItemIds(proposal.operation);
    if (ids.some((id) => claimed.has(id))) continue;
    seen.add(proposal.fingerprint);
    for (const id of ids) claimed.add(id);
    result.push(proposal);
  }
  return result;
}

/** The existing item ids an operation touches. */
export function proposalItemIds(operation: MemoryCurationOperation): string[] {
  switch (operation.op) {
    case "merge":
      return [operation.keepId, ...operation.mergeIds];
    case "resolve_conflict":
      return [operation.keepId, ...operation.dropIds];
    case "decay":
    case "expire_commitment":
      return [...operation.itemIds];
    case "promote":
      return [];
  }
}
