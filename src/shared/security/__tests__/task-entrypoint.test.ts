import { describe, expect, it } from "vitest";
import {
  normalizeTaskAgentConfigForCreation,
  taskAgentConfigForCreation,
} from "../task-entrypoint";

describe("task entrypoint access normalization", () => {
  const settings = { defaultAccessProfileId: "ask_for_approval" as const };

  it("attaches the migrated named default to a new root", () => {
    expect(taskAgentConfigForCreation({ gatewayContext: "private" }, settings)).toEqual({
      gatewayContext: "private",
      accessProfileId: "ask_for_approval",
    });
  });

  it("keeps an explicit profile and does not replace it with the default", () => {
    expect(
      normalizeTaskAgentConfigForCreation(
        { accessProfileId: "custom-restricted", shellAccess: false },
        settings,
      ),
    ).toEqual({
      agentConfig: { accessProfileId: "custom-restricted", shellAccess: false },
      source: "explicit_profile",
    });
  });

  it("keeps legacy mode and shell ceilings instead of widening them", () => {
    expect(
      taskAgentConfigForCreation(
        { permissionMode: "plan", shellAccess: false, readOnlyExecution: true },
        settings,
      ),
    ).toEqual({ permissionMode: "plan", shellAccess: false, readOnlyExecution: true });
  });

  it("keeps a standalone legacy shell=false ceiling instead of attaching the default", () => {
    expect(normalizeTaskAgentConfigForCreation({ shellAccess: false }, settings)).toEqual({
      agentConfig: { shellAccess: false },
      source: "legacy_override",
    });
  });

  it("keeps an explicit profile and its legacy shell ceiling together", () => {
    expect(
      taskAgentConfigForCreation(
        { accessProfileId: "custom-restricted", shellAccess: false },
        settings,
      ),
    ).toEqual({ accessProfileId: "custom-restricted", shellAccess: false });
  });

  it("preserves an explicit read-only helper while inheriting the named default", () => {
    expect(
      taskAgentConfigForCreation({ readOnlyExecution: true, allowUserInput: false }, settings),
    ).toEqual({
      readOnlyExecution: true,
      allowUserInput: false,
      accessProfileId: "ask_for_approval",
    });
  });

  it("does not invent full access when migration settings are missing", () => {
    expect(normalizeTaskAgentConfigForCreation({ allowUserInput: false }, {})).toEqual({
      agentConfig: { allowUserInput: false },
      source: "none",
    });
  });
});
