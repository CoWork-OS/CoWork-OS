import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "../../../shared/types";
import {
  BrowserUseApprovalDialog,
  getBrowserUseApprovalAction,
  getBrowserUseApprovalKeyboardAction,
  isBrowserUseDomainApproval,
  shouldIgnoreBrowserUseApprovalKeyboardShortcut,
} from "../BrowserUseApprovalDialog";

function makeApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "approval-1",
    taskId: "task-1",
    type: "network_access",
    description: "Allow Browser Use to access https://github.com?",
    details: {
      kind: "browser_use_domain_access",
      origin: "https://github.com",
      domain: "github.com",
      url: "https://github.com/openai/codex",
    },
    status: "pending",
    requestedAt: Date.now(),
    ...overrides,
  };
}

describe("BrowserUseApprovalDialog", () => {
  it("identifies only Browser Use domain approvals", () => {
    expect(isBrowserUseDomainApproval(makeApproval())).toBe(true);
    expect(
      isBrowserUseDomainApproval(
        makeApproval({
          details: { kind: "generic" },
        }),
      ),
    ).toBe(false);
  });

  it("renders Codex-style Browser Use domain approval controls", () => {
    const html = renderToStaticMarkup(
      React.createElement(BrowserUseApprovalDialog, {
        approval: makeApproval(),
        onRespond: vi.fn(),
      }),
    );

    expect(html).toContain("Browser Use");
    expect(html).toContain("Allow Browser Use to access https://github.com?");
    expect(html).toContain("Always allow");
    expect(html).toContain("Cancel");
    expect(html).toContain("Allow");
    expect(html).toContain("Esc");
    expect(html).toContain("Enter");
  });

  it("maps unchecked and checked Allow to session and workspace actions", () => {
    expect(getBrowserUseApprovalAction(false)).toBe("allow_session");
    expect(getBrowserUseApprovalAction(true)).toBe("allow_workspace");
  });

  it("maps Escape and Enter to cancel and active allow actions", () => {
    expect(getBrowserUseApprovalKeyboardAction("Escape", false)).toBe("deny_once");
    expect(getBrowserUseApprovalKeyboardAction("Enter", false)).toBe("allow_session");
    expect(getBrowserUseApprovalKeyboardAction("Enter", true)).toBe("allow_workspace");
    expect(getBrowserUseApprovalKeyboardAction("Tab", true)).toBeNull();
  });

  it("does not treat Enter inside dialog controls as a global allow shortcut", () => {
    expect(shouldIgnoreBrowserUseApprovalKeyboardShortcut("Enter", { tagName: "button" })).toBe(
      true,
    );
    expect(shouldIgnoreBrowserUseApprovalKeyboardShortcut("Enter", { tagName: "input" })).toBe(
      true,
    );
    expect(shouldIgnoreBrowserUseApprovalKeyboardShortcut("Enter", { role: "button" })).toBe(true);
    expect(
      shouldIgnoreBrowserUseApprovalKeyboardShortcut("Enter", { hasInteractiveAncestor: true }),
    ).toBe(true);
    expect(getBrowserUseApprovalKeyboardAction("Enter", false, { tagName: "button" })).toBeNull();
    expect(
      getBrowserUseApprovalKeyboardAction("Enter", false, { hasInteractiveAncestor: true }),
    ).toBeNull();
  });
});
