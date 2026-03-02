import { describe, expect, it } from "vitest";
import {
  parseInlineSkillSlashChain,
  parseLeadingSkillSlashCommand,
} from "../skill-slash-commands";

describe("skill slash command parsing", () => {
  it("parses /simplify with no args", () => {
    const result = parseLeadingSkillSlashCommand("/simplify");
    expect(result.matched).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.parsed?.command).toBe("simplify");
    expect(result.parsed?.objective).toBe("");
  });

  it("parses /simplify with objective and flags", () => {
    const result = parseLeadingSkillSlashCommand(
      "/simplify tighten this report --domain writing --scope current",
    );
    expect(result.matched).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.parsed?.command).toBe("simplify");
    expect(result.parsed?.objective).toBe("tighten this report");
    expect(result.parsed?.flags).toEqual({ domain: "writing", scope: "current" });
  });

  it("parses /batch freeform objective with flags", () => {
    const result = parseLeadingSkillSlashCommand(
      "/batch migrate docs to template v2 --parallel 6 --domain writing --external confirm",
    );
    expect(result.matched).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.parsed?.command).toBe("batch");
    expect(result.parsed?.objective).toBe("migrate docs to template v2");
    expect(result.parsed?.flags).toEqual({
      parallel: 6,
      domain: "writing",
      external: "confirm",
    });
  });

  it("rejects invalid /batch parallel values", () => {
    const result = parseLeadingSkillSlashCommand("/batch do thing --parallel 99");
    expect(result.matched).toBe(true);
    expect(result.error).toContain("Invalid --parallel");
  });

  it("rejects /batch with no objective", () => {
    const result = parseLeadingSkillSlashCommand("/batch");
    expect(result.matched).toBe(true);
    expect(result.error).toContain("Missing objective for /batch");
  });

  it("supports freeform objective text that contains --tokens", () => {
    const result = parseLeadingSkillSlashCommand("/batch migrate --all docs --parallel 2");
    expect(result.matched).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.parsed?.objective).toBe("migrate --all docs");
    expect(result.parsed?.flags.parallel).toBe(2);
  });

  it("supports quoted objectives with flag-like text", () => {
    const result = parseLeadingSkillSlashCommand('/batch "migrate --all docs" --parallel 2');
    expect(result.matched).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.parsed?.objective).toBe("migrate --all docs");
    expect(result.parsed?.flags.parallel).toBe(2);
  });

  it("parses inline chain command", () => {
    const result = parseInlineSkillSlashChain("Refactor this module then run /simplify");
    expect(result.matched).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.baseText).toBe("Refactor this module");
    expect(result.parsed?.command).toBe("simplify");
  });

  it("does not parse URL paths as command chains", () => {
    const result = parseInlineSkillSlashChain(
      "Look at https://example.com/batch and summarize findings",
    );
    expect(result.matched).toBe(false);
  });

  it("does not treat path-like prefixes as slash commands", () => {
    const direct = parseLeadingSkillSlashCommand("/batch/migrations");
    expect(direct.matched).toBe(false);

    const inline = parseInlineSkillSlashChain("Refactor this then run /batch/migrations");
    expect(inline.matched).toBe(false);
  });

  it("parses inline chain with punctuation terminator", () => {
    const result = parseInlineSkillSlashChain("Refactor this module then run /simplify.");
    expect(result.matched).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.parsed?.command).toBe("simplify");
  });

  it("rejects multiple inline slash chains in one message", () => {
    const result = parseInlineSkillSlashChain(
      "Do this then run /simplify then run /batch migrate docs",
    );
    expect(result.matched).toBe(true);
    expect(result.error).toContain("Multiple inline slash commands");
  });
});
