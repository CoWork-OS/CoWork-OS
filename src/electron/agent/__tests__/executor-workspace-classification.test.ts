import { describe, it, expect } from "vitest";
import { TaskExecutor } from "../executor";

describe("TaskExecutor workspace preflight classification", () => {
  const classify = (prompt: string) =>
    (TaskExecutor as Any).prototype.classifyWorkspaceNeed.call({}, prompt) as
      | "none"
      | "new_ok"
      | "ambiguous"
      | "needs_existing";

  it('does not treat new markdown file creation as "needs_existing"', () => {
    expect(classify("Create a NEW markdown file named notes.md in this folder")).toBe("new_ok");
  });

  it("still detects existing project work when prompt includes repo + update", () => {
    expect(classify("Update README.md in this repo")).toBe("needs_existing");
  });

  it("detects existing code work when prompt includes a code file path", () => {
    expect(classify("Fix a bug in src/app.ts")).toBe("needs_existing");
  });
});

describe("TaskExecutor intent detection", () => {
  const capabilityIntent = (prompt: string) =>
    (TaskExecutor as Any).prototype.isCapabilityUpgradeIntent.call({}, prompt) as boolean;

  const internalAppIntent = (prompt: string) =>
    (TaskExecutor as Any).prototype.isInternalAppOrToolChangeIntent.call({}, prompt) as boolean;

  const capabilityRefusal = (prompt: string) =>
    (TaskExecutor as Any).prototype.isCapabilityRefusal.call({}, prompt) as boolean;

  it("detects browser preference shifts as capability upgrade requests", () => {
    expect(capabilityIntent("open the browser on brave browser instead of chrome")).toBe(true);
  });

  it("detects explicit browser channel change requests", () => {
    expect(capabilityIntent("set browser_channel to brave for browser_navigate")).toBe(true);
  });

  it("detects internal app/tool implementation intent", () => {
    expect(internalAppIntent("change the app code to add logging for agent tools")).toBe(true);
  });

  it("does not mark unrelated text as internal app/tool implementation intent", () => {
    expect(internalAppIntent("Please summarize this article")).toBe(false);
  });

  it("does not treat neutral browser comparisons as capability requests", () => {
    expect(capabilityIntent("Compare Brave vs Chrome browser performance")).toBe(false);
  });

  it("does not misclassify generic project tooling requests as internal app/tool intent", () => {
    expect(internalAppIntent("Update tooling in the project and run tests")).toBe(false);
  });

  it("detects limitation phrasing that says only Chromium/Chrome are supported", () => {
    expect(
      capabilityRefusal(
        "My browser tools only support Chromium and Google Chrome - Brave isn't available as an option.",
      ),
    ).toBe(true);
  });
});
