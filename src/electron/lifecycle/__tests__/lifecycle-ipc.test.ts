import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  meta: [] as Any[],
  calls: [] as Array<[string, ...unknown[]]>,
}));

vi.mock("../../agent/custom-skill-loader", () => ({
  getCustomSkillLoader: () => ({
    listSkills: () => [
      { id: "my-skill", name: "My skill", source: "managed", metadata: { author: "Almarion" } },
      { id: "bundled-skill", name: "Bundled", source: "bundled" },
    ],
    updateSkill: async (id: string, updates: unknown) => {
      state.calls.push(["updateSkill", id, updates]);
      return {};
    },
  }),
}));

vi.mock("../../memory/MemoryWriter", () => ({
  MemoryWriter: {
    get: () => ({
      setStatus: async (id: string, status: string) => {
        state.calls.push(["setStatus", id, status]);
      },
      repository: {
        list: async () => [
          {
            id: "rule-1",
            content: "Always attach the invoice PDF",
            workspaceId: "ws-1",
            source: "user_stated",
            createdAt: 1,
            lastUsedAt: null,
            reinforcedCount: 2,
          },
        ],
      },
    }),
  },
}));

vi.mock("../../memory/PlaybookService", () => ({
  PlaybookService: {
    listEntries: async () => [
      {
        id: "entry-1",
        title: "Monthly close",
        workspaceId: "ws-1",
        status: "active",
        createdAt: 1,
      },
    ],
  },
}));

vi.mock("../../database/repository-facades", () => ({
  WorkspaceRepository: class {
    async findAll() {
      return [{ id: "ws-1" }];
    }
  },
  LifecycleMetaRepository: class {
    async list() {
      return state.meta;
    }
    async retire(input: unknown) {
      state.calls.push(["retire", input]);
    }
    async keep(input: unknown) {
      state.calls.push(["keep", input]);
    }
    async setMeta(input: unknown) {
      state.calls.push(["setMeta", input]);
      return input;
    }
  },
}));

import { IPC_CHANNELS } from "../../../shared/types";
import { buildHygieneReport, registerLifecycleIpc } from "../lifecycle-ipc";

function setup() {
  const handlers = new Map<string, (event: unknown, data: unknown) => Promise<Any>>();
  const cron = {
    list: async () => [
      {
        id: "job-1",
        name: "Nightly digest",
        enabled: true,
        workspaceId: "ws-gone",
        createdAtMs: 1,
        state: { lastRunAtMs: 5, totalRuns: 3 },
      },
    ],
    update: vi.fn(async () => ({})),
  };
  const triggers = {
    listTriggers: () => [
      { id: "trigger-1", name: "On PR", workspaceId: "ws-1", fireCount: 0, createdAt: 1 },
    ],
    updateTrigger: vi.fn(async () => ({})),
  };
  const deps = {
    ipcMain: { handle: (channel: string, handler: Any) => handlers.set(channel, handler) },
    getDatabase: () => ({}) as Any,
    getCronService: () => cron,
    getTriggerService: () => triggers,
  };
  registerLifecycleIpc(deps);
  const call = (channel: string, data?: unknown) => handlers.get(channel)!({}, data);
  return { deps, cron, triggers, call };
}

describe("lifecycle IPC", () => {
  beforeEach(() => {
    state.meta = [];
    state.calls = [];
  });

  it("collects user skills, playbooks, automations, triggers and rules; never bundled skills", async () => {
    const { deps } = setup();
    const report = await buildHygieneReport(deps, { includeAll: true, now: 10 });
    expect(report.items.map((item) => `${item.kind}:${item.id}`).sort()).toEqual([
      "automation:job-1",
      "playbook:entry-1",
      "rule:rule-1",
      "skill:my-skill",
      "trigger:trigger-1",
    ]);
    const byKey = Object.fromEntries(report.items.map((item) => [item.id, item]));
    expect(byKey["my-skill"].owner).toBe("Almarion");
    expect(byKey["rule-1"].owner).toBe("you");
    expect(byKey["job-1"].flags).toEqual(["ownerless", "broken_dependency"]);
    expect(byKey["job-1"].useCount).toBe(3);
  });

  it("retires each kind in its own store, then marks it retired; nothing is deleted", async () => {
    const { call, cron, triggers } = setup();
    for (const [kind, id] of [
      ["skill", "my-skill"],
      ["automation", "job-1"],
      ["trigger", "trigger-1"],
      ["rule", "rule-1"],
      ["playbook", "entry-1"],
    ]) {
      expect(await call(IPC_CHANNELS.LIFECYCLE_RETIRE, { kind, id })).toEqual({ success: true });
    }
    expect(cron.update).toHaveBeenCalledWith("job-1", { enabled: false });
    expect(triggers.updateTrigger).toHaveBeenCalledWith("trigger-1", { enabled: false });
    expect(state.calls).toEqual(
      expect.arrayContaining([
        ["updateSkill", "my-skill", { enabled: false }],
        ["setStatus", "rule-1", "archived"],
        ["retire", expect.objectContaining({ kind: "playbook", id: "entry-1" })],
      ]),
    );
    expect(state.calls.filter(([name]) => name === "retire")).toHaveLength(5);
  });

  it("validates renderer input", async () => {
    const { call } = setup();
    expect(await call(IPC_CHANNELS.LIFECYCLE_RETIRE, { kind: "artifact", id: "x" })).toEqual({
      success: false,
      error: "Unknown item.",
    });
    expect(await call(IPC_CHANNELS.LIFECYCLE_KEEP, { kind: "skill", id: "" })).toMatchObject({
      success: false,
    });
    expect(
      await call(IPC_CHANNELS.LIFECYCLE_SET_META, { kind: "skill", id: "s", evidence: "eval:1" }),
    ).toMatchObject({ success: false });
    expect(
      await call(IPC_CHANNELS.LIFECYCLE_SET_META, {
        kind: "rule",
        id: "rule-1",
        dependsOn: [{ kind: "nonsense", id: "x" }],
      }),
    ).toEqual({ success: false, error: "Invalid dependencies." });
    expect(
      await call(IPC_CHANNELS.LIFECYCLE_SET_META, {
        kind: "rule",
        id: "rule-1",
        owner: "Almarion",
        evidence: "eval:invoice-pdf",
      }),
    ).toMatchObject({ success: true });
    expect(state.calls.filter(([name]) => name === "retire")).toHaveLength(0);
  });
});
