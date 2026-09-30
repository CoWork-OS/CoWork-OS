import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  OpenAIOAuth,
  recommendChatGPTModelForPlan,
  type OpenAIOAuthTokens,
} from "../../electron/agent/llm/openai-oauth";
import { LLMProviderFactory } from "../../electron/agent/llm";
import type { BrowserProviderSignIn } from "../../shared/host-api/provider-sign-in";
import type { BrowserDesktopDefinitions } from "./browser-desktop-rpc";
import { WebApplicationError } from "../web/WebApplication";

type Authenticator = Pick<OpenAIOAuth, "authenticate">;
type Flow = {
  owner: string;
  display: BrowserProviderSignIn;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  running: boolean;
};

export function createBrowserProviderSignIn(options?: {
  authenticator?: Authenticator;
  persist?: (tokens: OpenAIOAuthTokens) => void;
  ttlMs?: number;
}) {
  const flows = new Map<string, Flow>();
  const auth = options?.authenticator ?? new OpenAIOAuth();
  const ttlMs = options?.ttlMs ?? 15 * 60_000;
  const persist =
    options?.persist ??
    ((tokens: OpenAIOAuthTokens) => {
      const settings = LLMProviderFactory.loadSettings();
      LLMProviderFactory.saveSettings({
        ...settings,
        openai: {
          ...settings.openai,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          tokenExpiresAt: tokens.expires_at,
          accountId: tokens.accountId,
          email: tokens.email,
          authMethod: "oauth",
          chatgptPlanType: tokens.planType,
          apiKey: undefined,
        },
        cachedOpenAIModels: undefined,
      });
    });
  const cancel = (flow: Flow) => {
    if (flow.display.state !== "pending") return;
    flow.display = { ...flow.display, state: "cancelled", authorizationUrl: undefined };
    flow.reject(new Error("Sign-in cancelled."));
  };
  const find = (id: string, owner: string) => {
    const flow = flows.get(id);
    if (!flow || flow.owner !== owner)
      throw new WebApplicationError("NOT_FOUND", "Sign-in is unavailable. Start again.", 404);
    if (Date.now() >= flow.display.expiresAt) {
      cancel(flow);
      throw new WebApplicationError("STALE_STATE", "Sign-in expired. Start again.", 409);
    }
    return flow;
  };
  const copy = (flow: Flow) => ({ ...flow.display });
  const idSchema = z.string().uuid();
  const definitions: BrowserDesktopDefinitions = {
    beginOpenAIBrowserSignIn: {
      capability: "providers.configure",
      mutation: true,
      minArgs: 0,
      maxArgs: 0,
      handler: async (_args, context) => {
        if ([...flows.values()].some((flow) => flow.running))
          throw new WebApplicationError(
            "CONFLICT",
            "A host account sign-in is already in progress.",
            409,
          );
        // Retain one bounded, session-owned outcome until expiry for refresh/poll recovery.
        for (const flow of flows.values()) clearTimeout(flow.timer);
        flows.clear();
        const flowId = randomUUID();
        let resolve!: Flow["resolve"], reject!: Flow["reject"];
        const manual = new Promise<string>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        // Prevent an early cancellation from leaving an unobserved rejection.
        void manual.catch(() => undefined);
        let ready!: () => void;
        const waitingForUrl = new Promise<void>((yes) => {
          ready = yes;
        });
        const flow: Flow = {
          owner: context.sessionId,
          display: { flowId, state: "pending", expiresAt: Date.now() + ttlMs },
          resolve,
          reject,
          running: true,
          timer: setTimeout(() => {
            cancel(flow);
            if (!flow.running) flows.delete(flowId);
          }, ttlMs),
        };
        flow.timer.unref();
        flows.set(flowId, flow);
        void Promise.resolve()
          .then(() =>
            auth.authenticate({
              onAuth: ({ url }) => {
                if (flow.display.state !== "pending") throw new Error("Sign-in no longer active.");
                const parsed = new URL(url);
                if (
                  parsed.origin !== "https://auth.openai.com" ||
                  !parsed.searchParams.get("state")
                )
                  throw new Error("Unexpected account sign-in URL.");
                flow.display.authorizationUrl = url;
                ready();
              },
              onManualCodeInput: () => manual,
            }),
          )
          .then((tokens) => {
            if (flow.display.state !== "pending" || Date.now() >= flow.display.expiresAt) return;
            persist(tokens);
            flow.display = {
              ...flow.display,
              state: "completed",
              authorizationUrl: undefined,
              recommendedModel: recommendChatGPTModelForPlan(tokens.planType),
            };
          })
          .catch(() => {
            if (flow.display.state === "pending")
              flow.display = {
                ...flow.display,
                state: "failed",
                authorizationUrl: undefined,
                error: "Account sign-in could not be completed. Start again.",
              };
          })
          .finally(() => {
            flow.running = false;
            ready();
          });
        // onAuth normally arrives immediately; never hold an HTTP request for the full login.
        await Promise.race([
          waitingForUrl,
          new Promise<void>((yes) => {
            const timer = setTimeout(yes, 1500);
            timer.unref();
          }),
        ]);
        return copy(flow);
      },
    },
    getOpenAIBrowserSignIn: {
      capability: "providers.configure",
      minArgs: 1,
      maxArgs: 1,
      validate: ([id]) => [idSchema.parse(id)],
      handler: ([id], context) => copy(find(id as string, context.sessionId)),
    },
    submitOpenAIBrowserSignIn: {
      capability: "providers.configure",
      mutation: true,
      minArgs: 2,
      maxArgs: 2,
      validate: ([id, url]) => [idSchema.parse(id), z.string().url().max(4096).parse(url)],
      handler: ([id, raw], context) => {
        const flow = find(id as string, context.sessionId);
        const callback = new URL(raw as string);
        const state = new URL(
          flow.display.authorizationUrl ?? "https://auth.openai.com",
        ).searchParams.get("state");
        if (
          flow.display.state !== "pending" ||
          callback.origin !== "http://localhost:1455" ||
          callback.pathname !== "/auth/callback" ||
          !callback.searchParams.get("code") ||
          !state ||
          callback.searchParams.get("state") !== state
        )
          throw new WebApplicationError(
            "INVALID_REQUEST",
            "Paste the complete callback URL from this sign-in.",
          );
        flow.resolve(callback.href);
        return { success: true };
      },
    },
    openaiOAuthLogout: {
      capability: "providers.configure",
      mutation: true,
      minArgs: 0,
      maxArgs: 0,
      handler: () => {
        const settings = LLMProviderFactory.loadSettings();
        LLMProviderFactory.saveSettings({
          ...settings,
          openai: {
            ...settings.openai,
            accessToken: undefined,
            refreshToken: undefined,
            tokenExpiresAt: undefined,
            accountId: undefined,
            email: undefined,
            authMethod: undefined,
          },
          cachedOpenAIModels: undefined,
        });
        for (const flow of flows.values()) cancel(flow);
        return { success: true };
      },
    },
    cancelOpenAIBrowserSignIn: {
      capability: "providers.configure",
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: ([id]) => [idSchema.parse(id)],
      handler: ([id], context) => {
        cancel(find(id as string, context.sessionId));
        return { success: true };
      },
    },
  };
  return {
    definitions,
    revokeSession: (owner: string) => {
      for (const flow of flows.values())
        if (flow.owner === owner) {
          cancel(flow);
          clearTimeout(flow.timer);
          flows.delete(flow.display.flowId);
        }
    },
    dispose: () => {
      for (const flow of flows.values()) {
        cancel(flow);
        clearTimeout(flow.timer);
      }
      flows.clear();
    },
  };
}
