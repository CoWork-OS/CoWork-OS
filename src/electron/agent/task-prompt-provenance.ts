/**
 * Who wrote a task's title and prompt (Task.promptProvenance).
 *
 * The admin-lane tools (persona, behavioral rules, expertise, heartbeat, integration setup)
 * save into the system prompt of every later task, so only the user's own words may expose
 * them (tool-policy-engine.ts, ToolAvailabilityContext.userText). Tasks are created from many
 * places besides a composer: mail commitments, the strategic planner, orchestration and
 * workflow steps, remote agents, automations, other agents. Their `source` is often "manual",
 * "api" or unset, so it cannot say who wrote the prompt. Each creation path a person types
 * into marks its task "user_typed" (follow-up-provenance.ts does the same for follow-ups), and
 * an unmarked task's prompt never counts.
 */
import type { Task } from "../../shared/types";
import { isThirdPartyGatewayTask } from "../gateway/gateway-sender-identity";

export const USER_TYPED_TASK_PROMPT = { promptProvenance: "user_typed" } as const satisfies Pick<
  Task,
  "promptProvenance"
>;

/**
 * Provenance for a fork or side chat of `source`. It keeps the source task's value only when
 * it reuses the source task's own prompt; a prompt taken from a message in the history may
 * have been injected, and one a caller passed in was not typed into this task.
 */
export function forkedTaskPromptProvenance(
  source: Pick<Task, "promptProvenance">,
  reusesSourcePrompt: boolean,
): Pick<Task, "promptProvenance"> {
  return reusesSourcePrompt && source.promptProvenance === "user_typed"
    ? USER_TYPED_TASK_PROMPT
    : {};
}

/**
 * Whether the user wrote this task's title and prompt. Requires the "user_typed" marker; a
 * task another agent spawned or a channel sender other than the verified owner started never
 * counts, even if a marker was copied onto it.
 */
export function isTaskPromptFromUser(
  task: Pick<Task, "promptProvenance" | "parentTaskId" | "agentType" | "agentConfig">,
): boolean {
  return (
    task.promptProvenance === "user_typed" &&
    !task.parentTaskId &&
    (task.agentType === undefined || task.agentType === "main") &&
    !isThirdPartyGatewayTask(task)
  );
}
