import { z } from "zod";
import {
  botWorkControlRequestSchema,
  type BotWorkControlRead,
  type BotWorkControlRequest,
} from "../../shared/bot-work-control";
export type WorkControlStorage = Pick<Storage, "getItem" | "setItem">;
const cacheSchema = z
  .object({
    version: z.literal(1),
    request: botWorkControlRequestSchema,
    stopped: z
      .array(
        z
          .object({ taskId: z.string().min(1).max(128), stopVersion: z.number().int().positive() })
          .strict(),
      )
      .max(10000),
  })
  .strict();
export type WorkControlCache = z.infer<typeof cacheSchema>;
const MAX_CHARACTERS = 1024 * 1024;
export function workControlCacheKey(scope: BotWorkControlRead["scope"]): string {
  return `cowork.botWorkControl.v1:${JSON.stringify([scope.workspaceId, scope.agentRoleId])}`;
}
export function defaultWorkControlStorage(): WorkControlStorage | null | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}
export function readWorkControlCache(
  scope: BotWorkControlRead["scope"],
  storage?: WorkControlStorage | null,
): WorkControlCache | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(workControlCacheKey(scope));
    if (!raw || raw.length > MAX_CHARACTERS) return null;
    const result = cacheSchema.safeParse(JSON.parse(raw));
    if (
      !result.success ||
      result.data.request.scope.workspaceId !== scope.workspaceId ||
      result.data.request.scope.agentRoleId !== scope.agentRoleId
    )
      return null;
    return result.data;
  } catch {
    return null;
  }
}
/** Store identifiers and stop versions only, never task text, receipt errors or bot instructions. */
export function writeWorkControlCache(
  request: BotWorkControlRequest,
  stopped: WorkControlCache["stopped"],
  storage?: WorkControlStorage | null,
): void {
  if (storage === undefined) return; // Non-browser unit consumers use the in-memory controller.
  if (!storage) throw new Error("Recovery storage is unavailable");
  const value = JSON.stringify(cacheSchema.parse({ version: 1, request, stopped }));
  if (value.length > MAX_CHARACTERS) throw new Error("Recovery state exceeds the storage limit");
  storage.setItem(workControlCacheKey(request.scope), value);
}
