import { botResponsibilityScopeSchema, type BotResponsibilityScope } from "./bot-responsibility";

export const RESPONSIBILITY_TIMING = {
  manual: "On demand",
  hourly: "Every hour",
  daily: "Daily at 09:00",
  weekdays: "Weekdays at 09:00",
} as const;
export type ResponsibilityTiming = keyof typeof RESPONSIBILITY_TIMING;

/** Creates an inert existing-engine definition; preview and activation remain separate. */
export function buildPausedResponsibilityRoutine(input: {
  scope: BotResponsibilityScope;
  name: string;
  timing: ResponsibilityTiming;
  timezone?: string;
}) {
  const scope = botResponsibilityScopeSchema.parse(input.scope);
  const name = input.name.trim();
  if (!name || name.length > 120)
    throw new Error("Give the routine a name of at most 120 characters.");
  if (!Object.hasOwn(RESPONSIBILITY_TIMING, input.timing))
    throw new Error("Choose a supported timing.");
  const timezone = input.timezone?.trim();
  if (timezone) new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  const schedule =
    input.timing === "hourly"
      ? { kind: "every" as const, everyMs: 3600000 }
      : {
          kind: "cron" as const,
          expr: input.timing === "weekdays" ? "0 9 * * 1-5" : "0 9 * * *",
          ...(timezone ? { tz: timezone } : {}),
        };
  return {
    name,
    enabled: false,
    workspaceId: scope.workspaceId,
    instructions:
      "Carry out the current bound bot responsibility. Follow its objective, selected sources, output contract and granted scope.",
    executionTarget: { kind: "workspace" as const },
    contextBindings: { metadata: { assignedAgentRoleId: scope.agentRoleId } },
    approvalPolicy: { mode: "strict_confirm" as const },
    connectorPolicy: { mode: "allowlist" as const, connectorIds: [] },
    outputs: [{ kind: "task_only" as const }],
    triggers: [
      input.timing === "manual"
        ? { id: crypto.randomUUID(), type: "manual" as const, enabled: true }
        : { id: crypto.randomUUID(), type: "schedule" as const, enabled: true, schedule },
    ],
  };
}
