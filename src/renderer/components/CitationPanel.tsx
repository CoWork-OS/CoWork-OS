import React, { useState } from "react";
import { ExternalLink, ChevronDown, ChevronRight, Globe } from "lucide-react";

interface Citation {
  index: number;
  url: string;
  title: string;
  snippet: string;
  domain: string;
  accessedAt: number;
  sourceTool: string;
}

interface CitationPanelProps {
  citations: Citation[];
}

export const CitationPanel: React.FC<CitationPanelProps> = ({ citations }) => {
  const [expanded, setExpanded] = useState(true);

  if (!citations || citations.length === 0) return null;

  return (
    <div
      style={{
        marginTop: 8,
        border: "1px solid var(--border-color, #333)",
        borderRadius: 8,
        overflow: "hidden",
        background: "var(--surface-secondary, #1a1a1a)",
      }}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "8px 12px",
          border: "none",
          background: "none",
          color: "var(--text-secondary, #999)",
          cursor: "pointer",
          fontSize: 12,
          fontWeight: 500,
        }}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Globe size={14} />
        <span>
          {citations.length} source{citations.length !== 1 ? "s" : ""}
        </span>
      </button>

      {expanded && (
        <div style={{ padding: "0 12px 10px" }}>
          {citations.map((c) => (
            <div
              key={c.index}
              onClick={() => window.electronAPI?.openExternal?.(c.url)}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                padding: "6px 4px",
                borderTop: "1px solid var(--border-color, #2a2a2a)",
                borderRadius: 4,
                cursor: "pointer",
                transition: "background 0.15s",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLDivElement).style.background =
                  "var(--surface-hover, rgba(255,255,255,0.05))";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLDivElement).style.background = "transparent";
              }}
            >
              <span
                style={{
                  flexShrink: 0,
                  width: 22,
                  height: 22,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 4,
                  background: "var(--accent-bg, #2563eb22)",
                  color: "var(--accent-color, #60a5fa)",
                  fontSize: 11,
                  fontWeight: 600,
                }}
              >
                {c.index}
              </span>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <img
                    src={`https://www.google.com/s2/favicons?domain=${c.domain}&sz=16`}
                    alt=""
                    width={14}
                    height={14}
                    style={{ borderRadius: 2, flexShrink: 0 }}
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = "none";
                    }}
                  />
                  <span
                    style={{
                      color: "var(--text-primary, #e5e5e5)",
                      fontSize: 12,
                      fontWeight: 500,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                    title={c.title}
                  >
                    {c.title || c.domain}
                  </span>
                  <ExternalLink size={11} style={{ flexShrink: 0, opacity: 0.4 }} />
                </div>

                <div
                  style={{
                    fontSize: 11,
                    color: "var(--text-tertiary, #666)",
                    marginTop: 2,
                  }}
                >
                  {c.domain}
                </div>

                {c.snippet && (
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--text-secondary, #999)",
                      marginTop: 3,
                      lineHeight: 1.4,
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {c.snippet}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * Inline citation badge [N] rendered inside markdown text.
 * Clicking opens the source URL externally.
 */
export const CitationBadge: React.FC<{
  index: number;
  citation?: Citation;
}> = ({ index, citation }) => {
  const [hovered, setHovered] = useState(false);
  const isClickable = !!citation?.url;

  return (
    <span
      onClick={() => {
        if (citation?.url) {
          window.electronAPI?.openExternal?.(citation.url);
        }
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={citation ? `${citation.title} — ${citation.domain}` : `Source [${index}]`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 18,
        height: 18,
        padding: "0 4px",
        borderRadius: 4,
        background: hovered && isClickable
          ? "var(--accent-color, #60a5fa)"
          : "var(--accent-bg, #2563eb22)",
        color: hovered && isClickable
          ? "#fff"
          : "var(--accent-color, #60a5fa)",
        fontSize: 10,
        fontWeight: 600,
        cursor: isClickable ? "pointer" : "default",
        verticalAlign: "super",
        marginLeft: 1,
        marginRight: 1,
        lineHeight: 1,
        transition: "background 0.15s, color 0.15s",
      }}
    >
      {index}
    </span>
  );
};
