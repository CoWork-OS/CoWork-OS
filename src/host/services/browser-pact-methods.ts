import type { ZodType } from "zod";
import type { AgentDaemon } from "../../electron/agent/daemon";
import { localOwnerPrincipal } from "../../electron/pact/daemon-host";
import { PactSurfaceError, PactSurfaceService } from "../../electron/pact/pact-surface-service";
import {
  PactAuthorizationByInputSchema,
  PactAuthorizationListSchema,
  PactAuthorizationStartSchema,
  PactConversationListSchema,
  PactDiscoverSchema,
  PactIdSchema,
  PactSendSchema,
  PactSettingsUpdateSchema,
  PactSignerCredentialSchema,
} from "../../electron/pact/pact-validation";
import type { PactPrincipal } from "../../electron/pact/types";
import { WebApplicationError } from "../web/WebApplication";
import type { BrowserDesktopDefinition, BrowserDesktopDefinitions } from "./browser-desktop-rpc";

/**
 * PACT for the browser build: the same names as the desktop `ElectronAPI` methods, backed by
 * the same surface service. A paired browser session acts as the profile owner. Unlike the
 * desktop renderer, the browser cannot ask the host to open a window on the user's machine, so
 * `getPactSignIn` returns the verified link for the owner's own tab; `openPactSignIn` is absent.
 */
export function createBrowserPactDefinitions(options: {
  agentDaemon: AgentDaemon;
}): BrowserDesktopDefinitions {
  const db = options.agentDaemon.getDatabase();
  const service = new PactSurfaceService({
    runtime: () => options.agentDaemon.getPactRuntime(),
    db,
    findWorkspace: (workspaceId) => options.agentDaemon.getWorkspaceForPact(workspaceId),
  });
  const owner = (): PactPrincipal => localOwnerPrincipal(db, "browser_session");
  const run = async (handler: () => unknown) => {
    try {
      return await handler();
    } catch (error) {
      if (error instanceof PactSurfaceError) {
        throw new WebApplicationError(
          error.code === "not_found" ? "NOT_FOUND" : "HOST_UNAVAILABLE",
          error.message,
          error.code === "not_found" ? 404 : 502,
        );
      }
      throw error;
    }
  };
  const action = <T>(
    schema: ZodType<T>,
    handler: (value: T, principal: PactPrincipal) => unknown,
    mutation: boolean,
  ): BrowserDesktopDefinition => ({
    capability: "pact.manage",
    mutation,
    minArgs: 1,
    maxArgs: 1,
    validate: (args) => [schema.parse(args[0])],
    handler: ([value]) => run(() => handler(value as T, owner())),
  });
  const noArgs = (handler: (principal: PactPrincipal) => unknown, mutation = false): BrowserDesktopDefinition => ({
    capability: "pact.manage",
    mutation,
    minArgs: 0,
    maxArgs: 0,
    handler: () => run(() => handler(owner())),
  });

  return {
    getPactStatus: noArgs((principal) => service.status(principal)),
    getPactSettings: noArgs(() => service.getSettings()),
    updatePactSettings: action(PactSettingsUpdateSchema, (value) => service.updateSettings(value), true),
    setPactSignerCredential: action(
      PactSignerCredentialSchema,
      (value) => service.setSignerCredential(value.credential),
      true,
    ),
    createPactDeviceKey: noArgs(() => service.ensureDeviceKey(), true),
    discoverPactBusiness: action(PactDiscoverSchema, (value, principal) => service.discover(principal, value), true),
    listPactBusinesses: noArgs(() => service.listBusinesses()),
    getPactConversation: action(PactIdSchema, (value, principal) => service.getConversation(principal, value.id), false),
    listPactConversations: action(
      PactConversationListSchema,
      (value, principal) => service.listConversations(principal, value),
      false,
    ),
    sendPactMessage: action(PactSendSchema, (value, principal) => service.send(principal, value), true),
    acknowledgePactEvidence: action(
      PactIdSchema,
      (value, principal) => service.acknowledgeEvidence(principal, value.id),
      true,
    ),
    startPactAuthorization: action(
      PactAuthorizationStartSchema,
      (value, principal) => service.startAuthorization(principal, value),
      true,
    ),
    getPactAuthorization: action(PactIdSchema, (value, principal) => service.getAuthorization(principal, value.id), false),
    getPactAuthorizationForInput: action(
      PactAuthorizationByInputSchema,
      (value, principal) => service.getAuthorizationByInputRequest(principal, value.inputRequestId),
      false,
    ),
    listPactAuthorizations: action(
      PactAuthorizationListSchema,
      (value, principal) => service.listAuthorizations(principal, value),
      false,
    ),
    cancelPactAuthorization: action(
      PactIdSchema,
      (value, principal) => service.cancelAuthorization(principal, value.id),
      true,
    ),
    getPactSignIn: action(
      PactIdSchema,
      async (value, principal) => {
        const signIn = await service.authorizationSignIn(principal, value.id);
        if (!signIn) throw new PactSurfaceError("not_found", "This sign-in is no longer pending.");
        return signIn;
      },
      false,
    ),
    listPactGrants: noArgs((principal) => service.listGrants(principal)),
    disconnectPactGrant: action(PactIdSchema, (value, principal) => service.disconnectGrant(principal, value.id), true),
    getPactReceipt: action(PactIdSchema, (value, principal) => service.getReceipt(principal, value.id), false),
  };
}
