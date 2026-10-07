import {
  initialSurfaceState,
  nodeChildren,
  parseAnswerSurfaceSource,
  walkSurface,
  type AnswerSurfaceNode,
  type AnswerSurfaceSpec,
  type AnswerSurfaceState,
} from "./schema";
import {
  buildSurfaceScope,
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

function plainLines(
  node: AnswerSurfaceNode,
  scope: SurfaceScope,
  state: AnswerSurfaceState,
): string[] {
  const text = (value: string) => interpolateText(value, scope);
  switch (node.type) {
    case "card": {
      const lines = [
        node.eyebrow ? text(node.eyebrow) : "",
        node.title ? `**${text(node.title)}**` : "",
        node.subtitle ? text(node.subtitle) : "",
      ];
      return [...lines, ...nodeChildren(node).flatMap((child) => plainLines(child, scope, state))];
    }
    case "stack":
    case "grid":
      return nodeChildren(node).flatMap((child) => plainLines(child, scope, state));
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
      return node.items.map(
        (item) => `- ${text(item.label)}: ${formatSurfaceValue(item.value, scope)}`,
      );
    case "values": {
      const lines = node.items.map(
        (item) => `- ${text(item.label)}: ${formatSurfaceValue(item.value, scope)}`,
      );
      return node.title ? [`**${text(node.title)}**`, ...lines] : lines;
    }
    case "table": {
      const header = `| ${node.columns.join(" | ")} |`;
      const divider = `| ${node.columns.map(() => "---").join(" | ")} |`;
      const rows = node.rows.map(
        (row) =>
          `| ${node.columns.map((_column, index) => (row[index] === undefined ? "" : formatSurfaceValue(row[index], scope))).join(" | ")} |`,
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
      const lines = node.labels.map((labelText, index) => {
        const values = node.series
          .map((series) => {
            const value = series.values[index];
            const formatted = value === undefined ? "—" : formatSurfaceValue(value, scope);
            return node.series.length > 1 ? `${series.name} ${formatted}` : formatted;
          })
          .join(", ");
        return `- ${labelText}: ${values}${node.unit ? ` ${node.unit}` : ""}`;
      });
      return node.title ? [`**${text(node.title)}**`, ...lines] : lines;
    }
    case "stepper":
    case "slider": {
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

/** A readable text version of a surface, for channels, the CLI, search and older clients. */
export function answerSurfaceToPlainText(
  spec: AnswerSurfaceSpec,
  state?: AnswerSurfaceState,
): string {
  const current = state ?? initialSurfaceState(spec);
  const scope = buildSurfaceScope(spec, current);
  return plainLines(spec.root, scope, current)
    .filter((line) => line.trim().length > 0)
    .join("\n");
}

/**
 * Replaces every ```cowork-ui block with its text version. Invalid or unfinished blocks
 * are dropped rather than shown as raw JSON.
 */
export function toPlainAnswerText(message: string): string {
  if (!hasAnswerSurfaceBlock(message)) return message;
  return splitAnswerSurfaceBlocks(message)
    .map((part) => {
      if (part.kind === "text") return part.text;
      if (!part.closed) return "";
      const parsed = parseAnswerSurfaceSource(part.source);
      return parsed.ok ? answerSurfaceToPlainText(parsed.spec) : "";
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Removes every ```cowork-ui block, finished or not, for previews that show prose only. */
export function withoutAnswerSurfaceBlocks(message: string): string {
  if (!hasAnswerSurfaceBlock(message)) return message;
  return splitAnswerSurfaceBlocks(message)
    .filter((part) => part.kind === "text")
    .map((part) => (part.kind === "text" ? part.text : ""))
    .join("\n")
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
