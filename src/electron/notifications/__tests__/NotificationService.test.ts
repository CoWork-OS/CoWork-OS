import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppNotification } from "../../../shared/types";
import { NotificationService, type NotificationEvent } from "../service";

describe("NotificationService", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-notifications-"));
    storePath = path.join(tmpDir, "notifications.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not add the same unresolved input-required notification more than once per task", async () => {
    const events: NotificationEvent[] = [];
    const service = new NotificationService({
      storePath,
      onEvent: (event) => events.push(event),
    });

    const first = await service.add({
      type: "input_required",
      title: "Quick check-in",
      message: "Ready when you are.",
      taskId: "task-1",
    });
    const second = await service.add({
      type: "input_required",
      title: "Quick check-in",
      message: "Ready when you are.",
      taskId: "task-1",
    });

    expect(second.id).toBe(first.id);
    expect(service.list()).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("added");
  });

  it("does not add the same unresolved integration reconnect notification more than once", async () => {
    const events: NotificationEvent[] = [];
    const service = new NotificationService({
      storePath,
      onEvent: (event) => events.push(event),
    });

    const params = {
      type: "warning" as const,
      title: "Reconnect Google Workspace",
      message:
        "Google Workspace needs attention in Settings > Integrations > Google Workspace. Reconnect or resync it before automated work can continue.",
    };
    const first = await service.add(params);
    const second = await service.add({
      ...params,
      message:
        "Google Workspace needs attention in Settings > Integrations > Google Workspace. Reconnect or resync it before automated work can continue. Token has been expired or revoked.",
    });

    expect(second.id).toBe(first.id);
    expect(service.list()).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("added");
  });

  it("collapses stored duplicate input-required notifications for the same task on startup", () => {
    const notifications: AppNotification[] = [
      {
        id: "older-input",
        type: "input_required",
        title: "Quick check-in",
        message: "Older prompt",
        read: false,
        createdAt: 100,
        taskId: "task-1",
      },
      {
        id: "newer-input",
        type: "input_required",
        title: "Quick check-in",
        message: "Newer prompt",
        read: false,
        createdAt: 200,
        taskId: "task-1",
      },
      {
        id: "warning-1",
        type: "warning",
        title: "Heads up",
        message: "Different notification types are preserved.",
        read: false,
        createdAt: 300,
      },
    ];
    fs.writeFileSync(storePath, JSON.stringify({ version: 1, notifications }, null, 2), "utf-8");

    const service = new NotificationService({ storePath });

    expect(service.list().map((notification) => notification.id)).toEqual([
      "warning-1",
      "newer-input",
    ]);

    const persisted = JSON.parse(fs.readFileSync(storePath, "utf-8")) as {
      notifications: AppNotification[];
    };
    expect(persisted.notifications.map((notification) => notification.id)).toEqual([
      "newer-input",
      "warning-1",
    ]);
  });

  it("collapses stored duplicate integration reconnect notifications on startup", () => {
    const notifications: AppNotification[] = [
      {
        id: "older-google-workspace-auth",
        type: "warning",
        title: "Reconnect Google Workspace",
        message:
          "Google Workspace needs attention in Settings > Integrations > Google Workspace. Reconnect or resync it before automated work can continue.",
        read: false,
        createdAt: 100,
      },
      {
        id: "newer-google-workspace-auth",
        type: "warning",
        title: "Reconnect Google Workspace",
        message:
          "Google Workspace needs attention in Settings > Integrations > Google Workspace. Reconnect or resync it before automated work can continue. Token has been expired or revoked.",
        read: false,
        createdAt: 200,
      },
      {
        id: "whatsapp-auth",
        type: "warning",
        title: "Reconnect WhatsApp",
        message:
          "WhatsApp needs attention in Settings > WhatsApp. Reconnect or resync it before automated work can continue.",
        read: false,
        createdAt: 300,
      },
    ];
    fs.writeFileSync(storePath, JSON.stringify({ version: 1, notifications }, null, 2), "utf-8");

    const service = new NotificationService({ storePath });

    expect(service.list().map((notification) => notification.id)).toEqual([
      "whatsapp-auth",
      "newer-google-workspace-auth",
    ]);

    const persisted = JSON.parse(fs.readFileSync(storePath, "utf-8")) as {
      notifications: AppNotification[];
    };
    expect(persisted.notifications.map((notification) => notification.id)).toEqual([
      "newer-google-workspace-auth",
      "whatsapp-auth",
    ]);
  });
});
