import type { TaskEvent } from "./types";

export const COMPOSER_PREDICTION_CHANNEL = "composer:predict";
export const COMPOSER_PREDICTION_CANCEL_CHANNEL = "composer:cancelPrediction";
export interface ComposerPredictionRequest {
  requestId: string;
  taskId: string;
  revision: string;
}
export interface ComposerPrediction {
  revision: string;
  text: string;
}

export function predictionConversation(events: TaskEvent[]) {
  return events.filter((event) => {
    const type = event.legacyType || event.type;
    return (
      ["user_message", "assistant_message", "task_completed"].includes(type) &&
      event.payload?.internal !== true &&
      event.payload?.messageSource !== "agent"
    );
  });
}
export function predictionRevision(events: TaskEvent[]): string {
  return predictionConversation(events).at(-1)?.id || "";
}
