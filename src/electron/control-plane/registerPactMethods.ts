import type { ZodType } from "zod";
import { PactSurfaceError, PactSurfaceService } from "../pact/pact-surface-service";
import {
  PactAuthorizationListSchema,
  PactAuthorizationStartSchema,
  PactConversationListSchema,
  PactDiscoverSchema,
  PactIdSchema,
  PactNoArgsSchema,
  PactSendSchema,
  PactSettingsUpdateSchema,
  PactSignerCredentialSchema,
} from "../pact/pact-validation";
import type { PactPrincipal } from "../pact/types";
import type { AgentDaemon } from "../agent/daemon";
import type { ControlPlaneServer } from "./server";
import { ErrorCodes, Methods } from "./protocol";

type Scope = "admin" | "read" | "write" | "operator";
type RequireScope = (client: unknown, scope: Scope) => void;

/**
 * PACT methods for both Control Plane entry points (desktop handlers and the Node daemon).
 *
 * Scopes (plan §7): `read` sees status, businesses, conversations and receipts without secrets;
 * `write` discovers; `operator` (or `admin`) sends, clears evidence reviews and runs grant
 * operations, including reading a pending sign-in link; configuration changes need `admin`. An opaque conversation id is not authority:
 * every call is checked against the principal. Remote callers act as the local owner (the shared
 * token is the owner's), recorded as the actor.
 *
 * Calls outside a task use the default access profile's network rules. Only an admin client may
 * name a workspace to use that workspace's rules instead. Today a workspace's rules can only be
 * the same or stricter (its network switch); the check keeps workspace choice from becoming a way
 * to loosen rules if workspaces ever carry their own profiles.
 */
export function registerPactMethods(input: {
  server: ControlPlaneServer;
  agentDaemon: AgentDaemon;
  requireScope: RequireScope;
}): void {
  const service = new PactSurfaceService({
    runtime: () => input.agentDaemon.getPactRuntime(),
    findWorkspace: (workspaceId) => input.agentDaemon.getWorkspaceForPact(workspaceId),
  });
  const isAdmin = (client: unknown) =>
    Boolean((client as { hasScope?: (scope: string) => boolean })?.hasScope?.("admin"));
  const checkWorkspaceChoice = (client: unknown, params: { workspaceId?: string }) => {
    if (params.workspaceId && !isAdmin(client)) {
      throw {
        code: ErrorCodes.INVALID_PARAMS,
        message:
          "Only an admin client can choose a workspace's network rules; omit workspaceId to use the default access profile.",
      };
    }
  };
  const principalFor = async (client: unknown): Promise<PactPrincipal> => {
    const id = (client as { id?: unknown })?.id;
    const owner = await input.agentDaemon
      .getPactRuntime()
      .ownerPrincipal(
        `control_plane:${typeof id === "string" || typeof id === "number" ? id : "unknown"}`,
      );
    return { ...owner, kind: "control_plane_client" };
  };

  const register = <T>(
    method: string,
    scope: Scope,
    schema: ZodType<T>,
    run: (params: T, principal: PactPrincipal, client: unknown) => unknown,
  ) => {
    input.server.registerMethod(method, async (client, params) => {
      input.requireScope(client, scope);
      const parsed = schema.safeParse(params ?? undefined);
      if (!parsed.success) {
        throw {
          code: ErrorCodes.INVALID_PARAMS,
          message: `Invalid ${method} request: ${parsed.error.issues[0]?.message ?? "bad input"}`,
        };
      }
      try {
        return await run(parsed.data, await principalFor(client), client);
      } catch (error) {
        if (error instanceof PactSurfaceError) {
          throw {
            code: error.code === "not_found" ? ErrorCodes.INVALID_PARAMS : ErrorCodes.METHOD_FAILED,
            message: error.message,
          };
        }
        throw error;
      }
    });
  };

  register(Methods.PACT_STATUS, "read", PactNoArgsSchema, (_params, principal) =>
    service.status(principal),
  );
  register(Methods.PACT_SETTINGS_GET, "read", PactNoArgsSchema, () => service.getSettings());
  register(Methods.PACT_SETTINGS_UPDATE, "admin", PactSettingsUpdateSchema, (params) =>
    service.updateSettings(params),
  );
  register(Methods.PACT_IDENTITY_SET_CREDENTIAL, "admin", PactSignerCredentialSchema, (params) =>
    service.setSignerCredential(params.credential),
  );
  register(Methods.PACT_IDENTITY_DEVICE_KEY, "admin", PactNoArgsSchema, () =>
    service.ensureDeviceKey(),
  );
  register(
    Methods.PACT_BUSINESS_DISCOVER,
    "write",
    PactDiscoverSchema,
    (params, principal, client) => {
      checkWorkspaceChoice(client, params);
      return service.discover(principal, params);
    },
  );
  register(Methods.PACT_BUSINESS_LIST, "read", PactNoArgsSchema, () => service.listBusinesses());
  register(Methods.PACT_CONVERSATION_GET, "read", PactIdSchema, (params, principal) =>
    service.getConversation(principal, params.id),
  );
  register(
    Methods.PACT_CONVERSATION_LIST,
    "read",
    PactConversationListSchema,
    (params, principal) => service.listConversations(principal, params),
  );
  // Sends act with the owner's business permissions: operator scope, and a client-supplied
  // confirmation counts only from an admin client (the owner's own token).
  input.server.registerMethod(Methods.PACT_CONVERSATION_SEND, async (client, params) => {
    input.requireScope(client, "operator");
    const parsed = PactSendSchema.safeParse(params ?? undefined);
    if (!parsed.success) {
      throw {
        code: ErrorCodes.INVALID_PARAMS,
        message: `Invalid ${Methods.PACT_CONVERSATION_SEND} request: ${parsed.error.issues[0]?.message ?? "bad input"}`,
      };
    }
    try {
      checkWorkspaceChoice(client, parsed.data);
      return await service.send(await principalFor(client), {
        ...parsed.data,
        confirmed: parsed.data.confirmed && isAdmin(client),
      });
    } catch (error) {
      if (error instanceof PactSurfaceError) {
        throw { code: ErrorCodes.METHOD_FAILED, message: error.message };
      }
      throw error;
    }
  });
  register(
    Methods.PACT_CONVERSATION_ACKNOWLEDGE_EVIDENCE,
    "operator",
    PactIdSchema,
    (params, principal) => service.acknowledgeEvidence(principal, params.id),
  );
  register(
    Methods.PACT_AUTHORIZATION_START,
    "operator",
    PactAuthorizationStartSchema,
    (params, principal, client) => {
      checkWorkspaceChoice(client, params);
      return service.startAuthorization(principal, params);
    },
  );
  register(Methods.PACT_AUTHORIZATION_GET, "read", PactIdSchema, (params, principal) =>
    service.getAuthorization(principal, params.id),
  );
  register(
    Methods.PACT_AUTHORIZATION_LIST,
    "read",
    PactAuthorizationListSchema,
    (params, principal) => service.listAuthorizations(principal, params),
  );
  register(Methods.PACT_AUTHORIZATION_CANCEL, "operator", PactIdSchema, (params, principal) =>
    service.cancelAuthorization(principal, params.id),
  );
  register(Methods.PACT_GRANT_LIST, "read", PactNoArgsSchema, (_params, principal) =>
    service.listGrants(principal),
  );
  register(Methods.PACT_GRANT_DISCONNECT, "operator", PactIdSchema, (params, principal) =>
    service.disconnectGrant(principal, params.id),
  );
  register(Methods.PACT_RECEIPT_GET, "read", PactIdSchema, (params, principal) =>
    service.getReceipt(principal, params.id),
  );
  // The sign-in link is a grant operation: operator or admin only, and never logged.
  register(
    Methods.PACT_AUTHORIZATION_SIGN_IN,
    "operator",
    PactIdSchema,
    async (params, principal) => {
      const signIn = await service.authorizationSignIn(principal, params.id);
      if (!signIn) throw new PactSurfaceError("not_found", "No pending sign-in");
      return signIn;
    },
  );
}
