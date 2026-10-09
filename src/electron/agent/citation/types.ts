/**
 * Citation types for web research source tracking.
 * Captures and indexes sources from web_search and web_fetch tool calls.
 */

export interface Citation {
  /** Sequential citation index (1-based) */
  index: number;
  /** Source URL */
  url: string;
  /** Page title or extracted heading */
  title: string;
  /** Snippet/excerpt from the source */
  snippet: string;
  /** Domain extracted from URL (e.g. "nytimes.com") */
  domain: string;
  /** Timestamp when the source was accessed */
  accessedAt: number;
  /**
   * What produced this citation: "web_search", "web_fetch", or "answer_link"
   * (a page the final answer cited by URL without a research tool reading it).
   */
  sourceTool: string;
}

export interface CitationBundle {
  /** Task this bundle belongs to */
  taskId: string;
  /** Ordered list of citations */
  citations: Citation[];
}
