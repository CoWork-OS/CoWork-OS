import type { Task } from "../../../shared/types";

export function isTurnThisIntoRoutinePrompt(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  return /^(please\s+)?(turn|make|convert)\s+(this|that|it)\s+into\s+(a\s+)?routine[.!?]?$/.test(
    normalized,
  );
}

export function taskCanBecomeRoutineFromFollowUp(task: Task | null | undefined): boolean {
  if (!task) return false;
  if (task.status !== "completed") return false;
  return !task.terminalStatus || task.terminalStatus === "ok";
}
