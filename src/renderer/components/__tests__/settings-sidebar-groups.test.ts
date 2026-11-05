import { describe, expect, it } from "vitest";

import { groupSettingsSidebarItems, settingsSidebarItems } from "../Settings";

describe("settings sidebar groups", () => {
  it("keeps every group's items together, so each header is followed by its own items", () => {
    const groups = settingsSidebarItems.map((item) => item.group);
    const seen = new Set<string>();
    for (let index = 0; index < groups.length; index += 1) {
      if (index > 0 && groups[index] !== groups[index - 1]) {
        expect(seen.has(groups[index])).toBe(false);
      }
      seen.add(groups[index]);
    }
  });

  it("puts Memory with AI & Models and Skills with Skills & Tools", () => {
    const groupOf = (tab: string) => settingsSidebarItems.find((item) => item.tab === tab)?.group;
    const tabsInGroup = (group: string) =>
      settingsSidebarItems.filter((item) => item.group === group).map((item) => item.tab);

    expect(groupOf("memory")).toBe("AI & Models");
    expect(tabsInGroup("AI & Models")).toEqual(["aimodels", "jev", "memory"]);
    expect(tabsInGroup("Skills & Tools")).toEqual([
      "addtools",
      "customize",
      "skills",
      "mcp",
      "tools",
    ]);
  });

  it("keeps first-seen group order and item order inside a group", () => {
    expect(
      groupSettingsSidebarItems([
        { group: "A", id: 1 },
        { group: "B", id: 2 },
        { group: "A", id: 3 },
        { group: "C", id: 4 },
        { group: "B", id: 5 },
      ]).map((item) => item.id),
    ).toEqual([1, 3, 2, 5, 4]);
  });
});
