import { describe, expect, it } from "vitest";
import { getRoutineListDisplayState } from "../routine-list-state";

describe("routine list display state", () => {
  it("does not present a failed or pending host read as an empty routine list", () => {
    expect(getRoutineListDisplayState(false, 0)).toBe("unavailable");
  });

  it("shows the empty state only after a successful routine list read", () => {
    expect(getRoutineListDisplayState(true, 0)).toBe("empty");
    expect(getRoutineListDisplayState(true, 1)).toBe("loaded");
  });
});
