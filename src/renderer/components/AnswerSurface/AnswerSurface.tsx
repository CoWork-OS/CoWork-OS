import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ArrowDownRight, ArrowRight, ArrowUpRight, Check } from "lucide-react";
import {
  isContainerNode,
  parseAnswerSurfaceSource,
  walkSurface,
  type AnswerSurfaceImageRef,
  type AnswerSurfaceNode,
  type AnswerSurfaceSpec,
  type AnswerSurfaceState,
  type AnswerSurfaceStateValue,
  type AnswerSurfaceTone,
  type AnswerSurfaceValue,
} from "../../../shared/answer-surfaces/schema";
import {
  buildSurfaceScope,
  formatControlValue,
  formatSurfaceValue,
  interpolateText,
  numericSurfaceValue,
  resolveSurfaceLabels,
  resolveSurfaceNumber,
  resolveSurfaceRows,
  resolveSurfaceValues,
  type SurfaceData,
  type SurfaceScope,
} from "../../../shared/answer-surfaces/runtime";
import { answerImageCredit } from "../../../shared/answer-surfaces/images";
import { useAnswerSurfaceState } from "../../hooks/useAnswerSurfaceState";
import { useSurfaceLogic } from "../../hooks/useSurfaceLogic";
import { useTweenedNumber } from "../../hooks/useTweenedNumber";
import { SurfaceIcon } from "./AnswerSurfaceIcon";
import {
  answerImageKey,
  useAnswerImages,
  type AnswerImageStatus,
} from "../../hooks/useAnswerImages";
import "./answer-surface.css";

const LazyAnswerSurfaceChart = lazy(() =>
  import("./AnswerSurfaceChart").then((module) => ({ default: module.AnswerSurfaceChart })),
);

type SurfaceContext = {
  state: AnswerSurfaceState;
  scope: SurfaceScope;
  /** Lists and tables from the surface's logic, for `{"bind": …}`. */
  data: SurfaceData;
  setValue: (id: string, value: AnswerSurfaceStateValue) => void;
  images: Map<string, AnswerImageStatus>;
};

export type AnswerSurfaceBlockProps = {
  source: string;
  surfaceKey: string;
  /** The block's closing fence has arrived. */
  closed: boolean;
  /** The message is still being generated. */
  streaming?: boolean;
  taskId?: string;
  /** Save control values for this task (off for drafts and read-only views). */
  persist?: boolean;
};

/** One ```cowork-ui block from an assistant message, rendered as native components. */
export function AnswerSurfaceBlock({
  source,
  surfaceKey,
  closed,
  streaming = false,
  taskId,
  persist = false,
}: AnswerSurfaceBlockProps) {
  const parsed = useMemo(
    () => (closed ? parseAnswerSurfaceSource(source) : null),
    [closed, source],
  );
  if (!parsed) {
    return (
      <div className="answer-surface">
        {streaming ? (
          <div className="as-skeleton" role="status" aria-live="polite">
            <span className="as-skeleton-bar" />
            <span className="as-skeleton-bar as-skeleton-bar-short" />
            <span className="as-skeleton-label">Building interactive answer…</span>
          </div>
        ) : (
          <p className="as-notice">This interactive part of the answer did not finish.</p>
        )}
      </div>
    );
  }
  if (!parsed.ok) {
    return (
      <div className="answer-surface">
        <p className="as-notice" title={parsed.error}>
          This interactive part of the answer could not be shown.
        </p>
      </div>
    );
  }
  return (
    <AnswerSurfaceView
      spec={parsed.spec}
      surfaceKey={surfaceKey}
      taskId={taskId}
      persist={persist && !streaming}
    />
  );
}

function collectImageRefs(spec: AnswerSurfaceSpec): AnswerSurfaceImageRef[] {
  const refs: AnswerSurfaceImageRef[] = [];
  walkSurface(spec.root, (node) => {
    if (node.type === "image") refs.push(node.image);
    else if (node.type === "gallery") refs.push(...node.images);
    else if (node.type === "media_list") {
      for (const item of node.items) if (item.image) refs.push(item.image);
    }
  });
  return refs;
}

/**
 * Surfaces already shown in this window. A surface animates in the first time it appears;
 * scrolling it out of the virtualized feed and back does not replay the entrance.
 */
const revealedSurfaces = new Set<string>();

function AnswerSurfaceView({
  spec,
  surfaceKey,
  taskId,
  persist,
}: {
  spec: AnswerSurfaceSpec;
  surfaceKey: string;
  taskId?: string;
  persist: boolean;
}) {
  const [state, setValue] = useAnswerSurfaceState(spec, { taskId, surfaceKey, persist });
  const logic = useSurfaceLogic(spec, state);
  const scope = useMemo(
    () => buildSurfaceScope(spec, state, logic.outputs.scope),
    [spec, state, logic.outputs.scope],
  );
  const imageRefs = useMemo(() => collectImageRefs(spec), [spec]);
  const images = useAnswerImages(imageRefs, taskId);
  const [entering] = useState(() => {
    const revealKey = `${taskId ?? ""}:${surfaceKey}`;
    if (revealedSurfaces.has(revealKey)) return false;
    revealedSurfaces.add(revealKey);
    return true;
  });
  const context: SurfaceContext = { state, scope, data: logic.outputs.data, setValue, images };
  return (
    <div
      className={`answer-surface as-theme-accent${entering ? " as-enter" : ""}${logic.status === "starting" ? " as-logic-starting" : ""}`}
      data-surface-key={surfaceKey}
      data-logic-status={logic.status === "none" ? undefined : logic.status}
    >
      <SurfaceNode node={spec.root} context={context} />
      {logic.status === "error" && (
        <p className="as-notice" role="status">
          This answer's calculation stopped: {logic.error}
        </p>
      )}
      {logic.status === "unavailable" && (
        <p className="as-notice">Some values in this answer are calculated in the desktop app.</p>
      )}
    </div>
  );
}

/** A container's own theme class, so it and everything inside it pick up that palette. */
function themeClass(node: AnswerSurfaceNode): string {
  return isContainerNode(node) && node.theme ? ` as-theme-${node.theme}` : "";
}

function toneClass(tone: AnswerSurfaceTone | undefined, index?: number): string {
  if (tone) return `as-tone-${tone}`;
  return index === undefined ? "as-tone-accent" : `as-series-${(index % 5) + 1}`;
}

/** A CSS custom property for a value the stylesheet reads (fills, positions). */
function cssVars(vars: Record<string, string | number>): CSSProperties {
  return vars as CSSProperties;
}

function SurfaceNode({
  node,
  context,
}: {
  node: AnswerSurfaceNode;
  context: SurfaceContext;
}): ReactNode {
  const text = (value: string) => interpolateText(value, context.scope);
  const children = (nodes: AnswerSurfaceNode[]) =>
    nodes.map((child, index) => (
      <SurfaceNode key={`${child.type}-${index}`} node={child} context={context} />
    ));

  switch (node.type) {
    case "card":
      return (
        <section
          className={`as-card as-card-${node.style ?? "plain"}${themeClass(node)}`}
          aria-label={node.title ? text(node.title) : undefined}
        >
          {(node.title || node.eyebrow || node.subtitle) && (
            <header className={`as-card-header${node.icon ? " as-card-header-icon" : ""}`}>
              {node.icon && (
                <span className="as-icon-chip as-tone-accent">
                  <SurfaceIcon name={node.icon} className="as-icon" />
                </span>
              )}
              <div className="as-card-heading">
                {node.eyebrow && <div className="as-eyebrow">{text(node.eyebrow)}</div>}
                {node.title && <h3 className="as-card-title">{text(node.title)}</h3>}
                {node.subtitle && <p className="as-card-subtitle">{text(node.subtitle)}</p>}
              </div>
            </header>
          )}
          {node.children.length > 0 && <div className="as-stack">{children(node.children)}</div>}
        </section>
      );
    case "stack":
      return <div className={`as-stack${themeClass(node)}`}>{children(node.children)}</div>;
    case "grid": {
      const columns = node.columns ?? 2;
      return (
        <div className={`as-grid as-grid-${columns}${themeClass(node)}`}>
          {node.children.map((child, index) => {
            const span = Math.min(columns, Math.max(1, node.spans?.[index] ?? 1));
            return (
              <div key={`${child.type}-${index}`} className={`as-grid-cell as-span-${span}`}>
                <SurfaceNode node={child} context={context} />
              </div>
            );
          })}
        </div>
      );
    }
    case "tabs":
      return <SurfaceTabs node={node} context={context} />;
    case "hero":
      return <SurfaceHero node={node} context={context} />;
    case "heading":
      return node.level === 4 ? (
        <h5 className="as-heading as-heading-small">{text(node.text)}</h5>
      ) : (
        <h4 className="as-heading">{text(node.text)}</h4>
      );
    case "text":
      return (
        <p className={`as-text${node.tone === "muted" ? " as-muted" : ""}`}>{text(node.text)}</p>
      );
    case "image":
      return (
        <figure className="as-figure">
          <SurfaceImage
            refValue={node.image}
            context={context}
            className={`as-image-${node.aspect ?? "wide"}`}
          />
          {node.caption && <figcaption className="as-caption">{text(node.caption)}</figcaption>}
        </figure>
      );
    case "gallery":
      return (
        <SurfaceGallery images={node.images} layout={node.layout ?? "collage"} context={context} />
      );
    case "media_list":
      return (
        <ul className="as-media-list as-list">
          {node.items.map((item, index) => (
            <li key={index} className="as-media-item">
              {item.image && (
                <SurfaceImage refValue={item.image} context={context} className="as-media-thumb" />
              )}
              <div className="as-media-body">
                <div className="as-media-title">
                  {text(item.title)}
                  {item.badge && <span className="as-badge">{item.badge}</span>}
                </div>
                {item.meta && <div className="as-media-meta">{text(item.meta)}</div>}
                {item.text && <p className="as-media-text">{text(item.text)}</p>}
              </div>
            </li>
          ))}
        </ul>
      );
    case "tiles":
      return <SurfaceTiles node={node} context={context} />;
    case "metrics":
      return <SurfaceMetrics node={node} context={context} />;
    case "progress":
      return <SurfaceProgress node={node} context={context} />;
    case "timeline":
      return (
        <div className="as-timeline">
          {node.title && <div className="as-block-title">{text(node.title)}</div>}
          <ol className="as-list as-timeline-list">
            {node.items.map((item, index) => {
              // Without a status a step is part of a plan, not a tracked task: keep its color.
              const status = item.status ?? "step";
              return (
                <li
                  key={index}
                  className={`as-timeline-item as-timeline-${status} ${toneClass(item.tone)}`}
                >
                  <span className="as-timeline-marker" aria-hidden="true">
                    {status === "done" ? (
                      <Check className="as-icon" strokeWidth={3} />
                    ) : item.icon ? (
                      <SurfaceIcon name={item.icon} className="as-icon" />
                    ) : null}
                  </span>
                  <div className="as-timeline-body">
                    {item.time && <div className="as-timeline-time">{text(item.time)}</div>}
                    <div className="as-timeline-title">{text(item.title)}</div>
                    {item.text && <p className="as-timeline-text">{text(item.text)}</p>}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      );
    case "tags":
      return (
        <ul className="as-list as-tags">
          {node.items.map((item, index) => (
            <li key={index} className={`as-tag ${toneClass(item.tone, index)}`}>
              {item.icon && <SurfaceIcon name={item.icon} className="as-icon" />}
              {text(item.label)}
            </li>
          ))}
        </ul>
      );
    case "values":
      return (
        <div className="as-values">
          {node.title && <div className="as-block-title">{text(node.title)}</div>}
          <dl className="as-values-list">
            {node.items.map((item, index) => (
              <div key={index} className="as-values-row">
                <dt>
                  {text(item.label)}
                  {item.note && <span className="as-values-note">{text(item.note)}</span>}
                </dt>
                <dd aria-live="polite">
                  <AnimatedValue value={item.value} scope={context.scope} />
                </dd>
              </div>
            ))}
          </dl>
        </div>
      );
    case "table": {
      const rows = resolveSurfaceRows(node.rows, context.data);
      return (
        <div className="as-table-wrap">
          <table className="as-table">
            {node.caption && <caption>{text(node.caption)}</caption>}
            <thead>
              <tr>
                {node.columns.map((column, index) => (
                  <th
                    key={index}
                    scope="col"
                    className={index > 0 && isNumericColumn(rows, index) ? "as-num" : undefined}
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {node.columns.map((_column, cellIndex) => (
                    <td
                      key={cellIndex}
                      className={
                        cellIndex > 0 && isNumericColumn(rows, cellIndex) ? "as-num" : undefined
                      }
                    >
                      {row[cellIndex] === undefined
                        ? ""
                        : formatSurfaceValue(row[cellIndex], context.scope)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "checklist":
      return <SurfaceChecklist node={node} context={context} />;
    case "chart": {
      const values = node.series.map((series) => resolveSurfaceValues(series.values, context.data));
      const data = resolveSurfaceLabels(node.labels, context.data).map((label, index) => {
        const point: Record<string, string | number | null> = { label };
        for (const [seriesIndex, series] of node.series.entries()) {
          const value = values[seriesIndex][index];
          point[series.name] =
            value === undefined ? null : numericSurfaceValue(value, context.scope);
        }
        return point;
      });
      return (
        <figure className="as-chart">
          {node.title && <figcaption className="as-block-title">{text(node.title)}</figcaption>}
          <Suspense
            fallback={<div className={`as-chart-placeholder as-chart-${node.height ?? "md"}`} />}
          >
            <LazyAnswerSurfaceChart
              kind={node.kind}
              data={data}
              series={node.series.map((series) => ({
                name: series.name,
                style: series.style ?? "solid",
                tone: series.tone,
              }))}
              unit={node.unit}
              prefix={node.prefix}
              format={node.format}
              stacked={node.stacked ?? false}
              horizontal={node.horizontal ?? false}
              height={node.height ?? "md"}
            />
          </Suspense>
        </figure>
      );
    }
    case "stepper":
      return <SurfaceStepper node={node} context={context} />;
    case "slider": {
      const value =
        typeof context.state[node.id] === "number"
          ? (context.state[node.id] as number)
          : node.default;
      const fill = ((value - node.min) / (node.max - node.min)) * 100;
      return (
        <label className="as-slider">
          <span className="as-control-row">
            <span className="as-control-label">{node.label}</span>
            <span className="as-control-value" aria-hidden="true">
              {formatControlValue(value, node)}
            </span>
          </span>
          <input
            type="range"
            min={node.min}
            max={node.max}
            step={node.step ?? 1}
            value={value}
            style={cssVars({ "--as-fill": `${fill}%` })}
            aria-valuetext={formatControlValue(value, node)}
            onChange={(event) => context.setValue(node.id, Number(event.currentTarget.value))}
          />
        </label>
      );
    }
    case "number":
      return <SurfaceNumberInput node={node} context={context} />;
    case "select":
      return <SurfaceSelect node={node} context={context} />;
    case "toggle": {
      const on = context.state[node.id] === true;
      return (
        <button
          type="button"
          role="switch"
          aria-checked={on}
          className={`as-toggle${on ? " as-toggle-on" : ""}`}
          onClick={() => context.setValue(node.id, !on)}
        >
          <span className="as-toggle-track" aria-hidden="true">
            <span className="as-toggle-thumb" />
          </span>
          <span>{node.label}</span>
        </button>
      );
    }
    case "callout": {
      const tone = node.tone ?? "info";
      return (
        <div className={`as-callout as-callout-${tone}`} role="note">
          <SurfaceIcon
            name={node.icon ?? CALLOUT_ICONS[tone]}
            className="as-icon as-callout-icon"
          />
          <div>
            {node.title && <strong>{text(node.title)} </strong>}
            {text(node.text)}
          </div>
        </div>
      );
    }
    case "copy":
      return <SurfaceCopyButton label={node.label} text={text(node.text)} />;
    case "divider":
      return <hr className="as-divider" />;
  }
}

const CALLOUT_ICONS = {
  info: "info",
  tip: "lightbulb",
  warning: "alert",
  success: "check-circle",
} as const;

function isNumericColumn(rows: AnswerSurfaceValue[][], index: number): boolean {
  const cells = rows.map((row) => row[index]).filter((cell) => cell !== undefined);
  return (
    cells.length > 0 && cells.every((cell) => typeof cell === "number" || typeof cell === "object")
  );
}

/** A value that eases to its new result when the inputs it reads change. */
function AnimatedValue({ value, scope }: { value: AnswerSurfaceValue; scope: SurfaceScope }) {
  const resolved = resolveSurfaceNumber(value, scope);
  const shown = useTweenedNumber(resolved?.number ?? 0);
  return <>{resolved ? resolved.format(shown) : formatSurfaceValue(value, scope)}</>;
}

/** A change badge: the arrow follows the direction, the color follows whether that is good. */
function SurfaceDelta({
  delta,
  direction,
  good = "up",
  scope,
}: {
  delta: AnswerSurfaceValue;
  direction?: "up" | "down" | "flat";
  good?: "up" | "down";
  scope: SurfaceScope;
}) {
  const number = numericSurfaceValue(delta, scope);
  const formatted = formatSurfaceValue(delta, scope);
  const resolvedDirection =
    direction ??
    (number === null
      ? /^\s*[-−]/.test(formatted)
        ? "down"
        : "up"
      : number > 0
        ? "up"
        : number < 0
          ? "down"
          : "flat");
  const sentiment =
    resolvedDirection === "flat" ? "flat" : resolvedDirection === good ? "good" : "bad";
  const Arrow =
    resolvedDirection === "up"
      ? ArrowUpRight
      : resolvedDirection === "down"
        ? ArrowDownRight
        : ArrowRight;
  return (
    <span className={`as-delta as-delta-${sentiment}`}>
      <Arrow className="as-icon" strokeWidth={2.5} aria-hidden="true" />
      {formatted}
    </span>
  );
}

function SurfaceHero({
  node,
  context,
}: {
  node: Extract<AnswerSurfaceNode, { type: "hero" }>;
  context: SurfaceContext;
}) {
  const text = (value: string) => interpolateText(value, context.scope);
  const requested = node.style ?? (node.image ? "image" : "gradient");
  const style = requested === "image" && !node.image ? "gradient" : requested;
  return (
    <section className={`as-hero as-hero-${style}`} aria-label={text(node.title)}>
      {style === "image" && node.image && (
        <SurfaceImage refValue={node.image} context={context} className="as-hero-image" />
      )}
      <div className="as-hero-content">
        <div className="as-hero-top">
          <div>
            {node.eyebrow && <div className="as-hero-eyebrow">{text(node.eyebrow)}</div>}
            <div className="as-hero-title">{text(node.title)}</div>
          </div>
          {node.icon && (
            <span className="as-hero-icon">
              <SurfaceIcon name={node.icon} className="as-icon" />
            </span>
          )}
        </div>
        {node.value !== undefined && (
          <div className="as-hero-value" aria-live="polite">
            <AnimatedValue value={node.value} scope={context.scope} />
          </div>
        )}
        {(node.delta !== undefined || node.caption) && (
          <div className="as-hero-footer">
            {node.delta !== undefined && (
              <SurfaceDelta delta={node.delta} direction={node.direction} scope={context.scope} />
            )}
            {node.caption && <span className="as-hero-caption">{text(node.caption)}</span>}
          </div>
        )}
      </div>
    </section>
  );
}

function SurfaceTabs({
  node,
  context,
}: {
  node: Extract<AnswerSurfaceNode, { type: "tabs" }>;
  context: SurfaceContext;
}) {
  const [active, setActive] = useState(0);
  const baseId = useId();
  const current = node.tabs[Math.min(active, node.tabs.length - 1)];
  return (
    <div className={`as-tabs${themeClass(node)}`}>
      <div className="as-tab-list" role="tablist">
        {node.tabs.map((tab, index) => (
          <button
            key={index}
            type="button"
            role="tab"
            id={`${baseId}-tab-${index}`}
            aria-selected={index === active}
            aria-controls={`${baseId}-panel`}
            className={`as-tab${index === active ? " as-tab-active" : ""}`}
            onClick={() => setActive(index)}
          >
            {tab.icon && <SurfaceIcon name={tab.icon} className="as-icon" />}
            {interpolateText(tab.label, context.scope)}
          </button>
        ))}
      </div>
      <div
        className="as-stack as-tab-panel"
        role="tabpanel"
        id={`${baseId}-panel`}
        aria-labelledby={`${baseId}-tab-${active}`}
        key={active}
      >
        {current.children.map((child, index) => (
          <SurfaceNode key={`${child.type}-${index}`} node={child} context={context} />
        ))}
      </div>
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const gradientId = useId();
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * 100;
    const y = 26 - ((value - min) / range) * 22;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  return (
    <svg className="as-spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" className="as-spark-stop-top" />
          <stop offset="100%" className="as-spark-stop-bottom" />
        </linearGradient>
      </defs>
      <polygon points={`0,28 ${points.join(" ")} 100,28`} fill={`url(#${gradientId})`} />
      <polyline points={points.join(" ")} className="as-spark-line" />
    </svg>
  );
}

function SurfaceMetrics({
  node,
  context,
}: {
  node: Extract<AnswerSurfaceNode, { type: "metrics" }>;
  context: SurfaceContext;
}) {
  const style = node.style ?? "cards";
  return (
    <div className={`as-metrics as-metrics-${style}`}>
      {node.items.map((item, index) => (
        <div key={index} className={`as-metric ${toneClass(item.tone, index)}`}>
          <div className="as-metric-head">
            {item.icon && (
              <span className="as-icon-chip">
                <SurfaceIcon name={item.icon} className="as-icon" />
              </span>
            )}
            <span className="as-metric-label">{interpolateText(item.label, context.scope)}</span>
          </div>
          <div className="as-metric-value" aria-live="polite">
            <AnimatedValue value={item.value} scope={context.scope} />
          </div>
          {(item.delta !== undefined || item.caption) && (
            <div className="as-metric-foot">
              {item.delta !== undefined && (
                <SurfaceDelta
                  delta={item.delta}
                  direction={item.direction}
                  good={item.good}
                  scope={context.scope}
                />
              )}
              {item.caption && (
                <span className="as-metric-caption">
                  {interpolateText(item.caption, context.scope)}
                </span>
              )}
            </div>
          )}
          {item.spark && <Sparkline values={item.spark} />}
        </div>
      ))}
    </div>
  );
}

const RING_RADIUS = 40;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

function SurfaceProgress({
  node,
  context,
}: {
  node: Extract<AnswerSurfaceNode, { type: "progress" }>;
  context: SurfaceContext;
}) {
  const style = node.style ?? "bar";
  return (
    <div className={`as-progress as-progress-${style}`}>
      {node.title && (
        <div className="as-block-title">{interpolateText(node.title, context.scope)}</div>
      )}
      <div className="as-progress-items">
        {node.items.map((item, index) => {
          const number = numericSurfaceValue(item.value, context.scope) ?? 0;
          const ratio = Math.min(1, Math.max(0, number / (item.max ?? 100)));
          const label = interpolateText(item.label, context.scope);
          const formatted = formatSurfaceValue(item.value, context.scope);
          // Without a max the value is a percentage; say so when the value is a bare number.
          const valueText =
            item.max === undefined && /^[\d.,]+$/.test(formatted) ? `${formatted}%` : formatted;
          return style === "ring" ? (
            <div key={index} className={`as-ring ${toneClass(item.tone, index)}`}>
              <svg viewBox="0 0 100 100" className="as-ring-svg" aria-hidden="true">
                <circle cx="50" cy="50" r={RING_RADIUS} className="as-ring-track" />
                <circle
                  cx="50"
                  cy="50"
                  r={RING_RADIUS}
                  className="as-ring-fill"
                  strokeDasharray={`${RING_LENGTH * ratio} ${RING_LENGTH}`}
                />
              </svg>
              <div className="as-ring-center">
                <span className="as-ring-value">{valueText}</span>
              </div>
              <div className="as-ring-label">{label}</div>
              {item.caption && (
                <div className="as-ring-caption">
                  {interpolateText(item.caption, context.scope)}
                </div>
              )}
            </div>
          ) : (
            <div key={index} className={`as-bar ${toneClass(item.tone, index)}`}>
              <div className="as-control-row">
                <span className="as-bar-label">{label}</span>
                <span className="as-control-value">
                  {valueText}
                  {item.max !== undefined && item.max !== 100 && (
                    <span className="as-bar-max"> / {item.max}</span>
                  )}
                </span>
              </div>
              <div
                className="as-bar-track"
                role="progressbar"
                aria-label={label}
                aria-valuemin={0}
                aria-valuemax={item.max ?? 100}
                aria-valuenow={number}
              >
                <span className="as-bar-fill" style={cssVars({ "--as-fill": ratio })} />
              </div>
              {item.caption && (
                <div className="as-bar-caption">{interpolateText(item.caption, context.scope)}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SurfaceImage({
  refValue,
  context,
  className,
}: {
  refValue: AnswerSurfaceImageRef;
  context: SurfaceContext;
  className?: string;
}) {
  const status = context.images.get(answerImageKey(refValue)) ?? { status: "loading" as const };
  const classes = `as-image ${className ?? ""}`.trim();
  if (status.status === "ready") {
    const credit = answerImageCredit(status.image);
    return (
      <span className={classes} title={credit}>
        <img src={status.image.dataUrl} alt={refValue.alt} loading="lazy" decoding="async" />
        <span className="as-image-credit">{credit}</span>
      </span>
    );
  }
  return (
    <span
      className={`${classes} as-image-placeholder${status.status === "loading" ? " as-image-loading" : ""}`}
      role="img"
      aria-label={refValue.alt}
    >
      {status.status === "missing" && <span className="as-image-alt">{refValue.alt}</span>}
    </span>
  );
}

function SurfaceGallery({
  images,
  layout,
  context,
}: {
  images: AnswerSurfaceImageRef[];
  layout: "collage" | "grid" | "row";
  context: SurfaceContext;
}) {
  const count = Math.min(images.length, 8);
  const variant =
    layout === "collage" && count >= 3
      ? "collage"
      : layout === "row"
        ? "row"
        : `grid-${Math.min(count, 3)}`;
  return (
    <div className={`as-gallery as-gallery-${variant}${count > 3 ? " as-gallery-many" : ""}`}>
      {images.slice(0, count).map((image, index) => (
        <SurfaceImage
          key={`${answerImageKey(image)}-${index}`}
          refValue={image}
          context={context}
          className={variant === "collage" && index === 0 ? "as-gallery-hero" : "as-gallery-item"}
        />
      ))}
    </div>
  );
}

function SurfaceTiles({
  node,
  context,
}: {
  node: Extract<AnswerSurfaceNode, { type: "tiles" }>;
  context: SurfaceContext;
}) {
  const selected = node.id ? context.state[node.id] : undefined;
  const selectable = Boolean(node.selectable && node.id);
  return (
    <div className="as-tiles-wrap">
      <div className={`as-tiles as-tiles-${Math.min(node.items.length, 4)}`}>
        {node.items.map((item, index) => {
          const content = (
            <>
              {item.icon ? (
                <span className="as-icon-chip as-tile-icon">
                  <SurfaceIcon name={item.icon} className="as-icon" />
                </span>
              ) : (
                item.emoji && (
                  <span className="as-tile-emoji" aria-hidden="true">
                    {item.emoji}
                  </span>
                )
              )}
              <span className="as-tile-title">{item.title}</span>
              {item.subtitle && <span className="as-tile-subtitle">{item.subtitle}</span>}
            </>
          );
          const classes = `as-tile ${toneClass(item.tone, index)}${selected === item.title ? " as-tile-selected" : ""}`;
          return selectable ? (
            <button
              key={index}
              type="button"
              className={classes}
              aria-pressed={selected === item.title}
              onClick={() => context.setValue(node.id!, selected === item.title ? "" : item.title)}
            >
              {content}
            </button>
          ) : (
            <div key={index} className={classes}>
              {content}
            </div>
          );
        })}
      </div>
      {node.caption && (
        <p className="as-tiles-caption">{interpolateText(node.caption, context.scope)}</p>
      )}
    </div>
  );
}

function SurfaceChecklist({
  node,
  context,
}: {
  node: Extract<AnswerSurfaceNode, { type: "checklist" }>;
  context: SurfaceContext;
}) {
  const checked = new Set(
    Array.isArray(context.state[node.id]) ? (context.state[node.id] as string[]) : [],
  );
  const done = node.items.filter((item) => checked.has(item.id)).length;
  const toggle = (id: string) => {
    const next = checked.has(id) ? [...checked].filter((value) => value !== id) : [...checked, id];
    context.setValue(node.id, next);
  };
  return (
    <div className="as-checklist">
      <div className="as-checklist-header">
        {node.title && <span className="as-checklist-title">{node.title}</span>}
        <span className="as-checklist-progress" aria-live="polite">
          {done} of {node.items.length} done
        </span>
      </div>
      <div className="as-checklist-meter" aria-hidden="true">
        <span
          className="as-bar-fill"
          style={cssVars({ "--as-fill": node.items.length ? done / node.items.length : 0 })}
        />
      </div>
      <ul className="as-list">
        {node.items.map((item) => {
          const isChecked = checked.has(item.id);
          // Short times ("13:30") get a column; longer ones ("A day before") sit above the step.
          const shortTime = item.time && item.time.length <= 12 ? item.time : undefined;
          const longTime = item.time && !shortTime ? item.time : undefined;
          return (
            <li key={item.id} className={isChecked ? "as-checked" : undefined}>
              <label>
                <input type="checkbox" checked={isChecked} onChange={() => toggle(item.id)} />
                {shortTime && <span className="as-checklist-time">{shortTime}</span>}
                <span className="as-checklist-text">
                  {longTime && <span className="as-checklist-when">{longTime}</span>}
                  {item.text}
                  {item.detail && <span className="as-checklist-detail">{item.detail}</span>}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SurfaceStepper({
  node,
  context,
}: {
  node: Extract<AnswerSurfaceNode, { type: "stepper" }>;
  context: SurfaceContext;
}) {
  const value =
    typeof context.state[node.id] === "number" ? (context.state[node.id] as number) : node.default;
  const step = node.step ?? 1;
  const clamp = (next: number) =>
    Math.min(node.max, Math.max(node.min, Math.round(next / step) * step));
  return (
    <div className="as-stepper" role="group" aria-label={node.label}>
      <span className="as-stepper-label">
        <span className="as-control-label">{node.label}</span>
      </span>
      <div className="as-stepper-row">
        <button
          type="button"
          className="as-stepper-button"
          aria-label={`Decrease ${node.label}`}
          disabled={value <= node.min}
          onClick={() => context.setValue(node.id, clamp(value - step))}
        >
          −
        </button>
        <div className="as-stepper-value" aria-live="polite">
          <span className="as-stepper-number">{formatControlValue(value, { step })}</span>
          {node.unit && <span className="as-stepper-unit">{node.unit}</span>}
        </div>
        <button
          type="button"
          className="as-stepper-button"
          aria-label={`Increase ${node.label}`}
          disabled={value >= node.max}
          onClick={() => context.setValue(node.id, clamp(value + step))}
        >
          +
        </button>
      </div>
    </div>
  );
}

/** An editable amount (a goal, a balance, a price) with its prefix and unit beside it. */
function SurfaceNumberInput({
  node,
  context,
}: {
  node: Extract<AnswerSurfaceNode, { type: "number" }>;
  context: SurfaceContext;
}) {
  const value =
    typeof context.state[node.id] === "number" ? (context.state[node.id] as number) : node.default;
  const [draft, setDraft] = useState<string | null>(null);
  const inputId = useId();
  const clamp = (next: number) =>
    Math.min(node.max ?? Infinity, Math.max(node.min ?? -Infinity, next));
  const parse = (raw: string) => Number(raw.replace(/[,\s]/g, ""));
  const commit = (raw: string) => {
    const next = parse(raw);
    if (raw.trim() !== "" && Number.isFinite(next)) context.setValue(node.id, clamp(next));
    setDraft(null);
  };
  return (
    <div className="as-number">
      <label className="as-control-label" htmlFor={inputId}>
        {node.label}
      </label>
      <div className="as-number-field">
        {node.prefix && <span className="as-number-affix">{node.prefix}</span>}
        <input
          id={inputId}
          type="text"
          inputMode="decimal"
          value={draft ?? formatControlValue(value, { step: node.step })}
          // Selecting without changing the text keeps the selection; typing replaces it.
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => {
            const raw = event.currentTarget.value;
            setDraft(raw);
            const next = parse(raw);
            const inRange =
              (node.min === undefined || next >= node.min) &&
              (node.max === undefined || next <= node.max);
            if (raw.trim() !== "" && Number.isFinite(next) && inRange) {
              context.setValue(node.id, next);
            }
          }}
          onBlur={(event) => commit(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        {node.unit && <span className="as-number-affix">{node.unit}</span>}
      </div>
    </div>
  );
}

function SurfaceSelect({
  node,
  context,
}: {
  node: Extract<AnswerSurfaceNode, { type: "select" }>;
  context: SurfaceContext;
}) {
  const current = context.state[node.id] ?? node.default;
  if (node.options.length <= 4) {
    return (
      <div className="as-segmented-wrap">
        <span className="as-control-label">{node.label}</span>
        <div className="as-segmented" role="radiogroup" aria-label={node.label}>
          {node.options.map((option) => (
            <button
              key={String(option.value)}
              type="button"
              role="radio"
              aria-checked={option.value === current}
              className={option.value === current ? "as-segment-active" : undefined}
              onClick={() => context.setValue(node.id, option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <label className="as-select">
      <span className="as-control-label">{node.label}</span>
      <select
        value={String(current)}
        onChange={(event) => {
          const option = node.options.find(
            (candidate) => String(candidate.value) === event.currentTarget.value,
          );
          if (option) context.setValue(node.id, option.value);
        }}
      >
        {node.options.map((option) => (
          <option key={String(option.value)} value={String(option.value)}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function SurfaceCopyButton({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <button
      type="button"
      className="as-copy-button"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 2000);
          })
          .catch(() => {});
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}
