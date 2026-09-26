import type { Task } from "./types";

export function firstTaskRecovery(
  task: Pick<Task, "status" | "error" | "failureClass">,
): string | null {
  if (task.status === "cancelled")
    return "The sample was cancelled. Start a fresh attempt when you are ready.";
  if (task.status === "interrupted")
    return "The application is reconnecting to this task. Review its timeline before starting another attempt.";
  if (task.status !== "failed") return null;
  const detail = `${task.error ?? ""} ${task.failureClass ?? ""}`.toLowerCase();
  if (/unauthori[sz]ed|authentication|api.?key|credential|401|403/.test(detail))
    return "The model route rejected access. Reconnect it in AI settings, then start a fresh attempt.";
  if (/model.*(not found|unavailable|invalid)|404/.test(detail))
    return "The selected model is unavailable. Choose an available model in AI settings, then check the route again.";
  if (/tool.?call|function.?call|unsupported tool/.test(detail))
    return "This route did not use the required file tools. Choose a tool-capable model and check it again.";
  if (/permission|sandbox|denied|blocked/.test(detail))
    return "A task permission blocked the sample. Review the task timeline; keep the sample workspace-only policy.";
  if (/budget|quota|rate.?limit|429/.test(detail))
    return "The model hit a budget or provider limit. Review the provider limit before a fresh attempt.";
  return "Review the task timeline for the failure, then start a fresh attempt. Earlier sample files remain available.";
}
