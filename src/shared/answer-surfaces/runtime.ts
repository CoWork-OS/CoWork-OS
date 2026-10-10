import { evaluateExpression, expressionIdentifiers, type ExpressionValue } from "./expression";
import type { LogicCell, SurfaceLogicOutputs } from "./logic";
import {
  initialSurfaceState,
  interpolationExpressions,
  isContainerNode,
  isSurfaceBind,
  replaceInterpolations,
  walkSurface,
  type AnswerSurfaceBind,
  type AnswerSurfaceSpec,
  type AnswerSurfaceState,
  type AnswerSurfaceValue,
} from "./schema";

export type SurfaceScope = Record<string, ExpressionValue>;
/** Lists and tables from the surface's logic, by output name. */
export type SurfaceData = SurfaceLogicOutputs["data"];

/** A logic cell for display. Strings come back literal: `{{…}}` inside is not a formula. */
function cellValue(cell: LogicCell | undefined): AnswerSurfaceValue | undefined {
  if (cell === null || cell === undefined) return undefined;
  if (typeof cell === "number") return cell;
  return { value: typeof cell === "boolean" ? (cell ? "Yes" : "No") : cell, literal: true };
}

function cellText(cell: LogicCell | LogicCell[] | undefined): string {
  if (cell === null || cell === undefined || Array.isArray(cell)) return "";
  return typeof cell === "boolean" ? (cell ? "Yes" : "No") : String(cell);
}

function boundList(data: SurfaceData, name: string): Array<LogicCell | LogicCell[]> {
  return Object.prototype.hasOwnProperty.call(data, name) ? data[name] : [];
}

/** Chart labels, from the block or from a bound logic output. */
export function resolveSurfaceLabels(
  labels: string[] | AnswerSurfaceBind,
  data: SurfaceData,
): string[] {
  if (!isSurfaceBind(labels)) return labels;
  return boundList(data, labels.bind).map(cellText);
}

/** A series' values; gaps (null) stay undefined so charts leave them out. */
export function resolveSurfaceValues(
  values: AnswerSurfaceValue[] | AnswerSurfaceBind,
  data: SurfaceData,
): Array<AnswerSurfaceValue | undefined> {
  if (!isSurfaceBind(values)) return values;
  return boundList(data, values.bind).map((cell) =>
    Array.isArray(cell) ? undefined : cellValue(cell),
  );
}

/** Table rows; a bound output must be a list of rows. */
export function resolveSurfaceRows(
  rows: AnswerSurfaceValue[][] | AnswerSurfaceBind,
  data: SurfaceData,
): AnswerSurfaceValue[][] {
  if (!isSurfaceBind(rows)) return rows;
  return boundList(data, rows.bind)
    .filter((row): row is LogicCell[] => Array.isArray(row))
    .map((row) => row.map((cell) => cellValue(cell) ?? ""));
}

/**
 * The values formulas can read: every control's current value, a checklist's count of
 * ticked items, a selectable tile group's chosen title, then `computed` values in
 * document order (each may read the ones before it).
 */
export function buildSurfaceScope(
  spec: AnswerSurfaceSpec,
  state: AnswerSurfaceState,
  logicScope: SurfaceScope = {},
): SurfaceScope {
  const scope: SurfaceScope = {};
  for (const [id, value] of Object.entries(state)) {
    scope[id] = Array.isArray(value) ? value.length : value;
  }
  // Logic outputs come after the controls they are computed from, before `computed`.
  for (const name of spec.logic?.outputs ?? []) {
    if (Object.prototype.hasOwnProperty.call(logicScope, name)) scope[name] = logicScope[name];
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
      ? value.literal
        ? raw
        : interpolateText(raw, scope)
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
export function lintAnswerSurface(
  spec: AnswerSurfaceSpec,
  logicScope: SurfaceScope = {},
  options: { skipLogicValues?: boolean } = {},
): string[] {
  const scope = buildSurfaceScope(spec, initialSurfaceState(spec), logicScope);
  const problems: string[] = [];
  // Without a logic run (main, plain text), values computed by the logic are not known.
  const dependsOnLogic = options.skipLogicValues ? logicDependence(spec) : () => false;
  const check = (value: AnswerSurfaceValue | undefined) => {
    if (value === undefined || dependsOnLogic(value)) return;
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
        if (!isSurfaceBind(node.rows)) for (const row of node.rows) row.forEach(check);
        break;
      case "chart":
        for (const series of node.series) {
          if (!isSurfaceBind(series.values)) series.values.forEach(check);
        }
        break;
      default:
        break;
    }
  });
  return problems;
}

/** Names whose values only the logic can produce: its outputs and `computed` values using them. */
export function logicDependence(spec: AnswerSurfaceSpec): (value: AnswerSurfaceValue) => boolean {
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
