import { z } from "zod";
import {
  ExpressionError,
  MAX_EXPRESSION_LENGTH,
  compileExpression,
  expressionIdentifiers,
  isValidIdentifier,
} from "./expression";

/**
 * Native answer surfaces: trusted CoWork components that a model describes as data in a
 * fenced ```cowork-ui block inside its answer. The model chooses components and supplies
 * content, control definitions and formulas; it never supplies code or styles.
 */

export const ANSWER_SURFACE_SCHEMA_VERSION = 1;
export const MAX_SURFACE_NODES = 150;
export const MAX_SURFACE_DEPTH = 6;
export const MAX_SURFACE_SOURCE_CHARS = 24_000;

export type AnswerSurfaceTone = "blue" | "pink" | "yellow" | "green" | "purple" | "orange" | "gray";

export type AnswerSurfaceImageRef = {
  /** A short description the host turns into a photo through its image search. */
  query?: string;
  /** An https image the host fetches on the model's behalf. */
  src?: string;
  alt: string;
};

export type AnswerSurfaceValue =
  | number
  | string
  | { expr?: string; value?: number | string; decimals?: number; unit?: string; prefix?: string };

export type AnswerSurfaceChoice = { label: string; value: string | number };

type ContainerFields = { computed?: Record<string, string> };

export type AnswerSurfaceNode =
  | ({
      type: "card";
      title?: string;
      eyebrow?: string;
      subtitle?: string;
      children: AnswerSurfaceNode[];
    } & ContainerFields)
  | ({ type: "stack"; children: AnswerSurfaceNode[] } & ContainerFields)
  | ({ type: "grid"; columns?: 2 | 3 | 4; children: AnswerSurfaceNode[] } & ContainerFields)
  | { type: "heading"; text: string; level?: 2 | 3 | 4 }
  | { type: "text"; text: string; tone?: "default" | "muted" }
  | {
      type: "image";
      image: AnswerSurfaceImageRef;
      caption?: string;
      aspect?: "wide" | "square" | "portrait";
    }
  | { type: "gallery"; layout?: "collage" | "grid" | "row"; images: AnswerSurfaceImageRef[] }
  | {
      type: "media_list";
      items: Array<{
        title: string;
        text?: string;
        meta?: string;
        badge?: string;
        image?: AnswerSurfaceImageRef;
      }>;
    }
  | {
      type: "tiles";
      id?: string;
      selectable?: boolean;
      caption?: string;
      items: Array<{ title: string; subtitle?: string; emoji?: string; tone?: AnswerSurfaceTone }>;
    }
  | {
      type: "metrics";
      items: Array<{ label: string; value: AnswerSurfaceValue; caption?: string }>;
    }
  | {
      type: "values";
      title?: string;
      items: Array<{ label: string; value: AnswerSurfaceValue; note?: string }>;
    }
  | { type: "table"; caption?: string; columns: string[]; rows: AnswerSurfaceValue[][] }
  | {
      type: "checklist";
      id: string;
      title?: string;
      items: Array<{ id: string; text: string; detail?: string; time?: string }>;
    }
  | {
      type: "chart";
      kind: "bar" | "line" | "area" | "pie";
      title?: string;
      unit?: string;
      labels: string[];
      series: Array<{ name: string; values: AnswerSurfaceValue[] }>;
    }
  | {
      type: "stepper";
      id: string;
      label: string;
      min: number;
      max: number;
      step?: number;
      default: number;
      unit?: string;
    }
  | {
      type: "slider";
      id: string;
      label: string;
      min: number;
      max: number;
      step?: number;
      default: number;
      unit?: string;
      prefix?: string;
    }
  | {
      type: "select";
      id: string;
      label: string;
      options: AnswerSurfaceChoice[];
      default: string | number;
    }
  | { type: "toggle"; id: string; label: string; default: boolean }
  | { type: "callout"; tone?: "info" | "tip" | "warning"; title?: string; text: string }
  | { type: "copy"; label: string; text: string }
  | { type: "divider" };

export type AnswerSurfaceNodeType = AnswerSurfaceNode["type"];
export type AnswerSurfaceSpec = { version: number; root: AnswerSurfaceNode };
export type AnswerSurfaceStateValue = number | string | boolean | string[];
export type AnswerSurfaceState = Record<string, AnswerSurfaceStateValue>;

const label = (max = 300) => z.string().trim().min(1).max(max);
const optionalLabel = (max = 600) => z.string().trim().max(max).optional();
const controlId = z.string().trim().refine(isValidIdentifier, "must be a simple identifier");
const finite = z.number().finite();
const tone = z.enum(["blue", "pink", "yellow", "green", "purple", "orange", "gray"]);

const imageRefSchema = z
  .union([
    z.string().trim().min(1).max(200),
    z.object({
      query: z.string().trim().min(1).max(200).optional(),
      src: z
        .string()
        .trim()
        .max(2048)
        .regex(/^https:\/\//i, "image src must be an https URL")
        .optional(),
      alt: z.string().trim().max(200).optional(),
    }),
  ])
  .transform((value, ctx): AnswerSurfaceImageRef => {
    if (typeof value === "string") return { query: value, alt: value };
    if (!value.query && !value.src) {
      ctx.addIssue({ code: "custom", message: "image needs a query or src" });
      return z.NEVER;
    }
    return { query: value.query, src: value.src, alt: value.alt || value.query || "" };
  });

const valueSchema: z.ZodType<AnswerSurfaceValue> = z.union([
  finite,
  z.string().max(300),
  z.object({
    expr: z.string().trim().min(1).max(MAX_EXPRESSION_LENGTH).optional(),
    value: z.union([finite, z.string().max(300)]).optional(),
    decimals: z.number().int().min(0).max(6).optional(),
    unit: z.string().trim().max(24).optional(),
    prefix: z.string().trim().max(8).optional(),
  }),
]);

const computedSchema = z
  .record(controlId, z.string().trim().min(1).max(MAX_EXPRESSION_LENGTH))
  .optional();

const nodeSchema: z.ZodType<AnswerSurfaceNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("card"),
      title: optionalLabel(200),
      eyebrow: optionalLabel(80),
      subtitle: optionalLabel(300),
      computed: computedSchema,
      children: z.array(nodeSchema).max(30),
    }),
    z.object({
      type: z.literal("stack"),
      computed: computedSchema,
      children: z.array(nodeSchema).max(30),
    }),
    z.object({
      type: z.literal("grid"),
      columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
      computed: computedSchema,
      children: z.array(nodeSchema).max(24),
    }),
    z.object({
      type: z.literal("heading"),
      text: label(200),
      level: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
    }),
    z.object({
      type: z.literal("text"),
      text: label(2000),
      tone: z.enum(["default", "muted"]).optional(),
    }),
    z.object({
      type: z.literal("image"),
      image: imageRefSchema,
      caption: optionalLabel(200),
      aspect: z.enum(["wide", "square", "portrait"]).optional(),
    }),
    z.object({
      type: z.literal("gallery"),
      layout: z.enum(["collage", "grid", "row"]).optional(),
      images: z.array(imageRefSchema).min(1).max(8),
    }),
    z.object({
      type: z.literal("media_list"),
      items: z
        .array(
          z.object({
            title: label(200),
            text: optionalLabel(600),
            meta: optionalLabel(120),
            badge: optionalLabel(40),
            image: imageRefSchema.optional(),
          }),
        )
        .min(1)
        .max(12),
    }),
    z.object({
      type: z.literal("tiles"),
      id: controlId.optional(),
      selectable: z.boolean().optional(),
      caption: optionalLabel(300),
      items: z
        .array(
          z.object({
            title: label(80),
            subtitle: optionalLabel(160),
            emoji: z.string().trim().max(16).optional(),
            tone: tone.optional(),
          }),
        )
        .min(1)
        .max(12),
    }),
    z.object({
      type: z.literal("metrics"),
      items: z
        .array(z.object({ label: label(120), value: valueSchema, caption: optionalLabel(160) }))
        .min(1)
        .max(8),
    }),
    z.object({
      type: z.literal("values"),
      title: optionalLabel(200),
      items: z
        .array(z.object({ label: label(160), value: valueSchema, note: optionalLabel(200) }))
        .min(1)
        .max(30),
    }),
    z.object({
      type: z.literal("table"),
      caption: optionalLabel(200),
      columns: z.array(label(80)).min(1).max(8),
      rows: z.array(z.array(valueSchema).max(8)).min(1).max(40),
    }),
    z.object({
      type: z.literal("checklist"),
      id: controlId,
      title: optionalLabel(200),
      items: z
        .array(
          z.union([
            z.string().trim().min(1).max(300),
            z.object({
              id: controlId.optional(),
              text: label(300),
              detail: optionalLabel(300),
              time: optionalLabel(40),
            }),
          ]),
        )
        .min(1)
        .max(30)
        .transform((items) =>
          items.map((item, index) =>
            typeof item === "string"
              ? { id: `item_${index + 1}`, text: item }
              : { ...item, id: item.id || `item_${index + 1}` },
          ),
        ),
    }),
    z.object({
      type: z.literal("chart"),
      kind: z.enum(["bar", "line", "area", "pie"]),
      title: optionalLabel(200),
      unit: z.string().trim().max(24).optional(),
      labels: z.array(label(60)).min(1).max(40),
      series: z
        .array(z.object({ name: label(60), values: z.array(valueSchema).min(1).max(40) }))
        .min(1)
        .max(4),
    }),
    z.object({
      type: z.literal("stepper"),
      id: controlId,
      label: label(120),
      min: finite,
      max: finite,
      step: z.number().positive().finite().optional(),
      default: finite,
      unit: z.string().trim().max(24).optional(),
    }),
    z.object({
      type: z.literal("slider"),
      id: controlId,
      label: label(120),
      min: finite,
      max: finite,
      step: z.number().positive().finite().optional(),
      default: finite,
      unit: z.string().trim().max(24).optional(),
      prefix: z.string().trim().max(8).optional(),
    }),
    z.object({
      type: z.literal("select"),
      id: controlId,
      label: label(120),
      options: z
        .array(z.object({ label: label(80), value: z.union([z.string().max(80), finite]) }))
        .min(1)
        .max(20),
      default: z.union([z.string().max(80), finite]),
    }),
    z.object({ type: z.literal("toggle"), id: controlId, label: label(120), default: z.boolean() }),
    z.object({
      type: z.literal("callout"),
      tone: z.enum(["info", "tip", "warning"]).optional(),
      title: optionalLabel(120),
      text: label(800),
    }),
    z.object({ type: z.literal("copy"), label: label(60), text: label(4000) }),
    z.object({ type: z.literal("divider") }),
  ]),
) as z.ZodType<AnswerSurfaceNode>;

export type AnswerSurfaceParseResult =
  | { ok: true; spec: AnswerSurfaceSpec }
  | { ok: false; error: string };

const INTERPOLATION_REGEX = /\{\{\s*([^{}]{1,400}?)\s*\}\}/g;

export function interpolationExpressions(text: string): string[] {
  return [...text.matchAll(INTERPOLATION_REGEX)].map((match) => match[1]);
}

export function replaceInterpolations(text: string, render: (expr: string) => string): string {
  return text.replace(INTERPOLATION_REGEX, (_match, expr: string) => render(expr));
}

/** Children of a container node, or an empty list. */
export function nodeChildren(node: AnswerSurfaceNode): AnswerSurfaceNode[] {
  return node.type === "card" || node.type === "stack" || node.type === "grid" ? node.children : [];
}

/** Every node in document order, with its depth (root = 1). */
export function walkSurface(
  root: AnswerSurfaceNode,
  visit: (node: AnswerSurfaceNode, depth: number) => void,
  depth = 1,
): void {
  visit(root, depth);
  for (const child of nodeChildren(root)) walkSurface(child, visit, depth + 1);
}

function stripJsonNoise(source: string): string {
  // Models occasionally emit comments or trailing commas; remove both outside strings.
  let output = "";
  let inString = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      output += char;
      if (char === "\\") {
        output += source[index + 1] ?? "";
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
    } else if (char === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      output += "\n";
    } else if (char === ",") {
      const rest = source.slice(index + 1).match(/^\s*([\]}])/);
      if (!rest) output += char;
    } else {
      output += char;
    }
  }
  return output;
}

function parseJsonLenient(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    return JSON.parse(stripJsonNoise(source));
  }
}

function formatIssues(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid interactive answer";
  const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return `${path}${issue.message}`;
}

/** Checks the rules a schema cannot express: size, ids, formulas and control bounds. */
function validateSemantics(root: AnswerSurfaceNode): string | null {
  let nodes = 0;
  let tooDeep = false;
  const controls = new Set<string>();
  const expressions: string[] = [];
  let problem: string | null = null;

  const declare = (id: string) => {
    if (controls.has(id)) problem ??= `Duplicate control id "${id}"`;
    controls.add(id);
  };
  const collectValue = (value: AnswerSurfaceValue) => {
    if (typeof value === "string") expressions.push(...interpolationExpressions(value));
    else if (typeof value === "object" && value.expr) expressions.push(value.expr);
  };
  const collectText = (...texts: Array<string | undefined>) => {
    for (const text of texts) if (text) expressions.push(...interpolationExpressions(text));
  };

  walkSurface(root, (node, depth) => {
    nodes += 1;
    if (depth > MAX_SURFACE_DEPTH) tooDeep = true;
    switch (node.type) {
      case "card":
      case "stack":
      case "grid":
        if (node.type === "card") collectText(node.title, node.subtitle, node.eyebrow);
        for (const [id, expr] of Object.entries(node.computed ?? {})) {
          declare(id);
          expressions.push(expr);
        }
        break;
      case "heading":
      case "text":
        collectText(node.text);
        break;
      case "callout":
        collectText(node.title, node.text);
        break;
      case "copy":
        collectText(node.text);
        break;
      case "media_list":
        for (const item of node.items) collectText(item.title, item.text, item.meta);
        break;
      case "metrics":
        for (const item of node.items) {
          collectText(item.label, item.caption);
          collectValue(item.value);
        }
        break;
      case "values":
        collectText(node.title);
        for (const item of node.items) {
          collectText(item.label, item.note);
          collectValue(item.value);
        }
        break;
      case "table":
        for (const row of node.rows) row.forEach(collectValue);
        break;
      case "chart":
        for (const series of node.series) series.values.forEach(collectValue);
        break;
      case "tiles":
        if (node.id) declare(node.id);
        break;
      case "checklist": {
        declare(node.id);
        const itemIds = new Set<string>();
        for (const item of node.items) {
          if (itemIds.has(item.id)) problem ??= `Duplicate checklist item id "${item.id}"`;
          itemIds.add(item.id);
        }
        break;
      }
      case "stepper":
      case "slider":
        declare(node.id);
        if (node.min >= node.max) problem ??= `"${node.id}" needs min below max`;
        if (node.default < node.min || node.default > node.max) {
          problem ??= `"${node.id}" default is outside its range`;
        }
        break;
      case "select":
        declare(node.id);
        if (!node.options.some((option) => option.value === node.default)) {
          problem ??= `"${node.id}" default is not one of its options`;
        }
        break;
      case "toggle":
        declare(node.id);
        break;
      default:
        break;
    }
  });

  if (nodes > MAX_SURFACE_NODES) return `Too many components (${nodes})`;
  if (tooDeep) return "Components are nested too deeply";
  if (problem) return problem;

  for (const expr of expressions) {
    try {
      for (const name of expressionIdentifiers(expr)) {
        if (!controls.has(name)) return `Formula "${expr}" uses unknown value "${name}"`;
      }
    } catch (error) {
      const reason = error instanceof ExpressionError ? error.message : "invalid formula";
      return `Formula "${expr}": ${reason}`;
    }
  }
  return null;
}

/** Parses and validates the JSON body of a ```cowork-ui block. */
export function parseAnswerSurfaceSource(source: string): AnswerSurfaceParseResult {
  const trimmed = String(source || "").trim();
  if (!trimmed) return { ok: false, error: "Empty interactive answer" };
  if (trimmed.length > MAX_SURFACE_SOURCE_CHARS) {
    return { ok: false, error: "Interactive answer is too large" };
  }
  let raw: unknown;
  try {
    raw = parseJsonLenient(trimmed);
  } catch {
    return { ok: false, error: "Interactive answer is not valid JSON" };
  }
  if (Array.isArray(raw)) raw = { type: "stack", children: raw };
  let version = ANSWER_SURFACE_SCHEMA_VERSION;
  if (raw && typeof raw === "object" && "v" in raw) {
    const { v, ...rest } = raw as Record<string, unknown>;
    if (typeof v === "number") version = v;
    raw = rest;
  }
  if (version > ANSWER_SURFACE_SCHEMA_VERSION) {
    return { ok: false, error: "This interactive answer needs a newer version of CoWork" };
  }
  const parsed = nodeSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: formatIssues(parsed.error) };
  const problem = validateSemantics(parsed.data);
  if (problem) return { ok: false, error: problem };
  return { ok: true, spec: { version, root: parsed.data } };
}

/** The value each control starts with, before any saved state is applied. */
export function initialSurfaceState(spec: AnswerSurfaceSpec): AnswerSurfaceState {
  const state: AnswerSurfaceState = {};
  walkSurface(spec.root, (node) => {
    switch (node.type) {
      case "stepper":
      case "slider":
      case "select":
      case "toggle":
        state[node.id] = node.default;
        break;
      case "checklist":
        state[node.id] = [];
        break;
      case "tiles":
        if (node.id && node.selectable) state[node.id] = "";
        break;
      default:
        break;
    }
  });
  return state;
}

/**
 * Applies saved values over the defaults, keeping only values that still fit the current
 * controls (a revised answer may have renamed, removed or re-ranged a control).
 */
export function mergeSurfaceState(
  spec: AnswerSurfaceSpec,
  saved: Record<string, unknown> | null | undefined,
): AnswerSurfaceState {
  const state = initialSurfaceState(spec);
  if (!saved || typeof saved !== "object") return state;
  walkSurface(spec.root, (node) => {
    if (!("id" in node) || !node.id || !(node.id in saved)) return;
    const value = saved[node.id];
    switch (node.type) {
      case "stepper":
      case "slider":
        if (typeof value === "number" && value >= node.min && value <= node.max)
          state[node.id] = value;
        break;
      case "select":
        if (node.options.some((option) => option.value === value))
          state[node.id] = value as string | number;
        break;
      case "toggle":
        if (typeof value === "boolean") state[node.id] = value;
        break;
      case "checklist": {
        const ids = new Set(node.items.map((item) => item.id));
        if (Array.isArray(value)) {
          state[node.id] = value.filter(
            (id): id is string => typeof id === "string" && ids.has(id),
          );
        }
        break;
      }
      case "tiles":
        if (typeof value === "string" && node.items.some((item) => item.title === value)) {
          state[node.id] = value;
        }
        break;
      default:
        break;
    }
  });
  return state;
}

/** Verifies the module's formulas compile; used by tests and the prompt examples. */
export function isValidSurfaceExpression(expr: string): boolean {
  try {
    compileExpression(expr);
    return true;
  } catch {
    return false;
  }
}
