import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../daemon";
import { botWorkspaceId } from "../../../shared/bot-containment";
import type { Task } from "../../../shared/types";

let userData: string;
const originalUserData = process.env.COWORK_USER_DATA_DIR;

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-bot-containment-"));
  process.env.COWORK_USER_DATA_DIR = userData;
});

afterEach(() => {
  if (originalUserData === undefined) delete process.env.COWORK_USER_DATA_DIR;
  else process.env.COWORK_USER_DATA_DIR = originalUserData;
  fs.rmSync(userData, { recursive: true, force: true });
});

function fixture(tasks: Task[], role: Record<string, unknown> = {}) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const workspaces = new Map<string, Any>();
  const daemon = {
    agentRoleRepo: {
      findById: vi.fn((id: string) => ({ id, name: "scout", displayName: "Scout", ...role })),
    },
    taskRepo: {
      findById: vi.fn((id: string) => byId.get(id)),
      update: vi.fn((id: string, patch: Partial<Task>) => {
        byId.set(id, { ...byId.get(id)!, ...patch });
      }),
    },
    workspaceRepo: {
      findById: vi.fn((id: string) => workspaces.get(id)),
      upsertWithId: vi.fn((row: Any) => workspaces.set(row.id, row)),
    },
    updateTaskWorkspace: vi.fn((id: string, workspaceId: string) => {
      byId.set(id, { ...byId.get(id)!, workspaceId });
    }),
    getTaskAncestorChain: AgentDaemon.prototype["getTaskAncestorChain"],
    ensureBotWorkspace: AgentDaemon.prototype["ensureBotWorkspace"],
  } as Any;
  const contain = (task: Task): Task => AgentDaemon.prototype["containBotTask"].call(daemon, task);
  return { daemon, contain, byId, workspaces };
}

const task = (overrides: Partial<Task>): Task =>
  ({
    id: "task-1",
    title: "Run",
    prompt: "Check the inbox",
    status: "pending",
    workspaceId: "user-project",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }) as Task;

describe("moving a bot's unattended run into its own folder", () => {
  it("moves a heartbeat-style run and marks it contained", () => {
    const f = fixture([task({ assignedAgentRoleId: "bot-1" })]);
    const result = f.contain(f.byId.get("task-1")!);

    const id = botWorkspaceId("bot-1");
    expect(result.workspaceId).toBe(id);
    expect(result.agentConfig?.botContained).toBe(true);
    expect(f.daemon.updateTaskWorkspace).toHaveBeenCalledWith("task-1", id);
    expect(f.byId.get("task-1")?.agentConfig?.botContained).toBe(true);
    const folder = f.workspaces.get(id).path;
    expect(folder).toBe(path.join(userData, "bots", "bot-1", "work"));
    expect(fs.statSync(folder).mode & 0o777).toBe(0o700);
    expect(f.workspaces.get(id).permissions.unrestrictedFileAccess).toBe(false);
  });

  it("leaves a run the person typed in the app in their project", () => {
    const f = fixture([task({ assignedAgentRoleId: "bot-1", promptProvenance: "user_typed" })]);
    const result = f.contain(f.byId.get("task-1")!);
    expect(result.workspaceId).toBe("user-project");
    expect(f.daemon.updateTaskWorkspace).not.toHaveBeenCalled();
    expect(f.workspaces.size).toBe(0);
  });

  it("leaves bots set to Your workspace where the run was given", () => {
    const f = fixture([task({ assignedAgentRoleId: "bot-1" })], { fileAccess: "workspace" });
    expect(f.contain(f.byId.get("task-1")!).workspaceId).toBe("user-project");
  });

  it("follows the person's choice through a delegating task", () => {
    const f = fixture([
      task({ id: "root", promptProvenance: "user_typed" }),
      task({ id: "task-1", parentTaskId: "root", assignedAgentRoleId: "bot-1" }),
    ]);
    expect(f.contain(f.byId.get("task-1")!).workspaceId).toBe("user-project");
  });

  it("keeps any task in a bot's folder marked contained", () => {
    const f = fixture([task({ workspaceId: botWorkspaceId("bot-1") })]);
    const result = f.contain(f.byId.get("task-1")!);
    expect(result.agentConfig?.botContained).toBe(true);
    expect(f.daemon.updateTaskWorkspace).not.toHaveBeenCalled();
  });
});
