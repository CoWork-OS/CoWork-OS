import { execFile } from "child_process";
import { promisify } from "util";
import * as os from "os";
import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";

const execFileAsync = promisify(execFile);

const APPLESCRIPT_TIMEOUT_MS = 30 * 1000; // 30 seconds
const MAX_BUFFER = 1024 * 1024; // 1MB

type CalendarAction =
  | "list_calendars"
  | "list_events"
  | "get_event"
  | "create_event"
  | "update_event"
  | "delete_event";

interface AppleCalendarActionInput {
  action: CalendarAction;
  calendar_id?: string;
  event_id?: string;
  query?: string;
  time_min?: string;
  time_max?: string;
  max_results?: number;
  summary?: string;
  description?: string;
  location?: string;
  start?: string;
  end?: string;
}

type ParsedCalendar = {
  calendar_id: string;
  name: string;
  writable: boolean;
};

type ParsedEvent = {
  event_id: string;
  calendar_id: string;
  calendar_name: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: string;
  end?: string;
  all_day?: boolean;
};

const RS = "\x1e"; // record separator
const US = "\x1f"; // unit separator

function parseEpochSeconds(iso?: string): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid ISO datetime: ${iso}`);
  }
  return Math.floor(ms / 1000);
}

function epochToIso(epochSeconds: string | number | undefined): string | undefined {
  if (epochSeconds === undefined) return undefined;
  const n = typeof epochSeconds === "string" ? Number(epochSeconds) : epochSeconds;
  if (!Number.isFinite(n)) return undefined;
  return new Date(n * 1000).toISOString();
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function splitRecords(output: string): string[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  return trimmed.split(RS).filter(Boolean);
}

function splitFields(record: string): string[] {
  return record.split(US);
}

const APPLESCRIPT = `
property US : ASCII character 31
property RS : ASCII character 30

on epochUtcDate()
  set epochBase to date "1/1/1970"
  return epochBase - (time to GMT)
end epochUtcDate

on joinWithRS(theList)
  if theList is {} then return ""
  set AppleScript's text item delimiters to RS
  set outText to theList as string
  set AppleScript's text item delimiters to ""
  return outText
end joinWithRS

on resolveCalendar(calId)
  tell application "Calendar"
    if calId is "" then
      repeat with c in calendars
        try
          if writable of c is true then return c
        end try
      end repeat
      return calendar 1
    end if

    try
      return first calendar whose calendarIdentifier is calId
    on error
      try
        return first calendar whose name is calId
      on error
        error "Calendar not found: " & calId
      end try
    end try
  end tell
end resolveCalendar

on run argv
  set action to ""
  if (count of argv) >= 1 then set action to item 1 of argv

  if action is "list_calendars" then
    -- NOTE: Do NOT name this list "records" inside a tell block. Some apps (including Calendar)
    -- may resolve "records" as a class reference ("every record"), causing -10006 errors.
    set outRows to {}
    tell application "Calendar"
      repeat with c in calendars
        set rec to (calendarIdentifier of c) & US & (name of c) & US & ((writable of c) as string)
        set end of outRows to rec
      end repeat
    end tell
    return my joinWithRS(outRows)
  end if

  if action is "list_events" then
    set calId to ""
    set minEpoch to ""
    set maxEpoch to ""
    if (count of argv) >= 2 then set calId to item 2 of argv
    if (count of argv) >= 3 then set minEpoch to item 3 of argv
    if (count of argv) >= 4 then set maxEpoch to item 4 of argv

    if minEpoch is "" then error "Missing time_min"
    if maxEpoch is "" then error "Missing time_max"

    set epochUtc to my epochUtcDate()
    set minDate to epochUtc + (minEpoch as number)
    set maxDate to epochUtc + (maxEpoch as number)

    -- Collect results outside the tell block to avoid AppleScript resolving a variable name
    -- as an application object (e.g., "records" -> "every record").
    set outRows to {}
    tell application "Calendar"
      set calList to {}
      if calId is "" then
        set calList to calendars
      else
        set calList to {my resolveCalendar(calId)}
      end if

      repeat with c in calList
        set evs to (every event of c whose start date >= minDate and start date <= maxDate)
        repeat with e in evs
          set evSummary to ""
          try
            set evSummary to summary of e
          end try
          set evLoc to ""
          try
            set evLoc to location of e
          end try
          set evDesc to ""
          try
            set evDesc to description of e
          end try
          set evAllDay to "false"
          try
            set evAllDay to (allday event of e) as string
          end try
          set evStartSec to ((start date of e) - epochUtc) as string
          set evEndSec to ((end date of e) - epochUtc) as string

          set rec to (uid of e) & US & (calendarIdentifier of c) & US & (name of c) & US & evSummary & US & evStartSec & US & evEndSec & US & evLoc & US & evDesc & US & evAllDay
          set end of outRows to rec
        end repeat
      end repeat
    end tell
    return my joinWithRS(outRows)
  end if

  if action is "get_event" then
    set calId to ""
    set evId to ""
    if (count of argv) >= 2 then set calId to item 2 of argv
    if (count of argv) >= 3 then set evId to item 3 of argv
    if evId is "" then error "Missing event_id"

    set epochUtc to my epochUtcDate()
    tell application "Calendar"
      set calList to {}
      if calId is "" then
        set calList to calendars
      else
        set calList to {my resolveCalendar(calId)}
      end if

      repeat with c in calList
        try
          set e to first event of c whose uid is evId
          set evSummary to ""
          try
            set evSummary to summary of e
          end try
          set evLoc to ""
          try
            set evLoc to location of e
          end try
          set evDesc to ""
          try
            set evDesc to description of e
          end try
          set evAllDay to "false"
          try
            set evAllDay to (allday event of e) as string
          end try
          set evStartSec to ((start date of e) - epochUtc) as string
          set evEndSec to ((end date of e) - epochUtc) as string
          return (uid of e) & US & (calendarIdentifier of c) & US & (name of c) & US & evSummary & US & evStartSec & US & evEndSec & US & evLoc & US & evDesc & US & evAllDay
        end try
      end repeat
    end tell
    error "Event not found: " & evId
  end if

  if action is "create_event" then
    set calId to ""
    set evSummary to ""
    set startEpoch to ""
    set endEpoch to ""
    set evLoc to ""
    set evDesc to ""
    if (count of argv) >= 2 then set calId to item 2 of argv
    if (count of argv) >= 3 then set evSummary to item 3 of argv
    if (count of argv) >= 4 then set startEpoch to item 4 of argv
    if (count of argv) >= 5 then set endEpoch to item 5 of argv
    if (count of argv) >= 6 then set evLoc to item 6 of argv
    if (count of argv) >= 7 then set evDesc to item 7 of argv

    if evSummary is "" then error "Missing summary"
    if startEpoch is "" then error "Missing start"
    if endEpoch is "" then error "Missing end"

    set epochUtc to my epochUtcDate()
    set startDate to epochUtc + (startEpoch as number)
    set endDate to epochUtc + (endEpoch as number)

    tell application "Calendar"
      set c to my resolveCalendar(calId)
      tell c
        set props to {summary:evSummary, start date:startDate, end date:endDate}
        if evLoc is not "" then set props to props & {location:evLoc}
        if evDesc is not "" then set props to props & {description:evDesc}
        set e to make new event at end of events with properties props
        return (uid of e) & US & (calendarIdentifier of c) & US & (name of c)
      end tell
    end tell
  end if

  if action is "update_event" then
    set calId to ""
    set evId to ""
    set newSummary to ""
    set newStartEpoch to ""
    set newEndEpoch to ""
    set newLoc to ""
    set newDesc to ""
    if (count of argv) >= 2 then set calId to item 2 of argv
    if (count of argv) >= 3 then set evId to item 3 of argv
    if (count of argv) >= 4 then set newSummary to item 4 of argv
    if (count of argv) >= 5 then set newStartEpoch to item 5 of argv
    if (count of argv) >= 6 then set newEndEpoch to item 6 of argv
    if (count of argv) >= 7 then set newLoc to item 7 of argv
    if (count of argv) >= 8 then set newDesc to item 8 of argv

    if evId is "" then error "Missing event_id"

    set epochUtc to my epochUtcDate()
    tell application "Calendar"
      set calList to {}
      if calId is "" then
        set calList to calendars
      else
        set calList to {my resolveCalendar(calId)}
      end if

      repeat with c in calList
        try
          set e to first event of c whose uid is evId
          if newSummary is not "" then set summary of e to newSummary
          if newLoc is not "" then set location of e to newLoc
          if newDesc is not "" then set description of e to newDesc
          if newStartEpoch is not "" then set start date of e to (epochUtc + (newStartEpoch as number))
          if newEndEpoch is not "" then set end date of e to (epochUtc + (newEndEpoch as number))
          return (uid of e) & US & (calendarIdentifier of c) & US & (name of c)
        end try
      end repeat
    end tell
    error "Event not found: " & evId
  end if

  if action is "delete_event" then
    set calId to ""
    set evId to ""
    if (count of argv) >= 2 then set calId to item 2 of argv
    if (count of argv) >= 3 then set evId to item 3 of argv
    if evId is "" then error "Missing event_id"

    tell application "Calendar"
      set calList to {}
      if calId is "" then
        set calList to calendars
      else
        set calList to {my resolveCalendar(calId)}
      end if

      repeat with c in calList
        try
          set e to first event of c whose uid is evId
          delete e
          return evId & US & (calendarIdentifier of c) & US & (name of c)
        end try
      end repeat
    end tell
    error "Event not found: " & evId
  end if

  error "Unsupported action: " & action
end run
`;

export class AppleCalendarTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {}

  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  static isAvailable(): boolean {
    return os.platform() === "darwin";
  }

  private async requireApproval(summary: string, details: Record<string, unknown>): Promise<void> {
    const approved = await this.daemon.requestApproval(
      this.taskId,
      "external_service",
      summary,
      details,
    );
    if (!approved) {
      throw new Error("User denied Apple Calendar action");
    }
  }

  private async runAppleScript(argv: string[]): Promise<string> {
    const lines = APPLESCRIPT.split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const args = lines.flatMap((line) => ["-e", line]);
    args.push(...argv);

    const { stdout, stderr } = await execFileAsync("osascript", args, {
      timeout: APPLESCRIPT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      env: process.env,
      cwd: this.workspace.path,
    });

    return (stdout || stderr || "").trim();
  }

  private formatPermissionHint(message: string): string | null {
    // Common AppleScript automation permission error code
    if (/-1743/.test(message) || /not authorized to send apple events/i.test(message)) {
      return "macOS blocked Calendar automation. Enable access in System Settings > Privacy & Security > Automation (and Calendars), then retry.";
    }
    if (
      /Not permitted|operation not permitted|denied/i.test(message) &&
      /calendar/i.test(message)
    ) {
      return "Calendar access was denied by macOS privacy settings. Check System Settings > Privacy & Security > Calendars and Automation, then retry.";
    }
    return null;
  }

  private parseCalendars(output: string): ParsedCalendar[] {
    const records = splitRecords(output);
    const calendars: ParsedCalendar[] = [];
    for (const record of records) {
      const [calendar_id, name, writableRaw] = splitFields(record);
      if (!calendar_id || !name) continue;
      calendars.push({
        calendar_id,
        name,
        writable: writableRaw === "true",
      });
    }
    return calendars;
  }

  private parseEvents(output: string): ParsedEvent[] {
    const records = splitRecords(output);
    const events: ParsedEvent[] = [];
    for (const record of records) {
      const [
        event_id,
        calendar_id,
        calendar_name,
        summary,
        startEpoch,
        endEpoch,
        location,
        description,
        allDayRaw,
      ] = splitFields(record);
      if (!event_id || !calendar_id) continue;
      events.push({
        event_id,
        calendar_id,
        calendar_name: calendar_name || calendar_id,
        summary: summary || undefined,
        start: epochToIso(startEpoch),
        end: epochToIso(endEpoch),
        location: location || undefined,
        description: description || undefined,
        all_day: parseBool(allDayRaw),
      });
    }
    return events;
  }

  async executeAction(input: AppleCalendarActionInput): Promise<Any> {
    if (!AppleCalendarTools.isAvailable()) {
      throw new Error("Apple Calendar tools are only available on macOS.");
    }

    const action = input.action;
    if (!action) {
      throw new Error('Missing required "action" parameter');
    }

    // Defaults: constrain list_events to a reasonable window to avoid huge enumerations.
    const nowSec = Math.floor(Date.now() / 1000);
    const defaultMaxSec = nowSec + 7 * 24 * 60 * 60;

    try {
      switch (action) {
        case "list_calendars": {
          const out = await this.runAppleScript([action]);
          const calendars = this.parseCalendars(out);
          return { success: true, action, data: { calendars } };
        }
        case "list_events": {
          const minSec = parseEpochSeconds(input.time_min) ?? nowSec;
          const maxSec = parseEpochSeconds(input.time_max) ?? defaultMaxSec;
          const out = await this.runAppleScript([
            action,
            input.calendar_id || "",
            String(minSec),
            String(maxSec),
          ]);
          let events = this.parseEvents(out);
          if (input.query) {
            const q = input.query.toLowerCase();
            events = events.filter((e) => {
              const hay =
                `${e.summary ?? ""} ${e.description ?? ""} ${e.location ?? ""}`.toLowerCase();
              return hay.includes(q);
            });
          }
          events.sort((a, b) => {
            const at = a.start ? Date.parse(a.start) : 0;
            const bt = b.start ? Date.parse(b.start) : 0;
            return at - bt;
          });
          const limit = Math.min(Math.max(input.max_results ?? 50, 1), 500);
          return { success: true, action, data: { events: events.slice(0, limit) } };
        }
        case "get_event": {
          if (!input.event_id) throw new Error("Missing event_id for get_event");
          const out = await this.runAppleScript([action, input.calendar_id || "", input.event_id]);
          const [event] = this.parseEvents(out);
          if (!event) {
            throw new Error("Event not found");
          }
          return { success: true, action, data: { event } };
        }
        case "create_event": {
          if (!input.summary || !input.start || !input.end) {
            throw new Error("Missing summary/start/end for calendar event");
          }
          const startSec = parseEpochSeconds(input.start);
          const endSec = parseEpochSeconds(input.end);
          if (startSec === null || endSec === null) {
            throw new Error("Invalid start/end time");
          }
          await this.requireApproval("Create an Apple Calendar event", {
            action,
            calendar_id: input.calendar_id || "(default)",
            summary: input.summary,
            start: input.start,
            end: input.end,
          });
          const out = await this.runAppleScript([
            action,
            input.calendar_id || "",
            input.summary,
            String(startSec),
            String(endSec),
            input.location || "",
            input.description || "",
          ]);
          const [event_id, calendar_id, calendar_name] = splitFields(out);
          return {
            success: true,
            action,
            data: {
              event: {
                event_id,
                calendar_id,
                calendar_name: calendar_name || calendar_id,
                summary: input.summary,
                start: input.start,
                end: input.end,
                location: input.location,
                description: input.description,
              },
            },
          };
        }
        case "update_event": {
          if (!input.event_id) throw new Error("Missing event_id for update_event");
          const startSec = parseEpochSeconds(input.start ?? undefined);
          const endSec = parseEpochSeconds(input.end ?? undefined);
          await this.requireApproval("Update an Apple Calendar event", {
            action,
            calendar_id: input.calendar_id || "(search)",
            event_id: input.event_id,
            summary: input.summary,
            start: input.start,
            end: input.end,
          });
          const out = await this.runAppleScript([
            action,
            input.calendar_id || "",
            input.event_id,
            input.summary || "",
            startSec !== null ? String(startSec) : "",
            endSec !== null ? String(endSec) : "",
            input.location || "",
            input.description || "",
          ]);
          const [event_id, calendar_id, calendar_name] = splitFields(out);
          return {
            success: true,
            action,
            data: {
              event: {
                event_id,
                calendar_id,
                calendar_name: calendar_name || calendar_id,
              },
            },
          };
        }
        case "delete_event": {
          if (!input.event_id) throw new Error("Missing event_id for delete_event");
          await this.requireApproval("Delete an Apple Calendar event", {
            action,
            calendar_id: input.calendar_id || "(search)",
            event_id: input.event_id,
          });
          const out = await this.runAppleScript([action, input.calendar_id || "", input.event_id]);
          const [event_id, calendar_id, calendar_name] = splitFields(out);
          return { success: true, action, data: { event_id, calendar_id, calendar_name } };
        }
        default:
          throw new Error(`Unsupported action: ${action}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint = this.formatPermissionHint(message);
      const finalMessage = hint ?? message;
      this.daemon.logEvent(this.taskId, "tool_error", {
        tool: "apple_calendar_action",
        action,
        message: finalMessage,
      });
      throw new Error(finalMessage);
    }
  }
}
