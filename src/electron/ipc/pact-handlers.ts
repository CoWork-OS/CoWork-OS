/**
 * PACT IPC (pact:*, docs/pact.md): status and settings, discovery, conversations, consent,
 * grants and receipts for the desktop renderer. Every payload is validated with zod in main
 * (pact-validation.ts) and the caller is the local owner. The renderer never receives a sign-in
 * link: "Open sign-in" asks main to open the business's own login in the system browser.
 */
import { ipcMain } from "electron";
import type { ZodType } from "zod";
import { IPC_CHANNELS } from "../../shared/types";
import type { PactSurfaceService } from "../pact/pact-surface-service";
import {
  PactAuthorizationByInputSchema,
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
import { RATE_LIMIT_CONFIGS, rateLimiter } from "../utils/rate-limiter";
import { validateInput } from "../utils/validation";

export interface PactIpcDeps {
  service: () => PactSurfaceService;
  /** The owner principal (the desktop user), resolved by the PACT runtime. */
  owner: () => Promise<PactPrincipal>;
  /** Opens an https URL in the user's own browser (shell.openExternal in main). */
  openExternal: (url: string) => Promise<void>;
  /**
   * A native confirmation owned by main for a send that needs local approval. The renderer can
   * never answer it; without it such sends are refused.
   */
  confirmSend?: (request: {
    businessName: string;
    effect: string;
    text: string;
    scopes: string[];
  }) => Promise<boolean>;
  /** Development deployments may open loopback sign-in pages of a local reference stack. */
  developmentAllowed?: () => boolean;
  checkRateLimit?: (channel: string) => void;
}

type Handler = (raw: unknown) => Promise<unknown>;

function defaultRateLimit(channel: string): void {
  if (!rateLimiter.check(channel)) {
    const resetSec = Math.ceil(rateLimiter.getResetTime(channel) / 1000);
    throw new Error(`Rate limit exceeded. Try again in ${resetSec} seconds.`);
  }
}

/** The handlers by channel, independent of Electron (tests call them directly). */
export function createPactIpcHandlers(deps: PactIpcDeps): Record<string, Handler> {
  const limit = deps.checkRateLimit ?? defaultRateLimit;
  const handler =
    <T>(
      channel: string,
      schema: ZodType<T>,
      run: (value: T, principal: PactPrincipal) => unknown,
    ): Handler =>
    async (raw) => {
      limit(channel);
      const value = validateInput(schema, raw, "PACT request");
      return run(value, await deps.owner());
    };
  const svc = () => deps.service();
  return {
    [IPC_CHANNELS.PACT_STATUS]: handler(IPC_CHANNELS.PACT_STATUS, PactNoArgsSchema, (_v, p) =>
      svc().status(p),
    ),
    [IPC_CHANNELS.PACT_SETTINGS_GET]: handler(
      IPC_CHANNELS.PACT_SETTINGS_GET,
      PactNoArgsSchema,
      () => svc().getSettings(),
    ),
    [IPC_CHANNELS.PACT_SETTINGS_UPDATE]: handler(
      IPC_CHANNELS.PACT_SETTINGS_UPDATE,
      PactSettingsUpdateSchema,
      (v) => svc().updateSettings(v),
    ),
    [IPC_CHANNELS.PACT_IDENTITY_SET_CREDENTIAL]: handler(
      IPC_CHANNELS.PACT_IDENTITY_SET_CREDENTIAL,
      PactSignerCredentialSchema,
      (v) => svc().setSignerCredential(v.credential),
    ),
    [IPC_CHANNELS.PACT_IDENTITY_DEVICE_KEY]: handler(
      IPC_CHANNELS.PACT_IDENTITY_DEVICE_KEY,
      PactNoArgsSchema,
      () => svc().ensureDeviceKey(),
    ),
    [IPC_CHANNELS.PACT_BUSINESS_DISCOVER]: handler(
      IPC_CHANNELS.PACT_BUSINESS_DISCOVER,
      PactDiscoverSchema,
      (v, p) => svc().discover(p, v),
    ),
    [IPC_CHANNELS.PACT_BUSINESS_LIST]: handler(
      IPC_CHANNELS.PACT_BUSINESS_LIST,
      PactNoArgsSchema,
      () => svc().listBusinesses(),
    ),
    [IPC_CHANNELS.PACT_CONVERSATION_GET]: handler(
      IPC_CHANNELS.PACT_CONVERSATION_GET,
      PactIdSchema,
      (v, p) => svc().getConversation(p, v.id),
    ),
    [IPC_CHANNELS.PACT_CONVERSATION_LIST]: handler(
      IPC_CHANNELS.PACT_CONVERSATION_LIST,
      PactConversationListSchema,
      (v, p) => svc().listConversations(p, v),
    ),
    [IPC_CHANNELS.PACT_CONVERSATION_SEND]: handler(
      IPC_CHANNELS.PACT_CONVERSATION_SEND,
      PactSendSchema,
      // The renderer is a web context: it can never pre-confirm a change. Anything that needs
      // local approval comes back as local_approval_required.
      async (v, p) => {
        // A send that needs local approval is confirmed in a native dialog owned by main,
        // showing the full text; the renderer's own `confirmed` is ignored.
        const first = await svc().send(p, { ...v, confirmed: false });
        if (first.status !== "blocked" || first.reason !== "local_approval_required") return first;
        if (!deps.confirmSend) return first;
        const business = (await svc().listBusinesses()).find((entry) => entry.id === v.businessId);
        const confirmed = await deps.confirmSend({
          businessName: business?.displayName ?? "this business",
          effect: v.effect,
          text: v.text,
          scopes: v.requiredScopes,
        });
        if (!confirmed) {
          return {
            status: "denied" as const,
            conversationId: first.conversationId,
            reason: "local_approval_denied",
            message: "The request was not approved.",
          };
        }
        return svc().send(p, { ...v, confirmed: true });
      },
    ),
    [IPC_CHANNELS.PACT_CONVERSATION_ACKNOWLEDGE_EVIDENCE]: handler(
      IPC_CHANNELS.PACT_CONVERSATION_ACKNOWLEDGE_EVIDENCE,
      PactIdSchema,
      (v, p) => svc().acknowledgeEvidence(p, v.id),
    ),
    [IPC_CHANNELS.PACT_AUTHORIZATION_START]: handler(
      IPC_CHANNELS.PACT_AUTHORIZATION_START,
      PactAuthorizationStartSchema,
      (v, p) => svc().startAuthorization(p, v),
    ),
    [IPC_CHANNELS.PACT_AUTHORIZATION_GET]: handler(
      IPC_CHANNELS.PACT_AUTHORIZATION_GET,
      PactIdSchema,
      (v, p) => svc().getAuthorization(p, v.id),
    ),
    [IPC_CHANNELS.PACT_AUTHORIZATION_FOR_INPUT]: handler(
      IPC_CHANNELS.PACT_AUTHORIZATION_FOR_INPUT,
      PactAuthorizationByInputSchema,
      (v, p) => svc().getAuthorizationByInputRequest(p, v.inputRequestId),
    ),
    [IPC_CHANNELS.PACT_AUTHORIZATION_LIST]: handler(
      IPC_CHANNELS.PACT_AUTHORIZATION_LIST,
      PactAuthorizationListSchema,
      (v, p) => svc().listAuthorizations(p, v),
    ),
    [IPC_CHANNELS.PACT_AUTHORIZATION_CANCEL]: handler(
      IPC_CHANNELS.PACT_AUTHORIZATION_CANCEL,
      PactIdSchema,
      (v, p) => svc().cancelAuthorization(p, v.id),
    ),
    [IPC_CHANNELS.PACT_AUTHORIZATION_OPEN_SIGN_IN]: handler(
      IPC_CHANNELS.PACT_AUTHORIZATION_OPEN_SIGN_IN,
      PactIdSchema,
      async (v, p) => {
        const signIn = await svc().authorizationSignIn(p, v.id);
        if (!signIn) throw new Error("This sign-in is no longer pending.");
        const url = new URL(signIn.verificationUriComplete);
        const localDevelopment =
          deps.developmentAllowed?.() === true &&
          url.protocol === "http:" &&
          (url.hostname === "127.0.0.1" || url.hostname === "localhost");
        if (url.protocol !== "https:" && !localDevelopment) {
          throw new Error("CoWork only opens HTTPS sign-in pages.");
        }
        // The user's own browser: CoWork never frames, proxies or observes the login.
        await deps.openExternal(url.toString());
        return {
          opened: true,
          verificationOrigin: signIn.verificationOrigin,
          userCode: signIn.userCode,
        };
      },
    ),
    [IPC_CHANNELS.PACT_GRANT_LIST]: handler(
      IPC_CHANNELS.PACT_GRANT_LIST,
      PactNoArgsSchema,
      (_v, p) => svc().listGrants(p),
    ),
    [IPC_CHANNELS.PACT_GRANT_DISCONNECT]: handler(
      IPC_CHANNELS.PACT_GRANT_DISCONNECT,
      PactIdSchema,
      (v, p) => svc().disconnectGrant(p, v.id),
    ),
    [IPC_CHANNELS.PACT_RECEIPT_GET]: handler(IPC_CHANNELS.PACT_RECEIPT_GET, PactIdSchema, (v, p) =>
      svc().getReceipt(p, v.id),
    ),
  };
}

export function setupPactHandlers(deps: PactIpcDeps): void {
  for (const channel of [
    IPC_CHANNELS.PACT_STATUS,
    IPC_CHANNELS.PACT_SETTINGS_GET,
    IPC_CHANNELS.PACT_BUSINESS_LIST,
    IPC_CHANNELS.PACT_CONVERSATION_GET,
    IPC_CHANNELS.PACT_CONVERSATION_LIST,
    IPC_CHANNELS.PACT_AUTHORIZATION_GET,
    IPC_CHANNELS.PACT_AUTHORIZATION_FOR_INPUT,
    IPC_CHANNELS.PACT_AUTHORIZATION_LIST,
    IPC_CHANNELS.PACT_GRANT_LIST,
    IPC_CHANNELS.PACT_RECEIPT_GET,
  ]) {
    rateLimiter.configure(channel, RATE_LIMIT_CONFIGS.frequent);
  }
  // Each of these reaches a business or changes stored permissions; one button is the caller.
  for (const channel of [
    IPC_CHANNELS.PACT_SETTINGS_UPDATE,
    IPC_CHANNELS.PACT_IDENTITY_SET_CREDENTIAL,
    IPC_CHANNELS.PACT_IDENTITY_DEVICE_KEY,
    IPC_CHANNELS.PACT_BUSINESS_DISCOVER,
    IPC_CHANNELS.PACT_CONVERSATION_SEND,
    IPC_CHANNELS.PACT_CONVERSATION_ACKNOWLEDGE_EVIDENCE,
    IPC_CHANNELS.PACT_AUTHORIZATION_START,
    IPC_CHANNELS.PACT_AUTHORIZATION_CANCEL,
    IPC_CHANNELS.PACT_AUTHORIZATION_OPEN_SIGN_IN,
    IPC_CHANNELS.PACT_GRANT_DISCONNECT,
  ]) {
    rateLimiter.configure(channel, RATE_LIMIT_CONFIGS.standard);
  }
  const handlers = createPactIpcHandlers(deps);
  for (const [channel, handle] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_event, raw: unknown) => handle(raw));
  }
}
