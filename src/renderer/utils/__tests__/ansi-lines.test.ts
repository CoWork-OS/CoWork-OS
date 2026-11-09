import { describe, expect, it } from "vitest";
import { ansiToLines, ANSI_RENDER_LIMITS } from "../ansi-lines";
const esc = String.fromCharCode(27);
const text = (raw: string) =>
  ansiToLines(raw)
    .map((line) => line.map((s) => s.text).join(""))
    .join("\n");
describe("bounded terminal rendering", () => {
  it("handles a bounded input full of incomplete control sequences", () => {
    const result = ansiToLines(`${esc}[`.repeat(ANSI_RENDER_LIMITS.inputChars));
    expect(result.length).toBeLessThanOrEqual(ANSI_RENDER_LIMITS.lines);
  });
  it.each(["9999999999", "9".repeat(400), "Infinity", "1e309"])("bounds column %s", (column) => {
    const result = text(`${esc}[${column}Gx\tend`);
    expect(result.length).toBeLessThanOrEqual(ANSI_RENDER_LIMITS.columns);
  });
  it("bounds total cell writes independently of short repeated cursor sequences", () => {
    const raw = `${esc}[4096Gx\n`.repeat(1000);
    const lines = ansiToLines(raw);
    expect(
      lines.reduce((n, l) => n + l.reduce((sum, s) => sum + s.text.length, 0), 0),
    ).toBeLessThanOrEqual(ANSI_RENDER_LIMITS.cellWrites);
  });
  it("preserves ordinary style, overwrite, tabs and cursor movement", () => {
    expect(text("hello\rbye")).toBe("byelo");
    expect(text(`abc${esc}[2GX`)).toBe("aXc");
    expect(text("x\ty")).toBe("x       y");
    expect(ansiToLines(`${esc}[31mred${esc}[0m plain`)[0]).toEqual([
      { fg: 1, text: "red" },
      { text: " plain" },
    ]);
  });
});
