/**
 * Contract tests for Agent Teams repositories.
 *
 * These tests use in-memory mocks (no better-sqlite3) to match the existing
 * repository test style in this codebase.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type {
  AgentTeam,
  AgentTeamMember,
  AgentTeamRun,
  AgentTeamItem,
  CreateAgentTeamRequest,
  UpdateAgentTeamRequest,
  CreateAgentTeamMemberRequest,
  UpdateAgentTeamMemberRequest,
  CreateAgentTeamRunRequest,
  AgentTeamRunStatus,
  CreateAgentTeamItemRequest,
  UpdateAgentTeamItemRequest,
} from "../../../shared/types";

// Mock electron to avoid getPath errors in other imports
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp/test-cowork"),
  },
}));

let mockTeams: Map<string, Any>;
let mockMembers: Map<string, Any>;
let mockRuns: Map<string, Any>;
let mockItems: Map<string, Any>;

let teamIdCounter: number;
let memberIdCounter: number;
let runIdCounter: number;
let itemIdCounter: number;

class MockAgentTeamRepository {
  create(request: CreateAgentTeamRequest): AgentTeam {
    // Enforce UNIQUE(workspace_id, name)
    for (const stored of mockTeams.values()) {
      if (stored.workspace_id === request.workspaceId && stored.name === request.name) {
        throw new Error("UNIQUE constraint failed: agent_teams.workspace_id, agent_teams.name");
      }
    }

    const id = `team-${++teamIdCounter}`;
    const now = Date.now();

    const team: AgentTeam = {
      id,
      workspaceId: request.workspaceId,
      name: request.name,
      description: request.description,
      leadAgentRoleId: request.leadAgentRoleId,
      maxParallelAgents: request.maxParallelAgents ?? 4,
      defaultModelPreference: request.defaultModelPreference,
      defaultPersonality: request.defaultPersonality,
      isActive: request.isActive ?? true,
      createdAt: now,
      updatedAt: now,
    };

    mockTeams.set(id, {
      id,
      workspace_id: team.workspaceId,
      name: team.name,
      description: team.description ?? null,
      lead_agent_role_id: team.leadAgentRoleId,
      max_parallel_agents: team.maxParallelAgents,
      default_model_preference: team.defaultModelPreference ?? null,
      default_personality: team.defaultPersonality ?? null,
      is_active: team.isActive ? 1 : 0,
      created_at: team.createdAt,
      updated_at: team.updatedAt,
    });

    return team;
  }

  findById(id: string): AgentTeam | undefined {
    const stored = mockTeams.get(id);
    return stored ? this.mapRowToTeam(stored) : undefined;
  }

  findByName(workspaceId: string, name: string): AgentTeam | undefined {
    for (const stored of mockTeams.values()) {
      if (stored.workspace_id === workspaceId && stored.name === name) {
        return this.mapRowToTeam(stored);
      }
    }
    return undefined;
  }

  listByWorkspace(workspaceId: string, includeInactive = false): AgentTeam[] {
    const teams: AgentTeam[] = [];
    mockTeams.forEach((stored) => {
      if (stored.workspace_id !== workspaceId) return;
      if (!includeInactive && stored.is_active !== 1) return;
      teams.push(this.mapRowToTeam(stored));
    });
    return teams.sort((a, b) => a.name.localeCompare(b.name));
  }

  update(request: UpdateAgentTeamRequest): AgentTeam | undefined {
    const stored = mockTeams.get(request.id);
    if (!stored) return undefined;

    // Name uniqueness check within workspace when renaming
    if (request.name !== undefined && request.name !== stored.name) {
      for (const other of mockTeams.values()) {
        if (
          other.id !== stored.id &&
          other.workspace_id === stored.workspace_id &&
          other.name === request.name
        ) {
          throw new Error("UNIQUE constraint failed: agent_teams.workspace_id, agent_teams.name");
        }
      }
    }

    if (request.name !== undefined) stored.name = request.name;
    if (request.description !== undefined) stored.description = request.description;
    if (request.leadAgentRoleId !== undefined) stored.lead_agent_role_id = request.leadAgentRoleId;
    if (request.maxParallelAgents !== undefined)
      stored.max_parallel_agents = request.maxParallelAgents;
    if (request.defaultModelPreference !== undefined)
      stored.default_model_preference = request.defaultModelPreference;
    if (request.defaultPersonality !== undefined)
      stored.default_personality = request.defaultPersonality;
    if (request.isActive !== undefined) stored.is_active = request.isActive ? 1 : 0;
    stored.updated_at = Date.now();

    mockTeams.set(request.id, stored);
    return this.findById(request.id);
  }

  delete(id: string): boolean {
    if (!mockTeams.has(id)) return false;

    // Manual cascade: items -> runs -> members -> team
    const runIds: string[] = [];
    for (const run of mockRuns.values()) {
      if (run.team_id === id) runIds.push(run.id);
    }

    for (const [itemId, item] of mockItems) {
      if (runIds.includes(item.team_run_id)) {
        mockItems.delete(itemId);
      }
    }

    for (const [runId, run] of mockRuns) {
      if (run.team_id === id) mockRuns.delete(runId);
    }

    for (const [memberId, member] of mockMembers) {
      if (member.team_id === id) mockMembers.delete(memberId);
    }

    return mockTeams.delete(id);
  }

  private mapRowToTeam(row: Any): AgentTeam {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      description: row.description ?? undefined,
      leadAgentRoleId: row.lead_agent_role_id,
      maxParallelAgents: row.max_parallel_agents,
      defaultModelPreference: row.default_model_preference ?? undefined,
      defaultPersonality: row.default_personality ?? undefined,
      isActive: row.is_active === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

class MockAgentTeamMemberRepository {
  add(request: CreateAgentTeamMemberRequest): AgentTeamMember {
    const existing = this.findByTeamAndRole(request.teamId, request.agentRoleId);
    if (existing) return existing;

    const id = `member-${++memberIdCounter}`;
    const now = Date.now();
    const member: AgentTeamMember = {
      id,
      teamId: request.teamId,
      agentRoleId: request.agentRoleId,
      memberOrder: request.memberOrder ?? 0,
      isRequired: request.isRequired ?? false,
      roleGuidance: request.roleGuidance,
      createdAt: now,
    };

    mockMembers.set(id, {
      id,
      team_id: member.teamId,
      agent_role_id: member.agentRoleId,
      member_order: member.memberOrder,
      is_required: member.isRequired ? 1 : 0,
      role_guidance: member.roleGuidance ?? null,
      created_at: member.createdAt,
    });

    return member;
  }

  findById(id: string): AgentTeamMember | undefined {
    const stored = mockMembers.get(id);
    return stored ? this.mapRowToMember(stored) : undefined;
  }

  findByTeamAndRole(teamId: string, agentRoleId: string): AgentTeamMember | undefined {
    for (const stored of mockMembers.values()) {
      if (stored.team_id === teamId && stored.agent_role_id === agentRoleId) {
        return this.mapRowToMember(stored);
      }
    }
    return undefined;
  }

  listByTeam(teamId: string): AgentTeamMember[] {
    const members: AgentTeamMember[] = [];
    mockMembers.forEach((stored) => {
      if (stored.team_id === teamId) {
        members.push(this.mapRowToMember(stored));
      }
    });
    return members.sort((a, b) => a.memberOrder - b.memberOrder);
  }

  update(request: UpdateAgentTeamMemberRequest): AgentTeamMember | undefined {
    const stored = mockMembers.get(request.id);
    if (!stored) return undefined;

    if (request.memberOrder !== undefined) stored.member_order = request.memberOrder;
    if (request.isRequired !== undefined) stored.is_required = request.isRequired ? 1 : 0;
    if (request.roleGuidance !== undefined) stored.role_guidance = request.roleGuidance;

    mockMembers.set(request.id, stored);
    return this.findById(request.id);
  }

  remove(id: string): boolean {
    return mockMembers.delete(id);
  }

  private mapRowToMember(row: Any): AgentTeamMember {
    return {
      id: row.id,
      teamId: row.team_id,
      agentRoleId: row.agent_role_id,
      memberOrder: row.member_order,
      isRequired: row.is_required === 1,
      roleGuidance: row.role_guidance ?? undefined,
      createdAt: row.created_at,
    };
  }
}

class MockAgentTeamRunRepository {
  create(request: CreateAgentTeamRunRequest): AgentTeamRun {
    const id = `run-${++runIdCounter}`;
    const now = Date.now();
    const run: AgentTeamRun = {
      id,
      teamId: request.teamId,
      rootTaskId: request.rootTaskId,
      status: request.status ?? "pending",
      startedAt: request.startedAt ?? now,
      completedAt: undefined,
      error: undefined,
      summary: undefined,
    };

    mockRuns.set(id, {
      id,
      team_id: run.teamId,
      root_task_id: run.rootTaskId,
      status: run.status,
      started_at: run.startedAt,
      completed_at: null,
      error: null,
      summary: null,
    });

    return run;
  }

  findById(id: string): AgentTeamRun | undefined {
    const stored = mockRuns.get(id);
    return stored ? this.mapRowToRun(stored) : undefined;
  }

  listByTeam(teamId: string): AgentTeamRun[] {
    const runs: AgentTeamRun[] = [];
    mockRuns.forEach((stored) => {
      if (stored.team_id === teamId) runs.push(this.mapRowToRun(stored));
    });
    return runs.sort((a, b) => b.startedAt - a.startedAt);
  }

  update(
    id: string,
    updates: {
      status?: AgentTeamRunStatus;
      completedAt?: number | null;
      error?: string | null;
      summary?: string | null;
    },
  ): AgentTeamRun | undefined {
    const stored = mockRuns.get(id);
    if (!stored) return undefined;

    if (updates.status !== undefined) {
      stored.status = updates.status;
      if (
        (updates.status === "completed" ||
          updates.status === "failed" ||
          updates.status === "cancelled") &&
        updates.completedAt === undefined
      ) {
        stored.completed_at = Date.now();
      }
    }
    if (updates.completedAt !== undefined) stored.completed_at = updates.completedAt;
    if (updates.error !== undefined) stored.error = updates.error;
    if (updates.summary !== undefined) stored.summary = updates.summary;

    mockRuns.set(id, stored);
    return this.findById(id);
  }

  private mapRowToRun(row: Any): AgentTeamRun {
    return {
      id: row.id,
      teamId: row.team_id,
      rootTaskId: row.root_task_id,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
      error: row.error ?? undefined,
      summary: row.summary ?? undefined,
    };
  }
}

class MockAgentTeamItemRepository {
  create(request: CreateAgentTeamItemRequest): AgentTeamItem {
    const id = `item-${++itemIdCounter}`;
    const now = Date.now();
    const item: AgentTeamItem = {
      id,
      teamRunId: request.teamRunId,
      parentItemId: request.parentItemId,
      title: request.title,
      description: request.description,
      ownerAgentRoleId: request.ownerAgentRoleId,
      sourceTaskId: request.sourceTaskId,
      status: request.status ?? "todo",
      resultSummary: undefined,
      sortOrder: request.sortOrder ?? 0,
      createdAt: now,
      updatedAt: now,
    };

    mockItems.set(id, {
      id,
      team_run_id: item.teamRunId,
      parent_item_id: item.parentItemId ?? null,
      title: item.title,
      description: item.description ?? null,
      owner_agent_role_id: item.ownerAgentRoleId ?? null,
      source_task_id: item.sourceTaskId ?? null,
      status: item.status,
      result_summary: null,
      sort_order: item.sortOrder,
      created_at: item.createdAt,
      updated_at: item.updatedAt,
    });

    return item;
  }

  listByRun(teamRunId: string): AgentTeamItem[] {
    const items: AgentTeamItem[] = [];
    mockItems.forEach((stored) => {
      if (stored.team_run_id === teamRunId) items.push(this.mapRowToItem(stored));
    });
    return items.sort((a, b) => a.sortOrder - b.sortOrder);
  }

  findById(id: string): AgentTeamItem | undefined {
    const stored = mockItems.get(id);
    return stored ? this.mapRowToItem(stored) : undefined;
  }

  update(request: UpdateAgentTeamItemRequest): AgentTeamItem | undefined {
    const stored = mockItems.get(request.id);
    if (!stored) return undefined;

    if (request.parentItemId !== undefined) stored.parent_item_id = request.parentItemId;
    if (request.title !== undefined) stored.title = request.title;
    if (request.description !== undefined) stored.description = request.description;
    if (request.ownerAgentRoleId !== undefined)
      stored.owner_agent_role_id = request.ownerAgentRoleId;
    if (request.sourceTaskId !== undefined) stored.source_task_id = request.sourceTaskId;
    if (request.status !== undefined) stored.status = request.status;
    if (request.resultSummary !== undefined) stored.result_summary = request.resultSummary;
    if (request.sortOrder !== undefined) stored.sort_order = request.sortOrder;
    stored.updated_at = Date.now();

    mockItems.set(request.id, stored);
    return this.findById(request.id);
  }

  delete(id: string): boolean {
    return mockItems.delete(id);
  }

  setResultSummaryBySourceTaskId(sourceTaskId: string, resultSummary: string | null): number {
    let changes = 0;
    for (const [id, stored] of mockItems) {
      if (stored.source_task_id === sourceTaskId) {
        stored.result_summary = resultSummary;
        stored.updated_at = Date.now();
        mockItems.set(id, stored);
        changes++;
      }
    }
    return changes;
  }

  private mapRowToItem(row: Any): AgentTeamItem {
    return {
      id: row.id,
      teamRunId: row.team_run_id,
      parentItemId: row.parent_item_id ?? undefined,
      title: row.title,
      description: row.description ?? undefined,
      ownerAgentRoleId: row.owner_agent_role_id ?? undefined,
      sourceTaskId: row.source_task_id ?? undefined,
      status: row.status,
      resultSummary: row.result_summary ?? undefined,
      sortOrder: row.sort_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

describe("Agent Teams repositories (contract)", () => {
  let teamRepo: MockAgentTeamRepository;
  let memberRepo: MockAgentTeamMemberRepository;
  let runRepo: MockAgentTeamRunRepository;
  let itemRepo: MockAgentTeamItemRepository;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

    mockTeams = new Map();
    mockMembers = new Map();
    mockRuns = new Map();
    mockItems = new Map();

    teamIdCounter = 0;
    memberIdCounter = 0;
    runIdCounter = 0;
    itemIdCounter = 0;

    teamRepo = new MockAgentTeamRepository();
    memberRepo = new MockAgentTeamMemberRepository();
    runRepo = new MockAgentTeamRunRepository();
    itemRepo = new MockAgentTeamItemRepository();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("AgentTeamRepository", () => {
    it("creates a team with defaults", () => {
      const team = teamRepo.create({
        workspaceId: "ws-1",
        name: "Core Team",
        leadAgentRoleId: "role-lead",
      });

      expect(team.id).toBeDefined();
      expect(team.workspaceId).toBe("ws-1");
      expect(team.name).toBe("Core Team");
      expect(team.maxParallelAgents).toBe(4);
      expect(team.isActive).toBe(true);
      expect(team.createdAt).toBeGreaterThan(0);
      expect(team.updatedAt).toBe(team.createdAt);
    });

    it("enforces unique team name within workspace", () => {
      teamRepo.create({ workspaceId: "ws-1", name: "Team A", leadAgentRoleId: "lead-1" });

      expect(() =>
        teamRepo.create({ workspaceId: "ws-1", name: "Team A", leadAgentRoleId: "lead-2" }),
      ).toThrow(/UNIQUE constraint failed/);

      // Same name in a different workspace should be fine
      expect(() =>
        teamRepo.create({ workspaceId: "ws-2", name: "Team A", leadAgentRoleId: "lead-3" }),
      ).not.toThrow();
    });

    it("lists by workspace and filters inactive by default", () => {
      teamRepo.create({ workspaceId: "ws-1", name: "B", leadAgentRoleId: "lead" });
      const inactive = teamRepo.create({
        workspaceId: "ws-1",
        name: "A",
        leadAgentRoleId: "lead",
        isActive: false,
      });

      const activeOnly = teamRepo.listByWorkspace("ws-1");
      expect(activeOnly.map((t) => t.id)).not.toContain(inactive.id);

      const allTeams = teamRepo.listByWorkspace("ws-1", true);
      expect(allTeams).toHaveLength(2);
      expect(allTeams[0].name).toBe("A"); // Sorted by name
    });

    it("updates team fields and bumps updatedAt", () => {
      const team = teamRepo.create({ workspaceId: "ws-1", name: "Team", leadAgentRoleId: "lead" });

      vi.advanceTimersByTime(5);
      const updated = teamRepo.update({
        id: team.id,
        description: "Updated description",
        maxParallelAgents: 8,
        isActive: false,
      });

      expect(updated?.description).toBe("Updated description");
      expect(updated?.maxParallelAgents).toBe(8);
      expect(updated?.isActive).toBe(false);
      expect(updated?.updatedAt).toBeGreaterThan(team.updatedAt);
    });

    it("deletes a team and cascades to members, runs, and items", () => {
      const team = teamRepo.create({ workspaceId: "ws-1", name: "Team", leadAgentRoleId: "lead" });
      memberRepo.add({ teamId: team.id, agentRoleId: "role-1" });
      const run = runRepo.create({ teamId: team.id, rootTaskId: "task-root" });
      itemRepo.create({ teamRunId: run.id, title: "Checklist item", sourceTaskId: "task-1" });

      expect(memberRepo.listByTeam(team.id)).toHaveLength(1);
      expect(runRepo.listByTeam(team.id)).toHaveLength(1);
      expect(itemRepo.listByRun(run.id)).toHaveLength(1);

      const deleted = teamRepo.delete(team.id);
      expect(deleted).toBe(true);

      expect(teamRepo.findById(team.id)).toBeUndefined();
      expect(memberRepo.listByTeam(team.id)).toHaveLength(0);
      expect(runRepo.listByTeam(team.id)).toHaveLength(0);
      expect(itemRepo.listByRun(run.id)).toHaveLength(0);
    });
  });

  describe("AgentTeamMemberRepository", () => {
    it("add is idempotent for the same team + agent role", () => {
      const team = teamRepo.create({ workspaceId: "ws-1", name: "Team", leadAgentRoleId: "lead" });

      const m1 = memberRepo.add({ teamId: team.id, agentRoleId: "role-1", memberOrder: 2 });
      const m2 = memberRepo.add({ teamId: team.id, agentRoleId: "role-1", memberOrder: 5 });

      expect(m2.id).toBe(m1.id);
      expect(memberRepo.listByTeam(team.id)).toHaveLength(1);
      expect(memberRepo.listByTeam(team.id)[0].memberOrder).toBe(2);
    });

    it("lists members ordered by memberOrder", () => {
      const team = teamRepo.create({ workspaceId: "ws-1", name: "Team", leadAgentRoleId: "lead" });

      memberRepo.add({ teamId: team.id, agentRoleId: "role-b", memberOrder: 20 });
      memberRepo.add({ teamId: team.id, agentRoleId: "role-a", memberOrder: 10 });

      const members = memberRepo.listByTeam(team.id);
      expect(members.map((m) => m.agentRoleId)).toEqual(["role-a", "role-b"]);
    });
  });

  describe("AgentTeamRunRepository", () => {
    it("creates runs with defaults", () => {
      const team = teamRepo.create({ workspaceId: "ws-1", name: "Team", leadAgentRoleId: "lead" });
      const run = runRepo.create({ teamId: team.id, rootTaskId: "task-root" });

      expect(run.status).toBe("pending");
      expect(run.startedAt).toBeGreaterThan(0);
      expect(run.completedAt).toBeUndefined();
    });

    it("sets completedAt automatically when moving to a terminal status", () => {
      const team = teamRepo.create({ workspaceId: "ws-1", name: "Team", leadAgentRoleId: "lead" });
      const run = runRepo.create({ teamId: team.id, rootTaskId: "task-root" });

      vi.advanceTimersByTime(1000);
      const updated = runRepo.update(run.id, { status: "completed" });

      expect(updated?.status).toBe("completed");
      expect(updated?.completedAt).toBeGreaterThan(run.startedAt);
    });
  });

  describe("AgentTeamItemRepository", () => {
    it("creates items with defaults and lists ordered by sortOrder", () => {
      const team = teamRepo.create({ workspaceId: "ws-1", name: "Team", leadAgentRoleId: "lead" });
      const run = runRepo.create({ teamId: team.id, rootTaskId: "task-root" });

      itemRepo.create({ teamRunId: run.id, title: "B", sortOrder: 10 });
      itemRepo.create({ teamRunId: run.id, title: "A", sortOrder: 5 });

      const items = itemRepo.listByRun(run.id);
      expect(items.map((i) => i.title)).toEqual(["A", "B"]);
      expect(items[0].status).toBe("todo");
    });

    it("updates items and bumps updatedAt", () => {
      const team = teamRepo.create({ workspaceId: "ws-1", name: "Team", leadAgentRoleId: "lead" });
      const run = runRepo.create({ teamId: team.id, rootTaskId: "task-root" });
      const item = itemRepo.create({ teamRunId: run.id, title: "Item", sourceTaskId: "task-1" });

      vi.advanceTimersByTime(10);
      const updated = itemRepo.update({
        id: item.id,
        status: "done",
        resultSummary: "Completed",
      } satisfies UpdateAgentTeamItemRequest);

      expect(updated?.status).toBe("done");
      expect(updated?.resultSummary).toBe("Completed");
      expect(updated?.updatedAt).toBeGreaterThan(item.updatedAt);
    });

    it("sets resultSummary by sourceTaskId", () => {
      const team = teamRepo.create({ workspaceId: "ws-1", name: "Team", leadAgentRoleId: "lead" });
      const run = runRepo.create({ teamId: team.id, rootTaskId: "task-root" });

      const a = itemRepo.create({ teamRunId: run.id, title: "A", sourceTaskId: "task-1" });
      itemRepo.create({ teamRunId: run.id, title: "B", sourceTaskId: "task-2" });

      vi.advanceTimersByTime(50);
      const changed = itemRepo.setResultSummaryBySourceTaskId("task-1", "Summary");
      expect(changed).toBe(1);

      const updatedA = itemRepo.findById(a.id);
      expect(updatedA?.resultSummary).toBe("Summary");
      expect(updatedA?.updatedAt).toBeGreaterThan(a.updatedAt);
    });
  });
});
