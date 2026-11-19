import { memo, useId, useState } from "react";
import { BookOpen, CalendarDays, ChevronRight, Globe, HardDrive } from "lucide-react";
import "./claim-sources.css";

export type ClaimSource = {
  index: number;
  url: string;
  title: string;
  domain: string;
  sourceLabel?: string;
};

function SourceIcon({ source }: { source: ClaimSource }) {
  const props = { size: 12, strokeWidth: 1.9, "aria-hidden": true } as const;
  switch (source.sourceLabel) {
    case "Google Calendar":
      return <CalendarDays {...props} />;
    case "Google Drive":
      return <HardDrive {...props} />;
    case "Notion":
      return <BookOpen {...props} />;
    default:
      return <Globe {...props} />;
  }
}

/** Where a claim's sources come from, in words: "Google Calendar", "nytimes.com", "Notion and web". */
export function claimSourcesLabel(sources: readonly ClaimSource[]): string {
  const names: string[] = [];
  for (const source of sources) {
    const name = source.sourceLabel || (sources.length === 1 ? source.domain : "web");
    if (name && !names.includes(name)) names.push(name);
  }
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

/** One distinct icon per kind of source, at most three, for the collapsed row. */
function iconSources(sources: readonly ClaimSource[]): ClaimSource[] {
  const seen = new Set<string>();
  return sources
    .filter((source) => {
      const key = source.sourceLabel || "web";
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3);
}

/**
 * The sources behind one paragraph or list of an answer: "Google Calendar · 3 sources ›",
 * opening into the list. Each source opens in the browser; the link is the provider's own page.
 */
export const ClaimSources = memo(function ClaimSources({
  sources,
}: {
  sources: readonly ClaimSource[];
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (sources.length === 0) return null;
  const count = `${sources.length} ${sources.length === 1 ? "source" : "sources"}`;
  return (
    <div className="claim-sources" data-open={open ? "true" : undefined}>
      <button
        type="button"
        className="claim-sources-toggle"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="claim-sources-icons" aria-hidden="true">
          {iconSources(sources).map((source) => (
            <span key={source.sourceLabel || "web"} className="claim-sources-icon">
              <SourceIcon source={source} />
            </span>
          ))}
        </span>
        <span className="claim-sources-label">{claimSourcesLabel(sources)}</span>
        <span className="claim-sources-count">{count}</span>
        <ChevronRight
          className="claim-sources-chevron"
          size={13}
          strokeWidth={2}
          aria-hidden="true"
        />
      </button>
      {open && (
        <ul id={listId} className="claim-sources-list">
          {sources.map((source) => (
            <li key={`${source.index}-${source.url}`}>
              <button
                type="button"
                className="claim-sources-item"
                title={source.url}
                onClick={() => window.electronAPI?.openExternal?.(source.url)}
              >
                <span className="claim-sources-index">{source.index}</span>
                <span className="claim-sources-icon" aria-hidden="true">
                  <SourceIcon source={source} />
                </span>
                <span className="claim-sources-title">{source.title}</span>
                <span className="claim-sources-origin">{source.sourceLabel || source.domain}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
