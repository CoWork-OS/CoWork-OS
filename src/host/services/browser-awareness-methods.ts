import { z } from "zod";
import type { AwarenessService } from "../../electron/awareness/AwarenessService";
import type { AwarenessConfig, Workspace } from "../../shared/types";
import type { BrowserDesktopDefinition, BrowserDesktopDefinitions } from "./browser-desktop-rpc";
import { WebApplicationError } from "../web/WebApplication";

const id = z.string().trim().min(1).max(200);
const sources = z.enum([
  "conversation",
  "feedback",
  "files",
  "git",
  "apps",
  "browser",
  "calendar",
  "notifications",
  "clipboard",
  "tasks",
]);
const policy = z
  .object({
    enabled: z.boolean().optional(),
    ttlMinutes: z.number().int().min(1).max(10080).optional(),
    allowPromotion: z.boolean().optional(),
    allowPromptInjection: z.boolean().optional(),
    allowHeartbeat: z.boolean().optional(),
  })
  .strict();
const config = z
  .object({
    privateModeEnabled: z.boolean().optional(),
    defaultTtlMinutes: z.number().int().min(1).max(10080).optional(),
    sources: z.partialRecord(sources, policy).optional(),
  })
  .strict();
const beliefPatch = z
  .object({
    confidence: z.number().finite().min(0).max(1).optional(),
    value: z.string().trim().min(1).max(220).optional(),
    promotionStatus: z.enum(["observed", "promoted", "confirmed"]).optional(),
  })
  .strict();

export function createBrowserAwarenessDefinitions(options: {
  service: AwarenessService;
  resolveWorkspace: (workspaceId: string) => Promise<Workspace | null>;
}): BrowserDesktopDefinitions {
  const authorize = async (
    workspaceId: string,
    permission: "read" | "write" | "delete" = "read",
  ) => {
    const workspace = await options.resolveWorkspace(workspaceId);
    if (!workspace?.permissions.read || !workspace.permissions[permission])
      throw new WebApplicationError("FORBIDDEN", "Workspace awareness access is unavailable.", 403);
  };
  const definition = <S extends z.ZodType>(
    schema: S,
    handler: (value: z.infer<S>) => unknown,
    mutation = false,
  ): BrowserDesktopDefinition => ({
    capability: "memory.manage",
    mutation,
    minArgs: 1,
    maxArgs: 1,
    validate: (args) => [schema.parse(args[0])],
    handler: ([value]) => handler(value as z.infer<S>),
  });
  const scoped = (handler: (workspaceId: string) => unknown) =>
    definition(id, async (workspaceId) => {
      await authorize(workspaceId);
      return handler(workspaceId);
    });
  const authorizeBelief = async (beliefId: string, permission: "write" | "delete") => {
    const belief = options.service.listBeliefs().find((item) => item.id === beliefId);
    if (!belief)
      throw new WebApplicationError("NOT_FOUND", "Awareness belief is unavailable.", 404);
    if (belief.workspaceId) await authorize(belief.workspaceId, permission);
  };
  return {
    getAwarenessConfig: {
      capability: "memory.manage",
      minArgs: 0,
      maxArgs: 0,
      handler: () => options.service.getConfig(),
    },
    saveAwarenessConfig: definition(
      config,
      (patch) => {
        const current = options.service.getConfig();
        const merged: AwarenessConfig = { ...current, ...patch, sources: { ...current.sources } };
        for (const [source, changes] of Object.entries(patch.sources ?? {}))
          merged.sources[source as keyof AwarenessConfig["sources"]] = {
            ...current.sources[source as keyof AwarenessConfig["sources"]],
            ...changes,
          };
        return options.service.saveConfig(merged);
      },
      true,
    ),
    listAwarenessBeliefs: scoped((workspaceId) =>
      options.service.listBeliefs(workspaceId).slice(0, 200),
    ),
    getAwarenessSummary: scoped((workspaceId) => options.service.getSummary(workspaceId)),
    getAwarenessSnapshot: scoped((workspaceId) => options.service.getSnapshot(workspaceId)),
    listAwarenessEvents: definition(
      z.object({ workspaceId: id, limit: z.number().int().min(1).max(200).optional() }).strict(),
      async (value) => {
        await authorize(value.workspaceId);
        return options.service
          .listEvents({ workspaceId: value.workspaceId, limit: value.limit ?? 50 })
          .map(({ payload: _payload, ...event }) => event);
      },
    ),
    updateAwarenessBelief: {
      capability: "memory.manage",
      mutation: true,
      minArgs: 2,
      maxArgs: 2,
      validate: ([beliefId, patch]) => [id.parse(beliefId), beliefPatch.parse(patch)],
      handler: async ([beliefId, patch]) => {
        await authorizeBelief(beliefId as string, "write");
        return options.service.updateBelief(
          beliefId as string,
          patch as z.infer<typeof beliefPatch>,
        );
      },
    },
    deleteAwarenessBelief: definition(
      id,
      async (beliefId) => {
        await authorizeBelief(beliefId, "delete");
        return { success: options.service.deleteBelief(beliefId) };
      },
      true,
    ),
  };
}
