import { describe, expect, it } from "vitest";
import {
  parseWritePreview,
  parseWriteReceipt,
  renderWritePreview,
  supportsWritePreview,
} from "../write-preview";

const prepared = {
  kind: "preview",
  summary: 'Send the email "Invoice" to 2 recipients',
  references: ["resend:send_email"],
  payload: {
    fields: [
      { label: "To", value: "a@example.com, b@example.com" },
      { label: "Subject", value: "Invoice" },
      { label: "", value: "ignored" },
    ],
  },
};

describe("connector write preview and receipt", () => {
  it("knows which tools can describe a write", () => {
    expect(supportsWritePreview({ _meta: { "cowork.preview": true } })).toBe(true);
    expect(supportsWritePreview({ _meta: { "cowork.preview": "yes" } })).toBe(false);
    expect(supportsWritePreview({})).toBe(false);
    expect(supportsWritePreview(undefined)).toBe(false);
  });

  it("accepts only a well-formed preview answer", () => {
    expect(parseWritePreview({ structuredContent: { status: "preview", prepared } })).toMatchObject(
      {
        kind: "preview",
        summary: 'Send the email "Invoice" to 2 recipients',
      },
    );
    expect(
      parseWritePreview({ structuredContent: { status: "created", prepared } }),
    ).toBeUndefined();
    expect(
      parseWritePreview({ isError: true, structuredContent: { status: "preview", prepared } }),
    ).toBeUndefined();
    // Unknown keys are refused: the shape is ApplicationPreparedChange, strictly.
    expect(
      parseWritePreview({
        structuredContent: { status: "preview", prepared: { ...prepared, runScript: "x" } },
      }),
    ).toBeUndefined();
  });

  it("renders the effect as labeled lines, bounded", () => {
    expect(renderWritePreview(prepared as never)).toBe(
      [
        'Send the email "Invoice" to 2 recipients',
        "To: a@example.com, b@example.com",
        "Subject: Invoice",
        "",
        "References:",
        "- resend:send_email",
      ].join("\n"),
    );
    const long = renderWritePreview({
      ...prepared,
      payload: { fields: [{ label: "Body", value: "x".repeat(5_000) }] },
    } as never);
    expect(long.length).toBeLessThan(1_200);
  });

  it("accepts only a well-formed receipt", () => {
    const receipt = {
      status: "verified",
      summary: "Created Jira issue OPS-1",
      checkedAt: 1_000,
      evidence: [{ source: "jira:issue:OPS-1", claim: 'Issue OPS-1 exists with summary "Rotate"' }],
    };
    expect(parseWriteReceipt({ structuredContent: { status: "created", receipt } })).toEqual(
      receipt,
    );
    expect(parseWriteReceipt({ structuredContent: { status: "created" } })).toBeUndefined();
    expect(
      parseWriteReceipt({ structuredContent: { receipt: { ...receipt, status: "done" } } }),
    ).toBeUndefined();
  });
});
