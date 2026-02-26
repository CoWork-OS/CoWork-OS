/**
 * CitationTracker — per-task citation registry.
 *
 * Intercepts results from web_search and web_fetch tools,
 * deduplicates by URL, and assigns sequential [1]..[N] indices.
 * The formatted list is injected into the system prompt so the LLM
 * can reference sources inline.
 */

import { Citation, CitationBundle } from "./types";

function extractDomain(url: string): string {
  try {
    const host = new URL(url).hostname;
    return host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export class CitationTracker {
  private citations: Citation[] = [];
  private urlIndex = new Map<string, number>(); // url → citation index

  constructor(private readonly taskId: string) {}

  /**
   * Add citations from a web_search result set.
   * Each result is expected to have { title, url, snippet }.
   */
  addFromSearch(results: Array<{ title?: string; url?: string; snippet?: string }>): void {
    if (!Array.isArray(results)) return;
    for (const r of results) {
      if (!r.url) continue;
      this.addOne({
        url: r.url,
        title: r.title || "",
        snippet: r.snippet || "",
        sourceTool: "web_search",
      });
    }
  }

  /**
   * Add a citation from a web_fetch call.
   */
  addFromFetch(url: string, title?: string): void {
    if (!url) return;
    this.addOne({
      url,
      title: title || extractDomain(url),
      snippet: "",
      sourceTool: "web_fetch",
    });
  }

  /** Return all collected citations. */
  getCitations(): Citation[] {
    return this.citations.slice();
  }

  /** Return the full bundle for event payload serialisation. */
  getBundle(): CitationBundle {
    return { taskId: this.taskId, citations: this.getCitations() };
  }

  /** How many unique sources have been tracked. */
  get count(): number {
    return this.citations.length;
  }

  /**
   * Format a compact reference list the LLM can consult when writing
   * its response.  Injected into the system prompt or appended to a
   * tool-result message.
   */
  formatForPrompt(): string {
    if (this.citations.length === 0) return "";
    const lines = this.citations.map((c) => `[${c.index}] ${c.title} — ${c.domain} (${c.url})`);
    return [
      "## Sources Collected So Far",
      ...lines,
      "",
      "When presenting findings, cite sources inline using [N] notation.",
    ].join("\n");
  }

  // ── internal ──────────────────────────────────────────────────────

  private addOne(input: { url: string; title: string; snippet: string; sourceTool: string }): void {
    const normalized = input.url.replace(/\/+$/, "").toLowerCase();
    if (this.urlIndex.has(normalized)) return; // dedupe

    const index = this.citations.length + 1;
    const citation: Citation = {
      index,
      url: input.url,
      title: input.title,
      snippet: input.snippet,
      domain: extractDomain(input.url),
      accessedAt: Date.now(),
      sourceTool: input.sourceTool,
    };

    this.citations.push(citation);
    this.urlIndex.set(normalized, index);
  }
}
