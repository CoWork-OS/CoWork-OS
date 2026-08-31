import { describe, expect, it } from "vitest";
import { buildBrowserUseDomainApprovalDetails } from "../browser-use-approval-context";

describe("Browser Use approval context", () => {
  it("uses the requested URL for browser_navigate domain approvals", () => {
    const details = buildBrowserUseDomainApprovalDetails({
      toolName: "browser_navigate",
      input: { url: "https://github.com/openai/codex" },
    });

    expect(details).toMatchObject({
      kind: "browser_use_domain_access",
      tool: "browser_navigate",
      url: "https://github.com/openai/codex",
      origin: "https://github.com",
      domain: "github.com",
      permissionInput: { url: "https://github.com/openai/codex" },
    });
  });

  it("uses the visible Browser Workbench URL for later browser actions", () => {
    const details = buildBrowserUseDomainApprovalDetails({
      toolName: "browser_click",
      input: { selector: "button", session_id: "browser-1" },
      currentUrl: "https://github.com/openai/codex/issues",
    });

    expect(details).toMatchObject({
      kind: "browser_use_domain_access",
      tool: "browser_click",
      origin: "https://github.com",
      domain: "github.com",
      browserSessionId: "browser-1",
      permissionInput: { url: "https://github.com/openai/codex/issues" },
    });
  });

  it("does not infer domain approvals for history navigation with unknown targets", () => {
    for (const toolName of ["browser_back", "browser_forward"]) {
      expect(
        buildBrowserUseDomainApprovalDetails({
          toolName,
          currentUrl: "https://github.com/openai/codex/issues",
        }),
      ).toBeNull();
    }
  });

  it("falls back when a browser action has no resolvable domain", () => {
    expect(
      buildBrowserUseDomainApprovalDetails({
        toolName: "browser_click",
        input: { selector: "button" },
      }),
    ).toBeNull();
    expect(
      buildBrowserUseDomainApprovalDetails({
        toolName: "browser_navigate",
        input: { url: "file:///tmp/index.html" },
      }),
    ).toBeNull();
  });
});
