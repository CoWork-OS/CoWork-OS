import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function jsonResponse(data: Any, status = 200): Any {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    json: vi.fn().mockResolvedValue(data),
    text: vi.fn().mockResolvedValue(JSON.stringify(data)),
  };
}

async function loadConnector(scopeText?: string) {
  vi.resetModules();
  process.env.GOOGLE_ACCESS_TOKEN = "test-token";
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_REFRESH_TOKEN;
  if (scopeText === undefined) {
    delete process.env.GOOGLE_SCOPES;
  } else {
    process.env.GOOGLE_SCOPES = scopeText;
  }
  return import("../../../../connectors/google-workspace-mcp/src/index");
}

describe("google-workspace MCP Workspace tools", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GOOGLE_ACCESS_TOKEN;
    delete process.env.GOOGLE_SCOPES;
  });

  it("sends a Tasks PATCH with null due when clearDue is requested", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(jsonResponse({ id: "task-1", due: null }) as Response);
    const { executeGoogleWorkspaceToolForTest } = await loadConnector();

    await executeGoogleWorkspaceToolForTest("google-workspace.tasks_update", {
      tasklistId: "list-1",
      taskId: "task-1",
      clearDue: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://tasks.googleapis.com/tasks/v1/lists/list-1/tasks/task-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ due: null }),
      }),
    );
  });

  it("exposes confirmation schema on delete without adding it to task completion", async () => {
    const { listGoogleWorkspaceToolsForTest } = await loadConnector();
    const tools = listGoogleWorkspaceToolsForTest();
    const completeSchema = tools.find((tool: Any) => tool.name === "google-workspace.tasks_complete")
      ?.inputSchema;
    const deleteSchema = tools.find((tool: Any) => tool.name === "google-workspace.tasks_delete")
      ?.inputSchema;

    expect(completeSchema?.required).toEqual(["tasklistId", "taskId"]);
    expect(deleteSchema?.required).toContain("confirm");
    expect(deleteSchema?.properties?.confirm).toBeTruthy();
    expect(deleteSchema?.properties?.deleteAssignedTaskEverywhere).toBeTruthy();
  });

  it("blocks assigned task deletion unless cross-surface deletion is explicitly acknowledged", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: "task-1", assignmentInfo: { surfaceType: "DOCUMENT" } }) as Response,
    );
    const { executeGoogleWorkspaceToolForTest } = await loadConnector();

    await expect(
      executeGoogleWorkspaceToolForTest("google-workspace.tasks_delete", {
        tasklistId: "list-1",
        taskId: "task-1",
        confirm: true,
      }),
    ).rejects.toThrow(/assigned task/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requires explicit confirmation for raw Slides batch updates", async () => {
    const fetchMock = vi.mocked(fetch);
    const { executeGoogleWorkspaceToolForTest } = await loadConnector();

    await expect(
      executeGoogleWorkspaceToolForTest("google-workspace.slides_batch_update", {
        presentationId: "deck-1",
        requests: [{ deleteObject: { objectId: "slide-1" } }],
      }),
    ).rejects.toThrow(/Confirmation required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports missing scopes from connector health when GOOGLE_SCOPES is incomplete", async () => {
    const fetchMock = vi.mocked(fetch);
    const { executeGoogleWorkspaceToolForTest } = await loadConnector(
      "https://www.googleapis.com/auth/drive",
    );

    const result = await executeGoogleWorkspaceToolForTest("google-workspace.health", {});

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.data.status).toBe("missing_scopes");
    expect(result.data.missingScopes).toContain("https://www.googleapis.com/auth/tasks");
    expect(result.data.missingScopes).toContain("https://www.googleapis.com/auth/presentations");
  });

  it("exposes Google Calendar MCP tools", async () => {
    const { listGoogleWorkspaceToolsForTest } = await loadConnector();
    const tools = listGoogleWorkspaceToolsForTest();
    const toolNames = tools.map((tool: Any) => tool.name);
    const createSchema = tools.find((tool: Any) => tool.name === "google-workspace.calendar_event_create")
      ?.inputSchema;

    expect(toolNames).toEqual(
      expect.arrayContaining([
        "google-workspace.calendar_calendars_list",
        "google-workspace.calendar_events_list",
        "google-workspace.calendar_event_get",
        "google-workspace.calendar_events_batch_get",
        "google-workspace.calendar_availability_get",
        "google-workspace.calendar_event_create",
        "google-workspace.calendar_event_update",
        "google-workspace.calendar_event_delete",
      ]),
    );
    expect(createSchema?.properties?.attendeeEmails?.items).toEqual({ type: "string" });
    expect(createSchema?.properties?.attendees?.items?.properties?.email).toBeTruthy();
    expect(createSchema?.properties?.conferenceData).toBeTruthy();
  });

  it("looks up Google Calendar availability with freeBusy", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(jsonResponse({ calendars: { primary: { busy: [] } } }) as Response);
    const { executeGoogleWorkspaceToolForTest } = await loadConnector();

    await executeGoogleWorkspaceToolForTest("google-workspace.calendar_availability_get", {
      calendarIds: ["primary", "room@example.com"],
      timeMin: "2026-06-12T09:00:00Z",
      timeMax: "2026-06-12T10:00:00Z",
      timeZone: "Europe/Lisbon",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.googleapis.com/calendar/v3/freeBusy",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          timeMin: "2026-06-12T09:00:00Z",
          timeMax: "2026-06-12T10:00:00Z",
          items: [{ id: "primary" }, { id: "room@example.com" }],
          timeZone: "Europe/Lisbon",
        }),
      }),
    );
  });

  it("rejects invalid Google Calendar availability windows before calling Google", async () => {
    const fetchMock = vi.mocked(fetch);
    const { executeGoogleWorkspaceToolForTest } = await loadConnector();

    await expect(
      executeGoogleWorkspaceToolForTest("google-workspace.calendar_availability_get", {
        calendarIds: ["primary"],
        timeMin: "2026-06-12T10:00:00",
        timeMax: "2026-06-12T11:00:00Z",
      }),
    ).rejects.toThrow(/RFC3339/);
    await expect(
      executeGoogleWorkspaceToolForTest("google-workspace.calendar_availability_get", {
        calendarIds: ["primary"],
        timeMin: "2026-06-12T11:00:00Z",
        timeMax: "2026-06-12T10:00:00Z",
      }),
    ).rejects.toThrow(/timeMin must be before timeMax/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns per-event errors for partial Calendar batch read failures", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: "event-1" }) as Response)
      .mockResolvedValueOnce(jsonResponse({ error: { message: "Not found" } }, 404) as Response);
    const { executeGoogleWorkspaceToolForTest } = await loadConnector();

    const result = await executeGoogleWorkspaceToolForTest("google-workspace.calendar_events_batch_get", {
      eventIds: ["event-1", "missing-event"],
    });

    expect(result.data.events).toEqual([
      { eventId: "event-1", data: { id: "event-1" } },
      { eventId: "missing-event", error: expect.stringContaining("Google API 404") },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("limits Calendar batch reads before calling Google", async () => {
    const fetchMock = vi.mocked(fetch);
    const { executeGoogleWorkspaceToolForTest } = await loadConnector();

    await expect(
      executeGoogleWorkspaceToolForTest("google-workspace.calendar_events_batch_get", {
        eventIds: Array.from({ length: 51 }, (_, index) => `event-${index}`),
      }),
    ).rejects.toThrow(/at most 50/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("defaults Calendar event listing to the primary calendar", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(jsonResponse({ items: [] }) as Response);
    const { executeGoogleWorkspaceToolForTest } = await loadConnector();

    await executeGoogleWorkspaceToolForTest("google-workspace.calendar_events_list", {
      maxResults: 10,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=10&singleEvents=true",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("requires explicit confirmation for Calendar writes", async () => {
    const fetchMock = vi.mocked(fetch);
    const { executeGoogleWorkspaceToolForTest } = await loadConnector();

    await expect(
      executeGoogleWorkspaceToolForTest("google-workspace.calendar_event_create", {
        summary: "Planning",
        start: { dateTime: "2026-06-12T09:00:00Z" },
        end: { dateTime: "2026-06-12T10:00:00Z" },
      }),
    ).rejects.toThrow(/Confirmation required/);
    await expect(
      executeGoogleWorkspaceToolForTest("google-workspace.calendar_event_update", {
        eventId: "event-1",
        summary: "Updated",
      }),
    ).rejects.toThrow(/Confirmation required/);
    await expect(
      executeGoogleWorkspaceToolForTest("google-workspace.calendar_event_delete", {
        eventId: "event-1",
      }),
    ).rejects.toThrow(/Confirmation required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates confirmed Google Calendar events with event fields and query options", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(jsonResponse({ id: "event-1" }) as Response);
    const { executeGoogleWorkspaceToolForTest } = await loadConnector();

    await executeGoogleWorkspaceToolForTest("google-workspace.calendar_event_create", {
      calendarId: "team@example.com",
      summary: "Planning",
      start: { dateTime: "2026-06-12T09:00:00Z" },
      end: { dateTime: "2026-06-12T10:00:00Z" },
      attendeeEmails: ["person@example.com"],
      conferenceData: {
        createRequest: {
          requestId: "meet-1",
        },
      },
      conferenceDataVersion: 1,
      sendUpdates: "all",
      confirm: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.googleapis.com/calendar/v3/calendars/team%40example.com/events?sendUpdates=all&conferenceDataVersion=1",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          summary: "Planning",
          start: { dateTime: "2026-06-12T09:00:00Z" },
          end: { dateTime: "2026-06-12T10:00:00Z" },
          attendees: [{ email: "person@example.com" }],
          conferenceData: {
            createRequest: {
              requestId: "meet-1",
            },
          },
        }),
      }),
    );
  });
});
