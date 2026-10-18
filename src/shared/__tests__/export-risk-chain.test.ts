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

  it("separates recent untrusted context from the actual outgoing file", () => {
    const chain = buildExportRiskChain({
      directSource: {
        path: "private/report.pdf",
        sourceKind: "workspace_native",
        trustLevel: "trusted",
      },
      recentSensitiveSources: [
        {
          path: "mail/instructions.txt",
          sourceKind: "channel_attachment",
          trustLevel: "untrusted",
          sourceLabel: "Incoming email",
        },
      ],
      exportTarget: {
        toolName: "http_request",
        method: "POST",
        url: "https://user:password@uploads.example.com/submit?token=secret#private",
      },
    });
    expect(chain?.source).toBe("recent untrusted source (Incoming email)");
    expect(chain?.data).toBe("private/report.pdf");
    expect(chain?.destination).toBe("uploads.example.com");
    expect(JSON.stringify(chain)).not.toMatch(/password|token|secret|#private/);
  });

  it("keeps an unknown outgoing payload explicit instead of attributing a recent read", () => {
    expect(
      buildExportRiskChain({
        recentSensitiveSources: [
          { path: "mail/context.txt", sourceKind: "channel_attachment", trustLevel: "untrusted" },
        ],
        exportTarget: { toolName: "send_message", provider: "Teams" },
      }),
    ).toMatchObject({ data: "Data not identified", destination: "Teams" });
  });

  it("tolerates malformed legacy context without rendering arbitrary metadata", () => {
    expect(buildExportRiskChain({ exportTarget: {} } as Any)).toBeNull();
    const chain = buildExportRiskChain({
      directSource: { path: { secret: "never-render" } },
      recentSensitiveSources: "invalid",
      exportTarget: {
        toolName: "send_message",
        domain: "example.com/path?token=never-render",
        metadata: { secret: "never-render" },
      },
    } as Any);
    expect(chain).toMatchObject({
      source: "Source not recorded",
      data: "Data not identified",
      destination: "example.com",
    });
    expect(JSON.stringify(chain)).not.toContain("never-render");
  });
});
