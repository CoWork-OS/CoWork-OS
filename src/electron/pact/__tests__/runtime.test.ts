import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PactAuthorizationState, PactSettings } from "../../../shared/pact";
import type { AdminPolicies } from "../../admin/policies";
import type { NetworkPolicyContext } from "../../security/policy-checked-fetch";
import { DevelopmentPactSigner } from "../development-signer";
import { PactRuntime, type PactCallContext, type PactHost } from "../runtime";
import { ensurePactSchema } from "../schema";
import { MemoryPactSecretStore } from "../secret-store";
import { PactTransport } from "../transport";
import { FakeNetwork, FakePactProvider } from "./fixtures/fake-pact-provider";

const nativeSqlite = await import("better-sqlite3")
  .then((module) => {
    try {
      new module.default(":memory:").close();
      return module.default;
    } catch {
      return null;
    }
  })
  .catch(() => null);

const PROVIDER_ORIGIN = "https://provider.example";
const BRAND_ORIGIN = "https://shop.example";
const ISSUER = "https://pa.cowork.example";
const AUDIENCE = "aud-cowork-123";

interface Harness {
  runtime: PactRuntime;
  provider: FakePactProvider;
  network: FakeNetwork;
  host: PactHost & {
    approvals: string[];
    approvalDetails: Record<string, unknown>[];
    waits: { taskId: string; requestId: string }[];
    settled: { requestId: string; state: PactAuthorizationState }[];
    events: { type: string; payload: Record<string, unknown> }[];
    unavailable: string[];
    approve: boolean;
    onWait: () => void;
  };
  settings: PactSettings;
  policies: AdminPolicies;
  secrets: MemoryPactSecretStore;
  signer: DevelopmentPactSigner;
  clock: { now: number };
  db: InstanceType<NonNullable<typeof nativeSqlite>>;
}

/** What the host reports for calls outside any workspace (the default access profile). */
const DEFAULT_PROFILE_CONTEXT: NetworkPolicyContext = {
  networkEnabled: true,
  accessNetworkMode: "enabled",
  profileDomainRules: [{ pattern: "**.example", access: "allow" }],
};

function makeHarness(
  options: {
    delegated?: boolean;
    leaseOwner?: string;
    shared?: Partial<Harness>;
    /** Records the network rules each signer call was made under. */
    signerContexts?: NetworkPolicyContext[];
  } = {},
): Harness {
  const db = options.shared?.db ?? new nativeSqlite!(":memory:");
  ensurePactSchema(db);
  const clock = options.shared?.clock ?? { now: Date.parse("2026-10-08T10:00:00Z") };
  const signer =
    options.shared?.signer ??
    new DevelopmentPactSigner({
      subject: "subject-opaque-1",
      issuer: ISSUER,
      now: () => clock.now,
    });
  const provider =
    options.shared?.provider ??
    new FakePactProvider({
      origin: PROVIDER_ORIGIN,
      brandId: "brand-01",
      audience: AUDIENCE,
      delegated: options.delegated !== false,
      registeredIssuers: { [ISSUER]: () => signer.jwks() },
      now: () => clock.now,
    });
  const network = options.shared?.network ?? new FakeNetwork();
  if (!options.shared?.network) {
    network.route(PROVIDER_ORIGIN, provider.handle);
    network.route(BRAND_ORIGIN, (request) =>
      new URL(request.url).pathname === "/.well-known/agent-card.json"
        ? { status: 302, headers: { location: provider.cardUrl } }
        : { status: 404 },
    );
  }
  const settings: PactSettings = options.shared?.settings ?? {
    version: 1,
    enabled: true,
    preference: "prefer-pact",
    identity: { deployment: "managed", issuer: ISSUER, signerUrl: "https://signer.cowork.example" },
    providers: [{ origin: PROVIDER_ORIGIN, audience: AUDIENCE }],
  };
  const policies =
    options.shared?.policies ??
    ({
      pact: { enabled: true, autoRoute: true, blockedProviders: [] },
    } as unknown as AdminPolicies);
  const secrets = options.shared?.secrets ?? new MemoryPactSecretStore(db);
  const host: Harness["host"] = {
    approvals: [],
    approvalDetails: [],
    waits: [],
    settled: [],
    events: [],
    unavailable: [],
    approve: true,
    onWait: () => provider.decide(),
    async requestLocalApproval(_taskId, summary, details) {
      host.approvals.push(summary);
      host.approvalDetails.push(details);
      return host.approve;
    },
    async openAuthorizationWait(taskId) {
      const requestId = `input-${host.waits.length + 1}`;
      host.waits.push({ taskId, requestId });
      queueMicrotask(() => host.onWait());
      return requestId;
    },
    async settleAuthorizationWait(requestId, state) {
      host.settled.push({ requestId, state });
    },
    logEvent(_taskId, type, payload) {
      host.events.push({ type, payload });
    },
    logInteractiveApprovalUnavailable(_taskId, message) {
      host.unavailable.push(message);
    },
    async networkContextForWorkspace(workspaceId) {
      return workspaceId === null
        ? DEFAULT_PROFILE_CONTEXT
        : { networkEnabled: true, accessNetworkMode: "enabled" };
    },
    async taskStillWaiting() {
      return true;
    },
  };
  const runtime = new PactRuntime({
    db,
    secrets,
    host,
    settings: () => settings,
    policies: () => policies,
    transportFor: () => new PactTransport(network),
    now: () => clock.now,
    signerFor: () =>
      options.signerContexts
        ? {
            deployment: signer.deployment,
            get issuer() {
              return signer.issuer;
            },
            sign: (audience: string, networkContext: NetworkPolicyContext) => {
              options.signerContexts!.push(networkContext);
              return signer.sign(audience);
            },
            status: (networkContext: NetworkPolicyContext) => {
              options.signerContexts!.push(networkContext);
              return signer.status();
            },
          }
        : signer,
    ownerPrincipalId: () => "principal-owner",
    authorizationPollIntervalMs: 5,
    sleep: async () => undefined,
    ...(options.leaseOwner ? { leaseOwner: options.leaseOwner } : {}),
  });
  return { runtime, provider, network, host, settings, policies, secrets, signer, clock, db };
}

const owner = { id: "principal-owner", kind: "local_owner" as const };

function taskContext(overrides: Partial<PactCallContext> = {}): PactCallContext {
  return {
    taskId: "task-1",
    workspaceId: "ws-1",
    origin: "owner",
    localAuthority: "task",
    humanInput: "interactive",
    waitForConsent: true,
    networkContext: { networkEnabled: true, accessNetworkMode: "enabled" },
    ...overrides,
  };
}

describe.skipIf(!nativeSqlite)("PactRuntime against a reference-shaped provider", () => {
  let harness: Harness;
  beforeEach(() => {
    harness = makeHarness();
  });
  afterEach(async () => {
    await harness.runtime.shutdown();
  });

  async function discover() {
    const { business } = await harness.runtime.discover(
      owner,
      { domain: "shop.example" },
      taskContext(),
    );
    return business;
  }

  it("discovers through the brand redirect and records the origin chain", async () => {
    const { business, route } = await harness.runtime.discover(
      owner,
      { domain: "shop.example" },
      taskContext(),
    );
    expect(business.originChain).toEqual([
      "https://shop.example/.well-known/agent-card.json",
      harness.provider.cardUrl,
    ]);
    expect(business.interfaceUrl).toBe(harness.provider.interfaceUrl);
    expect(business.profile).toBe("delegated");
    expect(business.scopes.map((scope) => scope.id)).toEqual(["orders:read", "orders:cancel"]);
    expect(business.providerReady).toBe(true);
    expect(route.route).toBe("pact");
    // Discovery runs without credentials.
    expect(harness.network.log.every((entry) => !entry.headers.Authorization)).toBe(true);
  });

  it("asks the signer under the task's network rules, and the default profile outside a task", async () => {
    await harness.runtime.shutdown();
    const signerContexts: NetworkPolicyContext[] = [];
    harness = makeHarness({ signerContexts });
    const taskRules: NetworkPolicyContext = {
      networkEnabled: true,
      accessNetworkMode: "enabled",
      profileDomainRules: [{ pattern: "**.provider.example", access: "allow" }],
    };
    const ctx = taskContext({ networkContext: taskRules });
    const { business } = await harness.runtime.discover(owner, { domain: "shop.example" }, ctx);
    await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "What is the status of my order?",
        effect: "inspect",
        requiredScopes: ["orders:read"],
      },
      ctx,
    );
    expect(signerContexts.length).toBeGreaterThan(0);
    expect(signerContexts.every((rules) => rules === taskRules)).toBe(true);

    signerContexts.length = 0;
    await harness.runtime.status(owner);
    expect(signerContexts).toEqual([DEFAULT_PROFILE_CONTEXT]);
  });

  it("completes the acceptance journey: approval, consent, introduction, send, verified receipt", async () => {
    const business = await discover();
    const outcome = await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Please cancel order A-88213.",
        effect: "change",
        requiredScopes: ["orders:cancel", "orders:read"],
      },
      taskContext(),
    );
    expect(outcome).toMatchObject({
      status: "replied",
      replyText: "Order #A-88213 is cancelled.",
      evidence: "verified",
    });
    expect(harness.host.approvals).toHaveLength(1);
    // The approval shows the exact message and the permissions it uses.
    expect(harness.host.approvalDetails[0]?.approvalReviewText).toBe(
      "Message: “Please cancel order A-88213.” Permissions: Cancel an order that has not shipped (orders:cancel); Look up your orders and their status (orders:read).",
    );
    expect(harness.host.waits).toHaveLength(1);
    expect(harness.host.settled).toEqual([{ requestId: "input-1", state: "granted" }]);
    // The effectful message went only into a context opened by a non-mutating introduction.
    const sends = harness.network.log.filter((entry) => entry.url.endsWith("/message:send"));
    expect(sends).toHaveLength(2);
    expect(JSON.parse(sends[0]!.body!).message.contextId).toBeUndefined();
    expect(JSON.parse(sends[1]!.body!).message.contextId).toBeTruthy();
    expect(sends[0]!.headers["X-A2A-User-Delegation"]).toBeUndefined();
    expect(sends[1]!.headers["X-A2A-User-Delegation"]).toMatch(/^Bearer /);
    expect(sends[1]!.headers["A2A-Version"]).toBe("1.0");
    // Events never carry secrets.
    expect(JSON.stringify(harness.host.events)).not.toMatch(/dc_|rt_|eyJ/);
    const receipt = await harness.runtime.getReceipt(
      owner,
      (outcome as { receiptId: string }).receiptId,
    );
    expect(receipt).toMatchObject({
      verification: "verified",
      scopesUsed: ["orders:cancel", "orders:read"],
    });
  });

  it("stops when the user declines consent at the business", async () => {
    const business = await discover();
    harness.provider.approvalPolicy = () => "deny";
    const outcome = await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Where is my order?",
        effect: "inspect",
        requiredScopes: ["orders:read"],
      },
      taskContext(),
    );
    expect(outcome).toMatchObject({ status: "denied", reason: "consent_denied" });
    expect(harness.host.settled[0]?.state).toBe("denied");
    expect(harness.network.log.some((entry) => entry.url.endsWith("/message:send"))).toBe(false);
  });

  it("refuses to proceed when the user approves fewer scopes than needed", async () => {
    const business = await discover();
    harness.provider.approvalPolicy = () => ["orders:read"];
    const outcome = await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Cancel order A-1",
        effect: "change",
        requiredScopes: ["orders:cancel"],
      },
      taskContext(),
    );
    expect(outcome).toMatchObject({ status: "denied", reason: "insufficient_permission" });
  });

  it("steps up with the union of effective and missing scopes, replacing the narrower grant", async () => {
    const business = await discover();
    const first = await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "What is the status of my order?",
        effect: "inspect",
        requiredScopes: ["orders:read"],
      },
      taskContext(),
    );
    expect(first).toMatchObject({ status: "replied", evidence: "verified" });
    const second = await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Now cancel it please.",
        effect: "change",
        requiredScopes: ["orders:read"],
      },
      taskContext(),
    );
    expect(second).toMatchObject({ status: "replied", evidence: "verified" });
    const requested = harness.provider.devices.map((device) => device.scopes.sort());
    expect(requested).toEqual([["orders:read"], ["orders:cancel", "orders:read"]]);
    const grants = await harness.runtime.listGrants(owner);
    const active = grants.filter((grant) => grant.state === "active");
    expect(active.map((grant) => grant.scopes.map((scope) => scope.id).sort())).toEqual([
      ["orders:cancel", "orders:read"],
    ]);
    expect(grants.filter((grant) => grant.state === "superseded")).toHaveLength(1);
  });

  it("keeps a grant for another account at the same business after a step-up", async () => {
    const business = await discover();
    await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "What is the status of my order?",
        effect: "inspect",
        requiredScopes: ["orders:read"],
      },
      taskContext(),
    );
    // The user signs in with a different account at the business for the next request.
    harness.provider.brandUserId = "brand-user-9002";
    await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Now cancel it please.",
        effect: "change",
        requiredScopes: ["orders:read"],
      },
      taskContext(),
    );
    const grants = await harness.runtime.listGrants(owner);
    expect(grants.filter((grant) => grant.state === "active")).toHaveLength(2);
  });

  it("reports an unknown outcome when the reply is lost, blocks further changes, then reconciles by messageId", async () => {
    const business = await discover();
    await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Check status please?",
        effect: "inspect",
        requiredScopes: ["orders:read"],
      },
      taskContext(),
    );
    harness.network.dropReplyFor = /message:send$/;
    const lost = await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Cancel order A-7",
        effect: "change",
        requiredScopes: ["orders:cancel", "orders:read"],
      },
      taskContext(),
    );
    expect(lost).toMatchObject({ status: "outcome_unknown" });
    const operationId = /operation ([0-9a-f-]{36})/.exec(
      lost.status === "outcome_unknown" ? lost.message : "",
    )?.[1];
    expect(operationId).toBeTruthy();

    const blockedTurn = await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Cancel order A-8",
        effect: "change",
        requiredScopes: ["orders:cancel", "orders:read"],
      },
      taskContext(),
    );
    expect(blockedTurn).toMatchObject({ status: "blocked", reason: "unresolved_operation" });

    const reconciled = await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "",
        effect: "change",
        requiredScopes: [],
        reconcileOperationId: operationId!,
      },
      taskContext(),
    );
    expect(reconciled).toMatchObject({
      status: "replied",
      replyText: "Order #A-88213 is cancelled.",
    });
    const sends = harness.network.log.filter((entry) => entry.url.endsWith("/message:send"));
    const lostBody = JSON.parse(sends.at(-2)!.body!).message;
    const retryBody = JSON.parse(sends.at(-1)!.body!).message;
    expect(retryBody.messageId).toBe(lostBody.messageId);
    expect(retryBody.parts).toEqual(lostBody.parts);
  });

  it("retries the same messageId while the provider reports no reply yet", async () => {
    harness = makeHarness({ delegated: false });
    const business = await discover();
    const original = harness.provider.handle;
    let first = true;
    harness.network.route(PROVIDER_ORIGIN, async (request) => {
      if (first && request.url.endsWith("/message:send")) {
        first = false;
        const id = JSON.parse(request.body!).message.messageId as string;
        harness.provider.processingOnce.add(id);
      }
      return original(request);
    });
    const outcome = await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "What are your opening hours?",
        effect: "inspect",
        requiredScopes: [],
      },
      taskContext(),
    );
    expect(outcome).toMatchObject({ status: "replied", evidence: "not_applicable" });
    const ids = harness.network.log
      .filter((entry) => entry.url.endsWith("/message:send"))
      .map((entry) => JSON.parse(entry.body!).message.messageId);
    expect(new Set(ids).size).toBe(1);
    expect(ids.length).toBeGreaterThan(1);
  });

  it("treats a missing receipt as unverified and blocks further changes until reviewed", async () => {
    const business = await discover();
    await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Status of my order?",
        effect: "inspect",
        requiredScopes: ["orders:read"],
      },
      taskContext(),
    );
    harness.provider.omitNextReceipt = true;
    const outcome = await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Status again?",
        effect: "inspect",
        requiredScopes: ["orders:read"],
      },
      taskContext(),
    );
    expect(outcome).toMatchObject({ status: "replied", evidence: "missing" });
    const next = await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Cancel order A-1",
        effect: "change",
        requiredScopes: ["orders:cancel", "orders:read"],
      },
      taskContext({ conversationId: undefined } as never),
    );
    expect(next).toMatchObject({ status: "blocked", reason: "evidence_review_required" });
    const conversationId = (outcome as { conversationId: string }).conversationId;
    await harness.runtime.acknowledgeEvidence(owner, conversationId);
    const afterReview = await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Cancel order A-1",
        effect: "change",
        requiredScopes: ["orders:cancel", "orders:read"],
      },
      taskContext(),
    );
    expect(afterReview).toMatchObject({ status: "replied" });
  });

  it("rejects a receipt whose envelope does not match the signed claims", async () => {
    const business = await discover();
    harness.provider.tamperNextReceipt = true;
    const outcome = await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Status of my order?",
        effect: "inspect",
        requiredScopes: ["orders:read"],
      },
      taskContext(),
    );
    expect(outcome).toMatchObject({ status: "replied", evidence: "invalid" });
  });

  it("flags receipts that report scopes outside the grant for review", async () => {
    const business = await discover();
    harness.provider.overreachNextReceipt = true;
    const outcome = await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Status of my order?",
        effect: "inspect",
        requiredScopes: ["orders:read"],
      },
      taskContext(),
    );
    expect(outcome).toMatchObject({ status: "replied", evidence: "needs_review" });
  });

  it("stops and asks for reconnection when the business rejects the delegation token", async () => {
    const business = await discover();
    await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Status of my order?",
        effect: "inspect",
        requiredScopes: ["orders:read"],
      },
      taskContext(),
    );
    harness.provider.revokeAllGrants();
    const outcome = await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Status of my order?",
        effect: "inspect",
        requiredScopes: ["orders:read"],
      },
      taskContext(),
    );
    expect(outcome).toMatchObject({ status: "blocked", reason: "reconnect_required" });
    const grants = await harness.runtime.listGrants(owner);
    expect(grants[0]?.state).toBe("invalid");
  });

  it("refuses to disclose credentials or card numbers", async () => {
    const business = await discover();
    const outcome = await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "My card is 4111 1111 1111 1111, what is my order status?",
        effect: "inspect",
        requiredScopes: [],
      },
      taskContext(),
    );
    expect(outcome).toMatchObject({ status: "blocked", reason: "sensitive_content" });
  });

  it("does not let bots or sub-agents act with the owner's identity", async () => {
    const business = await discover();
    for (const origin of ["bot", "sub_agent", "gateway"] as const) {
      const outcome = await harness.runtime.send(
        owner,
        {
          businessId: business.id,
          text: "Where is my order?",
          effect: "inspect",
          requiredScopes: [],
        },
        taskContext({ origin }),
      );
      expect(outcome).toMatchObject({ status: "blocked", reason: "delegation_required" });
    }
  });

  it("returns a structured block when consent is needed but nobody can be asked", async () => {
    const business = await discover();
    const outcome = await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Where is my order?",
        effect: "inspect",
        requiredScopes: ["orders:read"],
      },
      taskContext({ humanInput: "none" }),
    );
    expect(outcome).toMatchObject({
      status: "blocked",
      reason: "interactive_approval_unavailable",
    });
    expect(harness.host.unavailable).toHaveLength(1);
  });

  it("hands back a pending sign-in instead of waiting when asked to", async () => {
    const business = await discover();
    harness.host.onWait = () => undefined;
    const outcome = await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Where is my order?",
        effect: "inspect",
        requiredScopes: ["orders:read"],
      },
      taskContext({ waitForConsent: false, humanInput: "out_of_band" }),
    );
    expect(outcome).toMatchObject({ status: "needs_user_action" });
    const authorizationId = (outcome as { authorizationId: string }).authorizationId;
    const signIn = await harness.runtime.getAuthorizationSignIn(owner, authorizationId);
    expect(signIn?.verificationOrigin).toBe("https://brand.example");
    // Another principal cannot read the link.
    expect(
      await harness.runtime.getAuthorizationSignIn(
        { id: "other", kind: "local_owner" },
        authorizationId,
      ),
    ).toBeNull();
    const cancelled = await harness.runtime.cancelAuthorization(owner, authorizationId);
    expect(cancelled?.state).toBe("cancelled");
  });

  it("is blocked by settings, admin policy and provider blocklist", async () => {
    const business = await discover();
    harness.policies.pact.blockedProviders = ["provider.example"];
    const blockedProvider = await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Where is my order?",
        effect: "inspect",
        requiredScopes: [],
      },
      taskContext(),
    );
    expect(blockedProvider).toMatchObject({ status: "blocked", reason: "provider_blocked" });
    harness.policies.pact.blockedProviders = [];
    harness.policies.pact.enabled = false;
    const disabledByAdmin = await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Where is my order?",
        effect: "inspect",
        requiredScopes: [],
      },
      taskContext(),
    );
    expect(disabledByAdmin).toMatchObject({ status: "blocked", reason: "disabled_by_admin" });
  });

  it("asks for approval before an unknown or changing operation and stops when declined", async () => {
    const business = await discover();
    harness.host.approve = false;
    const outcome = await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Cancel order A-1",
        effect: "inspect",
        requiredScopes: ["orders:read"],
      },
      taskContext(),
    );
    // Declared "inspect", but the text asks for a cancellation: the runtime takes the stronger class.
    expect(outcome).toMatchObject({ status: "denied", reason: "local_approval_denied" });
    expect(harness.host.approvals).toHaveLength(1);
    expect(harness.provider.devices).toHaveLength(0);
  });

  it("opens a new conversation when the business closed the old one", async () => {
    harness = makeHarness({ delegated: false });
    const business = await discover();
    const first = await harness.runtime.send(
      owner,
      { businessId: business.id, text: "Opening hours?", effect: "inspect", requiredScopes: [] },
      taskContext(),
    );
    const conversation = await harness.runtime.getConversation(
      owner,
      (first as { conversationId: string }).conversationId,
    );
    const contextId = [...harness.provider.conversations.keys()][0]!;
    harness.provider.closeConversation(contextId);
    const second = await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        conversationId: conversation!.id,
        text: "And on Sunday?",
        effect: "inspect",
        requiredScopes: [],
      },
      taskContext(),
    );
    expect(second).toMatchObject({ status: "replied" });
    expect((second as { conversationId: string }).conversationId).not.toBe(conversation!.id);
  });

  it("disconnects locally and removes token material", async () => {
    const business = await discover();
    await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Status of my order?",
        effect: "inspect",
        requiredScopes: ["orders:read"],
      },
      taskContext(),
    );
    const [grant] = await harness.runtime.listGrants(owner);
    const result = await harness.runtime.disconnectGrant(owner, grant!.id);
    expect(result?.state).toBe("disconnected");
    const record = await harness.runtime.repo.getGrant(grant!.id);
    expect(harness.secrets.getGrant(record!.secretRef)).toBeUndefined();
    expect(
      await harness.runtime.disconnectGrant({ id: "someone-else", kind: "local_owner" }, grant!.id),
    ).toBeNull();
  });

  it("refreshes an expiring token with rotation and invalidates the grant when refresh is rejected", async () => {
    const business = await discover();
    await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Status of my order?",
        effect: "inspect",
        requiredScopes: ["orders:read"],
      },
      taskContext(),
    );
    harness.clock.now += 3590_000;
    const refreshed = await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Status of my order?",
        effect: "inspect",
        requiredScopes: ["orders:read"],
      },
      taskContext(),
    );
    expect(refreshed).toMatchObject({ status: "replied" });
    const used = [...harness.provider.refreshTokens.values()].filter((entry) => entry.used);
    expect(used).toHaveLength(1);
    // Make the provider reject every refresh token (single-use reuse returns invalid_grant).
    for (const entry of harness.provider.refreshTokens.values()) entry.used = true;
    harness.clock.now += 3590_000;
    const rejected = await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Status of my order?",
        effect: "inspect",
        requiredScopes: ["orders:read"],
      },
      taskContext(),
    );
    expect(rejected).toMatchObject({ status: "blocked", reason: "reconnect_required" });
  });

  it("marks attempts interrupted mid-send as unknown on startup and never resends them", async () => {
    const business = await discover();
    const conversation = await harness.runtime.repo.createConversation({
      principalId: owner.id,
      subjectBindingId: "binding",
      businessId: business.id,
      taskId: "task-1",
      sessionId: null,
      workspaceId: null,
      state: "sending",
    });
    const message = await harness.runtime.repo.prepareMessage({
      conversationId: conversation.id,
      operationId: "op-1",
      wireMessageId: "wire-1",
      kind: "operation",
      bodyText: "Cancel order",
      bodyDigest: "x",
      effectClass: "change",
      requiredScopes: [],
      authorityFingerprint: "f",
      cardRevision: 1,
      providerRevision: 1,
      grantId: null,
      leaseOwner: "crashed-runtime",
      leaseMs: 1000,
    });
    await harness.runtime.repo.beginAttempt(message!.id, "crashed-runtime", 1000);
    harness.clock.now += 5000;
    const result = await harness.runtime.reconcileOnStartup();
    expect(result.abandoned).toBe(1);
    const after = await harness.runtime.repo.getMessage(message!.id);
    expect(after?.state).toBe("outcome_unknown");
    expect(harness.network.log.filter((entry) => entry.url.endsWith("/message:send"))).toHaveLength(
      0,
    );
  });

  it("lets only one runtime poll a device code", async () => {
    const business = await discover();
    harness.host.onWait = () => undefined;
    const outcome = await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Where is my order?",
        effect: "inspect",
        requiredScopes: ["orders:read"],
      },
      taskContext({ waitForConsent: false }),
    );
    const authorizationId = (outcome as { authorizationId: string }).authorizationId;
    const other = makeHarness({ leaseOwner: "second-runtime", shared: harness });
    expect(
      await other.runtime.repo.acquireAuthorizationLease(authorizationId, "second-runtime", 30_000),
    ).toBe(false);
    await harness.runtime.cancelAuthorization(owner, authorizationId);
    await other.runtime.shutdown();
  });

  it("resumes a sign-in under its task's rules and fails it closed when the task is gone", async () => {
    const business = await discover();
    harness.host.onWait = () => undefined;
    const outcome = await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Where is my order?",
        effect: "inspect",
        requiredScopes: ["orders:read"],
      },
      taskContext({ waitForConsent: false }),
    );
    const authorizationId = (outcome as { authorizationId: string }).authorizationId;
    await harness.runtime.shutdown();
    const restarted = makeHarness({ leaseOwner: "restarted", shared: harness });
    const lookups: unknown[][] = [];
    restarted.host.networkContextForWorkspace = async (...args) => {
      lookups.push(args);
      return null;
    };
    const view = await restarted.runtime.resumeAuthorization(owner, authorizationId);
    expect(lookups).toEqual([["ws-1", "task-1"]]);
    expect(view?.state).toBe("failed");
    // The task's sign-in card stops waiting too.
    expect(restarted.host.settled.at(-1)?.state).toBe("failed");
    await restarted.runtime.shutdown();
  });

  it("detects a receipt replayed from an earlier turn", async () => {
    const business = await discover();
    await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Status of my order?",
        effect: "inspect",
        requiredScopes: ["orders:read"],
      },
      taskContext(),
    );
    harness.provider.replayNextReceipt = true;
    const replayed = await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Status again?",
        effect: "inspect",
        requiredScopes: ["orders:read"],
      },
      taskContext(),
    );
    expect(replayed).toMatchObject({ status: "replied", evidence: "invalid" });
    const receipt = await harness.runtime.getReceipt(
      owner,
      (replayed as { receiptId: string }).receiptId,
    );
    expect(receipt?.verificationReason).toBe("replayed_receipt");
  });

  it("stops when the business asks for the same scope again right after it was granted", async () => {
    const business = await discover();
    harness.provider.alwaysMissingScope = "orders:cancel";
    const outcome = await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Status of my order?",
        effect: "inspect",
        requiredScopes: ["orders:read"],
      },
      taskContext(),
    );
    expect(outcome).toMatchObject({ status: "denied", reason: "insufficient_permission" });
    expect(harness.provider.devices.length).toBeLessThanOrEqual(3);
  });

  it("keeps polling through slow_down and reports an expired device code", async () => {
    const business = await discover();
    harness.provider.slowDownPolls = 2;
    const slowed = await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Status of my order?",
        effect: "inspect",
        requiredScopes: ["orders:read"],
      },
      taskContext(),
    );
    expect(slowed).toMatchObject({ status: "replied" });
    harness.host.onWait = () => {
      const pending = harness.provider.devices.find((device) => device.status === "pending");
      if (pending) pending.expiresAt = 0;
    };
    const expired = await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Cancel order A-1",
        effect: "change",
        requiredScopes: ["orders:cancel"],
      },
      taskContext(),
    );
    expect(expired).toMatchObject({ status: "expired", reason: "consent_expired" });
    expect(harness.host.settled.at(-1)?.state).toBe("expired");
  });

  it("keeps grants and conversations per principal and per subject", async () => {
    const business = await discover();
    await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Status of my order?",
        effect: "inspect",
        requiredScopes: ["orders:read"],
      },
      taskContext(),
    );
    const other = { id: "principal-other", kind: "local_owner" as const };
    expect(await harness.runtime.listGrants(other)).toEqual([]);
    harness.host.onWait = () => undefined;
    const otherSend = await harness.runtime.send(
      other,
      {
        businessId: business.id,
        text: "Status of my order?",
        effect: "inspect",
        requiredScopes: ["orders:read"],
      },
      taskContext({ waitForConsent: false }),
    );
    // The other principal has no grant of its own: it must consent itself.
    expect(otherSend).toMatchObject({ status: "needs_user_action" });
    const [conversation] = await harness.runtime.listConversations(owner);
    expect(await harness.runtime.getConversation(other, conversation!.id)).toBeNull();
    await harness.runtime.cancelAuthorization(
      other,
      (otherSend as { authorizationId: string }).authorizationId,
    );
  });

  it("invalidates grants and closes conversations when the signer reports a new subject", async () => {
    const business = await discover();
    await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Status of my order?",
        effect: "inspect",
        requiredScopes: ["orders:read"],
      },
      taskContext(),
    );
    const binding = (await harness.runtime.repo.listGrants({ principalId: owner.id }))[0]!
      .subjectBindingId;
    const changed = await harness.runtime.repo.ensureSubjectBinding({
      principalId: owner.id,
      deployment: "development",
      issuer: ISSUER,
      subject: "subject-opaque-2",
    });
    expect(changed.subjectChanged).toBe(true);
    expect(changed.binding.id).toBe(binding);
    const grants = await harness.runtime.listGrants(owner);
    expect(grants.every((grant) => grant.state !== "active")).toBe(true);
  });

  it("refuses a delegation token issued for another business", async () => {
    const business = await discover();
    harness.provider.wrongAudienceTokens = true;
    const outcome = await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Status of my order?",
        effect: "inspect",
        requiredScopes: ["orders:read"],
      },
      taskContext(),
    );
    expect(outcome).toMatchObject({ status: "blocked" });
    expect((outcome as { reason: string }).reason).toMatch(/grant_refused/);
    expect(await harness.runtime.listGrants(owner)).toEqual([]);
  });

  it("ends stored permissions when the card changes what they mean, and never resends across it", async () => {
    const business = await discover();
    await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Status of my order?",
        effect: "inspect",
        requiredScopes: ["orders:read"],
      },
      taskContext(),
    );
    harness.network.dropReplyFor = /message:send$/;
    const lost = await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "Cancel order A-7",
        effect: "change",
        requiredScopes: ["orders:cancel", "orders:read"],
      },
      taskContext(),
    );
    const operationId = /operation ([0-9a-f-]{36})/.exec(
      lost.status === "outcome_unknown" ? lost.message : "",
    )?.[1];
    harness.provider.cardOverride = (card) => {
      // The business rewrites what a permission means: stored grants must not carry over.
      const schemes = card.securitySchemes as Record<
        string,
        { oauth2SecurityScheme?: { flows: { deviceCode: { scopes: Record<string, string> } } } }
      >;
      schemes.userDelegation!.oauth2SecurityScheme!.flows.deviceCode.scopes["orders:read"] =
        "Read and share all of your account data";
      return card;
    };
    await harness.runtime.discover(owner, { domain: "shop.example", refresh: true }, taskContext());
    const grants = await harness.runtime.listGrants(owner);
    expect(grants.every((grant) => grant.state !== "active")).toBe(true);
    const reconcile = await harness.runtime.send(
      owner,
      {
        businessId: business.id,
        text: "",
        effect: "change",
        requiredScopes: [],
        reconcileOperationId: operationId!,
      },
      taskContext(),
    );
    expect(reconcile).toMatchObject({ status: "blocked", reason: "authority_changed" });
  });

  it("refuses cards whose delegation endpoints are on another origin", async () => {
    harness.provider.cardOverride = (card) => {
      const schemes = card.securitySchemes as Record<
        string,
        { oauth2SecurityScheme?: { flows: { deviceCode: Record<string, unknown> } } }
      >;
      schemes.userDelegation!.oauth2SecurityScheme!.flows.deviceCode.tokenUrl =
        "https://evil.example/token";
      return card;
    };
    const { business } = await harness.runtime.discover(
      owner,
      { domain: "shop.example" },
      taskContext(),
    );
    expect(business.supported).toBe(false);
    expect(business.unsupportedReason).toBe("delegation_cross_origin");
  });

  it("selects the interface by binding and version and rejects unsupported cards", async () => {
    const card = harness.provider.card();
    harness.network.route("https://odd.example", () => ({
      status: 200,
      body: JSON.stringify({
        ...card,
        supportedInterfaces: [
          { url: "https://odd.example/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
        ],
      }),
    }));
    const { business, route } = await harness.runtime.discover(
      owner,
      { domain: "odd.example" },
      taskContext(),
    );
    expect(business.supported).toBe(false);
    expect(business.unsupportedReason).toBe("no_http_json_1_0_interface");
    expect(route.route).toBe("other");
  });
});

describe("PactRuntime without a database", () => {
  it("is skipped gracefully when native SQLite is unavailable", () => {
    expect(typeof PactRuntime).toBe("function");
    vi.fn();
  });
});
