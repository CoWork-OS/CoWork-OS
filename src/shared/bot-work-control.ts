import { z } from "zod";
import { botResponsibilityScopeSchema } from "./bot-responsibility";
const id = z.string().trim().min(1).max(128);
export const botWorkControlRequestSchema = z
  .object({
    scope: botResponsibilityScopeSchema,
    requestId: id,
    action: z.enum([
      "stop_turn",
      "stop_bot",
      "resume_turn",
      "pause_bot",
      "resume_bot",
      "stop_and_pause",
    ]),
    taskId: id.optional(),
    expectedStopVersion: z.number().int().positive().optional(),
    expectedFutureControlVersion: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (["stop_turn", "resume_turn"].includes(input.action) !== !!input.taskId)
      ctx.addIssue({
        code: "custom",
        message: "Turn controls require a task; bot controls do not accept a task",
      });
    if ((input.action === "resume_turn") !== (input.expectedStopVersion !== undefined))
      ctx.addIssue({ code: "custom", message: "Resume requires the exact stop version" });
    if ((input.action === "resume_bot") !== (input.expectedFutureControlVersion !== undefined))
      ctx.addIssue({
        code: "custom",
        message: "Resume bot requires the exact future control version",
      });
  });
export const botWorkControlReadSchema = z
  .object({ scope: botResponsibilityScopeSchema, requestId: id })
  .strict();
export type BotWorkControlRequest = z.infer<typeof botWorkControlRequestSchema>;
export type BotWorkControlRead = z.infer<typeof botWorkControlReadSchema>;
export interface BotWorkControlReceipt {
  scope: z.infer<typeof botResponsibilityScopeSchema>;
  requestId: string;
  action: BotWorkControlRequest["action"];
  futureControl?: BotFutureControlState;
  recordedAt: number;
  updatedAt: number;
  status: "pending" | "settled";
  stillActiveTaskIds: string[];
  tasks: Array<{
    taskId: string;
    status: "requested" | "stopped" | "failed" | "released";
    stopVersion: number;
    error?: string;
  }>;
}

export const botWorkControlScopeSchema = z.object({ scope: botResponsibilityScopeSchema }).strict();
export interface BotFutureControlState {
  scope: z.infer<typeof botResponsibilityScopeSchema>;
  futurePaused: boolean;
  futureControlVersion: number;
  responsibilityIds: string[];
}

export function requiresWorkCleanup(action: BotWorkControlRequest["action"]): boolean {
  return ["stop_turn", "stop_bot", "stop_and_pause"].includes(action);
}
