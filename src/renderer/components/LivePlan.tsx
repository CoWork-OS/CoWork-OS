import { ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { memo, useEffect, useId, useRef, useState } from "react";

import {
  LIVE_PLAN_MAX_ROWS,
  collapsedLivePlanRow,
  windowLivePlanRows,
  type LivePlanItem,
  type LivePlanItemStatus,
  type LivePlanModel,
} from "../utils/live-plan";
import { TaskStatusPlanStepDescription } from "./TaskStatusPlanStepDescription";

/** `.live-plan.is-leaving` in main-content.css: a 420ms hold, then a 420ms fold. */
const LEAVE_MS = 900;
/** How long a row keeps its "just changed" class, so its glyph animation can finish. */
const CHANGE_HIGHLIGHT_MS = 700;
/** Remembers across tasks whether the user folded the plan down to its current step. */
const COLLAPSED_KEY = "cowork:live-plan:collapsed";

function readCollapsed(): boolean {
  try {
    return window.localStorage?.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    window.localStorage?.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // Storage can be unavailable; the toggle still works for this session.
  }
}

const STATUS_TEXT: Record<LivePlanItemStatus, string> = {
  pending: "Not started",
  active: "In progress",
  done: "Done",
  skipped: "Skipped",
  blocked: "Blocked",
  failed: "Failed",
};

/** Tooltip text: the label without Markdown emphasis or code marks. */
function plainLabel(label: string): string {
  return label.replace(/[*`]/g, "");
}

// The check is cut out of the disc, so it shows the surface behind it on any theme.
function DoneGlyph() {
  const maskId = `live-plan-check-${useId().replace(/[^\w-]/g, "")}`;
  return (
    <>
      <mask id={maskId}>
        <rect width="16" height="16" fill="white" />
        <path
          className="live-plan-glyph-check"
          d="M5.1 8.2 7.1 10.1 10.9 6.1"
          pathLength="10"
          stroke="black"
        />
      </mask>
      <circle className="live-plan-glyph-fill" cx="8" cy="8" r="7" mask={`url(#${maskId})`} />
    </>
  );
}

function LivePlanGlyph({ status }: { status: LivePlanItemStatus }) {
  return (
    <svg className="live-plan-glyph" viewBox="0 0 16 16" aria-hidden="true">
      {status === "done" ? (
        <DoneGlyph />
      ) : status === "active" ? (
        <circle
          className="live-plan-glyph-ring is-turning"
          cx="8"
          cy="8"
          r="6.25"
          pathLength="24"
        />
      ) : status === "skipped" ? (
        <>
          <circle className="live-plan-glyph-ring is-dashed" cx="8" cy="8" r="6.25" />
          <path className="live-plan-glyph-mark" d="M5.5 8h5" />
        </>
      ) : status === "blocked" || status === "failed" ? (
        <>
          <circle className="live-plan-glyph-ring" cx="8" cy="8" r="6.25" />
          <path className="live-plan-glyph-mark" d="M8 4.9v3.6M8 10.9v.2" />
        </>
      ) : (
        <circle className="live-plan-glyph-ring" cx="8" cy="8" r="6.25" />
      )}
    </svg>
  );
}

/**
 * Remembers when each item last changed status, so only a real transition (not the
 * first paint or an unrelated re-render) plays the row's change animation.
 */
function useRecentStatusChanges(items: LivePlanItem[] | undefined, scopeKey: string): Set<string> {
  const previousRef = useRef(new Map<string, LivePlanItemStatus>());
  const changedAtRef = useRef(new Map<string, number>());
  const scopeRef = useRef(scopeKey);
  const [, forceRender] = useState(0);
  const now = Date.now();

  // Another task's plan may reuse the same step ids; never compare across tasks.
  if (scopeRef.current !== scopeKey) {
    scopeRef.current = scopeKey;
    previousRef.current = new Map();
    changedAtRef.current = new Map();
  }

  for (const item of items ?? []) {
    const previous = previousRef.current.get(item.id);
    if (previous !== undefined && previous !== item.status) changedAtRef.current.set(item.id, now);
  }
  const recent = new Set<string>();
  for (const [id, at] of changedAtRef.current) {
    if (now - at < CHANGE_HIGHLIGHT_MS) recent.add(id);
  }

  useEffect(() => {
    previousRef.current = new Map((items ?? []).map((item) => [item.id, item.status]));
  }, [items]);

  // Drop the class once the animation has run, even if nothing else re-renders.
  const hasRecent = recent.size > 0;
  useEffect(() => {
    if (!hasRecent) return;
    const timer = setTimeout(() => forceRender((value) => value + 1), CHANGE_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [hasRecent, items]);

  return recent;
}

interface LivePlanProps {
  plan: LivePlanModel | null;
  /** Identifies the task; a finished plan only folds away within the same task. */
  scopeKey: string;
  replay?: boolean;
  markdownComponents?: unknown;
  /** The activity group a row jumps to, when it has one. */
  getItemTarget?: (item: LivePlanItem) => string | undefined;
  onSelectTarget?: (target: string) => void;
}

export const LivePlan = memo(function LivePlan({
  plan,
  scopeKey,
  replay = false,
  markdownComponents,
  getItemTarget,
  onSelectTarget,
}: LivePlanProps) {
  // Hold the last plan for one fold-away transition when the task stops running.
  const [held, setHeld] = useState<{
    plan: LivePlanModel;
    scopeKey: string;
    leaving: boolean;
  } | null>(null);
  if (plan && (held?.plan !== plan || held.scopeKey !== scopeKey || held.leaving)) {
    setHeld({ plan, scopeKey, leaving: false });
  } else if (!plan && held && !held.leaving) {
    setHeld(held.scopeKey === scopeKey && !replay ? { ...held, leaving: true } : null);
  }
  const leaving = !plan && held?.leaving === true;
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setHeld(null), LEAVE_MS);
    return () => clearTimeout(timer);
  }, [leaving]);

  const [expanded, setExpanded] = useState(false);
  useEffect(() => setExpanded(false), [scopeKey]);
  const [collapsed, setCollapsed] = useState(() =>
    typeof window === "undefined" ? false : readCollapsed(),
  );
  const listId = `live-plan-list-${useId().replace(/[^\w-]/g, "")}`;
  const toggleCollapsed = () => {
    setCollapsed((value) => {
      writeCollapsed(!value);
      return !value;
    });
  };

  const shown = plan ?? (leaving ? held?.plan : null) ?? null;
  const recentChanges = useRecentStatusChanges(shown?.items, scopeKey);
  if (!shown) return null;

  const total = shown.items.length;
  const canCollapse = total > 1;
  const isCollapsed = canCollapse && collapsed;
  const collapsedRow = isCollapsed ? collapsedLivePlanRow(shown) : null;
  const rows = collapsedRow ? [collapsedRow] : windowLivePlanRows(shown, expanded);
  const summary = `Plan, ${shown.doneCount} of ${total} done`;

  return (
    <section
      className={`live-plan${leaving ? " is-leaving" : ""}${isCollapsed ? " is-collapsed" : ""}`}
      aria-label={summary}
    >
      <div className="live-plan-inner">
        {canCollapse && (
          <button
            type="button"
            className="live-plan-toggle"
            onClick={toggleCollapsed}
            aria-expanded={!isCollapsed}
            aria-controls={listId}
            aria-label={isCollapsed ? `Show all ${total} steps` : "Show only the current step"}
            title={isCollapsed ? "Show all steps" : "Show only the current step"}
          >
            {isCollapsed ? (
              <ChevronsUpDown aria-hidden="true" />
            ) : (
              <ChevronsDownUp aria-hidden="true" />
            )}
          </button>
        )}
        <ol
          id={listId}
          className={`live-plan-list${expanded && !isCollapsed ? " is-expanded" : ""}`}
          aria-busy={shown.activeId ? true : undefined}
        >
          {rows.map((row) => {
            if (row.kind !== "item") {
              const label = row.kind === "more-before" ? `${row.count} done` : `${row.count} more`;
              return (
                <li key={row.kind} className="live-plan-fold">
                  <button
                    type="button"
                    onClick={() => setExpanded(true)}
                    aria-label={`Show all ${total} steps`}
                  >
                    <span className="live-plan-fold-dots" aria-hidden="true" />
                    <span>{label}</span>
                  </button>
                </li>
              );
            }

            const { item } = row;
            const target = getItemTarget?.(item);
            const isCurrent = item.id === shown.activeId;
            const className = [
              "live-plan-item",
              `is-${item.status}`,
              recentChanges.has(item.id) ? "just-changed" : "",
            ]
              .filter(Boolean)
              .join(" ");
            const content = (
              <>
                <span className="live-plan-glyph-slot" key={item.status}>
                  <LivePlanGlyph status={item.status} />
                </span>
                <TaskStatusPlanStepDescription
                  description={item.label}
                  markdownComponents={markdownComponents}
                />
                <span className="sr-only">{STATUS_TEXT[item.status]}</span>
              </>
            );
            return (
              <li key={item.id} className={className} aria-current={isCurrent ? "step" : undefined}>
                {target && onSelectTarget ? (
                  <button
                    type="button"
                    className="live-plan-item-body"
                    onClick={() => onSelectTarget(target)}
                    title={plainLabel(item.label)}
                  >
                    {content}
                  </button>
                ) : (
                  <div className="live-plan-item-body" title={plainLabel(item.label)}>
                    {content}
                  </div>
                )}
              </li>
            );
          })}
          {expanded && !isCollapsed && total > LIVE_PLAN_MAX_ROWS && (
            <li className="live-plan-fold">
              <button type="button" onClick={() => setExpanded(false)}>
                <span className="live-plan-fold-dots" aria-hidden="true" />
                <span>Show less</span>
              </button>
            </li>
          )}
        </ol>
      </div>
    </section>
  );
});
