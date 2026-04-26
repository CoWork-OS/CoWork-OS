import { describe, expect, it } from "vitest";
import { classifyShellPermissionDecision } from "../shell-permission-intents";

describe("classifyShellPermissionDecision", () => {
  it("detects explicit enable phrases", () => {
    expect(classifyShellPermissionDecision("enable shell")).toBe("enable_shell");
    expect(classifyShellPermissionDecision("please turn on shell access")).toBe(
      "enable_shell",
    );
  });

  it("detects continue-without-shell phrases", () => {
    expect(classifyShellPermissionDecision("continue without shell")).toBe(
      "continue_without_shell",
    );
    expect(classifyShellPermissionDecision("go ahead, limited best effort is fine")).toBe(
      "continue_without_shell",
    );
  });

  it("returns unknown for unrelated text", () => {
    expect(classifyShellPermissionDecision("show me the logs")).toBe("unknown");
    expect(classifyShellPermissionDecision("continue")).toBe("unknown");
    expect(classifyShellPermissionDecision("please continue")).toBe("unknown");
  });
});
