import type Database from "better-sqlite3";
import { TaskRepository, WorkspaceRepository } from "../../electron/database/repository-facades";
import type { Workspace } from "../../shared/types";
import { isTempWorkspaceId } from "../../shared/types";
import { WebApplicationError, type WebRpcMethod } from "../web/WebApplication";

type RecordLike = Record<string, unknown>;

export interface BrowserReadSources {
  listWorkspaces: () => Promise<RecordLike[]>;
  listTasks: (params: ListParams) => Promise<RecordLike[]>;
  getTask: (id: string) => Promise<RecordLike | null>;
}

export function createDatabaseBrowserReadSources(
  db: Database.Database,
  resolveWorkspace?: (id: string) => Promise<Workspace | null>,
): BrowserReadSources {
  const tasks = new TaskRepository(db);
  const workspaces = new WorkspaceRepository(db);
  const readable = async (id: string) =>
    !resolveWorkspace || Boolean((await resolveWorkspace(id))?.permissions.read);
  return {
    listWorkspaces: async () => {
      const rows = await workspaces.findAll();
      const allowed = await Promise.all(rows.map((row) => readable(row.id)));
      return rows.filter((_row, index) => allowed[index]) as unknown as RecordLike[];
    },
    listTasks: async ({ limit, offset, workspaceId }) => {
      if (workspaceId) {
        if (!(await readable(workspaceId))) return [];
        return (await tasks.findSidebarSummaries(limit + 1, offset, {
          workspaceId,
          includeArchivedSessions: false,
        })) as unknown as RecordLike[];
      }
      // Filter before applying the browser's offset, preserving the repository's stable order.
      const ids = new Set((await workspaces.findAll()).map((row) => row.id));
      const allowed = new Set(
        (await Promise.all([...ids].map(async (id) => ((await readable(id)) ? id : null)))).filter(
          (id): id is string => id !== null,
        ),
      );
      const collected = [];
      let cursor = 0;
      while (collected.length < offset + limit + 1 && allowed.size) {
        const page = await tasks.findAll(500, cursor, { includeArchivedSessions: false });
        collected.push(...page.filter((row) => allowed.has(row.workspaceId)));
        if (page.length < 500) break;
        cursor += page.length;
      }
      return collected.slice(offset, offset + limit + 1) as unknown as RecordLike[];
    },
    getTask: async (id) => {
      const task = await tasks.findById(id);
      return task && (await readable(task.workspaceId)) ? (task as unknown as RecordLike) : null;
    },
  };
}

/** Browser reads are intentionally field-selected; storage records contain local paths and prompts. */
export function createBrowserReadMethods(
  sources: BrowserReadSources,
): Record<string, WebRpcMethod> {
  return {
    "workspace.list": {
      capability: "workspaces.read",
      handler: async () => ({
        workspaces: (await sources.listWorkspaces())
          .filter(
            (workspace) =>
              workspace.isTemp !== true && !isTempWorkspaceId(String(workspace.id ?? "")),
          )
          .map(toPublicWorkspace),
      }),
    },
    "task.list": {
      capability: "tasks.read",
      validateParams: parseListParams,
      handler: async (_context, params) => {
        const { limit, offset, workspaceId } = params as ListParams;
        const tasks = await sources.listTasks({ limit, offset, workspaceId });
        return {
          tasks: tasks.slice(0, limit).map(toPublicTask),
          hasMore: tasks.length > limit,
          limit,
          offset,
        };
      },
    },
    "task.get": {
      capability: "tasks.read",
      validateParams: parseTaskId,
      handler: async (_context, params) => ({
        task: toPublicTaskOrNull(await sources.getTask((params as { taskId: string }).taskId)),
      }),
    },
  };
}

interface ListParams {
  limit: number;
  offset: number;
  workspaceId: string | null;
}

function parseListParams(value: unknown): ListParams {
  if (!isRecord(value)) throw invalidParams();
  const limit = value.limit === undefined ? 50 : value.limit;
  const offset = value.offset === undefined ? 0 : value.offset;
  const workspaceId =
    value.workspaceId === undefined || value.workspaceId === null ? null : value.workspaceId;
  if (
    !Number.isInteger(limit) ||
    Number(limit) < 1 ||
    Number(limit) > 100 ||
    !Number.isInteger(offset) ||
    Number(offset) < 0 ||
    Number(offset) > 100_000
  ) {
    throw invalidParams();
  }
  if (workspaceId !== null && (typeof workspaceId !== "string" || workspaceId.length > 128))
    throw invalidParams();
  return {
    limit: Number(limit),
    offset: Number(offset),
    workspaceId: workspaceId as string | null,
  };
}

function parseTaskId(value: unknown): { taskId: string } {
  if (
    !isRecord(value) ||
    typeof value.taskId !== "string" ||
    value.taskId.length < 1 ||
    value.taskId.length > 128
  ) {
    throw invalidParams();
  }
  return { taskId: value.taskId };
}

function invalidParams(): WebApplicationError {
  return new WebApplicationError("INVALID_REQUEST", "Invalid browser read parameters.", 400);
}

function isRecord(value: unknown): value is RecordLike {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toPublicWorkspace(workspace: RecordLike): RecordLike {
  return pick(workspace, ["id", "name", "createdAt", "lastUsedAt"]);
}

function toPublicTaskOrNull(task: RecordLike | null): RecordLike | null {
  return task ? toPublicTask(task) : null;
}

function toPublicTask(task: RecordLike): RecordLike {
  return pick(task, [
    "id",
    "title",
    "status",
    "workspaceId",
    "createdAt",
    "updatedAt",
    "completedAt",
    "parentTaskId",
    "agentType",
    "depth",
    "assignedAgentRoleId",
    "boardColumn",
    "priority",
    "labels",
    "dueDate",
    "pinned",
    "sessionArchived",
    "sessionId",
    "source",
  ]);
}

function pick(source: RecordLike, keys: readonly string[]): RecordLike {
  return Object.fromEntries(
    keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
  );
}
