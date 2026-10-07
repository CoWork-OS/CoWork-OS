import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  parseAnswerSurfaceSource,
  walkSurface,
  type AnswerSurfaceImageRef,
  type AnswerSurfaceNode,
  type AnswerSurfaceSpec,
  type AnswerSurfaceState,
  type AnswerSurfaceStateValue,
} from "../../../shared/answer-surfaces/schema";
import {
  buildSurfaceScope,
  formatControlValue,
  formatSurfaceValue,
  interpolateText,
  numericSurfaceValue,
  type SurfaceScope,
} from "../../../shared/answer-surfaces/runtime";
import { answerImageCredit } from "../../../shared/answer-surfaces/images";
import { useAnswerSurfaceState } from "../../hooks/useAnswerSurfaceState";
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
  const scope = useMemo(() => buildSurfaceScope(spec, state), [spec, state]);
  const imageRefs = useMemo(() => collectImageRefs(spec), [spec]);
  const images = useAnswerImages(imageRefs, taskId);
  const context: SurfaceContext = { state, scope, setValue, images };
  return (
    <div className="answer-surface" data-surface-key={surfaceKey}>
      <SurfaceNode node={spec.root} context={context} />
    </div>
  );
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
        <section className="as-card" aria-label={node.title ? text(node.title) : undefined}>
          {node.eyebrow && <div className="as-eyebrow">{text(node.eyebrow)}</div>}
          {node.title && <h3 className="as-card-title">{text(node.title)}</h3>}
          {node.subtitle && <p className="as-card-subtitle">{text(node.subtitle)}</p>}
          {node.children.length > 0 && <div className="as-stack">{children(node.children)}</div>}
        </section>
      );
    case "stack":
      return <div className="as-stack">{children(node.children)}</div>;
    case "grid":
      return (
        <div className={`as-grid as-grid-${node.columns ?? 2}`}>{children(node.children)}</div>
      );
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
      return (
        <div className="as-metrics">
          {node.items.map((item, index) => (
            <div key={index} className="as-metric">
              <div className="as-metric-label">{text(item.label)}</div>
              <div className="as-metric-value">{formatSurfaceValue(item.value, context.scope)}</div>
              {item.caption && <div className="as-metric-caption">{text(item.caption)}</div>}
            </div>
          ))}
        </div>
      );
    case "values":
      return (
        <div className="as-values">
          {node.title && <div className="as-values-title">{text(node.title)}</div>}
          <dl className="as-values-list">
            {node.items.map((item, index) => (
              <div key={index} className="as-values-row">
                <dt>
                  {text(item.label)}
                  {item.note && <span className="as-values-note">{text(item.note)}</span>}
                </dt>
                <dd aria-live="polite">{formatSurfaceValue(item.value, context.scope)}</dd>
              </div>
            ))}
          </dl>
        </div>
      );
    case "table":
      return (
        <div className="as-table-wrap">
          <table className="as-table">
            {node.caption && <caption>{text(node.caption)}</caption>}
            <thead>
              <tr>
                {node.columns.map((column, index) => (
                  <th key={index} scope="col">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {node.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {node.columns.map((_column, cellIndex) => (
                    <td key={cellIndex}>
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
    case "checklist":
      return <SurfaceChecklist node={node} context={context} />;
    case "chart": {
      const data = node.labels.map((label, index) => {
        const point: Record<string, string | number | null> = { label };
        for (const series of node.series) {
          const value = series.values[index];
          point[series.name] =
            value === undefined ? null : numericSurfaceValue(value, context.scope);
        }
        return point;
      });
      return (
        <figure className="as-chart">
          {node.title && <figcaption className="as-chart-title">{text(node.title)}</figcaption>}
          <Suspense fallback={<div className="as-chart-placeholder" />}>
            <LazyAnswerSurfaceChart
              kind={node.kind}
              data={data}
              series={node.series.map((series) => series.name)}
              unit={node.unit}
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
            aria-valuetext={formatControlValue(value, node)}
            onChange={(event) => context.setValue(node.id, Number(event.currentTarget.value))}
          />
        </label>
      );
    }
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
    case "callout":
      return (
        <div className={`as-callout as-callout-${node.tone ?? "info"}`} role="note">
          {node.title && <strong>{text(node.title)} </strong>}
          {text(node.text)}
        </div>
      );
    case "copy":
      return <SurfaceCopyButton label={node.label} text={text(node.text)} />;
    case "divider":
      return <hr className="as-divider" />;
  }
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
              {item.emoji && (
                <span className="as-tile-emoji" aria-hidden="true">
                  {item.emoji}
                </span>
              )}
              <span className="as-tile-title">{item.title}</span>
              {item.subtitle && <span className="as-tile-subtitle">{item.subtitle}</span>}
            </>
          );
          const classes = `as-tile as-tone-${item.tone ?? "gray"}${selected === item.title ? " as-tile-selected" : ""}`;
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
      <div className="as-eyebrow">{node.label}</div>
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
