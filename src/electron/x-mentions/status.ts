import { XMentionTriggerStatus } from "../../shared/types";

const DEFAULT_STATUS: XMentionTriggerStatus = {
  mode: "disabled",
  running: false,
  acceptedCount: 0,
  ignoredCount: 0,
};

export class XMentionTriggerStatusStore {
  private status: XMentionTriggerStatus = { ...DEFAULT_STATUS };

  snapshot(): XMentionTriggerStatus {
    return { ...this.status };
  }

  setMode(mode: XMentionTriggerStatus["mode"], running: boolean): void {
    this.status = {
      ...this.status,
      mode,
      running,
    };
  }

  markPoll(): void {
    this.status = {
      ...this.status,
      lastPollAt: Date.now(),
    };
  }

  markSuccess(): void {
    this.status = {
      ...this.status,
      lastSuccessAt: Date.now(),
      lastError: undefined,
    };
  }

  markError(error: string): void {
    const message = String(error || "").trim();
    this.status = {
      ...this.status,
      lastError: message || "Unknown error",
    };
  }

  incrementAccepted(): void {
    this.status = {
      ...this.status,
      acceptedCount: this.status.acceptedCount + 1,
    };
  }

  incrementIgnored(): void {
    this.status = {
      ...this.status,
      ignoredCount: this.status.ignoredCount + 1,
    };
  }

  setLastTaskId(taskId: string): void {
    const normalized = String(taskId || "").trim();
    if (!normalized) return;
    this.status = {
      ...this.status,
      lastTaskId: normalized,
    };
  }
}

const sharedStore = new XMentionTriggerStatusStore();

export function getXMentionTriggerStatusStore(): XMentionTriggerStatusStore {
  return sharedStore;
}

export function getXMentionTriggerStatus(): XMentionTriggerStatus {
  return sharedStore.snapshot();
}
