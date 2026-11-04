import { describe, expect, it } from "vitest";

import { findSettingsSidebarSearchEntry, sidebarSearchEntries } from "../Settings";

describe("settings sidebar search entries", () => {
  it("routes feature pack terms to Customize, not Integrations", () => {
    const customizeTerms = (sidebarSearchEntries.customize ?? []).flatMap((entry) => entry.terms);
    const integrationTerms = (sidebarSearchEntries.integrations ?? []).flatMap(
      (entry) => entry.terms,
    );

    expect(customizeTerms).toEqual(
      expect.arrayContaining(["feature packs", "plugin packs", "customize"]),
    );
    expect(integrationTerms).not.toContain("feature packs");
    expect(integrationTerms).not.toContain("customize");
  });

  it("only targets the tab each entry is listed under", () => {
    for (const [tab, entries] of Object.entries(sidebarSearchEntries)) {
      for (const entry of entries ?? []) {
        if (entry.target) expect(entry.target.tab).toBe(tab);
      }
    }
  });

  it("makes browser privacy and profile settings searchable", () => {
    const browserTerms = (sidebarSearchEntries.browser ?? []).flatMap((entry) => entry.terms);
    expect(browserTerms).toEqual(
      expect.arrayContaining([
        "browsing history",
        "site permissions",
        "cookies",
        "saved logins",
        "import passwords",
        "cache and storage",
        "restore tabs",
      ]),
    );
  });

  it("finds the newer settings sections by their own names", () => {
    const find = (tab: keyof typeof sidebarSearchEntries, query: string) =>
      findSettingsSidebarSearchEntry(sidebarSearchEntries[tab] ?? [], query)?.target;

    expect(find("automations", "watchdog")).toEqual({
      tab: "automations",
      automationsSubTab: "queue",
    });
    expect(find("automations", "event gate")).toEqual({
      tab: "automations",
      automationsSubTab: "triggers",
    });
    expect(
      findSettingsSidebarSearchEntry(sidebarSearchEntries.browser ?? [], "camofox"),
    ).toBeTruthy();
    expect(
      findSettingsSidebarSearchEntry(sidebarSearchEntries.browser ?? [], "proxy"),
    ).toBeTruthy();
    expect(find("aimodels", "api key")).toEqual({ tab: "aimodels", aiModelsSubTab: "llm" });
    expect(find("aimodels", "lm studio")).toEqual({ tab: "aimodels", aiModelsSubTab: "llm" });
  });

  it("routes multiword searches to the matching model settings destination", () => {
    const entries = sidebarSearchEntries.aimodels ?? [];
    const context = ["AI & Models"];

    expect(findSettingsSidebarSearchEntry(entries, "openai image", context)?.target).toEqual({
      tab: "aimodels",
      aiModelsSubTab: "image",
    });
    expect(findSettingsSidebarSearchEntry(entries, "tavily search", context)?.target).toEqual({
      tab: "aimodels",
      aiModelsSubTab: "search",
    });
    expect(findSettingsSidebarSearchEntry(entries, "claude video", context)).toBeUndefined();
  });
});
