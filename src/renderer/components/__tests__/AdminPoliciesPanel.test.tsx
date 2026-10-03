import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ShellSandboxPolicySummary } from "../AdminPoliciesPanel";

/**
 * The shell sandbox and shell network admin policies decide whether
 * run_command is sandboxed or networked, but Settings never showed them, so
 * users could not see why a command was refused or ran without a sandbox.
 */
describe("ShellSandboxPolicySummary", () => {
  it("shows each shell runtime policy with its effect", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ShellSandboxPolicySummary, {
        runtime: {
          requireSandboxForShell: true,
          allowUnsandboxedShell: false,
          allowedSandboxTypes: ["macos", "docker"],
          network: { allowShellNetwork: false },
        },
      }),
    );

    expect(markup).toContain("Require OS sandbox for shell commands");
    expect(markup).toContain("Allow unsandboxed shell fallback");
    expect(markup).toContain("Allowed sandbox backends");
    expect(markup).toContain("Allow network access from shell commands");
    expect(markup).toContain("macOS sandbox, Docker");
    expect((markup.match(/>On</g) || []).length).toBe(1);
    expect((markup.match(/>Off</g) || []).length).toBe(2);
    expect(markup).toContain("COWORK_ALLOW_UNSANDBOXED_SHELL=1");
    expect(markup).toContain("policies.json");
    // Read-only: changes go through the admin policy update path and its
    // confirmation dialog, not through controls here.
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain("<select");
  });

  it("reports missing values instead of guessing", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ShellSandboxPolicySummary, { runtime: undefined }),
    );
    expect(markup).toContain("Not reported");
  });
});
