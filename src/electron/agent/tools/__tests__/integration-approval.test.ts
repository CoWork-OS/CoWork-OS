/**
 * Tests for external integration approval workflows
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../../../shared/types";
import { NotionTools } from "../notion-tools";
import { BoxTools } from "../box-tools";
import { OneDriveTools } from "../onedrive-tools";
import { GoogleDriveTools } from "../google-drive-tools";
import { GmailTools } from "../gmail-tools";
import { GoogleCalendarTools } from "../google-calendar-tools";
import { DropboxTools } from "../dropbox-tools";
import { SharePointTools } from "../sharepoint-tools";
import { NotionSettingsManager } from "../../../settings/notion-manager";
import { BoxSettingsManager } from "../../../settings/box-manager";
import { OneDriveSettingsManager } from "../../../settings/onedrive-manager";
import { GoogleWorkspaceSettingsManager } from "../../../settings/google-workspace-manager";
import { DropboxSettingsManager } from "../../../settings/dropbox-manager";
import { SharePointSettingsManager } from "../../../settings/sharepoint-manager";

vi.mock("../../../utils/notion-api", () => ({
  notionRequest: vi.fn().mockResolvedValue({ status: 200, data: {} }),
  DEFAULT_NOTION_VERSION: "2022-06-28",
}));

vi.mock("../../../utils/box-api", () => ({
  boxRequest: vi.fn().mockResolvedValue({ status: 200, data: {} }),
  boxUploadFile: vi.fn().mockResolvedValue({ status: 201, data: {} }),
}));

vi.mock("../../../utils/onedrive-api", () => ({
  onedriveRequest: vi.fn().mockResolvedValue({ status: 200, data: {} }),
}));

vi.mock("../../../utils/google-workspace-api", () => ({
  googleDriveRequest: vi.fn().mockResolvedValue({ status: 200, data: {} }),
  googleDriveUpload: vi.fn().mockResolvedValue({ status: 201, data: {} }),
}));

vi.mock("../../../utils/gmail-api", () => ({
  gmailRequest: vi.fn().mockResolvedValue({ status: 200, data: {} }),
}));

vi.mock("../../../utils/google-calendar-api", () => ({
  googleCalendarRequest: vi.fn().mockResolvedValue({ status: 200, data: {} }),
}));

vi.mock("../../../utils/dropbox-api", () => ({
  dropboxRequest: vi.fn().mockResolvedValue({ status: 200, data: {} }),
  dropboxUploadFile: vi.fn().mockResolvedValue({ status: 201, data: {} }),
}));

vi.mock("../../../utils/sharepoint-api", () => ({
  sharepointRequest: vi.fn().mockResolvedValue({ status: 200, data: {} }),
}));

const workspace: Workspace = {
  id: "workspace-1",
  name: "Test Workspace",
  path: "/tmp",
  createdAt: Date.now(),
  permissions: {
    read: true,
    write: true,
    delete: true,
    network: true,
    shell: true,
  },
};

const taskId = "task-123";

const buildDaemon = (approved = true) => ({
  requestApproval: vi.fn().mockResolvedValue(approved),
  logEvent: vi.fn(),
});

let notionSettingsSpy: ReturnType<typeof vi.spyOn>;
let boxSettingsSpy: ReturnType<typeof vi.spyOn>;
let oneDriveSettingsSpy: ReturnType<typeof vi.spyOn>;
let googleWorkspaceSettingsSpy: ReturnType<typeof vi.spyOn>;
let dropboxSettingsSpy: ReturnType<typeof vi.spyOn>;
let sharePointSettingsSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  notionSettingsSpy = vi.spyOn(NotionSettingsManager, "loadSettings");
  boxSettingsSpy = vi.spyOn(BoxSettingsManager, "loadSettings");
  oneDriveSettingsSpy = vi.spyOn(OneDriveSettingsManager, "loadSettings");
  googleWorkspaceSettingsSpy = vi.spyOn(GoogleWorkspaceSettingsManager, "loadSettings");
  dropboxSettingsSpy = vi.spyOn(DropboxSettingsManager, "loadSettings");
  sharePointSettingsSpy = vi.spyOn(SharePointSettingsManager, "loadSettings");
});

beforeEach(() => {
  vi.clearAllMocks();
  notionSettingsSpy.mockReturnValue({ enabled: true, apiKey: "notion-key" });
  boxSettingsSpy.mockReturnValue({ enabled: true, accessToken: "box-token" });
  oneDriveSettingsSpy.mockReturnValue({ enabled: true, accessToken: "onedrive-token" });
  googleWorkspaceSettingsSpy.mockReturnValue({
    enabled: true,
    accessToken: "gdrive-token",
    refreshToken: "gdrive-refresh",
    clientId: "gdrive-client",
  });
  dropboxSettingsSpy.mockReturnValue({ enabled: true, accessToken: "dropbox-token" });
  sharePointSettingsSpy.mockReturnValue({
    enabled: true,
    accessToken: "sharepoint-token",
    driveId: "drive-1",
    siteId: "site-1",
  });
});

describe("External integration approval workflows", () => {
  it("requests approval for Notion update_block", async () => {
    const daemon = buildDaemon();
    const tools = new NotionTools(workspace, daemon as Any, taskId);

    await tools.executeAction({
      action: "update_block",
      block_id: "block-1",
      archived: true,
    });

    expect(daemon.requestApproval).toHaveBeenCalledWith(
      taskId,
      "external_service",
      expect.any(String),
      expect.objectContaining({ action: "update_block" }),
    );
  });

  it("requests approval for Box create_folder", async () => {
    const daemon = buildDaemon();
    const tools = new BoxTools(workspace, daemon as Any, taskId);

    await tools.executeAction({
      action: "create_folder",
      name: "Reports",
      parent_id: "0",
    });

    expect(daemon.requestApproval).toHaveBeenCalledWith(
      taskId,
      "external_service",
      expect.any(String),
      expect.objectContaining({ action: "create_folder" }),
    );
  });

  it("requests approval for OneDrive create_folder", async () => {
    const daemon = buildDaemon();
    const tools = new OneDriveTools(workspace, daemon as Any, taskId);

    await tools.executeAction({
      action: "create_folder",
      name: "Reports",
    });

    expect(daemon.requestApproval).toHaveBeenCalledWith(
      taskId,
      "external_service",
      expect.any(String),
      expect.objectContaining({ action: "create_folder" }),
    );
  });

  it("requests approval for Google Drive create_folder", async () => {
    const daemon = buildDaemon();
    const tools = new GoogleDriveTools(workspace, daemon as Any, taskId);

    await tools.executeAction({
      action: "create_folder",
      name: "Reports",
    });

    expect(daemon.requestApproval).toHaveBeenCalledWith(
      taskId,
      "external_service",
      expect.any(String),
      expect.objectContaining({ action: "create_folder" }),
    );
  });

  it("requests approval for Gmail send_message", async () => {
    const daemon = buildDaemon();
    const tools = new GmailTools(workspace, daemon as Any, taskId);

    await tools.executeAction({
      action: "send_message",
      to: "test@example.com",
      subject: "Hello",
      body: "Test email",
    });

    expect(daemon.requestApproval).toHaveBeenCalledWith(
      taskId,
      "external_service",
      expect.any(String),
      expect.objectContaining({ action: "send_message" }),
    );
  });

  it("requests approval for Google Calendar create_event", async () => {
    const daemon = buildDaemon();
    const tools = new GoogleCalendarTools(workspace, daemon as Any, taskId);

    await tools.executeAction({
      action: "create_event",
      summary: "Sync",
      start: "2026-02-05T10:00:00Z",
      end: "2026-02-05T10:30:00Z",
    });

    expect(daemon.requestApproval).toHaveBeenCalledWith(
      taskId,
      "external_service",
      expect.any(String),
      expect.objectContaining({ action: "create_event" }),
    );
  });

  it("requests approval for Dropbox create_folder", async () => {
    const daemon = buildDaemon();
    const tools = new DropboxTools(workspace, daemon as Any, taskId);

    await tools.executeAction({
      action: "create_folder",
      path: "/Reports",
    });

    expect(daemon.requestApproval).toHaveBeenCalledWith(
      taskId,
      "external_service",
      expect.any(String),
      expect.objectContaining({ action: "create_folder" }),
    );
  });

  it("requests approval for SharePoint create_folder", async () => {
    const daemon = buildDaemon();
    const tools = new SharePointTools(workspace, daemon as Any, taskId);

    await tools.executeAction({
      action: "create_folder",
      name: "Reports",
    });

    expect(daemon.requestApproval).toHaveBeenCalledWith(
      taskId,
      "external_service",
      expect.any(String),
      expect.objectContaining({ action: "create_folder" }),
    );
  });

  it("throws when approval is denied", async () => {
    const daemon = buildDaemon(false);
    const tools = new BoxTools(workspace, daemon as Any, taskId);

    await expect(
      tools.executeAction({
        action: "create_folder",
        name: "Denied",
      }),
    ).rejects.toThrow("User denied Box action");

    expect(daemon.requestApproval).toHaveBeenCalled();
  });
});
