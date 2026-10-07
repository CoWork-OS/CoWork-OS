import { describe, expect, it } from "vitest";
import { evaluateExpression, expressionIdentifiers, compileExpression } from "../expression";

describe("answer surface expressions", () => {
  it("evaluates arithmetic with precedence, power and unary minus", () => {
    expect(evaluateExpression("2 + 3 * 4", {})).toBe(14);
    expect(evaluateExpression("(2 + 3) * 4", {})).toBe(20);
    expect(evaluateExpression("2 ^ 3 ^ 2", {})).toBe(512);
    expect(evaluateExpression("-2 ^ 2", {})).toBe(4);
    expect(evaluateExpression("10 % 4", {})).toBe(2);
    expect(evaluateExpression("1.5e2", {})).toBe(150);
  });

  it("reads control values and supports the function set", () => {
    const scope = { people: 5, rate: 0.05 };
    expect(evaluateExpression("max(1.5, people * 0.4)", scope)).toBe(2);
    expect(evaluateExpression("ceil(people * 1.5)", scope)).toBe(8);
    expect(evaluateExpression("round(people / 3, 2)", scope)).toBe(1.67);
    expect(evaluateExpression("clamp(people, 1, 4)", scope)).toBe(4);
    expect(evaluateExpression("pow(1 + rate, 10)", scope)).toBeCloseTo(1.628894627, 8);
  });

  it("handles comparisons, logic, strings and the ternary", () => {
    const scope = { size: "large", vegetarian: true, guests: 8 };
    expect(evaluateExpression("size == 'large' ? 2 : 1", scope)).toBe(2);
    expect(evaluateExpression("vegetarian && guests > 6", scope)).toBe(true);
    expect(evaluateExpression("!vegetarian || guests <= 2", scope)).toBe(false);
    expect(evaluateExpression("guests != 8", scope)).toBe(false);
  });

  it("returns null for invalid, unknown or non-finite formulas", () => {
    expect(evaluateExpression("people *", { people: 1 })).toBeNull();
    expect(evaluateExpression("missing + 1", {})).toBeNull();
    expect(evaluateExpression("1 / 0", {})).toBeNull();
    expect(evaluateExpression("alert(1)", {})).toBeNull();
    expect(evaluateExpression("constructor", {})).toBeNull();
    expect(evaluateExpression("x.y", { x: 1 })).toBeNull();
  });

  it("rejects runaway input", () => {
    expect(() => compileExpression("1+".repeat(300) + "1")).toThrow();
    expect(() => compileExpression("(".repeat(40) + "1" + ")".repeat(40))).toThrow();
  });

  it("lists the identifiers a formula reads", () => {
    expect(expressionIdentifiers("max(a, b * 2) + (c ? d : 1)").sort()).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });
});
