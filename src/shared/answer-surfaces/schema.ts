import { z } from "zod";
import {
  ExpressionError,
  MAX_EXPRESSION_LENGTH,
  compileExpression,
  expressionIdentifiers,
  isValidIdentifier,
} from "./expression";
import { AnswerSurfaceDataSchema, type AnswerSurfaceData } from "./data";
import { AnswerSurfaceLogicSchema, type AnswerSurfaceLogic } from "./logic";
import { normalizeSurfaceIcon } from "./icons";

/**
 * Native answer surfaces: trusted CoWork components that a model describes as data in a
 * fenced ```cowork-ui block inside its answer. The model chooses components and supplies
 * content, control definitions and formulas; it never supplies code or styles.
 */

export const ANSWER_SURFACE_SCHEMA_VERSION = 1;
export const MAX_SURFACE_NODES = 150;
export const MAX_SURFACE_DEPTH = 6;
export const MAX_SURFACE_SOURCE_CHARS = 24_000;

export const ANSWER_SURFACE_THEMES = [
  "accent",
  "ocean",
  "violet",
  "sunset",
  "forest",
  "ember",
  "rose",
  "mono",
] as const;

/** A curated palette for a container and everything inside it (accents, gradients, charts). */
export type AnswerSurfaceTheme = (typeof ANSWER_SURFACE_THEMES)[number];

export const ANSWER_SURFACE_TONES = [
  "accent",
  "blue",
  "teal",
  "green",
  "yellow",
  "orange",
  "red",
  "pink",
  "purple",
  "gray",
] as const;

export type AnswerSurfaceTone = (typeof ANSWER_SURFACE_TONES)[number];

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
  | {
      expr?: string;
      value?: number | string;
      decimals?: number;
      unit?: string;
      prefix?: string;
      /** Set by the app for text from surface logic: shown as-is, never interpolated. */
      literal?: boolean;
    };

export type AnswerSurfaceChoice = { label: string; value: string | number };

/** A list or table produced by the surface's logic, by output name. */
export type AnswerSurfaceBind = { bind: string };

export function isSurfaceBind(value: unknown): value is AnswerSurfaceBind {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "bind" in (value as object)
  );
}

export type AnswerSurfaceDirection = "up" | "down" | "flat";

type ContainerFields = { computed?: Record<string, string>; theme?: AnswerSurfaceTheme };

export type AnswerSurfaceNode =
  | ({
      type: "card";
      title?: string;
      eyebrow?: string;
      subtitle?: string;
      icon?: string;
      style?: "plain" | "tinted" | "gradient";
      children: AnswerSurfaceNode[];
    } & ContainerFields)
  | ({ type: "stack"; children: AnswerSurfaceNode[] } & ContainerFields)
  | ({
      type: "grid";
      columns?: 2 | 3 | 4;
      /** Column span per child, in order (bento layouts). */
      spans?: number[];
      children: AnswerSurfaceNode[];
    } & ContainerFields)
  | ({
      type: "tabs";
      tabs: Array<{ label: string; icon?: string; children: AnswerSurfaceNode[] }>;
    } & ContainerFields)
  | {
      type: "hero";
      eyebrow?: string;
      title: string;
      value?: AnswerSurfaceValue;
      caption?: string;
      icon?: string;
      image?: AnswerSurfaceImageRef;
      style?: "gradient" | "soft" | "image";
      delta?: AnswerSurfaceValue;
      direction?: AnswerSurfaceDirection;
    }
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
      items: Array<{
        title: string;
        subtitle?: string;
        emoji?: string;
        icon?: string;
        tone?: AnswerSurfaceTone;
      }>;
    }
  | {
      type: "metrics";
      style?: "cards" | "colorful" | "plain";
      items: Array<{
        label: string;
        value: AnswerSurfaceValue;
        caption?: string;
        icon?: string;
        tone?: AnswerSurfaceTone;
        delta?: AnswerSurfaceValue;
        direction?: AnswerSurfaceDirection;
        /** Which direction is good news; colors the delta (default up). */
        good?: "up" | "down";
        spark?: number[];
      }>;
    }
  | {
      type: "progress";
      title?: string;
      style?: "bar" | "ring";
      items: Array<{
        label: string;
        value: AnswerSurfaceValue;
        max?: number;
        caption?: string;
        tone?: AnswerSurfaceTone;
      }>;
    }
  | {
      type: "timeline";
      title?: string;
      items: Array<{
        title: string;
        text?: string;
        time?: string;
        icon?: string;
        status?: "done" | "current" | "upcoming";
        tone?: AnswerSurfaceTone;
      }>;
    }
  | {
      type: "tags";
      items: Array<{ label: string; tone?: AnswerSurfaceTone; icon?: string }>;
    }
  | {
      type: "values";
      title?: string;
      items: Array<{ label: string; value: AnswerSurfaceValue; note?: string }>;
    }
  | {
      type: "table";
      caption?: string;
      columns: string[];
      rows: AnswerSurfaceValue[][] | AnswerSurfaceBind;
    }
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
      prefix?: string;
      format?: "number" | "compact" | "percent";
      stacked?: boolean;
      horizontal?: boolean;
      height?: "sm" | "md" | "lg";
      labels: string[] | AnswerSurfaceBind;
      series: Array<{
        name: string;
        values: AnswerSurfaceValue[] | AnswerSurfaceBind;
        style?: "solid" | "muted" | "dashed";
        tone?: AnswerSurfaceTone;
      }>;
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
      type: "number";
      id: string;
      label: string;
      min?: number;
      max?: number;
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
  | {
      type: "callout";
      tone?: "info" | "tip" | "warning" | "success";
      title?: string;
      text: string;
      icon?: string;
    }
  | { type: "copy"; label: string; text: string }
  | { type: "divider" };

export type AnswerSurfaceNodeType = AnswerSurfaceNode["type"];
export type AnswerSurfaceSpec = {
  version: number;
  root: AnswerSurfaceNode;
  /** Code that computes named outputs from the controls (see logic.ts). */
  logic?: AnswerSurfaceLogic;
  /** Workspace files the logic computes from, by id (see data.ts). */
  data?: AnswerSurfaceData;
};
export type AnswerSurfaceStateValue = number | string | boolean | string[];
export type AnswerSurfaceState = Record<string, AnswerSurfaceStateValue>;

const label = (max = 300) => z.string().trim().min(1).max(max);
const optionalLabel = (max = 600) => z.string().trim().max(max).optional();
const controlId = z.string().trim().refine(isValidIdentifier, "must be a simple identifier");
const finite = z.number().finite();
/*
 * Decorative fields (tones, themes, styles, icons) fall back to the default instead of
 * rejecting the surface: a misspelled color should never cost the user the whole answer.
 */
const lenient = <T extends z.ZodTypeAny>(schema: T) => schema.optional().catch(undefined);
const tone = lenient(z.enum(ANSWER_SURFACE_TONES));
const theme = lenient(z.enum(ANSWER_SURFACE_THEMES));
const icon = lenient(
  z
    .string()
    .max(40)
    .transform((value) => normalizeSurfaceIcon(value)),
);
const direction = lenient(z.enum(["up", "down", "flat"]));

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

const bindSchema = z
  .object({ bind: z.string().trim().refine(isValidIdentifier, "must be a simple identifier") })
  .strict();

const computedSchema = z
  .record(controlId, z.string().trim().min(1).max(MAX_EXPRESSION_LENGTH))
  .optional();

const childrenSchema = (max: number) => z.array(z.lazy(() => nodeSchema)).max(max);

const nodeSchema: z.ZodType<AnswerSurfaceNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("card"),
      title: optionalLabel(200),
      eyebrow: optionalLabel(80),
      subtitle: optionalLabel(300),
      icon,
      style: lenient(z.enum(["plain", "tinted", "gradient"])),
      computed: computedSchema,
      theme,
      children: childrenSchema(30),
    }),
    z.object({
      type: z.literal("stack"),
      computed: computedSchema,
      theme,
      children: childrenSchema(30),
    }),
    z.object({
      type: z.literal("grid"),
      columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
      spans: lenient(z.array(z.number().int().min(1).max(4)).max(24)),
      computed: computedSchema,
      theme,
      children: childrenSchema(24),
    }),
    z.object({
      type: z.literal("tabs"),
      computed: computedSchema,
      theme,
      tabs: z
        .array(z.object({ label: label(40), icon, children: childrenSchema(20) }))
        .min(2)
        .max(6),
    }),
    z.object({
      type: z.literal("hero"),
      eyebrow: optionalLabel(80),
      title: label(200),
      value: valueSchema.optional(),
      caption: optionalLabel(300),
      icon,
      image: imageRefSchema.optional(),
      style: lenient(z.enum(["gradient", "soft", "image"])),
      delta: valueSchema.optional(),
      direction,
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
            icon,
            tone,
          }),
        )
        .min(1)
        .max(12),
    }),
    z.object({
      type: z.literal("metrics"),
      style: lenient(z.enum(["cards", "colorful", "plain"])),
      items: z
        .array(
          z.object({
            label: label(120),
            value: valueSchema,
            caption: optionalLabel(160),
            icon,
            tone,
            delta: valueSchema.optional(),
            direction,
            good: lenient(z.enum(["up", "down"])),
            spark: lenient(z.array(finite).min(2).max(40)),
          }),
        )
        .min(1)
        .max(8),
    }),
    z.object({
      type: z.literal("progress"),
      title: optionalLabel(200),
      style: lenient(z.enum(["bar", "ring"])),
      items: z
        .array(
          z.object({
            label: label(120),
            value: valueSchema,
            max: z.number().positive().finite().optional(),
            caption: optionalLabel(160),
            tone,
          }),
        )
        .min(1)
        .max(8),
    }),
    z.object({
      type: z.literal("timeline"),
      title: optionalLabel(200),
      items: z
        .array(
          z.object({
            title: label(200),
            text: optionalLabel(600),
            time: optionalLabel(60),
            icon,
            status: lenient(z.enum(["done", "current", "upcoming"])),
            tone,
          }),
        )
        .min(1)
        .max(20),
    }),
    z.object({
      type: z.literal("tags"),
      items: z
        .array(
          z.union([z.string().trim().min(1).max(60), z.object({ label: label(60), tone, icon })]),
        )
        .min(1)
        .max(20)
        .transform((items) =>
          items.map((item) => (typeof item === "string" ? { label: item } : item)),
        ),
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
      rows: z.union([z.array(z.array(valueSchema).max(8)).min(1).max(40), bindSchema]),
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
      prefix: z.string().trim().max(8).optional(),
      format: lenient(z.enum(["number", "compact", "percent"])),
      stacked: z.boolean().optional(),
      horizontal: z.boolean().optional(),
      height: lenient(z.enum(["sm", "md", "lg"])),
      labels: z.union([z.array(label(60)).min(1).max(40), bindSchema]),
      series: z
        .array(
          z.object({
            name: label(60),
            values: z.union([z.array(valueSchema).min(1).max(40), bindSchema]),
            style: lenient(z.enum(["solid", "muted", "dashed"])),
            tone,
          }),
        )
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
      type: z.literal("number"),
      id: controlId,
      label: label(120),
      min: finite.optional(),
      max: finite.optional(),
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
      tone: lenient(z.enum(["info", "tip", "warning", "success"])),
      title: optionalLabel(120),
      text: label(800),
      icon,
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
  if (node.type === "tabs") return node.tabs.flatMap((tab) => tab.children);
  return node.type === "card" || node.type === "stack" || node.type === "grid" ? node.children : [];
}

/** Containers carry `computed` values and an optional theme. */
export function isContainerNode(
  node: AnswerSurfaceNode,
): node is Extract<AnswerSurfaceNode, { type: "card" | "stack" | "grid" | "tabs" }> {
  return (
    node.type === "card" || node.type === "stack" || node.type === "grid" || node.type === "tabs"
  );
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
function validateSemantics(
  root: AnswerSurfaceNode,
  outputs: readonly string[] = [],
): string | null {
  let nodes = 0;
  let tooDeep = false;
  const controls = new Set<string>(outputs);
  const binds: string[] = [];
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
      case "tabs":
        if (node.type === "card") collectText(node.title, node.subtitle, node.eyebrow);
        for (const [id, expr] of Object.entries(node.computed ?? {})) {
          declare(id);
          expressions.push(expr);
        }
        break;
      case "hero":
        collectText(node.eyebrow, node.title, node.caption);
        if (node.value !== undefined) collectValue(node.value);
        if (node.delta !== undefined) collectValue(node.delta);
        break;
      case "progress":
        collectText(node.title);
        for (const item of node.items) {
          collectText(item.label, item.caption);
          collectValue(item.value);
        }
        break;
      case "timeline":
        collectText(node.title);
        for (const item of node.items) collectText(item.title, item.text, item.time);
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
          if (item.delta !== undefined) collectValue(item.delta);
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
        if (isSurfaceBind(node.rows)) binds.push(node.rows.bind);
        else for (const row of node.rows) row.forEach(collectValue);
        break;
      case "chart":
        if (isSurfaceBind(node.labels)) binds.push(node.labels.bind);
        for (const series of node.series) {
          if (isSurfaceBind(series.values)) binds.push(series.values.bind);
          else series.values.forEach(collectValue);
        }
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
      case "number":
        declare(node.id);
        if (node.min !== undefined && node.max !== undefined && node.min >= node.max) {
          problem ??= `"${node.id}" needs min below max`;
        }
        if (
          (node.min !== undefined && node.default < node.min) ||
          (node.max !== undefined && node.default > node.max)
        ) {
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

  for (const name of binds) {
    if (!outputs.includes(name)) return `"${name}" is bound but is not one of the logic outputs`;
  }
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
  // A theme on a lone component (a chart, a hero) applies through a wrapping stack.
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "theme" in raw) {
    const { theme: rootTheme, ...rest } = raw as Record<string, unknown>;
    const type = rest.type;
    if (type !== "card" && type !== "stack" && type !== "grid" && type !== "tabs") {
      raw = { type: "stack", theme: rootTheme, children: [rest] };
    }
  }
  // Logic sits beside the components it feeds, on the block's outer object.
  let logic: AnswerSurfaceLogic | undefined;
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "logic" in raw) {
    const { logic: rawLogic, ...rest } = raw as Record<string, unknown>;
    const parsedLogic = AnswerSurfaceLogicSchema.safeParse(rawLogic);
    if (!parsedLogic.success)
      return { ok: false, error: `logic: ${formatIssues(parsedLogic.error)}` };
    logic = parsedLogic.data;
    raw = rest;
  }
  let data: AnswerSurfaceData | undefined;
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "data" in raw) {
    const { data: rawData, ...rest } = raw as Record<string, unknown>;
    const parsedData = AnswerSurfaceDataSchema.safeParse(rawData);
    if (!parsedData.success) return { ok: false, error: `data: ${formatIssues(parsedData.error)}` };
    // Rows reach the screen only through logic, so data without logic does nothing.
    if (!logic) return { ok: false, error: "data: needs logic that computes from it" };
    data = parsedData.data;
    raw = rest;
  }
  if (version > ANSWER_SURFACE_SCHEMA_VERSION) {
    return { ok: false, error: "This interactive answer needs a newer version of CoWork" };
  }
  const parsed = nodeSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: formatIssues(parsed.error) };
  const problem = validateSemantics(parsed.data, logic?.outputs);
  if (problem) return { ok: false, error: problem };
  return {
    ok: true,
    spec: {
      version,
      root: parsed.data,
      ...(logic ? { logic } : {}),
      ...(data ? { data } : {}),
    },
  };
}

/** The value each control starts with, before any saved state is applied. */
export function initialSurfaceState(spec: AnswerSurfaceSpec): AnswerSurfaceState {
  const state: AnswerSurfaceState = {};
  walkSurface(spec.root, (node) => {
    switch (node.type) {
      case "stepper":
      case "slider":
      case "number":
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
      case "number":
        if (
          typeof value === "number" &&
          Number.isFinite(value) &&
          (node.min === undefined || value >= node.min) &&
          (node.max === undefined || value <= node.max)
        ) {
          state[node.id] = value;
        }
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
