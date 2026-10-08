/**
 * CoWork's PACT runtime against the upstream reference provider (openpactprotocol@838c6bd),
 * through the production transport (policy-checked, DNS-pinned). Runs only when
 * PACT_REFERENCE_PROVIDER_URL is set; the `pact-conformance` CI job starts the reference stack.
 *
 *   PACT_REFERENCE_PROVIDER_URL=http://localhost:3000
 *   PACT_REFERENCE_AUDIENCE=http://localhost:3000/a2a
 *   PACT_REFERENCE_IDENTITY_CUSTOMER=01M3R53Q5WKZ7A0GY4PZ8Y39TB      (Loom & Co., identity only)
 *   PACT_REFERENCE_DELEGATED_CUSTOMER=01M3R53Q5SZQ6FQSMSDBSSREAA     (Skyline, delegation on)
 *   PACT_REFERENCE_BRAND_EMAIL / PACT_REFERENCE_BRAND_PASSWORD        (demo login)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PactSettings } from "../../../shared/pact";
import type { AdminPolicies } from "../../admin/policies";
import { DevelopmentPactSigner } from "../development-signer";
import { PactRuntime, type PactCallContext, type PactHost } from "../runtime";
import { ensurePactSchema } from "../schema";
import { MemoryPactSecretStore } from "../secret-store";
import { createPactTransport } from "../transport-node";

const providerUrl = (process.env.PACT_REFERENCE_PROVIDER_URL ?? "").replace(/\/+$/, "");
const audience = process.env.PACT_REFERENCE_AUDIENCE ?? `${providerUrl}/a2a`;
const identityCustomer = process.env.PACT_REFERENCE_IDENTITY_CUSTOMER ?? "01M3R53Q5WKZ7A0GY4PZ8Y39TB";
const delegatedCustomer =
  process.env.PACT_REFERENCE_DELEGATED_CUSTOMER ?? "01M3R53Q5SZQ6FQSMSDBSSREAA";
const brandEmail = process.env.PACT_REFERENCE_BRAND_EMAIL ?? "alex.rivera@example.com";
const brandPassword = process.env.PACT_REFERENCE_BRAND_PASSWORD ?? "skyline";

const nativeSqlite = providerUrl
  ? await import("better-sqlite3").then((module) => module.default).catch(() => null)
  : null;

function field(html: string, name: string): string {
  const tag = html.match(new RegExp(`<input\\b[^>]*\\bname="${name}"[^>]*>`))?.[0];
  const value = tag?.match(/\bvalue="([^"]+)"/)?.[1];
  if (!value) throw new Error(`No ${name} field in page`);
  return value;
}

/** Plays the user in their own browser: Brand login, then the Provider's consent page. */
async function approveInBrowser(link: string, scopes: string[], decision: "allow" | "deny"): Promise<void> {
  const loginUrl = new URL(link);
  const returnTo = loginUrl.searchParams.get("return_to") ?? "";
  const login = await fetch(new URL("/login", loginUrl), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ return_to: returnTo, email: brandEmail, password: brandPassword }),
  });
  const loginHtml = await login.text();
  const consentAction = loginHtml.match(/<form[^>]*\baction="([^"]+)"/)?.[1] ?? "";
  const consent = await fetch(consentAction, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ assertion: field(loginHtml, "assertion") }),
  });
  const consentHtml = await consent.text();
  const decisionAction = consentHtml.match(/<form[^>]*\baction="([^"]+)"/)?.[1] ?? "";
  const body = new URLSearchParams({ session: field(consentHtml, "session"), decision });
  for (const scope of scopes) body.append("scope", scope);
  await fetch(decisionAction.replace(/&amp;/g, "&"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
  });
}

describe.skipIf(!providerUrl || !nativeSqlite)("PACT conformance against the reference provider", () => {
  const owner = { id: "conformance-owner", kind: "local_owner" as const };
  const signer = new DevelopmentPactSigner({ subject: `cowork-ci-${crypto.randomUUID()}` });
  let runtime: PactRuntime;
  let consentDecision: "allow" | "deny" = "allow";
  let consentScopes: string[] | null = null;
  const settings: PactSettings = {
    version: 1,
    enabled: true,
    preference: "prefer-pact",
    identity: { deployment: "development" },
    providers: [{ origin: providerUrl, audience }],
  };
  const context: PactCallContext = {
    taskId: "conformance-task",
    origin: "owner",
    localAuthority: "explicit_user_request",
    humanInput: "interactive",
    waitForConsent: true,
    preApproved: true,
    networkContext: { networkEnabled: true, accessNetworkMode: "enabled" },
  };

  beforeAll(async () => {
    const issuer = await signer.start();
    settings.identity.issuer = issuer;
    // Self-service registration at the reference provider (ES256 token signed by our key).
    const registrationUrl = `${providerUrl}/api/platforms`;
    const registered = await fetch(registrationUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${signer.registrationToken(registrationUrl)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: `cowork-ci-${Date.now().toString(36)}`,
        jwksUri: `${issuer}/.well-known/jwks.json`,
      }),
    });
    expect([200, 201]).toContain(registered.status);

    const db = new nativeSqlite!(":memory:");
    ensurePactSchema(db);
    const host: PactHost = {
      requestLocalApproval: async () => true,
      openAuthorizationWait: async () => {
        // The runtime polls; play the user once the sign-in link exists.
        setTimeout(() => {
          void (async () => {
            const pending = await runtime.listAuthorizations(owner, { pendingOnly: true });
            const signIn = pending[0] ? await runtime.getAuthorizationSignIn(owner, pending[0].id) : null;
            if (!signIn || !pending[0]) return;
            await approveInBrowser(
              signIn.verificationUriComplete,
              consentScopes ?? pending[0].requestedScopes.map((scope) => scope.id),
              consentDecision,
            );
          })();
        }, 200);
        return `input-${Date.now()}`;
      },
      settleAuthorizationWait: async () => undefined,
      logEvent: () => undefined,
      logInteractiveApprovalUnavailable: () => undefined,
      networkContextForWorkspace: async () => context.networkContext,
      taskStillWaiting: async () => true,
    };
    runtime = new PactRuntime({
      db,
      secrets: new MemoryPactSecretStore(db),
      host,
      settings: () => settings,
      policies: () => ({ pact: { enabled: true, autoRoute: true, blockedProviders: [] } }) as unknown as AdminPolicies,
      transportFor: (networkContext) => createPactTransport({ networkContext }),
      env: { COWORK_PACT_DEVELOPMENT: "1" },
      signerFor: () => signer,
      ownerPrincipalId: () => owner.id,
    });
  }, 60_000);

  afterAll(async () => {
    await runtime?.shutdown();
    await signer.stop();
  });

  it("identity profile: discovers, sends, and continues the same context", async () => {
    const { business, route } = await runtime.discover(
      owner,
      { cardUrl: `${providerUrl}/a2a/${identityCustomer}/.well-known/agent-card.json` },
      context,
    );
    expect(business.supported).toBe(true);
    expect(business.profile).toBe("identity");
    expect(route.route).toBe("pact");
    const first = await runtime.send(
      owner,
      { businessId: business.id, text: "Hi, I need help with my order.", effect: "inspect", requiredScopes: [] },
      context,
    );
    expect(first.status).toBe("replied");
    const second = await runtime.send(
      owner,
      {
        businessId: business.id,
        conversationId: (first as { conversationId: string }).conversationId,
        text: "What are your opening hours?",
        effect: "inspect",
        requiredScopes: [],
      },
      context,
    );
    expect(second).toMatchObject({ status: "replied", conversationId: (first as { conversationId: string }).conversationId });
  }, 120_000);

  it("delegated profile: consent on the business's page, verified receipt", async () => {
    const { business } = await runtime.discover(
      owner,
      { cardUrl: `${providerUrl}/a2a/${delegatedCustomer}/.well-known/agent-card.json` },
      context,
    );
    if (business.profile !== "delegated") return; // Provider started without DELEGATION_ENABLED.
    consentDecision = "allow";
    consentScopes = null;
    const outcome = await runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Can you check my upcoming flights?",
        effect: "inspect",
        requiredScopes: ["flights:upcoming:read"],
      },
      context,
    );
    expect(outcome).toMatchObject({ status: "replied", evidence: "verified" });
  }, 180_000);

  it("delegated profile: a declined consent stops the operation", async () => {
    const { business } = await runtime.discover(
      owner,
      { cardUrl: `${providerUrl}/a2a/${delegatedCustomer}/.well-known/agent-card.json` },
      context,
    );
    if (business.profile !== "delegated") return;
    consentDecision = "deny";
    const outcome = await runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Show my past flights please.",
        effect: "inspect",
        requiredScopes: ["flights:history:read"],
      },
      context,
    );
    expect(outcome).toMatchObject({ status: "denied", reason: "consent_denied" });
  }, 180_000);
});
