import { MailboxEvent } from "../../shared/mailbox";
import { KnowledgeGraphService } from "../knowledge-graph/KnowledgeGraphService";
import { RelationshipMemoryService } from "../memory/RelationshipMemoryService";
import { PlaybookService } from "../memory/PlaybookService";
import type { EventTriggerService } from "../triggers/EventTriggerService";
import type { TriggerEvent } from "../triggers/types";
import type { HeartbeatService } from "../agents/HeartbeatService";

type MailboxAutomationHubDeps = {
  triggerService?: EventTriggerService | null;
  heartbeatService?: HeartbeatService | null;
  resolveDefaultWorkspaceId?: () => string | undefined;
  emitMailboxEvent?: (event: MailboxEvent) => void;
  log?: (...args: unknown[]) => void;
};

type MailboxSignalPlan = {
  signalFamily:
    | "open_loop_pressure"
    | "suggestion_aging"
    | "maintenance"
    | "awareness_signal"
    | "memory_drift";
  urgency: "low" | "medium" | "high" | "critical";
  confidence: number;
  reason: string;
  fingerprint: string;
};

const EMPTY_DEPS: MailboxAutomationHubDeps = {};

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => asString(entry)).filter((entry): entry is string => Boolean(entry))
    : [];
}

function createMailboxTriggerEvent(event: MailboxEvent): TriggerEvent {
  const payload = event.payload || {};
  const fields: Record<string, string | number | boolean> = {
    eventType: event.type,
    workspaceId: event.workspaceId,
    threadId: event.threadId || "",
    subject: event.subject || "",
    summary: event.summary || "",
    accountId: event.accountId || "",
    provider: event.provider || "",
    evidenceCount: event.evidenceRefs.length,
  };

  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      fields[key] = value;
    }
  }

  return {
    source: "mailbox_event",
    timestamp: event.timestamp,
    fields,
  };
}

function buildSignalPlan(event: MailboxEvent): MailboxSignalPlan | null {
  const subject = event.subject || "";
  const summary = event.summary || "";
  const payload = event.payload || {};
  const needsReply = Boolean(payload.needsReply);
  const staleFollowup = Boolean(payload.staleFollowup);
  const cleanupCandidate = Boolean(payload.cleanupCandidate);
  const commitmentCount = Number(payload.commitmentCount || 0);
  const actionType = asString(payload.actionType);

  switch (event.type) {
    case "sync_completed":
      return {
        signalFamily: "awareness_signal",
        urgency: "medium",
        confidence: 0.62,
        reason: `Mailbox sync completed (${Number(payload.threadCount || 0)} threads)`,
        fingerprint: `mailbox:sync:${event.workspaceId}:${event.accountId || "all"}:${event.timestamp}`,
      };
    case "thread_classified":
      return {
        signalFamily:
          staleFollowup || needsReply || commitmentCount > 0
            ? "open_loop_pressure"
            : cleanupCandidate
              ? "suggestion_aging"
              : "awareness_signal",
        urgency: staleFollowup || needsReply ? "high" : cleanupCandidate ? "medium" : "low",
        confidence: Number(payload.confidence || 0.66),
        reason: subject || summary || "Thread classified",
        fingerprint: `mailbox:classified:${event.threadId}:${payload.classificationFingerprint || event.timestamp}`,
      };
    case "thread_summarized":
      return {
        signalFamily: "awareness_signal",
        urgency: "low",
        confidence: 0.55,
        reason: summary || subject || "Thread summarized",
        fingerprint: `mailbox:summary:${event.threadId}:${event.timestamp}`,
      };
    case "draft_created":
      return {
        signalFamily: "memory_drift",
        urgency: "low",
        confidence: 0.58,
        reason: subject || "Draft created",
        fingerprint: `mailbox:draft:${event.threadId}:${payload.draftId || event.timestamp}`,
      };
    case "commitments_extracted":
      return {
        signalFamily: "open_loop_pressure",
        urgency: commitmentCount > 1 ? "high" : "medium",
        confidence: 0.72,
        reason: `${commitmentCount} commitment(s) extracted`,
        fingerprint: `mailbox:commitments:${event.threadId}:${payload.commitmentFingerprint || event.timestamp}`,
      };
    case "commitment_updated":
      return {
        signalFamily:
          actionType === "done" || actionType === "dismissed"
            ? "maintenance"
            : "open_loop_pressure",
        urgency: actionType === "done" || actionType === "dismissed" ? "low" : "medium",
        confidence: 0.7,
        reason: `Commitment ${actionType || "updated"}`,
        fingerprint: `mailbox:commitment-update:${payload.commitmentId || event.threadId}:${event.timestamp}`,
      };
    case "action_applied":
      return {
        signalFamily: "maintenance",
        urgency: "low",
        confidence: 0.64,
        reason: actionType ? `Action applied: ${actionType}` : "Mailbox action applied",
        fingerprint: `mailbox:action:${event.threadId}:${actionType || event.timestamp}`,
      };
    case "contact_researched":
      return {
        signalFamily: "awareness_signal",
        urgency: "low",
        confidence: 0.52,
        reason: subject || "Contact researched",
        fingerprint: `mailbox:research:${event.threadId}:${event.timestamp}`,
      };
    default:
      return null;
  }
}

function buildMailboxFacts(event: MailboxEvent): string[] {
  const payload = event.payload || {};
  const facts = [
    event.subject ? `Thread subject: ${event.subject}` : null,
    event.summary ? `Summary: ${event.summary}` : null,
    asString(payload.primaryContactEmail)
      ? `Primary contact: ${asString(payload.primaryContactEmail)}`
      : null,
    asString(payload.company) ? `Company: ${asString(payload.company)}` : null,
    asString(payload.projectHint) ? `Project: ${asString(payload.projectHint)}` : null,
  ].filter((entry): entry is string => Boolean(entry));
  return facts;
}

function buildMailboxCommitments(event: MailboxEvent): Array<{ text: string; dueAt?: number }> {
  const payload = event.payload || {};
  const titles = asStringArray(payload.commitmentTitles);
  const dueAt = typeof payload.dueAt === "number" ? payload.dueAt : undefined;
  return titles.slice(0, 6).map((text) => ({ text, dueAt }));
}

export class MailboxAutomationHub {
  private static deps: MailboxAutomationHubDeps = { ...EMPTY_DEPS };

  static configure(deps: MailboxAutomationHubDeps): void {
    this.deps = { ...this.deps, ...deps };
  }

  static reset(): void {
    this.deps = { ...EMPTY_DEPS };
  }

  static handleMailboxEvent(event: MailboxEvent): void {
    const deps = this.deps;
    const workspaceId = event.workspaceId || deps.resolveDefaultWorkspaceId?.();
    if (!workspaceId) return;

    try {
      deps.emitMailboxEvent?.(event);
    } catch (error) {
      deps.log?.("[MailboxAutomationHub] Failed to emit mailbox event:", error);
    }

    try {
      KnowledgeGraphService.ingestMailboxEvent(workspaceId, event);
    } catch (error) {
      deps.log?.("[MailboxAutomationHub] KG ingestion failed:", error);
    }

    try {
      RelationshipMemoryService.rememberMailboxInsights({
        facts: buildMailboxFacts(event),
        commitments: buildMailboxCommitments(event),
      });
    } catch (error) {
      deps.log?.("[MailboxAutomationHub] Relationship memory update failed:", error);
    }

    try {
      const triggerEvent = createMailboxTriggerEvent(event);
      deps.triggerService?.evaluateEvent(triggerEvent);
    } catch (error) {
      deps.log?.("[MailboxAutomationHub] Trigger evaluation failed:", error);
    }

    const plan = buildSignalPlan(event);
    if (plan && deps.heartbeatService) {
      try {
        deps.heartbeatService.submitSignalForAll({
          workspaceId,
          signalFamily: plan.signalFamily,
          source: "hook",
          urgency: plan.urgency,
          confidence: plan.confidence,
          fingerprint: plan.fingerprint,
          reason: plan.reason,
          evidenceRefs: event.evidenceRefs,
          payload: {
            mailboxEventType: event.type,
            threadId: event.threadId,
            subject: event.subject,
            summary: event.summary,
          },
        });
      } catch (error) {
        deps.log?.("[MailboxAutomationHub] Heartbeat signal submission failed:", error);
      }
    }

    if (event.type === "draft_created") {
      try {
        void PlaybookService.captureMailboxPattern(workspaceId, {
          title: event.subject || "Draft created",
          summary: event.summary || "Mailbox draft was created",
          evidenceRefs: event.evidenceRefs,
          payload: event.payload,
        }).catch((error) => {
          deps.log?.("[MailboxAutomationHub] Playbook capture promise rejected:", error);
        });
      } catch (error) {
        deps.log?.("[MailboxAutomationHub] Playbook capture failed:", error);
      }
    }
  }
}
