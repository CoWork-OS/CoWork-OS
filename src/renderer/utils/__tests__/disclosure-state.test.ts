import { describe, expect, it } from "vitest";

import {
  disclosureIntentReducer,
  EMPTY_DISCLOSURE_INTENT_STATE,
  getDisclosureIntent,
  resolveDisclosureExpanded,
} from "../disclosure-state";

describe("disclosure intent", () => {
  it("opens auto intent only for the current group", () => {
    expect(resolveDisclosureExpanded({ intent: "auto", isCurrent: true })).toBe(true);
    expect(resolveDisclosureExpanded({ intent: "auto", isCurrent: false })).toBe(false);
  });

  it("keeps explicit collapsed and expanded intent across activity changes", () => {
    expect(resolveDisclosureExpanded({ intent: "collapsed", isCurrent: true })).toBe(false);
    expect(resolveDisclosureExpanded({ intent: "expanded", isCurrent: false })).toBe(true);
  });

  it("uses the same reducer for groups and individual activities", () => {
    const groupCollapsed = disclosureIntentReducer(EMPTY_DISCLOSURE_INTENT_STATE, {
      type: "toggle",
      scope: "group",
      id: "group-1",
      isCurrent: true,
    });
    const activityExpanded = disclosureIntentReducer(groupCollapsed, {
      type: "toggle",
      scope: "activity",
      id: "activity-1",
      isCurrent: false,
    });

    expect(getDisclosureIntent(activityExpanded, "group", "group-1")).toBe("collapsed");
    expect(getDisclosureIntent(activityExpanded, "activity", "activity-1")).toBe("expanded");
  });
});
