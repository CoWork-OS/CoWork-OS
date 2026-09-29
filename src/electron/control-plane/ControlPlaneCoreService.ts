import { TaskRepository } from "../database/repository-facades";
import type Database from "better-sqlite3";
import { randomUUID } from "crypto";

import { storeFacade, type AsyncStore } from "../database/statements/store-units";
import type {
  AgentRole,
  Company,
  CompanyCreateInput,
  CompanyImportResult,
  CompanyTemplateExport,
  CompanyUpdate,
  HeartbeatRun,
  Issue,
  Task,
} from "../../shared/types";
import { ControlPlaneStore } from "./control-plane-sql";
import { createControlPlaneStatementPort } from "./control-plane-statement-port";
import { CONTROL_PLANE_READS, CONTROL_PLANE_WRITES } from "./control-plane-units";

export { ControlPlaneStore } from "./control-plane-sql";

type UnitMethod = (typeof CONTROL_PLANE_READS)[number] | (typeof CONTROL_PLANE_WRITES)[number];

/**
 * The control plane (async SQLite migration plan, DB6). Queries and the issue/run state
 * machine are control-plane transaction units over `ControlPlaneStore`: in the database
 * worker when the runtime routes the control plane there, one host transaction
 * otherwise. Checking out an issue, attaching a task's run and issue rows, releasing an
 * issue and syncing a run to its task's lifecycle are single transactions.
 *
 * Task rows are updated through the storage layer's `TaskRepository` on the host, so its
 * read-cache and usage-projector hooks keep running here. Company creation and updates
 * (which provision workspace folders and workspace rows), template import and export, and
 * budget enforcement need the storage layer's repositories and the file system; they run
 * on the host as before.
 */
export class ControlPlaneCoreService {
  private readonly units: AsyncStore<ControlPlaneStore, UnitMethod>;
  /** The same store over the host connection, for the host-only operations. */
  private readonly host: ControlPlaneStore;
  private readonly taskRepo: TaskRepository;

  constructor(db: Database.Database) {
    this.host = new ControlPlaneStore(db, { provision: true });
    this.taskRepo = new TaskRepository(db);
    const sql = createControlPlaneStatementPort(db);
    this.units = storeFacade<ControlPlaneStore, UnitMethod>(
      "controlPlane_",
      [...CONTROL_PLANE_READS, ...CONTROL_PLANE_WRITES],
      (name, args) => sql.unit(name as never, args as never),
    );
  }

  // ─── Units ────────────────────────────────────────────────────────

  listCompanies = (...args: Parameters<ControlPlaneStore["listCompanies"]>) =>
    this.units.listCompanies(...args);
  getCompany = (...args: Parameters<ControlPlaneStore["getCompany"]>) =>
    this.units.getCompany(...args);
  getDefaultCompany = (...args: Parameters<ControlPlaneStore["getDefaultCompany"]>) =>
    this.units.getDefaultCompany(...args);
  listGoals = (...args: Parameters<ControlPlaneStore["listGoals"]>) =>
    this.units.listGoals(...args);
  getGoal = (...args: Parameters<ControlPlaneStore["getGoal"]>) => this.units.getGoal(...args);
  createGoal = (...args: Parameters<ControlPlaneStore["createGoal"]>) =>
    this.units.createGoal(...args);
  updateGoal = (...args: Parameters<ControlPlaneStore["updateGoal"]>) =>
    this.units.updateGoal(...args);
  listProjects = (...args: Parameters<ControlPlaneStore["listProjects"]>) =>
    this.units.listProjects(...args);
  getProject = (...args: Parameters<ControlPlaneStore["getProject"]>) =>
    this.units.getProject(...args);
  createProject = (...args: Parameters<ControlPlaneStore["createProject"]>) =>
    this.units.createProject(...args);
  updateProject = (...args: Parameters<ControlPlaneStore["updateProject"]>) =>
    this.units.updateProject(...args);
  listProjectWorkspaces = (...args: Parameters<ControlPlaneStore["listProjectWorkspaces"]>) =>
    this.units.listProjectWorkspaces(...args);
  linkProjectWorkspace = (...args: Parameters<ControlPlaneStore["linkProjectWorkspace"]>) =>
    this.units.linkProjectWorkspace(...args);
  unlinkProjectWorkspace = (...args: Parameters<ControlPlaneStore["unlinkProjectWorkspace"]>) =>
    this.units.unlinkProjectWorkspace(...args);
  setPrimaryProjectWorkspace = (
    ...args: Parameters<ControlPlaneStore["setPrimaryProjectWorkspace"]>
  ) => this.units.setPrimaryProjectWorkspace(...args);
  listIssues = (...args: Parameters<ControlPlaneStore["listIssues"]>) =>
    this.units.listIssues(...args);
  getIssue = (...args: Parameters<ControlPlaneStore["getIssue"]>) => this.units.getIssue(...args);
  createIssue = (...args: Parameters<ControlPlaneStore["createIssue"]>) =>
    this.units.createIssue(...args);
  updateIssue = (...args: Parameters<ControlPlaneStore["updateIssue"]>) =>
    this.units.updateIssue(...args);
  listIssueComments = (...args: Parameters<ControlPlaneStore["listIssueComments"]>) =>
    this.units.listIssueComments(...args);
  createIssueComment = (...args: Parameters<ControlPlaneStore["createIssueComment"]>) =>
    this.units.createIssueComment(...args);
  listAssignedIssues = (...args: Parameters<ControlPlaneStore["listAssignedIssues"]>) =>
    this.units.listAssignedIssues(...args);
  releaseIssue = (...args: Parameters<ControlPlaneStore["releaseIssue"]>) =>
    this.units.releaseIssue(...args);
  listRuns = (...args: Parameters<ControlPlaneStore["listRuns"]>) => this.units.listRuns(...args);
  getRun = (...args: Parameters<ControlPlaneStore["getRun"]>) => this.units.getRun(...args);
  getRunEvents = (...args: Parameters<ControlPlaneStore["getRunEvents"]>) =>
    this.units.getRunEvents(...args);
  summarizeCosts = (...args: Parameters<ControlPlaneStore["summarizeCosts"]>) =>
    this.units.summarizeCosts(...args);
  summarizeCostsByAgent = (...args: Parameters<ControlPlaneStore["summarizeCostsByAgent"]>) =>
    this.units.summarizeCostsByAgent(...args);
  summarizeCostsByProject = (...args: Parameters<ControlPlaneStore["summarizeCostsByProject"]>) =>
    this.units.summarizeCostsByProject(...args);

  // ─── The run state machine ────────────────────────────────────────

  async checkoutIssue(input: {
    issueId: string;
    agentRoleId?: string;
    workspaceId?: string;
    taskId?: string;
    resumedFromRunId?: string;
  }): Promise<{ issue: Issue; run: HeartbeatRun }> {
    const runId = randomUUID();
    const result = await this.units.checkoutIssueRows(input, runId, Date.now());
    if (result.status === "not_found") throw new Error(`Issue not found: ${input.issueId}`);
    if (result.status === "already_checked_out") {
      throw new Error(`Issue already checked out: ${input.issueId}`);
    }
    if (input.taskId) {
      await this.attachTaskToRun(runId, input.taskId);
    }
    const [issue, run] = await Promise.all([this.getIssue(input.issueId), this.getRun(runId)]);
    if (!issue || !run) {
      throw new Error("Failed to checkout issue");
    }
    return { issue, run };
  }

  async attachTaskToRun(
    runId: string,
    taskId: string,
  ): Promise<{ issue: Issue; run: HeartbeatRun; task: Task }> {
    const task = await this.taskRepo.findById(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const { issue } = await this.units.attachTaskRows(runId, taskId, task.workspaceId, Date.now());

    await this.taskRepo.update(taskId, {
      companyId: issue.companyId,
      goalId: issue.goalId,
      projectId: issue.projectId,
      issueId: issue.id,
      heartbeatRunId: runId,
      requestDepth: issue.requestDepth,
      billingCode: issue.billingCode,
      workspaceId: issue.workspaceId || task.workspaceId,
    });

    await this.units.recordRunEvent(runId, "run.task_attached", {
      taskId,
      issueId: issue.id,
      workspaceId: task.workspaceId,
    });

    const [updatedIssue, updatedRun] = await Promise.all([
      this.getIssue(issue.id),
      this.getRun(runId),
    ]);
    const updatedTask = await this.taskRepo.findById(taskId);
    if (!updatedIssue || !updatedRun || !updatedTask) {
      throw new Error("Failed to attach task to run");
    }
    return { issue: updatedIssue, run: updatedRun, task: updatedTask };
  }

  async syncTaskLifecycle(
    taskId: string,
    overrides?: { status?: Task["status"]; resultSummary?: string; error?: string },
  ): Promise<void> {
    const task = await this.taskRepo.findById(taskId);
    if (!task?.issueId || !task.heartbeatRunId) return;
    await this.units.syncRunForTask(
      {
        id: task.id,
        status: task.status,
        issueId: task.issueId,
        heartbeatRunId: task.heartbeatRunId,
        terminalStatus: task.terminalStatus,
        resultSummary: task.resultSummary,
        error: task.error,
      },
      overrides,
      Date.now(),
    );
  }

  // ─── Host-only operations ─────────────────────────────────────────

  async createCompany(input: CompanyCreateInput): Promise<Company> {
    return this.host.createCompany(input);
  }

  async updateCompany(id: string, updates: CompanyUpdate): Promise<Company | undefined> {
    return this.host.updateCompany(id, updates);
  }

  async enforceAgentBudgets(agentRoleIds?: string[]): Promise<AgentRole[]> {
    return this.host.enforceAgentBudgets(agentRoleIds);
  }

  async exportCompanyTemplate(companyId: string): Promise<CompanyTemplateExport> {
    return this.host.exportCompanyTemplate(companyId);
  }

  async importCompanyTemplate(template: CompanyTemplateExport): Promise<CompanyImportResult> {
    return this.host.importCompanyTemplate(template);
  }
}
