import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import { GoogleWorkspaceSettingsManager } from "../../settings/google-workspace-manager";
import { googleCalendarRequest } from "../../utils/google-calendar-api";

type CalendarAction =
  | "list_calendars"
  | "list_events"
  | "get_event"
  | "create_event"
  | "update_event"
  | "delete_event";

interface GoogleCalendarActionInput {
  action: CalendarAction;
  calendar_id?: string;
  event_id?: string;
  query?: string;
  time_min?: string;
  time_max?: string;
  max_results?: number;
  page_token?: string;
  single_events?: boolean;
  order_by?: "startTime" | "updated";
  summary?: string;
  description?: string;
  location?: string;
  start?: string | { dateTime?: string; date?: string; timeZone?: string };
  end?: string | { dateTime?: string; date?: string; timeZone?: string };
  attendees?: Array<string | { email: string }>;
  time_zone?: string;
  payload?: Record<string, Any>;
}

function buildAttendees(
  attendees?: Array<string | { email: string }>,
): Array<{ email: string }> | undefined {
  if (!attendees || attendees.length === 0) return undefined;
  return attendees
    .map((attendee) => {
      if (typeof attendee === "string") {
        return { email: attendee };
      }
      return { email: attendee.email };
    })
    .filter((attendee) => attendee.email);
}

function buildEventPayload(input: GoogleCalendarActionInput): Record<string, Any> {
  if (input.payload) {
    return input.payload;
  }

  if (!input.summary || !input.start || !input.end) {
    throw new Error("Missing summary/start/end for calendar event");
  }

  const event: Record<string, Any> = {
    summary: input.summary,
  };

  if (input.description) event.description = input.description;
  if (input.location) event.location = input.location;

  const timeZone = input.time_zone;

  const buildDateField = (
    value: string | { dateTime?: string; date?: string; timeZone?: string },
  ) => {
    if (typeof value === "string") {
      return {
        dateTime: value,
        timeZone,
      };
    }
    return {
      ...value,
      timeZone: value.timeZone || timeZone,
    };
  };

  event.start = buildDateField(input.start);
  event.end = buildDateField(input.end);

  const attendees = buildAttendees(input.attendees);
  if (attendees) {
    event.attendees = attendees;
  }

  return event;
}

export class GoogleCalendarTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {}

  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  static isEnabled(): boolean {
    return GoogleWorkspaceSettingsManager.loadSettings().enabled;
  }

  private formatAuthError(error: unknown): string | null {
    const message = String((error as Any)?.message ?? "");
    const status = (error as Any)?.status;
    if (status === 401) {
      return "Google Workspace authorization failed (401). Reconnect in Settings > Integrations > Google Workspace.";
    }
    if (
      /token refresh failed|refresh token not configured|access token not configured|access token expired/i.test(
        message,
      )
    ) {
      return `Google Workspace authorization error: ${message}`;
    }
    return null;
  }

  private async requireApproval(summary: string, details: Record<string, unknown>): Promise<void> {
    const approved = await this.daemon.requestApproval(
      this.taskId,
      "external_service",
      summary,
      details,
    );

    if (!approved) {
      throw new Error("User denied Google Calendar action");
    }
  }

  async executeAction(input: GoogleCalendarActionInput): Promise<Any> {
    const settings = GoogleWorkspaceSettingsManager.loadSettings();
    if (!settings.enabled) {
      throw new Error(
        "Google Workspace integration is disabled. Enable it in Settings > Integrations > Google Workspace.",
      );
    }

    const action = input.action;
    if (!action) {
      throw new Error('Missing required "action" parameter');
    }

    const calendarId = input.calendar_id || "primary";
    let result;

    try {
      switch (action) {
        case "list_calendars": {
          result = await googleCalendarRequest(settings, {
            method: "GET",
            path: "/users/me/calendarList",
            query: {
              maxResults: input.max_results,
              pageToken: input.page_token,
            },
          });
          break;
        }
        case "list_events": {
          result = await googleCalendarRequest(settings, {
            method: "GET",
            path: `/calendars/${encodeURIComponent(calendarId)}/events`,
            query: {
              q: input.query,
              timeMin: input.time_min,
              timeMax: input.time_max,
              maxResults: input.max_results,
              pageToken: input.page_token,
              singleEvents: input.single_events ?? true,
              orderBy: input.order_by,
            },
          });
          break;
        }
        case "get_event": {
          if (!input.event_id) throw new Error("Missing event_id for get_event");
          result = await googleCalendarRequest(settings, {
            method: "GET",
            path: `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(input.event_id)}`,
          });
          break;
        }
        case "create_event": {
          const eventPayload = buildEventPayload(input);
          await this.requireApproval("Create a Google Calendar event", {
            action: "create_event",
            calendar_id: calendarId,
            summary: eventPayload.summary,
          });
          result = await googleCalendarRequest(settings, {
            method: "POST",
            path: `/calendars/${encodeURIComponent(calendarId)}/events`,
            body: eventPayload,
          });
          break;
        }
        case "update_event": {
          if (!input.event_id) throw new Error("Missing event_id for update_event");
          const updatePayload = buildEventPayload(input);
          await this.requireApproval("Update a Google Calendar event", {
            action: "update_event",
            calendar_id: calendarId,
            event_id: input.event_id,
            summary: updatePayload.summary,
          });
          result = await googleCalendarRequest(settings, {
            method: "PATCH",
            path: `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(input.event_id)}`,
            body: updatePayload,
          });
          break;
        }
        case "delete_event": {
          if (!input.event_id) throw new Error("Missing event_id for delete_event");
          await this.requireApproval("Delete a Google Calendar event", {
            action: "delete_event",
            calendar_id: calendarId,
            event_id: input.event_id,
          });
          result = await googleCalendarRequest(settings, {
            method: "DELETE",
            path: `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(input.event_id)}`,
          });
          break;
        }
        default:
          throw new Error(`Unsupported action: ${action}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const authMessage = this.formatAuthError(error);
      const finalMessage = authMessage ?? message;
      this.daemon.logEvent(this.taskId, "tool_error", {
        tool: "calendar_action",
        action,
        message: finalMessage,
        status: (error as Any)?.status,
      });
      if (authMessage) {
        throw new Error(authMessage);
      }
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(message);
    }

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "calendar_action",
      action,
      status: result?.status,
      hasData: result?.data ? true : false,
    });

    return {
      success: true,
      action,
      status: result?.status,
      data: result?.data,
      raw: result?.raw,
    };
  }
}
