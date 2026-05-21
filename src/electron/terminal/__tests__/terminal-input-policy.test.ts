import { describe, expect, it } from "vitest";

import { normalizeTerminalAttachInput } from "../terminal-input-policy";

describe("terminal input policy", () => {
  it("allows empty input to attach terminal output listeners", () => {
    expect(normalizeTerminalAttachInput("")).toBe("");
    expect(normalizeTerminalAttachInput(undefined)).toBe("");
  });

  it("allows ctrl-c control input", () => {
    expect(normalizeTerminalAttachInput("\x03")).toBe("\x03");
  });

  it("allows enter control input", () => {
    expect(normalizeTerminalAttachInput("\r")).toBe("\r");
    expect(normalizeTerminalAttachInput("\n")).toBe("\n");
    expect(normalizeTerminalAttachInput("\r\n")).toBe("\r\n");
  });

  it("allows ordinary PTY input for a real interactive terminal", () => {
    expect(normalizeTerminalAttachInput("ls -la")).toBe("ls -la");
    expect(normalizeTerminalAttachInput("yes\n")).toBe("yes\n");
    expect(normalizeTerminalAttachInput("\u001b[A")).toBe("\u001b[A");
  });

  it("normalizes non-string input to empty attach input", () => {
    expect(normalizeTerminalAttachInput(null)).toBe("");
    expect(normalizeTerminalAttachInput(42)).toBe("");
  });
});
