/**
 * Tests for external integration approval workflows
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../../../shared/types";
import { GOOGLE_WORKSPACE_DEFAULT_SCOPES } from "../../../../shared/google-workspace";
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
import { googleDriveRequest } from "../../../utils/google-workspace-api";
import { gmailRequest } from "../../../utils/gmail-api";
import { googleCalendarRequest } from "../../../utils/google-calendar-api";
import { notionRequest } from "../../../utils/notion-api";

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

vi.mock("../../../automation/responsibility-task-policy", () => ({
  enforceResponsibilityToolPolicy: vi.fn().mockResolvedValue(undefined),
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

const buildDaemon = (approved = true, activeWorkspace: Workspace = workspace) => ({
  requestApproval: vi.fn().mockResolvedValue(approved),
  getToolEffectAuthority: vi.fn().mockResolvedValue("authority"),
  getEffectiveWorkspaceForTask: vi.fn(() => activeWorkspace),
  getDatabase: vi.fn(() => ({})),
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
  vi.mocked(gmailRequest).mockResolvedValue({ status: 200, data: {} });
  vi.mocked(googleCalendarRequest).mockResolvedValue({ status: 200, data: {} });
  vi.mocked(notionRequest).mockResolvedValue({ status: 200, data: {} });
  notionSettingsSpy.mockReturnValue({ enabled: true, apiKey: "notion-key" });
  boxSettingsSpy.mockReturnValue({ enabled: true, accessToken: "box-token" });
  oneDriveSettingsSpy.mockReturnValue({ enabled: true, accessToken: "onedrive-token" });
  googleWorkspaceSettingsSpy.mockReturnValue({
    enabled: true,
    connectionMode: "workspace",
    accessToken: "gdrive-token",
    refreshToken: "gdrive-refresh",
    clientId: "gdrive-client",
    scopes: [...GOOGLE_WORKSPACE_DEFAULT_SCOPES],
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
      expect.objectContaining({
        action: "update_block",
        reviewedEffect: expect.objectContaining({
          provider: "notion",
          operation: "update_block",
          target: expect.objectContaining({ kind: "block", id: "block-1" }),
          change: { archived: true },
          request: expect.objectContaining({ method: "PATCH", sha256: expect.any(String) }),
        }),
      }),
    );
  });

  it("rechecks Notion authority at the HTTP boundary", async () => {
    const daemon = buildDaemon();
    let authority = "authority";
    daemon.getToolEffectAuthority.mockImplementation(async () => authority);
    vi.mocked(notionRequest).mockImplementation(async (_settings, options) => {
      authority = "changed";
      await options.beforeSend?.();
      return { status: 200, data: {} };
    });
    const tools = new NotionTools(workspace, daemon as Any, taskId);

    await expect(
      tools.executeAction({ action: "update_block", block_id: "block-1", archived: true }),
    ).rejects.toThrow(/task authority changed before send/i);
  });

  it("refuses to delete a Notion block whose reviewed revision changed", async () => {
    const daemon = buildDaemon();
    let block = { id: "block-1", paragraph: { rich_text: [{ plain_text: "Before" }] } };
    let submitted = false;
    daemon.requestApproval.mockImplementation(async () => {
      block = { id: "block-1", paragraph: { rich_text: [{ plain_text: "After" }] } };
      return true;
    });
    vi.mocked(notionRequest).mockImplementation(async (_settings, options) => {
      if (options.method === "GET") return { status: 200, data: block };
      await options.beforeSend?.();
      submitted = true;
      return { status: 200, data: {} };
    });
    const tools = new NotionTools(workspace, daemon as Any, taskId);

    await expect(
      tools.executeAction({ action: "delete_block", block_id: "block-1" }),
    ).rejects.toThrow(/block changed after review/i);
    expect(submitted).toBe(false);
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
      expect.objectContaining({
        action: "send_message",
        reviewedEffect: expect.objectContaining({
          provider: "gmail",
          operation: "send_message",
          message: expect.objectContaining({
            to: "test@example.com",
            subject: "Hello",
            body: "Test email",
          }),
          request: expect.objectContaining({
            method: "POST",
            path: "/users/me/messages/send",
            sha256: expect.any(String),
          }),
        }),
      }),
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
      expect.objectContaining({
        action: "create_event",
        reviewedEffect: expect.objectContaining({
          provider: "google_calendar",
          operation: "create_event",
          event: expect.objectContaining({ summary: "Sync" }),
          request: expect.objectContaining({ method: "POST", sha256: expect.any(String) }),
        }),
      }),
    );
  });

  it("rechecks Gmail send authority at the HTTP boundary", async () => {
    const daemon = buildDaemon();
    let authority = "authority";
    daemon.getToolEffectAuthority.mockImplementation(async () => authority);
    vi.mocked(gmailRequest).mockImplementation(async (_settings, options) => {
      authority = "changed";
      await options.beforeSend?.();
      return { status: 200, data: {} };
    });
    const tools = new GmailTools(workspace, daemon as Any, taskId);

    await expect(
      tools.executeAction({
        action: "send_message",
        to: "test@example.com",
        subject: "Hello",
        body: "Test email",
      }),
    ).rejects.toThrow(/task authority changed before send/i);
  });

  it("shows and authorizes a new Gmail draft before writing it", async () => {
    const daemon = buildDaemon();
    vi.mocked(gmailRequest).mockImplementation(async (_settings, options) => {
      await options.beforeSend?.();
      return { status: 200, data: {} };
    });
    const tools = new GmailTools(workspace, daemon as Any, taskId);

    await tools.executeCodexStyleTool("gmail_create_draft", {
      to: "reader@example.com",
      subject: "Draft",
      body: "Review before sending",
    });

    expect(daemon.requestApproval).toHaveBeenCalledWith(
      taskId,
      "external_service",
      "Create a Gmail draft",
      expect.objectContaining({
        reviewedEffect: expect.objectContaining({
          provider: "gmail",
          operation: "create_draft",
          message: expect.objectContaining({
            to: "reader@example.com",
            subject: "Draft",
            body: "Review before sending",
          }),
        }),
      }),
    );
  });

  it("approves a missing Gmail label before creating it", async () => {
    const daemon = buildDaemon();
    const events: string[] = [];
    daemon.requestApproval.mockImplementation(async (_task, _type, _summary, details) => {
      events.push(`approval:${String((details as Any).action)}`);
      return true;
    });
    vi.mocked(gmailRequest).mockImplementation(async (_settings, options) => {
      events.push(`request:${options.method}:${options.path}`);
      await options.beforeSend?.();
      if (options.path === "/users/me/labels" && options.method === "GET") {
        return { status: 200, data: { labels: [] } };
      }
      if (options.path === "/users/me/labels" && options.method === "POST") {
        return { status: 200, data: { id: "label-work" } };
      }
      return { status: 200, data: {} };
    });
    const tools = new GmailTools(workspace, daemon as Any, taskId);

    await tools.executeCodexStyleTool("gmail_apply_labels_to_emails", {
      message_ids: ["message-1"],
      add_label_names: ["Work"],
      create_missing_labels: true,
    });

    expect(events.indexOf("approval:create_label")).toBeLessThan(
      events.indexOf("request:POST:/users/me/labels"),
    );
    expect(events).toContain("approval:apply_labels");
  });

  it("refuses to overwrite a Gmail draft whose reviewed revision changed", async () => {
    const daemon = buildDaemon();
    let draftRaw = "draft-revision-before-review";
    let submitted = false;
    daemon.requestApproval.mockImplementation(async () => {
      draftRaw = "draft-revision-after-review";
      return true;
    });
    vi.mocked(gmailRequest).mockImplementation(async (_settings, options) => {
      if (options.method === "GET" && options.query?.format === "full") {
        return {
          status: 200,
          data: {
            message: {
              id: "message-1",
              threadId: "thread-1",
              payload: {
                mimeType: "text/plain",
                headers: [
                  { name: "To", value: "reader@example.com" },
                  { name: "Subject", value: "Old subject" },
                ],
                body: { data: Buffer.from("Old body").toString("base64") },
              },
            },
          },
        };
      }
      if (options.method === "GET" && options.query?.format === "raw") {
        return { status: 200, data: { message: { raw: draftRaw } } };
      }
      if (options.method === "PUT") {
        await options.beforeSend?.();
        submitted = true;
      }
      return { status: 200, data: {} };
    });
    const tools = new GmailTools(workspace, daemon as Any, taskId);

    await expect(
      tools.executeCodexStyleTool("gmail_update_draft", {
        draft_id: "draft-1",
        body: "Updated body",
      }),
    ).rejects.toThrow(/draft changed after review/i);
    expect(submitted).toBe(false);
    expect(daemon.requestApproval).toHaveBeenCalledWith(
      taskId,
      "external_service",
      "Update a Gmail draft",
      expect.objectContaining({
        reviewedEffect: expect.objectContaining({
          provider: "gmail",
          sourceDraftRevisionSha256: expect.any(String),
          message: expect.objectContaining({ body: "Updated body" }),
        }),
      }),
    );
  });

  it("rechecks Google Calendar authority at the HTTP boundary", async () => {
    const daemon = buildDaemon();
    let authority = "authority";
    daemon.getToolEffectAuthority.mockImplementation(async () => authority);
    vi.mocked(googleCalendarRequest).mockImplementation(async (_settings, options) => {
      authority = "changed";
      await options.beforeSend?.();
      return { status: 200, data: {} };
    });
    const tools = new GoogleCalendarTools(workspace, daemon as Any, taskId);

    await expect(
      tools.executeAction({
        action: "create_event",
        summary: "Sync",
        start: "2026-02-05T10:00:00Z",
        end: "2026-02-05T10:30:00Z",
      }),
    ).rejects.toThrow(/task authority changed before send/i);
  });

  it("refuses to send a Gmail draft whose reviewed revision changed", async () => {
    const daemon = buildDaemon();
    let draftRaw = "draft-revision-before-review";
    let submitted = false;
    daemon.requestApproval.mockImplementation(async () => {
      draftRaw = "draft-revision-after-review";
      return true;
    });
    vi.mocked(gmailRequest).mockImplementation(async (_settings, options) => {
      if (options.method === "GET" && options.query?.format === "raw") {
        return { status: 200, data: { message: { raw: draftRaw } } };
      }
      if (options.method === "GET" && options.query?.format === "full") {
        return {
          status: 200,
          data: {
            id: "draft-1",
            message: {
              id: "message-1",
              threadId: "thread-1",
              payload: {
                mimeType: "text/plain",
                headers: [
                  { name: "To", value: "reader@example.com" },
                  { name: "Subject", value: "Reviewed draft" },
                ],
                body: { data: Buffer.from("Draft body").toString("base64") },
              },
            },
          },
        };
      }
      if (options.method === "POST") {
        await options.beforeSend?.();
        submitted = true;
      }
      return { status: 200, data: {} };
    });
    const tools = new GmailTools(workspace, daemon as Any, taskId);

    await expect(
      tools.executeCodexStyleTool("gmail_send_draft", { draft_id: "draft-1" }),
    ).rejects.toThrow(/draft changed after review/i);
    expect(submitted).toBe(false);
    expect(daemon.requestApproval).toHaveBeenCalledWith(
      taskId,
      "external_service",
      expect.any(String),
      expect.objectContaining({
        reviewedEffect: expect.objectContaining({
          provider: "gmail",
          draftRevisionSha256: expect.any(String),
          message: expect.objectContaining({ to: "reader@example.com", body: "Draft body" }),
        }),
      }),
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

  it("requests separate external-file approval before uploading an outside-workspace input", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-integration-approval-"));
    try {
      const workspacePath = path.join(root, "workspace");
      const inputPath = path.join(root, "input.txt");
      fs.mkdirSync(workspacePath, { recursive: true });
      fs.writeFileSync(inputPath, "external input", "utf8");
      const uploadWorkspace = { ...workspace, path: workspacePath };
      const daemon = buildDaemon(true, uploadWorkspace);
      const tools = new GoogleDriveTools(uploadWorkspace, daemon as Any, taskId);
      vi.mocked(googleDriveRequest).mockResolvedValueOnce({
        status: 200,
        data: { id: "file-1" },
      } as Any);

      await tools.executeAction({ action: "upload_file", file_path: inputPath });

      expect(daemon.requestApproval).toHaveBeenCalledWith(
        taskId,
        "external_file_access",
        expect.stringContaining("external Google Drive upload input"),
        expect.objectContaining({
          path: fs.realpathSync(inputPath),
          operation: "read",
          tool: "google_drive",
        }),
        expect.objectContaining({ allowAutoApprove: true }),
      );
      expect(daemon.requestApproval).toHaveBeenCalledWith(
        taskId,
        "external_service",
        expect.any(String),
        expect.objectContaining({ action: "upload_file" }),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
