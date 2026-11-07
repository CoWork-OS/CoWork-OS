/**
 * The sidebar owns the "Session archived · Undo" notice. Archiving from anywhere else (the task
 * header's actions menu) announces it here so the same notice and Undo appear.
 */
export const SESSION_ARCHIVED_EVENT = "cowork:session-archived";

export interface SessionArchivedDetail {
  taskId: string;
  /** Undo reopens the session when it was the one on screen. */
  wasSelected: boolean;
}

export function announceSessionArchived(detail: SessionArchivedDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<SessionArchivedDetail>(SESSION_ARCHIVED_EVENT, { detail }));
}
