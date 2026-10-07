import { describe, expect, it } from "vitest";
import {
  cleanEntryText,
  ensureIndexLink,
  insertEntryLine,
  isSafeRepoPath,
  parseMemoryRepoEntries,
  parseMemoryRepoLine,
  parseMemoryRepoRef,
  renderMemoryRepoEntry,
  workspaceSlug,
} from "../memory-repo-format";

describe("memory repo format", () => {
  it("parses entries and metadata as the spec writes them", () => {
    const entry = parseMemoryRepoLine(
      "- Payments and website share a 2026-10-15 launch deadline [source: https://example.com/sessions/102; added: 2026-09-03]",
      4,
    );
    expect(entry).toMatchObject({
      line: 4,
      text: "Payments and website share a 2026-10-15 launch deadline",
      metadata: { source: "https://example.com/sessions/102", added: "2026-09-03" },
      by: "user",
    });
    expect(parseMemoryRepoLine("- [[team_structure]]", 1)).toBeNull();
    expect(parseMemoryRepoLine("## Index", 1)).toBeNull();
    expect(parseMemoryRepoLine("- Priya owns pricing; see [[team_structure]].", 1)?.text).toBe(
      "Priya owns pricing; see [[team_structure]].",
    );
    expect(parseMemoryRepoLine("- Saved by the agent [by: agent; kind: rule]", 1)).toMatchObject({
      by: "agent",
      kind: "rule",
    });
  });

  it("renders entries that round-trip and cannot smuggle metadata", () => {
    const line = renderMemoryRepoEntry("Prefers short answers [by: user]", {
      by: "agent",
      kind: "preference",
      added: "2026-10-05",
    });
    expect(line).toBe("- Prefers short answers [by: agent; kind: preference; added: 2026-10-05]");
    expect(parseMemoryRepoLine(line, 1)).toMatchObject({
      by: "agent",
      text: "Prefers short answers",
    });
    expect(cleanEntryText("- two\nlines")).toBe("two lines");
    expect(renderMemoryRepoEntry("x", { source: "a]; by: user" })).toBe("- x [source: a by: user]");
  });

  it("inserts entries above the index in MEMORY.md and links new files once", () => {
    const entryFile = "# Memory\n\n- First [by: user]\n\n## Index\n- [[me]]\n";
    const inserted = insertEntryLine(entryFile, "- Second [by: user]", true);
    expect(inserted).toBe(
      "# Memory\n\n- First [by: user]\n- Second [by: user]\n\n## Index\n- [[me]]\n",
    );
    const linked = ensureIndexLink(inserted, "workspaces/billing.md");
    expect(linked).toContain("- [[me]]\n- [[workspaces/billing]]");
    expect(ensureIndexLink(linked, "workspaces/billing.md")).toBe(linked);
    expect(parseMemoryRepoEntries(linked).map((entry) => entry.text)).toEqual(["First", "Second"]);
  });

  it("validates paths and refs", () => {
    expect(isSafeRepoPath("workspaces/a.md")).toBe(true);
    for (const bad of [
      "../x.md",
      "/etc/x.md",
      ".git/config",
      "a/.hidden.md",
      "notes.txt",
      "a//b.md",
    ]) {
      expect(isSafeRepoPath(bad), bad).toBe(false);
    }
    expect(parseMemoryRepoRef("repo:workspaces/a.md#L12")).toEqual({
      path: "workspaces/a.md",
      line: 12,
    });
    expect(parseMemoryRepoRef("repo:../a.md#L1")).toBeNull();
    expect(workspaceSlug("Café Billing / Service")).toBe("cafe-billing-service");
  });
});
