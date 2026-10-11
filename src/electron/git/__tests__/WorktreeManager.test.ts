import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WORKTREE_SETTINGS } from "../../../shared/types";

const mockSecureRepository = {
  loadWithStatus: vi.fn(),
  save: vi.fn(),
  delete: vi.fn(),
};

const secureSettingsStatics = {
  isInitialized: vi.fn(() => true),
  getInstance: vi.fn(() => mockSecureRepository),
};

vi.mock("../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: secureSettingsStatics,
}));

const nativeSqliteAvailable = (() => {
  try {
    const probe = new Database(":memory:");
    probe.close();
    return true;
  } catch {
    return false;
  }
})();

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("WorktreeManager", () => {
  let db: Database.Database;
  let WorktreeManagerClass: typeof import("../WorktreeManager").WorktreeManager;
  const temporaryRepos: string[] = [];
  function repository(): string {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-worktree-test-"));
    temporaryRepos.push(repo);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    git("init", "-b", "main");
    git("config", "user.name", "Worktree Test");
    git("config", "user.email", "worktree@example.test");
    fs.writeFileSync(path.join(repo, "app.txt"), "main content");
    git("add", "app.txt");
    git("commit", "-m", "Initial commit");
    return repo;
  }

  beforeEach(async () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE worktree_info (
        task_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'creating',
        created_at INTEGER NOT NULL,
        last_commit_sha TEXT,
        last_commit_message TEXT,
        merge_result TEXT,
        repo_path TEXT
      );
    `);
    db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);

    mockSecureRepository.loadWithStatus.mockReset();
    mockSecureRepository.loadWithStatus.mockReturnValue({ status: "missing" });
    mockSecureRepository.save.mockReset();
    mockSecureRepository.delete.mockReset();
    secureSettingsStatics.isInitialized.mockReset();
    secureSettingsStatics.getInstance.mockReset();
    secureSettingsStatics.isInitialized.mockReturnValue(true);
    secureSettingsStatics.getInstance.mockReturnValue(mockSecureRepository);

    ({ WorktreeManager: WorktreeManagerClass } = await import("../WorktreeManager"));
  });

  afterEach(() => {
    db?.close();
    for (const repo of temporaryRepos.splice(0)) fs.rmSync(repo, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("cleans a deleted task's worktree using its pre-deletion snapshot", async () => {
    const repo = repository();
    const manager = new WorktreeManagerClass(db);
    const created = await manager.createForTask("deleted-task", "Deleted task", "workspace", repo);
    const snapshot = await manager.getWorktreeInfo("deleted-task");
    expect(snapshot).toBeDefined();
    db.prepare("DELETE FROM worktree_info WHERE task_id = ?").run("deleted-task");
    await manager.cleanupDeletedWorktree(snapshot!, true);
    expect(fs.existsSync(created.worktreePath)).toBe(false);
    expect(
      execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" }),
    ).not.toContain(created.worktreePath);
  });

  it("returns secure settings when decryption succeeds", () => {
    mockSecureRepository.loadWithStatus.mockReturnValue({
      status: "success",
      data: {
        enabled: false,
        branchPrefix: "secure/",
      },
    });

    const manager = new WorktreeManagerClass(db);

    expect(manager.getSettings()).toEqual({
      ...DEFAULT_WORKTREE_SETTINGS,
      enabled: false,
      branchPrefix: "secure/",
    });
    expect(mockSecureRepository.delete).not.toHaveBeenCalled();
  });

  it("deletes corrupted secure settings and falls back to defaults", () => {
    mockSecureRepository.loadWithStatus.mockReturnValue({
      status: "decryption_failed",
      error: "Unsupported state or unable to authenticate data",
    });

    const manager = new WorktreeManagerClass(db);

    expect(manager.getSettings()).toEqual({ ...DEFAULT_WORKTREE_SETTINGS });
    expect(mockSecureRepository.delete).toHaveBeenCalledWith("worktree");
    expect(mockSecureRepository.save).not.toHaveBeenCalled();
  });

  it("repairs corrupted secure settings from legacy storage when available", () => {
    mockSecureRepository.loadWithStatus.mockReturnValue({
      status: "checksum_mismatch",
      error: "corrupted",
    });
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
      "worktree_settings",
      JSON.stringify({
        enabled: false,
        branchPrefix: "legacy/",
        commitMessagePrefix: "[legacy] ",
      }),
    );

    const manager = new WorktreeManagerClass(db);

    expect(manager.getSettings()).toEqual({
      ...DEFAULT_WORKTREE_SETTINGS,
      enabled: false,
      branchPrefix: "legacy/",
      commitMessagePrefix: "[legacy] ",
    });
    expect(mockSecureRepository.delete).toHaveBeenCalledWith("worktree");
    expect(mockSecureRepository.save).toHaveBeenCalledWith("worktree", {
      ...DEFAULT_WORKTREE_SETTINGS,
      enabled: false,
      branchPrefix: "legacy/",
      commitMessagePrefix: "[legacy] ",
    });
  });
});
