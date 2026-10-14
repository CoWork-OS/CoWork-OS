import { describe, expect, it } from "vitest";
import {
  EMPTY_REMOTE_OAUTH_FORM,
  remoteOAuthFormFromServer,
  remoteOAuthFormReady,
  remoteOAuthRequest,
} from "../mcp-remote-oauth-form";

const MASK = "***configured***";

describe("Remote (OAuth) server form", () => {
  it("prefills an edit from the saved server with empty secret fields", () => {
    const { form, stored } = remoteOAuthFormFromServer({
      name: "Workday",
      url: "https://us.agent.workday.com/acme/mcp",
      auth: {
        clientId: "client-1",
        clientSecret: MASK,
        tokenUrl: "https://us.agent.workday.com/auth/oauth2/acme/token",
        oauth: {
          grant: "authorization_code",
          redirectUri: "https://127.0.0.1:18768/oauth/callback",
          scopes: ["a", "b"],
          preset: { kind: "workday", region: "us", tenant: "acme" },
        },
      },
    });
    expect(form).toMatchObject({
      kind: "workday",
      name: "Workday",
      region: "us",
      tenant: "acme",
      clientId: "client-1",
      clientSecret: "",
      privateKey: "",
      redirectUri: "https://127.0.0.1:18768/oauth/callback",
      scopes: "a b",
    });
    expect(JSON.stringify(form)).not.toContain(MASK);
    expect(stored).toEqual({ clientSecret: true, privateKey: false });
  });

  it("leaves blank secrets out of the request so the saved ones are kept", () => {
    const request = remoteOAuthRequest({
      ...EMPTY_REMOTE_OAUTH_FORM,
      tenant: "acme",
      clientId: " client-1 ",
    });
    expect(request).toMatchObject({ kind: "workday", region: "us", tenant: "acme" });
    expect(request.clientId).toBe("client-1");
    expect(request.clientSecret).toBeUndefined();
    expect(
      remoteOAuthRequest({ ...EMPTY_REMOTE_OAUTH_FORM, clientSecret: "s2" }).clientSecret,
    ).toBe("s2");
  });

  it("lets an edit keep a saved agent key", () => {
    const { form, stored } = remoteOAuthFormFromServer({
      name: "Agent",
      url: "https://a.example/mcp",
      auth: {
        clientId: "c",
        privateKey: MASK,
        tokenUrl: "https://a.example/token",
        oauth: { grant: "jwt_bearer", jwt: { subject: "agent-1" } },
      },
    });
    expect(form).toMatchObject({ kind: "custom", url: "https://a.example/mcp", privateKey: "" });
    expect(remoteOAuthFormReady(form)).toBe(false);
    expect(remoteOAuthFormReady(form, stored)).toBe(true);
    expect(remoteOAuthRequest(form)).not.toHaveProperty("privateKey");
  });
});
