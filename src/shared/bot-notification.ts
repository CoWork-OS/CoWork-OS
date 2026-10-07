import { z } from "zod";
const id = z.string().trim().min(1).max(128);
export const botNotificationScopeSchema = z.object({ workspaceId: id, agentRoleId: id }).strict();
export type BotNotificationScope = z.infer<typeof botNotificationScopeSchema>;
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const timezone = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Unknown timezone");
export const botNotificationOptionsSchema = z
  .object({
    enabled: z.boolean(),
    destination: z.enum(["inbox", "desktop"]),
    quietHours: z
      .object({ start: time, end: time, timeZone: timezone })
      .strict()
      .refine(
        (value) => value.start !== value.end,
        "Quiet hours must have different start and end times",
      )
      .nullable(),
    digestMinutes: z
      .number()
      .int()
      .min(0)
      .max(1440)
      .refine((value) => value === 0 || value >= 15, "Digest must be off or at least 15 minutes"),
  })
  .strict();
export type BotNotificationOptions = z.infer<typeof botNotificationOptionsSchema>;
export interface BotNotificationRoute extends BotNotificationOptions {
  scope: BotNotificationScope;
  version: number;
  activatedAt: number;
  updatedAt: number;
  onFinish: boolean;
  onInputRequired: boolean;
}
export const botNotificationUpdateSchema = z
  .object({
    scope: botNotificationScopeSchema,
    requestId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(),
    options: botNotificationOptionsSchema,
  })
  .strict();
export type BotNotificationUpdate = z.infer<typeof botNotificationUpdateSchema>;
export interface BotNotificationReceipt {
  id: string;
  scope: BotNotificationScope;
  taskId: string;
  kind: "decision" | "result" | "failure";
  state: "queued" | "delivering" | "stored_in_inbox" | "delivery_unknown" | "cancelled";
  destination: "inbox" | "desktop";
  dueAt: number;
  createdAt: number;
  notificationId?: string;
  desktop: "not_requested" | "requested" | "unavailable";
  reason?: string;
}
export const DEFAULT_BOT_NOTIFICATION_OPTIONS: BotNotificationOptions = {
  enabled: false,
  destination: "inbox",
  quietHours: null,
  digestMinutes: 0,
};
const formatters = new Map<string, Intl.DateTimeFormat>();
export function inBotQuietHours(options: BotNotificationOptions, now: number): boolean {
  const quiet = options.quietHours;
  if (!quiet) return false;
  let formatter = formatters.get(quiet.timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: quiet.timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    if (formatters.size >= 32) formatters.delete(formatters.keys().next().value!);
    formatters.set(quiet.timeZone, formatter);
  }
  const parts = formatter.formatToParts(now);
  const minute =
    Number(parts.find((p) => p.type === "hour")?.value) * 60 +
    Number(parts.find((p) => p.type === "minute")?.value);
  const parse = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const start = parse(quiet.start),
    end = parse(quiet.end);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}
export function botNotificationDue(
  options: BotNotificationOptions,
  kind: BotNotificationReceipt["kind"],
  now: number,
): number {
  const interval = options.digestMinutes * 60000;
  let due = kind !== "decision" && interval ? Math.ceil((now + 1) / interval) * interval : now;
  // Minute stepping resolves timezone offsets and DST through the runtime's IANA data.
  for (let count = 0; inBotQuietHours(options, due) && count < 2880; count++)
    due = Math.floor(due / 60000) * 60000 + 60000;
  if (inBotQuietHours(options, due)) throw Error("Quiet hours could not be resolved");
  return due;
}

export const botNotificationRetrySchema = z
  .object({
    scope: botNotificationScopeSchema,
    requestId: z.string().uuid(),
    intentId: id,
    expectedRouteVersion: z.number().int().nonnegative(),
  })
  .strict();
export type BotNotificationRetry = z.infer<typeof botNotificationRetrySchema>;
