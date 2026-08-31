import type {
  AutomationRunEvidenceRef,
  AutomationRunTrigger,
  CreateAutomationRunOutcomeInput,
} from "../../shared/types";
import type { AgentRole, Company, HeartbeatResult, StrategicPlannerRun } from "../../shared/types";

interface HeartbeatDispatchClassificationInput {
  agent: AgentRole;
  workspaceId: string;
  sourceRunId: string;
  trigger: AutomationRunTrigger;
  reason: string;
  dispatchKind?: string;
  result: HeartbeatResult;
  evidenceRefs?: AutomationRunEvidenceRef[];
}

export function classifyHeartbeatDispatchOutcome(
  input: HeartbeatDispatchClassificationInput,
): CreateAutomationRunOutcomeInput {
  const failed = input.result.status === "error";
  const actionable = !failed && Boolean(input.result.taskCreated);
  return {
    source: "heartbeat",
    sourceRunId: input.sourceRunId,
    taskId: input.result.taskCreated,
    workspaceId: input.workspaceId,
    agentRoleId: input.agent.id,
    title: failed
      ? `${input.agent.displayName} heartbeat dispatch failed`
      : actionable
        ? `${input.agent.displayName} started background work`
        : `${input.agent.displayName} heartbeat dispatch completed`,
    summary: [
      input.reason,
      input.result.taskCreated ? `Created task ${input.result.taskCreated}.` : "",
      input.result.error,
    ]
      .filter(Boolean)
      .join(" "),
    usefulness: failed ? "failed" : actionable ? "actionable" : "informational",
    trigger: input.trigger,
    metrics: {
      dispatchedTaskCount: input.result.taskCreated ? 1 : 0,
      dispatchKind: input.dispatchKind,
    },
    evidenceRefs: input.evidenceRefs,
    nextAction: input.result.taskCreated ? "Review the created background task." : undefined,
    notificationRecommended: failed || actionable,
    notificationReason: failed
      ? "Heartbeat dispatch failed."
      : actionable
        ? "Heartbeat created background work."
        : undefined,
  };
}

export function classifyHeartbeatErrorOutcome(input: {
  agent: AgentRole;
  workspaceId?: string;
  sourceRunId: string;
  trigger: AutomationRunTrigger;
  error: string;
}): CreateAutomationRunOutcomeInput {
  return {
    source: "heartbeat",
    sourceRunId: input.sourceRunId,
    workspaceId: input.workspaceId,
    agentRoleId: input.agent.id,
    title: `${input.agent.displayName} heartbeat failed`,
    summary: input.error,
    usefulness: "failed",
    trigger: input.trigger,
    nextAction: "Inspect the heartbeat run error.",
    notificationRecommended: true,
    notificationReason: "Heartbeat failed before it could complete.",
  };
}

export function classifyStrategicPlannerOutcome(input: {
  company: Company;
  configWorkspaceId?: string;
  trigger: StrategicPlannerRun["trigger"];
  run: StrategicPlannerRun;
  createdIssueIds: string[];
  updatedIssueIds: string[];
  dispatchedTaskIds: string[];
  suppressedOutputCount: number;
}): CreateAutomationRunOutcomeInput {
  const actionableCount =
    input.createdIssueIds.length + input.updatedIssueIds.length + input.dispatchedTaskIds.length;
  const usefulness =
    actionableCount > 0
      ? "actionable"
      : input.suppressedOutputCount > 0
        ? "low_value"
        : "informational";
  return {
    source: "strategic_planner",
    sourceRunId: input.run.id,
    taskId: input.dispatchedTaskIds[0],
    workspaceId: input.configWorkspaceId || input.company.defaultWorkspaceId,
    companyId: input.company.id,
    title:
      usefulness === "actionable"
        ? `${input.company.name} planner found background work`
        : usefulness === "low_value"
          ? `${input.company.name} planner held low-confidence work`
          : `${input.company.name} planner found no changes`,
    summary: input.run.summary || "Planner run completed.",
    usefulness,
    trigger: input.trigger,
    metrics: {
      changedIssueCount: input.createdIssueIds.length + input.updatedIssueIds.length,
      createdIssueCount: input.createdIssueIds.length,
      updatedIssueCount: input.updatedIssueIds.length,
      dispatchedTaskCount: input.dispatchedTaskIds.length,
      suppressedOutputCount: input.suppressedOutputCount,
    },
    evidenceRefs: [
      ...input.createdIssueIds.map((id) => ({ type: "issue", id, label: "created" })),
      ...input.updatedIssueIds.map((id) => ({ type: "issue", id, label: "updated" })),
      ...input.dispatchedTaskIds.map((id) => ({ type: "task", id, label: "dispatched" })),
    ],
    nextAction:
      actionableCount > 0
        ? "Review the planner-created work."
        : input.suppressedOutputCount > 0
          ? "Review planner confidence thresholds before dispatching."
          : undefined,
    notificationRecommended: input.trigger !== "manual" && usefulness === "actionable",
    notificationReason:
      input.trigger !== "manual" && usefulness === "actionable"
        ? "Automated planner run created or dispatched work."
        : undefined,
  };
}

export function classifyStrategicPlannerFailure(input: {
  company: Company;
  configWorkspaceId?: string;
  trigger: StrategicPlannerRun["trigger"];
  error: string;
}): CreateAutomationRunOutcomeInput {
  return {
    source: "strategic_planner",
    workspaceId: input.configWorkspaceId || input.company.defaultWorkspaceId,
    companyId: input.company.id,
    title: `${input.company.name} planner failed`,
    summary: input.error,
    usefulness: "failed",
    trigger: input.trigger,
    nextAction: "Inspect the planner run error.",
    notificationRecommended: input.trigger !== "manual",
    notificationReason: "Automated planner run failed.",
  };
}

export function classifyCheckEvidence(input: {
  source: CreateAutomationRunOutcomeInput["source"];
  title: string;
  summary: string;
  trigger: AutomationRunTrigger;
  workspaceId?: string;
  taskId?: string;
  sourceRunId?: string;
  declaredCheck: boolean;
  executedCommandCount: number;
  toolCallCount: number;
  failedCheckCount?: number;
  limitationOnly?: boolean;
}): CreateAutomationRunOutcomeInput {
  const noRealCheckEvidence =
    input.declaredCheck &&
    input.executedCommandCount === 0 &&
    (input.toolCallCount === 0 || input.limitationOnly);
  const failed = (input.failedCheckCount || 0) > 0;
  return {
    source: input.source,
    sourceRunId: input.sourceRunId,
    taskId: input.taskId,
    workspaceId: input.workspaceId,
    title: input.title,
    summary: input.summary,
    usefulness: failed ? "failed" : noRealCheckEvidence ? "low_value" : "informational",
    trigger: input.trigger,
    metrics: {
      checkedSurfaceCount: input.executedCommandCount + input.toolCallCount,
      failedCheckCount: input.failedCheckCount || 0,
      executedCommandCount: input.executedCommandCount,
      toolCallCount: input.toolCallCount,
      limitationOnly: input.limitationOnly || false,
    },
    notificationRecommended: failed,
    notificationReason: failed ? "A background check failed." : undefined,
  };
}
