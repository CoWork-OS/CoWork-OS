import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkSessionItem } from "../../shared/types";
import { evaluateIsolatedReplay } from "../../electron/sessions/WorkSessionReplayEvaluationService";
import { DRILL_METHODS, loadDrillFixture, runLiveInterruptDrill } from "../drill";
import { main } from "../main";

const FIXTURE = path.resolve(__dirname, "../../../scripts/qa/drills/stop-in-flight.json");

afterEach(() => {
  vi.restoreAllMocks();
});

async function runCli(args: string[]): Promise<{ code: number; stdout: string }> {
  let stdout = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  const code = await main(args);
  vi.mocked(process.stdout.write).mockRestore();
  return { code, stdout };
}

describe("cowork drill interrupt", () => {
  it("replays the stop-in-flight fixture and matches its expected result", async () => {
    const { code, stdout } = await runCli(["drill", "interrupt", FIXTURE, "--json"]);
    expect(code).toBe(0);
    const output = JSON.parse(stdout);
    expect(output).toMatchObject({ fixture: "stop-in-flight", mode: "replay", problems: [] });
    expect(output.report).toEqual({
      taskId: "drill-stop-in-flight",
      interrupted: true,
      status: "cancelled",
      requirements: [
        {
          id: "requirement-1",
          description: "notes.md exists",
          status: "satisfied",
          required: true,
        },
        { id: "requirement-2", description: "report.md exists", status: "pending", required: true },
      ],
      filesChanged: ["notes.md"],
      inFlight: [
        {
          toolName: "write_file",
          outcome: "unknown",
          effect: "write",
          target: "report.md",
          idempotencyKey: "5f0b6c1e9a2d4e7f8a1b3c5d7e9f0a2b",
        },
      ],
      pendingWaits: [],
      findings: [],
      resume: [
        "cowork handoff export --task drill-stop-in-flight",
        "cowork handoff import <package folder> --environment <environmentId> --dry-run",
      ],
    });
  });

  it("prints what changed, what is unknown and how to resume", async () => {
    const { code, stdout } = await runCli(["drill", "interrupt", FIXTURE]);
    expect(code).toBe(0);
    expect(stdout).toContain("Stop confirmed: yes (cancelled)");
    expect(stdout).toContain("[pending] report.md exists");
    expect(stdout).toContain("Files changed (1): notes.md");
    expect(stdout).toContain("write_file on report.md: outcome unknown");
    expect(stdout).toContain("cowork handoff export --task drill-stop-in-flight");
  });

  it("agrees with the replay evaluator: the stop is not a success and has no findings", () => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
    const kindOf = (type: string): WorkSessionItem["kind"] =>
      type === "tool_call" || type === "tool_result"
        ? type
        : type.startsWith("file_")
          ? "artifact"
          : "status";
    const items: WorkSessionItem[] = fixture.events.map((event: Any, index: number) => ({
      id: `drill-${index}`,
      sessionId: "drill-session",
      turnId: "drill-turn",
      sequence: index + 1,
      kind: kindOf(event.type),
      actor: "agent",
      payload: { eventType: event.type, payload: event.payload },
      redactionClass: "standard",
      createdAt: index + 1,
    }));
    const result = evaluateIsolatedReplay(items, "drill:stop-in-flight");
    expect(result.replayStatus).toBe("cancelled");
    expect(result.findings).toEqual([]);
  });

  it("exits 1 and lists the difference when a run does not match the fixture", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-drill-"));
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
    fixture.expected.filesChanged = ["notes.md", "report.md"];
    const tampered = path.join(dir, "tampered.json");
    fs.writeFileSync(tampered, JSON.stringify(fixture));
    const { code, stdout } = await runCli(["drill", "interrupt", tampered]);
    expect(code).toBe(1);
    expect(stdout).toContain("Differs from fixture stop-in-flight");
    expect(stdout).toContain("filesChanged");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("finds a fixture by name under scripts/qa/drills", async () => {
    const fixture = await loadDrillFixture("stop-in-flight", path.resolve(__dirname, "../../.."));
    expect(fixture.id).toBe("stop-in-flight");
    await expect(loadDrillFixture("no-such-drill", os.tmpdir())).rejects.toThrow("not found");
  });

  it("runs live: stops after the set number of tool calls and reads back contract and replay", async () => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
    const toolCall = { type: "tool_call", payload: { tool: "write_file" } };
    const pages = [
      [toolCall],
      [toolCall, toolCall],
      [
        toolCall,
        toolCall,
        {
          type: "timeline_step_updated",
          legacyType: "agent_interrupt_confirmed",
          payload: {
            status: "cancelled",
            inFlight: [{ toolName: "write_file", outcome: "unknown", target: "report.md" }],
          },
        },
      ],
    ];
    let page = 0;
    const calls: string[] = [];
    const client = {
      request: vi.fn(async (method: string) => {
        calls.push(method);
        if (method === DRILL_METHODS.TASK_CREATE) return { taskId: "task-live" };
        if (method === DRILL_METHODS.TASK_EVENTS) {
          const events = pages[Math.min(page, pages.length - 1)];
          page += 1;
          return { events };
        }
        if (method === DRILL_METHODS.TASK_CANCEL) return { ok: true };
        if (method === DRILL_METHODS.CONTRACT_GET) {
          return {
            requirements: [{ id: "r1", description: "report.md exists", status: "pending" }],
            pendingWaits: [{ kind: "approval", reason: "Approve the write" }],
          };
        }
        return { result: { replayStatus: "cancelled", findings: [] } };
      }),
    };

    const report = await runLiveInterruptDrill(client, {
      workspaceId: "ws-1",
      fixture,
      sleep: async () => undefined,
    });

    expect(calls.filter((method) => method === DRILL_METHODS.TASK_CANCEL)).toHaveLength(1);
    expect(calls.indexOf(DRILL_METHODS.TASK_CANCEL)).toBeGreaterThan(
      calls.indexOf(DRILL_METHODS.TASK_EVENTS),
    );
    expect(client.request).toHaveBeenCalledWith(
      DRILL_METHODS.TASK_CREATE,
      expect.objectContaining({ workspaceId: "ws-1", prompt: fixture.prompt }),
      30_000,
    );
    expect(report).toMatchObject({
      taskId: "task-live",
      interrupted: true,
      status: "cancelled",
      replayStatus: "cancelled",
      inFlight: [{ toolName: "write_file", outcome: "unknown", target: "report.md" }],
      pendingWaits: [{ kind: "approval", reason: "Approve the write" }],
      requirements: [{ id: "r1", status: "pending" }],
    });
  });
});
