import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyDevLogRetention,
  createDevLogEvent,
  formatDevLogTextLine,
  inferDevLogLevel,
  isIgnorableDevLogLine,
  redactDevLogLine,
  serializeDevLogEvent,
} from "../scripts/dev-log-utils.mjs";

describe("dev-log-utils", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-dev-log-utils-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("serializes JSONL events with inferred process, component, severity, and ids", () => {
    const event = createDevLogEvent({
      timestamp: "2026-04-28T10:00:00.000Z",
      runId: "20260428-100000",
      stream: "stderr",
      line: "[electron] [TaskRunner] Failed taskId=task-1 workspaceId=workspace-2",
    });

    expect(JSON.parse(serializeDevLogEvent(event))).toMatchObject({
      timestamp: "2026-04-28T10:00:00.000Z",
      runId: "20260428-100000",
      process: "electron",
      component: "TaskRunner",
      stream: "stderr",
      level: "error",
      message: "Failed taskId=task-1 workspaceId=workspace-2",
      taskId: "task-1",
      workspaceId: "workspace-2",
    });
  });

  it("preserves multiline output as separate timestamped text lines", () => {
    const first = formatDevLogTextLine("2026-04-28T10:00:00.000Z", "[electron] Error: boom");
    const second = formatDevLogTextLine("2026-04-28T10:00:00.001Z", "    at run (file.ts:1:1)");

    expect(`${first}${second}`).toBe(
      "[2026-04-28T10:00:00.000Z] [electron] Error: boom\n" +
        "[2026-04-28T10:00:00.001Z]     at run (file.ts:1:1)\n",
    );
  });

  it("infers warning and error levels from stdout text", () => {
    expect(
      createDevLogEvent({
        timestamp: "2026-04-28T10:00:00.000Z",
        runId: "run",
        line: "[react] warning: deprecated option",
      }).level,
    ).toBe("warn");
    expect(
      createDevLogEvent({
        timestamp: "2026-04-28T10:00:00.000Z",
        runId: "run",
        line: "[electron] uncaught exception while loading",
      }).level,
    ).toBe("error");
  });

  it("does not treat successful failed=0 summaries as errors", () => {
    expect(
      inferDevLogLevel(
        "[electron] [Main] MCP summary: enabled=5, attempted=5, connected=5, failed=0",
        "stderr",
      ),
    ).toBe("info");
  });

  it("does not treat run_command start lines with ffprobe log-level arguments as errors", () => {
    expect(
      inferDevLogLevel(
        '[electron] [TaskExecutor] [Executor:task]   │ ⚙ Tool #1 "run_command" start | input={"command":"ffprobe -v error -show_streams video.mov"}',
        "stdout",
      ),
    ).toBe("info");
  });

  it("keeps non-error stderr notes out of the error bucket", () => {
    expect(
      inferDevLogLevel(
        "Note: The code generator has deoptimised the styling of src/renderer/components/MainContent.tsx as it exceeds the max of 500KB.",
        "stderr",
      ),
    ).toBe("warn");
    expect(inferDevLogLevel("    at process.processTimers (node:internal/timers:541:7)", "stderr"))
      .toBe("warn");
  });

  it("keeps transient IMAP fetch timeouts as warnings", () => {
    expect(
      inferDevLogLevel("Error fetching email 67486: Error: IMAP command timeout", "stderr"),
    ).toBe("warn");
  });

  it("marks known Electron macOS native menu warnings as ignorable dev-log noise", () => {
    expect(
      isIgnorableDevLogLine(
        "[electron] 2026-05-25 10:11:41.912 Electron[11303:37884501] representedObject is not a WeakPtrToElectronMenuModelAsNSObject",
      ),
    ).toBe(true);
    expect(isIgnorableDevLogLine("[electron] Uncaught ReferenceError: selectedTaskSwitchId is not defined"))
      .toBe(false);
  });

  it("still classifies real stderr failures as errors", () => {
    expect(inferDevLogLevel("Unhandled exception: boom", "stderr")).toBe("error");
    expect(inferDevLogLevel("Error: Unable to find an available dev server port", "stderr")).toBe(
      "error",
    );
  });

  it("redacts common secret shapes before writing files", () => {
    const redacted = redactDevLogLine(
      "Authorization: Bearer abcdefghijklmnop OPENAI_API_KEY=sk-testsecret123456789 https://user:pass@example.com",
    );

    expect(redacted).toContain("Authorization: Bearer [REDACTED]");
    expect(redacted).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(redacted).toContain("https://[REDACTED]@example.com");
    expect(redacted).not.toContain("abcdefghijklmnop");
    expect(redacted).not.toContain("testsecret");
    expect(redacted).not.toContain("user:pass");
  });

  it("keeps the newest minimum run count while deleting older excess logs", () => {
    const now = Date.now();
    for (let index = 0; index < 25; index += 1) {
      const runId = `202604${String(index + 1).padStart(2, "0")}-100000`;
      const textPath = path.join(tempDir, `dev-${runId}.log`);
      const jsonlPath = path.join(tempDir, `dev-${runId}.jsonl`);
      fs.writeFileSync(textPath, "x".repeat(1024), "utf8");
      fs.writeFileSync(jsonlPath, "x".repeat(1024), "utf8");
      const mtime = new Date(now - (25 - index) * 24 * 60 * 60 * 1000);
      fs.utimesSync(textPath, mtime, mtime);
      fs.utimesSync(jsonlPath, mtime, mtime);
    }

    const result = applyDevLogRetention(tempDir, {
      retentionDays: 1,
      minRuns: 20,
      maxBytes: 1024 * 1024,
    });

    expect(result.deletedRunIds).toHaveLength(5);
    expect(fs.readdirSync(tempDir).filter((file) => /^dev-.*\.log$/.test(file))).toHaveLength(20);
    expect(JSON.parse(fs.readFileSync(path.join(tempDir, "dev-runs.json"), "utf8")).runs).toHaveLength(
      20,
    );
    expect(fs.existsSync(path.join(tempDir, "dev-20260425-100000.log"))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, "dev-20260401-100000.log"))).toBe(false);
  });
});
