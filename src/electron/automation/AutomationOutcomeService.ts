import { createHash, randomUUID } from "node:crypto";
import type { AutomationRunOutcome, CreateAutomationRunOutcomeInput } from "../../shared/types";
import type { AutomationRunOutcomeRepository } from "./AutomationRunOutcomeRepository";
import {
  buildAutomationNotification,
  type AutomationNotificationPayload,
} from "./AutomationNotificationPolicy";
import { createLogger } from "../utils/logger";

const log = createLogger("AutomationOutcomeService");

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function canonicalizeEvidenceRefs(input: CreateAutomationRunOutcomeInput): unknown[] {
  return (input.evidenceRefs || [])
    .map((entry) => canonicalize(entry))
    .sort((left, right) => (JSON.stringify(left) || "").localeCompare(JSON.stringify(right) || ""));
}

function deriveChangeHash(input: CreateAutomationRunOutcomeInput): string {
  const meaningfulOutput = canonicalize({
    source: input.source,
    title: input.title,
    summary: input.summary,
    usefulness: input.usefulness,
    trigger: input.trigger,
    metrics: input.metrics || null,
    evidenceRefs: canonicalizeEvidenceRefs(input),
    nextAction: input.nextAction || null,
  });
  return createHash("sha256").update(JSON.stringify(meaningfulOutput)).digest("hex");
}

function deriveNotificationKey(input: CreateAutomationRunOutcomeInput): string {
  const explicitKey = input.notificationKey?.trim();
  if (explicitKey) return explicitKey;

  // Prefer the job identity over the containing workspace. Multiple heartbeat
  // or planner jobs can share a workspace but must not suppress one another.
  const owner = input.agentRoleId || input.companyId || input.workspaceId || input.taskId;
  const ownerType = input.agentRoleId
    ? "agent"
    : input.companyId
      ? "company"
      : input.workspaceId
        ? "workspace"
        : "task";
  return owner ? `automation:${input.source}:${ownerType}:${owner}` : `automation:${input.source}`;
}

function deriveNotificationScope(
  outcome: Pick<
    AutomationRunOutcome,
    "workspaceId" | "companyId" | "agentRoleId" | "taskId" | "source"
  >,
): string {
  if (outcome.agentRoleId) return `agent:${outcome.agentRoleId}`;
  if (outcome.companyId) return `company:${outcome.companyId}`;
  if (outcome.workspaceId) return `workspace:${outcome.workspaceId}`;
  if (outcome.taskId) return `task:${outcome.taskId}`;
  return `source:${outcome.source}`;
}

interface AutomationOutcomeServiceDeps {
  repo: AutomationRunOutcomeRepository;
  notify?: (notification: AutomationNotificationPayload) => Promise<void>;
}

export class AutomationOutcomeService {
  constructor(private readonly deps: AutomationOutcomeServiceDeps) {}

  async record(input: CreateAutomationRunOutcomeInput): Promise<AutomationRunOutcome> {
    const normalizedInput: CreateAutomationRunOutcomeInput = {
      ...input,
      changeHash: input.changeHash?.trim() || deriveChangeHash(input),
      notificationKey: deriveNotificationKey(input),
    };
    const previous = this.deps.repo.findLatestByNotificationKey?.(
      normalizedInput.notificationKey || "",
      deriveNotificationScope(normalizedInput),
    );
    const storedOutcome = this.deps.repo.create(normalizedInput);
    const outcome: AutomationRunOutcome = {
      ...storedOutcome,
      changeHash: storedOutcome.changeHash || normalizedInput.changeHash,
      notificationKey: storedOutcome.notificationKey || normalizedInput.notificationKey,
    };
    const notification = buildAutomationNotification(outcome);
    if (!notification || !this.deps.notify) return outcome;

    if (previous?.changeHash && previous.changeHash === outcome.changeHash) {
      const skippedAt = Date.now();
      this.deps.repo.markNotificationSkipped?.(outcome.id, "unchanged_output", skippedAt);
      return {
        ...outcome,
        notificationSkippedAt: skippedAt,
        notificationSkipReason: "unchanged_output",
      };
    }

    try {
      await this.deps.notify(notification);
      this.deps.repo.markNotificationDelivered(outcome.id);
      return {
        ...outcome,
        notificationDeliveredAt: Date.now(),
      };
    } catch (error) {
      log.warn("Failed to deliver automation outcome notification:", error);
      return outcome;
    }
  }

  /** Retry a previously suppressed or failed notification with a new delivery id. */
  async retryNotification(outcomeId: string): Promise<AutomationRunOutcome> {
    const outcome = this.deps.repo.findById?.(outcomeId);
    if (!outcome) throw new Error("Automation outcome not found.");
    const notification = buildAutomationNotification(outcome);
    if (!notification || !this.deps.notify) return outcome;
    await this.deps.notify({ ...notification, deliveryId: randomUUID() });
    const deliveredAt = Date.now();
    this.deps.repo.markNotificationDelivered(outcome.id, deliveredAt);
    return {
      ...outcome,
      notificationDeliveredAt: deliveredAt,
      notificationSkippedAt: undefined,
      notificationSkipReason: undefined,
    };
  }
}
