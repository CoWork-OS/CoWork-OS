import { describe, expect, it } from "vitest";
import {
  describeRequiredToolsForNudge,
  getEquivalentRequiredToolsForCall,
  getRequiredToolGroup,
} from "../required-tool-equivalence";

describe("required tool equivalence", () => {
  it("groups interchangeable tools", () => {
    expect(getRequiredToolGroup("write_file")).toBe("file_mutation");
    expect(getRequiredToolGroup("edit_file")).toBe("file_mutation");
    expect(getRequiredToolGroup("grep")).toBe("search");
    expect(getRequiredToolGroup("search_files")).toBe("search");
    expect(getRequiredToolGroup("glob")).toBe("search");
    expect(getRequiredToolGroup("web_fetch")).toBe("fetch");
    expect(getRequiredToolGroup("http_request")).toBe("fetch");
    expect(getRequiredToolGroup("browser_get_content")).toBe("fetch");
    // Distinct operations stay distinct.
    expect(getRequiredToolGroup("delete_file")).toBeNull();
    expect(getRequiredToolGroup("rename_file")).toBeNull();
    expect(getRequiredToolGroup("create_document")).toBeNull();
    expect(getRequiredToolGroup("web_search")).toBeNull();
  });

  it("lets a file edit satisfy a write requirement and vice versa", () => {
    expect(getEquivalentRequiredToolsForCall(["write_file"], "edit_file", {})).toEqual([
      "write_file",
    ]);
    expect(getEquivalentRequiredToolsForCall(["edit_file"], "write_file", {})).toEqual([
      "edit_file",
    ]);
    expect(getEquivalentRequiredToolsForCall(["delete_file"], "edit_file", {})).toEqual([]);
    expect(getEquivalentRequiredToolsForCall(["create_document"], "write_file", {})).toEqual([]);
  });

  it("accepts search tools and shell search commands for a grep requirement", () => {
    expect(getEquivalentRequiredToolsForCall(["grep"], "search_files", { query: "x" })).toEqual([
      "grep",
    ]);
    for (const command of [
      "rg -n getUser src",
      "grep -rn getUser src",
      "git grep getUser",
      "cd src && rg getUser",
      "find . -name '*.ts'",
    ]) {
      expect(getEquivalentRequiredToolsForCall(["grep"], "run_command", { command })).toEqual([
        "grep",
      ]);
    }
    expect(
      getEquivalentRequiredToolsForCall(["grep"], "run_command", { command: "npm test" }),
    ).toEqual([]);
    // A shell command never stands in for a file write here; that bridge needs
    // verified mutation evidence.
    expect(
      getEquivalentRequiredToolsForCall(["write_file"], "run_command", { command: "ls" }),
    ).toEqual([]);
  });

  it("accepts fetch equivalents but not a web search for a fetch requirement", () => {
    expect(getEquivalentRequiredToolsForCall(["web_fetch"], "http_request", {})).toEqual([
      "web_fetch",
    ]);
    expect(getEquivalentRequiredToolsForCall(["web_fetch"], "web_search", {})).toEqual([]);
  });

  it("describes pending requirements by group instead of naming a clobbering tool", () => {
    const [fileChange] = describeRequiredToolsForNudge(["write_file", "edit_file"]);
    expect(describeRequiredToolsForNudge(["write_file", "edit_file"])).toHaveLength(1);
    expect(fileChange).toContain("edit_file for targeted edits to an existing file");
    expect(fileChange).toContain("write_file only for a new file");
    expect(describeRequiredToolsForNudge(["create_document", "grep"])).toEqual([
      "create_document",
      "a search (grep, search_files, glob, or rg/grep via run_command)",
    ]);
  });
});
