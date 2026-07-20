import type {
  WorkflowInputValue,
  WorkflowReference,
  WorkflowTemplateValue,
} from "../../../shared/routine-workflow";

export interface WorkflowVariableContext {
  trigger: Record<string, unknown>;
  nodes: Record<string, Record<string, unknown>>;
  run?: Record<string, unknown>;
  item?: unknown;
  index?: number;
}

export function resolveWorkflowInputs(
  input: Record<string, WorkflowInputValue>,
  context: WorkflowVariableContext,
): Record<string, unknown> {
  return resolveValue(input, context) as Record<string, unknown>;
}

export function resolveWorkflowValue(
  value: WorkflowInputValue,
  context: WorkflowVariableContext,
): unknown {
  return resolveValue(value, context);
}

function resolveValue(value: WorkflowInputValue, context: WorkflowVariableContext): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, context));
  if (isReference(value)) {
    const resolved = lookupWorkflowPath(value.$ref, context);
    return resolved === undefined && value.default !== undefined
      ? resolveValue(value.default, context)
      : resolved;
  }
  if (isTemplate(value)) return interpolateWorkflowTemplate(value.$template, context);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, resolveValue(child, context)]),
    );
  }
  return value;
}

export function lookupWorkflowPath(path: string, context: WorkflowVariableContext): unknown {
  const parts = String(path || "")
    .split(".")
    .filter(Boolean);
  if (parts.length === 0) return undefined;
  let current: unknown;
  const [root, ...rest] = parts;
  if (root === "trigger") current = context.trigger;
  else if (root === "run") current = context.run;
  else if (root === "item") current = context.item;
  else if (root === "index") current = context.index;
  else current = context.nodes[root];

  for (const part of rest) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(part)) {
      current = current[Number(part)];
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function interpolateWorkflowTemplate(
  template: string,
  context: WorkflowVariableContext,
): string {
  return String(template || "").replace(/{{\s*([^{}]+?)\s*}}/g, (_match, path: string) => {
    const value = lookupWorkflowPath(path.trim(), context);
    if (value === null || value === undefined) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  });
}

function isReference(value: WorkflowInputValue): value is WorkflowReference {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && "$ref" in value);
}

function isTemplate(value: WorkflowInputValue): value is WorkflowTemplateValue {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) && "$template" in value,
  );
}

export function evaluateWorkflowComparison(
  left: unknown,
  operator: string,
  right?: unknown,
): boolean {
  const leftText = normalizeComparableText(left);
  const rightText = normalizeComparableText(right);
  switch (operator) {
    case "equals":
      return deepEqual(left, right);
    case "not_equals":
      return !deepEqual(left, right);
    case "contains":
      return Array.isArray(left)
        ? left.some((item) => deepEqual(item, right))
        : leftText.includes(rightText);
    case "not_contains":
      return Array.isArray(left)
        ? !left.some((item) => deepEqual(item, right))
        : !leftText.includes(rightText);
    case "matches":
      try {
        return new RegExp(String(right ?? ""), "i").test(String(left ?? ""));
      } catch {
        return false;
      }
    case "gt":
      return Number(left) > Number(right);
    case "gte":
      return Number(left) >= Number(right);
    case "lt":
      return Number(left) < Number(right);
    case "lte":
      return Number(left) <= Number(right);
    case "is_empty":
      return isEmpty(left);
    case "is_not_empty":
      return !isEmpty(left);
    default:
      return false;
  }
}

function normalizeComparableText(value: unknown): string {
  if (typeof value === "string") return value.toLocaleLowerCase();
  if (value === null || value === undefined) return "";
  return JSON.stringify(value).toLocaleLowerCase();
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length === 0;
  return false;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}
