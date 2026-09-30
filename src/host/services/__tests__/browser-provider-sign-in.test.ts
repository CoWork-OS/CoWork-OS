import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserProviderSignIn } from "../browser-provider-sign-in";
import type { OpenAIOAuth } from "../../../electron/agent/llm/openai-oauth";

const tokens = {
  access_token: "private-access",
  refresh_token: "private-refresh",
  expires_at: 1000,
  planType: "plus",
};
const owner = { sessionId: "owner" } as never;
const stranger = { sessionId: "stranger" } as never;
const authUrl = "https://auth.openai.com/oauth/authorize?state=fixture-state";
const callback = "http://localhost:1455/auth/callback?code=private-code&state=fixture-state";
function setup(persist = vi.fn(), ttlMs = 300_000) {
  const authenticate = vi.fn(
    async (hooks: NonNullable<Parameters<OpenAIOAuth["authenticate"]>[0]>) => {
      hooks.onAuth({ url: authUrl });
      await hooks.onManualCodeInput();
      return tokens;
    },
  );
  const service = createBrowserProviderSignIn({ authenticator: { authenticate }, persist, ttlMs });
  const call = async (
    name: keyof typeof service.definitions,
    args: unknown[] = [],
    context = owner,
  ) => {
    const method = service.definitions[name];
    return method.handler(method.validate?.(args) ?? args, context) as Promise<any>;
  };
  return { service, call, persist, authenticate };
}

afterEach(() => vi.useRealTimers());

describe("browser account sign-in", () => {
  it("binds pending outcomes to their session and keeps credentials out of returned records", async () => {
    const { service, call, persist } = setup();
    try {
      const flow = await call("beginOpenAIBrowserSignIn");
      expect(flow.authorizationUrl).toBe(authUrl);
      await expect(call("getOpenAIBrowserSignIn", [flow.flowId], stranger)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(
        call("cancelOpenAIBrowserSignIn", [flow.flowId], stranger),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(call("beginOpenAIBrowserSignIn", [], stranger)).rejects.toMatchObject({
        code: "CONFLICT",
      });
      await expect(
        call("submitOpenAIBrowserSignIn", [
          flow.flowId,
          callback.replace("fixture-state", "wrong"),
        ]),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(
        call("submitOpenAIBrowserSignIn", [
          flow.flowId,
          "http://localhost:1455/auth/callback?code=private-code",
        ]),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await call("submitOpenAIBrowserSignIn", [flow.flowId, callback]);
      await vi.waitFor(async () =>
        expect((await call("getOpenAIBrowserSignIn", [flow.flowId])).state).toBe("completed"),
      );
      expect(persist).toHaveBeenCalledWith(tokens);
      const result = await call("getOpenAIBrowserSignIn", [flow.flowId]);
      expect(result.authorizationUrl).toBeUndefined();
      expect(JSON.stringify(result)).not.toMatch(/private-|access_token|refresh_token/);
    } finally {
      service.dispose();
    }
  });

  it("does not announce completion when persistence fails", async () => {
    const { service, call } = setup(
      vi.fn(() => {
        throw new Error("private-refresh store refused");
      }),
    );
    try {
      const flow = await call("beginOpenAIBrowserSignIn");
      await call("submitOpenAIBrowserSignIn", [flow.flowId, callback]);
      await vi.waitFor(async () =>
        expect((await call("getOpenAIBrowserSignIn", [flow.flowId])).state).toBe("failed"),
      );
      const result = await call("getOpenAIBrowserSignIn", [flow.flowId]);
      expect(result.error).toBe("Account sign-in could not be completed. Start again.");
      expect(JSON.stringify(result)).not.toContain("private-refresh");
    } finally {
      service.dispose();
    }
  });

  it("cancels on session revocation and prevents late credentials from being saved", async () => {
    let finish!: (value: typeof tokens) => void;
    const persist = vi.fn();
    const service = createBrowserProviderSignIn({
      persist,
      authenticator: {
        authenticate: async (hooks) => {
          hooks!.onAuth({ url: authUrl });
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
    });
    try {
      const flow = (await service.definitions.beginOpenAIBrowserSignIn.handler([], owner)) as any;
      service.revokeSession("owner");
      finish(tokens);
      await new Promise((resolve) => setImmediate(resolve));
      expect(persist).not.toHaveBeenCalled();
      expect(() =>
        service.definitions.getOpenAIBrowserSignIn.handler([flow.flowId], owner),
      ).toThrow("Sign-in is unavailable.");
    } finally {
      service.dispose();
    }
  });

  it("expires pending flows and releases the SDK callback wait", async () => {
    vi.useFakeTimers();
    const { service, call, persist } = setup(vi.fn(), 100);
    try {
      const flow = await call("beginOpenAIBrowserSignIn");
      await vi.advanceTimersByTimeAsync(101);
      await expect(call("getOpenAIBrowserSignIn", [flow.flowId])).rejects.toMatchObject({
        code: "STALE_STATE",
      });
      expect(persist).not.toHaveBeenCalled();
      const next = await call("beginOpenAIBrowserSignIn");
      expect(next.flowId).not.toBe(flow.flowId);
      await call("cancelOpenAIBrowserSignIn", [next.flowId]);
    } finally {
      service.dispose();
    }
  });
});
