import { useMemo, type ReactNode } from "react";

import { MarkdownRenderer } from "./MarkdownRenderer";
import { normalizeMarkdownForDisplay } from "./MainContent/markdown-normalization";

type InlineMarkdownNodeProps = {
  children?: ReactNode;
};

function createInlinePlanMarkdownComponents(markdownComponents: unknown) {
  const baseComponents =
    markdownComponents && typeof markdownComponents === "object"
      ? (markdownComponents as Record<string, unknown>)
      : {};

  return {
    ...baseComponents,
    // Plan rows live inside a button, so keep Markdown flow content inline.
    p: ({ children }: InlineMarkdownNodeProps) => <>{children}</>,
    // Avoid nesting another interactive element inside the plan-row button.
    a: ({ children }: InlineMarkdownNodeProps) => <span>{children}</span>,
  };
}

export function TaskStatusPlanStepDescription({
  description,
  markdownComponents,
}: {
  description: string;
  markdownComponents?: unknown;
}) {
  const inlineMarkdownComponents = useMemo(
    () => createInlinePlanMarkdownComponents(markdownComponents),
    [markdownComponents],
  );

  return (
    <span className="task-status-plan-step-description markdown-content">
      <MarkdownRenderer components={inlineMarkdownComponents}>
        {normalizeMarkdownForDisplay(description)}
      </MarkdownRenderer>
    </span>
  );
}
