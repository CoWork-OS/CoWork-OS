import type { TaskEvent } from "../../shared/types";
import { getEffectiveTaskEventType } from "./task-event-compat";

/** A persisted receipt can arrive before the send IPC returns (including ACP turns). */
export function createComposerSubmissionAcceptance(taskId: string, messageId: string) {
  let received = false;
  let resolveReceipt!: (accepted: boolean) => void;
  const receipt = new Promise<boolean>((resolve) => {
    resolveReceipt = resolve;
  });
  return {
    hasReceipt: () => received,
    observe(events: TaskEvent[]) {
      if (received) return;
      const matched = events.some((event) => {
        const payload = event.payload;
        return (
          event.taskId === taskId &&
          getEffectiveTaskEventType(event) === "user_message" &&
          payload?.messageId === messageId &&
          payload.deliveryMode === "follow_up" &&
          ["queued", "started", "accepted"].includes(payload.deliveryStatus ?? payload.status)
        );
      });
      if (matched) {
        received = true;
        resolveReceipt(true);
      }
    },
    waitFor(submission: void | boolean | Promise<void | boolean>) {
      return Promise.race([Promise.resolve(submission), receipt]);
    },
  };
}
