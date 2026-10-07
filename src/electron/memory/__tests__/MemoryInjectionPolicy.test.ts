import { describe, expect, it } from "vitest";
import {
  DefaultMemoryInjectionPolicy,
  memoryItemAllowed,
  memoryPolicyInputForTask,
  resolveMemoryInjection,
  type MemoryInjectionPolicyInput,
} from "../MemoryInjectionPolicy";
import type { MemoryItem } from "../memory-items-types";

const GATEWAYS = ["private", "group", "public"] as const;
const RETAIN = [undefined, true, false] as const;
const SUB_AGENT = [false, true] as const;
const PRIVACY = ["normal", "strict", "disabled"] as const;
const NO_MEMORY = [false, true] as const;
const TRUSTED_SHARED = [false, true] as const;

describe("resolveMemoryInjection matrix", () => {
  const cases: Array<MemoryInjectionPolicyInput & { label: string }> = [];
  for (const gatewayContext of GATEWAYS)
    for (const retainMemory of RETAIN)
      for (const isSubAgent of SUB_AGENT)
        for (const privacyMode of PRIVACY)
          for (const noMemory of NO_MEMORY)
            for (const allowSharedContextMemory of TRUSTED_SHARED)
              cases.push({
                label: `${gatewayContext}/retain=${retainMemory}/sub=${isSubAgent}/${privacyMode}/noMemory=${noMemory}/trusted=${allowSharedContextMemory}`,
                gatewayContext,
                retainMemory,
                isSubAgent,
                noMemory,
                allowSharedContextMemory,
                workspaceSettings: { enabled: true, privacyMode },
                contextPackInjectionEnabled: true,
                workspaceCanRead: true,
                externalNetworkAllowed: true,
              });

  it.each(cases)("$label", (input) => {
    const decision = resolveMemoryInjection(input);
    const retained = input.retainMemory ?? !input.isSubAgent;
    const channelOk = input.gatewayContext === "private" || input.allowSharedContextMemory === true;
    const memoryOn =
      !input.noMemory &&
      retained &&
      channelOk &&
      input.workspaceSettings?.privacyMode !== "disabled";

    expect(decision.layers.l0).toBe(memoryOn);
    expect(decision.layers.l1).toBe(memoryOn);
    expect(decision.layers.external).toBe(memoryOn);
    expect(decision.memory).toBe(memoryOn);
    // Private items: only the user's own private conversation, never a sub-agent.
    expect(decision.allowPrivateItems).toBe(
      memoryOn && input.gatewayContext === "private" && !input.isSubAgent,
    );
    // The kit slice (USER.md / MEMORY.md) is private-gateway only.
    expect(decision.layers.workspaceKit).toBe(memoryOn && input.gatewayContext === "private");
    // Shared kit context ignores the workspace memory switch but not the channel or opt-outs.
    expect(decision.layers.sharedContext).toBe(!input.noMemory && retained && channelOk);
    // Project guidance is not memory.
    expect(decision.layers.projectGuidance).toBe(input.gatewayContext === "private");
    // The memory folder is off unless its setting is on (not passed here).
    expect(decision.layers.memoryRepo).toBe(false);
    expect(resolveMemoryInjection({ ...input, memoryRepoEnabled: true }).layers.memoryRepo).toBe(
      !input.noMemory &&
        retained &&
        !input.isSubAgent &&
        input.gatewayContext === "private" &&
        input.workspaceSettings?.privacyMode !== "disabled",
    );
    if (!memoryOn) expect(decision.reasons.l0).toBeDefined();
  });
});

describe("resolveMemoryInjection details", () => {
  it("names the first reason a layer is off", () => {
    expect(resolveMemoryInjection({ noMemory: true }).reasons.l0).toBe("no_memory_directive");
    expect(resolveMemoryInjection({ gatewayContext: "group" }).reasons.l0).toBe("group_channel");
    expect(resolveMemoryInjection({ isSubAgent: true }).reasons.l0).toBe("scope_mismatch");
    expect(resolveMemoryInjection({ workspaceSettings: { enabled: false } }).reasons.l0).toBe(
      "memory_off",
    );
  });

  it("keeps verifiers out of personal memory even with retainMemory", () => {
    const decision = resolveMemoryInjection({ retainMemory: true, workerRole: "verifier" });
    expect(decision.memory).toBe(false);
    expect(decision.layers.sharedContext).toBe(false);
  });

  it("turns the external provider off without network access only", () => {
    const decision = resolveMemoryInjection({ externalNetworkAllowed: false });
    expect(decision.layers.external).toBe(false);
    expect(decision.layers.l0).toBe(true);
  });

  it("drops file layers without read access or the context pack", () => {
    const noRead = resolveMemoryInjection({ workspaceCanRead: false });
    expect(noRead.layers.workspaceKit || noRead.layers.projectGuidance).toBe(false);
    expect(noRead.layers.l0).toBe(true);
    const noPack = resolveMemoryInjection({ contextPackInjectionEnabled: false });
    expect(noPack.layers.sharedContext || noPack.layers.workspaceKit).toBe(false);
  });

  it("gates the memory folder block (design §6.2)", () => {
    const on = { memoryRepoEnabled: true } as const;
    expect(resolveMemoryInjection(on).layers.memoryRepo).toBe(true);
    expect(resolveMemoryInjection({}).reasons.memoryRepo).toBe("memory_off");
    expect(resolveMemoryInjection({ ...on, noMemory: true }).reasons.memoryRepo).toBe(
      "no_memory_directive",
    );
    // Never in group/public channels, even with trusted shared context.
    const trustedGroup = resolveMemoryInjection({
      ...on,
      gatewayContext: "group",
      allowSharedContextMemory: true,
    });
    expect(trustedGroup.layers.l0).toBe(true);
    expect(trustedGroup.layers.memoryRepo).toBe(false);
    expect(trustedGroup.reasons.memoryRepo).toBe("group_channel");
    // Never a sub-agent, even with retainMemory, never a verifier.
    expect(
      resolveMemoryInjection({ ...on, isSubAgent: true, retainMemory: true }).layers.memoryRepo,
    ).toBe(false);
    expect(
      resolveMemoryInjection({ ...on, retainMemory: true, workerRole: "verifier" }).layers
        .memoryRepo,
    ).toBe(false);
    expect(resolveMemoryInjection({ ...on, retainMemory: false }).layers.memoryRepo).toBe(false);
    expect(
      resolveMemoryInjection({ ...on, workspaceSettings: { enabled: false } }).reasons.memoryRepo,
    ).toBe("memory_off");
    // The repo is outside the workspace: no read access or context pack needed.
    expect(
      resolveMemoryInjection({
        ...on,
        workspaceCanRead: false,
        contextPackInjectionEnabled: false,
      }).layers.memoryRepo,
    ).toBe(true);
  });

  it("gates swarm notes (phase 5 §2): sub-agents and verifiers included", () => {
    const on = { memoryRepoEnabled: true, swarmAvailable: true } as const;
    expect(resolveMemoryInjection(on).layers.swarm).toBe(true);
    expect(resolveMemoryInjection({ memoryRepoEnabled: true }).reasons.swarm).toBe(
      "scope_mismatch",
    );
    expect(resolveMemoryInjection({ swarmAvailable: true }).reasons.swarm).toBe("memory_off");
    const sub = resolveMemoryInjection({ ...on, isSubAgent: true, retainMemory: false });
    expect(sub.layers.swarm).toBe(true);
    expect(sub.layers.memoryRepo).toBe(false);
    expect(
      resolveMemoryInjection({ ...on, isSubAgent: true, workerRole: "verifier" }).layers.swarm,
    ).toBe(true);
    expect(resolveMemoryInjection({ ...on, noMemory: true }).reasons.swarm).toBe(
      "no_memory_directive",
    );
    expect(
      resolveMemoryInjection({ ...on, gatewayContext: "group", allowSharedContextMemory: true })
        .reasons.swarm,
    ).toBe("group_channel");
    expect(
      resolveMemoryInjection({
        ...on,
        workspaceSettings: { enabled: true, privacyMode: "disabled" },
      }).reasons.swarm,
    ).toBe("memory_off");
  });

  it("reports curated items as disallowed when curated memory is off", () => {
    expect(resolveMemoryInjection({ curatedMemoryEnabled: false }).allowCuratedItems).toBe(false);
  });
});

describe("memoryPolicyInputForTask", () => {
  it("derives sub-agent, gateway and <no-memory> from the task and the message", () => {
    const input = memoryPolicyInputForTask(
      {
        parentTaskId: "parent",
        prompt: "do it",
        agentConfig: { gatewayContext: "group", allowSharedContextMemory: true },
      },
      { message: "and <no-memory> please" },
    );
    expect(input).toMatchObject({
      isSubAgent: true,
      gatewayContext: "group",
      allowSharedContextMemory: true,
      noMemory: true,
    });
    expect(memoryPolicyInputForTask({ rawPrompt: "<no-memory> x" }).noMemory).toBe(true);
  });
});

function item(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: "i1",
    workspaceId: null,
    scope: "global",
    scopeRef: null,
    kind: "preference",
    subjectKey: "preference:0123456789abcdef",
    content: "Prefers tea",
    source: "user_stated",
    sourceRef: {},
    trust: 1,
    confidence: 1,
    status: "active",
    pinned: false,
    reinforcedCount: 0,
    lastUsedAt: null,
    supersedesId: null,
    contentHash: "h",
    privacy: "normal",
    taskId: null,
    expiresAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("memoryItemAllowed", () => {
  const privateDecision = resolveMemoryInjection({});
  const sharedDecision = resolveMemoryInjection({
    gatewayContext: "group",
    allowSharedContextMemory: true,
  });

  it("refuses third-party and contact items outside their contact's surface", () => {
    expect(memoryItemAllowed(item({ source: "third_party" }), privateDecision).reason).toBe(
      "third_party_item",
    );
    const contact = item({ scope: "contact", scopeRef: "c1", source: "third_party" });
    expect(memoryItemAllowed(contact, privateDecision).allowed).toBe(false);
    expect(memoryItemAllowed(contact, privateDecision, { contactRef: "c1" }).allowed).toBe(true);
  });

  it("allows private items only where the decision does", () => {
    const privateItem = item({ privacy: "private" });
    expect(memoryItemAllowed(privateItem, privateDecision).allowed).toBe(true);
    expect(memoryItemAllowed(privateItem, sharedDecision).reason).toBe("private_item");
  });

  it("refuses other workspaces' items, other tasks' items and closed items", () => {
    const ws = item({ scope: "workspace", workspaceId: "ws-2" });
    expect(memoryItemAllowed(ws, privateDecision, { workspaceId: "ws-1" }).allowed).toBe(false);
    const task = item({ scope: "task", scopeRef: "t2", workspaceId: "ws-1" });
    expect(memoryItemAllowed(task, privateDecision, { taskId: "t1" }).allowed).toBe(false);
    expect(memoryItemAllowed(item({ status: "superseded" }), privateDecision).allowed).toBe(false);
  });

  it("refuses curated items when curated memory is off", () => {
    const decision = resolveMemoryInjection({ curatedMemoryEnabled: false });
    expect(memoryItemAllowed(item({ source: "curated" }), decision).allowed).toBe(false);
  });
});

describe("DefaultMemoryInjectionPolicy (contract)", () => {
  it("refuses group channels, <no-memory> and memory-off workspaces", async () => {
    const policy = new DefaultMemoryInjectionPolicy({
      loadWorkspaceSettings: async (id) =>
        id === "off" ? { enabled: false, privacyMode: "normal" } : { enabled: true },
    });
    expect(await policy.surfaceAllowed({ workspaceId: "ws", surface: "step" })).toEqual({
      allowed: true,
    });
    expect(
      (await policy.surfaceAllowed({ workspaceId: "ws", surface: "channel_group" })).reason,
    ).toBe("group_channel");
    expect(
      (await policy.surfaceAllowed({ workspaceId: "ws", surface: "chat", noMemory: true })).reason,
    ).toBe("no_memory_directive");
    expect((await policy.surfaceAllowed({ workspaceId: "off", surface: "chat" })).reason).toBe(
      "memory_off",
    );
    expect(
      policy.itemAllowed(item({ privacy: "private" }), { workspaceId: "ws", surface: "chat" })
        .allowed,
    ).toBe(true);
    expect(policy.itemAllowed(item(), { workspaceId: "ws", surface: "channel_group" }).reason).toBe(
      "group_channel",
    );
  });
});

describe("channel caller memory authority", () => {
  it.each([false, undefined])("denies owner layers for a non-owner or legacy DM (%s)", (owner) => {
    const decision = resolveMemoryInjection(
      memoryPolicyInputForTask({
        agentConfig: {
          originChannel: "telegram",
          gatewayContext: "private",
          gatewaySenderIsOwner: owner,
          allowSharedContextMemory: true,
        },
      }),
    );
    expect(decision.memory).toBe(false);
    expect(decision.allowPrivateItems).toBe(false);
    // Every owner layer is off, including layers added later.
    expect(Object.entries(decision.layers).filter(([, enabled]) => enabled)).toEqual([]);
    expect(memoryItemAllowed(item(), decision).allowed).toBe(false);
  });
  it("keeps local and verified-owner DM memory", () => {
    for (const agentConfig of [
      undefined,
      { originChannel: "telegram", gatewayContext: "private" as const, gatewaySenderIsOwner: true },
    ]) {
      const decision = resolveMemoryInjection(memoryPolicyInputForTask({ agentConfig }));
      expect(decision.memory).toBe(true);
      expect(decision.layers.workspaceKit).toBe(true);
      expect(decision.allowPrivateItems).toBe(true);
    }
  });
  it("preserves explicit shared group grants while excluding private items and owner kit files", () => {
    const decision = resolveMemoryInjection(
      memoryPolicyInputForTask({
        agentConfig: {
          originChannel: "slack",
          gatewayContext: "group",
          gatewaySenderIsOwner: false,
          allowSharedContextMemory: true,
        },
      }),
    );
    expect(decision.memory).toBe(true);
    expect(decision.allowPrivateItems).toBe(false);
    expect(decision.layers.workspaceKit).toBe(false);
    expect(memoryItemAllowed(item({ privacy: "private" }), decision).allowed).toBe(false);
  });
});

describe("surface contract caller authority", () => {
  it.each([false, undefined])(
    "denies unattributed private-channel surfaces (%s)",
    async (owner) => {
      const policy = new DefaultMemoryInjectionPolicy();
      const context = {
        workspaceId: "ws",
        surface: "channel_private" as const,
        gatewaySenderIsOwner: owner,
      };
      expect((await policy.surfaceAllowed(context)).allowed).toBe(false);
      expect(policy.itemAllowed(item(), context).allowed).toBe(false);
      expect(policy.itemAllowed(item({ privacy: "private" }), context).allowed).toBe(false);
    },
  );
  it("admits a positively identified owner's private channel", async () => {
    const policy = new DefaultMemoryInjectionPolicy();
    const context = {
      workspaceId: "ws",
      surface: "channel_private" as const,
      gatewaySenderIsOwner: true,
    };
    expect((await policy.surfaceAllowed(context)).allowed).toBe(true);
    expect(policy.itemAllowed(item({ privacy: "private" }), context).allowed).toBe(true);
  });
});
