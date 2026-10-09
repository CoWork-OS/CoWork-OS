import { describe, expect, it, vi } from "vitest";
import { Methods } from "../protocol";
import { registerPactMethods } from "../registerPactMethods";

type Scope = "admin" | "read" | "write" | "operator";

function setup() {
  const handlers = new Map<string, (client: unknown, params?: unknown) => Promise<unknown>>();
  const server = {
    registerMethod: (
      name: string,
      handler: (client: unknown, params?: unknown) => Promise<unknown>,
    ) => handlers.set(name, handler),
  };
  const runtime = {
    ownerPrincipal: vi.fn(async (actor?: string) => ({ id: "owner", kind: "local_owner", actor })),
    status: vi.fn(async () => ({ available: true })),
    send: vi.fn(async () => ({ status: "replied" })),
    discover: vi.fn(async () => ({ business: { id: "b" }, route: { route: "pact" } })),
    startAuthorization: vi.fn(async () => ({ id: "a", state: "pending" })),
    disconnectGrant: vi.fn(async () => ({ id: "g", state: "disconnected" })),
    getAuthorizationSignIn: vi.fn(async () => ({
      verificationUriComplete: "https://brand.example/x",
    })),
  };
  const agentDaemon = {
    getPactRuntime: () => runtime,
    getWorkspaceForPact: (id: string) =>
      id === "ws-open"
        ? { id, path: "/tmp/ws-open", permissions: { read: true, network: true } }
        : undefined,
  };
  const requireScope = (client: unknown, scope: Scope) => {
    const scopes = (client as { scopes: Scope[] }).scopes;
    if (!scopes.includes("admin") && !scopes.includes(scope)) {
      throw { code: "UNAUTHORIZED", message: `Missing required scope: ${scope}` };
    }
  };
  registerPactMethods({ server: server as never, agentDaemon: agentDaemon as never, requireScope });
  const call = (method: string, scopes: Scope[], params?: unknown) =>
    handlers.get(method)!(
      { id: "client-7", scopes, hasScope: (scope: Scope) => scopes.includes(scope) },
      params,
    );
  return { handlers, runtime, call };
}

describe("PACT Control Plane methods", () => {
  it("registers every PACT method", () => {
    const { handlers } = setup();
    const expected = Object.entries(Methods)
      .filter(([key]) => key.startsWith("PACT_"))
      .map(([, method]) => method);
    expect([...handlers.keys()].sort()).toEqual([...expected].sort());
  });

  it("maps scopes: read for views, operator for sends, grants and sign-in links, admin for config", async () => {
    const { call } = setup();
    await expect(call(Methods.PACT_STATUS, ["read"])).resolves.toBeTruthy();
    await expect(
      call(Methods.PACT_CONVERSATION_SEND, ["write"], {
        businessId: "b",
        text: "hi",
        effect: "inspect",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      call(Methods.PACT_CONVERSATION_SEND, ["operator"], {
        businessId: "b",
        text: "hi",
        effect: "inspect",
      }),
    ).resolves.toBeTruthy();
    await expect(call(Methods.PACT_GRANT_DISCONNECT, ["write"], { id: "g" })).rejects.toMatchObject(
      { code: "UNAUTHORIZED" },
    );
    await expect(
      call(Methods.PACT_GRANT_DISCONNECT, ["operator"], { id: "g" }),
    ).resolves.toBeTruthy();
    await expect(
      call(Methods.PACT_AUTHORIZATION_SIGN_IN, ["read"], { id: "a" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      call(Methods.PACT_AUTHORIZATION_SIGN_IN, ["operator"], { id: "a" }),
    ).resolves.toBeTruthy();
    await expect(
      call(Methods.PACT_SETTINGS_UPDATE, ["operator"], { enabled: true }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      call(Methods.PACT_IDENTITY_SET_CREDENTIAL, ["write"], { credential: null }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects invalid params and records the remote actor", async () => {
    const { call, runtime } = setup();
    await expect(
      call(Methods.PACT_CONVERSATION_SEND, ["operator"], { businessId: "b" }),
    ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await call(Methods.PACT_STATUS, ["read"]);
    expect(runtime.ownerPrincipal).toHaveBeenCalledWith("control_plane:client-7");
  });

  it("lets only an admin client choose a workspace's network rules", async () => {
    const { call, runtime } = setup();
    const send = { businessId: "b", text: "hi", effect: "inspect", workspaceId: "ws-open" };
    await expect(call(Methods.PACT_CONVERSATION_SEND, ["operator"], send)).rejects.toMatchObject({
      code: "INVALID_PARAMS",
      message: expect.stringContaining("Only an admin client"),
    });
    await expect(
      call(Methods.PACT_BUSINESS_DISCOVER, ["write"], {
        domain: "shop.example",
        workspaceId: "ws-open",
      }),
    ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(
      call(Methods.PACT_AUTHORIZATION_START, ["operator"], {
        businessId: "b",
        scopes: ["orders:read"],
        workspaceId: "ws-open",
      }),
    ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    expect(runtime.send).not.toHaveBeenCalled();
    expect(runtime.discover).not.toHaveBeenCalled();
    expect(runtime.startAuthorization).not.toHaveBeenCalled();

    // Without a workspace the default profile applies; an admin may name one.
    await expect(
      call(Methods.PACT_CONVERSATION_SEND, ["operator"], {
        businessId: "b",
        text: "hi",
        effect: "inspect",
      }),
    ).resolves.toBeTruthy();
    await expect(call(Methods.PACT_CONVERSATION_SEND, ["admin"], send)).resolves.toBeTruthy();
    expect(runtime.send).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ workspaceId: "ws-open" }),
    );
  });
});
