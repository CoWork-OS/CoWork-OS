import { describe, expect, it } from "vitest";
import { buildExportRiskChain } from "../export-risk-chain";

describe("buildExportRiskChain", () => {
  it("describes untrusted source, private data, side effect, and destination", () => {
    expect(
      buildExportRiskChain({
        directSource: {
          path: "mail/invoice.pdf",
          sourceKind: "channel_attachment",
          trustLevel: "untrusted",
          sourceLabel: "Incoming attachment",
        },
        exportTarget: {
          toolName: "send_file",
          method: "POST",
          domain: "example.com",
        },
      }),
    ).toEqual({
      source: "untrusted source (Incoming attachment)",
      data: "mail/invoice.pdf",
      sideEffect: "send_file POST export",
      destination: "example.com",
      includesUntrustedSource: true,
    });
  });

  it("returns no chain when there is no external target", () => {
    expect(
      buildExportRiskChain({
        directSource: {
          path: "notes.txt",
          sourceKind: "workspace_native",
          trustLevel: "trusted",
        },
      }),
    ).toBeNull();
  });
});
