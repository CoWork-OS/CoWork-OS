import { expressionIdentifiers } from "./expression";
import { isToolDataSource } from "./data";
import { richEmbedsToPlainText } from "../rich-embeds";
import {
  initialSurfaceState,
  interpolationExpressions,
  isContainerNode,
  nodeChildren,
  parseAnswerSurfaceSource,
  walkSurface,
  type AnswerSurfaceNode,
  type AnswerSurfaceSpec,
  type AnswerSurfaceState,
  type AnswerSurfaceValue,
} from "./schema";
import {
  buildSurfaceScope,
  resolveSurfaceLabels,
  resolveSurfaceRows,
  resolveSurfaceValues,
  formatControlValue,
  formatSurfaceValue,
  interpolateText,
  type SurfaceScope,
} from "./runtime";

/** The fence language that marks a native answer surface inside an assistant message. */
export const ANSWER_SURFACE_FENCE_LANGUAGE = "cowork-ui";

const FENCE_START_REGEX = /^\s*```cowork-ui\s*$/i;
const FENCE_END_REGEX = /^\s*```\s*$/;

export type AnswerTextPart =
  | { kind: "text"; text: string }
  | { kind: "surface"; source: string; closed: boolean; key: string };

export function isAnswerSurfaceFenceStart(line: string): boolean {
  return FENCE_START_REGEX.test(line);
}

export function isAnswerSurfaceFenceEnd(line: string): boolean {
  return FENCE_END_REGEX.test(line);
}

/** cyrb53: a fast, well-distributed 53-bit string hash (not cryptographic). */
function hashString(value: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * A stable key for a surface's saved state: the hash of its source plus how many identical
 * blocks came before it in the same message. Keying by content rather than event id keeps
 * the state attached when the same answer is shown again as a completion summary.
 */
export function answerSurfaceKey(source: string, occurrence: number): string {
  return `s1-${hashString(source.trim())}-${occurrence}`;
}

/** The saved-state key of an inline HTML surface, from its document source. */
export function htmlSurfaceKey(source: string, occurrence = 0): string {
  return `h1-${hashString(source.trim())}-${occurrence}`;
}

/** Splits an assistant message into text and ```cowork-ui parts, in order. */
export function splitAnswerSurfaceBlocks(message: string): AnswerTextPart[] {
  const lines = String(message || "").split("\n");
  const parts: AnswerTextPart[] = [];
  const seen = new Map<string, number>();
  let buffer: string[] = [];
  const flush = () => {
    if (buffer.length > 0) parts.push({ kind: "text", text: buffer.join("\n") });
    buffer = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    if (!isAnswerSurfaceFenceStart(lines[index])) {
      buffer.push(lines[index]);
      continue;
    }
    flush();
    let end = index + 1;
    while (end < lines.length && !isAnswerSurfaceFenceEnd(lines[end])) end += 1;
    const source = lines.slice(index + 1, end).join("\n");
    const normalized = source.trim();
    const occurrence = seen.get(normalized) ?? 0;
    seen.set(normalized, occurrence + 1);
    parts.push({
      kind: "surface",
      source,
      closed: end < lines.length,
      key: answerSurfaceKey(normalized, occurrence),
    });
    index = end;
  }
  flush();
  return parts;
}

export function hasAnswerSurfaceBlock(message: string): boolean {
  return String(message || "")
    .split("\n")
    .some(isAnswerSurfaceFenceStart);
}

/**
 * Marks text that would show a value only the surface's logic can compute. Plain text has
 * no logic run (channels, the CLI, search), so such lines are left out instead of "—".
 */
const NEEDS_LOGIC = "\u0000needs-logic\u0000";

type PlainContext = { dependsOnLogic: (value: AnswerSurfaceValue) => boolean };

function plainLines(
  node: AnswerSurfaceNode,
  scope: SurfaceScope,
  state: AnswerSurfaceState,
  ctx: PlainContext,
): string[] {
  const text = (value: string) =>
    ctx.dependsOnLogic(value) ? NEEDS_LOGIC : interpolateText(value, scope);
  const fmt = (value: AnswerSurfaceValue) =>
    ctx.dependsOnLogic(value) ? NEEDS_LOGIC : formatSurfaceValue(value, scope);
  switch (node.type) {
    case "card": {
      const lines = [
        node.eyebrow ? text(node.eyebrow) : "",
        node.title ? `**${text(node.title)}**` : "",
        node.subtitle ? text(node.subtitle) : "",
      ];
      return [
        ...lines,
        ...nodeChildren(node).flatMap((child) => plainLines(child, scope, state, ctx)),
      ];
    }
    case "stack":
    case "grid":
      return nodeChildren(node).flatMap((child) => plainLines(child, scope, state, ctx));
    case "tabs":
      return node.tabs.flatMap((tab) => [
        `**${text(tab.label)}**`,
        ...tab.children.flatMap((child) => plainLines(child, scope, state, ctx)),
      ]);
    case "hero": {
      let value = node.value === undefined ? "" : fmt(node.value);
      let delta = node.delta === undefined ? "" : ` (${fmt(node.delta)})`;
      if (value === NEEDS_LOGIC) value = "";
      if (delta.includes(NEEDS_LOGIC)) delta = "";
      return [
        node.eyebrow ? text(node.eyebrow) : "",
        value ? `**${text(node.title)}: ${value}**${delta}` : `**${text(node.title)}**`,
        node.caption ? text(node.caption) : "",
      ];
    }
    case "progress": {
      const lines = node.items.map((item) => {
        const value = fmt(item.value);
        return `- ${text(item.label)}: ${value}${item.max !== undefined ? ` of ${item.max}` : ""}`;
      });
      return node.title ? [`**${text(node.title)}**`, ...lines] : lines;
    }
    case "timeline": {
      const lines = node.items.map((item) => {
        const time = item.time ? `${text(item.time)} — ` : "";
        const detail = item.text ? `: ${text(item.text)}` : "";
        const mark = item.status === "done" ? " ✓" : "";
        return `- ${time}${text(item.title)}${detail}${mark}`;
      });
      return node.title ? [`**${text(node.title)}**`, ...lines] : lines;
    }
    case "tags":
      return [node.items.map((item) => item.label).join(" · ")];
    case "heading":
      return [`**${text(node.text)}**`];
    case "text":
      return [text(node.text)];
    case "image":
      return node.caption ? [text(node.caption)] : [];
    case "gallery":
    case "divider":
    case "copy":
      return [];
    case "media_list":
      return node.items.map((item) => {
        const detail = item.text ? ` — ${text(item.text)}` : "";
        return `- **${text(item.title)}**${detail}`;
      });
    case "tiles": {
      const selected = node.id ? state[node.id] : undefined;
      const lines = node.items.map((item) => {
        const mark = selected && selected === item.title ? " (selected)" : "";
        const subtitle = item.subtitle ? `: ${item.subtitle}` : "";
        return `- ${item.emoji ? `${item.emoji} ` : ""}${item.title}${subtitle}${mark}`;
      });
      return node.caption ? [...lines, text(node.caption)] : lines;
    }
    case "metrics":
      return node.items.map((item) => {
        const delta = item.delta === undefined ? "" : ` (${fmt(item.delta)})`;
        return `- ${text(item.label)}: ${fmt(item.value)}${delta}`;
      });
    case "values": {
      const lines = node.items.map((item) => `- ${text(item.label)}: ${fmt(item.value)}`);
      return node.title ? [`**${text(node.title)}**`, ...lines] : lines;
    }
    case "table": {
      const header = `| ${node.columns.join(" | ")} |`;
      const divider = `| ${node.columns.map(() => "---").join(" | ")} |`;
      // Plain text has no logic run, so bound rows are left out rather than shown blank.
      const tableRows = resolveSurfaceRows(node.rows, {});
      if (tableRows.length === 0) return node.caption ? [text(node.caption)] : [];
      const rows = tableRows.map(
        (row) =>
          `| ${node.columns.map((_column, index) => (row[index] === undefined ? "" : fmt(row[index]))).join(" | ")} |`,
      );
      return [header, divider, ...rows];
    }
    case "checklist": {
      const checked = new Set(Array.isArray(state[node.id]) ? (state[node.id] as string[]) : []);
      const lines = node.items.map((item) => {
        const time = item.time ? `${item.time} — ` : "";
        return `- [${checked.has(item.id) ? "x" : " "}] ${time}${item.text}`;
      });
      return node.title ? [`**${node.title}**`, ...lines] : lines;
    }
    case "chart": {
      const labels = resolveSurfaceLabels(node.labels, {});
      const lines = labels.map((labelText, index) => {
        const values = node.series
          .map((series) => {
            const value = resolveSurfaceValues(series.values, {})[index];
            const formatted = value === undefined ? "—" : fmt(value);
            return node.series.length > 1 ? `${series.name} ${formatted}` : formatted;
          })
          .join(", ");
        return `- ${labelText}: ${values}${node.unit ? ` ${node.unit}` : ""}`;
      });
      return node.title ? [`**${text(node.title)}**`, ...lines] : lines;
    }
    case "stepper":
    case "slider":
    case "number": {
      const value = typeof state[node.id] === "number" ? (state[node.id] as number) : node.default;
      return [`${node.label}: ${formatControlValue(value, node)}`];
    }
    case "select": {
      const option = node.options.find((candidate) => candidate.value === state[node.id]);
      return [`${node.label}: ${option?.label ?? String(state[node.id] ?? node.default)}`];
    }
    case "toggle":
      return [`${node.label}: ${state[node.id] ? "Yes" : "No"}`];
    case "callout":
      return [`> ${node.title ? `**${text(node.title)}** ` : ""}${text(node.text)}`];
  }
}

/** Names whose values only the logic can produce: its outputs and `computed` values using them. */
function logicDependence(spec: AnswerSurfaceSpec): (value: AnswerSurfaceValue) => boolean {
  const names = new Set(spec.logic?.outputs ?? []);
  if (names.size === 0) return () => false;
  const uses = (expr: string) => {
    try {
      return expressionIdentifiers(expr).some((name) => names.has(name));
    } catch {
      return false;
    }
  };
  // `computed` values can read logic outputs (and each other) in document order.
  walkSurface(spec.root, (node) => {
    if (!isContainerNode(node)) return;
    for (const [id, expr] of Object.entries(node.computed ?? {})) if (uses(expr)) names.add(id);
  });
  return (value) => {
    if (typeof value === "number") return false;
    if (typeof value === "string") return interpolationExpressions(value).some(uses);
    return (
      Boolean(value.expr && uses(value.expr)) ||
      (typeof value.value === "string" && interpolationExpressions(value.value).some(uses))
    );
  };
}

/** Says where the missing numbers live, naming data files (tool handles mean nothing here). */
function plainLogicNote(spec: AnswerSurfaceSpec): string {
  const sources = Object.values(spec.data ?? {}).map((source) =>
    isToolDataSource(source) ? "a tool result" : source,
  );
  const from = sources.length > 0 ? ` from ${[...new Set(sources)].join(", ")}` : "";
  return `_Some values in this answer are calculated${from} in the CoWork app._`;
}

/** A readable text version of a surface, for channels, the CLI, search and older clients. */
export function answerSurfaceToPlainText(
  spec: AnswerSurfaceSpec,
  state?: AnswerSurfaceState,
): string {
  const current = state ?? initialSurfaceState(spec);
  const scope = buildSurfaceScope(spec, current);
  const dependsOnLogic = logicDependence(spec);
  const lines = plainLines(spec.root, scope, current, { dependsOnLogic }).filter(
    (line) => line.trim().length > 0 && !line.includes(NEEDS_LOGIC),
  );
  if (spec.logic) lines.push(plainLogicNote(spec));
  return lines.join("\n");
}

/**
 * The readable text of an assistant message for every surface without the desktop
 * renderer (channel gateways, the CLI, notifications, the tray, search): ```cowork-ui
 * blocks become their text version (invalid or unfinished ones are dropped rather than
 * shown as raw JSON), and rich embeds (frames, HTML pages, videos) become one line each.
 */
export function toPlainAnswerText(message: string): string {
  if (!hasAnswerSurfaceBlock(message)) return richEmbedsToPlainText(message);
  const withSurfaces = splitAnswerSurfaceBlocks(message)
    .map((part) => {
      if (part.kind === "text") return part.text;
      if (!part.closed) return "";
      const parsed = parseAnswerSurfaceSource(part.source);
      return parsed.ok ? answerSurfaceToPlainText(parsed.spec) : "";
    })
    .join("\n");
  return richEmbedsToPlainText(withSurfaces)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Removes every ```cowork-ui block, finished or not, for previews that show prose only. */
export function withoutAnswerSurfaceBlocks(message: string): string {
  // Rich embeds (frames, pages) become one line too, so a preview never shows raw HTML.
  if (!hasAnswerSurfaceBlock(message)) return richEmbedsToPlainText(message);
  const prose = splitAnswerSurfaceBlocks(message)
    .filter((part) => part.kind === "text")
    .map((part) => (part.kind === "text" ? part.text : ""))
    .join("\n");
  return richEmbedsToPlainText(prose)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * What the user changed in a surface, as short lines for the next turn's context: control
 * values that differ from their defaults, checklist progress and tile selections.
 */
export function summarizeSurfaceChanges(
  spec: AnswerSurfaceSpec,
  state: AnswerSurfaceState,
): string[] {
  const defaults = initialSurfaceState(spec);
  const lines: string[] = [];
  walkSurface(spec.root, (node) => {
    switch (node.type) {
      case "stepper":
      case "slider":
      case "number":
        if (state[node.id] !== defaults[node.id] && typeof state[node.id] === "number") {
          lines.push(`${node.label}: ${formatControlValue(state[node.id] as number, node)}`);
        }
        break;
      case "select":
        if (state[node.id] !== defaults[node.id]) {
          const option = node.options.find((candidate) => candidate.value === state[node.id]);
          lines.push(`${node.label}: ${option?.label ?? String(state[node.id])}`);
        }
        break;
      case "toggle":
        if (state[node.id] !== defaults[node.id])
          lines.push(`${node.label}: ${state[node.id] ? "on" : "off"}`);
        break;
      case "checklist": {
        const checked = Array.isArray(state[node.id]) ? (state[node.id] as string[]) : [];
        if (checked.length === 0) break;
        const done = node.items
          .filter((item) => checked.includes(item.id))
          .map((item) => item.text);
        lines.push(
          `${node.title ?? "Checklist"}: ${done.length}/${node.items.length} done (${done.join("; ")})`,
        );
        break;
      }
      case "tiles":
        if (node.id && typeof state[node.id] === "string" && state[node.id]) {
          lines.push(`Selected: ${state[node.id] as string}`);
        }
        break;
      default:
        break;
    }
  });
  return lines;
}
