import { describe, expect, it } from "vitest";
import {
  buildGenericLegalWorkflowFollowUp,
  buildGenericLegalWorkflowInitialValues,
  buildLegalDemandIntakeFollowUp,
  buildLegalDemandIntakeInitialValues,
  parseLegalDemandIntakeSlashPrompt,
  parseLegalWorkflowSlashPrompt,
} from "../legal-demand-intake";

describe("parseLegalDemandIntakeSlashPrompt", () => {
  it("matches the legal demand intake slash command and returns trailing args", () => {
    expect(
      parseLegalDemandIntakeSlashPrompt(
        "/litigation-legal-demand-intake unpaid invoices acme logistics",
      ),
    ).toEqual({
      matched: true,
      args: "unpaid invoices acme logistics",
    });
  });

  it("does not match unrelated slash commands", () => {
    expect(
      parseLegalDemandIntakeSlashPrompt("/litigation-legal-demand-draft payment-acme"),
    ).toEqual({
      matched: false,
      args: "",
    });
  });
});

describe("parseLegalWorkflowSlashPrompt", () => {
  it("routes demand intake to the specialized form", () => {
    expect(
      parseLegalWorkflowSlashPrompt("/litigation-legal-demand-intake unpaid invoices"),
    ).toEqual({
      matched: true,
      commandName: "litigation-legal-demand-intake",
      args: "unpaid invoices",
      kind: "demand-intake",
    });
  });

  it("matches other Claude-for-Legal workflows that benefit from matter context", () => {
    expect(
      parseLegalWorkflowSlashPrompt("/commercial-legal-saas-msa-review acme subscription"),
    ).toEqual({
      matched: true,
      commandName: "commercial-legal-saas-msa-review",
      args: "acme subscription",
      kind: "general",
    });
  });

  it("does not show a context form for legal pack management commands", () => {
    expect(parseLegalWorkflowSlashPrompt("/legal-builder-hub-disable old-skill")).toMatchObject({
      matched: false,
      commandName: "",
      args: "",
    });
  });

  it("does not match unrelated slash commands", () => {
    expect(parseLegalWorkflowSlashPrompt("/plan build the thing")).toMatchObject({
      matched: false,
      commandName: "",
      args: "",
    });
  });
});

describe("buildLegalDemandIntakeInitialValues", () => {
  it("prefills payment-demand basics from terse slash args", () => {
    const values = buildLegalDemandIntakeInitialValues(
      "/litigation-legal-demand-intake unpaid invoices acme logistics",
    );

    expect(values).toMatchObject({
      title: "Unpaid Invoices - Acme Logistics",
      recipient: "Acme Logistics",
      demandType: "payment",
      tone: "measured",
      responseWindow: "14 days",
    });
  });
});

describe("buildLegalDemandIntakeFollowUp", () => {
  it("serializes the form into a continuation message with explicit blanks", () => {
    const values = buildLegalDemandIntakeInitialValues(
      "/litigation-legal-demand-intake unpaid invoices acme logistics",
    );
    const message = buildLegalDemandIntakeFollowUp({
      ...values,
      sender: "Almarion LLC",
      desiredOutcome: "Payment of $42,000 by wire.",
    });

    expect(message).toContain("Demand intake details for /litigation-legal-demand-intake.");
    expect(message).toContain("- Sender: Almarion LLC");
    expect(message).toContain("Payment of $42,000 by wire.");
    expect(message).toContain("[not provided]");
  });
});

describe("buildGenericLegalWorkflowFollowUp", () => {
  it("serializes a generic legal workflow context message", () => {
    const invocation = parseLegalWorkflowSlashPrompt(
      "/privacy-legal-dpa-review acme processor terms",
    );
    const values = buildGenericLegalWorkflowInitialValues(invocation);
    const message = buildGenericLegalWorkflowFollowUp(invocation, {
      ...values,
      jurisdiction: "California and GDPR",
      documents: "DPA_v4.docx",
    });

    expect(message).toContain("Legal workflow context for /privacy-legal-dpa-review.");
    expect(message).toContain("- Jurisdiction / governing law: California and GDPR");
    expect(message).toContain("DPA_v4.docx");
    expect(message).toContain("[not provided]");
  });
});
