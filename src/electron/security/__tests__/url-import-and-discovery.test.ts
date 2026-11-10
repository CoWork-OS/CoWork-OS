import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ fetch: vi.fn(), lookup: vi.fn(), root: "" }));
vi.mock("node-fetch/node", () => ({ fetch: transport.fetch }));
vi.mock("node:dns/promises", () => ({ lookup: transport.lookup }));
vi.mock("dns", async () => {
  const actual = await vi.importActual<typeof import("dns")>("dns");
  return { ...actual, promises: { ...actual.promises, lookup: transport.lookup } };
});
vi.mock("../../admin/policies", () => ({
  loadPolicies: () => ({
    runtime: {
      network: {
        defaultAction: "allow",
        allowShellNetwork: true,
        allowedDomains: [],
        blockedDomains: [],
        allowedInternalHosts: [],
      },
    },
  }),
}));
vi.mock("../../security/capability-bundle-security", () => ({
  getCapabilityBundleSecurityService: () => ({
    scanSkill: vi.fn(),
    scanPluginPack: vi.fn(),
    activatePluginPack: vi.fn(),
  }),
}));
vi.mock("electron", () => ({ app: { getPath: () => transport.root, getVersion: () => "test" } }));

import { SkillRegistry } from "../../agent/skill-registry";
import { installFromUrl as installPlugin } from "../../extensions/pack-installer";
import { GuardrailManager } from "../../guardrails/guardrail-manager";
import { LLMProviderFactory } from "../../agent/llm/provider-factory";
import { browserProviderDiagnosticFetch } from "../../agent/llm/provider-diagnostic-fetch";
import { createBrowserSettingsDefinitions } from "../../../host/services/browser-settings-methods";

function response(
  status = 200,
  body = JSON.stringify({
    data: [{ id: "fixture-model", name: "Fixture", context_length: 4096 }],
    models: [{ name: "fixture-model", size: 1, modified_at: "today" }],
  }),
  headers: Record<string, string> = {},
) {
  const values = new Headers({ "content-type": "application/json", ...headers });
  Object.assign(values, { raw: () => ({}) });
  return {
    status,
    statusText: "fixture",
    headers: values,
    body: Readable.from([Buffer.from(body)]),
  };
}
let settings: Any;
beforeEach(() => {
  transport.root = fs.mkdtempSync(path.join(os.tmpdir(), "url-security-"));
  transport.fetch.mockReset().mockImplementation(async () => response());
  transport.lookup.mockReset().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  for (const key of [
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "NO_PROXY",
    "no_proxy",
  ])
    vi.stubEnv(key, "");
  vi.spyOn(GuardrailManager, "isDomainAllowed").mockReturnValue(true);
  settings = { providerType: "openai", modelKey: "gpt-4o" };
  vi.spyOn(LLMProviderFactory, "loadSettings").mockImplementation(() => settings);
  vi.spyOn(LLMProviderFactory, "saveSettings").mockImplementation(() => {});
  vi.spyOn(LLMProviderFactory, "getConfigStatus").mockReturnValue({
    providers: [{ type: "atomic-chat" }],
  } as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(transport.root, { recursive: true, force: true });
});

const browser = (name: string, args: unknown[]) => {
  const method = createBrowserSettingsDefinitions()[name];
  return method.handler(method.validate?.(args) ?? args, {} as never);
};
const discoveryCases: Array<[string, unknown[]]> = [
  ["getOllamaModels", ["https://models.example"]],
  ["getOpenRouterModels", ["fixture-key", "https://models.example/v1"]],
  ["getGroqModels", ["fixture-key", "https://models.example/v1"]],
  ["getKimiModels", ["fixture-key", "https://models.example/v1"]],
  [
    "getOpenAICompatibleModels",
    ["https://models.example/v1", "fixture-key", { cacheModels: false }],
  ],
  ["getOpenRouterImageModels", ["fixture-key", "https://models.example/v1"]],
  [
    "refreshCustomProviderModels",
    ["atomic-chat", { apiKey: "fixture-key", baseUrl: "https://models.example/v1" }],
  ],
  ["discoverAtomicChatModels", [{ apiKey: "fixture-key", baseUrl: "https://models.example/v1" }]],
];

describe("URL import connection boundary", () => {
  it.each(["skill", "plugin"])(
    "rejects private and denied-domain redirects before the next %s request",
    async (kind) => {
      const skill = new SkillRegistry({ managedSkillsDir: path.join(transport.root, "skills") });
      const install = kind === "skill" ? skill.installFromUrl.bind(skill) : installPlugin;
      for (const target of ["http://169.254.169.254/latest", "https://denied.example/bundle"]) {
        transport.fetch.mockClear().mockResolvedValue(response(302, "", { location: target }));
        vi.mocked(GuardrailManager.isDomainAllowed).mockImplementation(
          (url) => new URL(url).hostname !== "denied.example",
        );
        const result = await install("https://public.example/manifest.json");
        expect(result.success).toBe(false);
        expect(transport.fetch).toHaveBeenCalledTimes(1);
      }
    },
  );
  it("retains HTTPS on every plugin manifest hop", async () => {
    transport.fetch.mockResolvedValue(
      response(302, "", { location: "http://public.example/manifest.json" }),
    );
    const result = await installPlugin("https://public.example/start");
    expect(result).toMatchObject({ success: false, error: expect.stringContaining("https") });
    expect(transport.fetch).toHaveBeenCalledOnce();
  });
  it.each(["skill", "plugin"])(
    "rejects a %s public hostname resolving internally without sending a request",
    async (kind) => {
      transport.lookup.mockResolvedValue([{ address: "10.2.3.4", family: 4 }]);
      const skill = new SkillRegistry({ managedSkillsDir: path.join(transport.root, "skills") });
      const result = await (kind === "skill"
        ? skill.installFromUrl("https://public.example/skill.json")
        : installPlugin("https://public.example/manifest.json"));
      expect(result.success).toBe(false);
      expect(transport.fetch).not.toHaveBeenCalled();
    },
  );
  it("also enforces the transport for the ClawHub download branch", async () => {
    const skill = new SkillRegistry({ managedSkillsDir: path.join(transport.root, "skills") });
    transport.fetch.mockResolvedValue(response(302, "", { location: "http://169.254.169.254/" }));
    await expect((skill as Any).downloadClawHubFiles("fixture", "1")).rejects.toThrow();
    expect(transport.fetch).toHaveBeenCalledOnce();
  });
});

describe("browser provider discovery connection boundary", () => {
  it.each(["azure", "azure-anthropic"])(
    "checks the actual %s connection-test transport",
    async (providerType) => {
      const configuration = {
        apiKey: "fixture-key",
        endpoint: "https://models.example",
        deployment: "fixture-deployment",
      };
      const incoming = {
        providerType,
        modelKey: "fixture-deployment",
        [providerType === "azure" ? "azure" : "azureAnthropic"]: configuration,
      };
      transport.fetch.mockResolvedValue(
        response(302, "", { location: "http://169.254.169.254/latest" }),
      );
      const result = await browser("testLLMProvider", [incoming]);
      expect(result).toMatchObject({ success: false });
      expect(transport.fetch).toHaveBeenCalledOnce();
      transport.fetch.mockClear().mockResolvedValue(response());
      expect(await browser("testLLMProvider", [incoming])).toMatchObject({ success: true });
      expect(transport.fetch).toHaveBeenCalledOnce();
    },
  );

  it.each(discoveryCases)("checks redirects for %s", async (name, args) => {
    transport.fetch.mockResolvedValue(
      response(302, "", { location: "http://169.254.169.254/latest" }),
    );
    try {
      await browser(name, args);
    } catch {
      /* structured discovery failure or thrown failure are both safe */
    }
    expect(transport.fetch).toHaveBeenCalledOnce();
  });
  it.each(discoveryCases.slice(0, 5))("preserves normal discovery for %s", async (name, args) => {
    const result = await browser(name, args);
    expect(JSON.stringify(result)).toContain("fixture-model");
    expect(transport.fetch).toHaveBeenCalledOnce();
  });
  it("refuses a connection-time DNS change after browser preflight", async () => {
    transport.lookup
      .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
      .mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
    await expect(
      browser("getOpenAICompatibleModels", [
        "https://public.example/v1",
        "fixture-key",
        { cacheModels: false },
      ]),
    ).rejects.toThrow();
    expect(transport.fetch).not.toHaveBeenCalled();
  });
  it("preserves saved-key destination binding", async () => {
    settings.openrouter = { apiKey: "saved-fixture-key", baseUrl: "https://trusted.example/v1" };
    await expect(
      browser("getOpenRouterModels", [undefined, "https://other.example/v1"]),
    ).rejects.toThrow();
    expect(transport.fetch).not.toHaveBeenCalled();
  });
  it("permits explicit local discovery but refuses cloud loopback destinations", async () => {
    await browser("getOllamaModels", ["http://127.0.0.1:11434"]);
    expect(transport.fetch).toHaveBeenCalledOnce();
    transport.fetch.mockClear();
    await expect(
      browserProviderDiagnosticFetch(false)("http://127.0.0.1:11434/models"),
    ).rejects.toThrow();
    expect(transport.fetch).not.toHaveBeenCalled();
  });
  it("pins the socket lookup and strips credentials on cross-origin redirects", async () => {
    transport.fetch
      .mockResolvedValueOnce(response(302, "", { location: "https://other.example/models" }))
      .mockResolvedValueOnce(response());
    await browserProviderDiagnosticFetch(false)("https://models.example/models", {
      headers: { Authorization: "Bearer fixture" },
    });
    expect(transport.fetch).toHaveBeenCalledTimes(2);
    expect(new Headers(transport.fetch.mock.calls[1][1].headers).has("authorization")).toBe(false);
    const agent = transport.fetch.mock.calls[0][1].agent;
    transport.lookup.mockClear().mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    const resolved = await new Promise<unknown>((resolve, reject) =>
      agent.options.lookup(
        "models.example",
        { all: true },
        (error: Error | null, values: unknown) => (error ? reject(error) : resolve(values)),
      ),
    );
    expect(resolved).toEqual([{ address: "8.8.8.8", family: 4 }]);
    expect(transport.lookup).not.toHaveBeenCalled();
  });
  it.each(["skill", "plugin", "discovery"])(
    "fails closed for an unpinnable proxy on %s",
    async (kind) => {
      vi.stubEnv("HTTPS_PROXY", "http://proxy.example:8080");
      if (kind === "discovery")
        await expect(
          browserProviderDiagnosticFetch(false)("https://models.example/models"),
        ).rejects.toThrow(/pinning|proxies/);
      else {
        const skill = new SkillRegistry({ managedSkillsDir: path.join(transport.root, "skills") });
        const result = await (kind === "skill"
          ? skill.installFromUrl("https://public.example/skill.json")
          : installPlugin("https://public.example/manifest.json"));
        expect(result.success).toBe(false);
      }
      expect(transport.fetch).not.toHaveBeenCalled();
    },
  );
});
