import { describe, expect, it } from "vitest";

import { formatAgentRoleDisplay, normalizeAgentRoleIcon } from "../agent-role-display";

describe("agent-role-display", () => {
  it("normalizes stringified missing icons to the default icon", () => {
    expect(normalizeAgentRoleIcon("undefined")).toBe("🤖");
    expect(normalizeAgentRoleIcon(" null ")).toBe("🤖");
    expect(normalizeAgentRoleIcon("")).toBe("🤖");
  });

  it("formats collaborative titles without leaking literal undefined prefixes", () => {
    expect(formatAgentRoleDisplay("System QA Twin", "undefined")).toBe("🤖 System QA Twin");
  });
});
