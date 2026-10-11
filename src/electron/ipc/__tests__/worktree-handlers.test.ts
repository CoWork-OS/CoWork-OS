import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS, type Workspace } from "../../../shared/types";
import type { AgentDaemon } from "../../agent/daemon";

type Handler = (...args: unknown[]) => unknown;
const { handlers, git, access } = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  git: {
    isGitRepo: vi.fn(),
    getHeadCommit: vi.fn(),
    getCurrentBranch: vi.fn(),
    getLocalBranches: vi.fn(),
  },
  access: vi.fn(),
}));
vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
}));
vi.mock("../../git/GitService", () => ({ GitService: git }));
vi.mock("../../security/access-profile-paths", () => ({ assertWorkspaceFilesystemAccess: access }));
vi.mock("../../utils/rate-limiter", () => ({
  rateLimiter: { configure: vi.fn(), check: () => true },
  RATE_LIMIT_CONFIGS: { standard: {}, limited: {}, frequent: {}, expensive: {} },
}));
import { setupWorktreeHandlers } from "../worktree-handlers";

describe("Build worktree workspace inspection", () => {
  let workspace: Workspace;
  const readInfo = () => handlers.get(IPC_CHANNELS.WORKTREE_WORKSPACE_INFO)!(null, workspace.id);
  beforeEach(() => {
    handlers.clear();
    vi.resetAllMocks();
    workspace = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Project",
      path: "/project",
      createdAt: 1,
      permissions: { read: true, write: true, execute: true },
    };
    git.isGitRepo.mockResolvedValue(true);
    git.getHeadCommit.mockResolvedValue("abc123");
    git.getCurrentBranch.mockResolvedValue("main");
    git.getLocalBranches.mockResolvedValue(["main", "feature/base"]);
    setupWorktreeHandlers({
      getWorktreeManager: () => ({}),
      getWorkspaceById: (id: string) => (id === workspace.id ? workspace : undefined),
    } as unknown as AgentDaemon);
  });
  it("returns starting branches only after authorizing workspace reads", async () => {
    await expect(readInfo()).resolves.toEqual({
      workspaceId: workspace.id,
      available: true,
      currentBranch: "main",
      branches: ["main", "feature/base"],
    });
    expect(access).toHaveBeenCalledWith(workspace, workspace.path, "read", "worktree repository");
  });
  it("explains temporary and read-only folders without inspecting Git", async () => {
    workspace.isTemp = true;
    await expect(readInfo()).resolves.toMatchObject({
      available: false,
      branches: [],
      reason: expect.stringContaining("Git project"),
    });
    workspace.isTemp = false;
    workspace.permissions.write = false;
    await expect(readInfo()).resolves.toMatchObject({
      available: false,
      reason: expect.stringContaining("read-only"),
    });
    expect(git.isGitRepo).not.toHaveBeenCalled();
  });
  it("explains non-repositories and repositories without commits", async () => {
    git.isGitRepo.mockResolvedValue(false);
    await expect(readInfo()).resolves.toMatchObject({
      available: false,
      reason: "Worktrees require a Git repository.",
    });
    git.isGitRepo.mockResolvedValue(true);
    git.getHeadCommit.mockRejectedValue(new Error("No HEAD"));
    await expect(readInfo()).resolves.toMatchObject({
      available: false,
      reason: expect.stringContaining("first commit"),
    });
    expect(git.getLocalBranches).not.toHaveBeenCalled();
  });
  it("does not inspect Git when filesystem access is denied", async () => {
    access.mockImplementation(() => {
      throw new Error("Access denied");
    });
    await expect(readInfo()).rejects.toThrow("Access denied");
    expect(git.isGitRepo).not.toHaveBeenCalled();
  });
});
