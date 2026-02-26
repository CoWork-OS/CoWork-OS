import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let capturedExecArgs: string[] | null = null;

vi.mock("child_process", () => ({
  execFile: vi.fn((file: string, args: string[], options: Any, callback: Any) => {
    capturedExecArgs = args;
    callback(null, `cal_1\x1fCalendar\x1ftrue`, "");
  }),
}));

describe("AppleCalendarTools AppleScript generation", () => {
  beforeEach(() => {
    capturedExecArgs = null;
    vi.clearAllMocks();
  });

  it('does not use the ambiguous "records" variable inside tell application "Calendar"', async () => {
    if (process.platform !== "darwin") {
      // Tool is macOS-only; in CI this may run on Linux/Windows.
      expect(true).toBe(true);
      return;
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-cal-"));

    const { AppleCalendarTools } = await import("../apple-calendar-tools");

    const workspace: Any = {
      id: "w",
      name: "w",
      path: tmpDir,
      isTemp: true,
      createdAt: Date.now(),
      permissions: { read: true, write: true, delete: true, network: true, shell: false },
    };

    const daemon: Any = {
      logEvent: vi.fn(),
      requestApproval: vi.fn(),
      registerArtifact: vi.fn(),
    };

    const tools = new AppleCalendarTools(workspace, daemon, "task");
    const res = await tools.executeAction({ action: "list_calendars" });

    expect(res?.success).toBe(true);
    expect(capturedExecArgs).toBeTruthy();

    const scriptLines = capturedExecArgs?.filter((_, idx, arr) => arr[idx - 1] === "-e") ?? [];

    const hasOutRowsInit = scriptLines.some((l) => /\bset outRows to \{\}/.test(l));
    const hasRecordsInit = scriptLines.some((l) => /\bset records to \{\}/.test(l));

    expect(hasOutRowsInit).toBe(true);
    expect(hasRecordsInit).toBe(false);
  });
});
