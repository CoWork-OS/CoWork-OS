import { execFile } from "child_process";
import { promisify } from "util";
import * as os from "os";
import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";

const execFileAsync = promisify(execFile);

const APPLESCRIPT_TIMEOUT_MS = 30 * 1000; // 30 seconds
const MAX_BUFFER = 1024 * 1024; // 1MB

type RemindersAction =
  | "list_lists"
  | "list_reminders"
  | "get_reminder"
  | "create_reminder"
  | "update_reminder"
  | "complete_reminder"
  | "delete_reminder";

interface AppleRemindersActionInput {
  action: RemindersAction;
  list_id?: string;
  reminder_id?: string;
  query?: string;
  include_completed?: boolean;
  due_min?: string;
  due_max?: string;
  max_results?: number;
  title?: string;
  notes?: string;
  due?: string;
}

type ParsedList = {
  list_id: string;
  name: string;
};

type ParsedReminder = {
  reminder_id: string;
  list_id: string;
  list_name: string;
  title?: string;
  notes?: string;
  due?: string;
  completed?: boolean;
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

on resolveList(listId)
  tell application "Reminders"
    if listId is "" then return list 1
    try
      return first list whose id is listId
    on error
      try
        return first list whose name is listId
      on error
        error "List not found: " & listId
      end try
    end try
  end tell
end resolveList

on serializeReminder(r, l, epochUtc)
  set rid to ""
  try
    set rid to id of r
  end try
  set lid to ""
  try
    set lid to id of l
  end try
  set lname to ""
  try
    set lname to name of l
  end try
  set rname to ""
  try
    set rname to name of r
  end try
  set rbody to ""
  try
    set rbody to body of r
  end try
  set rcompleted to "false"
  try
    set rcompleted to (completed of r) as string
  end try
  set dueSec to ""
  try
    if due date of r is not missing value then
      set dueSec to ((due date of r) - epochUtc) as string
    end if
  end try
  return rid & US & lid & US & lname & US & rname & US & dueSec & US & rbody & US & rcompleted
end serializeReminder

on run argv
  set action to ""
  if (count of argv) >= 1 then set action to item 1 of argv

  if action is "list_lists" then
    tell application "Reminders"
      set records to {}
      repeat with l in lists
        set rec to (id of l) & US & (name of l)
        set end of records to rec
      end repeat
    end tell
    return my joinWithRS(records)
  end if

  if action is "list_reminders" then
    set listId to ""
    set includeCompleted to "false"
    set minEpoch to ""
    set maxEpoch to ""
    if (count of argv) >= 2 then set listId to item 2 of argv
    if (count of argv) >= 3 then set includeCompleted to item 3 of argv
    if (count of argv) >= 4 then set minEpoch to item 4 of argv
    if (count of argv) >= 5 then set maxEpoch to item 5 of argv

    set epochUtc to my epochUtcDate()
    set hasMin to (minEpoch is not "")
    set hasMax to (maxEpoch is not "")
    set minDate to missing value
    set maxDate to missing value
    if hasMin then set minDate to epochUtc + (minEpoch as number)
    if hasMax then set maxDate to epochUtc + (maxEpoch as number)

    tell application "Reminders"
      set listList to {}
      if listId is "" then
        set listList to lists
      else
        set listList to {my resolveList(listId)}
      end if

      set records to {}
      repeat with l in listList
        set rs to {}
        if includeCompleted is "true" then
          set rs to reminders of l
        else
          set rs to (every reminder of l whose completed is false)
        end if

        if (hasMin or hasMax) then
          set filtered to {}
          repeat with r in rs
            set d to missing value
            try
              set d to due date of r
            end try
            if d is not missing value then
              if (not hasMin or d >= minDate) and (not hasMax or d <= maxDate) then
                set end of filtered to r
              end if
            end if
          end repeat
          set rs to filtered
        end if

        repeat with r in rs
          set end of records to my serializeReminder(r, l, epochUtc)
        end repeat
      end repeat
    end tell
    return my joinWithRS(records)
  end if

  if action is "get_reminder" then
    set listId to ""
    set remId to ""
    if (count of argv) >= 2 then set listId to item 2 of argv
    if (count of argv) >= 3 then set remId to item 3 of argv
    if remId is "" then error "Missing reminder_id"

    set epochUtc to my epochUtcDate()
    tell application "Reminders"
      set listList to {}
      if listId is "" then
        set listList to lists
      else
        set listList to {my resolveList(listId)}
      end if

      repeat with l in listList
        try
          set r to first reminder of l whose id is remId
          return my serializeReminder(r, l, epochUtc)
        end try
      end repeat
    end tell
    error "Reminder not found: " & remId
  end if

  if action is "create_reminder" then
    set listId to ""
    set titleText to ""
    set dueEpoch to ""
    set bodyText to ""
    if (count of argv) >= 2 then set listId to item 2 of argv
    if (count of argv) >= 3 then set titleText to item 3 of argv
    if (count of argv) >= 4 then set dueEpoch to item 4 of argv
    if (count of argv) >= 5 then set bodyText to item 5 of argv

    if titleText is "" then error "Missing title"

    set epochUtc to my epochUtcDate()
    tell application "Reminders"
      set l to my resolveList(listId)
      set r to make new reminder at end of reminders of l with properties {name:titleText}
      if bodyText is not "" then
        try
          set body of r to bodyText
        end try
      end if
      if dueEpoch is not "" then
        try
          set due date of r to (epochUtc + (dueEpoch as number))
        end try
      end if
      return my serializeReminder(r, l, epochUtc)
    end tell
  end if

  if action is "update_reminder" then
    set listId to ""
    set remId to ""
    set titleText to ""
    set dueEpoch to ""
    set bodyText to ""
    if (count of argv) >= 2 then set listId to item 2 of argv
    if (count of argv) >= 3 then set remId to item 3 of argv
    if (count of argv) >= 4 then set titleText to item 4 of argv
    if (count of argv) >= 5 then set dueEpoch to item 5 of argv
    if (count of argv) >= 6 then set bodyText to item 6 of argv
    if remId is "" then error "Missing reminder_id"

    set epochUtc to my epochUtcDate()
    tell application "Reminders"
      set listList to {}
      if listId is "" then
        set listList to lists
      else
        set listList to {my resolveList(listId)}
      end if

      repeat with l in listList
        try
          set r to first reminder of l whose id is remId
          if titleText is not "" then set name of r to titleText
          if bodyText is not "" then
            try
              set body of r to bodyText
            end try
          end if
          if dueEpoch is not "" then
            try
              set due date of r to (epochUtc + (dueEpoch as number))
            end try
          end if
          return my serializeReminder(r, l, epochUtc)
        end try
      end repeat
    end tell
    error "Reminder not found: " & remId
  end if

  if action is "complete_reminder" then
    set listId to ""
    set remId to ""
    if (count of argv) >= 2 then set listId to item 2 of argv
    if (count of argv) >= 3 then set remId to item 3 of argv
    if remId is "" then error "Missing reminder_id"

    set epochUtc to my epochUtcDate()
    tell application "Reminders"
      set listList to {}
      if listId is "" then
        set listList to lists
      else
        set listList to {my resolveList(listId)}
      end if

      repeat with l in listList
        try
          set r to first reminder of l whose id is remId
          set completed of r to true
          return my serializeReminder(r, l, epochUtc)
        end try
      end repeat
    end tell
    error "Reminder not found: " & remId
  end if

  if action is "delete_reminder" then
    set listId to ""
    set remId to ""
    if (count of argv) >= 2 then set listId to item 2 of argv
    if (count of argv) >= 3 then set remId to item 3 of argv
    if remId is "" then error "Missing reminder_id"

    tell application "Reminders"
      set listList to {}
      if listId is "" then
        set listList to lists
      else
        set listList to {my resolveList(listId)}
      end if

      repeat with l in listList
        try
          set r to first reminder of l whose id is remId
          delete r
          return remId & US & (id of l) & US & (name of l)
        end try
      end repeat
    end tell
    error "Reminder not found: " & remId
  end if

  error "Unsupported action: " & action
end run
`;

export class AppleRemindersTools {
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
      throw new Error("User denied Apple Reminders action");
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
    if (/-1743/.test(message) || /not authorized to send apple events/i.test(message)) {
      return "macOS blocked Reminders automation. Enable access in System Settings > Privacy & Security > Automation (and Reminders), then retry.";
    }
    if (
      /Not permitted|operation not permitted|denied/i.test(message) &&
      /reminders/i.test(message)
    ) {
      return "Reminders access was denied by macOS privacy settings. Check System Settings > Privacy & Security > Reminders and Automation, then retry.";
    }
    return null;
  }

  private parseLists(output: string): ParsedList[] {
    const records = splitRecords(output);
    const lists: ParsedList[] = [];
    for (const record of records) {
      const [list_id, name] = splitFields(record);
      if (!list_id || !name) continue;
      lists.push({ list_id, name });
    }
    return lists;
  }

  private parseReminders(output: string): ParsedReminder[] {
    const records = splitRecords(output);
    const reminders: ParsedReminder[] = [];
    for (const record of records) {
      const [reminder_id, list_id, list_name, title, dueEpoch, notes, completedRaw] =
        splitFields(record);
      if (!reminder_id || !list_id) continue;
      reminders.push({
        reminder_id,
        list_id,
        list_name: list_name || list_id,
        title: title || undefined,
        due: epochToIso(dueEpoch),
        notes: notes || undefined,
        completed: parseBool(completedRaw),
      });
    }
    return reminders;
  }

  async executeAction(input: AppleRemindersActionInput): Promise<Any> {
    if (!AppleRemindersTools.isAvailable()) {
      throw new Error("Apple Reminders tools are only available on macOS.");
    }

    const action = input.action;
    if (!action) {
      throw new Error('Missing required "action" parameter');
    }

    try {
      switch (action) {
        case "list_lists": {
          const out = await this.runAppleScript([action]);
          const lists = this.parseLists(out);
          return { success: true, action, data: { lists } };
        }
        case "list_reminders": {
          const minSec = parseEpochSeconds(input.due_min) ?? "";
          const maxSec = parseEpochSeconds(input.due_max) ?? "";
          const out = await this.runAppleScript([
            action,
            input.list_id || "",
            input.include_completed ? "true" : "false",
            minSec === "" ? "" : String(minSec),
            maxSec === "" ? "" : String(maxSec),
          ]);
          let reminders = this.parseReminders(out);
          if (input.query) {
            const q = input.query.toLowerCase();
            reminders = reminders.filter((r) => {
              const hay = `${r.title ?? ""} ${r.notes ?? ""} ${r.list_name ?? ""}`.toLowerCase();
              return hay.includes(q);
            });
          }
          reminders.sort((a, b) => {
            const at = a.due ? Date.parse(a.due) : Number.POSITIVE_INFINITY;
            const bt = b.due ? Date.parse(b.due) : Number.POSITIVE_INFINITY;
            return at - bt;
          });
          const limit = Math.min(Math.max(input.max_results ?? 100, 1), 500);
          return { success: true, action, data: { reminders: reminders.slice(0, limit) } };
        }
        case "get_reminder": {
          if (!input.reminder_id) throw new Error("Missing reminder_id for get_reminder");
          const out = await this.runAppleScript([action, input.list_id || "", input.reminder_id]);
          const [reminder] = this.parseReminders(out);
          if (!reminder) throw new Error("Reminder not found");
          return { success: true, action, data: { reminder } };
        }
        case "create_reminder": {
          if (!input.title) throw new Error("Missing title for create_reminder");
          const dueSec = input.due ? parseEpochSeconds(input.due) : null;
          if (input.due && dueSec === null) throw new Error("Invalid due datetime");
          await this.requireApproval("Create an Apple Reminders item", {
            action,
            list_id: input.list_id || "(default)",
            title: input.title,
            due: input.due,
          });
          const out = await this.runAppleScript([
            action,
            input.list_id || "",
            input.title,
            dueSec === null ? "" : String(dueSec),
            input.notes || "",
          ]);
          const [reminder] = this.parseReminders(out);
          if (!reminder) throw new Error("Failed to create reminder");
          return { success: true, action, data: { reminder } };
        }
        case "update_reminder": {
          if (!input.reminder_id) throw new Error("Missing reminder_id for update_reminder");
          const dueSec = input.due ? parseEpochSeconds(input.due) : null;
          if (input.due && dueSec === null) throw new Error("Invalid due datetime");
          await this.requireApproval("Update an Apple Reminders item", {
            action,
            list_id: input.list_id || "(search)",
            reminder_id: input.reminder_id,
            title: input.title,
            due: input.due,
          });
          const out = await this.runAppleScript([
            action,
            input.list_id || "",
            input.reminder_id,
            input.title || "",
            dueSec === null ? "" : String(dueSec),
            input.notes || "",
          ]);
          const [reminder] = this.parseReminders(out);
          if (!reminder) throw new Error("Failed to update reminder");
          return { success: true, action, data: { reminder } };
        }
        case "complete_reminder": {
          if (!input.reminder_id) throw new Error("Missing reminder_id for complete_reminder");
          await this.requireApproval("Complete an Apple Reminders item", {
            action,
            list_id: input.list_id || "(search)",
            reminder_id: input.reminder_id,
          });
          const out = await this.runAppleScript([action, input.list_id || "", input.reminder_id]);
          const [reminder] = this.parseReminders(out);
          if (!reminder) throw new Error("Failed to complete reminder");
          return { success: true, action, data: { reminder } };
        }
        case "delete_reminder": {
          if (!input.reminder_id) throw new Error("Missing reminder_id for delete_reminder");
          await this.requireApproval("Delete an Apple Reminders item", {
            action,
            list_id: input.list_id || "(search)",
            reminder_id: input.reminder_id,
          });
          const out = await this.runAppleScript([action, input.list_id || "", input.reminder_id]);
          const [reminder_id, list_id, list_name] = splitFields(out);
          return { success: true, action, data: { reminder_id, list_id, list_name } };
        }
        default:
          throw new Error(`Unsupported action: ${action}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint = this.formatPermissionHint(message);
      const finalMessage = hint ?? message;
      this.daemon.logEvent(this.taskId, "tool_error", {
        tool: "apple_reminders_action",
        action,
        message: finalMessage,
      });
      throw new Error(finalMessage);
    }
  }
}
