import { describe, expect, it } from "vitest";
import { BoundedOutputBuffer, OUTPUT_TRUNCATED_MARKER, boundOutput } from "../bounded-output";

describe("BoundedOutputBuffer", () => {
  it("returns output within the budget unchanged, across chunk boundaries", () => {
    const buffer = new BoundedOutputBuffer(100);
    for (const chunk of ["alpha ", "beta ", "gamma"]) buffer.append(chunk);

    expect(buffer.toString()).toBe("alpha beta gamma");
    expect(buffer.truncated).toBe(false);
  });

  it("keeps the first fifth and the last four fifths of overflowing output", () => {
    const buffer = new BoundedOutputBuffer(100);
    buffer.append("H".repeat(30));
    buffer.append("m".repeat(500));
    buffer.append(`${"t".repeat(70)}END`);

    const text = buffer.toString();
    expect(buffer.truncated).toBe(true);
    expect(text.startsWith(`${"H".repeat(20)}\n${OUTPUT_TRUNCATED_MARKER}`)).toBe(true);
    expect(text).toContain("[... 503 chars omitted ...]");
    expect(text.endsWith(`m${"t".repeat(70)}END`)).toBe(true);
    expect(text.length - text.indexOf("\n", 21) - 1).toBe(80);
  });

  it("bounds a complete string the same way", () => {
    expect(boundOutput("short", 100)).toEqual({ text: "short", truncated: false });
    const bounded = boundOutput(`${"x".repeat(1_000)}tail`, 100);
    expect(bounded.truncated).toBe(true);
    expect(bounded.text.endsWith("tail")).toBe(true);
  });
});
