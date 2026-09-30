import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NotificationService } from "../../../electron/notifications/service";
import type { Workspace } from "../../../shared/types";
import type { WebRequestContext } from "../../web/WebApplication";
import { createBrowserNotificationDefinitions } from "../browser-notification-methods";

describe("browser notification methods", () => {
  let tempDirectory: string;
  let service: NotificationService;

  afterEach(async () => {
    if (tempDirectory) await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  async function setup() {
    tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-browser-notifications-"));
    service = new NotificationService({
      storePath: path.join(tempDirectory, "notifications.json"),
    });
    const workspace = (id: string, readable: boolean, writable: boolean) =>
      ({
        id,
        permissions: { read: readable, write: writable },
      }) as Workspace;
    const methods = createBrowserNotificationDefinitions({
      service,
      resolveWorkspace: async (id) => {
        if (id === "workspace-readable") return workspace(id, true, true);
        if (id === "workspace-readonly") return workspace(id, true, false);
        return null;
      },
      getTask: async (id) =>
        id === "task-readable" ? ({ id, workspaceId: "workspace-readable" } as never) : null,
    });
    const context = {
      sessionId: "browser-session",
      identity: { profileId: "profile-one" },
    } as WebRequestContext;
    const call = async (name: string, args: unknown[] = []) => {
      const definition = methods[name];
      const validated = definition.validate ? definition.validate(args) : args;
      return definition.handler(validated, context);
    };
    return { methods, call };
  }

  it("provides read, mark-read, delete, and add actions for authorized notifications", async () => {
    const { methods, call } = await setup();
    expect(methods.listNotifications.capability).toBe("notifications.read");
    expect(methods.markNotificationRead.mutation).toBe(true);

    const first = await service.add({
      type: "info",
      title: "Visible notification",
      message: "This belongs to a readable workspace.",
      workspaceId: "workspace-readable",
    });
    const userNotice = await call("addNotification", [
      { type: "warning", title: "Check setup", message: "A provider needs attention." },
    ]);

    expect(await call("listNotifications")).toEqual([userNotice, first]);
    expect(await call("getUnreadNotificationCount")).toBe(2);
    expect(await call("markNotificationRead", [first.id])).toMatchObject({ read: true });
    await call("markAllNotificationsRead");
    expect(await call("getUnreadNotificationCount")).toBe(0);
    expect(await call("deleteNotification", [first.id])).toBe(true);
    await call("deleteAllNotifications");
    expect(await call("listNotifications")).toEqual([]);
  });

  it("allows notification actions in readable workspaces and hides inaccessible workspaces", async () => {
    const { call } = await setup();
    const hidden = await service.add({
      type: "info",
      title: "Private notice",
      message: "Must stay scoped.",
      workspaceId: "workspace-missing",
    });
    const readOnly = await service.add({
      type: "info",
      title: "Read only notice",
      message: "Visible but not writable.",
      workspaceId: "workspace-readonly",
    });
    const taskScoped = await service.add({
      type: "task_completed",
      title: "Task complete",
      message: "Task-level access is checked through its workspace.",
      taskId: "task-readable",
    });

    const visible = (await call("listNotifications")) as Array<{ id: string }>;
    expect(visible.map((notification) => notification.id)).toEqual([taskScoped.id, readOnly.id]);
    expect(visible.map((notification) => notification.id)).not.toContain(hidden.id);
    await expect(call("markNotificationRead", [hidden.id])).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await call("markNotificationRead", [readOnly.id])).toMatchObject({ read: true });
    expect(await call("deleteNotification", [readOnly.id])).toBe(true);
    const added = await call("addNotification", [
      {
        type: "info",
        title: "Visible in read-only workspace",
        message: "Notifications are profile data.",
        workspaceId: "workspace-readonly",
      },
    ]);
    expect(added).toMatchObject({ workspaceId: "workspace-readonly" });
    await expect(
      call("addNotification", [
        {
          type: "info",
          title: "Blocked",
          message: "This workspace is not available to the browser session.",
          workspaceId: "workspace-missing",
        },
      ]),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects malformed notification payloads", async () => {
    const { methods } = await setup();
    expect(() =>
      methods.addNotification.validate?.([
        { type: "unknown", title: "x", message: "y", arbitraryHostPath: "/tmp" },
      ]),
    ).toThrow();
    expect(() => methods.deleteNotification.validate?.(["../outside"])).toThrow();
  });
});
