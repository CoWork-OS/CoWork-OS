/**
 * SuggestionSink — the single entry point for proposing a user-facing suggestion.
 *
 * Heartbeat dispatch, Workflow Intelligence, ProactiveSuggestions generators (due soon, focus,
 * chief of staff, ...) and AutonomyEngine decisions all describe the same handful of entities
 * (a commitment, an open loop, a WI target, a task). Before the sink each producer stored its
 * own suggestion and only exact titles were deduplicated, so one open loop could surface six
 * times. `propose()` merges proposals for the same entity into one suggestion that records
 * every source that proposed it.
 *
 * Entity key: an explicit key from the producer (`commitment:<id>`, `task:<id>`, a WI target
 * key, ...) or, when none is given, the normalized title with producer prefixes such as
 * "Review due soon:" / "Follow up on:" stripped. Proposals also merge when their normalized
 * titles match, so the old title dedupe is a floor, not a regression.
 *
 * Storage stays behind `SuggestionSinkStore` (ProactiveSuggestionsService today); the sink
 * only decides create vs merge vs suppress.
 */
import type {
  HeartbeatWorkspaceScope,
  ProactiveSuggestion,
  SuggestionType,
} from "../../shared/types";

export type SuggestionSource =
  | "heartbeat"
  | "workflow_intelligence"
  | "awareness"
  | "autonomy"
  | "briefing"
  | "proactive"
  | "follow_up"
  | "companion";

export interface SuggestionProposal {
  workspaceId: string;
  /** Normalized commitment/thread/task/target id. Falls back to the normalized title. */
  entityKey?: string;
  title: string;
  /** Why the suggestion matters (stored as the description). */
  why: string;
  source: SuggestionSource;
  /** Evidence refs (signal ids, task ids, memory ids). */
  evidence?: string[];
  confidence: number;
  type?: SuggestionType;
  actionPrompt?: string;
  sourceTaskId?: string;
  sourceEntity?: string;
  suggestionClass?: ProactiveSuggestion["suggestionClass"];
  urgency?: ProactiveSuggestion["urgency"];
  learningSignalIds?: string[];
  workspaceScope?: HeartbeatWorkspaceScope;
  recommendedDelivery?: ProactiveSuggestion["recommendedDelivery"];
  companionStyle?: ProactiveSuggestion["companionStyle"];
}

export interface SuggestionCreateInput {
  type: SuggestionType;
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
  entityKey: string;
  sources: string[];
}

export interface SuggestionSinkStore {
  /** Active (not dismissed, acted on or expired) suggestions, deferred ones included. */
  listActive(workspaceId: string): Promise<ProactiveSuggestion[]>;
  create(workspaceId: string, input: SuggestionCreateInput): Promise<ProactiveSuggestion | null>;
  /** Record extra sources/evidence on an existing suggestion. */
  mergeSources(
    workspaceId: string,
    suggestionId: string,
    sources: string[],
    evidence: string[],
  ): Promise<void> | void;
  /** True while the user recently dismissed or acted on a suggestion for this entity. */
  isEntitySuppressed?(workspaceId: string, entityKey: string): boolean;
}

export interface SuggestionProposalResult {
  entityKey: string;
  /** The created suggestion, or the existing one the proposal merged into. */
  suggestion: ProactiveSuggestion | null;
  created: boolean;
  merged: boolean;
  suppressed?: boolean;
}

/** Producer prefixes that describe the action, not the entity. */
const TITLE_PREFIX_RE =
  /^(?:review due soon|follow up on|follow up|decision needed|heartbeat review|workflow intelligence(?: code change)?|capture current focus|chief of staff|routine prep|prepare routine context|organize work session)\s*:\s*/i;

const RECENT_PROPOSAL_TTL_MS = 10 * 60 * 1000;

export function normalizeSuggestionTitleKey(title: string): string {
  let value = String(title || "")
    .trim()
    .toLowerCase();
  for (let i = 0; i < 3; i += 1) {
    const stripped = value.replace(TITLE_PREFIX_RE, "");
    if (stripped === value) break;
    value = stripped.trim();
  }
  return value
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 80);
}

export function normalizeSuggestionEntityKey(entityKey: string | undefined, title: string): string {
  const explicit = typeof entityKey === "string" ? entityKey.trim().toLowerCase() : "";
  if (explicit) return explicit.replace(/\s+/g, " ").slice(0, 200);
  return `title:${normalizeSuggestionTitleKey(title)}`;
}

export function commitmentEntityKey(commitmentId: string): string {
  return `commitment:${commitmentId}`;
}

function suggestionEntityKey(suggestion: ProactiveSuggestion): string {
  return normalizeSuggestionEntityKey(suggestion.entityKey, suggestion.title);
}

function uniq(values: Array<string | undefined>, limit: number): string[] {
  return Array.from(
    new Set(values.filter((value): value is string => typeof value === "string" && !!value)),
  ).slice(0, limit);
}

export class SuggestionSink {
  private queues = new Map<string, Promise<unknown>>();
  private recent = new Map<
    string,
    Map<string, { suggestion: ProactiveSuggestion; titleKey: string; at: number }>
  >();

  constructor(
    private readonly resolveStore: () => SuggestionSinkStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** Proposals are serialized per workspace so concurrent producers cannot both create. */
  propose(proposal: SuggestionProposal): Promise<SuggestionProposalResult> {
    const workspaceId = proposal.workspaceId;
    const previous = this.queues.get(workspaceId) || Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.proposeNow(proposal));
    this.queues.set(workspaceId, next);
    void next.finally(() => {
      if (this.queues.get(workspaceId) === next) this.queues.delete(workspaceId);
    });
    return next;
  }

  private async proposeNow(proposal: SuggestionProposal): Promise<SuggestionProposalResult> {
    const store = this.resolveStore();
    const workspaceId = proposal.workspaceId;
    const entityKey = normalizeSuggestionEntityKey(proposal.entityKey, proposal.title);
    const titleKey = normalizeSuggestionTitleKey(proposal.title);
    const source = proposal.source;
    const evidence = uniq(proposal.evidence || [], 12);

    if (store.isEntitySuppressed?.(workspaceId, entityKey)) {
      return { entityKey, suggestion: null, created: false, merged: false, suppressed: true };
    }

    const existing = await this.findExisting(store, workspaceId, entityKey, titleKey);
    if (existing) {
      const knownSources = existing.sources || [];
      const newSources = knownSources.includes(source) ? [] : [source];
      const knownEvidence = new Set(existing.sourceSignals || []);
      const newEvidence = evidence.filter((ref) => !knownEvidence.has(ref));
      if (newSources.length > 0 || newEvidence.length > 0) {
        await store.mergeSources(workspaceId, existing.id, newSources, newEvidence);
      }
      const merged: ProactiveSuggestion = {
        ...existing,
        sources: uniq([...knownSources, ...newSources], 12),
        sourceSignals: uniq([...(existing.sourceSignals || []), ...newEvidence], 24),
      };
      this.remember(workspaceId, entityKey, titleKey, merged);
      return { entityKey, suggestion: merged, created: false, merged: true };
    }

    const created = await store.create(workspaceId, {
      type: proposal.type || "insight",
      title: proposal.title,
      description: proposal.why,
      actionPrompt: proposal.actionPrompt,
      sourceTaskId: proposal.sourceTaskId,
      sourceEntity: proposal.sourceEntity,
      confidence: proposal.confidence,
      suggestionClass: proposal.suggestionClass,
      urgency: proposal.urgency,
      learningSignalIds: proposal.learningSignalIds,
      workspaceScope: proposal.workspaceScope,
      sourceSignals: evidence.length > 0 ? evidence : undefined,
      recommendedDelivery: proposal.recommendedDelivery,
      companionStyle: proposal.companionStyle,
      entityKey,
      sources: [source],
    });
    if (!created) {
      return { entityKey, suggestion: null, created: false, merged: false };
    }
    const withMeta: ProactiveSuggestion = {
      ...created,
      entityKey: created.entityKey || entityKey,
      sources: created.sources?.length ? created.sources : [source],
    };
    this.remember(workspaceId, entityKey, titleKey, withMeta);
    return { entityKey, suggestion: withMeta, created: true, merged: false };
  }

  private async findExisting(
    store: SuggestionSinkStore,
    workspaceId: string,
    entityKey: string,
    titleKey: string,
  ): Promise<ProactiveSuggestion | null> {
    const now = this.now();
    const recent = this.recent.get(workspaceId);
    if (recent) {
      for (const [key, entry] of recent) {
        if (now - entry.at > RECENT_PROPOSAL_TTL_MS) {
          recent.delete(key);
          continue;
        }
        if (key === entityKey || (titleKey && entry.titleKey === titleKey)) {
          return entry.suggestion;
        }
      }
    }
    const active = await store.listActive(workspaceId);
    return (
      active.find((suggestion) => suggestionEntityKey(suggestion) === entityKey) ||
      (titleKey
        ? active.find((suggestion) => normalizeSuggestionTitleKey(suggestion.title) === titleKey)
        : undefined) ||
      null
    );
  }

  private remember(
    workspaceId: string,
    entityKey: string,
    titleKey: string,
    suggestion: ProactiveSuggestion,
  ): void {
    let recent = this.recent.get(workspaceId);
    if (!recent) {
      recent = new Map();
      this.recent.set(workspaceId, recent);
    }
    recent.set(entityKey, { suggestion, titleKey, at: this.now() });
  }

  /** Forget cached proposals (after a dismiss/act-on, or in tests). */
  forget(workspaceId?: string): void {
    if (workspaceId) this.recent.delete(workspaceId);
    else this.recent.clear();
  }
}

let sharedSink: SuggestionSink | null = null;
let storeResolver: (() => SuggestionSinkStore) | null = null;

/**
 * Register the storage behind the shared sink. ProactiveSuggestionsService registers itself
 * when its module loads; tests can register a fake.
 */
export function setSuggestionSinkStore(resolver: (() => SuggestionSinkStore) | null): void {
  storeResolver = resolver;
  sharedSink = null;
}

export function getSuggestionSink(): SuggestionSink {
  if (!sharedSink) {
    sharedSink = new SuggestionSink(() => {
      if (!storeResolver) throw new Error("Suggestion storage is not registered.");
      return storeResolver();
    });
  }
  return sharedSink;
}

/** `SuggestionSink.propose(...)` via the shared instance. */
export function proposeSuggestion(proposal: SuggestionProposal): Promise<SuggestionProposalResult> {
  return getSuggestionSink().propose(proposal);
}
