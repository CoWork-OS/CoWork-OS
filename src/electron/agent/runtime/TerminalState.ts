import type { Task } from "../../../shared/types";

export type TerminalKind =
  | "success"
  | "partial_success"
  | "timed_out"
  | "needs_user_action"
  | "cancelled"
  | "external_completed"
  | "deterministic_handled"
  | "failed";

export interface TerminalState {
  terminalKind: TerminalKind;
  terminalStatus: NonNullable<Task["terminalStatus"]>;
  failureClass?: Task["failureClass"];
  reason?: string;
  failedStepIds?: string[];
  incompleteStepIds?: string[];
}

export type TerminalStateInput = Partial<Omit<TerminalState, "terminalKind" | "terminalStatus">> & {
  terminalStatus?: Task["terminalStatus"];
};

export function createTerminalState(
  terminalKind: TerminalKind,
  input: TerminalStateInput = {},
): TerminalState {
  const terminalStatus = resolveTerminalStatus(terminalKind, input.terminalStatus);
  const failureClass = resolveFailureClass(terminalKind, terminalStatus, input.failureClass);
  return {
    terminalKind,
    terminalStatus,
    ...(failureClass ? { failureClass } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.failedStepIds?.length ? { failedStepIds: input.failedStepIds } : {}),
    ...(input.incompleteStepIds?.length ? { incompleteStepIds: input.incompleteStepIds } : {}),
  };
}

export function projectTerminalState(
  terminalState?: TerminalState,
): Pick<TerminalState, "terminalKind" | "terminalStatus" | "failureClass"> | undefined {
  if (!terminalState) return undefined;
  return {
    terminalKind: terminalState.terminalKind,
    terminalStatus: terminalState.terminalStatus,
    ...(terminalState.failureClass ? { failureClass: terminalState.failureClass } : {}),
  };
}

function resolveTerminalStatus(
  terminalKind: TerminalKind,
  override?: Task["terminalStatus"],
): NonNullable<Task["terminalStatus"]> {
  if (override) return override;
  switch (terminalKind) {
    case "success":
    case "external_completed":
    case "deterministic_handled":
      return "ok";
    case "partial_success":
    case "timed_out":
    case "cancelled":
      return "partial_success";
    case "needs_user_action":
      return "needs_user_action";
    case "failed":
      return "failed";
  }
}

function resolveFailureClass(
  terminalKind: TerminalKind,
  terminalStatus: Task["terminalStatus"],
  override?: Task["failureClass"],
): Task["failureClass"] | undefined {
  if (terminalStatus === "ok" || terminalStatus === "needs_user_action") return undefined;
  if (override) return override;
  switch (terminalKind) {
    case "timed_out":
    case "cancelled":
      return "budget_exhausted";
    case "failed":
      return "unknown";
    case "partial_success":
      return "contract_error";
    default:
      return undefined;
  }
}
