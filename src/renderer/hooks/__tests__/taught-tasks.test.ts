import { describe, expect, it } from "vitest";
import { formatTaughtTaskLength } from "../useTaughtTasks";

describe("formatTaughtTaskLength", () => {
  it("says how long a taught task takes in seconds or minutes", () => {
    expect(formatTaughtTaskLength(0)).toBe("1 s");
    expect(formatTaughtTaskLength(8_400)).toBe("8 s");
    expect(formatTaughtTaskLength(120_000)).toBe("2 min");
    expect(formatTaughtTaskLength(125_000)).toBe("2 min 5 s");
  });
});
