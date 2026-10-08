import { describe, expect, it } from "vitest";
import {
  checkPactUrl,
  evaluateAuthorizationServerMetadata,
  evaluateCardSupport,
} from "../protocol-adapter";

const rules = { allowLoopbackHttp: false };

function card(overrides: Record<string, unknown> = {}) {
  return {
    name: "Example Co. Support",
    description: "Orders",
    supportedInterfaces: [
      {
        url: "https://provider.example/a2a/brand",
        protocolBinding: "HTTP+JSON",
        protocolVersion: "1.0",
      },
    ],
    version: "0.1.0",
    capabilities: { streaming: false },
    securitySchemes: {
      anyName: { httpAuthSecurityScheme: { scheme: "Bearer", bearerFormat: "JWT" } },
    },
    securityRequirements: [{ schemes: { anyName: { list: [] } } }],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [],
    ...overrides,
  };
}

const delegatedSchemes = {
  pa: { httpAuthSecurityScheme: { scheme: "Bearer", bearerFormat: "JWT" } },
  account: {
    oauth2SecurityScheme: {
      flows: {
        deviceCode: {
          deviceAuthorizationUrl: "https://provider.example/a2a/brand/oauth/device_authorization",
          tokenUrl: "https://provider.example/a2a/brand/oauth/token",
          scopes: { "orders:read": "Look up your orders" },
        },
      },
      oauth2MetadataUrl:
        "https://provider.example/a2a/brand/oauth/.well-known/oauth-authorization-server",
    },
  },
};

describe("PACT card support check", () => {
  it("selects the interface by binding and version, never by position", () => {
    const result = evaluateCardSupport(
      card({
        supportedInterfaces: [
          {
            url: "https://provider.example/jsonrpc",
            protocolBinding: "JSONRPC",
            protocolVersion: "1.0",
          },
          {
            url: "https://provider.example/a2a/brand",
            protocolBinding: "HTTP+JSON",
            protocolVersion: "1.0",
          },
        ],
      }),
      rules,
    );
    expect(result).toMatchObject({
      status: "supported",
      interfaceUrl: "https://provider.example/a2a/brand",
    });
  });

  it("rejects unsupported versions, bindings, ambiguous interfaces and tenants", () => {
    expect(
      evaluateCardSupport(
        card({
          supportedInterfaces: [
            { url: "https://p.example/a", protocolBinding: "HTTP+JSON", protocolVersion: "2.0" },
          ],
        }),
        rules,
      ),
    ).toMatchObject({ status: "unsupported", reason: "no_http_json_1_0_interface" });
    expect(
      evaluateCardSupport(
        card({
          supportedInterfaces: [
            { url: "https://p.example/a", protocolBinding: "HTTP+JSON", protocolVersion: "1.0" },
            { url: "https://p.example/b", protocolBinding: "HTTP+JSON", protocolVersion: "1.0" },
          ],
        }),
        rules,
      ),
    ).toMatchObject({ status: "unsupported", reason: "ambiguous_interface" });
    expect(
      evaluateCardSupport(
        card({
          supportedInterfaces: [
            {
              url: "https://p.example/a",
              protocolBinding: "HTTP+JSON",
              protocolVersion: "1.0",
              tenant: "t1",
            },
          ],
        }),
        rules,
      ),
    ).toMatchObject({ status: "unsupported", reason: "interface_tenant_unsupported" });
  });

  it("finds schemes by type, not by key name", () => {
    const result = evaluateCardSupport(
      card({
        securitySchemes: delegatedSchemes,
        securityRequirements: [
          { schemes: { pa: { list: [] } } },
          { schemes: { pa: { list: [] }, account: { list: [] } } },
        ],
      }),
      rules,
    );
    expect(result).toMatchObject({
      status: "supported",
      profile: "delegated",
      identitySchemeName: "pa",
    });
  });

  it("requires the identity scheme alone in a requirement and refuses required extensions", () => {
    expect(
      evaluateCardSupport(
        card({
          securitySchemes: delegatedSchemes,
          securityRequirements: [{ schemes: { pa: { list: [] }, account: { list: [] } } }],
        }),
        rules,
      ),
    ).toMatchObject({ status: "unsupported", reason: "identity_requirement_missing" });
    expect(
      evaluateCardSupport(
        card({
          capabilities: { extensions: [{ uri: "urn:x", description: "x", required: true }] },
        }),
        rules,
      ),
    ).toMatchObject({ status: "unsupported", reason: "required_extension_unsupported" });
    expect(
      evaluateCardSupport(card({ securitySchemes: {}, securityRequirements: [] }), rules),
    ).toMatchObject({ status: "unsupported", reason: "identity_scheme_missing" });
  });

  it("rejects malformed cards, unknown top-level fields and insecure URLs", () => {
    expect(evaluateCardSupport({ name: "x" }, rules)).toMatchObject({
      status: "unsupported",
      reason: "invalid_card",
    });
    expect(evaluateCardSupport(card({ surprise: true }), rules)).toMatchObject({
      reason: "invalid_card",
    });
    expect(
      evaluateCardSupport(
        card({
          supportedInterfaces: [
            {
              url: "http://provider.example/a",
              protocolBinding: "HTTP+JSON",
              protocolVersion: "1.0",
            },
          ],
        }),
        rules,
      ),
    ).toMatchObject({ status: "unsupported", reason: "insecure_url" });
  });

  it("allows loopback http only under development rules", () => {
    expect(checkPactUrl("http://127.0.0.1:3000/a2a", { allowLoopbackHttp: true })).toBeTruthy();
    expect(checkPactUrl("http://127.0.0.1:3000/a2a", rules)).toBeUndefined();
    expect(checkPactUrl("http://example.com/a2a", { allowLoopbackHttp: true })).toBeUndefined();
    expect(checkPactUrl("https://user:pw@example.com/", rules)).toBeUndefined();
    expect(checkPactUrl("https://example.com/#frag", rules)).toBeUndefined();
  });

  it("refuses RFC 8414 metadata that disagrees with the card", () => {
    const support = evaluateCardSupport(
      card({
        securitySchemes: delegatedSchemes,
        securityRequirements: [
          { schemes: { pa: { list: [] } } },
          { schemes: { pa: { list: [] }, account: { list: [] } } },
        ],
      }),
      rules,
    );
    if (support.status !== "supported" || !support.delegation)
      throw new Error("expected delegated");
    const metadata = {
      issuer: "https://provider.example/a2a/brand/oauth",
      device_authorization_endpoint: support.delegation.deviceAuthorizationUrl,
      token_endpoint: support.delegation.tokenUrl,
      jwks_uri: "https://provider.example/a2a/brand/oauth/jwks.json",
    };
    expect(evaluateAuthorizationServerMetadata(metadata, support.delegation, rules).status).toBe(
      "valid",
    );
    expect(
      evaluateAuthorizationServerMetadata(
        { ...metadata, token_endpoint: "https://evil.example/token" },
        support.delegation,
        rules,
      ),
    ).toMatchObject({ status: "invalid" });
  });
});
