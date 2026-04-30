import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type {
  AgentRole,
  Company,
  CompanyLoopType,
  CompanyOutputContract,
  CompanyOutputType,
  CompanyReviewReason,
  Issue,
  StrategicPlannerConfig,
  StrategicPlannerConfigUpdate,
  StrategicPlannerRun,
  StrategicPlannerRunRequest,
} from "../../shared/types";
import type { AgentDaemon } from "../agent/daemon";
import { TaskRepository, WorkspaceRepository } from "../database/repositories";
import { AgentRoleRepository } from "../agents/AgentRoleRepository";
import { ControlPlaneCoreService } from "./ControlPlaneCoreService";
import {
  buildAgentConfigFromAutonomyPolicy,
  resolveOperationalAutonomyPolicy,
} from "../agents/autonomy-policy";
import { isTempWorkspaceId } from "../../shared/types";

const DEFAULT_INTERVAL_MINUTES = 180;
const DEFAULT_MAX_ISSUES_PER_RUN = 4;
const DEFAULT_STALE_ISSUE_DAYS = 3;
const PLANNER_SCAN_INTERVAL_MS = 60_000;

type PlannerManagedIssueKind =
  | "goal_planning"
  | "project_workspace"
  | "project_next_step"
  | "project_blocked_review"
  | "issue_refresh";

interface PlannerManagedIssueSeed {
  kind: PlannerManagedIssueKind;
  title: string;
  description: string;
  priority: number;
  goalId?: string;
  projectId?: string;
  workspaceId?: string;
  assigneeAgentRoleId?: string;
  targetIssueId?: string;
}

interface PlannerScore {
  coverageGapScore: number;
  stalenessScore: number;
  businessImpactScore: number;
  confidenceScore: number;
  totalScore: number;
}

interface StrategicPlannerServiceDeps {
  db: Database.Database;
  agentDaemon?: AgentDaemon;
  log?: (...args: unknown[]) => void;
}

export class StrategicPlannerService {
  private readonly core: ControlPlaneCoreService;
  private readonly taskRepo: TaskRepository;
  private readonly workspaceRepo: WorkspaceRepository;
  private readonly agentRoleRepo: AgentRoleRepository;
  private intervalHandle: NodeJS.Timeout | null = null;
  private readonly activeRuns = new Set<string>();

  constructor(private readonly deps: StrategicPlannerServiceDeps) {
    this.core = new ControlPlaneCoreService(deps.db);
    this.taskRepo = new TaskRepository(deps.db);
    this.workspaceRepo = new WorkspaceRepository(deps.db);
    this.agentRoleRepo = new AgentRoleRepository(deps.db);
    this.ensureSchema();
  }

  start(): void {
    if (this.intervalHandle) return;
    this.intervalHandle = setInterval(() => {
      void this.tick();
    }, PLANNER_SCAN_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  listConfigs(): StrategicPlannerConfig[] {
    const rows = this.deps.db
      .prepare("SELECT * FROM strategic_planner_configs ORDER BY created_at ASC")
      .all() as Any[];
    return rows.map((row) => this.mapConfig(row));
  }

  getConfig(companyId: string): StrategicPlannerConfig {
    const row = this.deps.db
      .prepare("SELECT * FROM strategic_planner_configs WHERE company_id = ?")
      .get(companyId) as Any;
    if (row) {
      const config = this.sanitizeConfigReferences(this.mapConfig(row));
      if (
        config.planningWorkspaceId !== this.mapConfig(row).planningWorkspaceId ||
        config.plannerAgentRoleId !== this.mapConfig(row).plannerAgentRoleId
      ) {
        this.persistConfig(config);
      }
      return config;
    }

    const now = Date.now();
    const config: StrategicPlannerConfig = {
      companyId,
      enabled: false,
      intervalMinutes: DEFAULT_INTERVAL_MINUTES,
      autoDispatch: false,
      approvalPreset: "founder_edge",
      maxIssuesPerRun: DEFAULT_MAX_ISSUES_PER_RUN,
      staleIssueDays: DEFAULT_STALE_ISSUE_DAYS,
      createdAt: now,
      updatedAt: now,
    };
    this.insertConfig(config);
    return config;
  }

  updateConfig(companyId: string, updates: StrategicPlannerConfigUpdate): StrategicPlannerConfig {
    const existing = this.getConfig(companyId);
    const next: StrategicPlannerConfig = {
      ...existing,
      ...(typeof updates.enabled === "boolean" ? { enabled: updates.enabled } : {}),
      ...(typeof updates.intervalMinutes === "number"
        ? { intervalMinutes: Math.max(15, Math.min(24 * 60, Math.round(updates.intervalMinutes))) }
        : {}),
      ...(updates.planningWorkspaceId === null
        ? { planningWorkspaceId: undefined }
        : typeof updates.planningWorkspaceId === "string"
          ? { planningWorkspaceId: updates.planningWorkspaceId.trim() || undefined }
          : {}),
      ...(updates.plannerAgentRoleId === null
        ? { plannerAgentRoleId: undefined }
        : typeof updates.plannerAgentRoleId === "string"
          ? { plannerAgentRoleId: updates.plannerAgentRoleId.trim() || undefined }
          : {}),
      ...(typeof updates.autoDispatch === "boolean" ? { autoDispatch: updates.autoDispatch } : {}),
      ...(updates.approvalPreset ? { approvalPreset: updates.approvalPreset } : {}),
      ...(typeof updates.maxIssuesPerRun === "number"
        ? { maxIssuesPerRun: Math.max(1, Math.min(20, Math.round(updates.maxIssuesPerRun))) }
        : {}),
      ...(typeof updates.staleIssueDays === "number"
        ? { staleIssueDays: Math.max(1, Math.min(30, Math.round(updates.staleIssueDays))) }
        : {}),
      ...(updates.lastRunAt === null
        ? { lastRunAt: undefined }
        : typeof updates.lastRunAt === "number"
          ? { lastRunAt: updates.lastRunAt }
          : {}),
      updatedAt: Date.now(),
    };

    const sanitized = this.sanitizeConfigReferences(next);
    this.persistConfig(sanitized);
    return this.getConfig(companyId);
  }

  private persistConfig(config: StrategicPlannerConfig): void {
    this.deps.db
      .prepare(
        `
          UPDATE strategic_planner_configs
          SET enabled = ?, interval_minutes = ?, planning_workspace_id = ?, planner_agent_role_id = ?,
              auto_dispatch = ?, approval_preset = ?, max_issues_per_run = ?, stale_issue_days = ?,
              last_run_at = ?, updated_at = ?
          WHERE company_id = ?
        `,
      )
      .run(
        config.enabled ? 1 : 0,
        config.intervalMinutes,
        config.planningWorkspaceId || null,
        config.plannerAgentRoleId || null,
        config.autoDispatch ? 1 : 0,
        config.approvalPreset,
        config.maxIssuesPerRun,
        config.staleIssueDays,
        config.lastRunAt ?? null,
        config.updatedAt,
        config.companyId,
      );
  }

  listRuns(input?: { companyId?: string; limit?: number; offset?: number }): StrategicPlannerRun[] {
    const clauses: string[] = ["1 = 1"];
    const args: Any[] = [];
    if (input?.companyId) {
      clauses.push("company_id = ?");
      args.push(input.companyId);
    }
    const limit = Math.min(Math.max(input?.limit || 50, 1), 500);
    const offset = Math.max(input?.offset || 0, 0);
    args.push(limit, offset);
    const rows = this.deps.db
      .prepare(
        `
          SELECT * FROM strategic_planner_runs
          WHERE ${clauses.join(" AND ")}
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?
        `,
      )
      .all(...args) as Any[];
    return rows.map((row) => this.mapRun(row));
  }

  async runNow(request: StrategicPlannerRunRequest): Promise<StrategicPlannerRun> {
    const trigger = request.trigger || "manual";
    const config = this.getConfig(request.companyId);
    const company = this.core.getCompany(request.companyId);
    if (!company) {
      throw new Error(`Company not found: ${request.companyId}`);
    }
    if (this.activeRuns.has(request.companyId)) {
      throw new Error(`Planner run already active for company: ${request.companyId}`);
    }
    this.activeRuns.add(request.companyId);

    const runId = randomUUID();
    const now = Date.now();
    this.deps.db
      .prepare(
        `
          INSERT INTO strategic_planner_runs (
            id, company_id, status, trigger, summary, error, created_issue_count, updated_issue_count,
            dispatched_task_count, metadata, created_at, updated_at, completed_at
          ) VALUES (?, ?, 'running', ?, NULL, NULL, 0, 0, 0, NULL, ?, ?, NULL)
        `,
      )
      .run(runId, request.companyId, trigger, now, now);

    try {
      const outcome = await this.executePlanningRun(company, config);
      const outputType: CompanyOutputType =
        outcome.createdIssueIds.length > 0 || outcome.updatedIssueIds.length > 0
          ? "issue_batch"
          : outcome.suppressedOutputs.some((entry) => entry.outputType === "decision_brief")
            ? "decision_brief"
            : "status_digest";
      const summaryParts = [
        `${outcome.createdIssueIds.length} issue(s) created`,
        `${outcome.updatedIssueIds.length} issue(s) updated`,
        `${outcome.dispatchedTaskIds.length} task(s) dispatched`,
      ];
      this.deps.db
        .prepare(
          `
            UPDATE strategic_planner_runs
            SET status = 'completed', summary = ?, created_issue_count = ?, updated_issue_count = ?,
                dispatched_task_count = ?, metadata = ?, updated_at = ?, completed_at = ?
            WHERE id = ?
          `,
        )
        .run(
          summaryParts.join(", "),
          outcome.createdIssueIds.length,
          outcome.updatedIssueIds.length,
          outcome.dispatchedTaskIds.length,
          JSON.stringify({
            createdIssueIds: outcome.createdIssueIds,
            updatedIssueIds: outcome.updatedIssueIds,
            dispatchedTaskIds: outcome.dispatchedTaskIds,
            suppressedOutputs: outcome.suppressedOutputs,
            outputContract: {
              companyId: company.id,
              operatorRoleId: config.plannerAgentRoleId,
              loopType: "work_generation" as CompanyLoopType,
              outputType,
              valueReason:
                outcome.createdIssueIds.length > 0 || outcome.updatedIssueIds.length > 0
                  ? `Planner refreshed ${outcome.createdIssueIds.length + outcome.updatedIssueIds.length} issue(s)`
                  : "Planner found no high-confidence work to dispatch",
              reviewRequired: outputType !== "issue_batch",
              reviewReason: outputType !== "issue_batch" ? ("strategy" as CompanyReviewReason) : undefined,
              evidenceRefs: [
                ...outcome.createdIssueIds.map((id) => ({ type: "issue", id, label: "created" })),
                ...outcome.updatedIssueIds.map((id) => ({ type: "issue", id, label: "updated" })),
                ...outcome.dispatchedTaskIds.map((id) => ({ type: "task", id, label: "dispatched" })),
              ],
              companyPriority:
                outcome.createdIssueIds.length > 0 || outcome.dispatchedTaskIds.length > 0 ? "high" : "normal",
              triggerReason: `planner:${trigger}`,
              expectedOutputType: outputType,
            } satisfies CompanyOutputContract,
          }),
          Date.now(),
          Date.now(),
          runId,
        );
      this.updateConfig(request.companyId, { lastRunAt: Date.now() });
      return this.getRunOrThrow(runId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.db
        .prepare(
          `
            UPDATE strategic_planner_runs
            SET status = 'failed', error = ?, updated_at = ?, completed_at = ?
            WHERE id = ?
          `,
        )
        .run(message, Date.now(), Date.now(), runId);
      throw error;
    } finally {
      this.activeRuns.delete(request.companyId);
    }
  }

  private async tick(): Promise<void> {
    for (const config of this.listConfigs()) {
      if (!config.enabled) continue;
      if (this.activeRuns.has(config.companyId)) continue;
      const lastRunAt = config.lastRunAt || 0;
      const intervalMs = config.intervalMinutes * 60 * 1000;
      if (lastRunAt && Date.now() - lastRunAt < intervalMs) continue;
      try {
        await this.runNow({
          companyId: config.companyId,
          trigger: lastRunAt ? "schedule" : "startup",
        });
      } catch (error) {
        this.log("Planner tick failed", config.companyId, error);
      }
    }
  }

  private async executePlanningRun(company: Company, config: StrategicPlannerConfig): Promise<{
    createdIssueIds: string[];
    updatedIssueIds: string[];
    dispatchedTaskIds: string[];
    suppressedOutputs: Array<{ seedTitle: string; summary: string; outputType: CompanyOutputType }>;
  }> {
    const runStartedAt = Date.now();
    const activeGoals = this.core.listGoals(company.id).filter((goal) => goal.status === "active");
    const projects = this.core.listProjects({ companyId: company.id, includeArchived: false });
    const issues = this.core.listIssues({ companyId: company.id, limit: 5000 });
    const openIssues = issues.filter((issue) => !["done", "cancelled"].includes(issue.status));
    const companyWorkspaceId = company.defaultWorkspaceId;
    const plannerAgent = this.pickPlannerAgent(config);
    const createdIssueIds: string[] = [];
    const updatedIssueIds: string[] = [];
    const suppressedOutputs: Array<{
      seedTitle: string;
      summary: string;
      outputType: CompanyOutputType;
    }> = [];

    const seeds: PlannerManagedIssueSeed[] = [];

    for (const goal of activeGoals) {
      const goalProjects = projects.filter(
        (project) => project.goalId === goal.id && !["completed", "archived"].includes(project.status),
      );
      if (goalProjects.length === 0) {
        seeds.push({
          kind: "goal_planning",
          title: `Define first project for goal: ${goal.title}`,
          description:
            `This goal has no active projects yet.\n\nGoal: ${goal.title}\n\n` +
            `Create a concrete project breakdown, starting with the smallest viable delivery step.`,
          priority: 1,
          goalId: goal.id,
          assigneeAgentRoleId: plannerAgent?.id,
        });
      }
    }

    for (const project of projects.filter((entry) => entry.status === "active")) {
      const linkedWorkspaceId =
        this.core.listProjectWorkspaces(project.id).find((link) => link.isPrimary)?.workspaceId ||
        this.core.listProjectWorkspaces(project.id)[0]?.workspaceId ||
        companyWorkspaceId;
      const projectIssues = openIssues.filter((issue) => issue.projectId === project.id);
      const blockedIssues = projectIssues.filter((issue) => issue.status === "blocked");
      const staleIssue = projectIssues.find((issue) => this.isStaleIssue(issue, config.staleIssueDays));

      if (!linkedWorkspaceId && !companyWorkspaceId) {
        seeds.push({
          kind: "project_workspace",
          title: `Link a workspace for project: ${project.name}`,
          description:
            `This active project has no linked workspace yet.\n\nProject: ${project.name}\n\n` +
            `Link the correct workspace so autonomous agents can operate with durable context.`,
          priority: 1,
          projectId: project.id,
          assigneeAgentRoleId: plannerAgent?.id,
        });
      }

      if (projectIssues.length === 0) {
        seeds.push({
          kind: "project_next_step",
          title: `Define next deliverable for project: ${project.name}`,
          description:
            `This project has no open issues.\n\nProject: ${project.name}\n\n` +
            `Create the next concrete deliverable and route it to the right operator.`,
          priority: 2,
          projectId: project.id,
          workspaceId: linkedWorkspaceId,
          assigneeAgentRoleId: plannerAgent?.id,
        });
      }

      if (blockedIssues.length >= 2) {
        seeds.push({
          kind: "project_blocked_review",
          title: `Unblock project: ${project.name}`,
          description:
            `Multiple issues are blocked in this project.\n\nProject: ${project.name}\n\n` +
            `Review blockers, dependencies, and escalation paths. Convert blockers into the next action.`,
          priority: 1,
          projectId: project.id,
          workspaceId: linkedWorkspaceId,
          assigneeAgentRoleId: plannerAgent?.id,
        });
      }

      if (staleIssue) {
        const staleIssueMetadata = this.getPlannerMetadata(staleIssue);
        seeds.push({
          kind: "issue_refresh",
          title:
            staleIssueMetadata?.source === "mailbox_handoff"
              ? `Planner follow-up for inbox issue: ${staleIssue.title}`
              : `Refresh stale issue: ${staleIssue.title}`,
          description:
            staleIssueMetadata?.source === "mailbox_handoff"
              ? `This inbox-originated issue appears stale and may need planner co-management.\n\n` +
                `Issue: ${staleIssue.title}\nStatus: ${staleIssue.status}\n\n` +
                `Create a linked follow-up issue that clarifies the next step without taking ownership away from the original inbox handoff.`
              : `This issue appears stale and needs a next step.\n\n` +
                `Issue: ${staleIssue.title}\nStatus: ${staleIssue.status}\n\n` +
                `Reassess the blocker, progress, or required action and move it forward.`,
          priority: Math.min(2, staleIssue.priority || 2),
          projectId: project.id,
          workspaceId: staleIssue.workspaceId || linkedWorkspaceId,
          assigneeAgentRoleId: staleIssue.assigneeAgentRoleId || plannerAgent?.id,
          targetIssueId: staleIssue.id,
        });
      }
    }

    const uniqueSeeds = seeds.slice(0, config.maxIssuesPerRun);
    const managedOpenIssues = openIssues.filter((issue) => this.getPlannerMetadata(issue)?.plannerManaged === true);

    for (const seed of uniqueSeeds) {
      const score = this.scoreSeed(seed, companyWorkspaceId);
      if (score.totalScore < 0.55) {
        suppressedOutputs.push({
          seedTitle: seed.title,
          summary: `Suppressed low-confidence planner work (${score.totalScore.toFixed(2)}): ${seed.title}`,
          outputType: score.businessImpactScore >= 0.6 ? "decision_brief" : "status_digest",
        });
        continue;
      }
      const existing = this.findManagedIssue(openIssues, seed);
      if (existing) {
        const nextPriority = Math.min(existing.priority || seed.priority, seed.priority);
        const shouldUpdate =
          existing.priority !== nextPriority ||
          (seed.assigneeAgentRoleId && existing.assigneeAgentRoleId !== seed.assigneeAgentRoleId);
        if (shouldUpdate) {
          const outputContract = this.buildIssueOutputContract(company, plannerAgent, seed, score, existing.id);
          this.core.updateIssue(existing.id, {
            priority: nextPriority,
            assigneeAgentRoleId: seed.assigneeAgentRoleId || existing.assigneeAgentRoleId,
            metadata: {
              ...existing.metadata,
              plannerManaged: true,
              plannerKind: seed.kind,
              targetIssueId: seed.targetIssueId,
              plannerTouchedAt: Date.now(),
              plannerScore: score,
              outputContract,
              completionContract: this.buildCompletionContract(seed),
            },
          });
          updatedIssueIds.push(existing.id);
        }
        continue;
      }

      const outputContract = this.buildIssueOutputContract(company, plannerAgent, seed, score);
      const created = this.core.createIssue({
        companyId: company.id,
        goalId: seed.goalId,
        projectId: seed.projectId,
        parentIssueId:
          seed.kind === "issue_refresh" && seed.targetIssueId
            ? seed.targetIssueId
            : undefined,
        workspaceId: seed.workspaceId,
        title: seed.title,
        description: seed.description,
        status: "backlog",
        priority: seed.priority,
        assigneeAgentRoleId: seed.assigneeAgentRoleId,
        reporterAgentRoleId: plannerAgent?.id,
        metadata: {
          plannerManaged: true,
          plannerKind: seed.kind,
          targetIssueId: seed.targetIssueId,
          source: "strategic_planner",
          plannerScore: score,
          outputContract,
          completionContract: this.buildCompletionContract(seed),
        },
      });
      createdIssueIds.push(created.id);
      openIssues.push(created);
      managedOpenIssues.push(created);
    }

    const touchedIssueIds = new Set<string>([...createdIssueIds, ...updatedIssueIds]);
    const dispatchable = [...managedOpenIssues]
      .filter((issue) => !issue.activeRunId && ["backlog", "todo", "blocked"].includes(issue.status))
      .filter((issue) => {
        if (touchedIssueIds.has(issue.id)) {
          return true;
        }
        if (!issue.taskId) {
          return true;
        }
        return issue.updatedAt >= runStartedAt;
      })
      .sort((a, b) => a.priority - b.priority || b.updatedAt - a.updatedAt)
      .slice(0, config.autoDispatch ? config.maxIssuesPerRun : 0);

    const dispatchedTaskIds: string[] = [];
    for (const issue of dispatchable) {
      const taskId = await this.dispatchIssue(company, config, issue, plannerAgent);
      if (taskId) dispatchedTaskIds.push(taskId);
    }

    return {
      createdIssueIds,
      updatedIssueIds,
      dispatchedTaskIds,
      suppressedOutputs,
    };
  }

  private async dispatchIssue(
    company: Company,
    config: StrategicPlannerConfig,
    issue: Issue,
    plannerAgent: AgentRole | undefined,
  ): Promise<string | null> {
    if (!this.deps.agentDaemon) return null;
    const workspaceId =
      issue.workspaceId ||
      company.defaultWorkspaceId ||
      config.planningWorkspaceId ||
      this.pickDefaultWorkspaceId();
    if (!workspaceId) return null;

    const assigneeAgentRoleId = issue.assigneeAgentRoleId || plannerAgent?.id;
    const dispatchAgent = assigneeAgentRoleId
      ? this.agentRoleRepo.findById(assigneeAgentRoleId)
      : plannerAgent;
    if (!dispatchAgent) return null;

    const checkout = this.core.checkoutIssue({
      issueId: issue.id,
      agentRoleId: dispatchAgent.id,
      workspaceId,
    });

    const task = await this.deps.agentDaemon.createTask({
      title: issue.title,
      prompt: this.buildDispatchPrompt(company, issue),
      workspaceId,
      source: "api",
      agentConfig: {
        ...buildAgentConfigFromAutonomyPolicy({
          preset: config.approvalPreset,
        }),
        ...buildAgentConfigFromAutonomyPolicy(resolveOperationalAutonomyPolicy(dispatchAgent)),
        allowUserInput: false,
        gatewayContext: "private",
      },
    });

    this.taskRepo.update(task.id, {
      assignedAgentRoleId: dispatchAgent.id,
      boardColumn: "todo",
    });
    this.core.attachTaskToRun(checkout.run.id, task.id);
    return task.id;
  }

  private buildDispatchPrompt(company: Company, issue: Issue): string {
    const plannerMetadata = this.getPlannerMetadata(issue);
    const plannerInstructions =
      plannerMetadata?.plannerKind === "project_workspace"
        ? [
            "",
            "## Workspace Linking Requirements",
            "This issue is only complete when the project is linked in the CoWork OS control plane database.",
            "Use the control-plane tools: list_projects, list_workspaces, and link_project_workspace.",
            "Do not treat ad hoc files in .cowork/ as a substitute for the database link.",
          ]
        : [];

    return [
      `You are executing a planner-routed company issue for ${company.name}.`,
      "",
      "## Issue",
      `- Title: ${issue.title}`,
      `- Status: ${issue.status}`,
      `- Priority: ${issue.priority}`,
      issue.description ? `- Description: ${issue.description}` : "",
      "",
      "## Instructions",
      "Move this issue forward using the normal toolset.",
      "Prefer concrete progress over commentary.",
      "If the issue turns out to be underspecified, tighten scope and capture the next actionable step.",
      "If you hit a real blocker, state it clearly and leave the issue in a better-defined state than you found it.",
      ...plannerInstructions,
    ]
      .filter(Boolean)
      .join("\n");
  }

  private findManagedIssue(issues: Issue[], seed: PlannerManagedIssueSeed): Issue | undefined {
    return issues.find((issue) => {
      const metadata = this.getPlannerMetadata(issue);
      if (!metadata?.plannerManaged) return false;
      if (metadata.plannerKind !== seed.kind) return false;
      if ((issue.projectId || "") !== (seed.projectId || "")) return false;
      if ((issue.goalId || "") !== (seed.goalId || "")) return false;
      if ((metadata.targetIssueId || "") !== (seed.targetIssueId || "")) return false;
      return !["done", "cancelled"].includes(issue.status);
    });
  }

  private isStaleIssue(issue: Issue, staleIssueDays: number): boolean {
    if (!["backlog", "todo", "review", "blocked"].includes(issue.status)) return false;
    const ageMs = Date.now() - issue.updatedAt;
    return ageMs >= staleIssueDays * 24 * 60 * 60 * 1000;
  }

  private pickPlannerAgent(config: StrategicPlannerConfig): AgentRole | undefined {
    if (config.plannerAgentRoleId) {
      const configured = this.agentRoleRepo.findById(config.plannerAgentRoleId);
      if (configured?.isActive !== false) return configured;
    }

    const activeRoles = this.agentRoleRepo.findAll().filter((role) => role.isActive !== false);
    const namedLead =
      activeRoles.find((role) => role.name === "project_manager") ||
      activeRoles.find((role) => role.name === "product_manager") ||
      activeRoles.find((role) => role.name === "architect");
    if (namedLead) return namedLead;
    return activeRoles.find((role) => role.autonomyLevel === "lead");
  }

  private pickDefaultWorkspaceId(): string | undefined {
    const workspaces = this.workspaceRepo
      .findAll()
      .filter((workspace) => !workspace.isTemp && !isTempWorkspaceId(workspace.id) && workspace.path);
    return workspaces[0]?.id;
  }

  private getPlannerMetadata(issue: Issue): {
    plannerManaged?: boolean;
    plannerKind?: PlannerManagedIssueKind;
    targetIssueId?: string;
    outputContract?: CompanyOutputContract;
    source?: string;
  } | null {
    if (!issue.metadata || typeof issue.metadata !== "object") return null;
    return issue.metadata as {
      plannerManaged?: boolean;
      plannerKind?: PlannerManagedIssueKind;
      targetIssueId?: string;
      outputContract?: CompanyOutputContract;
      source?: string;
    };
  }

  private scoreSeed(seed: PlannerManagedIssueSeed, companyWorkspaceId?: string): PlannerScore {
    const coverageGapScore =
      seed.kind === "goal_planning"
        ? 1
        : seed.kind === "project_workspace" || seed.kind === "project_next_step"
          ? 0.85
          : seed.kind === "project_blocked_review"
            ? 0.7
            : 0.55;
    const stalenessScore =
      seed.kind === "issue_refresh" ? 0.9 : seed.kind === "project_blocked_review" ? 0.75 : 0.35;
    const businessImpactScore = seed.priority === 1 ? 0.9 : seed.priority === 2 ? 0.7 : 0.5;
    const confidenceScore =
      seed.workspaceId || companyWorkspaceId
        ? seed.assigneeAgentRoleId
          ? 0.85
          : 0.7
        : 0.45;
    const totalScore =
      coverageGapScore * 0.35 +
      stalenessScore * 0.2 +
      businessImpactScore * 0.3 +
      confidenceScore * 0.15;
    return {
      coverageGapScore,
      stalenessScore,
      businessImpactScore,
      confidenceScore,
      totalScore,
    };
  }

  private buildIssueOutputContract(
    company: Company,
    plannerAgent: AgentRole | undefined,
    seed: PlannerManagedIssueSeed,
    score: PlannerScore,
    issueId?: string,
  ): CompanyOutputContract {
    return {
      companyId: company.id,
      operatorRoleId: seed.assigneeAgentRoleId || plannerAgent?.id,
      loopType: "work_generation",
      outputType: "issue_batch",
      sourceIssueId: issueId || seed.targetIssueId,
      sourceGoalId: seed.goalId,
      valueReason: `Planner created scoped work for ${seed.kind.replace(/_/g, " ")}`,
      reviewRequired: score.confidenceScore < 0.65,
      reviewReason: score.confidenceScore < 0.65 ? "strategy" : undefined,
      evidenceRefs: [
        ...(seed.goalId ? [{ type: "goal", id: seed.goalId, label: "source goal" }] : []),
        ...(seed.projectId ? [{ type: "project", id: seed.projectId, label: "source project" }] : []),
        ...(seed.targetIssueId ? [{ type: "issue", id: seed.targetIssueId, label: "stale issue" }] : []),
      ],
      companyPriority: seed.priority === 1 ? "high" : "normal",
      triggerReason: seed.kind,
      expectedOutputType: "work_order",
    };
  }

  private buildCompletionContract(seed: PlannerManagedIssueSeed): Record<string, unknown> {
    return {
      expectedArtifactType: seed.kind === "goal_planning" ? "decision_brief" : "work_order",
      doneWhen:
        seed.kind === "project_workspace"
          ? ["project linked to durable workspace", "workspace captured in control plane"]
          : ["concrete next deliverable defined", "responsible operator identified", "next step captured"],
    };
  }

  private insertConfig(config: StrategicPlannerConfig): void {
    this.deps.db
      .prepare(
        `
          INSERT INTO strategic_planner_configs (
            company_id, enabled, interval_minutes, planning_workspace_id, planner_agent_role_id,
            auto_dispatch, approval_preset, max_issues_per_run, stale_issue_days,
            created_at, updated_at, last_run_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        config.companyId,
        config.enabled ? 1 : 0,
        config.intervalMinutes,
        config.planningWorkspaceId || null,
        config.plannerAgentRoleId || null,
        config.autoDispatch ? 1 : 0,
        config.approvalPreset,
        config.maxIssuesPerRun,
        config.staleIssueDays,
        config.createdAt,
        config.updatedAt,
        config.lastRunAt ?? null,
      );
  }

  private getRunOrThrow(runId: string): StrategicPlannerRun {
    const row = this.deps.db
      .prepare("SELECT * FROM strategic_planner_runs WHERE id = ?")
      .get(runId) as Any;
    if (!row) throw new Error(`Planner run not found: ${runId}`);
    return this.mapRun(row);
  }

  private mapConfig(row: Any): StrategicPlannerConfig {
    return {
      companyId: row.company_id,
      enabled: Number(row.enabled) === 1,
      intervalMinutes: Number(row.interval_minutes) || DEFAULT_INTERVAL_MINUTES,
      planningWorkspaceId: row.planning_workspace_id || undefined,
      plannerAgentRoleId: row.planner_agent_role_id || undefined,
      autoDispatch: Number(row.auto_dispatch) === 1,
      approvalPreset: row.approval_preset || "founder_edge",
      maxIssuesPerRun: Number(row.max_issues_per_run) || DEFAULT_MAX_ISSUES_PER_RUN,
      staleIssueDays: Number(row.stale_issue_days) || DEFAULT_STALE_ISSUE_DAYS,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastRunAt: typeof row.last_run_at === "number" ? row.last_run_at : undefined,
    };
  }

  private sanitizeConfigReferences(config: StrategicPlannerConfig): StrategicPlannerConfig {
    const next = { ...config };

    if (next.plannerAgentRoleId) {
      const role = this.agentRoleRepo.findById(next.plannerAgentRoleId);
      if (!role || role.isActive === false) {
        next.plannerAgentRoleId = undefined;
      }
    }

    if (next.planningWorkspaceId) {
      const workspace = this.workspaceRepo.findById(next.planningWorkspaceId);
      if (!workspace) {
        next.planningWorkspaceId = undefined;
      }
    }

    return next;
  }

  private mapRun(row: Any): StrategicPlannerRun {
    return {
      id: row.id,
      companyId: row.company_id,
      status: row.status,
      trigger: row.trigger,
      summary: row.summary || undefined,
      error: row.error || undefined,
      createdIssueCount: Number(row.created_issue_count) || 0,
      updatedIssueCount: Number(row.updated_issue_count) || 0,
      dispatchedTaskCount: Number(row.dispatched_task_count) || 0,
      metadata:
        typeof row.metadata === "string" && row.metadata.trim().length > 0
          ? JSON.parse(row.metadata)
          : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: typeof row.completed_at === "number" ? row.completed_at : undefined,
    };
  }

  private ensureSchema(): void {
    this.deps.db.exec(`
      CREATE TABLE IF NOT EXISTS strategic_planner_configs (
        company_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        interval_minutes INTEGER NOT NULL DEFAULT ${DEFAULT_INTERVAL_MINUTES},
        planning_workspace_id TEXT,
        planner_agent_role_id TEXT,
        auto_dispatch INTEGER NOT NULL DEFAULT 0,
        approval_preset TEXT NOT NULL DEFAULT 'founder_edge',
        max_issues_per_run INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_ISSUES_PER_RUN},
        stale_issue_days INTEGER NOT NULL DEFAULT ${DEFAULT_STALE_ISSUE_DAYS},
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_run_at INTEGER,
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
        FOREIGN KEY (planning_workspace_id) REFERENCES workspaces(id),
        FOREIGN KEY (planner_agent_role_id) REFERENCES agent_roles(id)
      );
      CREATE TABLE IF NOT EXISTS strategic_planner_runs (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        status TEXT NOT NULL,
        trigger TEXT NOT NULL,
        summary TEXT,
        error TEXT,
        created_issue_count INTEGER NOT NULL DEFAULT 0,
        updated_issue_count INTEGER NOT NULL DEFAULT 0,
        dispatched_task_count INTEGER NOT NULL DEFAULT 0,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_strategic_planner_runs_company
        ON strategic_planner_runs(company_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_strategic_planner_runs_status
        ON strategic_planner_runs(status, created_at DESC);
    `);
  }

  private log(...args: unknown[]): void {
    this.deps.log?.("[StrategicPlanner]", ...args);
  }
}

let strategicPlannerServiceInstance: StrategicPlannerService | null = null;

export function setStrategicPlannerService(service: StrategicPlannerService | null): void {
  strategicPlannerServiceInstance = service;
}

export function getStrategicPlannerService(): StrategicPlannerService | null {
  return strategicPlannerServiceInstance;
}
