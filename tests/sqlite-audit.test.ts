import { describe, expect, it } from "vitest";
import { audit } from "../scripts/qa/sqlite-audit.mjs";

// DB6 dependency audit: no synchronous SQLite access on an application thread without a
// stated domain, access pattern and migration plan.
describe("sqlite dependency audit", () => {
  it("explains every file in the ratchet register", () => {
    expect(audit().unexplained).toEqual([]);
  });

  it("reports a register entry no rule explains", () => {
    const result = audit({
      baseline: { files: { "src/electron/new-domain/Store.ts": { prepare: 1 } } },
      rules: [{ pattern: "^src/electron/other/", domain: "x", access: "y", plan: "z" }],
    });
    expect(result.unexplained).toEqual(["src/electron/new-domain/Store.ts"]);
  });

  it("checks newly discovered application-thread files before they enter the register", () => {
    const result = audit({
      baseline: { files: {} },
      inventory: {
        files: [{ path: "src/electron/new-domain/Store.ts", counts: { prepare: 1 } }],
      },
      rules: [{ pattern: "^src/electron/other/", domain: "x", access: "y", plan: "z", owner: "o" }],
    });
    expect(result.unexplained).toEqual(["src/electron/new-domain/Store.ts"]);
  });

  it("fails a file only a backstop covers, and a rule without an owner (DB7 gate)", () => {
    const result = audit({
      baseline: { files: { "src/electron/new-area/Service.ts": { prepare: 1 } } },
      rules: [
        {
          pattern: "^src/electron/",
          domain: "services",
          access: "y",
          plan: "z",
          backstop: true,
          owner: "o",
        },
        { pattern: "^src/other/", domain: "x", access: "y", plan: "z" },
      ],
    });
    expect(result.backstopped).toEqual(["src/electron/new-area/Service.ts"]);
    expect(result.unowned).toEqual(["^src/other/"]);
  });

  it("has no backstopped files and no unowned rules today", () => {
    const result = audit();
    expect(result.backstopped).toEqual([]);
    expect(result.unowned).toEqual([]);
  });
});
