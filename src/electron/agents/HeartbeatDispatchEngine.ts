import {
  AgentRole,
  HeartbeatResult,
  ProactiveSuggestion,
  Task,
  type ProactiveTaskDefinition,
} from "../../shared/types";
import {
  buildCoreAutomationAgentConfig,
  resolveOperationalAutonomyPolicy,
} from "./autonomy-policy";
import type { HeartbeatChecklistItem } from "./heartbeat-maintenance";
import type { SuggestionSource } from "../agent/SuggestionSink";

export interface HeartbeatDispatchDeps {
  createTask: (
    workspaceId: string,
    prompt: string,
    title: string,
    agentRoleId?: string,
    options?: {
      source?: Task["source"];
      agentConfig?: Task["agentConfig"];
      taskOverrides?: Partial<Task>;
    },
  ) => Promise<Task>;
  updateTask?: (taskId: string, updates: Partial<Task>) => void;
  createCompanionSuggestion?: (
    workspaceId: string,
    suggestion: {
      type?: ProactiveSuggestion["type"];
      title: string;
      description: string;
      actionPrompt?: string;
      confidence: number;
      suggestionClass?: ProactiveSuggestion["suggestionClass"];
      urgency?: ProactiveSuggestion["urgency"];
      learningSignalIds?: string[];
      workspaceScope?: "single" | "all";
      sourceSignals?: string[];
      recommendedDelivery?: ProactiveSuggestion["recommendedDelivery"];
      companionStyle?: ProactiveSuggestion["companionStyle"];
      sourceEntity?: string;
      sourceTaskId?: string;
      /** Entity the suggestion is about; the suggestion sink merges proposals per entity. */
      entityKey?: string;
      source?: SuggestionSource;
    },
  ) => Promise<ProactiveSuggestion | null>;
  addNotification?: (params: {
    type: "companion_suggestion" | "info" | "warning";
    title: string;
    message: string;
    workspaceId?: string;
    suggestionId?: string;
    recommendedDelivery?: "briefing" | "inbox" | "nudge";
    companionStyle?: "email" | "note";
  }) => Promise<void>;
  recordActivity?: (params: {
    workspaceId: string;
    agentRoleId: string;
    title: string;
    description?: string;
    metadata?: Record<string, unknown>;
  }) => void;
}

export interface DispatchExecutionInput {
  backgroundDispatchTicket?: string;
  agent: AgentRole;
  heartbeatRunId: string;
  workspaceId: string;
  reason: string;
  signalSummaries: string[];
  evidenceRefs: string[];
  dueChecklistItems: HeartbeatChecklistItem[];
  dueProactiveTasks: ProactiveTaskDefinition[];
  dispatchKind: "silent" | "suggestion" | "task" | "runbook" | "cron_handoff";
}

function buildTaskPrompt(input: DispatchExecutionInput): string {
  const sections = [
    `You are ${input.agent.displayName}, running a Heartbeat v3 dispatch.`,
    `Reason: ${input.reason}`,
  ];
  if (input.signalSummaries.length > 0) {
    sections.push(`Signals:\n- ${input.signalSummaries.join("\n- ")}`);
  }
  if (input.dueChecklistItems.length > 0) {
    sections.push(
      `Checklist items due:\n- ${input.dueChecklistItems.map((item) => item.title).join("\n- ")}`,
    );
  }
  if (input.dueProactiveTasks.length > 0) {
    sections.push(
      `Proactive tasks due:\n- ${input.dueProactiveTasks.map((item) => item.name).join("\n- ")}`,
    );
  }
  if (input.evidenceRefs.length > 0) {
    sections.push(`Evidence refs: ${input.evidenceRefs.join(", ")}`);
  }
  sections.push(`Always include the heartbeat run id in your notes: ${input.heartbeatRunId}.`);
  return sections.join("\n\n");
}

/**
 * The entity a heartbeat suggestion is about: the first task or mention it cites. Without one
 * the suggestion sink falls back to the normalized title.
 */
export function heartbeatSuggestionEntityKey(evidenceRefs: string[]): string | undefined {
  return (
    evidenceRefs.find((ref) => ref.startsWith("task:")) ||
    evidenceRefs.find((ref) => ref.startsWith("mention:"))
  );
}

export class HeartbeatDispatchEngine {
  constructor(private deps: HeartbeatDispatchDeps) {}

  async execute(input: DispatchExecutionInput): Promise<HeartbeatResult> {
    switch (input.dispatchKind) {
      case "task": {
        const title = `Heartbeat: ${input.reason}`;
        const task = await this.deps.createTask(
          input.workspaceId,
          buildTaskPrompt(input),
          title,
          input.agent.id,
          {
            source: "hook",
            agentConfig: {
              ...buildCoreAutomationAgentConfig(resolveOperationalAutonomyPolicy(input.agent)),
              backgroundDispatchTicket: input.backgroundDispatchTicket,
            },
            taskOverrides: {
              assignedAgentRoleId: input.agent.id,
              heartbeatRunId: input.heartbeatRunId,
            },
          },
        );
        this.deps.updateTask?.(task.id, {
          assignedAgentRoleId: input.agent.id,
          heartbeatRunId: input.heartbeatRunId,
        });
        this.deps.recordActivity?.({
          workspaceId: input.workspaceId,
          agentRoleId: input.agent.id,
          title: "Heartbeat dispatched task",
          description: input.reason,
          metadata: { heartbeatRunId: input.heartbeatRunId, taskId: task.id },
        });
        return {
          agentRoleId: input.agent.id,
          status: "work_done",
          runId: input.heartbeatRunId,
          runType: "dispatch",
          pendingMentions: 0,
          assignedTasks: 0,
          relevantActivities: 0,
          taskCreated: task.id,
          triggerReason: input.reason,
          dispatchKind: "task",
          evidenceRefsV3: input.evidenceRefs,
        };
      }
      case "runbook": {
        // Runbooks are not executed yet: this only records that they are due, so the result
        // reports no work done.
        this.deps.recordActivity?.({
          workspaceId: input.workspaceId,
          agentRoleId: input.agent.id,
          title: "Heartbeat runbook requested",
          description: input.reason,
          metadata: {
            heartbeatRunId: input.heartbeatRunId,
            checklistItems: input.dueChecklistItems.map((item) => item.title),
            proactiveTasks: input.dueProactiveTasks.map((item) => item.name),
          },
        });
        return {
          agentRoleId: input.agent.id,
          status: "ok",
          runId: input.heartbeatRunId,
          runType: "dispatch",
          pendingMentions: 0,
          assignedTasks: 0,
          relevantActivities: 0,
          triggerReason: input.reason,
          dispatchKind: "runbook",
          evidenceRefsV3: input.evidenceRefs,
        };
      }
      case "cron_handoff": {
        this.deps.recordActivity?.({
          workspaceId: input.workspaceId,
          agentRoleId: input.agent.id,
          title: "Heartbeat handed work to cron",
          description: input.reason,
          metadata: {
            heartbeatRunId: input.heartbeatRunId,
            proactiveTasks: input.dueProactiveTasks.map((item) => item.name),
          },
        });
        return {
          agentRoleId: input.agent.id,
          status: "ok",
          runId: input.heartbeatRunId,
          runType: "dispatch",
          pendingMentions: 0,
          assignedTasks: 0,
          relevantActivities: 0,
          triggerReason: input.reason,
          dispatchKind: "cron_handoff",
          evidenceRefsV3: input.evidenceRefs,
        };
      }
      case "suggestion":
      default: {
        const suggestion = await this.deps.createCompanionSuggestion?.(input.workspaceId, {
          type: "insight",
          title: `Heartbeat review: ${input.reason}`,
          description: input.signalSummaries.join(" | ") || input.reason,
          actionPrompt: buildTaskPrompt(input),
          confidence: 0.8,
          suggestionClass: "general",
          urgency: "medium",
          workspaceScope: "single",
          sourceSignals: input.evidenceRefs,
          recommendedDelivery: "inbox",
          companionStyle: "note",
          sourceEntity: "heartbeat_v3",
          entityKey: heartbeatSuggestionEntityKey(input.evidenceRefs),
          source: "heartbeat",
        });
        if (suggestion) {
          await this.deps.addNotification?.({
            type: "companion_suggestion",
            title: suggestion.title,
            message: suggestion.description,
            workspaceId: input.workspaceId,
            suggestionId: suggestion.id,
            recommendedDelivery: suggestion.recommendedDelivery,
            companionStyle: suggestion.companionStyle,
          });
        }
        this.deps.recordActivity?.({
          workspaceId: input.workspaceId,
          agentRoleId: input.agent.id,
          title: "Heartbeat posted suggestion",
          description: input.reason,
          metadata: { heartbeatRunId: input.heartbeatRunId, suggestionId: suggestion?.id },
        });
        return {
          agentRoleId: input.agent.id,
          status: "ok",
          runId: input.heartbeatRunId,
          runType: "dispatch",
          pendingMentions: 0,
          assignedTasks: 0,
          relevantActivities: 0,
          triggerReason: input.reason,
          dispatchKind: "suggestion",
          evidenceRefsV3: input.evidenceRefs,
        };
      }
    }
  }
}
