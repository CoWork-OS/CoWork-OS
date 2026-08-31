import { describe, expect, it } from "vitest";
import {
  detectCliAgentFromEvents,
  getCliAgentDisplayInfo,
  isCliAgentChildTask,
  resolveCliAgentType,
} from "../cli-agent-detection";
import type { Task, TaskEvent } from "../types";

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Child task",
    prompt: "Do work",
    status: "pending",
    workspaceId: "workspace-1",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function createEvent(overrides: Partial<TaskEvent> = {}): TaskEvent {
  return {
    id: "event-1",
    taskId: "task-1",
    timestamp: 1,
    type: "tool_call",
    payload: {},
    schemaVersion: 2,
    ...overrides,
  };
}

describe("cli-agent-detection", () => {
  it("classifies acpx Codex tasks from task metadata", () => {
    const task = createTask({
      agentConfig: {
        externalRuntime: {
          kind: "acpx",
          agent: "codex",
          sessionMode: "persistent",
          outputMode: "json",
          permissionMode: "approve-reads",
        },
      },
    });

    expect(isCliAgentChildTask(task)).toBe(true);
    expect(resolveCliAgentType(task)).toBe("codex-acpx");
  });

  it("classifies acpx Codex tasks from event payload metadata", () => {
    const events = [
      createEvent({
        type: "progress_update",
        payload: {
          runtime: "acpx",
          runtimeAgent: "codex",
          message: "Delegating to Codex via ACP",
        },
      }),
    ];

    expect(detectCliAgentFromEvents(events)).toBe("codex-acpx");
  });

  it("classifies acpx Claude tasks from task metadata", () => {
    const task = createTask({
      agentConfig: {
        externalRuntime: {
          kind: "acpx",
          agent: "claude",
          sessionMode: "persistent",
          outputMode: "json",
          permissionMode: "approve-reads",
        },
      },
    });

    expect(isCliAgentChildTask(task)).toBe(true);
    expect(resolveCliAgentType(task)).toBe("claude-acpx");
  });

  it("falls back to legacy Claude CLI command detection", () => {
    const task = createTask({ title: "Generic child task" });
    const events = [
      createEvent({
        payload: {
          tool: "run_command",
          command: 'claude -p "review this patch"',
        },
      }),
    ];

    expect(isCliAgentChildTask(task, events)).toBe(true);
    expect(resolveCliAgentType(task, events)).toBe("claude-cli");
  });

  it("falls back to legacy Codex CLI command detection", () => {
    const task = createTask({ title: "Generic child task" });
    const events = [
      createEvent({
        payload: {
          tool: "run_command",
          command: 'codex exec "review this patch"',
        },
      }),
    ];

    expect(isCliAgentChildTask(task, events)).toBe(true);
    expect(resolveCliAgentType(task, events)).toBe("codex-cli");
  });

  it("returns the new badge text for acpx-backed Codex tasks", () => {
    expect(getCliAgentDisplayInfo("codex-acpx")).toEqual({
      icon: "⚡",
      name: "Codex",
      badge: "Codex via ACP",
      color: "#0ea5e9",
    });
  });

  it("returns Claude display metadata for acpx-backed tasks", () => {
    expect(getCliAgentDisplayInfo("claude-acpx")).toEqual({
      icon: "🧠",
      name: "Claude",
      badge: "Claude via ACP",
      color: "#8b5cf6",
    });
  });
});
