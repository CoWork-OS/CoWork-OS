import { describe, expect, it } from "vitest";
import { requiresAgentSecurityConfirmation } from "../agent-security-confirmation";

describe("agent security direct-run confirmation", () => {
  it.each(["agent-security-prune", "agent-security-hook-install", "agent-security-hook-uninstall"])(
    "requires --yes for %s",
    (command) => {
      expect(requiresAgentSecurityConfirmation(command)).toBe(true);
    },
  );

  it.each(["agent-security-hook-status", "agent-security-findings", undefined])(
    "does not gate the read-only command %s",
    (command) => {
      expect(requiresAgentSecurityConfirmation(command)).toBe(false);
    },
  );
});
