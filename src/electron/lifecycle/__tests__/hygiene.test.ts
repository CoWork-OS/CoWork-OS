import { describe, expect, it } from "vitest";
import type { LifecycleMeta } from "../../../shared/types";
import { projectHygiene, type HygieneSourceItem } from "../hygiene";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000 * DAY;

const meta = (partial: Partial<LifecycleMeta> & Pick<LifecycleMeta, "kind" | "id">) =>
  ({ useCount: 0, dependsOn: [], createdAt: 0, updatedAt: 0, ...partial }) as LifecycleMeta;

function report(items: HygieneSourceItem[], metas: LifecycleMeta[] = [], includeAll = false) {
  return projectHygiene({
    items,
    meta: metas,
    workspaceIds: new Set(["ws-1"]),
    now: NOW,
    includeAll,
  });
}

const byId = (result: ReturnType<typeof report>) =>
  Object.fromEntries(result.items.map((item) => [item.id, item]));

describe("Hygiene projection", () => {
  it("flags items unused for 60 and 90 days, counting uses from both stores", () => {
    const result = byId(
      report(
        [
          { kind: "skill", id: "old", name: "Old", owner: "a", createdAt: NOW - 120 * DAY },
          { kind: "skill", id: "warm", name: "Warm", owner: "a", createdAt: NOW - 70 * DAY },
          { kind: "skill", id: "fresh", name: "Fresh", owner: "a", createdAt: NOW - 200 * DAY },
        ],
        [meta({ kind: "skill", id: "fresh", lastUsedAt: NOW - 5 * DAY, useCount: 3 })],
      ),
    );
    expect(result.old.flags).toEqual(["unused_90"]);
    expect(result.old.idleDays).toBe(120);
    expect(result.warm.flags).toEqual(["unused_60"]);
    expect(result.fresh).toBeUndefined();
  });

  it("judges an automation by its next scheduled run (decision 6)", () => {
    const result = byId(
      report([
        {
          kind: "automation",
          id: "yearly",
          name: "Yearly report",
          owner: "a",
          createdAt: NOW - 400 * DAY,
          lastUsedAt: NOW - 300 * DAY,
          nextRunAt: NOW + 65 * DAY,
        },
        {
          kind: "automation",
          id: "stopped",
          name: "Stopped",
          owner: "a",
          createdAt: NOW - 400 * DAY,
          lastUsedAt: NOW - 100 * DAY,
        },
      ]),
    );
    expect(result.yearly).toBeUndefined();
    expect(result.stopped.flags).toEqual(["unused_90"]);
  });

  it("restarts the idle timer from Keep", () => {
    const items: HygieneSourceItem[] = [
      { kind: "trigger", id: "t", name: "T", owner: "a", createdAt: NOW - 120 * DAY },
    ];
    expect(report(items).items).toHaveLength(1);
    expect(report(items, [meta({ kind: "trigger", id: "t", keptAt: NOW - DAY })]).items).toEqual(
      [],
    );
  });

  it("leaves retired items out and flags what depends on them or on a missing workspace", () => {
    const result = byId(
      report(
        [
          { kind: "skill", id: "retired-skill", name: "Gone", owner: "a", createdAt: NOW },
          { kind: "automation", id: "uses-skill", name: "Uses it", owner: "a", createdAt: NOW },
          {
            kind: "trigger",
            id: "lost-workspace",
            name: "Lost",
            owner: "a",
            createdAt: NOW,
            dependsOn: [{ kind: "workspace", id: "ws-deleted" }],
          },
        ],
        [
          meta({ kind: "skill", id: "retired-skill", retiredAt: NOW - DAY }),
          meta({
            kind: "automation",
            id: "uses-skill",
            dependsOn: [{ kind: "skill", id: "retired-skill" }],
          }),
        ],
      ),
    );
    expect(result["retired-skill"]).toBeUndefined();
    expect(result["uses-skill"].flags).toEqual(["broken_dependency"]);
    expect(result["uses-skill"].brokenDependencies).toEqual([
      { kind: "skill", id: "retired-skill" },
    ]);
    expect(result["lost-workspace"].brokenDependencies).toEqual([
      { kind: "workspace", id: "ws-deleted" },
    ]);
  });

  it("expects an owner only for things that run on their own", () => {
    const result = byId(
      report([
        { kind: "skill", id: "s", name: "S", createdAt: NOW },
        { kind: "automation", id: "a", name: "A", createdAt: NOW },
        { kind: "playbook", id: "p", name: "P", createdAt: NOW },
        { kind: "rule", id: "r", name: "R", createdAt: NOW },
      ]),
    );
    expect(result.s.flags).toEqual(["ownerless"]);
    expect(result.a.flags).toEqual(["ownerless"]);
    expect(result.p).toBeUndefined();
    expect(result.r).toBeUndefined();
  });

  it("proposes retiring a rule unused for 90 days that names no evidence", () => {
    const items: HygieneSourceItem[] = [
      { kind: "rule", id: "bare", name: "Bare rule", createdAt: NOW - 100 * DAY },
      { kind: "rule", id: "backed", name: "Backed rule", createdAt: NOW - 100 * DAY },
    ];
    const result = byId(
      report(items, [meta({ kind: "rule", id: "backed", evidence: "eval:case-12" })]),
    );
    expect(result.bare.flags).toEqual(["unused_90", "rule_without_evidence"]);
    expect(result.backed.flags).toEqual(["unused_90"]);
    expect(result.backed.evidence).toBe("eval:case-12");
  });

  it("lists everything on request, so owners and evidence can be set", () => {
    const items: HygieneSourceItem[] = [{ kind: "playbook", id: "p", name: "P", createdAt: NOW }];
    expect(report(items).items).toEqual([]);
    expect(report(items, [], true).items.map((item) => item.flags)).toEqual([[]]);
  });
});
