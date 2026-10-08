import { describe, expect, it } from "vitest";
import type { PactSettings } from "../../../shared/pact";
import { isPactProviderBlocked, validatePolicies, type AdminPolicies } from "../../admin/policies";
import {
  admitPactOperation,
  classifyScope,
  classifyText,
  findSensitiveContent,
} from "../admission-service";
import { redactPact, redactPactString } from "../redaction";
import { evaluatePactAvailability, pactToolsExposed, resolveBusinessRoute } from "../routing";
import { normalizePactSettings } from "../settings";
import type { PactBusinessRecord } from "../types";

const business: PactBusinessRecord = {
  id: "b1",
  cardUrl: "https://shop.example/.well-known/agent-card.json",
  displayName: "Shop",
  originChain: [],
  providerId: "p1",
  interfaceUrl: "https://provider.example/a2a/shop",
  profile: "delegated",
  supportStatus: "supported",
  unsupportedReason: null,
  cardFingerprint: "x",
  securityFingerprint: "y",
  descriptor: {
    description: "",
    identitySchemeName: "pa",
    skills: [],
    delegation: {
      deviceAuthorizationUrl: "https://provider.example/da",
      tokenUrl: "https://provider.example/token",
      refreshUrl: "https://provider.example/token",
      metadataUrl: "https://provider.example/meta",
      scopes: [
        { id: "orders:read", description: "Look up your orders and their status" },
        { id: "orders:cancel", description: "Cancel an order that has not shipped" },
        { id: "loyalty", description: "Your points" },
      ],
    },
  },
  revision: 1,
  fetchedAt: 0,
  expiresAt: 0,
  createdAt: 0,
  updatedAt: 0,
};

const owner = { id: "o", kind: "local_owner" as const };

describe("effect classification and admission", () => {
  it("classifies scopes and text conservatively", () => {
    expect(classifyScope({ id: "orders:read", description: "Look up your orders" })).toBe(
      "inspect",
    );
    expect(classifyScope({ id: "orders:cancel", description: "Cancel an order" })).toBe("change");
    expect(classifyScope({ id: "loyalty", description: "Your points" })).toBe("unknown");
    expect(classifyText("Where is my order A-1?")).toBe("inspect");
    expect(classifyText("Please cancel order A-1")).toBe("change");
  });

  it("a stored cancel permission cannot turn an inspection into a cancellation", () => {
    const admission = admitPactOperation({
      principal: owner,
      origin: "owner",
      localAuthority: "task",
      business,
      text: "Where is my order?",
      declaredEffect: "inspect",
      requiredScopes: [],
      tokenScopes: ["orders:cancel"],
    });
    expect(admission).toMatchObject({
      decision: "admit",
      effectClass: "inspect",
      approvalRequired: true,
    });
    expect((admission as { approvalReasons: string[] }).approvalReasons).toContain(
      "token_exceeds_operation",
    );
  });

  it("takes the strongest declared, textual or scope effect and needs approval for it", () => {
    const admission = admitPactOperation({
      principal: owner,
      origin: "owner",
      localAuthority: "task",
      business,
      text: "Status please?",
      declaredEffect: "inspect",
      requiredScopes: ["loyalty"],
      tokenScopes: [],
    });
    expect(admission).toMatchObject({ effectClass: "unknown", approvalRequired: true });
  });

  it("lets the owner's explicit request cover a change, but not an unknown effect", () => {
    const change = admitPactOperation({
      principal: owner,
      origin: "owner_cli",
      localAuthority: "explicit_user_request",
      business,
      text: "Cancel order A-1",
      declaredEffect: "change",
      requiredScopes: ["orders:cancel"],
      tokenScopes: ["orders:cancel"],
    });
    expect(change).toMatchObject({ effectClass: "change", approvalRequired: false });
    const unknown = admitPactOperation({
      principal: owner,
      origin: "owner_cli",
      localAuthority: "explicit_user_request",
      business,
      text: "Do the thing",
      declaredEffect: "unknown",
      requiredScopes: [],
      tokenScopes: [],
    });
    expect(unknown).toMatchObject({ approvalRequired: true });
  });

  it("denies unknown scopes, empty or oversized messages, secrets and non-owner origins", () => {
    const base = {
      principal: owner,
      origin: "owner" as const,
      localAuthority: "task" as const,
      business,
      declaredEffect: "inspect" as const,
      tokenScopes: [],
    };
    expect(
      admitPactOperation({ ...base, text: "hi?", requiredScopes: ["refunds:issue"] }),
    ).toMatchObject({ reason: "unknown_scope" });
    expect(admitPactOperation({ ...base, text: "   ", requiredScopes: [] })).toMatchObject({
      reason: "blank_message",
    });
    expect(
      admitPactOperation({ ...base, text: "x".repeat(4001), requiredScopes: [] }),
    ).toMatchObject({ reason: "message_too_long" });
    expect(
      admitPactOperation({ ...base, text: "my password: hunter2", requiredScopes: [] }),
    ).toMatchObject({ reason: "sensitive_content" });
    expect(
      admitPactOperation({ ...base, origin: "bot", text: "hi?", requiredScopes: [] }),
    ).toMatchObject({ reason: "delegation_required" });
    expect(findSensitiveContent("token sk-abcdefghijklmnopqrstuvwxyz")).toBeTruthy();
    expect(findSensitiveContent("Order A-88213, delivered Monday")).toBeNull();
  });
});

describe("redaction", () => {
  it("removes tokens, device codes, sign-in links and the receipt user claim", () => {
    const redacted = redactPact({
      headers: {
        Authorization: "Bearer eyJhbGciOi.eyJzdWIiOi.c2ln",
        "X-A2A-User-Delegation": "Bearer abc",
      },
      device_code: "dc_0123456789abcdef0123",
      verificationUriComplete: "https://brand.example/login?return_to=x%3Fuser_code%3DWDJB-MJHT",
      note: "refresh_token=rt_abcdefghijklmnop0123 used",
      receipt: { claims: { user: "jane-4471", grantId: "g1" } },
    });
    const text = JSON.stringify(redacted);
    expect(text).not.toMatch(/eyJhbGciOi|dc_0123|WDJB-MJHT|rt_abcdef|jane-4471|Bearer abc/);
    expect(text).toContain("g1");
    expect(redactPactString("Authorization: Bearer abc.def.ghi")).toBe(
      "Authorization: Bearer [redacted]",
    );
  });
});

describe("settings, availability and routing", () => {
  const policy = { enabled: true, autoRoute: true, blockedProviders: [] };
  const settings = (overrides: Partial<PactSettings> = {}): PactSettings => ({
    version: 1,
    enabled: true,
    preference: "prefer-pact",
    identity: {
      deployment: "self_hosted",
      issuer: "https://pa.example",
      signerUrl: "https://s.example",
    },
    providers: [],
    ...overrides,
  });

  it("never reads the development signer outside development runs and keeps explicit choices", () => {
    expect(
      normalizePactSettings({ identity: { deployment: "development" } } as never, {
        developmentAllowed: false,
      }).identity.deployment,
    ).toBe("none");
    const normalized = normalizePactSettings({
      enabled: true,
      preference: "require-pact",
      identity: {
        deployment: "self_hosted",
        issuer: "http://pa.example",
        signerUrl: "https://s.example/",
      },
      providers: [
        { origin: "https://p.example/path", audience: "aud" },
        { origin: "nope", audience: "x" },
      ],
    } as never);
    expect(normalized.preference).toBe("require-pact");
    expect(normalized.identity.issuer).toBeUndefined(); // http issuer refused
    expect(normalized.identity.signerUrl).toBe("https://s.example");
    expect(normalized.providers).toEqual([{ origin: "https://p.example", audience: "aud" }]);
    // No qualified default yet: an unset preference stays unset.
    expect(normalizePactSettings({ enabled: true } as never).preference).toBeUndefined();
  });

  it("applies hard limits before preferences", () => {
    expect(
      evaluatePactAvailability({
        settings: settings(),
        policy,
        env: { COWORK_PACT_DISABLED: "1" },
      }),
    ).toMatchObject({ reason: "disabled_by_env" });
    expect(
      evaluatePactAvailability({
        settings: settings(),
        policy: { ...policy, enabled: false },
        env: {},
      }),
    ).toMatchObject({ reason: "disabled_by_admin" });
    expect(
      evaluatePactAvailability({ settings: settings({ enabled: false }), policy, env: {} }),
    ).toMatchObject({ reason: "disabled_in_settings" });
    expect(
      pactToolsExposed({ settings: settings({ preference: "disabled" }), policy, env: {} }),
    ).toBe(false);
    expect(pactToolsExposed({ settings: settings(), policy, env: {} })).toBe(true);
  });

  it("routes per the preference table", () => {
    const available = { available: true } as const;
    expect(
      resolveBusinessRoute({
        preference: "prefer-pact",
        availability: available,
        support: "supported",
        identityReady: true,
        providerReady: true,
      }),
    ).toMatchObject({ route: "pact" });
    expect(
      resolveBusinessRoute({
        preference: "prefer-pact",
        availability: available,
        support: "unsupported",
        identityReady: true,
        providerReady: true,
      }),
    ).toMatchObject({ route: "other" });
    expect(
      resolveBusinessRoute({
        preference: "require-pact",
        availability: available,
        support: "unsupported",
        identityReady: true,
        providerReady: true,
      }),
    ).toMatchObject({ route: "blocked" });
    expect(
      resolveBusinessRoute({
        preference: "require-pact",
        availability: available,
        support: "supported",
        identityReady: false,
        providerReady: true,
      }),
    ).toMatchObject({ route: "blocked", reason: "identity_not_ready" });
    expect(
      resolveBusinessRoute({
        preference: "prefer-pact",
        availability: available,
        support: "rejected",
        identityReady: true,
        providerReady: true,
      }),
    ).toMatchObject({ route: "other", reason: "card_rejected" });
  });
});

describe("admin PACT policy", () => {
  const policies = (pact: AdminPolicies["pact"]) => ({ pact }) as AdminPolicies;

  it("matches blocked providers by origin and host pattern", () => {
    const p = policies({
      enabled: true,
      autoRoute: true,
      blockedProviders: ["https://bad.example", "*.evil.example", "plain.example"],
    });
    expect(isPactProviderBlocked("https://bad.example", p)).toBe(true);
    expect(isPactProviderBlocked("https://a.evil.example", p)).toBe(true);
    expect(isPactProviderBlocked("https://PLAIN.example", p)).toBe(true);
    expect(isPactProviderBlocked("https://good.example", p)).toBe(false);
    expect(isPactProviderBlocked("not a url", p)).toBe(true);
  });

  it("validates the section", () => {
    expect(validatePolicies({ pact: { enabled: "yes" } })).toMatch(/pact.enabled/);
    expect(validatePolicies({ pact: { blockedProviders: [1] } })).toMatch(/blockedProviders/);
    expect(validatePolicies({ pact: { enabled: true, blockedProviders: ["x"] } })).toBeNull();
  });
});
