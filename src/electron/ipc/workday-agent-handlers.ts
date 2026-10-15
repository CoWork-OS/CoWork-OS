/**
 * IPC for in-app Workday agent setup (docs/remote-mcp-oauth.md): save the admin
 * connection, sign in with the admin client, list agent definitions, search the
 * tool catalog and save a definition. Payloads are validated with zod in main;
 * the renderer never receives the admin secret or token and cannot choose which
 * page opens or which host admin calls reach.
 */
import { ipcMain } from "electron";
import { z } from "zod";
import {
  IPC_CHANNELS,
  type WorkdayAdminSignInResult,
  type WorkdayAgentSaveResult,
} from "../../shared/types";
import { isMcpSignInCancelled } from "../mcp/oauth/mcp-oauth";
import {
  cancelWorkdayAdminSignIn,
  listAgentDefinitions,
  saveAgentDefinition,
  saveWorkdayAdminConnection,
  searchAgentResources,
  signInWorkdayAdmin,
  WorkdayAdminConnectionSchema,
  WorkdayAgentModelSchema,
} from "../mcp/oauth/workday-agent-setup";
import { RATE_LIMIT_CONFIGS, rateLimiter } from "../utils/rate-limiter";
import { UUIDSchema, validateInput } from "../utils/validation";
import { createSignInPageOpener, defaultRateLimit } from "./mcp-oauth-handlers";

export interface WorkdayAgentIpcDeps {
  /** Opens the tenant's sign-in page in the user's own browser (shell.openExternal). */
  openExternal: (url: string) => Promise<void>;
  checkRateLimit?: (channel: string) => void;
  /** The setup operations; tests substitute fakes. */
  service?: {
    saveConnection: typeof saveWorkdayAdminConnection;
    signIn: typeof signInWorkdayAdmin;
    cancel: typeof cancelWorkdayAdminSignIn;
    list: typeof listAgentDefinitions;
    search: typeof searchAgentResources;
    save: typeof saveAgentDefinition;
  };
}

const SearchRequestSchema = z
  .object({
    serverId: z.string().uuid(),
    query: z.string().trim().min(1).max(200),
    includeOperations: z.boolean().optional(),
  })
  .strict();

const SaveRequestSchema = z
  .object({ serverId: z.string().uuid(), agent: WorkdayAgentModelSchema })
  .strict();

type Handler = (raw: unknown) => Promise<unknown>;

/** The handlers by channel, independent of Electron (tests call them directly). */
export function createWorkdayAgentIpcHandlers(deps: WorkdayAgentIpcDeps): Record<string, Handler> {
  const limit = deps.checkRateLimit ?? defaultRateLimit;
  const service = deps.service ?? {
    saveConnection: saveWorkdayAdminConnection,
    signIn: signInWorkdayAdmin,
    cancel: cancelWorkdayAdminSignIn,
    list: listAgentDefinitions,
    search: searchAgentResources,
    save: saveAgentDefinition,
  };
  const openUrl = createSignInPageOpener(deps.openExternal);
  return {
    [IPC_CHANNELS.WORKDAY_AGENT_ADMIN_SAVE_CONNECTION]: async (raw) => {
      limit(IPC_CHANNELS.WORKDAY_AGENT_ADMIN_SAVE_CONNECTION);
      const validated = validateInput(
        WorkdayAdminConnectionSchema,
        raw,
        "Workday admin connection",
      );
      return service.saveConnection(validated);
    },
    [IPC_CHANNELS.WORKDAY_AGENT_ADMIN_SIGN_IN]: async (raw): Promise<WorkdayAdminSignInResult> => {
      limit(IPC_CHANNELS.WORKDAY_AGENT_ADMIN_SIGN_IN);
      const serverId = validateInput(UUIDSchema, raw, "server ID");
      try {
        // Only the expiry crosses IPC; the token stays in main.
        const { expiresAt } = await service.signIn(serverId, { openUrl });
        return { status: "signed_in", ...(expiresAt ? { expiresAt } : {}) };
      } catch (error) {
        if (isMcpSignInCancelled(error)) return { status: "cancelled", reason: error.reason };
        throw error;
      }
    },
    [IPC_CHANNELS.WORKDAY_AGENT_ADMIN_CANCEL]: async (raw) => {
      limit(IPC_CHANNELS.WORKDAY_AGENT_ADMIN_CANCEL);
      const serverId = validateInput(UUIDSchema, raw, "server ID");
      return { cancelled: service.cancel(serverId) };
    },
    [IPC_CHANNELS.WORKDAY_AGENT_LIST]: async (raw) => {
      limit(IPC_CHANNELS.WORKDAY_AGENT_LIST);
      const serverId = validateInput(UUIDSchema, raw, "server ID");
      return service.list(serverId);
    },
    [IPC_CHANNELS.WORKDAY_AGENT_SEARCH]: async (raw) => {
      limit(IPC_CHANNELS.WORKDAY_AGENT_SEARCH);
      const request = validateInput(SearchRequestSchema, raw, "Workday tool search");
      return service.search(request.serverId, request.query, {
        mcpOnly: !request.includeOperations,
      });
    },
    [IPC_CHANNELS.WORKDAY_AGENT_SAVE]: async (raw): Promise<WorkdayAgentSaveResult> => {
      limit(IPC_CHANNELS.WORKDAY_AGENT_SAVE);
      const request = validateInput(SaveRequestSchema, raw, "Workday agent definition");
      return service.save(request.serverId, request.agent);
    },
  };
}

export function setupWorkdayAgentHandlers(deps: WorkdayAgentIpcDeps): void {
  // Credentials and tenant-wide writes: the tightest budget.
  rateLimiter.configure(
    IPC_CHANNELS.WORKDAY_AGENT_ADMIN_SAVE_CONNECTION,
    RATE_LIMIT_CONFIGS.limited,
  );
  rateLimiter.configure(IPC_CHANNELS.WORKDAY_AGENT_SAVE, RATE_LIMIT_CONFIGS.limited);
  rateLimiter.configure(IPC_CHANNELS.WORKDAY_AGENT_ADMIN_SIGN_IN, RATE_LIMIT_CONFIGS.expensive);
  rateLimiter.configure(IPC_CHANNELS.WORKDAY_AGENT_ADMIN_CANCEL, RATE_LIMIT_CONFIGS.standard);
  rateLimiter.configure(IPC_CHANNELS.WORKDAY_AGENT_LIST, RATE_LIMIT_CONFIGS.standard);
  rateLimiter.configure(IPC_CHANNELS.WORKDAY_AGENT_SEARCH, RATE_LIMIT_CONFIGS.standard);
  for (const [channel, handle] of Object.entries(createWorkdayAgentIpcHandlers(deps))) {
    ipcMain.handle(channel, (_event, raw: unknown) => handle(raw));
  }
}
