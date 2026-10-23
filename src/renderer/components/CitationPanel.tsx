import React, { useState } from "react";

interface Citation {
  index: number;
  url: string;
  title: string;
  snippet: string;
  domain: string;
  accessedAt: number;
  sourceTool: string;
}

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
        background:
          hovered && isClickable ? "var(--accent-color, #60a5fa)" : "var(--accent-bg, #2563eb22)",
        color: hovered && isClickable ? "#fff" : "var(--accent-color, #60a5fa)",
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
