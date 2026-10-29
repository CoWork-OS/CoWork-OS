import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { AgentMailStatus } from "../../../shared/types";
import {
  agentMailApiKeyConfigured,
  agentMailErrorMessage,
  loadAgentMailInboxApiKeys,
  loadAgentMailListEntries,
  loadAgentMailPods,
  type AgentMailKeyedApi,
} from "../agentmail-settings-model";

const componentSource = readFileSync(
  fileURLToPath(new URL("../AgentMailSettings.tsx", import.meta.url)),
  "utf8",
);

function fakeApi(): AgentMailKeyedApi & {
  listAgentMailPods: ReturnType<typeof vi.fn>;
  listAgentMailListEntries: ReturnType<typeof vi.fn>;
  listAgentMailInboxApiKeys: ReturnType<typeof vi.fn>;
} {
  return {
    listAgentMailPods: vi.fn(async () => [{ podId: "pod-1", name: "Acme" }]),
    listAgentMailListEntries: vi.fn(async () => [
      { entry: "vip@example.com", direction: "receive", listType: "allow" },
    ]),
    listAgentMailInboxApiKeys: vi.fn(async () => [{ apiKeyId: "key-1", prefix: "am_1" }]),
  } as never;
}

const UNCONFIGURED: AgentMailStatus = {
  configured: false,
  connected: false,
  realtimeConnected: false,
  connectionState: "disconnected",
};

describe("AgentMail settings without an API key", () => {
  it("treats a missing or unsaved key as not configured", () => {
    expect(agentMailApiKeyConfigured(null)).toBe(false);
    expect(agentMailApiKeyConfigured(UNCONFIGURED)).toBe(false);
    expect(agentMailApiKeyConfigured({ ...UNCONFIGURED, configured: true })).toBe(true);
  });

  it("does not call the API-backed list endpoints until a key is saved", async () => {
    const api = fakeApi();

    await expect(loadAgentMailPods(api, false)).resolves.toEqual([]);
    await expect(
      loadAgentMailListEntries(api, false, { workspaceId: "ws-1", inboxId: "inbox-1" }),
    ).resolves.toEqual([]);
    await expect(
      loadAgentMailInboxApiKeys(api, false, { workspaceId: "ws-1", inboxId: "inbox-1" }),
    ).resolves.toEqual([]);

    expect(api.listAgentMailPods).not.toHaveBeenCalled();
    expect(api.listAgentMailListEntries).not.toHaveBeenCalled();
    expect(api.listAgentMailInboxApiKeys).not.toHaveBeenCalled();
  });

  it("loads lists, keys and pods once a key is configured", async () => {
    const api = fakeApi();

    await expect(loadAgentMailPods(api, true)).resolves.toHaveLength(1);
    await expect(
      loadAgentMailListEntries(api, true, { workspaceId: "ws-1", inboxId: undefined }),
    ).resolves.toHaveLength(1);
    await expect(
      loadAgentMailInboxApiKeys(api, true, { workspaceId: "ws-1", inboxId: "inbox-1" }),
    ).resolves.toHaveLength(1);

    expect(api.listAgentMailListEntries).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      inboxId: undefined,
    });
    expect(api.listAgentMailInboxApiKeys).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      inboxId: "inbox-1",
    });
  });

  it("keeps an empty pod picker when listing pods fails", async () => {
    const api = fakeApi();
    api.listAgentMailPods.mockRejectedValueOnce(new Error("network down"));

    await expect(loadAgentMailPods(api, true)).resolves.toEqual([]);
  });

  it("strips Electron's remote-method prefix from shown errors", () => {
    expect(
      agentMailErrorMessage(
        new Error(
          "Error invoking remote method 'agentmail:listListEntries': Error: AgentMail API key is not configured",
        ),
      ),
    ).toBe("AgentMail API key is not configured");
    expect(
      agentMailErrorMessage(
        new Error("Error invoking remote method 'agentmail:listPods': TypeError: fetch failed"),
      ),
    ).toBe("fetch failed");
    expect(agentMailErrorMessage("Error: Bad request")).toBe("Bad request");
    expect(agentMailErrorMessage(new Error(""))).toBe("Something went wrong. Try again.");
  });

  it("routes every keyed list call through the guarded loaders", () => {
    expect(componentSource).not.toContain("window.electronAPI.listAgentMailListEntries(");
    expect(componentSource).not.toContain("window.electronAPI.listAgentMailInboxApiKeys(");
    expect(componentSource).not.toContain("window.electronAPI.listAgentMailPods(");
    expect(componentSource).not.toContain("Error: {error}");
    expect(componentSource).toContain(
      "Add your org API key and save to load pods, lists, and inbox keys.",
    );
    expect(componentSource).not.toMatch(/style=\{\{/);
  });
});
