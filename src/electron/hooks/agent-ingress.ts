import path from "path";
import * as fs from "fs/promises";
import * as os from "os";
import { AgentDaemon } from "../agent/daemon";
import { Workspace } from "../../shared/types";
import { WorkspaceRepository } from "../database/repositories";
import {
  createScopedTempWorkspaceIdentity,
  sanitizeTempWorkspaceKey,
  TempWorkspaceScope,
} from "../utils/temp-workspace-scope";
import {
  getActiveTempWorkspaceLeases,
  touchTempWorkspaceLease,
} from "../utils/temp-workspace-lease";
import { pruneTempWorkspaces } from "../utils/temp-workspace";
import { HookSessionRepository } from "./HookSessionRepository";
import { TEMP_WORKSPACE_NAME, TEMP_WORKSPACE_ROOT_DIR_NAME } from "../../shared/types";

export interface AgentIngressAction {
  message: string;
  name?: string;
  wakeMode?: "now" | "next-heartbeat";
  sessionKey?: string;
  deliver?: boolean;
  channel?: string;
  to?: string;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
  workspaceId?: string;
}

export interface AgentIngressOptions {
  scope?: TempWorkspaceScope;
  defaultTempWorkspaceKey?: string;
  logger?: (...args: unknown[]) => void;
}

export interface AgentIngressRunOptions {
  tempWorkspaceKey?: string;
}

export interface AgentIngressResult {
  taskId: string;
  workspaceId: string;
  duplicate: boolean;
}

const SESSION_LOCK_TTL_MS = 2 * 60 * 1000;
const SESSION_WAIT_TIMEOUT_MS = 30 * 1000;
const SESSION_WAIT_POLL_MS = 150;

/**
 * Shared task ingress for webhook-style sources.
 * Handles temporary workspace provisioning and session-key idempotency.
 */
export class HookAgentIngress {
  private workspaceRepo: WorkspaceRepository;
  private sessionRepo: HookSessionRepository;
  private tempWorkspaceRoot: string;
  private scope: TempWorkspaceScope;
  private defaultTempWorkspaceKey: string;
  private logger?: (...args: unknown[]) => void;

  constructor(
    private agentDaemon: AgentDaemon,
    options: AgentIngressOptions = {},
  ) {
    const db = agentDaemon.getDatabase();
    this.workspaceRepo = new WorkspaceRepository(db);
    this.sessionRepo = new HookSessionRepository(db);
    this.tempWorkspaceRoot = path.join(os.tmpdir(), TEMP_WORKSPACE_ROOT_DIR_NAME);
    this.scope = options.scope || "hooks";
    this.defaultTempWorkspaceKey = options.defaultTempWorkspaceKey || "default";
    this.logger = options.logger;
  }

  async createTaskFromAgentAction(
    action: AgentIngressAction,
    options: AgentIngressRunOptions = {},
  ): Promise<AgentIngressResult> {
    const message = String(action.message || "").trim();
    if (!message) {
      throw new Error("message required");
    }

    const sessionKey = String(action.sessionKey || "").trim();
    let lockHeld = false;
    if (sessionKey) {
      const existing = this.sessionRepo.findBySessionKey(sessionKey);
      if (existing) {
        const existingTask = this.agentDaemon.getTask(existing.taskId);
        return {
          taskId: existing.taskId,
          workspaceId: existingTask?.workspaceId || action.workspaceId || "",
          duplicate: true,
        };
      }

      lockHeld = this.sessionRepo.acquireLock(sessionKey, SESSION_LOCK_TTL_MS);
      if (!lockHeld) {
        const settled = await this.waitForSessionResolution(sessionKey);
        if (settled) {
          const existingTask = this.agentDaemon.getTask(settled.taskId);
          return {
            taskId: settled.taskId,
            workspaceId: existingTask?.workspaceId || action.workspaceId || "",
            duplicate: true,
          };
        }
        lockHeld = this.sessionRepo.acquireLock(sessionKey, SESSION_LOCK_TTL_MS);
        if (!lockHeld) {
          throw new Error(`Session key "${sessionKey}" is already being processed`);
        }
      }
    }

    try {
      if (sessionKey) {
        const existing = this.sessionRepo.findBySessionKey(sessionKey);
        if (existing) {
          const existingTask = this.agentDaemon.getTask(existing.taskId);
          return {
            taskId: existing.taskId,
            workspaceId: existingTask?.workspaceId || action.workspaceId || "",
            duplicate: true,
          };
        }
      }

      const workspaceId =
        action.workspaceId ||
        (await this.createTempWorkspace(
          options.tempWorkspaceKey || this.defaultTempWorkspaceKey,
        )).id;

      const task = await this.agentDaemon.createTask({
        title: action.name || "Webhook Task",
        prompt: message,
        workspaceId,
        source: "hook",
        agentConfig: {
          allowUserInput: false,
        },
      });

      if (sessionKey) {
        const created = this.sessionRepo.create(sessionKey, task.id);
        if (!created) {
          const existing = this.sessionRepo.findBySessionKey(sessionKey);
          if (existing) {
            this.logger?.(
              "[HookIngress] Session key already mapped; returning existing task",
              sessionKey,
              existing.taskId,
            );
            if (existing.taskId !== task.id) {
              void this.agentDaemon.cancelTask(task.id).catch((error) => {
                this.logger?.("[HookIngress] Failed to cancel duplicate task:", task.id, error);
              });
            }
            const existingTask = this.agentDaemon.getTask(existing.taskId);
            return {
              taskId: existing.taskId,
              workspaceId: existingTask?.workspaceId || workspaceId,
              duplicate: true,
            };
          }
          throw new Error(`Failed to persist session mapping for "${sessionKey}"`);
        }
      }

      return {
        taskId: task.id,
        workspaceId,
        duplicate: false,
      };
    } finally {
      if (lockHeld && sessionKey) {
        this.sessionRepo.releaseLock(sessionKey);
      }
    }
  }

  private async createTempWorkspace(key: string): Promise<Workspace> {
    await fs.mkdir(this.tempWorkspaceRoot, { recursive: true });

    const identity = createScopedTempWorkspaceIdentity(this.scope, sanitizeTempWorkspaceKey(key));
    const workspacePath = path.join(this.tempWorkspaceRoot, identity.slug);
    await fs.mkdir(workspacePath, { recursive: true });

    const now = Date.now();
    const permissions: Workspace["permissions"] = {
      read: true,
      write: true,
      delete: true,
      network: true,
      shell: false,
      unrestrictedFileAccess: true,
    };

    const db = this.agentDaemon.getDatabase();
    db.prepare(`
      INSERT INTO workspaces (id, name, path, created_at, last_used_at, permissions)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        path = excluded.path,
        last_used_at = excluded.last_used_at,
        permissions = excluded.permissions
    `).run(
      identity.workspaceId,
      TEMP_WORKSPACE_NAME,
      workspacePath,
      now,
      now,
      JSON.stringify(permissions),
    );

    const workspace = this.workspaceRepo.findById(identity.workspaceId) ?? {
      id: identity.workspaceId,
      name: TEMP_WORKSPACE_NAME,
      path: workspacePath,
      createdAt: now,
      lastUsedAt: now,
      permissions,
      isTemp: true,
    };

    try {
      pruneTempWorkspaces({
        db,
        tempWorkspaceRoot: this.tempWorkspaceRoot,
        currentWorkspaceId: workspace.id,
        protectedWorkspaceIds: getActiveTempWorkspaceLeases(),
      });
    } catch (error) {
      this.logger?.("[HookIngress] Failed to prune temp workspaces:", error);
    }

    touchTempWorkspaceLease(workspace.id);
    return workspace;
  }

  private async waitForSessionResolution(sessionKey: string): Promise<{ taskId: string } | null> {
    const deadline = Date.now() + SESSION_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const existing = this.sessionRepo.findBySessionKey(sessionKey);
      if (existing) {
        return { taskId: existing.taskId };
      }
      await new Promise((resolve) => setTimeout(resolve, SESSION_WAIT_POLL_MS));
    }
    const existing = this.sessionRepo.findBySessionKey(sessionKey);
    return existing ? { taskId: existing.taskId } : null;
  }
}

let sharedIngress: HookAgentIngress | null = null;

export function initializeHookAgentIngress(
  agentDaemon: AgentDaemon,
  options?: AgentIngressOptions,
): HookAgentIngress {
  if (sharedIngress) return sharedIngress;
  sharedIngress = new HookAgentIngress(agentDaemon, options);
  return sharedIngress;
}

export function getHookAgentIngress(): HookAgentIngress | null {
  return sharedIngress;
}
