import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: vi.fn(() => true),
  };
});

import { MCPSettingsManager } from "../../mcp/settings";
import {
  resolveManagedAllowedMcpTools,
  resolveManagedMcpToolAccess,
  sanitizeManagedEventPayload,
} from "../ManagedSessionService";

describe("sanitizeManagedEventPayload", () => {
  it("redacts sensitive keys and truncates oversized message bodies", () => {
    const sanitized = sanitizeManagedEventPayload({
      prompt: "hidden",
      apiKey: "secret",
      nested: {
        authorization: "Bearer abc",
      },
      message: "x".repeat(13_000),
    }) as Record<string, unknown>;

    expect(sanitized.prompt).toBe("[REDACTED]");
    expect(sanitized.apiKey).toBe("[REDACTED]");
    expect((sanitized.nested as Record<string, unknown>).authorization).toBe("[REDACTED]");
    expect(String(sanitized.message)).toContain("[... truncated");
  });
});

describe("resolveManagedAllowedMcpTools", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports a missing requirement when a referenced MCP server is missing", () => {
    vi.spyOn(MCPSettingsManager, "loadSettings").mockReturnValue({ toolNamePrefix: "mcp_" } as Any);
    vi.spyOn(MCPSettingsManager, "getServer").mockReturnValue(undefined);

    expect(
      resolveManagedAllowedMcpTools({
        allowedMcpServerIds: ["missing-server"],
      }),
    ).toEqual([]);

    expect(
      resolveManagedMcpToolAccess({
        allowedMcpServerIds: ["missing-server"],
      }),
    ).toMatchObject({
      allowedTools: [],
      hasMcpServerAllowlist: true,
      missingConnections: [
        {
          id: "missing-server",
          kind: "mcp_server",
          label: "Missing Server",
          status: "missing",
        },
      ],
    });
  });

  it("returns a prefixed allowlist when cached tool metadata is available", () => {
    vi.spyOn(MCPSettingsManager, "loadSettings").mockReturnValue({ toolNamePrefix: "mcp_" } as Any);
    vi.spyOn(MCPSettingsManager, "getServer").mockReturnValue({
      id: "server-1",
      tools: [{ name: "search" }, { name: "fetch" }],
    } as Any);

    expect(
      resolveManagedAllowedMcpTools({
        allowedMcpServerIds: ["server-1"],
      }),
    ).toEqual(["mcp_search", "mcp_fetch"]);
  });

  it("falls back to shipped registry metadata for known finance template MCP servers", () => {
    vi.spyOn(MCPSettingsManager, "loadSettings").mockReturnValue({ toolNamePrefix: "mcp_" } as Any);
    vi.spyOn(MCPSettingsManager, "getServer").mockReturnValue(undefined);

    expect(
      resolveManagedAllowedMcpTools({
        allowedMcpServerIds: [
          "factset",
          "spglobal",
          "lseg",
          "pitchbook",
          "aiera",
          "mtnewswires",
          "daloopa",
          "morningstar",
          "chronograph",
          "egnyte",
          "moodys",
        ],
      }),
    ).toEqual(
      expect.arrayContaining([
        "mcp_factset.get_financials",
        "mcp_spglobal.get_market_data",
        "mcp_lseg.get_news",
        "mcp_pitchbook.get_company_profile",
        "mcp_aiera.get_documents",
        "mcp_mtnewswires.get_news",
        "mcp_daloopa.get_documents",
        "mcp_morningstar.get_financials",
        "mcp_chronograph.get_documents",
        "mcp_egnyte.get_documents",
        "mcp_moodys.get_documents",
      ]),
    );
  });

  it("uses shipped registry metadata when an installed server has no cached tools yet", () => {
    vi.spyOn(MCPSettingsManager, "loadSettings").mockReturnValue({ toolNamePrefix: "mcp_" } as Any);
    vi.spyOn(MCPSettingsManager, "getServer").mockReturnValue({
      id: "factset",
      tools: [],
    } as Any);

    expect(
      resolveManagedAllowedMcpTools({
        allowedMcpServerIds: ["factset"],
      }),
    ).toContain("mcp_factset.get_financials");
  });
});
