/**
 * The app has several "does this tool mutate?" classifiers gating different
 * layers of the same pipeline. They were hand-maintained and drifted from
 * TOOL_GROUPS, so five group:write tools (organize_folder, compile_latex,
 * monty_transform_file, batch_image_process, scratchpad_write) classified as
 * read-only — auto-allowed in default mode and permitted in Plan mode, whose
 * documented guarantee is that it does not mutate.
 *
 * This asserts the canonical taxonomy is the source of truth, so adding a tool
 * to a group cannot silently reopen the gap.
 */
import { describe, expect, it } from "vitest";
import { TOOL_GROUPS } from "../../../shared/types";
import { isCanonicalWriteToolName } from "../tool-semantics";

describe("canonical write-tool classification", () => {
  const writeTools = TOOL_GROUPS["group:write"] || [];
  const destructiveTools = TOOL_GROUPS["group:destructive"] || [];

  it("has a non-empty canonical taxonomy to check against", () => {
    expect(writeTools.length).toBeGreaterThan(0);
    expect(destructiveTools.length).toBeGreaterThan(0);
  });

  it("classifies every group:write tool as a write tool", () => {
    const misclassified = writeTools.filter((name) => !isCanonicalWriteToolName(name));
    expect(misclassified).toEqual([]);
  });

  it("classifies every group:destructive tool as a write tool", () => {
    const misclassified = destructiveTools.filter((name) => !isCanonicalWriteToolName(name));
    expect(misclassified).toEqual([]);
  });

  it("covers the five tools that were previously missed", () => {
    for (const name of [
      "organize_folder",
      "compile_latex",
      "monty_transform_file",
      "batch_image_process",
      "scratchpad_write",
    ]) {
      expect(isCanonicalWriteToolName(name), name).toBe(true);
    }
  });

  it("does not classify read-only tools as writes", () => {
    for (const name of ["read_file", "list_directory", "grep", "glob", "web_search"]) {
      expect(isCanonicalWriteToolName(name), name).toBe(false);
    }
  });
});
