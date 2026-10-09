import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { sanitizeHistoryUrl } from "../../shared/browser-profile";

/** One page in the in-app browser's history, per browser profile (workspace). */
export interface BrowserHistoryEntry {
  id: string;
  profileKey: string;
  url: string;
  title: string;
  faviconUrl?: string;
  visitCount: number;
  firstVisitAt: number;
  lastVisitAt: number;
}

export interface BrowserHistoryVisitInput {
  profileKey: string;
  url: string;
  title?: string;
  faviconUrl?: string;
  tabId?: string;
  taskId?: string;
  visitedAt?: number;
}

/** Pages kept per profile; the least recently visited beyond this are dropped. */
export const MAX_BROWSER_HISTORY_ENTRIES = 10_000;
const PRUNE_SLACK = 250;
const MAX_VISITS_PER_ENTRY = 50;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/**
 * Browsing history of the in-app browser. Stores URLs and titles only:
 * credentials, fragments and secret-looking query parameters are removed
 * before anything is written, and non-web URLs are never recorded.
 */
export class BrowserHistoryStore {
  constructor(private db: Database.Database) {}

  /** Record a visit; returns the entry, or null when the URL is not recordable. */
  recordVisit(input: BrowserHistoryVisitInput): BrowserHistoryEntry | null {
    const url = sanitizeHistoryUrl(input.url);
    if (!url || !input.profileKey) return null;
    const now = input.visitedAt ?? Date.now();
    const title = String(input.title || "").slice(0, 500);
    const favicon =
      typeof input.faviconUrl === "string" && /^https?:/i.test(input.faviconUrl)
        ? input.faviconUrl.slice(0, 2048)
        : null;
    const existing = this.db
      .prepare("SELECT id FROM browser_history WHERE profile_key = ? AND url = ?")
      .get(input.profileKey, url) as { id: string } | undefined;
    const id = existing?.id || uuidv4();
    if (existing) {
      this.db
        .prepare(
          `UPDATE browser_history
             SET visit_count = visit_count + 1,
                 last_visit_at = ?,
                 title = CASE WHEN ? <> '' THEN ? ELSE title END,
                 favicon_url = COALESCE(?, favicon_url)
           WHERE id = ?`,
        )
        .run(now, title, title, favicon, id);
    } else {
      this.db
        .prepare(
          `INSERT INTO browser_history
             (id, profile_key, url, title, favicon_url, visit_count, first_visit_at, last_visit_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(id, input.profileKey, url, title, favicon, now, now);
    }
    this.db
      .prepare(
        "INSERT INTO browser_history_visits (history_id, visited_at, tab_id, task_id) VALUES (?, ?, ?, ?)",
      )
      .run(id, now, input.tabId?.slice(0, 120) || null, input.taskId?.slice(0, 120) || null);
    this.db
      .prepare(
        `DELETE FROM browser_history_visits
          WHERE history_id = ?
            AND rowid NOT IN (
              SELECT rowid FROM browser_history_visits
               WHERE history_id = ? ORDER BY visited_at DESC LIMIT ?
            )`,
      )
      .run(id, id, MAX_VISITS_PER_ENTRY);
    this.prune(input.profileKey);
    return this.findById(id) || null;
  }

  /** Update the title or favicon of the page last visited at a URL. */
  updatePage(input: {
    profileKey: string;
    url: string;
    title?: string;
    faviconUrl?: string;
  }): void {
    const url = sanitizeHistoryUrl(input.url);
    if (!url) return;
    if (typeof input.title === "string" && input.title.trim()) {
      this.db
        .prepare("UPDATE browser_history SET title = ? WHERE profile_key = ? AND url = ?")
        .run(input.title.slice(0, 500), input.profileKey, url);
    }
    if (typeof input.faviconUrl === "string" && /^https?:/i.test(input.faviconUrl)) {
      this.db
        .prepare("UPDATE browser_history SET favicon_url = ? WHERE profile_key = ? AND url = ?")
        .run(input.faviconUrl.slice(0, 2048), input.profileKey, url);
    }
  }

  findById(id: string): BrowserHistoryEntry | undefined {
    const row = this.db.prepare("SELECT * FROM browser_history WHERE id = ?").get(id) as Any;
    return row ? mapRow(row) : undefined;
  }

  /**
   * Pages matching a query in title or URL, best first: URL prefix matches,
   * then word matches, then any match; ties by visit count and recency.
   */
  search(input: { profileKey: string; query: string; limit?: number }): BrowserHistoryEntry[] {
    const query = String(input.query || "")
      .trim()
      .toLowerCase()
      .slice(0, 200);
    const limit = Math.min(100, Math.max(1, Math.floor(Number(input.limit) || 10)));
    if (!query) return this.list({ profileKey: input.profileKey, limit });
    const like = `%${escapeLike(query)}%`;
    const rows = this.db
      .prepare(
        `SELECT *,
           CASE
             WHEN lower(url) LIKE ? ESCAPE '\\' OR lower(url) LIKE ? ESCAPE '\\'
               OR lower(url) LIKE ? ESCAPE '\\' OR lower(url) LIKE ? ESCAPE '\\' THEN 3
             WHEN lower(title) LIKE ? ESCAPE '\\' OR lower(title) LIKE ? ESCAPE '\\' THEN 2
             ELSE 1
           END AS score
         FROM browser_history
         WHERE profile_key = ? AND (lower(url) LIKE ? ESCAPE '\\' OR lower(title) LIKE ? ESCAPE '\\')
         ORDER BY score DESC, visit_count DESC, last_visit_at DESC
         LIMIT ?`,
      )
      .all(
        `https://${escapeLike(query)}%`,
        `http://${escapeLike(query)}%`,
        `https://www.${escapeLike(query)}%`,
        `http://www.${escapeLike(query)}%`,
        `${escapeLike(query)}%`,
        `% ${escapeLike(query)}%`,
        input.profileKey,
        like,
        like,
        limit,
      ) as Any[];
    return rows.map(mapRow);
  }

  /** Most recent pages first, optionally filtered by a text query. */
  list(input: {
    profileKey: string;
    limit?: number;
    offset?: number;
    query?: string;
  }): BrowserHistoryEntry[] {
    const limit = Math.min(500, Math.max(1, Math.floor(Number(input.limit) || 50)));
    const offset = Math.max(0, Math.floor(Number(input.offset) || 0));
    const query = String(input.query || "")
      .trim()
      .toLowerCase();
    if (query) {
      const like = `%${escapeLike(query)}%`;
      return (
        this.db
          .prepare(
            `SELECT * FROM browser_history
              WHERE profile_key = ? AND (lower(url) LIKE ? ESCAPE '\\' OR lower(title) LIKE ? ESCAPE '\\')
              ORDER BY last_visit_at DESC LIMIT ? OFFSET ?`,
          )
          .all(input.profileKey, like, like, limit, offset) as Any[]
      ).map(mapRow);
    }
    return (
      this.db
        .prepare(
          "SELECT * FROM browser_history WHERE profile_key = ? ORDER BY last_visit_at DESC LIMIT ? OFFSET ?",
        )
        .all(input.profileKey, limit, offset) as Any[]
    ).map(mapRow);
  }

  remove(input: { profileKey: string; ids: string[] }): number {
    const ids = input.ids.filter((id) => typeof id === "string").slice(0, 500);
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(", ");
    this.db
      .prepare(
        `DELETE FROM browser_history_visits WHERE history_id IN (
           SELECT id FROM browser_history WHERE profile_key = ? AND id IN (${placeholders}))`,
      )
      .run(input.profileKey, ...ids);
    return this.db
      .prepare(`DELETE FROM browser_history WHERE profile_key = ? AND id IN (${placeholders})`)
      .run(input.profileKey, ...ids).changes;
  }

  /** Clear history, all of it or the pages visited since a time. */
  clear(input: { profileKey: string; since?: number }): number {
    const since = Number.isFinite(input.since) ? Number(input.since) : 0;
    this.db
      .prepare(
        `DELETE FROM browser_history_visits WHERE history_id IN (
           SELECT id FROM browser_history WHERE profile_key = ? AND last_visit_at >= ?)`,
      )
      .run(input.profileKey, since);
    return this.db
      .prepare("DELETE FROM browser_history WHERE profile_key = ? AND last_visit_at >= ?")
      .run(input.profileKey, since).changes;
  }

  private prune(profileKey: string): void {
    const count = (
      this.db
        .prepare("SELECT COUNT(*) AS count FROM browser_history WHERE profile_key = ?")
        .get(profileKey) as { count: number }
    ).count;
    if (count <= MAX_BROWSER_HISTORY_ENTRIES + PRUNE_SLACK) return;
    const stale = `SELECT id FROM browser_history WHERE profile_key = ?
                    ORDER BY last_visit_at DESC LIMIT -1 OFFSET ?`;
    this.db
      .prepare(`DELETE FROM browser_history_visits WHERE history_id IN (${stale})`)
      .run(profileKey, MAX_BROWSER_HISTORY_ENTRIES);
    this.db
      .prepare(`DELETE FROM browser_history WHERE id IN (${stale})`)
      .run(profileKey, MAX_BROWSER_HISTORY_ENTRIES);
  }
}

function mapRow(row: Any): BrowserHistoryEntry {
  return {
    id: String(row.id),
    profileKey: String(row.profile_key),
    url: String(row.url),
    title: String(row.title || ""),
    ...(row.favicon_url ? { faviconUrl: String(row.favicon_url) } : {}),
    visitCount: Number(row.visit_count) || 0,
    firstVisitAt: Number(row.first_visit_at) || 0,
    lastVisitAt: Number(row.last_visit_at) || 0,
  };
}

export const BROWSER_HISTORY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS browser_history (
    id TEXT PRIMARY KEY,
    profile_key TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    favicon_url TEXT,
    visit_count INTEGER NOT NULL DEFAULT 0,
    first_visit_at INTEGER NOT NULL,
    last_visit_at INTEGER NOT NULL,
    UNIQUE(profile_key, url)
  );

  CREATE INDEX IF NOT EXISTS idx_browser_history_profile_recent
    ON browser_history(profile_key, last_visit_at DESC);

  CREATE TABLE IF NOT EXISTS browser_history_visits (
    history_id TEXT NOT NULL,
    visited_at INTEGER NOT NULL,
    tab_id TEXT,
    task_id TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_browser_history_visits_entry
    ON browser_history_visits(history_id, visited_at DESC);
`;
