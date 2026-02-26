/**
 * Pure-function condition evaluator for event triggers.
 *
 * Evaluates an array of TriggerConditions against a TriggerEvent's fields.
 */

import { TriggerCondition, TriggerEvent } from "./types";

/**
 * Evaluate all conditions against an event.
 * @param event   The incoming event with field values
 * @param conditions  Array of conditions to check
 * @param logic   "all" (AND, default) or "any" (OR)
 * @returns true if the conditions match
 */
export function evaluateConditions(
  event: TriggerEvent,
  conditions: TriggerCondition[],
  logic: "all" | "any" = "all",
): boolean {
  if (conditions.length === 0) return true;

  const results = conditions.map((c) => evaluateOne(event, c));

  return logic === "all" ? results.every(Boolean) : results.some(Boolean);
}

function evaluateOne(event: TriggerEvent, cond: TriggerCondition): boolean {
  const raw = event.fields[cond.field];
  if (raw === undefined || raw === null) return false;

  const fieldVal = String(raw);
  const condVal = String(cond.value);

  switch (cond.operator) {
    case "equals":
      return fieldVal.toLowerCase() === condVal.toLowerCase();

    case "not_equals":
      return fieldVal.toLowerCase() !== condVal.toLowerCase();

    case "contains":
      return fieldVal.toLowerCase().includes(condVal.toLowerCase());

    case "not_contains":
      return !fieldVal.toLowerCase().includes(condVal.toLowerCase());

    case "starts_with":
      return fieldVal.toLowerCase().startsWith(condVal.toLowerCase());

    case "ends_with":
      return fieldVal.toLowerCase().endsWith(condVal.toLowerCase());

    case "matches":
      try {
        return new RegExp(condVal, "i").test(fieldVal);
      } catch {
        return false;
      }

    case "gt":
      return Number(fieldVal) > Number(condVal);

    case "lt":
      return Number(fieldVal) < Number(condVal);

    default:
      return false;
  }
}

/**
 * Substitute {{event.<field>}} variables in a template string with
 * actual event field values.
 */
export function substituteEventVariables(template: string, event: TriggerEvent): string {
  return template.replace(/\{\{event\.(\w+)\}\}/g, (_match, field) => {
    const val = event.fields[field];
    return val !== undefined ? String(val) : "";
  });
}
