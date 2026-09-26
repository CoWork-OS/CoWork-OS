import * as fs from "fs";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false } }));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  // Built connector scripts are not present in a clean checkout; the inventory
  // describes what the build ships, so treat them as present.
  const existsSync = (target: fs.PathLike) =>
    /[\\/]connectors[\\/][^\\/]+[\\/]dist[\\/]index\.js$/.test(String(target)) ||
    actual.existsSync(target);
  return { ...actual, default: { ...actual, existsSync }, existsSync };
});

vi.mock("../settings", () => ({
  MCPSettingsManager: {
    loadSettings: vi.fn(),
    addServer: vi.fn(),
    updateServer: vi.fn(),
    removeServer: vi.fn(),
  },
}));

import { getBuiltinRegistryServers } from "../registry/MCPRegistryManager";
import { CHANNEL_TYPES } from "../../gateway/channels/types";
import {
  NATIVE_INTEGRATIONS,
  buildConnectorInventory,
  classifyToolActions,
  renderInventoryMarkdown,
  resolveConnectionState,
  type SkillManifestSummary,
} from "../inventory/connector-inventory";

const repoRoot = path.resolve(__dirname, "../../../..");
const docPath = path.join(repoRoot, "docs/connector-inventory.md");

function loadSkills(): SkillManifestSummary[] {
  const dir = path.join(repoRoot, "resources/skills");
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      return {
        id: manifest.id || file.replace(/\.json$/, ""),
        name: manifest.name,
        category: manifest.category,
        requires: manifest.requires,
      };
    });
}

function buildInventory() {
  return buildConnectorInventory({
    registryEntries: getBuiltinRegistryServers(),
    channelTypes: CHANNEL_TYPES,
    skills: loadSkills(),
  });
}

describe("connector inventory", () => {
  it("matches the generated docs page", () => {
    const markdown = renderInventoryMarkdown(buildInventory());
    if (process.env.UPDATE_CONNECTOR_INVENTORY === "1") {
      fs.writeFileSync(docPath, markdown);
    }
    const current = fs.existsSync(docPath) ? fs.readFileSync(docPath, "utf8") : "";
    expect(current, "docs/connector-inventory.md is stale; run npm run connectors:inventory").toBe(
      markdown,
    );
  });

  it("has unique ids within each integration type", () => {
    const inventory = buildInventory();
    const seen = new Set<string>();
    for (const row of inventory.rows) {
      const key = `${row.integrationType}:${row.id}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });

  it("points native integrations at files that exist", () => {
    for (const native of NATIVE_INTEGRATIONS) {
      expect(fs.existsSync(path.join(repoRoot, native.source)), native.source).toBe(true);
    }
  });

  it("documents Outlook mail as Microsoft Graph-backed", () => {
    const inboxDoc = fs.readFileSync(path.join(repoRoot, "docs/inbox-agent.md"), "utf8");
    expect(inboxDoc).not.toMatch(/Microsoft Graph mail execution is still planned/);
  });

  // Matches catalogue-total claims ("**47 connectors**", "47 MCP Connectors",
  // "Install from 47 connectors", "47 connectors are available", "(47 available)")
  // without flagging ordinary sentences such as "10 connectors support OAuth".
  const TOTAL_CLAIMS = [
    /\*\*\d{2,3} (MCP |pre-built )?[Cc]onnectors\*\*/,
    /\b\d{2,3} (MCP|pre-built|shipped( MCP)?) [Cc]onnectors\b/,
    /\bfrom \d{2,3} connectors\b/,
    /\b\d{2,3} connectors (are|is) (available|included)/,
    /\(\d{2,3} (available|connectors supported)\)/,
  ];

  it("does not hard-code connector totals in docs", () => {
    const files = [
      "README.md",
      "docs/enterprise-connectors.md",
      "docs/getting-started.md",
      "docs/features.md",
      "docs/showcase.md",
    ];
    for (const file of files) {
      const text = fs.readFileSync(path.join(repoRoot, file), "utf8");
      for (const pattern of TOTAL_CLAIMS) expect(text, `${file} ${pattern}`).not.toMatch(pattern);
    }
  });

  it("recognises total claims but not ordinary counts", () => {
    const flagged = (text: string) => TOTAL_CLAIMS.some((pattern) => pattern.test(text));
    expect(flagged("**47 connectors** are included")).toBe(true);
    expect(flagged("- **47 MCP Connectors**: pre-built")).toBe(true);
    expect(flagged("Install from 47 connectors")).toBe(true);
    expect(flagged("44 shipped MCP connectors")).toBe(true);
    expect(flagged("10 connectors support OAuth")).toBe(false);
  });

  it("classifies read and write tools", () => {
    expect(classifyToolActions(["maps.search_places", "maps.timezone"])).toEqual(["read"]);
    expect(
      classifyToolActions(["home-assistant.call_service", "home-assistant.get_state"]),
    ).toEqual(["read", "write"]);
  });

  it("resolves runtime connection state", () => {
    expect(resolveConnectionState({ configured: false, connected: false })).toBe("available");
    expect(resolveConnectionState({ configured: true, connected: false })).toBe("configured");
    expect(resolveConnectionState({ configured: true, connected: true })).toBe("connected");
    expect(
      resolveConnectionState({ configured: true, connected: true, lastSuccessfulCallAt: 1 }),
    ).toBe("exercised");
  });
});
