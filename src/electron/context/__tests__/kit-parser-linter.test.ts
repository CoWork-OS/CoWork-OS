import { describe, expect, it } from "vitest";
import { WORKSPACE_KIT_CONTRACTS } from "../kit-contracts";
import { lintKitDoc } from "../kit-linter";
import { parseKitDocumentFromString, splitFrontmatter } from "../kit-parser";

describe("kit-parser-linter", () => {
  it("parses frontmatter into metadata and body", () => {
    const raw = [
      "---",
      "file: AGENTS.md",
      "updated: 2026-03-10",
      "scope: task, main-session",
      "---",
      "",
      "# Workspace Rules",
      "",
      "- Be concise",
      "",
    ].join("\n");

    const result = splitFrontmatter(raw);

    expect(result.meta.file).toBe("AGENTS.md");
    expect(result.meta.updated).toBe("2026-03-10");
    expect(result.body).toContain("# Workspace Rules");
    expect(result.body).not.toContain("file: AGENTS.md");
  });

  it("preserves DESIGN.md frontmatter as injectable design tokens", () => {
    const contract = WORKSPACE_KIT_CONTRACTS["DESIGN.md"];
    const doc = parseKitDocumentFromString(
      [
        "---",
        "name: Product UI",
        "colors:",
        '  primary: "#22d3ee"',
        "radii:",
        '  sm: "8px"',
        "---",
        "",
        "# Design System",
        "",
        "## Principles",
        "- Use calm operator UI",
        "",
      ].join("\n"),
      contract,
    );

    expect(doc).not.toBeNull();
    expect(doc?.meta.name).toBe("Product UI");
    expect(doc?.body).toContain("colors:");
    expect(doc?.body).toContain('primary: "#22d3ee"');
    expect(doc?.body).toContain("# Design System");
    expect(lintKitDoc(doc!, contract)).toEqual([]);
  });

  it("warns when freshness-tracked docs are missing updated frontmatter", () => {
    const contract = WORKSPACE_KIT_CONTRACTS["AGENTS.md"];
    const doc = parseKitDocumentFromString("# Workspace Rules\n\n- Keep notes durable\n", contract);

    expect(doc).not.toBeNull();
    expect(doc?.warnings).toContain("Missing updated date in AGENTS.md");

    const issues = lintKitDoc(doc!, contract, new Date("2026-03-14T00:00:00Z"));
    expect(issues.some((issue) => issue.code === "missing_updated")).toBe(true);
  });

  it("detects stale documents and likely overlap content", () => {
    const contract = WORKSPACE_KIT_CONTRACTS["SOUL.md"];
    const doc = parseKitDocumentFromString(
      [
        "---",
        "file: SOUL.md",
        "updated: 2025-01-01",
        "scope: task, main-session, role",
        "mutability: user_owned",
        "---",
        "",
        "# Persona",
        "",
        "- Collaboration style: direct",
        "- This document includes temporary priorities that should move elsewhere",
        "",
      ].join("\n"),
      contract,
    );

    expect(doc).not.toBeNull();

    const issues = lintKitDoc(doc!, contract, new Date("2026-03-14T00:00:00Z"));
    expect(issues.some((issue) => issue.code === "stale")).toBe(true);
    expect(issues.some((issue) => issue.code === "possible_overlap")).toBe(true);
  });

  it("detects possible secrets in ACCESS.md", () => {
    const contract = WORKSPACE_KIT_CONTRACTS["ACCESS.md"];
    const doc = parseKitDocumentFromString(
      [
        "---",
        "file: ACCESS.md",
        "updated: 2026-03-10",
        "scope: task, role",
        "mutability: system_locked",
        "---",
        "",
        "# Access",
        "",
        "## Allow",
        "- all",
        "",
        "## Notes",
        "- never store secrets in access notes",
        "",
      ].join("\n"),
      contract,
    );

    expect(doc).not.toBeNull();

    const issues = lintKitDoc(doc!, contract, new Date("2026-03-14T00:00:00Z"));
    expect(issues.some((issue) => issue.code === "possible_secret" && issue.level === "error")).toBe(
      true,
    );
  });

  it("returns null for documents whose sanitized body becomes empty", () => {
    const contract = WORKSPACE_KIT_CONTRACTS["AGENTS.md"];
    const doc = parseKitDocumentFromString("   \n\n   ", contract);
    expect(doc).toBeNull();
  });
});
