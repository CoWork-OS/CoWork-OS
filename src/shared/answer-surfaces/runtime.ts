import { evaluateExpression, type ExpressionValue } from "./expression";
import {
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
    if (node.type !== "card" && node.type !== "stack" && node.type !== "grid") return;
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
