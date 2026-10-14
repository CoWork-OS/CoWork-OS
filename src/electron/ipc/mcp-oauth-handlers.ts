/**
 * IPC for remote MCP servers that sign in with OAuth 2.1 (docs/remote-mcp-oauth.md): add,
 * edit, discover, sign in and cancel a pending sign-in. Payloads are validated with zod in
 * main; the renderer never receives stored secrets and cannot choose which page opens.
 */
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/types";
import { isMcpSignInCancelled } from "../mcp/oauth/mcp-oauth";
import {
  addRemoteOAuthServer,
  authorizeMcpServer,
  cancelMcpServerSignIn,
  discoverRemoteOAuth,
  RemoteOAuthServerUpdateSchema,
  updateRemoteOAuthServer,
} from "../mcp/oauth/mcp-server-authorization";
import { RATE_LIMIT_CONFIGS, rateLimiter } from "../utils/rate-limiter";
import { UUIDSchema, validateInput } from "../utils/validation";

export interface McpOAuthIpcDeps {
  /** Opens the provider's sign-in page in the user's own browser (shell.openExternal). */
  openExternal: (url: string) => Promise<void>;
  checkRateLimit?: (channel: string) => void;
  /** The server operations; tests substitute fakes. */
  service?: {
    add: typeof addRemoteOAuthServer;
    update: typeof updateRemoteOAuthServer;
    discover: typeof discoverRemoteOAuth;
    authorize: typeof authorizeMcpServer;
    cancel: typeof cancelMcpServerSignIn;
  };
}

/** What a sign-in returns to the renderer. A cancelled or replaced sign-in is not an error. */
export type McpOAuthAuthorizeResult =
  | { status: "signed_in"; expiresAt?: number; grant: "authorization_code" | "jwt_bearer" }
  | { status: "cancelled"; reason: "cancelled" | "superseded" };

type Handler = (raw: unknown) => Promise<unknown>;

function defaultRateLimit(channel: string): void {
  if (!rateLimiter.check(channel)) {
    const resetSec = Math.ceil(rateLimiter.getResetTime(channel) / 1000);
    throw new Error(`Rate limit exceeded. Try again in ${resetSec} seconds.`);
  }
}

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

/** The handlers by channel, independent of Electron (tests call them directly). */
export function createMcpOAuthIpcHandlers(deps: McpOAuthIpcDeps): Record<string, Handler> {
  const limit = deps.checkRateLimit ?? defaultRateLimit;
  const service = deps.service ?? {
    add: addRemoteOAuthServer,
    update: updateRemoteOAuthServer,
    discover: discoverRemoteOAuth,
    authorize: authorizeMcpServer,
    cancel: cancelMcpServerSignIn,
  };
  const openUrl = async (url: string) => {
    const page = new URL(url);
    const loopback = LOOPBACK_HOSTS.includes(page.hostname);
    if (page.protocol !== "https:" && !(page.protocol === "http:" && loopback))
      throw new Error("Sign-in page must use https");
    await deps.openExternal(url);
  };
  return {
    // Adding shares the generic add-server budget.
    [IPC_CHANNELS.MCP_ADD_REMOTE_OAUTH_SERVER]: async (raw) => {
      limit(IPC_CHANNELS.MCP_ADD_SERVER);
      return service.add(raw);
    },
    [IPC_CHANNELS.MCP_UPDATE_REMOTE_OAUTH_SERVER]: async (raw) => {
      limit(IPC_CHANNELS.MCP_UPDATE_REMOTE_OAUTH_SERVER);
      const validated = validateInput(RemoteOAuthServerUpdateSchema, raw, "remote OAuth server");
      const { server, signedOut } = await service.update(validated);
      return { id: server.id, name: server.name, signedOut };
    },
    [IPC_CHANNELS.MCP_OAUTH_DISCOVER]: async (raw) => {
      limit(IPC_CHANNELS.MCP_OAUTH_DISCOVER);
      return service.discover(raw);
    },
    [IPC_CHANNELS.MCP_OAUTH_AUTHORIZE]: async (raw): Promise<McpOAuthAuthorizeResult> => {
      limit(IPC_CHANNELS.MCP_OAUTH_AUTHORIZE);
      const serverId = validateInput(UUIDSchema, raw, "server ID");
      try {
        const result = await service.authorize(serverId, { openUrl });
        return { status: "signed_in", ...result };
      } catch (error) {
        if (isMcpSignInCancelled(error)) return { status: "cancelled", reason: error.reason };
        throw error;
      }
    },
    [IPC_CHANNELS.MCP_OAUTH_CANCEL]: async (raw) => {
      limit(IPC_CHANNELS.MCP_OAUTH_CANCEL);
      const serverId = validateInput(UUIDSchema, raw, "server ID");
      return { cancelled: service.cancel(serverId) };
    },
  };
}

export function setupMcpOAuthHandlers(deps: McpOAuthIpcDeps): void {
  rateLimiter.configure(IPC_CHANNELS.MCP_OAUTH_AUTHORIZE, RATE_LIMIT_CONFIGS.expensive);
  rateLimiter.configure(IPC_CHANNELS.MCP_OAUTH_DISCOVER, RATE_LIMIT_CONFIGS.expensive);
  // Edits store credentials, like settings saves.
  rateLimiter.configure(IPC_CHANNELS.MCP_UPDATE_REMOTE_OAUTH_SERVER, RATE_LIMIT_CONFIGS.limited);
  rateLimiter.configure(IPC_CHANNELS.MCP_OAUTH_CANCEL, RATE_LIMIT_CONFIGS.standard);
  for (const [channel, handle] of Object.entries(createMcpOAuthIpcHandlers(deps))) {
    ipcMain.handle(channel, (_event, raw: unknown) => handle(raw));
  }
}
