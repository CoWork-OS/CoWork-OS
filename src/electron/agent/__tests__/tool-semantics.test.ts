import { describe, expect, it } from "vitest";
import {
  getAliasesForCanonicalTool,
  getToolSemantics,
  canonicalizeToolName,
  isFileMutationToolName,
} from "../tool-semantics";

describe("tool-semantics artifact coverage", () => {
  const registryArtifactToolNames = [
    "create_document",
    "generate_document",
    "create_spreadsheet",
    "generate_spreadsheet",
    "create_presentation",
    "generate_presentation",
  ];

  it("maps every exposed artifact tool to semantics", () => {
    for (const toolName of registryArtifactToolNames) {
      expect(getToolSemantics(toolName)).toBeTruthy();
    }
  });

  it("normalizes generate_* aliases to create_* canonical tool names", () => {
    expect(canonicalizeToolName("generate_document")).toBe("create_document");
    expect(canonicalizeToolName("generate_spreadsheet")).toBe("create_spreadsheet");
    expect(canonicalizeToolName("generate_presentation")).toBe("create_presentation");
  });

  it("exposes alias families for canonical artifact tools", () => {
    expect(getAliasesForCanonicalTool("create_document")).toEqual(
      expect.arrayContaining(["create_document", "generate_document"]),
    );
    expect(getAliasesForCanonicalTool("create_spreadsheet")).toEqual(
      expect.arrayContaining(["create_spreadsheet", "generate_spreadsheet"]),
    );
    expect(getAliasesForCanonicalTool("create_presentation")).toEqual(
      expect.arrayContaining(["create_presentation", "generate_presentation"]),
    );
  });

  it("classifies structural file operations as mutations", () => {
    expect(isFileMutationToolName("rename_file")).toBe(true);
    expect(isFileMutationToolName("delete_file")).toBe(true);
    expect(isFileMutationToolName("create_directory")).toBe(true);
  });
});
