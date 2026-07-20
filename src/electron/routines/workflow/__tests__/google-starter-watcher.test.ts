import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  gmail: vi.fn(),
  drive: vi.fn(),
  calendar: vi.fn(),
}));

vi.mock("../../../settings/google-workspace-manager", () => ({
  GoogleWorkspaceSettingsManager: {
    loadSettings: () => ({ enabled: true, accessToken: "token", accounts: [] }),
  },
}));
vi.mock("../../../utils/gmail-api", () => ({ gmailRequest: api.gmail }));
vi.mock("../../../utils/google-workspace-api", () => ({ googleDriveRequest: api.drive }));
vi.mock("../../../utils/google-calendar-api", () => ({ googleCalendarRequest: api.calendar }));

import { GoogleWorkspaceWorkflowStarterWatcher } from "../google-starter-watcher";

describe("GoogleWorkspaceWorkflowStarterWatcher", () => {
  beforeEach(() => {
    api.gmail.mockReset();
    api.drive.mockReset();
    api.calendar.mockReset();
  });

  it("polls the active version and drains all Gmail result pages", async () => {
    const db = createCursorDb();
    const events: Any[] = [];
    const routine = {
      id: "routine-1",
      name: "Inbox flow",
      enabled: true,
      activeWorkflowVersionId: "version-active",
      workflow: gmailWorkflow("draft-query"),
    } as Any;
    const activeWorkflow = gmailWorkflow("active-query");
    const service = {
      list: () => [routine],
      getActiveWorkflowDefinition: () => activeWorkflow,
      enqueueWorkflowEvent: (event: Any) => events.push(event),
    } as Any;
    api.gmail.mockImplementation(async (_settings: Any, request: Any) => {
      if (request.path === "/users/me/messages") {
        return request.query.pageToken
          ? { data: { messages: [{ id: "message-2" }] } }
          : { data: { messages: [{ id: "message-1" }], nextPageToken: "page-2" } };
      }
      const id = request.path.includes("message-2") ? "message-2" : "message-1";
      return {
        data: {
          id,
          threadId: `thread-${id}`,
          internalDate: "200",
          payload: { headers: [{ name: "Subject", value: id }] },
        },
      };
    });
    const watcher = new GoogleWorkspaceWorkflowStarterWatcher(db as Any, service, 60_000);

    await watcher.poll();
    await watcher.poll();

    const listCalls = api.gmail.mock.calls.filter((call) => call[1].path === "/users/me/messages");
    expect(listCalls).toHaveLength(2);
    expect(listCalls[0][1].query.q).toContain("active-query");
    expect(listCalls[0][1].query.q).not.toContain("draft-query");
    expect(events.map((event) => event.idempotencyKey).sort()).toEqual([
      "gmail:message-1",
      "gmail:message-2",
    ]);
  });

  it("persists the Drive continuation token when a poll reaches its page cap", async () => {
    const db = createCursorDb();
    const routine = {
      id: "routine-drive",
      name: "Drive flow",
      enabled: true,
      activeWorkflowVersionId: "version-active",
      workflow: driveWorkflow(),
    } as Any;
    const service = {
      list: () => [routine],
      getActiveWorkflowDefinition: () => driveWorkflow(),
      enqueueWorkflowEvent: vi.fn(),
    } as Any;
    api.drive.mockImplementation(async (_settings: Any, request: Any) => {
      if (request.path === "/changes/startPageToken") return { data: { startPageToken: "page-0" } };
      const current = Number(String(request.query.pageToken).replace("page-", ""));
      return { data: { changes: [], nextPageToken: `page-${current + 1}` } };
    });
    const watcher = new GoogleWorkspaceWorkflowStarterWatcher(db as Any, service, 60_000);

    await watcher.poll();
    await watcher.poll();

    expect(db.read("routine-drive", "starter").drivePageToken).toBe("page-10");
  });
});

function gmailWorkflow(query: string) {
  return {
    version: 1,
    starterNodeId: "starter",
    nodes: [
      {
        id: "starter",
        kind: "starter",
        operation: "starter.gmail_message",
        name: "Gmail",
        config: { query },
      },
    ],
    edges: [],
  } as Any;
}

function driveWorkflow() {
  return {
    version: 1,
    starterNodeId: "starter",
    nodes: [
      {
        id: "starter",
        kind: "starter",
        operation: "starter.drive_item_added",
        name: "Drive",
        config: { folderId: "folder-1" },
      },
    ],
    edges: [],
  } as Any;
}

function createCursorDb() {
  const cursors = new Map<string, string>();
  const key = (routineId: string, starterId: string) => `${routineId}:${starterId}`;
  return {
    exec: vi.fn(),
    prepare: (sql: string) => ({
      get: (routineId: string, starterId: string) => {
        if (!sql.includes("SELECT cursor_json")) return undefined;
        const cursor = cursors.get(key(routineId, starterId));
        return cursor ? { cursor_json: cursor } : undefined;
      },
      run: (routineId: string, starterId: string, cursorJson: string) => {
        if (sql.includes("INSERT OR REPLACE")) {
          cursors.set(key(routineId, starterId), cursorJson);
        }
        return { changes: 1 };
      },
    }),
    read: (routineId: string, starterId: string) =>
      JSON.parse(cursors.get(key(routineId, starterId)) || "{}"),
  };
}
