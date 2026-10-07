import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  settings: { enabled: true, accessToken: "fixture" },
  upload: vi.fn(),
  policy: vi.fn(),
}));
vi.mock("../../../settings/box-manager", () => ({
  BoxSettingsManager: { loadSettings: () => structuredClone(fixture.settings) },
}));
vi.mock("../../../utils/box-api", () => ({ boxRequest: vi.fn(), boxUploadFile: fixture.upload }));
vi.mock("../../../automation/responsibility-task-policy", () => ({
  enforceResponsibilityToolPolicy: fixture.policy,
}));
import { BoxTools } from "../box-tools";
describe("Box reviewed upload consumption", () => {
  let root: string, workspace: Any, daemon: Any, tools: BoxTools;
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.settings.enabled = true;
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cowork-box-draft-")));
    workspace = {
      id: "ws",
      path: root,
      permissions: { read: true, network: true, unrestrictedFileAccess: false },
    };
    fs.writeFileSync(path.join(root, "draft.txt"), "approved draft");
    daemon = {
      requestApproval: vi.fn().mockResolvedValue(true),
      getToolEffectAuthority: vi.fn().mockResolvedValue("authority"),
      getEffectiveWorkspaceForTask: () => workspace,
      getDatabase: () => ({}),
      logEvent: vi.fn(),
    };
    fixture.policy.mockResolvedValue(undefined);
    fixture.upload.mockImplementation(async (_settings, opts) => {
      await opts.beforeSend();
      return { status: 201, data: { bytes: opts.data.toString() } };
    });
    tools = new BoxTools(workspace, daemon, "task");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  it("declares the exact reviewed bytes and consumes them after the source changes", async () => {
    daemon.requestApproval.mockImplementation(async (_task, _type, _summary, details) => {
      expect(details.reviewFiles).toEqual([path.join(root, "draft.txt")]);
      expect(details.expectedDraftRevisions).toEqual([
        {
          reference: path.join(root, "draft.txt"),
          sha256: createHash("sha256").update("approved draft").digest("hex"),
          size: 14,
        },
      ]);
      fs.writeFileSync(path.join(root, "draft.txt"), "after approval");
      return true;
    });
    expect(
      (await tools.executeAction({ action: "upload_file", file_path: "draft.txt" })).data.bytes,
    ).toBe("approved draft");
    expect(fixture.policy).toHaveBeenCalledWith(
      {},
      "task",
      "ws",
      root,
      "box_action",
      expect.objectContaining({ action: "upload_file" }),
    );
  });
  it.each(["workspace", "task", "disabled", "policy", "credential"])(
    "refuses %s revocation at the delayed upload boundary",
    async (change) => {
      let submitted = 0;
      fixture.upload.mockImplementation(async (_settings, opts) => {
        if (change === "workspace") workspace.permissions.read = false;
        if (change === "task") daemon.getToolEffectAuthority.mockResolvedValue(null);
        if (change === "disabled") fixture.settings.enabled = false;
        if (change === "policy")
          fixture.policy.mockRejectedValue(new Error("responsibility paused"));
        if (change === "credential") fixture.settings.accessToken = "manual";
        await opts.beforeSend();
        submitted++;
        return { status: 201 };
      });
      await expect(
        tools.executeAction({ action: "upload_file", file_path: "draft.txt" }),
      ).rejects.toThrow();
      expect(submitted).toBe(0);
      fixture.settings.accessToken = "fixture";
    },
  );
  it("rechecks authority after the awaited responsibility policy", async () => {
    let revoked = false;
    let releasePolicy: (() => void) | undefined;
    let announcePolicyStart: (() => void) | undefined;
    const policyStarted = new Promise<void>((resolve) => {
      announcePolicyStart = resolve;
    });
    const policyPending = new Promise<void>((resolve) => {
      releasePolicy = resolve;
    });
    daemon.getToolEffectAuthority.mockImplementation(async () => (revoked ? null : "authority"));
    fixture.policy.mockImplementation(() => {
      announcePolicyStart?.();
      return policyPending;
    });
    let submitted = 0;
    fixture.upload.mockImplementation(async (_settings, opts) => {
      await opts.beforeSend();
      submitted++;
      return { status: 201 };
    });

    const upload = tools.executeAction({ action: "upload_file", file_path: "draft.txt" });
    await policyStarted;
    revoked = true;
    releasePolicy?.();

    await expect(upload).rejects.toThrow("Box upload task authority changed before send");
    expect(daemon.getToolEffectAuthority).toHaveBeenCalledTimes(2);
    expect(submitted).toBe(0);
  });
  it.each(["workspace", "credential", "disabled"])(
    "rechecks %s after the final asynchronous authority read",
    async (change) => {
      daemon.getToolEffectAuthority
        .mockImplementationOnce(async () => "authority")
        .mockImplementationOnce(async () => {
          if (change === "workspace") workspace.permissions.read = false;
          if (change === "credential") fixture.settings.accessToken = "manual-late";
          if (change === "disabled") fixture.settings.enabled = false;
          return "authority";
        });
      let submitted = 0;
      fixture.upload.mockImplementation(async (_settings, opts) => {
        await opts.beforeSend();
        submitted++;
        return { status: 201 };
      });
      await expect(
        tools.executeAction({ action: "upload_file", file_path: "draft.txt" }),
      ).rejects.toThrow("authority changed before send");
      expect(submitted).toBe(0);
      fixture.settings.accessToken = "fixture";
    },
  );
  it("does not submit a refused review", async () => {
    daemon.requestApproval.mockResolvedValue(false);
    await expect(
      tools.executeAction({ action: "upload_file", file_path: "draft.txt" }),
    ).rejects.toThrow("denied");
    expect(fixture.upload).not.toHaveBeenCalled();
  });
  it("reviews the authorized canonical target of a local alias", async () => {
    fs.symlinkSync(path.join(root, "draft.txt"), path.join(root, "link.txt"));
    await expect(
      tools.executeAction({ action: "upload_file", file_path: "link.txt" }),
    ).resolves.toMatchObject({ success: true });
    expect(daemon.requestApproval.mock.calls[0][3].reviewFiles).toEqual([
      path.join(root, "draft.txt"),
    ]);
  });
});
