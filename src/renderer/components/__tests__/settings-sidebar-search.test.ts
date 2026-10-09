import { describe, expect, it } from "vitest";

import { sidebarSearchEntries } from "../Settings";

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
});
