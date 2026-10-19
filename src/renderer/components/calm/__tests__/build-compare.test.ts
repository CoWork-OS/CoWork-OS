import { describe, expect, it, vi } from "vitest";
import { submitBuildCompare } from "../BuildPanel";

const COMMIT = "c".repeat(40);

describe("Build Compare", () => {
  it("starts every variant from one commit with the same check", async () => {
    const onStart = vi.fn().mockResolvedValue(true);
    const resolveBaseCommit = vi.fn().mockResolvedValue({ commit: COMMIT });

    await expect(
      submitBuildCompare(onStart, "Build a status board", [], {
        workspaceId: "ws-1",
        branch: "main",
        count: 3,
        check: "  npm test ",
        accessProfileId: "ask_for_approval" as Any,
        resolveBaseCommit,
        newGroupId: () => "group-0001",
      }),
    ).resolves.toBe(true);

    expect(resolveBaseCommit).toHaveBeenCalledOnce();
    expect(resolveBaseCommit).toHaveBeenCalledWith({ workspaceId: "ws-1", branch: "main" });
    expect(onStart).toHaveBeenCalledTimes(3);
    expect(onStart.mock.calls.map((call) => call[2])).toEqual(
      [1, 2, 3].map((variant) => ({
        accessProfileId: "ask_for_approval",
        worktreeMode: "worktree",
        worktreeBaseBranch: "main",
        worktreeBaseCommit: COMMIT,
        compareGroupId: "group-0001",
        compareVariant: variant,
        compareCheckCommand: "npm test",
      })),
    );
    // Every variant gets the same request.
    expect(new Set(onStart.mock.calls.map((call) => call[0])).size).toBe(1);
  });

  it("stops at the first variant that is not admitted, and needs no check", async () => {
    const onStart = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(
      submitBuildCompare(onStart, "Build it", [], {
        workspaceId: "ws-1",
        count: 3,
        check: "",
        resolveBaseCommit: async () => ({ commit: COMMIT }),
        newGroupId: () => "group-0002",
      }),
    ).resolves.toBe(true);
    expect(onStart).toHaveBeenCalledTimes(2);
    expect(onStart.mock.calls[0][2]).not.toHaveProperty("compareCheckCommand");
    expect(onStart.mock.calls[0][2]).not.toHaveProperty("worktreeBaseBranch");
  });
});
