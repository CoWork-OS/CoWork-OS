import { describe, expect, it } from "vitest";
import { evaluateConditions, substituteEventVariables } from "../condition-evaluator";
import { TriggerCondition, TriggerEvent } from "../types";

function makeEvent(fields: Record<string, string | number | boolean>): TriggerEvent {
  return { source: "channel_message", timestamp: Date.now(), fields };
}

describe("evaluateConditions", () => {
  // ── Basic operators ────────────────────────────────────────────

  it("equals (case-insensitive)", () => {
    const event = makeEvent({ text: "Hello World" });
    const cond: TriggerCondition = { field: "text", operator: "equals", value: "hello world" };
    expect(evaluateConditions(event, [cond])).toBe(true);
  });

  it("not_equals", () => {
    const event = makeEvent({ text: "hello" });
    expect(
      evaluateConditions(event, [{ field: "text", operator: "not_equals", value: "world" }]),
    ).toBe(true);
    expect(
      evaluateConditions(event, [{ field: "text", operator: "not_equals", value: "hello" }]),
    ).toBe(false);
  });

  it("contains", () => {
    const event = makeEvent({ text: "urgent: deploy now" });
    expect(
      evaluateConditions(event, [{ field: "text", operator: "contains", value: "deploy" }]),
    ).toBe(true);
    expect(
      evaluateConditions(event, [{ field: "text", operator: "contains", value: "rollback" }]),
    ).toBe(false);
  });

  it("not_contains", () => {
    const event = makeEvent({ text: "normal update" });
    expect(
      evaluateConditions(event, [{ field: "text", operator: "not_contains", value: "urgent" }]),
    ).toBe(true);
  });

  it("starts_with", () => {
    const event = makeEvent({ text: "ALERT: something" });
    expect(
      evaluateConditions(event, [{ field: "text", operator: "starts_with", value: "alert" }]),
    ).toBe(true);
    expect(
      evaluateConditions(event, [{ field: "text", operator: "starts_with", value: "warn" }]),
    ).toBe(false);
  });

  it("ends_with", () => {
    const event = makeEvent({ text: "file.pdf" });
    expect(
      evaluateConditions(event, [{ field: "text", operator: "ends_with", value: ".pdf" }]),
    ).toBe(true);
  });

  it("matches (regex)", () => {
    const event = makeEvent({ text: "Error code: E12345" });
    expect(
      evaluateConditions(event, [{ field: "text", operator: "matches", value: "E\\d{5}" }]),
    ).toBe(true);
    expect(
      evaluateConditions(event, [{ field: "text", operator: "matches", value: "^Error" }]),
    ).toBe(true);
  });

  it("matches returns false for invalid regex instead of crashing", () => {
    const event = makeEvent({ text: "hello" });
    expect(
      evaluateConditions(event, [{ field: "text", operator: "matches", value: "[invalid" }]),
    ).toBe(false);
  });

  it("gt (numeric)", () => {
    const event = makeEvent({ priority: 8 });
    expect(evaluateConditions(event, [{ field: "priority", operator: "gt", value: "5" }])).toBe(
      true,
    );
    expect(evaluateConditions(event, [{ field: "priority", operator: "gt", value: "10" }])).toBe(
      false,
    );
  });

  it("lt (numeric)", () => {
    const event = makeEvent({ count: 3 });
    expect(evaluateConditions(event, [{ field: "count", operator: "lt", value: "5" }])).toBe(true);
  });

  // ── Missing fields ────────────────────────────────────────────

  it("returns false when field is missing from event", () => {
    const event = makeEvent({});
    expect(
      evaluateConditions(event, [{ field: "nonexistent", operator: "equals", value: "x" }]),
    ).toBe(false);
  });

  // ── Logic modes ────────────────────────────────────────────────

  it("empty conditions always match", () => {
    expect(evaluateConditions(makeEvent({}), [])).toBe(true);
  });

  it("logic=all requires all conditions to pass", () => {
    const event = makeEvent({ text: "hello world", sender: "bot" });
    const conditions: TriggerCondition[] = [
      { field: "text", operator: "contains", value: "hello" },
      { field: "sender", operator: "equals", value: "bot" },
    ];
    expect(evaluateConditions(event, conditions, "all")).toBe(true);
  });

  it("logic=all fails if any condition fails", () => {
    const event = makeEvent({ text: "hello world", sender: "human" });
    const conditions: TriggerCondition[] = [
      { field: "text", operator: "contains", value: "hello" },
      { field: "sender", operator: "equals", value: "bot" },
    ];
    expect(evaluateConditions(event, conditions, "all")).toBe(false);
  });

  it("logic=any passes if any condition matches", () => {
    const event = makeEvent({ text: "goodbye", sender: "bot" });
    const conditions: TriggerCondition[] = [
      { field: "text", operator: "contains", value: "hello" },
      { field: "sender", operator: "equals", value: "bot" },
    ];
    expect(evaluateConditions(event, conditions, "any")).toBe(true);
  });

  it("logic=any fails when no conditions match", () => {
    const event = makeEvent({ text: "goodbye", sender: "human" });
    const conditions: TriggerCondition[] = [
      { field: "text", operator: "contains", value: "hello" },
      { field: "sender", operator: "equals", value: "bot" },
    ];
    expect(evaluateConditions(event, conditions, "any")).toBe(false);
  });

  // ── Boolean field coercion ─────────────────────────────────────

  it("coerces boolean fields to string for comparison", () => {
    const event = makeEvent({ active: true });
    expect(
      evaluateConditions(event, [{ field: "active", operator: "equals", value: "true" }]),
    ).toBe(true);
  });
});

describe("substituteEventVariables", () => {
  it("replaces {{event.field}} placeholders with event values", () => {
    const event = makeEvent({ text: "hello world", senderName: "Alice" });
    const result = substituteEventVariables(
      "User {{event.senderName}} said: {{event.text}}",
      event,
    );
    expect(result).toBe("User Alice said: hello world");
  });

  it("replaces missing fields with empty string", () => {
    const event = makeEvent({});
    const result = substituteEventVariables("Missing: {{event.foo}}", event);
    expect(result).toBe("Missing: ");
  });

  it("leaves non-template text unchanged", () => {
    const event = makeEvent({ text: "hi" });
    expect(substituteEventVariables("plain text", event)).toBe("plain text");
  });

  it("handles multiple occurrences of same variable", () => {
    const event = makeEvent({ name: "Bob" });
    const result = substituteEventVariables("{{event.name}} and {{event.name}}", event);
    expect(result).toBe("Bob and Bob");
  });
});
