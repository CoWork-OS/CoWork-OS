import { describe, expect, it } from "vitest";
import {
  buildRemoteOAuthServer,
  DEFAULT_OAUTH_REDIRECT_URI,
  RemoteOAuthServerSchema,
} from "../mcp-server-authorization";

describe("remote OAuth MCP server setup", () => {
  it("builds a Workday server from region and tenant with a write-approval default", () => {
    const config = buildRemoteOAuthServer(
      RemoteOAuthServerSchema.parse({
        name: "Workday",
        kind: "workday",
        region: "US",
        tenant: "acme_dev1",
        grant: "authorization_code",
        clientId: "client-1",
        clientSecret: "secret-1",
      }),
    );
    expect(config).toMatchObject({
      transport: "streamable-http",
      url: "https://us.agent.workday.com/acme_dev1/mcp",
      defaultToolsApprovalMode: "writes",
      auth: {
        type: "bearer",
        clientId: "client-1",
        clientSecret: "secret-1",
        tokenUrl: "https://us.agent.workday.com/auth/oauth2/acme_dev1/token",
        oauth: {
          grant: "authorization_code",
          authorizationUrl: "https://us.agent.workday.com/auth/authorize/acme_dev1",
          redirectUri: DEFAULT_OAUTH_REDIRECT_URI,
          preset: { kind: "workday", region: "us", tenant: "acme_dev1" },
        },
      },
    });
    expect(config.auth?.token).toBeUndefined();
  });

  it("allows plain http only for a loopback development server", () => {
    const local = {
      name: "Local",
      kind: "custom",
      grant: "authorization_code",
      clientId: "c",
      url: "http://127.0.0.1:9000/mcp",
      tokenUrl: "http://127.0.0.1:9000/token",
      authorizationUrl: "http://127.0.0.1:9000/authorize",
    };
    expect(RemoteOAuthServerSchema.safeParse(local).success).toBe(true);
    expect(
      RemoteOAuthServerSchema.safeParse({ ...local, url: "http://10.0.0.5/mcp" }).success,
    ).toBe(false);
  });

  it("rejects incomplete or unsafe input", () => {
    const base = { name: "X", grant: "authorization_code", clientId: "c" };
    expect(
      RemoteOAuthServerSchema.safeParse({ ...base, kind: "workday", region: "us" }).success,
    ).toBe(false);
    expect(
      RemoteOAuthServerSchema.safeParse({
        ...base,
        kind: "custom",
        url: "http://insecure.example/mcp",
        tokenUrl: "https://a.example/token",
        authorizationUrl: "https://a.example/authorize",
      }).success,
    ).toBe(false);
    expect(
      RemoteOAuthServerSchema.safeParse({
        ...base,
        kind: "custom",
        grant: "jwt_bearer",
        url: "https://a.example/mcp",
        tokenUrl: "https://a.example/token",
      }).success,
    ).toBe(false);
    expect(
      RemoteOAuthServerSchema.safeParse({
        ...base,
        kind: "workday",
        region: "us",
        tenant: "t",
        extra: 1,
      }).success,
    ).toBe(false);
  });
});
