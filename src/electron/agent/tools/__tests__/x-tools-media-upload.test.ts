import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  settings: {
    enabled: true,
    authMethod: "manual",
    authToken: "fixture-token",
    ct0: "fixture-ct0",
    timeoutMs: 20000,
    mentionTrigger: {
      enabled: false,
      commandPrefix: "do:",
      allowedAuthors: [],
      pollIntervalSec: 120,
      fetchCount: 25,
      workspaceMode: "temporary",
    },
  },
  spawn: vi.fn(),
  policy: vi.fn(),
}));

vi.mock("child_process", () => {
  const execFile = vi.fn();
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), {
    value: (...args: unknown[]) => fixture.spawn(...args),
  });
  return { execFile };
});
vi.mock("../../../settings/x-manager", () => ({
  XSettingsManager: { loadSettings: () => structuredClone(fixture.settings) },
}));
vi.mock("../../../automation/responsibility-task-policy", () => ({
  enforceResponsibilityToolPolicy: fixture.policy,
}));

import { XTools } from "../x-tools";

describe("X reviewed media consumption", () => {
  let root: string;
  let workspace: Any;
  let daemon: Any;
  let tools: XTools;
  let authorityCalls: number;

  beforeEach(() => {
    vi.clearAllMocks();
    fixture.spawn.mockReset();
    fixture.policy.mockReset();
    fixture.settings.enabled = true;
    fixture.settings.authToken = "fixture-token";
    fixture.settings.ct0 = "fixture-ct0";
    fixture.policy.mockResolvedValue(undefined);
    fixture.spawn.mockResolvedValue({ stdout: "posted", stderr: "" });
    authorityCalls = 0;

    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cowork-x-review-")));
    workspace = {
      id: "workspace-x",
      path: root,
      permissions: {
        read: true,
        write: true,
        delete: true,
        network: true,
        shell: true,
      },
    };
    daemon = {
      requestApproval: vi.fn().mockResolvedValue(true),
      getToolEffectAuthority: vi.fn(async () => {
        authorityCalls += 1;
        return "admitted-authority";
      }),
      getEffectiveWorkspaceForTask: () => workspace,
      getDatabase: () => ({}),
      logEvent: vi.fn(),
    };
    tools = new XTools(workspace, daemon, "task-x");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reviews the exact snapshot and stages only those bytes with a private extension-preserving name", async () => {
    const source = path.join(root, "campaign.final.PnG");
    const reviewedBytes = Buffer.from("image bytes before approval");
    fs.writeFileSync(source, reviewedBytes);
    let stagedPath = "";

    daemon.requestApproval.mockImplementation(async (_task, _type, _summary, details) => {
      expect(details.reviewFiles).toEqual([source]);
      expect(details.expectedDraftRevisions).toEqual([
        {
          reference: source,
          sha256: createHash("sha256").update(reviewedBytes).digest("hex"),
          size: reviewedBytes.length,
        },
      ]);
      expect(details.params).toMatchObject({ action: "tweet", text: "launch", media: [source] });
      fs.writeFileSync(source, "changed while approval was pending");
      return true;
    });
    fixture.spawn.mockImplementation(async (_binary: string, args: string[]) => {
      const mediaIndex = args.indexOf("--media");
      stagedPath = args[mediaIndex + 1];
      expect(fs.readFileSync(stagedPath)).toEqual(reviewedBytes);
      expect(path.basename(stagedPath)).toBe("media-01.PnG");
      expect(fs.statSync(path.dirname(stagedPath)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(stagedPath).mode & 0o777).toBe(0o600);
      return { stdout: "posted", stderr: "" };
    });

    const input = { action: "tweet" as const, text: "launch", media: [source] };
    const execution = tools.executeAction(input);
    input.text = "mutated after invocation";
    input.media[0] = path.join(root, "replacement.png");

    await expect(execution).resolves.toMatchObject({ success: true, action: "tweet" });
    expect(fixture.spawn).toHaveBeenCalledTimes(1);
    expect(fixture.policy).toHaveBeenCalledWith(
      {},
      "task-x",
      "workspace-x",
      root,
      "x_action",
      expect.objectContaining({ action: "tweet", text: "launch", media: [source] }),
    );
    expect(fs.existsSync(stagedPath)).toBe(false);
  });

  it.each([
    [
      "too many files",
      (_rootPath: string) => ({ action: "tweet", text: "x", media: Array(5).fill("image.png") }),
    ],
    ["blank path", (_rootPath: string) => ({ action: "tweet", text: "x", media: [" "] })],
    [
      "missing file",
      (_rootPath: string) => ({ action: "tweet", text: "x", media: ["missing.png"] }),
    ],
    [
      "outside-workspace file",
      (_rootPath: string) => ({
        action: "tweet",
        text: "x",
        media: [path.join(os.tmpdir(), "outside-x.png")],
      }),
    ],
  ])("rejects %s before asking for approval or spawning Bird", async (_case, makeInput) => {
    await expect(tools.executeAction(makeInput(root) as Any)).rejects.toThrow();
    expect(daemon.requestApproval).not.toHaveBeenCalled();
    expect(fixture.spawn).not.toHaveBeenCalled();
  });

  it("rejects media larger than the reviewed snapshot limit", async () => {
    fs.writeFileSync(path.join(root, "oversize.png"), Buffer.alloc(4 * 1024 * 1024 + 1, 1));

    await expect(
      tools.executeAction({ action: "tweet", text: "x", media: ["oversize.png"] }),
    ).rejects.toThrow();
    expect(daemon.requestApproval).not.toHaveBeenCalled();
    expect(fixture.spawn).not.toHaveBeenCalled();
  });

  it.each(["task", "workspace", "settings"])(
    "blocks a %s revocation while the final responsibility policy is pending",
    async (change) => {
      const source = path.join(root, "draft.png");
      fs.writeFileSync(source, "reviewed");
      let announcePolicyStart!: () => void;
      let releasePolicy!: () => void;
      const policyStarted = new Promise<void>((resolve) => {
        announcePolicyStart = resolve;
      });
      const policyPending = new Promise<void>((resolve) => {
        releasePolicy = resolve;
      });
      fixture.policy.mockImplementation(() => {
        announcePolicyStart();
        return policyPending;
      });
      daemon.getToolEffectAuthority.mockImplementation(async () => {
        authorityCalls += 1;
        return change === "task" && authorityCalls > 1 ? null : "admitted-authority";
      });

      const execution = tools.executeAction({ action: "tweet", text: "x", media: [source] });
      await policyStarted;
      if (change === "workspace") workspace.permissions.read = false;
      if (change === "settings") fixture.settings.authToken = "changed-during-policy";
      releasePolicy();

      await expect(execution).rejects.toThrow(/authority changed|authority changed/i);
      expect(fixture.spawn).not.toHaveBeenCalled();
      expect(authorityCalls).toBe(change === "task" ? 2 : 1);
    },
  );

  it("rechecks local authority after the final asynchronous task-authority read", async () => {
    const source = path.join(root, "draft.png");
    fs.writeFileSync(source, "reviewed");
    daemon.getToolEffectAuthority
      .mockImplementationOnce(async () => {
        authorityCalls += 1;
        return "admitted-authority";
      })
      .mockImplementationOnce(async () => {
        authorityCalls += 1;
        fixture.settings.ct0 = "changed-during-authority-read";
        return "admitted-authority";
      });

    await expect(
      tools.executeAction({ action: "tweet", text: "x", media: [source] }),
    ).rejects.toThrow("X action authority changed before command execution");
    expect(fixture.spawn).not.toHaveBeenCalled();
    expect(authorityCalls).toBe(2);
  });

  it("runs a synchronous workspace check after queued revocation and before the native spawn", async () => {
    const source = path.join(root, "draft.png");
    fs.writeFileSync(source, "reviewed");
    let effectiveWorkspaceReads = 0;
    let revocationApplied = false;
    daemon.getEffectiveWorkspaceForTask = () => {
      effectiveWorkspaceReads += 1;
      if (effectiveWorkspaceReads === 7) {
        queueMicrotask(() => {
          workspace.permissions.write = false;
          revocationApplied = true;
        });
      }
      return workspace;
    };

    await expect(
      tools.executeAction({ action: "tweet", text: "x", media: [source] }),
    ).rejects.toThrow("X action authority changed before command execution");
    expect(revocationApplied).toBe(true);
    expect(effectiveWorkspaceReads).toBe(8);
    expect(fixture.spawn).not.toHaveBeenCalled();
  });

  it("keeps governed X posts denied when the trusted responsibility policy rejects them", async () => {
    const source = path.join(root, "draft.png");
    fs.writeFileSync(source, "reviewed");
    fixture.policy.mockRejectedValue(
      new Error("Responsibility tool denied: operation not cataloged"),
    );

    await expect(
      tools.executeAction({ action: "tweet", text: "x", media: [source] }),
    ).rejects.toThrow("Responsibility tool denied");
    expect(fixture.policy).toHaveBeenCalledWith(
      {},
      "task-x",
      "workspace-x",
      root,
      "x_action",
      expect.objectContaining({ action: "tweet", media: [source] }),
    );
    expect(fixture.spawn).not.toHaveBeenCalled();
  });

  it("reruns the final gate before Bird's JSON compatibility fallback and cleans staged files", async () => {
    const source = path.join(root, "draft.png");
    fs.writeFileSync(source, "reviewed");
    const stagedPaths: string[] = [];
    fixture.spawn
      .mockImplementationOnce(async (_binary: string, args: string[]) => {
        stagedPaths.push(args[args.indexOf("--media") + 1]);
        const error = new Error("unknown option --json") as Any;
        error.stderr = "unknown option --json";
        throw error;
      })
      .mockImplementationOnce(async (_binary: string, args: string[]) => {
        stagedPaths.push(args[args.indexOf("--media") + 1]);
        return { stdout: "posted", stderr: "" };
      });

    await expect(
      tools.executeAction({ action: "tweet", text: "x", media: [source] }),
    ).resolves.toMatchObject({ success: true });
    expect(fixture.spawn).toHaveBeenCalledTimes(2);
    expect(fixture.policy).toHaveBeenCalledTimes(2);
    expect(authorityCalls).toBe(3);
    expect(stagedPaths[0]).toBe(stagedPaths[1]);
    expect(fs.existsSync(stagedPaths[0])).toBe(false);
    expect(fixture.spawn.mock.calls[0][1]).toContain("--json");
    expect(fixture.spawn.mock.calls[1][1]).not.toContain("--json");
  });

  it("does not spawn Bird for the JSON fallback after its final authority is revoked", async () => {
    const source = path.join(root, "draft.png");
    fs.writeFileSync(source, "reviewed");
    daemon.getToolEffectAuthority.mockImplementation(async () => {
      authorityCalls += 1;
      return authorityCalls < 3 ? "admitted-authority" : null;
    });
    fixture.spawn.mockImplementationOnce(async () => {
      const error = new Error("unknown option --json") as Any;
      error.stderr = "unknown option --json";
      throw error;
    });
    let stagedPath = "";
    fixture.spawn.mockImplementationOnce(async (_binary: string, args: string[]) => {
      stagedPath = args[args.indexOf("--media") + 1];
      return { stdout: "should not execute", stderr: "" };
    });

    await expect(
      tools.executeAction({ action: "tweet", text: "x", media: [source] }),
    ).rejects.toThrow("X task authority changed before command execution");
    expect(fixture.spawn).toHaveBeenCalledTimes(1);
    expect(fixture.policy).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(stagedPath)).toBe(false);
  });

  it("runs the synchronous last gate on Bird's JSON fallback spawn", async () => {
    const source = path.join(root, "draft.png");
    fs.writeFileSync(source, "reviewed");
    let effectiveWorkspaceReads = 0;
    let revocationApplied = false;
    daemon.getEffectiveWorkspaceForTask = () => {
      effectiveWorkspaceReads += 1;
      if (effectiveWorkspaceReads === 12) {
        queueMicrotask(() => {
          fixture.settings.authToken = "changed-before-fallback-spawn";
          revocationApplied = true;
        });
      }
      return workspace;
    };
    let stagedPath = "";
    fixture.spawn.mockImplementationOnce(async (_binary: string, args: string[]) => {
      stagedPath = args[args.indexOf("--media") + 1];
      const error = new Error("unknown option --json") as Any;
      error.stderr = "unknown option --json";
      throw error;
    });

    await expect(
      tools.executeAction({ action: "tweet", text: "x", media: [source] }),
    ).rejects.toThrow("X action authority changed before command execution");
    expect(revocationApplied).toBe(true);
    expect(effectiveWorkspaceReads).toBe(13);
    expect(fixture.policy).toHaveBeenCalledTimes(2);
    expect(fixture.spawn).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(stagedPath)).toBe(false);
  });

  it("blocks browser fallback when workspace authority changes after the CLI attempt", async () => {
    const source = path.join(root, "draft.png");
    fs.writeFileSync(source, "reviewed");
    const openBrowserFallback = vi
      .spyOn(tools as Any, "openBrowserFallbackPage")
      .mockResolvedValue({ navResult: { success: true }, browserChannel: "fixture" });
    fixture.spawn.mockImplementationOnce(async () => {
      workspace.permissions.write = false;
      throw new Error("service temporarily unavailable");
    });

    await expect(
      tools.executeAction({ action: "tweet", text: "x", media: [source] }),
    ).rejects.toThrow("X action authority changed before command execution");
    expect(fixture.spawn).toHaveBeenCalledTimes(1);
    expect(openBrowserFallback).not.toHaveBeenCalled();
  });
});
