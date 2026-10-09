import { evaluateExpression, type ExpressionValue } from "./expression";
import {
  initialSurfaceState,
  interpolationExpressions,
  isContainerNode,
  replaceInterpolations,
  walkSurface,
  type AnswerSurfaceSpec,
  type AnswerSurfaceState,
  type AnswerSurfaceValue,
} from "./schema";

export type SurfaceScope = Record<string, ExpressionValue>;

/**
 * The values formulas can read: every control's current value, a checklist's count of
 * ticked items, a selectable tile group's chosen title, then `computed` values in
 * document order (each may read the ones before it).
 */
export function buildSurfaceScope(
  spec: AnswerSurfaceSpec,
  state: AnswerSurfaceState,
): SurfaceScope {
  const scope: SurfaceScope = {};
  for (const [id, value] of Object.entries(state)) {
    scope[id] = Array.isArray(value) ? value.length : value;
  }
  walkSurface(spec.root, (node) => {
    if (!isContainerNode(node)) return;
    for (const [id, expr] of Object.entries(node.computed ?? {})) {
      const value = evaluateExpression(expr, scope);
      if (value !== null) scope[id] = value;
    }
  });
  return scope;
}

export function formatNumber(value: number, decimals?: number): string {
  const fractionDigits =
    decimals === undefined
      ? { maximumFractionDigits: Number.isInteger(value) ? 0 : 2 }
      : { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
  return new Intl.NumberFormat("en-US", fractionDigits).format(value);
}

function joinUnit(text: string, unit?: string, prefix?: string): string {
  const withPrefix = prefix ? `${prefix}${text}` : text;
  if (!unit) return withPrefix;
  return /^[%°]/.test(unit) ? `${withPrefix}${unit}` : `${withPrefix} ${unit}`;
}

export function formatExpressionValue(value: ExpressionValue | null, decimals?: number): string {
  if (value === null) return "—";
  if (typeof value === "number") return formatNumber(value, decimals);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return value;
}

export function interpolateText(text: string, scope: SurfaceScope): string {
  return replaceInterpolations(text, (expr) =>
    formatExpressionValue(evaluateExpression(expr, scope)),
  );
}

/** Renders a value cell: a literal, an interpolated string, or a formatted formula. */
export function formatSurfaceValue(value: AnswerSurfaceValue, scope: SurfaceScope): string {
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "string") return interpolateText(value, scope);
  const raw =
    value.expr !== undefined
      ? evaluateExpression(value.expr, scope)
      : value.value !== undefined
        ? value.value
        : null;
  if (raw === null) return "—";
  const text =
    typeof raw === "string"
      ? interpolateText(raw, scope)
      : formatExpressionValue(raw, value.decimals);
  return joinUnit(text, value.unit, value.prefix);
}

/** The numeric value of a cell for charts; null when it is not a number. */
export function numericSurfaceValue(value: AnswerSurfaceValue, scope: SurfaceScope): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const raw =
    value.expr !== undefined ? evaluateExpression(value.expr, scope) : (value.value ?? null);
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function formatControlValue(
  value: number,
  options: { unit?: string; prefix?: string; step?: number },
): string {
  const decimals =
    options.step && !Number.isInteger(options.step)
      ? String(options.step).split(".")[1]?.length
      : undefined;
  return joinUnit(formatNumber(value, decimals), options.unit, options.prefix);
}

/** Decimal places a number is written with, up to two (86.4 → 1), so tweening keeps them. */
function fractionDigits(value: number): number {
  if (Number.isInteger(value)) return 0;
  return Math.min(2, (String(value).split(".")[1] ?? "").length);
}

/**
 * A value as a number plus a formatter for any number near it, so the renderer can animate
 * between results and still show units, prefixes and the right precision.
 */
export function resolveSurfaceNumber(
  value: AnswerSurfaceValue,
  scope: SurfaceScope,
): { number: number; format: (value: number) => string } | null {
  const number = numericSurfaceValue(value, scope);
  if (number === null || !Number.isFinite(number)) return null;
  if (typeof value === "string") return null;
  if (typeof value === "number") return { number, format: (next) => formatNumber(next) };
  const decimals = value.decimals ?? fractionDigits(number);
  return {
    number,
    format: (next) => joinUnit(formatNumber(next, decimals), value.unit, value.prefix),
  };
}

const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** Axis and label text for chart numbers: compact for large values, with prefix and unit. */
export function formatChartNumber(
  value: number,
  options: { prefix?: string; unit?: string; format?: "number" | "compact" | "percent" },
): string {
  if (!Number.isFinite(value)) return "";
  const format = options.format ?? (Math.abs(value) >= 10_000 ? "compact" : "number");
  const text =
    format === "compact"
      ? COMPACT.format(value)
      : format === "percent"
        ? `${formatNumber(value, Number.isInteger(value) ? 0 : 1)}%`
        : formatNumber(value, Number.isInteger(value) ? 0 : Math.abs(value) < 10 ? 2 : 1);
  return joinUnit(text, format === "percent" ? undefined : options.unit, options.prefix);
}

/**
 * Formulas that produce no value with the surface's default inputs (division by zero, a
 * typo'd function, a NaN). The renderer shows "—" for these, so tests and evals use this
 * to catch answers whose headline number would be blank.
 */
export function lintAnswerSurface(spec: AnswerSurfaceSpec): string[] {
  const scope = buildSurfaceScope(spec, initialSurfaceState(spec));
  const problems: string[] = [];
  const check = (value: AnswerSurfaceValue | undefined) => {
    if (value === undefined) return;
    if (typeof value === "string") {
      for (const expr of interpolationExpressions(value)) {
        if (evaluateExpression(expr, scope) === null) problems.push(`{{${expr}}} has no value`);
      }
      return;
    }
    if (typeof value === "object" && value.expr && evaluateExpression(value.expr, scope) === null) {
      problems.push(`"${value.expr}" has no value`);
    }
  };
  walkSurface(spec.root, (node) => {
    switch (node.type) {
      case "hero":
        check(node.value);
        check(node.delta);
        break;
      case "metrics":
        for (const item of node.items) {
          check(item.value);
          check(item.delta);
        }
        break;
      case "values":
      case "progress":
        for (const item of node.items) check(item.value);
        break;
      case "table":
        for (const row of node.rows) row.forEach(check);
        break;
      case "chart":
        for (const series of node.series) series.values.forEach(check);
        break;
      default:
        break;
    }
  });
  return problems;
}
