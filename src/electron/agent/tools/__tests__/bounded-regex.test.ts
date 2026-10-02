import { describe, expect, it } from "vitest";
import { BoundedRegex } from "../bounded-regex";

describe("bounded regex execution", () => {
  it("terminates an alternate catastrophic pattern and can subsequently search normally", async () => {
    const evaluator = new BoundedRegex();
    try {
      await expect(
        evaluator.evaluate("(a|aa)+$", "g", ["a".repeat(100) + "!"], "test"),
      ).rejects.toThrow("deadline");
      await evaluator.close();
      expect(await evaluator.evaluate("(?<=a)b", "g", ["ab", "ac"], "test")).toEqual([0]);
      expect(await evaluator.evaluate("", "g", ["ab"], "count")).toEqual([3]);
    } finally {
      await evaluator.close();
    }
  });
});
