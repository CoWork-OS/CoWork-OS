import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "../../../shared/types";
import { ApprovalDraftPreviewText, GenericApprovalDialog } from "../GenericApprovalDialog";

function makeApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "approval-1",
    taskId: "task-1",
    type: "external_service",
    description: "Approve tool call: open_application",
    details: {
      tool: "open_application",
      params: { appName: "Safari" },
      permissionPrompt: {
        scope: { kind: "tool", toolName: "open_application" },
        scopePreview: "tool open_application",
        reason: {
          type: "mode",
          mode: "default",
          summary: "Default mode prompts for writes, deletes, shell, and external effects.",
        },
        suggestedActions: [
          { action: "deny_once", label: "Deny once", effect: "deny" },
          { action: "allow_once", label: "Allow once", effect: "allow" },
        ],
      },
    },
    status: "pending",
    requestedAt: Date.now(),
    ...overrides,
  };
}

describe("GenericApprovalDialog", () => {
  it("keeps persistent policy scopes behind the advanced control", () => {
    const approval = makeApproval();
    const details = approval.details as Any;
    details.accessProfile = { id: "ask_for_approval" };
    details.permissionPrompt.suggestedActions = [
      "once",
      "session",
      "workspace",
      "profile",
      "recurring",
    ].flatMap((scope) => [
      { action: `allow_${scope}`, label: `Allow ${scope}`, effect: "allow" },
      { action: `deny_${scope}`, label: `Deny ${scope}`, effect: "deny" },
    ]);
    const html = renderToStaticMarkup(
      React.createElement(GenericApprovalDialog, {
        approval,
        onRespond: vi.fn(),
        onApproveAllSession: vi.fn(),
      }),
    );
    expect(html).toContain("Advanced permission rules");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain(">Workspace</button>");
    expect(html).not.toContain(">Profile</button>");
    expect(html).not.toContain("Approve all for");
  });

  it("shows the memory and its source when the agent asks to forget a memory", () => {
    const html = renderToStaticMarkup(
      React.createElement(GenericApprovalDialog, {
        approval: makeApproval({
          type: "memory_delete",
          description: 'Forget a saved memory: "The user prefers dark mode"',
          details: {
            tool: "memory_forget",
            memory: "memory:abc",
            content: "The user prefers dark mode",
            source: "user_stated",
            reason: "outdated",
          },
        }),
        onRespond: vi.fn(),
      }),
    );

    expect(html).toContain("Forget a memory");
    expect(html).not.toContain("Delete multiple items");
    expect(html).toContain("forget memory");
    expect(html).toContain("The user prefers dark mode");
    expect(html).toContain("You said");
    expect(html).toContain("outdated");
  });

  it("explains open_application approvals with the concrete app and system action", () => {
    const html = renderToStaticMarkup(
      React.createElement(GenericApprovalDialog, {
        approval: makeApproval(),
        onRespond: vi.fn(),
      }),
    );

    expect(html).toContain("Open application");
    expect(html).toContain("Allow CoWork OS to open Safari?");
    expect(html).toContain("system action");
    expect(html).toContain("open_application");
    expect(html).toContain("Application");
    expect(html).toContain("Safari");
    expect(html).toContain("CoWork OS launches Safari on this computer.");
  });

  it("shows the reviewed Gmail recipients, subject, and message before sending", () => {
    const html = renderToStaticMarkup(
      React.createElement(GenericApprovalDialog, {
        approval: makeApproval({
          description: "Send a Gmail message",
          details: {
            tool: "gmail_action",
            reviewedEffect: {
              version: 1,
              provider: "gmail",
              operation: "send_message",
              message: {
                to: "reader@example.com",
                cc: "copy@example.com",
                subject: "Quarterly update",
                body: "The revised report is ready.",
              },
            },
          },
        }),
        onRespond: vi.fn(),
      }),
    );

    expect(html).toContain("Send this Gmail message");
    expect(html).toContain("reader@example.com");
    expect(html).toContain("copy@example.com");
    expect(html).toContain("Quarterly update");
    expect(html).toContain("The revised report is ready.");
  });

  it("shows the selected Gmail label set before a bulk change", () => {
    const html = renderToStaticMarkup(
      React.createElement(GenericApprovalDialog, {
        approval: makeApproval({
          description: "Apply a Gmail label to matching messages",
          details: {
            tool: "gmail_bulk_label_matching_emails",
            reviewedEffect: {
              version: 1,
              provider: "gmail",
              operation: "bulk_label",
              message: {
                query: "from:reports@example.com",
                labelName: "Reviewed",
                matchCount: 12,
                messageIdsPreview: ["message-1", "message-2"],
              },
              target: { kind: "matching_messages", count: 12 },
              change: { addLabelIds: ["Label_1"], removeLabelIds: [] },
              messageIdsSha256: "a".repeat(64),
            },
          },
        }),
        onRespond: vi.fn(),
      }),
    );

    expect(html).toContain("Change labels on matching Gmail messages");
    expect(html).toContain("from:reports@example.com");
    expect(html).toContain("Reviewed");
    expect(html).toContain("12");
    expect(html).toContain("message-1");
    expect(html).toContain("a".repeat(64));
  });

  it("shows the complete proposed Calendar event before a write", () => {
    const html = renderToStaticMarkup(
      React.createElement(GenericApprovalDialog, {
        approval: makeApproval({
          description: "Create a Google Calendar event",
          details: {
            tool: "calendar_action",
            reviewedEffect: {
              version: 1,
              provider: "google_calendar",
              operation: "create_event",
              calendarId: "primary",
              event: {
                summary: "Project sync",
                start: { dateTime: "2026-10-07T10:00:00Z" },
                end: { dateTime: "2026-10-07T10:30:00Z" },
                attendees: [{ email: "reader@example.com" }],
                description: "Review the delivery plan",
              },
            },
          },
        }),
        onRespond: vi.fn(),
      }),
    );

    expect(html).toContain("Google Calendar create_event");
    expect(html).toContain("Project sync");
    expect(html).toContain("2026-10-07T10:00:00Z");
    expect(html).toContain("reader@example.com");
    expect(html).toContain("Review the delivery plan");
  });

  it("shows the exact Notion change and resource before a write", () => {
    const html = renderToStaticMarkup(
      React.createElement(GenericApprovalDialog, {
        approval: makeApproval({
          description: "Update a Notion block",
          details: {
            tool: "notion_action",
            reviewedEffect: {
              version: 1,
              provider: "notion",
              operation: "update_block",
              target: { kind: "block", id: "block-123" },
              change: { paragraph: { rich_text: [{ text: { content: "Reviewed copy" } }] } },
            },
          },
        }),
        onRespond: vi.fn(),
      }),
    );

    expect(html).toContain("Notion update_block");
    expect(html).toContain("block-123");
    expect(html).toContain("Reviewed copy");
  });

  it("labels local write_file approvals as workspace changes", () => {
    const html = renderToStaticMarkup(
      React.createElement(GenericApprovalDialog, {
        approval: makeApproval({
          type: "workspace_write",
          description: "Approve tool call: write_file",
          details: {
            tool: "write_file",
            path: "/workspace/notes/checklist.md",
            permissionPrompt: {
              scope: { kind: "path", path: "/workspace/notes/checklist.md" },
              scopePreview: "write_file on path /workspace/notes/checklist.md",
              reason: {
                type: "mode",
                mode: "default",
                summary: "Default mode prompts for writes, deletes, shell, and external effects.",
              },
              suggestedActions: [],
            },
          },
        }),
        onRespond: vi.fn(),
      }),
    );

    expect(html).toContain("Workspace change");
    expect(html).toContain("workspace write");
    expect(html).not.toContain("External service");
    expect(html).not.toContain("internet access");
  });
});

describe("captured draft review", () => {
  it("shows the recorded file version and escaped bounded draft text", () => {
    const html = renderToStaticMarkup(
      React.createElement(GenericApprovalDialog, {
        approval: makeApproval({
          details: {
            draftRevision: {
              version: 1,
              state: "bound",
              entries: [
                {
                  reference: "draft.md",
                  status: "present",
                  sha256: "a".repeat(64),
                  size: 4000,
                  preview: { text: "<img src=x onerror=alert(1)> reviewed text", truncated: true },
                },
                { reference: "missing.md", status: "missing" },
              ],
            },
          },
        }),
        onRespond: vi.fn(),
      }),
    );
    expect(html).toContain("Draft for this request");
    expect(html).toContain("File version aaaaaaaaaaaa");
    const previewHtml = renderToStaticMarkup(
      React.createElement(ApprovalDraftPreviewText, {
        preview: {
          reference: "draft.md",
          sha256: "a".repeat(64),
          text: "<img src=x onerror=alert(1)> reviewed text",
          truncated: true,
        },
      }),
    );
    expect(previewHtml).toContain("Preview truncated");
    expect(html).toContain("Missing when requested");
    expect(previewHtml).toContain("&lt;img");
    expect(previewHtml).not.toContain("<img src=x");
    expect(html).not.toContain("reviewed text");
  });
  it("keeps unavailable and legacy drafts readable without inventing a preview", () => {
    const html = renderToStaticMarkup(
      React.createElement(GenericApprovalDialog, {
        approval: makeApproval({
          details: { draftRevision: { version: 1, state: "unavailable" } },
        }),
        onRespond: vi.fn(),
      }),
    );
    expect(html).toContain("draft could not be inspected");
    expect(html).not.toContain("File version");
  });
});

describe("mandatory proposed-write approval", () => {
  function makeDetails(review: unknown) {
    return {
      responsibilityActionReview: review,
      permissionPrompt: {
        scope: { kind: "tool", toolName: "write_file" },
        scopePreview: "write_file to notes/proposal.md",
        reason: { type: "mode", mode: "default", summary: "Review the proposed content." },
        suggestedActions: [
          { action: "deny_once", label: "Deny once", effect: "deny" },
          { action: "allow_once", label: "Approve once", effect: "allow" },
          { action: "allow_session", label: "Allow session", effect: "allow" },
          { action: "allow_workspace", label: "Allow workspace", effect: "allow" },
          { action: "allow_profile", label: "Allow profile", effect: "allow" },
        ],
      },
    };
  }

  it("shows exact reviewed content and only one-time decisions even when broader scopes are suggested", () => {
    const content = "Exact proposal π\n";
    const review = {
      version: 1,
      operation: { connectorId: "workspace_files", method: "write_file" },
      canonicalPath: "notes/proposal.md",
      content,
      contentSha256: "c".repeat(64),
      contentBytes: new TextEncoder().encode(content).byteLength,
      responsibilityRun: {
        id: "run-1",
        revision: 3,
        controlVersion: 4,
        workspaceId: "workspace-1",
        agentRoleId: "writer",
      },
    };
    const html = renderToStaticMarkup(
      React.createElement(GenericApprovalDialog, {
        approval: makeApproval({
          type: "workspace_write",
          details: makeDetails(review),
        }),
        onRespond: vi.fn(),
        onApproveAllSession: vi.fn(),
      }),
    );

    expect(html).toContain('aria-label="Proposed write for responsibility review"');
    expect(html).toContain("notes/proposal.md");
    expect(html).toContain("c".repeat(64));
    expect(html).toContain("Exact proposal π\n");
    expect(html).toContain(">Deny once</button>");
    expect(html).toContain(">Approve once</button>");
    expect(html).not.toContain("Remember for");
    expect(html).not.toContain("Advanced permission rules");
    expect(html).not.toContain("Allow session");
    expect(html).not.toContain("Allow workspace");
    expect(html).not.toContain("Allow profile");
    expect(html).not.toContain("Approve all for this session");
  });

  it("fails closed for an invalid present review instead of falling back to suggested scopes", () => {
    const html = renderToStaticMarkup(
      React.createElement(GenericApprovalDialog, {
        approval: makeApproval({
          type: "workspace_write",
          details: makeDetails(null),
        }),
        onRespond: vi.fn(),
        onApproveAllSession: vi.fn(),
      }),
    );

    expect(html).toContain("proposed write review is invalid");
    expect(html).toContain(">Deny once</button>");
    expect(html).not.toContain(">Approve once</button>");
    expect(html).not.toContain("Allow session");
    expect(html).not.toContain("Allow workspace");
    expect(html).not.toContain("Allow profile");
    expect(html).not.toContain("Remember for");
    expect(html).not.toContain("Advanced permission rules");
    expect(html).not.toContain("Approve all for this session");
  });
});
