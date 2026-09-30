import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AUTOMATION_SUBTAB_METHOD_REQUIREMENTS,
  AutomationSubtabNavigation,
  getAutomationSubtabAvailability,
  getInitialAutomationSubtab,
  type AutomationSettingsSubTab,
} from "../AutomationSubtabNavigation";

describe("Automation settings subtab availability", () => {
  const routineMethods = AUTOMATION_SUBTAB_METHOD_REQUIREMENTS.routines;
  const withMethods =
    (...available: string[]) =>
    (...required: string[]) =>
      required.every((method) => available.includes(method));

  it("keeps supported routines available and gates browser subtabs by their complete method sets", () => {
    expect(
      getAutomationSubtabAvailability("routines", true, withMethods(...routineMethods)),
    ).toEqual({ available: true, message: "" });
    for (const tab of [
      "queue",
      "council",
      "subconscious",
      "scheduled",
      "hooks",
      "triggers",
    ] as AutomationSettingsSubTab[]) {
      expect(
        getAutomationSubtabAvailability(tab, true, withMethods(...routineMethods)),
      ).toMatchObject({
        available: false,
      });
    }
  });

  it("requires the full routine read and write surface before enabling Routines", () => {
    const incomplete = routineMethods.filter((method) => method !== "updateRoutine");
    expect(
      getAutomationSubtabAvailability("routines", true, withMethods(...incomplete)),
    ).toMatchObject({
      available: false,
      message: expect.stringContaining("Routines is unavailable"),
    });
  });

  it("falls back an unsupported deep link to available Routines", () => {
    expect(getInitialAutomationSubtab("hooks", true, withMethods(...routineMethods))).toBe(
      "routines",
    );
  });

  it("keeps all automation destinations enabled in the native desktop app", () => {
    for (const tab of Object.keys(
      AUTOMATION_SUBTAB_METHOD_REQUIREMENTS,
    ) as AutomationSettingsSubTab[]) {
      expect(getAutomationSubtabAvailability(tab, false, () => false).available).toBe(true);
    }
  });

  it("renders unsupported browser subtabs disabled with a visible desktop explanation", () => {
    const markup = renderToStaticMarkup(
      React.createElement(AutomationSubtabNavigation, {
        activeTab: "routines",
        isBrowserHost: true,
        hasMethods: withMethods(...routineMethods),
        onSelect: () => {},
      }),
    );

    expect(markup).toContain('<button type="button" class="more-channels-tab active"');
    expect(markup).toContain('disabled="" title="Task Queue is unavailable on this browser host.');
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Task Queue, R&amp;D Council");
    expect(markup).toContain("desktop app");
  });
});
