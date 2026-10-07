import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GOOGLE_WORKSPACE_DEFAULT_SCOPES } from "../../../../shared/google-workspace";

const fixture = vi.hoisted(() => ({
  settings: {
    google: {
      enabled: true,
      connectionMode: "workspace",
      accessToken: "google-token",
      refreshToken: "google-refresh",
      clientId: "google-client",
      scopes: [],
    },
    dropbox: { enabled: true, accessToken: "dropbox-token" },
    box: { enabled: true, accessToken: "box-token" },
    sharepoint: { enabled: true, accessToken: "sharepoint-token", driveId: "drive-1" },
    onedrive: { enabled: true, accessToken: "onedrive-token", driveId: "drive-2" },
  },
  sent: [] as string[],
  responsibilityPolicy: vi.fn(),
  googleDriveRequest: vi.fn(),
  googleDriveUpload: vi.fn(),
  boxRequest: vi.fn(),
  dropboxRequest: vi.fn(),
  dropboxContentUpload: vi.fn(),
  sharepointRequest: vi.fn(),
  onedriveRequest: vi.fn(),
}));

vi.mock("../../../settings/google-workspace-manager", () => ({
  GoogleWorkspaceSettingsManager: { loadSettings: () => structuredClone(fixture.settings.google) },
}));
vi.mock("../../../settings/box-manager", () => ({
  BoxSettingsManager: { loadSettings: () => structuredClone(fixture.settings.box) },
}));
vi.mock("../../../settings/dropbox-manager", () => ({
  DropboxSettingsManager: { loadSettings: () => structuredClone(fixture.settings.dropbox) },
}));
vi.mock("../../../settings/sharepoint-manager", () => ({
  SharePointSettingsManager: { loadSettings: () => structuredClone(fixture.settings.sharepoint) },
}));
vi.mock("../../../settings/onedrive-manager", () => ({
  OneDriveSettingsManager: { loadSettings: () => structuredClone(fixture.settings.onedrive) },
}));
vi.mock("../../../automation/responsibility-task-policy", () => ({
  enforceResponsibilityToolPolicy: fixture.responsibilityPolicy,
}));
vi.mock("../../../utils/google-workspace-api", () => ({
  googleDriveRequest: fixture.googleDriveRequest,
  googleDriveUpload: fixture.googleDriveUpload,
}));
vi.mock("../../../utils/box-api", () => ({
  boxRequest: fixture.boxRequest,
  boxUploadFile: vi.fn(),
}));
vi.mock("../../../utils/dropbox-api", () => ({
  dropboxRequest: fixture.dropboxRequest,
  dropboxContentUpload: fixture.dropboxContentUpload,
}));
vi.mock("../../../utils/sharepoint-api", () => ({
  sharepointRequest: fixture.sharepointRequest,
}));
vi.mock("../../../utils/onedrive-api", () => ({
  onedriveRequest: fixture.onedriveRequest,
}));

import { GoogleDriveTools } from "../google-drive-tools";
import { BoxTools } from "../box-tools";
import { DropboxTools } from "../dropbox-tools";
import { SharePointTools } from "../sharepoint-tools";
import { OneDriveTools } from "../onedrive-tools";

const taskId = "upload-review-task";
const content = "reviewed cloud upload bytes";

type Provider = "google" | "dropbox" | "sharepoint" | "onedrive";

describe("cloud integration upload review", () => {
  let root: string;
  let workspacePath: string;
  let filePath: string;
  let workspace: Any;
  let daemon: Any;

  beforeEach(() => {
    vi.clearAllMocks();
    fixture.sent.length = 0;
    fixture.settings.google = {
      enabled: true,
      connectionMode: "workspace",
      accessToken: "google-token",
      refreshToken: "google-refresh",
      clientId: "google-client",
      scopes: [...GOOGLE_WORKSPACE_DEFAULT_SCOPES],
    };
    fixture.settings.dropbox = { enabled: true, accessToken: "dropbox-token" };
    fixture.settings.box = { enabled: true, accessToken: "box-token" };
    fixture.settings.sharepoint = {
      enabled: true,
      accessToken: "sharepoint-token",
      driveId: "drive-1",
    };
    fixture.settings.onedrive = {
      enabled: true,
      accessToken: "onedrive-token",
      driveId: "drive-2",
    };
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cowork-upload-review-")));
    workspacePath = path.join(root, "workspace");
    fs.mkdirSync(workspacePath);
    filePath = path.join(workspacePath, "draft.txt");
    fs.writeFileSync(filePath, content);
    workspace = {
      id: "upload-review-workspace",
      path: workspacePath,
      permissions: { read: true, write: true, network: true },
    };
    daemon = {
      requestApproval: vi.fn().mockResolvedValue(true),
      getToolEffectAuthority: vi.fn().mockResolvedValue("authority"),
      getEffectiveWorkspaceForTask: () => workspace,
      getDatabase: () => ({}),
      logEvent: vi.fn(),
    };
    fixture.responsibilityPolicy.mockResolvedValue(undefined);
    fixture.googleDriveRequest.mockImplementation(async (_settings, options) => {
      if (options.beforeSend) await options.beforeSend();
      fixture.sent.push(
        options.path === "/files" && options.body?.mimeType ? "google-action" : "google-metadata",
      );
      return { status: 200, data: { id: "drive-file" } };
    });
    fixture.boxRequest.mockImplementation(async (_settings, options) => {
      await options.beforeSend?.();
      fixture.sent.push("box-action");
      return { status: 200, data: {} };
    });
    fixture.dropboxRequest.mockImplementation(async (_settings, options) => {
      await options.beforeSend?.();
      fixture.sent.push("dropbox-action");
      return { status: 200, data: {} };
    });
    fixture.googleDriveUpload.mockImplementation(
      async (_settings, _id, _data, _type, _signal, gate) => {
        if (gate) await gate();
        fixture.sent.push("google-content");
        return { status: 200, data: {} };
      },
    );
    fixture.dropboxContentUpload.mockImplementation(async (_settings, options) => {
      await options.beforeSend?.();
      fixture.sent.push("dropbox-content");
      return { status: 200, data: {} };
    });
    fixture.sharepointRequest.mockImplementation(async (_settings, options) => {
      await options.beforeSend?.();
      fixture.sent.push("sharepoint-content");
      return { status: 200, data: {} };
    });
    fixture.onedriveRequest.mockImplementation(async (_settings, options) => {
      await options.beforeSend?.();
      fixture.sent.push("onedrive-content");
      return { status: 200, data: {} };
    });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function makeTool(provider: Provider, sourcePath = filePath) {
    const tools = {
      google: new GoogleDriveTools(workspace, daemon, taskId),
      dropbox: new DropboxTools(workspace, daemon, taskId),
      sharepoint: new SharePointTools(workspace, daemon, taskId),
      onedrive: new OneDriveTools(workspace, daemon, taskId),
    }[provider];
    const inputs = {
      google: { action: "upload_file", file_path: sourcePath, parent_id: "folder-1" },
      dropbox: { action: "upload_file", file_path: sourcePath, path: "/Bots/draft.txt" },
      sharepoint: {
        action: "upload_file",
        file_path: sourcePath,
        drive_id: "drive-1",
        remote_path: "Bots/draft.txt",
      },
      onedrive: {
        action: "upload_file",
        file_path: sourcePath,
        drive_id: "drive-2",
        remote_path: "Bots/draft.txt",
      },
    }[provider];
    return () => tools.executeAction(inputs as Any);
  }

  function executeMutation(provider: Provider | "box", action: "create_folder" | "delete") {
    const tools = {
      google: new GoogleDriveTools(workspace, daemon, taskId),
      dropbox: new DropboxTools(workspace, daemon, taskId),
      sharepoint: new SharePointTools(workspace, daemon, taskId),
      onedrive: new OneDriveTools(workspace, daemon, taskId),
      box: new BoxTools(workspace, daemon, taskId),
    }[provider];
    const inputs = {
      google:
        action === "create_folder"
          ? { action: "create_folder", name: "Reports", parent_id: "folder-1" }
          : { action: "delete_file", file_id: "file-1" },
      dropbox:
        action === "create_folder"
          ? { action: "create_folder", path: "/Reports" }
          : { action: "delete_item", path: "/Reports/file.txt" },
      sharepoint:
        action === "create_folder"
          ? { action: "create_folder", name: "Reports", drive_id: "drive-1" }
          : { action: "delete_item", item_id: "item-1", drive_id: "drive-1" },
      onedrive:
        action === "create_folder"
          ? { action: "create_folder", name: "Reports", drive_id: "drive-2" }
          : { action: "delete_item", item_id: "item-1", drive_id: "drive-2" },
      box:
        action === "create_folder"
          ? { action: "create_folder", name: "Reports", parent_id: "folder-1" }
          : { action: "delete_file", file_id: "file-1" },
    }[provider];
    return tools.executeAction(inputs as Any);
  }

  it.each([
    ["google", "create_folder"],
    ["google", "delete"],
    ["dropbox", "create_folder"],
    ["dropbox", "delete"],
    ["sharepoint", "create_folder"],
    ["sharepoint", "delete"],
    ["onedrive", "create_folder"],
    ["onedrive", "delete"],
    ["box", "create_folder"],
    ["box", "delete"],
  ] as const)("%s %s refuses to send after task authority is revoked", async (provider, action) => {
    daemon.requestApproval.mockImplementation(async (_task, type) => {
      if (type === "external_service") daemon.getToolEffectAuthority.mockResolvedValue("revoked");
      return true;
    });

    await expect(executeMutation(provider, action)).rejects.toThrow(
      "task authority changed before send",
    );
    expect(fixture.sent).toEqual([]);
  });

  it.each(["google", "dropbox", "sharepoint", "onedrive"] as const)(
    "%s binds approval and send to the exact reviewed file revision",
    async (provider) => {
      await makeTool(provider)();
      const serviceApproval = daemon.requestApproval.mock.calls.find(
        ([, type]) => type === "external_service",
      );
      expect(serviceApproval).toBeDefined();
      expect(serviceApproval![3]).toMatchObject({
        action: "upload_file",
        reviewFiles: [filePath],
        expectedDraftRevisions: [
          {
            reference: filePath,
            sha256: createHash("sha256").update(content).digest("hex"),
            size: Buffer.byteLength(content),
          },
        ],
      });
      expect(fixture.sent).toEqual(
        provider === "google" ? ["google-metadata", "google-content"] : [`${provider}-content`],
      );
      expect(daemon.getToolEffectAuthority).toHaveBeenCalledTimes(provider === "google" ? 3 : 2);
    },
  );

  it.each(["google", "dropbox", "sharepoint", "onedrive"] as const)(
    "%s refuses to send if the reviewed file changes after approval",
    async (provider) => {
      daemon.requestApproval.mockImplementation(async (_task, type) => {
        if (type === "external_service") fs.writeFileSync(filePath, "changed after approval");
        return true;
      });

      await expect(makeTool(provider)()).rejects.toThrow(
        "Upload file revision changed before send",
      );
      expect(fixture.sent).toEqual([]);
    },
  );

  it.each(["google", "dropbox", "sharepoint", "onedrive"] as const)(
    "%s refuses a manual credential replacement after approval",
    async (provider) => {
      daemon.requestApproval.mockImplementation(async (_task, type) => {
        if (type === "external_service") fixture.settings[provider].accessToken = "manual-change";
        return true;
      });

      await expect(makeTool(provider)()).rejects.toThrow("authority changed before send");
      expect(fixture.sent).toEqual([]);
    },
  );

  it.each(["google", "dropbox", "sharepoint", "onedrive"] as const)(
    "%s refuses revoked task authority at the send boundary",
    async (provider) => {
      daemon.requestApproval.mockImplementation(async (_task, type) => {
        if (type === "external_service") daemon.getToolEffectAuthority.mockResolvedValue("revoked");
        return true;
      });

      await expect(makeTool(provider)()).rejects.toThrow("task authority changed before send");
      expect(fixture.sent).toEqual([]);
    },
  );

  it.each(["google", "dropbox", "sharepoint", "onedrive"] as const)(
    "%s preserves external file access approval and seals that approved snapshot",
    async (provider) => {
      const externalPath = path.join(root, "outside.txt");
      fs.writeFileSync(externalPath, content);
      await makeTool(provider, externalPath)();

      expect(daemon.requestApproval.mock.calls.map(([, type]) => type)).toEqual([
        "external_file_access",
        "external_service",
      ]);
      const serviceDetails = daemon.requestApproval.mock.calls[1][3];
      expect(serviceDetails).toMatchObject({
        externalFileRevision: {
          path: fs.realpathSync(externalPath),
          sha256: createHash("sha256").update(content).digest("hex"),
          size: Buffer.byteLength(content),
        },
      });
      expect(serviceDetails).not.toHaveProperty("reviewFiles");
    },
  );
});
