import { beforeEach, describe, expect, it, vi } from "vitest";

const policyState = { enabled: true, autoRoute: true, blockedProviders: [] as string[] };
vi.mock("../../../admin/policies", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../admin/policies")>()),
  getPactPolicy: () => policyState,
}));
const inlineState = { interactive: true };
vi.mock("../../approval-policy", () => ({
  canAnswerInlineApproval: () => inlineState.interactive,
}));

import { PactSettingsManager } from "../../../pact/settings";
import { evaluateToolAvailability, evaluateToolPolicy } from "../../tool-policy-engine";
import { PactTools } from "../pact-tools";

function makeDaemon(task: Record<string, unknown>) {
  const runtime = {
    ownerPrincipal: vi.fn(async (actor?: string) => ({ id: "owner", kind: "local_owner", actor })),
    send: vi.fn(),
    discover: vi.fn(),
    getConversation: vi.fn(),
    repo: {
      getBusiness: vi.fn(async () => ({
        interfaceUrl: "https://p.example/a2a/x",
        originChain: ["https://x.example/card"],
      })),
    },
  };
  const daemon = {
    recordSensitiveSourceRead: vi.fn(),
    getTask: () => task,
    getEffectiveWorkspaceForTask: () => ({
      id: "ws",
      permissions: { network: true, accessNetworkMode: "enabled", accessDomainRules: [] },
    }),
    getPactRuntime: () => runtime,
  };
  return { daemon, runtime };
}

const workspace = { id: "ws", permissions: { network: true } } as never;

describe("PACT tools", () => {
  beforeEach(() => {
    policyState.autoRoute = true;
    inlineState.interactive = true;
    PactSettingsManager.setRepositoryForTesting(null);
  });

  it("declares explicit runtime metadata that keeps runtime approval and plan-mode gates", () => {
    const { daemon } = makeDaemon({ id: "t" });
    const tools = new PactTools(workspace, daemon as never, "t").getToolDefinitions();
    expect(tools.map((tool) => tool.name)).toEqual([
      "pact_discover",
      "pact_send_message",
      "pact_get_conversation",
    ]);
    const send = tools.find((tool) => tool.name === "pact_send_message")!;
    expect(send.runtime).toMatchObject({
      readOnly: false,
      sideEffectLevel: "high",
      approvalKind: "external_service",
      concurrencyClass: "exclusive",
      capabilityTags: ["business", "integration"],
    });
    expect(send.runtime?.approvalKind).not.toBe("workspace_policy");
    expect(evaluateToolPolicy("pact_send_message", { executionMode: "plan" }).decision).toBe(
      "deny",
    );
    expect(evaluateToolPolicy("pact_send_message", { executionMode: "analyze" }).decision).toBe(
      "deny",
    );
    expect(evaluateToolPolicy("pact_discover", { executionMode: "plan" }).decision).toBe("allow");
  });

  it("is offered for business interactions without the user naming PACT, and only by name when auto-routing is off", () => {
    const { daemon } = makeDaemon({ id: "t" });
    const send = () =>
      new PactTools(workspace, daemon as never, "t")
        .getToolDefinitions()
        .find((tool) => tool.name === "pact_send_message")!;
    const runtime = send().runtime;
    expect(
      evaluateToolAvailability(
        "pact_send_message",
        { taskText: "Please cancel my order from Acme" },
        runtime,
      ).decision,
    ).toBe("allow");
    expect(
      evaluateToolAvailability(
        "pact_send_message",
        { taskText: "Contact the airline about my flight" },
        runtime,
      ).decision,
    ).toBe("allow");
    expect(
      evaluateToolAvailability(
        "pact_send_message",
        { taskText: "Write a haiku about autumn" },
        runtime,
      ).decision,
    ).toBe("defer");
    for (const coding of [
      "Update the plan and close the ticket",
      "Fix the account settings page",
      "Refactor the policy module",
    ]) {
      expect(
        evaluateToolAvailability("pact_send_message", { taskText: coding }, runtime).decision,
      ).toBe("defer");
    }
    policyState.autoRoute = false;
    const explicit = send().runtime;
    expect(explicit?.exposure).toBe("explicit_only");
    expect(
      evaluateToolAvailability(
        "pact_send_message",
        { taskText: "Please cancel my order from Acme" },
        explicit,
      ).decision,
    ).toBe("defer");
    expect(
      evaluateToolAvailability(
        "pact_send_message",
        { taskText: "Use PACT to cancel my order" },
        explicit,
      ).decision,
    ).toBe("allow");
  });

  it.each([
    [{ id: "t", parentTaskId: "p" }, "sub_agent", "none"],
    [{ id: "t", agentConfig: { gatewayContext: { channelType: "slack" } } }, "gateway", "none"],
    [{ id: "t", agentConfig: { cli: { owner: "cowork-run" } } }, "owner_cli", "out_of_band"],
    [{ id: "t" }, "owner", "interactive"],
  ])("derives the call origin from the task record (%o)", async (task, origin, humanInput) => {
    inlineState.interactive = origin === "owner";
    const { daemon, runtime } = makeDaemon(task);
    runtime.send.mockResolvedValue({ status: "blocked", reason: "x", message: "m" });
    await new PactTools(workspace, daemon as never, "t").sendMessage({
      business_id: "b",
      message: "Where is my order?",
      effect: "inspect",
    });
    const ctx = runtime.send.mock.calls[0]![2];
    expect(ctx).toMatchObject({ origin, humanInput, localAuthority: "task", taskId: "t" });
    expect(ctx.waitForConsent).toBe(humanInput !== "none");
  });

  it("never hands the model a sign-in link, token or code", async () => {
    const { daemon, runtime } = makeDaemon({ id: "t" });
    runtime.send.mockResolvedValue({
      status: "needs_user_action",
      conversationId: "c",
      authorizationId: "a",
      scopes: [{ id: "orders:read", description: "Look up orders" }],
      message: "Sign in with Shop and approve access to continue.",
    });
    const result = await new PactTools(workspace, daemon as never, "t").sendMessage({
      business_id: "b",
      message: "Where is my order?",
      effect: "inspect",
      required_scopes: ["orders:read"],
    });
    expect(JSON.stringify(result)).not.toMatch(/https?:|device|user_code/i);
    expect(result).toMatchObject({ status: "needs_user_action" });
  });

  it("supplies the verified interface URL as the approval destination", async () => {
    const { daemon } = makeDaemon({ id: "t" });
    const tools = new PactTools(workspace, daemon as never, "t");
    await expect(
      tools.approvalDestination("pact_send_message", { business_id: "b" }),
    ).resolves.toMatchObject({
      permissionInput: { url: "https://p.example/a2a/x" },
    });
    await expect(
      tools.approvalDestination("pact_discover", { domain: "shop.example" }),
    ).resolves.toMatchObject({
      permissionInput: { url: "https://shop.example/.well-known/agent-card.json" },
    });
  });

  it("validates input before reaching the runtime", async () => {
    const { daemon, runtime } = makeDaemon({ id: "t" });
    const tools = new PactTools(workspace, daemon as never, "t");
    await expect(tools.sendMessage({ message: "hi" })).resolves.toMatchObject({ success: false });
    await expect(tools.discover({})).resolves.toMatchObject({ success: false });
    expect(runtime.send).not.toHaveBeenCalled();
  });

  it("is offered only to the owner's own top-level tasks", () => {
    expect(
      new PactTools(workspace, makeDaemon({ id: "t" }).daemon as never, "t").offeredToTask(),
    ).toBe(true);
    expect(
      new PactTools(
        workspace,
        makeDaemon({ id: "t", parentTaskId: "p" }).daemon as never,
        "t",
      ).offeredToTask(),
    ).toBe(false);
    expect(
      new PactTools(
        workspace,
        makeDaemon({ id: "t", agentConfig: { gatewayContext: { channelType: "slack" } } })
          .daemon as never,
        "t",
      ).offeredToTask(),
    ).toBe(false);
  });

  it("redacts and caps business replies and marks them untrusted", async () => {
    const { daemon, runtime } = makeDaemon({ id: "t" });
    runtime.send.mockResolvedValue({
      status: "replied",
      conversationId: "c",
      turnId: "m",
      replyText: `Use Bearer abc.def.ghi to log in. ${"x".repeat(9000)}`,
      evidence: "verified",
    });
    const result = (await new PactTools(workspace, daemon as never, "t").sendMessage({
      business_id: "b",
      message: "Where is my order?",
      effect: "inspect",
    })) as { reply: string };
    expect(result.reply).not.toContain("abc.def.ghi");
    expect(result.reply.length).toBeLessThan(8_200);
    expect(result.reply).toMatch(/reply truncated/);
    expect(daemon.recordSensitiveSourceRead).toHaveBeenCalledWith(
      "t",
      expect.objectContaining({ path: "business://https://p.example", trustLevel: "untrusted" }),
    );
  });

  it("returns stored conversations safely and reports lookup failures without leaking", async () => {
    const { daemon, runtime } = makeDaemon({ id: "t" });
    runtime.getConversation.mockResolvedValue({
      id: "c",
      businessId: "b",
      businessName: "Shop",
      state: "replied",
      turns: [
        {
          operationId: "op",
          text: "hi",
          state: "replied",
          effectClass: "inspect",
          replyText: "eyJabcde.eyJfghij.sig",
          evidence: "verified",
        },
      ],
    });
    const tools = new PactTools(workspace, daemon as never, "t");
    const view = (await tools.getConversation({ conversation_id: "c" })) as {
      turns: { reply: string }[];
    };
    expect(view.turns[0]!.reply).not.toContain("eyJabcde");
    runtime.getConversation.mockRejectedValue(
      new Error("db failed with Bearer secret-token-value"),
    );
    const failed = (await tools.getConversation({ conversation_id: "c" })) as { error: string };
    expect(failed.error).not.toContain("secret-token-value");
  });

  it("passes the abort signal to discovery", async () => {
    const { daemon, runtime } = makeDaemon({ id: "t" });
    runtime.discover.mockResolvedValue({
      business: {
        id: "b",
        displayName: "Shop",
        originChain: ["https://shop.example/.well-known/agent-card.json"],
        providerOrigin: "https://p.example",
        supported: true,
        profile: "identity",
        scopes: [],
        skills: [],
      },
      route: { route: "pact", reason: "supported" },
    });
    const controller = new AbortController();
    await new PactTools(workspace, daemon as never, "t").discover(
      { domain: "shop.example" },
      controller.signal,
    );
    expect(runtime.discover.mock.calls[0]![2].signal).toBe(controller.signal);
  });
});
