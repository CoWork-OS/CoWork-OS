import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseManager } from "../../../electron/database/schema";
import { WorkspaceStore } from "../../../electron/database/repositories";
import { WorkspaceRepository } from "../../../electron/database/repository-facades";
import type { EverydayActionReceipt, Workspace } from "../../../shared/types";
import type { ManagedSessionService } from "../../../electron/managed/ManagedSessionService";
import type { EverydayAgentService } from "../../../electron/everyday-agent/everyday-agent-repository-facades";
import type { RoutineService } from "../../../electron/routines/service";
import { createBrowserNavigationDefinitions } from "../browser-navigation-methods";

describe("browser navigation desktop methods", () => {
  let tempDir: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;
  let db: ReturnType<DatabaseManager["getDatabase"]>;
  let workspace: Workspace;
  let workspaceRepository: WorkspaceRepository;
  let managed: ManagedSessionService;
  let everyday: EverydayAgentService;
  let routineService: RoutineService;
  let receipts: EverydayActionReceipt[];

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-browser-navigation-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tempDir;
    manager = new DatabaseManager();
    db = manager.getDatabase();
    workspaceRepository = new WorkspaceRepository(db);
    workspace = new WorkspaceStore(db).create("Readable", path.join(tempDir, "readable"), {
      read: true,
      write: true,
      delete: false,
      network: true,
      shell: false,
    });
    managed = {
      getMyWorkspacePermissions: vi.fn(async () => ({
        canViewAgents: true,
        canRunAgents: true,
        canResumeSessions: true,
        canAnswerApprovals: true,
        canEditDrafts: true,
        canManageEnvironments: true,
        canPublishAgents: true,
        canManageRoutines: true,
        canManageMemberships: true,
        canAuditAgents: true,
      })),
    } as unknown as ManagedSessionService;
    receipts = [];
    everyday = {
      getProfile: vi.fn(async () => ({ profile: { id: "profile-local" } })),
      listReceipts: vi.fn(async () => receipts),
    } as unknown as EverydayAgentService;
    routineService = {
      getWorkflowCapabilities: () => ({ operations: [] }),
    } as unknown as RoutineService;
  });

  afterEach(async () => {
    manager?.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function definitions(resolveWorkspace?: (id: string) => Promise<Workspace | null>) {
    return createBrowserNavigationDefinitions({
      db,
      agentDaemon: {} as never,
      managedSessionService: managed,
      everydayAgentService: everyday,
      getRoutineService: () => routineService,
      getCronService: () => null,
      resolveWorkspace: resolveWorkspace || (async (id) => workspaceRepository.findById(id)),
    }).definitions;
  }

  async function invoke(defs: ReturnType<typeof definitions>, name: string, args: unknown[] = []) {
    const method = defs[name];
    const validated = method.validate ? method.validate(args) : args;
    return method.handler(validated, {} as never);
  }

  it("registers only exact browser-safe method names and leaves host-only sources gated", () => {
    const defs = definitions();

    expect(defs.everydayAgentGetProfile).toBeDefined();
    expect(defs.generateManagedAgentPlan).toBeDefined();
    expect(defs.createManagedAgentFromPlan).toBeDefined();
    expect(defs.listRoutineWorkflowEventSamples).toBeUndefined();
    expect(defs.getAllHeartbeatStatus).toBeUndefined();
    expect(Object.keys(defs).some((name) => name.toLowerCase().includes("ipc"))).toBe(false);
  });

  it("rejects malformed mutation arguments before dispatching a handler", () => {
    const defs = definitions();
    const createRoutine = defs.createManagedAgentRoutine;
    const handler = vi.spyOn(createRoutine, "handler");

    expect(() =>
      createRoutine.validate!([
        { agentId: "agent-1", name: "Daily", trigger: { type: "schedule", cadenceMinutes: "bad" } },
      ]),
    ).toThrow();
    expect(() =>
      defs.updateManagedAgentRoutine.validate!([{ agentId: "agent-1", name: "Renamed" }]),
    ).toThrow();
    expect(() =>
      defs.everydayAgentPreviewAction.validate!([{ title: "", action: "review" }]),
    ).toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it("requires a saved routine for live workflow tests", async () => {
    const testWorkflow = vi.fn(async () => ({ run: {}, steps: [] }));
    routineService = {
      getWorkflowCapabilities: () => ({ operations: [] }),
      validateWorkflow: () => ({ issues: [] }),
      testWorkflow,
    } as unknown as RoutineService;

    await expect(
      invoke(definitions(), "testRoutineWorkflow", [
        {
          workflow: {
            version: 1,
            starterNodeId: "manual",
            nodes: [
              {
                id: "manual",
                kind: "starter",
                operation: "starter.manual",
                name: "Manual",
                config: {},
              },
            ],
            edges: [],
          },
          dryRun: false,
        },
      ]),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(testWorkflow).not.toHaveBeenCalled();
  });

  it("requires a writable, agent-enabled workspace for live workflow tests", async () => {
    const readOnly = new WorkspaceStore(db).create("Read only", path.join(tempDir, "read-only"), {
      read: true,
      write: false,
      delete: false,
      network: false,
      shell: false,
    });
    const routine = { id: "routine-read-only", workspaceId: readOnly.id };
    const testWorkflow = vi.fn(async () => ({ run: {}, steps: [] }));
    routineService = {
      getWorkflowCapabilities: () => ({ operations: [] }),
      get: vi.fn(async (id: string) => (id === routine.id ? routine : null)),
      validateWorkflow: () => ({ issues: [] }),
      testWorkflow,
    } as unknown as RoutineService;
    const defs = definitions();
    const request = {
      routineId: routine.id,
      workflow: {
        version: 1,
        starterNodeId: "manual",
        nodes: [
          {
            id: "manual",
            kind: "starter",
            operation: "starter.manual",
            name: "Manual",
            config: {},
          },
        ],
        edges: [],
      },
      dryRun: false,
    };

    await expect(invoke(defs, "testRoutineWorkflow", [request])).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(testWorkflow).not.toHaveBeenCalled();

    const writableRoutine = { id: "routine-writable", workspaceId: workspace.id };
    const agentDenied = vi.fn(async () => ({
      canViewAgents: true,
      canRunAgents: false,
      canResumeSessions: true,
      canAnswerApprovals: true,
      canEditDrafts: true,
      canManageEnvironments: true,
      canPublishAgents: true,
      canManageRoutines: true,
      canManageMemberships: true,
      canAuditAgents: true,
    }));
    vi.spyOn(managed, "getMyWorkspacePermissions").mockImplementation(agentDenied);
    routineService = {
      getWorkflowCapabilities: () => ({ operations: [] }),
      get: vi.fn(async (id: string) => (id === writableRoutine.id ? writableRoutine : null)),
      validateWorkflow: () => ({ issues: [] }),
      testWorkflow,
    } as unknown as RoutineService;

    await expect(
      invoke(definitions(), "testRoutineWorkflow", [{ ...request, routineId: writableRoutine.id }]),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(agentDenied).toHaveBeenCalledWith(workspace.id);
    expect(testWorkflow).not.toHaveBeenCalled();
  });

  it("allows a live workflow test through a saved routine in a writable agent-enabled workspace", async () => {
    const routine = { id: "routine-live", workspaceId: workspace.id };
    const testWorkflow = vi.fn(async () => ({ run: { id: "run-1" }, steps: [] }));
    routineService = {
      getWorkflowCapabilities: () => ({ operations: [] }),
      get: vi.fn(async (id: string) => (id === routine.id ? routine : null)),
      validateWorkflow: () => ({ issues: [] }),
      testWorkflow,
    } as unknown as RoutineService;
    const workflow = {
      version: 1,
      starterNodeId: "manual",
      nodes: [
        { id: "manual", kind: "starter", operation: "starter.manual", name: "Manual", config: {} },
      ],
      edges: [],
    };

    await expect(
      invoke(definitions(), "testRoutineWorkflow", [
        { routineId: routine.id, workflow, dryRun: false },
      ]),
    ).resolves.toEqual({ run: { id: "run-1" }, steps: [] });
    expect(testWorkflow).toHaveBeenCalledWith({ routineId: routine.id, workflow, dryRun: false });
  });

  it("returns workspaces and Everyday receipts only inside the effective readable scope", async () => {
    const hidden = new WorkspaceStore(db).create("Hidden", path.join(tempDir, "hidden"), {
      read: true,
      write: true,
      delete: false,
      network: false,
      shell: false,
    });
    receipts = [
      {
        id: "visible",
        profileId: "profile-local",
        workspaceId: workspace.id,
      } as EverydayActionReceipt,
      { id: "hidden", profileId: "profile-local", workspaceId: hidden.id } as EverydayActionReceipt,
      { id: "global", profileId: "profile-local" } as EverydayActionReceipt,
    ];
    const defs = definitions(async (id) =>
      id === hidden.id ? null : workspaceRepository.findById(id),
    );

    await expect(invoke(defs, "listWorkspaces")).resolves.toEqual([
      expect.objectContaining({ id: workspace.id }),
    ]);
    await expect(invoke(defs, "everydayAgentListReceipts")).resolves.toEqual([
      expect.objectContaining({ id: "visible" }),
      expect.objectContaining({ id: "global" }),
    ]);
    await expect(
      invoke(defs, "everydayAgentListReceipts", [{ workspaceId: hidden.id }]),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      invoke(defs, "everydayAgentListReceipts", [{ profileId: "other-profile" }]),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
