import type { AutomationRunOutcome, CreateAutomationRunOutcomeInput } from "../../shared/types";
import type { AutomationRunOutcomeRepository } from "./AutomationRunOutcomeRepository";
import {
  buildAutomationNotification,
  type AutomationNotificationPayload,
} from "./AutomationNotificationPolicy";
import { createLogger } from "../utils/logger";

const log = createLogger("AutomationOutcomeService");

interface AutomationOutcomeServiceDeps {
  repo: AutomationRunOutcomeRepository;
  notify?: (notification: AutomationNotificationPayload) => Promise<void>;
}

export class AutomationOutcomeService {
  constructor(private readonly deps: AutomationOutcomeServiceDeps) {}

  async record(input: CreateAutomationRunOutcomeInput): Promise<AutomationRunOutcome> {
    const outcome = this.deps.repo.create(input);
    const notification = buildAutomationNotification(outcome);
    if (!notification || !this.deps.notify) return outcome;

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
}
