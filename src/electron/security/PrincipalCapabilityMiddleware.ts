import {
  ApprovalRepository,
  ArtifactRepository,
  InputRequestRepository,
} from "../database/repository-facades";
import type Database from "better-sqlite3";
import type {
  SessionActionAttribution,
  SessionHumanCapability,
  SessionMembersRequest,
} from "../../shared/types";

import { SessionMembershipService } from "../workspaces/workspaces-repository-facades";

/**
 * Transport-neutral authorization boundary.
 *
 * Every transport (Electron IPC, Control Plane, CLI and channel adapters) can
 * use this class with the same principal and capability vocabulary.  It never
 * accepts a principal supplied by an untrusted request payload; the caller
 * must provide an already-authenticated principal or a bound client key.
 */
export class PrincipalCapabilityMiddleware {
  private readonly approvals: ApprovalRepository;
  private readonly inputs: InputRequestRepository;
  private readonly artifacts: ArtifactRepository;

  constructor(
    private readonly db: Database.Database,
    private readonly memberships: SessionMembershipService = new SessionMembershipService(db),
  ) {
    this.approvals = new ApprovalRepository(db);
    this.inputs = new InputRequestRepository(db);
    this.artifacts = new ArtifactRepository(db);
  }

  get membership(): SessionMembershipService {
    return this.memberships;
  }

  bindClient(clientId: number, principalId: string, source: "trusted" | "invite" = "trusted") {
    // SessionMembershipService owns the authenticated client binding. The
    // source label is retained at this boundary for transport callers but is
    // not persisted until invite-aware client bindings are introduced.
    void source;
    this.memberships.registerClientPrincipal(clientId, principalId);
  }

  principalForClient(clientId: number, options?: { trustedPrincipalId?: string }): string {
    if (options?.trustedPrincipalId) {
      this.bindClient(clientId, options.trustedPrincipalId, "trusted");
      return options.trustedPrincipalId;
    }
    return this.memberships.principalForClient(clientId);
  }

  async authorizeTask(
    taskId: string,
    capability: SessionHumanCapability,
    principalId: string,
  ): Promise<{ contextId: string; actor: SessionActionAttribution }> {
    return this.memberships.authorizeTaskAction(taskId, capability, principalId);
  }

  async authorizeContext(
    contextId: string,
    capability: SessionHumanCapability,
    principalId: string,
  ): Promise<SessionActionAttribution> {
    return this.memberships.authorizeContextAction(contextId, capability, principalId);
  }

  async authorizeApproval(
    approvalId: string,
    capability: SessionHumanCapability,
    principalId: string,
  ) {
    const approval = await this.approvals.findById(approvalId);
    if (!approval) throw new Error("Approval request not found.");
    await this.authorizeTask(approval.taskId, capability, principalId);
    return approval;
  }

  async authorizeInputRequest(
    requestId: string,
    capability: SessionHumanCapability,
    principalId: string,
  ) {
    const request = await this.inputs.findById(requestId);
    if (!request) throw new Error("Input request not found.");
    await this.authorizeTask(request.taskId, capability, principalId);
    return request;
  }

  async authorizeArtifact(
    artifactId: string,
    capability: SessionHumanCapability,
    principalId: string,
  ) {
    const artifact = await this.artifacts.findById(artifactId);
    if (!artifact) throw new Error("Artifact not found.");
    await this.authorizeTask(artifact.taskId, capability, principalId);
    return artifact;
  }

  async authorizeManagedSession(
    sessionId: string,
    capability: SessionHumanCapability,
    principalId: string,
  ): Promise<SessionActionAttribution> {
    // The context lookup and the check share one unit.
    return this.memberships.authorizeManagedSessionAction(sessionId, capability, principalId);
  }

  async authorizeTaskIds(
    taskIds: string[],
    capability: SessionHumanCapability,
    principalId: string,
  ): Promise<string[]> {
    const authorized: string[] = [];
    for (const taskId of taskIds) {
      try {
        await this.authorizeTask(taskId, capability, principalId);
        authorized.push(taskId);
      } catch {
        // A list operation is intentionally filtered rather than leaking the
        // existence of a task in a session the principal cannot view.
      }
    }
    return authorized;
  }

  async filterTasks<T extends { id: string }>(
    tasks: T[],
    capability: SessionHumanCapability,
    principalId: string,
  ): Promise<T[]> {
    const local = this.memberships.getLocalPrincipal().principalId;
    if (principalId === local) return tasks;
    // Authorization reads the task through the async storage facade: await each check,
    // and keep a task only when its check resolves.
    const allowed = await Promise.all(
      tasks.map((task) =>
        this.authorizeTask(task.id, capability, principalId).then(
          () => true,
          () => false,
        ),
      ),
    );
    return tasks.filter((_task, index) => allowed[index]);
  }

  /**
   * Authorize before applying pagination.  Filtering a database page after
   * offset/limit can both hide authorized rows and disclose an unauthorized
   * row count.  Transports provide their existing repository query as a page
   * loader so ordering, cursors, and archive/source predicates remain
   * unchanged.
   */
  async filterAndPaginateTasks<T extends { id: string }>(
    loadPage: (limit: number, offset: number) => T[],
    capability: SessionHumanCapability,
    principalId: string,
    limit: number,
    offset: number,
  ): Promise<{ tasks: T[]; total?: number }> {
    const safeLimit = Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 100));
    const safeOffset = Math.max(0, Math.floor(Number.isFinite(offset) ? offset : 0));
    const local = this.memberships.getLocalPrincipal().principalId;

    // Preserve the fast path for the local owner.  Local-owner totals are
    // already governed by the desktop process and do not reveal another
    // principal's private tasks.
    if (principalId === local) {
      return { tasks: loadPage(safeLimit, safeOffset) };
    }

    const pageSize = Math.max(100, Math.min(500, safeLimit));
    const visible: T[] = [];
    const seen = new Set<string>();
    let scanOffset = 0;

    while (true) {
      const page = loadPage(pageSize, scanOffset);
      if (page.length === 0) break;

      let newRows = 0;
      for (const task of page) {
        if (seen.has(task.id)) continue;
        seen.add(task.id);
        newRows += 1;
        try {
          await this.authorizeTask(task.id, capability, principalId);
          visible.push(task);
        } catch {
          // Filtering is intentional: list operations must not disclose
          // task existence to a principal without the requested capability.
        }
      }

      scanOffset += page.length;
      // A defensive duplicate-page guard prevents a broken/mock loader from
      // spinning forever while still returning the rows already authorized.
      if (page.length < pageSize || newRows === 0) break;
    }

    return {
      tasks: visible.slice(safeOffset, safeOffset + safeLimit),
      total: visible.length,
    };
  }

  async authorizeSessionRequest(
    request: SessionMembersRequest,
    capability: SessionHumanCapability,
    principalId: string,
  ): Promise<SessionActionAttribution> {
    if ("contextId" in request && request.contextId) {
      return this.authorizeContext(request.contextId, capability, principalId);
    }
    if ("taskId" in request && request.taskId) {
      return (await this.authorizeTask(request.taskId, capability, principalId)).actor;
    }
    throw new Error("contextId or taskId is required");
  }

  /** Global controls are local-owner-only until a context is supplied. */
  authorizeGlobalManage(principalId: string): void {
    const local = this.memberships.getLocalPrincipal();
    if (principalId !== local.principalId) {
      throw new Error("Only the local owner can manage global security controls.");
    }
  }
}

export function getRequestPrincipalId(
  middleware: PrincipalCapabilityMiddleware,
  clientId: number,
  trustedPrincipalId?: string,
): string {
  return middleware.principalForClient(clientId, { trustedPrincipalId });
}
