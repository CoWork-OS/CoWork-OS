import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CHANNEL_TYPES } from "../../../shared/gateway-channel-types";
import { supportedResponsibilityOperation } from "../../../electron/automation/responsibility-capabilities";
import {
  ResponsibilityOperationEditor,
  responsibilityOperationChoices,
  chooseResponsibilityOperation,
} from "../ResponsibilityOperationEditor";
describe("responsibility operation choices", () => {
  it("offers only trusted read adapters including the canonical channel catalog", () => {
    const choices = responsibilityOperationChoices("read");
    expect(choices).toHaveLength(CHANNEL_TYPES.length + 4);
    for (const choice of choices)
      expect(
        supportedResponsibilityOperation(
          {
            ...choice,
            resourceId: choice.connectorId === "workspace_files" ? "report.md" : "opaque-chat",
          },
          "read",
        ),
      ).toBe(true);
  });
  it("offers only workspace writes and never channel effects as a grant", () => {
    const choices = responsibilityOperationChoices("write");
    expect(choices).toHaveLength(1);
    expect(
      supportedResponsibilityOperation({ ...choices[0], resourceId: "report.md" }, "write"),
    ).toBe(true);
  });
  it("clears foreign conversation scope when switching channels and preserves a workspace path when changing file read kind", () => {
    const choices = responsibilityOperationChoices("read");
    expect(
      chooseResponsibilityOperation(
        { connectorId: "gateway:slack", method: "channel_history", resourceId: "private-slack" },
        choices.find((c) => c.connectorId === "gateway:teams")!,
      ).resourceId,
    ).toBe("");
    expect(
      chooseResponsibilityOperation(
        { connectorId: "workspace_files", method: "read_file", resourceId: "reports" },
        choices.find((c) => c.method === "list_directory")!,
      ).resourceId,
    ).toBe("reports");
  });
  it("preserves unsupported saved definitions and escapes their resource text", () => {
    const operation = {
      connectorId: "custom-connector",
      method: "custom_method",
      resourceId: "<script>private</script>",
    };
    const markup = renderToStaticMarkup(
      <ResponsibilityOperationEditor
        operation={operation}
        effect="read"
        index={0}
        onChange={() => {}}
      />,
    );
    expect(markup).toContain("Saved source (unavailable)");
    expect(markup).toContain("custom-connector");
    expect(markup).toContain("&lt;script&gt;private&lt;/script&gt;");
    expect(markup).not.toContain("<script>private</script>");
    expect(operation.resourceId).toBe("<script>private</script>");
  });

  it("offers configured mailbox accounts as the resource scope for mailbox reads", () => {
    const markup = renderToStaticMarkup(
      <ResponsibilityOperationEditor
        operation={{ connectorId: "mailbox", method: "list_threads", resourceId: "" }}
        effect="read"
        index={0}
        mailboxAccounts={[
          {
            id: "gmail:user@example.com",
            provider: "gmail",
            address: "user@example.com",
            status: "connected",
          },
        ]}
        onChange={() => {}}
      />,
    );
    expect(markup).toContain("Choose a configured mailbox account");
    expect(markup).toContain("user@example.com · gmail · connected");
    expect(markup).toContain("Only configured accounts are selectable.");
    expect(markup).not.toContain('type="text"');
  });
});
