import type Database from "better-sqlite3";
import { createHash } from "crypto";
import { cosineSimilarity, createLocalEmbedding } from "../memory/local-embedding";
import type {
  MailboxAskResult,
  MailboxAttachmentRecord,
  MailboxProvider,
  MailboxThreadDetail,
} from "../../shared/mailbox";

export type MailboxSearchSource = "local_fts" | "local_vector" | "provider_search" | "attachment_text";

export interface MailboxSearchQueryPlan {
  originalQuery: string;
  normalizedQuery: string;
  tokens: string[];
  expandedTokens: string[];
  entities: string[];
  providerQueries: string[];
  wantsAttachmentEvidence: boolean;
  wantsFinancialEvidence: boolean;
  wantsDueDate: boolean;
  semanticQuery: string;
  ftsQuery?: string;
}

export interface MailboxAgentSearchOutput {
  plan: MailboxSearchQueryPlan;
  results: MailboxAskResult["results"];
  coverage: {
    localFtsCount: number;
    localVectorCount: number;
    providerCount: number;
    topScore: number;
    searchedProvider: boolean;
  };
}

export interface MailboxAgentSearchProgress {
  stepStarted(stepId: string, label: string, detail?: string, payload?: Record<string, unknown>): void;
  stepCompleted(stepId: string, label: string, detail?: string, payload?: Record<string, unknown>): void;
}

type SearchCandidate = {
  threadId: string;
  attachmentId?: string;
  snippet: string;
  score: number;
  sources: Set<MailboxSearchSource>;
  matchedFields: Set<string>;
  evidenceSnippets: string[];
  provider?: MailboxProvider;
};

type FtsSearchRow = {
  record_type: string;
  record_id: string;
  thread_id: string;
  message_id: string | null;
  attachment_id: string | null;
  snippet: string | null;
  subject: string | null;
  sender: string | null;
  body: string | null;
  attachment_filename: string | null;
  attachment_text: string | null;
  fts_score?: number;
};

type EmbeddingRow = {
  record_type: string;
  record_id: string;
  thread_id: string;
  message_id: string | null;
  attachment_id: string | null;
  snippet: string;
  embedding_json: string;
  updated_at: number;
};

const MAILBOX_SEARCH_MAX_EMBEDDING_BACKFILL = 1500;
const MAILBOX_SEARCH_MAX_VECTOR_SCAN = 4000;

const STOP_WORDS = new Set([
  "a",
  "about",
  "after",
  "an",
  "and",
  "any",
  "are",
  "bank",
  "be",
  "can",
  "could",
  "do",
  "does",
  "find",
  "for",
  "from",
  "have",
  "how",
  "i",
  "in",
  "is",
  "it",
  "make",
  "me",
  "my",
  "need",
  "of",
  "on",
  "or",
  "should",
  "the",
  "to",
  "when",
  "with",
  "you",
  "your",
]);

const FINANCIAL_EXPANSIONS: Array<{ pattern: RegExp; terms: string[] }> = [
  {
    pattern: /\b(credit\s*card|card|kart|kredi)\b/i,
    terms: ["credit", "card", "kredi", "karti", "kartiniz", "kart", "hesap", "ozeti", "ekstre"],
  },
  {
    pattern: /\b(payment|pay|due|odeme|ödem|son)\b/i,
    terms: ["payment", "due", "odeme", "odeme tarihi", "son odeme tarihi", "asgari odeme", "tutari"],
  },
  {
    pattern: /\b(statement|extract|ekstre|invoice|bill|receipt)\b/i,
    terms: ["statement", "extract", "ekstre", "hesap ozeti", "invoice", "bill", "receipt"],
  },
  {
    pattern: /\b(bank|qnb|finans|finance)\b/i,
    terms: ["bank", "qnb", "finans", "finance", "hesap"],
  },
];

export class MailboxAgentSearchService {
  constructor(
    private db: Database.Database,
    private readonly deps: {
      getThread(threadId: string): Promise<MailboxThreadDetail | null>;
      getAttachment(attachmentId: string, includeText?: boolean): MailboxAttachmentRecord | null;
      extractCandidateAttachments?(query: string): Promise<void>;
      ensureLocalSearchIndex?(): void;
      providerSearch?(
        plan: MailboxSearchQueryPlan,
        limit: number,
      ): Promise<Array<{ thread: MailboxThreadDetail; snippet?: string; score?: number }>>;
      fallbackSearch?(query: string, limit: number): Promise<MailboxAskResult["results"]>;
    },
  ) {
    this.ensureEmbeddingTable();
  }

  async search(
    query: string,
    limit: number,
    progress?: MailboxAgentSearchProgress,
  ): Promise<MailboxAgentSearchOutput> {
    progress?.stepStarted("plan_search", "Plan mailbox search", "Extracting entities, intent, and provider queries.");
    const plan = planMailboxSearchQuery(query);
    progress?.stepCompleted("plan_search", "Plan mailbox search", undefined, {
      entities: plan.entities,
      wantsAttachmentEvidence: plan.wantsAttachmentEvidence,
      wantsFinancialEvidence: plan.wantsFinancialEvidence,
      wantsDueDate: plan.wantsDueDate,
    });
    progress?.stepStarted("prepare_indexes", "Prepare local indexes", "Refreshing mailbox text and semantic search indexes.");
    this.deps.ensureLocalSearchIndex?.();
    progress?.stepStarted("extract_attachments", "Check attachments", "Reading relevant statement, invoice, PDF, and attachment text when needed.");
    await this.deps.extractCandidateAttachments?.(plan.semanticQuery);
    progress?.stepCompleted("extract_attachments", "Check attachments");
    this.backfillEmbeddingsFromFts();
    progress?.stepCompleted("prepare_indexes", "Prepare local indexes");

    const candidates = new Map<string, SearchCandidate>();
    progress?.stepStarted("local_fts", "Search local mailbox text", "Searching subjects, senders, bodies, and extracted attachment text.");
    const ftsCandidates = this.searchLocalFts(plan, limit);
    for (const candidate of ftsCandidates) mergeCandidate(candidates, candidate);
    progress?.stepCompleted("local_fts", "Search local mailbox text", `${ftsCandidates.length} local text candidate${ftsCandidates.length === 1 ? "" : "s"} found.`, {
      count: ftsCandidates.length,
    });

    progress?.stepStarted("local_vector", "Search semantic mailbox index", "Comparing the question to local message and attachment embeddings.");
    const vectorCandidates = this.searchLocalVectors(plan, limit);
    for (const candidate of vectorCandidates) mergeCandidate(candidates, candidate);
    progress?.stepCompleted("local_vector", "Search semantic mailbox index", `${vectorCandidates.length} semantic candidate${vectorCandidates.length === 1 ? "" : "s"} found.`, {
      count: vectorCandidates.length,
    });

    let providerCount = 0;
    let searchedProvider = false;
    if (this.deps.providerSearch) {
      searchedProvider = true;
      progress?.stepStarted("provider_search", "Search connected providers", "Checking Gmail and Outlook provider search where available.");
      try {
        const providerResults = await this.deps.providerSearch(plan, Math.max(limit * 2, 10));
        providerCount = providerResults.length;
        for (const result of providerResults) {
          mergeCandidate(candidates, {
            threadId: result.thread.id,
            snippet: result.snippet || result.thread.snippet,
            score: result.score ?? 45,
            sources: new Set(["provider_search"]),
            matchedFields: new Set(["provider"]),
            evidenceSnippets: [result.snippet || result.thread.snippet].filter(Boolean),
            provider: result.thread.provider,
          });
        }
      } catch {
        // Provider-native search is additive; local search should still answer.
      }
      progress?.stepCompleted("provider_search", "Search connected providers", `${providerCount} provider candidate${providerCount === 1 ? "" : "s"} found.`, {
        count: providerCount,
      });
    }

    progress?.stepStarted("shortlist_evidence", "Shortlist and read evidence", "Merging search signals and reading the best matching threads.");
    const ranked = Array.from(candidates.values())
      .map((candidate) => this.applyIntentScore(plan, candidate))
      .sort((a, b) => b.score - a.score);

    const results: MailboxAskResult["results"] = [];
    const seenThreads = new Set<string>();
    for (const candidate of ranked.slice(0, Math.max(limit * 4, 20))) {
      if (seenThreads.has(candidate.threadId)) continue;
      const detail = await this.deps.getThread(candidate.threadId);
      if (!detail) continue;
      seenThreads.add(candidate.threadId);

      const attachmentId = candidate.attachmentId || this.findBestAttachmentForThread(plan, candidate.threadId);
      const matchedAttachment = attachmentId ? this.deps.getAttachment(attachmentId, true) || undefined : undefined;
      const snippet = normalizeWhitespace(
        candidate.evidenceSnippets.find((entry) => entry.trim().length > 0) ||
          candidate.snippet ||
          detail.summary?.summary ||
          detail.snippet,
        320,
      );
      results.push({
        thread: detail,
        matchedAttachment,
        snippet,
        score: Math.round(candidate.score),
        searchSources: Array.from(candidate.sources),
        matchedFields: Array.from(candidate.matchedFields),
        evidenceSnippets: candidate.evidenceSnippets.slice(0, 4).map((entry) => normalizeWhitespace(entry, 320)),
      });
      if (results.length >= limit) break;
    }

    if (!results.length && this.deps.fallbackSearch) {
      results.push(...(await this.deps.fallbackSearch(query, limit)));
    }
    progress?.stepCompleted("shortlist_evidence", "Shortlist and read evidence", `${results.length} result${results.length === 1 ? "" : "s"} selected.`, {
      count: results.length,
      topScore: results[0]?.score ?? 0,
    });

    return {
      plan,
      results,
      coverage: {
        localFtsCount: ftsCandidates.length,
        localVectorCount: vectorCandidates.length,
        providerCount,
        topScore: results[0]?.score ?? 0,
        searchedProvider,
      },
    };
  }

  static upsertEmbeddingForPlainText(
    db: Database.Database,
    input: {
      recordType: "message" | "attachment";
      recordId: string;
      accountId?: string;
      threadId: string;
      messageId?: string | null;
      attachmentId?: string | null;
      subject?: string;
      sender?: string;
      body?: string;
      attachmentFilename?: string;
      attachmentText?: string;
    },
  ): void {
    ensureMailboxEmbeddingTable(db);
    const text = buildEmbeddingText({
      subject: input.subject || "",
      sender: input.sender || "",
      body: input.body || "",
      attachment_filename: input.attachmentFilename || "",
      attachment_text: input.attachmentText || "",
    });
    if (text.length < 3) return;
    const textHash = sha256(text);
    const existing = db
      .prepare(`SELECT source_text_hash FROM mailbox_search_embeddings WHERE record_type = ? AND record_id = ?`)
      .get(input.recordType, input.recordId) as { source_text_hash: string } | undefined;
    if (existing?.source_text_hash === textHash) return;
    db.prepare(
      `INSERT INTO mailbox_search_embeddings
        (record_type, record_id, account_id, thread_id, message_id, attachment_id, source_text_hash, embedding_json, snippet, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(record_type, record_id) DO UPDATE SET
         account_id = excluded.account_id,
         thread_id = excluded.thread_id,
         message_id = excluded.message_id,
         attachment_id = excluded.attachment_id,
         source_text_hash = excluded.source_text_hash,
         embedding_json = excluded.embedding_json,
         snippet = excluded.snippet,
         updated_at = excluded.updated_at`,
    ).run(
      input.recordType,
      input.recordId,
      input.accountId || null,
      input.threadId,
      input.messageId || null,
      input.attachmentId || null,
      textHash,
      JSON.stringify(createLocalEmbedding(text)),
      normalizeWhitespace(text, 500),
      Date.now(),
    );
  }

  private ensureEmbeddingTable(): void {
    ensureMailboxEmbeddingTable(this.db);
  }

  private backfillEmbeddingsFromFts(): void {
    try {
      const rows = this.db
        .prepare(
          `SELECT f.record_type, f.record_id, t.account_id, f.thread_id, f.message_id, f.attachment_id,
                  f.subject, f.sender, f.body, f.attachment_filename, f.attachment_text
           FROM mailbox_search_fts f
           LEFT JOIN mailbox_threads t ON t.id = f.thread_id
           LEFT JOIN mailbox_search_embeddings e
             ON e.record_type = f.record_type
            AND e.record_id = f.record_id
           WHERE e.record_id IS NULL
           LIMIT ?`,
        )
        .all(MAILBOX_SEARCH_MAX_EMBEDDING_BACKFILL) as Array<
        FtsSearchRow & {
          account_id: string | null;
        }
      >;
      for (const row of rows) {
        MailboxAgentSearchService.upsertEmbeddingForPlainText(this.db, {
          recordType: row.record_type === "attachment" ? "attachment" : "message",
          recordId: row.record_id,
          accountId: row.account_id || undefined,
          threadId: row.thread_id,
          messageId: row.message_id,
          attachmentId: row.attachment_id,
          subject: row.subject || "",
          sender: row.sender || "",
          body: row.body || "",
          attachmentFilename: row.attachment_filename || "",
          attachmentText: row.attachment_text || "",
        });
      }
    } catch {
      // FTS is optional; vector search will use any embeddings already available.
    }
  }

  private searchLocalFts(plan: MailboxSearchQueryPlan, limit: number): SearchCandidate[] {
    if (!plan.ftsQuery) return [];
    try {
      const rows = this.db
        .prepare(
          `SELECT record_type, record_id, thread_id, message_id, attachment_id,
                  snippet(mailbox_search_fts, 7, '[', ']', ' ... ', 18) AS snippet,
                  subject, sender, body, attachment_filename, attachment_text,
                  bm25(mailbox_search_fts) AS fts_score
           FROM mailbox_search_fts
           WHERE mailbox_search_fts MATCH ?
           ORDER BY fts_score ASC
           LIMIT ?`,
        )
        .all(plan.ftsQuery, Math.max(limit * 18, 100)) as FtsSearchRow[];
      return rows.map((row) => this.candidateFromFtsRow(plan, row));
    } catch {
      return [];
    }
  }

  private searchLocalVectors(plan: MailboxSearchQueryPlan, limit: number): SearchCandidate[] {
    const queryEmbedding = createLocalEmbedding(plan.semanticQuery);
    const rows = this.db
      .prepare(
        `SELECT record_type, record_id, thread_id, message_id, attachment_id, snippet, embedding_json, updated_at
         FROM mailbox_search_embeddings
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(MAILBOX_SEARCH_MAX_VECTOR_SCAN) as EmbeddingRow[];
    return rows
      .map((row) => {
        const embedding = parseEmbedding(row.embedding_json);
        const similarity = embedding ? cosineSimilarity(queryEmbedding, embedding) : 0;
        const source: MailboxSearchSource = row.record_type === "attachment" ? "attachment_text" : "local_vector";
        return {
          threadId: row.thread_id,
          attachmentId: row.attachment_id || undefined,
          snippet: row.snippet,
          score: similarity * 100,
          sources: new Set<MailboxSearchSource>([source]),
          matchedFields: new Set<string>([row.record_type === "attachment" ? "attachment" : "message"]),
          evidenceSnippets: [row.snippet],
        } satisfies SearchCandidate;
      })
      .filter((candidate) => candidate.score >= 12)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(limit * 8, 40));
  }

  private candidateFromFtsRow(plan: MailboxSearchQueryPlan, row: FtsSearchRow): SearchCandidate {
    const haystacks = {
      subject: normalizeSearchText(row.subject || ""),
      sender: normalizeSearchText(row.sender || ""),
      body: normalizeSearchText(row.body || ""),
      attachment: normalizeSearchText(`${row.attachment_filename || ""} ${row.attachment_text || ""}`),
    };
    const all = Object.values(haystacks).join(" ");
    const matchedTokens = plan.expandedTokens.filter((token) => all.includes(token));
    const exactEntityMatches = plan.entities.filter((entity) => all.includes(normalizeSearchText(entity)));
    const matchedFields = new Set<string>();
    for (const [field, text] of Object.entries(haystacks)) {
      if (plan.expandedTokens.some((token) => text.includes(token))) matchedFields.add(field);
    }
    const evidence = [
      row.snippet || "",
      row.attachment_text || "",
      row.body || "",
      row.subject || "",
    ]
      .map((entry) => normalizeWhitespace(entry, 500))
      .filter(Boolean);
    const attachmentHit = row.record_type === "attachment" || matchedFields.has("attachment");
    const source: MailboxSearchSource = attachmentHit ? "attachment_text" : "local_fts";
    const intentBonus =
      (plan.wantsFinancialEvidence && /\b(qnb|bank|credit|card|payment|due|odeme|ekstre|hesap|asgari|kredi)\b/.test(all)
        ? 28
        : 0) +
      (plan.wantsDueDate && /\b(due|date|tarih|son odeme|ödeme|odeme)\b/.test(all) ? 24 : 0) +
      (attachmentHit && plan.wantsAttachmentEvidence ? 16 : 0);
    return {
      threadId: row.thread_id,
      attachmentId: row.attachment_id || undefined,
      snippet: row.snippet || row.subject || row.body || row.attachment_text || "",
      score:
        matchedTokens.length * 10 +
        exactEntityMatches.length * 22 +
        matchedFields.size * 5 +
        intentBonus -
        Math.max(0, row.fts_score || 0),
      sources: new Set([source]),
      matchedFields,
      evidenceSnippets: evidence,
    };
  }

  private applyIntentScore(plan: MailboxSearchQueryPlan, candidate: SearchCandidate): SearchCandidate {
    const text = normalizeSearchText([candidate.snippet, ...candidate.evidenceSnippets].join(" "));
    const exactEntityMatches = plan.entities.filter((entity) => text.includes(normalizeSearchText(entity))).length;
    const dueDateEvidence = /\b(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|due|son odeme|son ödeme|tarih)\b/i.test(text);
    const financialEvidence = /\b(qnb|bank|credit|card|kredi|kart|payment|odeme|ödeme|ekstre|hesap|asgari|tutari)\b/i.test(text);
    return {
      ...candidate,
      score:
        candidate.score +
        exactEntityMatches * 18 +
        (plan.wantsDueDate && dueDateEvidence ? 18 : 0) +
        (plan.wantsFinancialEvidence && financialEvidence ? 18 : 0) +
        (candidate.sources.has("provider_search") ? 8 : 0),
    };
  }

  private findBestAttachmentForThread(plan: MailboxSearchQueryPlan, threadId: string): string | undefined {
    if (!plan.wantsAttachmentEvidence && !plan.wantsFinancialEvidence) return undefined;
    const rows = this.db
      .prepare(
        `SELECT record_id, attachment_id, attachment_filename, attachment_text
         FROM mailbox_search_fts
         WHERE record_type = 'attachment'
           AND thread_id = ?`,
      )
      .all(threadId) as Array<{
      record_id: string;
      attachment_id: string | null;
      attachment_filename: string | null;
      attachment_text: string | null;
    }>;
    let best: { id: string; score: number } | undefined;
    for (const row of rows) {
      const text = normalizeSearchText(`${row.attachment_filename || ""} ${row.attachment_text || ""}`);
      const score =
        plan.expandedTokens.filter((token) => text.includes(token)).length * 10 +
        (plan.wantsFinancialEvidence && /\b(qnb|odeme|ekstre|hesap|asgari|kredi|kart)\b/.test(text) ? 25 : 0);
      const id = row.attachment_id || row.record_id;
      if (!best || score > best.score) best = { id, score };
    }
    return best && best.score > 0 ? best.id : undefined;
  }
}

export function planMailboxSearchQuery(query: string): MailboxSearchQueryPlan {
  const normalizedQuery = normalizeSearchText(query);
  const tokens = tokenize(normalizedQuery);
  const expanded = new Set(tokens);
  for (const expansion of FINANCIAL_EXPANSIONS) {
    if (expansion.pattern.test(query)) {
      for (const term of expansion.terms) {
        for (const token of tokenize(normalizeSearchText(term))) expanded.add(token);
      }
    }
  }
  const entities = extractEntities(query, tokens);
  for (const entity of entities) {
    for (const token of tokenize(normalizeSearchText(entity))) expanded.add(token);
  }
  const expandedTokens = Array.from(expanded).filter((token) => token.length >= 2).slice(0, 28);
  const wantsAttachmentEvidence = /\b(invoice|bill|receipt|statement|extract|ekstre|pdf|attachment|file|hesap)\b/i.test(query);
  const wantsFinancialEvidence = /\b(bank|qnb|payment|pay|due|credit|card|statement|extract|invoice|bill|ekstre|odeme|ödeme|kredi|kart)\b/i.test(query);
  const wantsDueDate = /\b(when|due|date|deadline|payment|pay|son|tarih|odeme|ödeme)\b/i.test(query);
  const semanticQuery = normalizeWhitespace([query, ...expandedTokens, ...entities].join(" "), 900);
  return {
    originalQuery: query,
    normalizedQuery,
    tokens,
    expandedTokens,
    entities,
    providerQueries: buildProviderQueries(query, entities, expandedTokens, {
      wantsAttachmentEvidence,
      wantsFinancialEvidence,
      wantsDueDate,
    }),
    wantsAttachmentEvidence,
    wantsFinancialEvidence,
    wantsDueDate,
    semanticQuery,
    ftsQuery: buildFtsQuery(expandedTokens),
  };
}

export function buildMailboxAskNoEvidenceAnswer(output: MailboxAgentSearchOutput): string {
  const providerText = output.coverage.searchedProvider
    ? "local mailbox index and connected provider search"
    : "local mailbox index";
  return `I searched the ${providerText}, but I did not find reliable email evidence for this question.`;
}

function ensureMailboxEmbeddingTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mailbox_search_embeddings (
      record_type TEXT NOT NULL,
      record_id TEXT NOT NULL,
      account_id TEXT,
      thread_id TEXT NOT NULL,
      message_id TEXT,
      attachment_id TEXT,
      source_text_hash TEXT NOT NULL,
      embedding_json TEXT NOT NULL,
      snippet TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (record_type, record_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mailbox_search_embeddings_thread
      ON mailbox_search_embeddings(thread_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mailbox_search_embeddings_account
      ON mailbox_search_embeddings(account_id, updated_at DESC);
  `);
}

function mergeCandidate(candidates: Map<string, SearchCandidate>, candidate: SearchCandidate): void {
  const existing = candidates.get(candidate.threadId);
  if (!existing) {
    candidates.set(candidate.threadId, candidate);
    return;
  }
  existing.score += candidate.score * 0.72;
  if (!existing.attachmentId && candidate.attachmentId) existing.attachmentId = candidate.attachmentId;
  if (candidate.snippet && candidate.score > existing.score) existing.snippet = candidate.snippet;
  for (const source of candidate.sources) existing.sources.add(source);
  for (const field of candidate.matchedFields) existing.matchedFields.add(field);
  for (const snippet of candidate.evidenceSnippets) {
    if (snippet && !existing.evidenceSnippets.includes(snippet)) existing.evidenceSnippets.push(snippet);
  }
}

function buildEmbeddingText(row: {
  subject?: string | null;
  sender?: string | null;
  body?: string | null;
  attachment_filename?: string | null;
  attachment_text?: string | null;
}): string {
  return normalizeWhitespace(
    [
      row.subject || "",
      row.sender || "",
      row.body || "",
      row.attachment_filename || "",
      row.attachment_text || "",
    ].join("\n"),
    4000,
  );
}

function buildFtsQuery(tokens: string[]): string | undefined {
  const safeTokens = tokens
    .map((token) => token.replace(/["']/g, "").trim())
    .filter((token) => token.length >= 2)
    .slice(0, 24);
  if (!safeTokens.length) return undefined;
  return safeTokens.map((token) => `"${token}"`).join(" OR ");
}

function buildProviderQueries(
  query: string,
  entities: string[],
  expandedTokens: string[],
  intent: { wantsAttachmentEvidence: boolean; wantsFinancialEvidence: boolean; wantsDueDate: boolean },
): string[] {
  const queries = new Set<string>([query]);
  const entityText = entities.slice(0, 3).join(" ");
  const importantTokens = expandedTokens
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token))
    .slice(0, 8)
    .join(" ");
  if (entityText || importantTokens) queries.add([entityText, importantTokens].filter(Boolean).join(" "));
  if (intent.wantsFinancialEvidence) {
    queries.add([entityText, "credit card payment due statement invoice bill"].filter(Boolean).join(" "));
    queries.add([entityText, "kredi karti odeme tarihi ekstre hesap ozeti"].filter(Boolean).join(" "));
  }
  if (intent.wantsAttachmentEvidence) queries.add([entityText, "has:attachment statement invoice pdf"].filter(Boolean).join(" "));
  if (intent.wantsDueDate) queries.add([entityText, "due date payment date son odeme tarihi"].filter(Boolean).join(" "));
  return Array.from(queries)
    .map((entry) => normalizeWhitespace(entry, 160))
    .filter((entry) => entry.length > 0)
    .slice(0, 6);
}

function extractEntities(query: string, tokens: string[]): string[] {
  const entities = new Set<string>();
  for (const match of query.matchAll(/\b[A-Z0-9][A-Z0-9&.-]{1,}\b/g)) {
    const value = match[0].trim();
    if (value.length >= 2 && !STOP_WORDS.has(value.toLowerCase())) entities.add(value);
  }
  for (const token of tokens) {
    if (/^[a-z]{2,5}\d*$/.test(token) && !STOP_WORDS.has(token)) entities.add(token);
  }
  return Array.from(entities).slice(0, 8);
}

function tokenize(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[^a-z0-9]+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2 && !STOP_WORDS.has(token)),
    ),
  ).slice(0, 18);
}

function normalizeSearchText(value: string): string {
  return (value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeWhitespace(value: string, maxLength = 1000): string {
  const text = (value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function parseEmbedding(value: string): number[] | null {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((entry) => Number(entry) || 0) : null;
  } catch {
    return null;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
