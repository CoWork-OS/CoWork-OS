/**
 * `cowork pact …` in the direct runner, and the `needs_user_action` hand-off for `cowork run`.
 *
 * Local commands act as the profile owner through the same surface service as the desktop and
 * the Control Plane. A send typed here is the owner's explicit request; `--yes` confirms it.
 */
import type { AgentDaemon } from "../electron/agent/daemon";
import { localOwnerPrincipal } from "../electron/pact/daemon-host";
import { PactSurfaceService } from "../electron/pact/pact-surface-service";
import {
  PactAuthorizationStartSchema,
  PactDiscoverSchema,
  PactSendSchema,
} from "../electron/pact/pact-validation";
import { isPactAuthorizationInputRequest, type PactAuthorizationSignIn } from "../shared/pact";

/** Exit code for a run that stopped because a person must act (sign in, approve). */
export const EXIT_NEEDS_USER_ACTION = 3;

export type PactDirectAction =
  | "status"
  | "discover"
  | "send"
  | "grants"
  | "disconnect"
  | "authorizations"
  | "authorization-status"
  | "authorization-wait"
  | "authorization-cancel"
  | "authorization-start"
  | "conversation"
  | "receipt";

export interface PactDirectArgs {
  pactAction?: PactDirectAction;
  pactDomain?: string;
  pactCardUrl?: string;
  pactBusinessId?: string;
  pactMessage?: string;
  pactEffect?: string;
  pactScopes?: string[];
  pactId?: string;
  pactConversationId?: string;
  pactReconcile?: string;
  yes?: boolean;
  json?: boolean;
  workspaceId?: string;
}

export type PactWrite = (payload: Record<string, unknown>, text: string) => void;

function surface(daemon: AgentDaemon): PactSurfaceService {
  return new PactSurfaceService({
    runtime: () => daemon.getPactRuntime(),
    db: daemon.getDatabase(),
    findWorkspace: (workspaceId) => daemon.getWorkspaceForPact(workspaceId),
  });
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

export function formatSignIn(signIn: PactAuthorizationSignIn, businessName: string): string {
  const minutes = Math.max(0, Math.round((signIn.expiresAt - Date.now()) / 60_000));
  return [
    `Sign in with ${businessName} to continue: ${signIn.verificationUriComplete}`,
    `The page is ${signIn.verificationOrigin}; check that it shows the code ${signIn.userCode}.`,
    `This link expires in ${minutes} minute(s).`,
  ].join("\n");
}

/**
 * If the task is paused on a PACT sign-in, describe it (the verified link included, for the
 * owner at this terminal). Returns null for any other kind of pause.
 */
export async function describePactSignInPause(
  daemon: AgentDaemon,
  taskId: string,
): Promise<{ authorizationId: string; text: string; payload: Record<string, unknown> } | null> {
  const pending = await daemon.getPendingInputRequests?.(taskId);
  const request = (pending ?? []).find((entry) => isPactAuthorizationInputRequest(entry));
  if (!request) return null;
  const principal = localOwnerPrincipal(daemon.getDatabase(), "cli");
  const runtime = daemon.getPactRuntime();
  const view = await runtime.getAuthorizationByInputRequest(principal, request.id);
  if (!view) return null;
  const signIn = await runtime.getAuthorizationSignIn(principal, view.id);
  if (!signIn) return null;
  return {
    authorizationId: view.id,
    text: `${formatSignIn(signIn, view.businessName)}\nResume later with: cowork pact authorization wait ${view.id}`,
    payload: {
      type: "needs_user_action",
      reason: "pact_authorization",
      taskId,
      authorizationId: view.id,
      business: view.businessName,
      scopes: view.requestedScopes,
      verificationUriComplete: signIn.verificationUriComplete,
      verificationOrigin: signIn.verificationOrigin,
      userCode: signIn.userCode,
      expiresAt: signIn.expiresAt,
    },
  };
}

export async function runPactDirectCommand(
  daemon: AgentDaemon,
  args: PactDirectArgs,
  write: PactWrite,
): Promise<number> {
  const service = surface(daemon);
  const principal = localOwnerPrincipal(daemon.getDatabase(), "cli");
  const show = (payload: unknown, text: string) =>
    write({ type: "pact", action: args.pactAction, result: payload as Record<string, unknown> }, text);

  switch (args.pactAction) {
    case "status": {
      const status = await service.status(principal);
      show(
        status,
        [
          `PACT: ${status.available ? "available" : `unavailable (${status.unavailableReason})`}`,
          `Preference: ${status.preference}`,
          `Identity: ${status.identity.deployment} ${status.identity.ready ? "ready" : `not ready${status.identity.reason ? ` (${status.identity.reason})` : ""}`}`,
          ...status.providers.map((provider) => `Provider ${provider.origin}: ${provider.ready ? "ready" : provider.reason ?? "not ready"}`),
          `Connected permissions: ${status.activeGrants}; pending sign-ins: ${status.pendingAuthorizations}`,
        ].join("\n"),
      );
      return 0;
    }
    case "discover": {
      const input = PactDiscoverSchema.parse({
        ...(args.pactDomain ? { domain: args.pactDomain } : {}),
        ...(args.pactCardUrl ? { cardUrl: args.pactCardUrl } : {}),
        ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
      });
      const { business, route } = await service.discover(principal, input);
      show(
        { business, route },
        [
          `${business.displayName} (${business.id})`,
          `Reached via: ${business.originChain.map((url) => new URL(url).origin).join(" -> ")}`,
          `Provider: ${business.providerOrigin}; ${business.supported ? business.profile : `unsupported: ${business.unsupportedReason}`}`,
          ...business.scopes.map((scope) => `  ${scope.id}: ${scope.description}`),
          `Route: ${route.route}${"message" in route ? ` (${route.message})` : ""}`,
        ].join("\n"),
      );
      return 0;
    }
    case "send": {
      const input = PactSendSchema.parse({
        businessId: requireValue(args.pactBusinessId, "--business"),
        text: args.pactMessage ?? "",
        effect: args.pactEffect ?? "inspect",
        requiredScopes: args.pactScopes ?? [],
        confirmed: args.yes === true,
        ...(args.pactConversationId ? { conversationId: args.pactConversationId } : {}),
        ...(args.pactReconcile ? { reconcileOperationId: args.pactReconcile } : {}),
        ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
      });
      const outcome = await service.send(principal, input);
      if (outcome.status === "replied") {
        show(outcome, `${outcome.replyText}\n[evidence: ${outcome.evidence}; conversation ${outcome.conversationId}]`);
        return 0;
      }
      if (outcome.status === "needs_user_action") {
        const signIn = await service.authorizationSignIn(principal, outcome.authorizationId);
        show(
          { ...outcome, ...(signIn ? { signIn } : {}) },
          `${signIn ? formatSignIn(signIn, "the business") : outcome.message}\nThen run: cowork pact authorization wait ${outcome.authorizationId}`,
        );
        return EXIT_NEEDS_USER_ACTION;
      }
      show(outcome, `${outcome.status}: ${outcome.message}${outcome.reason === "local_approval_required" ? " (re-run with --yes to confirm)" : ""}`);
      return outcome.reason === "local_approval_required" ? EXIT_NEEDS_USER_ACTION : 1;
    }
    case "grants": {
      const grants = await service.listGrants(principal);
      show(
        grants,
        grants.length
          ? grants
              .map((grant) => `${grant.id}  ${grant.businessName}  ${grant.state}  ${grant.scopes.map((scope) => scope.id).join(" ")}`)
              .join("\n")
          : "No business permissions.",
      );
      return 0;
    }
    case "disconnect": {
      const result = await service.disconnectGrant(principal, requireValue(args.pactId, "<grantId>"));
      show(result, `Disconnected ${result.grant.businessName} locally. The business was not notified (PACT 1.0 has no revocation).`);
      return 0;
    }
    case "authorizations": {
      const list = await service.listAuthorizations(principal, { pendingOnly: false });
      show(
        list,
        list.length
          ? list.map((entry) => `${entry.id}  ${entry.businessName}  ${entry.state}  expires ${new Date(entry.expiresAt).toISOString()}`).join("\n")
          : "No sign-in requests.",
      );
      return 0;
    }
    case "authorization-start": {
      const input = PactAuthorizationStartSchema.parse({
        businessId: requireValue(args.pactBusinessId, "--business"),
        scopes: args.pactScopes ?? [],
        ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
      });
      const view = await service.startAuthorization(principal, input);
      const signIn = await service.authorizationSignIn(principal, view.id);
      show({ authorization: view, ...(signIn ? { signIn } : {}) }, signIn ? formatSignIn(signIn, view.businessName) : `Started ${view.id}`);
      const settled = await service.awaitAuthorization(principal, view.id);
      show(settled ?? view, `Sign-in ${settled?.state ?? "pending"}.`);
      return settled?.state === "granted" ? 0 : 1;
    }
    case "authorization-status":
    case "authorization-wait": {
      const id = requireValue(args.pactId, "<authorizationId>");
      let view = await service.getAuthorization(principal, id);
      if (args.pactAction === "authorization-wait" && view.state === "pending") {
        const signIn = await service.authorizationSignIn(principal, id);
        if (signIn) write({ type: "needs_user_action", authorizationId: id, signIn }, formatSignIn(signIn, view.businessName));
        // Resume polling in this process; a granted wait resumes its task here.
        view = (await daemon.getPactRuntime().resumeAuthorization(principal, id)) ?? view;
      }
      show(view, `${view.businessName}: ${view.state}${view.stateReason ? ` (${view.stateReason})` : ""}`);
      if (view.state === "pending") return EXIT_NEEDS_USER_ACTION;
      return view.state === "granted" ? 0 : 1;
    }
    case "authorization-cancel": {
      const view = await service.cancelAuthorization(principal, requireValue(args.pactId, "<authorizationId>"));
      show(view, `${view.businessName}: ${view.state}`);
      return 0;
    }
    case "conversation": {
      const view = await service.getConversation(principal, requireValue(args.pactId, "<conversationId>"));
      show(
        view,
        [
          `${view.businessName}: ${view.state}${view.stateReason ? ` (${view.stateReason})` : ""}`,
          ...view.turns.map((turn) => `> ${turn.text}\n< ${turn.replyText ?? `[${turn.state}]`}  [evidence: ${turn.evidence}; operation ${turn.operationId}]`),
        ].join("\n"),
      );
      return 0;
    }
    case "receipt": {
      const receipt = await service.getReceipt(principal, requireValue(args.pactId, "<receiptId>"));
      show(
        receipt,
        `Receipt ${receipt.id}: ${receipt.verification}${receipt.verificationReason ? ` (${receipt.verificationReason})` : ""}\nActions: ${receipt.actions.map((action) => action.tool).join(", ") || "none"}\nScopes used: ${receipt.scopesUsed.join(", ") || "none"}`,
      );
      return 0;
    }
    default:
      throw new Error(
        "Usage: cowork pact status|discover|send|grants|disconnect|authorizations|authorization|conversation|receipt",
      );
  }
}
