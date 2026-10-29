import type { ReactNode } from "react";
import type { Components } from "react-markdown";
import { normalizeMarkdownForCollab } from "../../utils/markdown-inline-lists";
import { MarkdownRenderer } from "../MarkdownRenderer";

function ResultHeading({ children }: { children?: ReactNode }) {
  return <p className="work-view-result-heading">{children}</p>;
}

/* A summary card, not a reader: headings read as bold lines, and links and images
   show as their text so nothing in the panel navigates the app window. */
const RESULT_COMPONENTS: Components = {
  h1: ResultHeading,
  h2: ResultHeading,
  h3: ResultHeading,
  h4: ResultHeading,
  h5: ResultHeading,
  h6: ResultHeading,
  hr: () => null,
  a: ({ children }) => <span>{children}</span>,
  img: ({ alt }) => (alt ? <span>{alt}</span> : null),
};

/** A session's result summary as compact markdown (bold, code, lists) for the Work detail panel. */
export function WorkResultMarkdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className}>
      <MarkdownRenderer components={RESULT_COMPONENTS} withBreaks>
        {normalizeMarkdownForCollab(text)}
      </MarkdownRenderer>
    </div>
  );
}
