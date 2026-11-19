import { describe, expect, it } from "vitest";
import { connectorsOffField, mergeConnectorsOff, withConnectorOff } from "../connectors-off";

describe("connectors off for a conversation", () => {
  it("joins lists without blanks or repeats, so an override can only add", () => {
    expect(mergeConnectorsOff(["sf"], [], undefined, ["wiq", "sf", " "])).toEqual(["sf", "wiq"]);
    expect(mergeConnectorsOff(["sf"], [])).toEqual(["sf"]);
  });

  it("applies one change to the saved list", () => {
    expect(withConnectorOff(["sf"], "wiq", true)).toEqual(["sf", "wiq"]);
    expect(withConnectorOff(["sf", "wiq"], "sf", false)).toEqual(["wiq"]);
    expect(withConnectorOff(undefined, "sf", false)).toEqual([]);
  });

  it("adds the field to a config merge only when something is off", () => {
    expect(connectorsOffField(["sf"], [])).toEqual({ connectorsOff: ["sf"] });
    expect(connectorsOffField(undefined, [])).toEqual({});
  });
});
