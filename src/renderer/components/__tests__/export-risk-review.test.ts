import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "../../../shared/types";
import { GenericApprovalDialog } from "../GenericApprovalDialog";
import { BrowserApprovalCard } from "../BrowserWorkbench/BrowserApprovalCard";

function request(context?: unknown): ApprovalRequest {
  return {
    id: "export-1",
    taskId: "task-1",
    type: "data_export",
    status: "pending",
    requestedAt: 1,
    description: "Upload a report",
    details: {
      kind: "browser_upload",
      permissionPrompt: {
        securityContext: context,
        suggestedActions: [
          { action: "deny_once", label: "Deny once" },
          { action: "allow_once", label: "Allow once" },
        ],
      },
    },
  };
}

const context = {
  directSource: {
    path: "private/report.pdf",
    sourceKind: "workspace_native",
    trustLevel: "trusted",
  },
  recentSensitiveSources: [
    {
      path: "incoming.txt",
      sourceKind: "channel_attachment",
      trustLevel: "untrusted",
      sourceLabel: "Incoming email",
    },
  ],
  exportTarget: {
    toolName: "browser_upload",
    method: "POST",
    url: "https://qa-user:qa-password-value@forms.example.com/submit?token=qa-token-value",
  },
};

describe("export explanation in production approval surfaces", () => {
  it.each([
    [GenericApprovalDialog, "data_export"],
    [BrowserApprovalCard, "browser"],
  ] as const)("shows the main-process risk context in %s for %s", (Component, type) => {
    const approval = request(context);
    approval.type = type;
    approval.details!.url = context.exportTarget.url + "&format=pdf";
    const html = renderToStaticMarkup(
      React.createElement(Component as typeof GenericApprovalDialog, {
        approval,
        onRespond: vi.fn(),
      }),
    );
    expect(html).toContain('aria-label="Export risk explanation"');
    expect(html).toContain("recent untrusted source (Incoming email)");
    expect(html).toContain("private/report.pdf");
    expect(html).toContain("browser_upload POST export");
    expect(html).toContain("forms.example.com");
    if (type === "data_export") {
      expect(html).toContain("/submit?format=pdf");
    }
    expect(html).not.toMatch(/qa-user|qa-password-value|qa-token-value/);
  });

  it("does not invent a chain for legacy requests or source-only reads", () => {
    for (const value of [
      undefined,
      {},
      { directSource: context.directSource },
      { exportTarget: {} },
    ]) {
      const html = renderToStaticMarkup(
        React.createElement(GenericApprovalDialog, {
          approval: request(value),
          onRespond: vi.fn(),
        }),
      );
      expect(html).not.toContain('aria-label="Export risk explanation"');
      expect(html).toContain("Allow once");
    }
  });

  it("escapes externally supplied source labels", () => {
    const html = renderToStaticMarkup(
      React.createElement(GenericApprovalDialog, {
        approval: request({
          ...context,
          directSource: {
            ...context.directSource,
            trustLevel: "untrusted",
            sourceLabel: "<img src=x onerror=alert(1)>",
          },
        }),
        onRespond: vi.fn(),
      }),
    );
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img src=x");
  });

  it.each(["web_fetch", "http_request"])(
    "does not describe read-only %s network access as an export",
    (toolName) => {
      const approval = request({
        ...context,
        exportTarget: { toolName, method: "GET", url: "https://docs.example.com" },
      });
      approval.type = "network_access";
      approval.details!.kind = "network_access";
      for (const Component of [GenericApprovalDialog, BrowserApprovalCard]) {
        const html = renderToStaticMarkup(
          React.createElement(Component as typeof GenericApprovalDialog, {
            approval,
            onRespond: vi.fn(),
          }),
        );
        expect(html).not.toContain('aria-label="Export risk explanation"');
        expect(html).not.toContain("outgoing data");
      }
    },
  );
});
