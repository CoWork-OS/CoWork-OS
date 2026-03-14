import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeWorkspaceKitStatus } from "../kit-status";
import { writeKitFileWithSnapshot } from "../kit-revisions";

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function kitPath(root: string, ...parts: string[]): string {
  return path.join(root, ".cowork", ...parts);
}

describe("kit-status", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-kit-status-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports missing tracked kit files when the workspace kit is absent", async () => {
    const status = await computeWorkspaceKitStatus(tmpDir, "workspace-1");

    expect(status.workspaceId).toBe("workspace-1");
    expect(status.workspacePath).toBe(tmpDir);
    expect(status.hasKitDir).toBe(false);
    expect(status.missingCount).toBeGreaterThan(0);
    expect(status.lintWarningCount).toBe(0);
    expect(status.lintErrorCount).toBe(0);
    expect(status.files.some((entry) => entry.relPath === path.join(".cowork", "AGENTS.md"))).toBe(true);
    expect(status.onboarding?.bootstrapPresent).toBe(false);
  });

  it("surfaces stale files, secret lint errors, special handling, and revision counts", async () => {
    writeFile(
      kitPath(tmpDir, "TOOLS.md"),
      [
        "---",
        "file: TOOLS.md",
        "updated: 2020-01-01",
        "scope: task, main-session",
        "mutability: user_owned",
        "---",
        "",
        "# Tools",
        "",
        "## Notes",
        "- never store secrets in kit files",
        "",
      ].join("\n"),
    );
    writeFile(
      kitPath(tmpDir, "BOOTSTRAP.md"),
      [
        "---",
        "file: BOOTSTRAP.md",
        "updated: 2026-03-01",
        "scope: bootstrap",
        "mutability: system_locked",
        "---",
        "",
        "# Bootstrap",
        "",
        "- [ ] Create initial project context",
        "",
      ].join("\n"),
    );

    const agentsPath = kitPath(tmpDir, "AGENTS.md");
    writeKitFileWithSnapshot(
      agentsPath,
      [
        "---",
        "file: AGENTS.md",
        "updated: 2026-03-10",
        "scope: task, main-session",
        "mutability: system_locked",
        "---",
        "",
        "# Workspace Rules",
        "",
        "## Coordination",
        "- First version",
        "",
      ].join("\n"),
      "system",
      "seed",
    );
    writeKitFileWithSnapshot(
      agentsPath,
      [
        "---",
        "file: AGENTS.md",
        "updated: 2026-03-11",
        "scope: task, main-session",
        "mutability: system_locked",
        "---",
        "",
        "# Workspace Rules",
        "",
        "## Coordination",
        "- Second version",
        "",
      ].join("\n"),
      "agent",
      "refresh",
    );

    const status = await computeWorkspaceKitStatus(tmpDir, "workspace-2");
    const tools = status.files.find((entry) => entry.relPath === path.join(".cowork", "TOOLS.md"));
    const agents = status.files.find((entry) => entry.relPath === path.join(".cowork", "AGENTS.md"));
    const bootstrap = status.files.find((entry) => entry.relPath === path.join(".cowork", "BOOTSTRAP.md"));

    expect(tools?.exists).toBe(true);
    expect(tools?.stale).toBe(true);
    expect(tools?.issues?.some((issue) => issue.code === "stale")).toBe(true);
    expect(tools?.issues?.some((issue) => issue.code === "possible_secret")).toBe(true);

    expect(agents?.revisionCount).toBe(1);
    expect(bootstrap?.specialHandling).toBe("bootstrap");
    expect(status.lintWarningCount).toBeGreaterThan(0);
    expect(status.lintErrorCount).toBeGreaterThan(0);
    expect(status.onboarding?.bootstrapPresent).toBe(true);
    expect(typeof status.onboarding?.bootstrapSeededAt).toBe("number");
  });

  it("marks onboarding complete after BOOTSTRAP.md is removed", async () => {
    const bootstrapPath = kitPath(tmpDir, "BOOTSTRAP.md");
    writeFile(
      bootstrapPath,
      [
        "---",
        "file: BOOTSTRAP.md",
        "updated: 2026-03-01",
        "scope: bootstrap",
        "mutability: system_locked",
        "---",
        "",
        "# Bootstrap",
        "",
        "- [ ] Finish onboarding",
        "",
      ].join("\n"),
    );

    const first = await computeWorkspaceKitStatus(tmpDir, "workspace-3");
    expect(first.onboarding?.bootstrapPresent).toBe(true);
    expect(typeof first.onboarding?.bootstrapSeededAt).toBe("number");
    expect(first.onboarding?.onboardingCompletedAt).toBeUndefined();

    fs.unlinkSync(bootstrapPath);

    const second = await computeWorkspaceKitStatus(tmpDir, "workspace-3");
    expect(second.onboarding?.bootstrapPresent).toBe(false);
    expect(typeof second.onboarding?.bootstrapSeededAt).toBe("number");
    expect(typeof second.onboarding?.onboardingCompletedAt).toBe("number");
  });
});
