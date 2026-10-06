import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));

vi.mock("../../../settings/memory-features-manager", () => ({
  MemoryFeaturesManager: {
    loadSettings: () => settings.current,
    onSaved: () => () => undefined,
  },
}));

import { memoryRepoStatus, startMemoryRepo, stopMemoryRepo } from "../memory-repo-bootstrap";
import { getMemoryRepoDreamer } from "../MemoryRepoDreamer";

describe("memory repo bootstrap: dreamer lifecycle", () => {
  let base: string;
  const client = { complete: vi.fn() };

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "memory-repo-boot-"));
    settings.current = { memoryRepoEnabled: true, memoryRepoPath: path.join(base, "repo") };
  });

  afterEach(async () => {
    await stopMemoryRepo();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("creates the dreamer for a writable repo and clears it on stop", async () => {
    const status = await startMemoryRepo({
      runtime: "desktop",
      runExport: false,
      dreamModelClient: client,
      findTasksCreatedBetween: async () => [],
      findTaskEvents: async () => [],
    });
    expect(status?.ready).toBe(true);
    expect(getMemoryRepoDreamer()).not.toBeNull();
    await stopMemoryRepo();
    expect(getMemoryRepoDreamer()).toBeNull();
  });

  it("does not dream over a read-only repo", async () => {
    await startMemoryRepo({ runtime: "cli", readOnly: true, dreamModelClient: client });
    expect(getMemoryRepoDreamer()).toBeNull();
  });

  it("reads dreaming settings from the memory feature settings", async () => {
    settings.current = { ...settings.current, memoryRepoDreamingEnabled: false };
    await startMemoryRepo({ runtime: "desktop", runExport: false, dreamModelClient: client });
    const outcome = await getMemoryRepoDreamer()?.run("manual");
    expect(outcome?.ran).toBe(false);
    // "no_git" only on machines without git, which gates before the setting.
    expect(["disabled", "no_git"]).toContain(outcome && !outcome.ran ? outcome.reason : null);
    expect(client.complete).not.toHaveBeenCalled();
  });
});

describe("memory repo bootstrap: status with team memory", () => {
  let base: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "memory-repo-boot-team-"));
  });

  afterEach(async () => {
    await stopMemoryRepo();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("lists the configured team repos with their problems in the status", async () => {
    settings.current = {
      memoryRepoEnabled: true,
      memoryRepoPath: path.join(base, "repo"),
      memoryRepoTeamRepos: [{ name: "Platform", path: path.join(base, "missing-team") }],
    };
    await startMemoryRepo({ runtime: "cli", readOnly: true });
    const status = await memoryRepoStatus();
    expect(status.team).toEqual([
      expect.objectContaining({ name: "Platform", ready: false, workspaceIds: [] }),
    ]);
    expect(status.team[0].problem).toBeTruthy();
  });
});
