/**
 * In-app Workday agent setup against a local fake Workday: admin sign-in with
 * Basic + body client credentials, the ASOR agentDefinition and
 * agentResourceSearch APIs, WID verification before a save, and the 415
 * multipart fallback. The fake runs on http 127.0.0.1 through the test-only
 * endpoint override; production endpoints are https Workday hosts only.
 */
import * as http from "node:http";
import * as https from "node:https";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  stored: undefined as Record<string, unknown> | undefined,
  blocked: [] as string[],
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn().mockReturnValue("/mock/user/data") },
  safeStorage: {
    isEncryptionAvailable: vi.fn().mockReturnValue(false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

vi.mock("../../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: {
    isInitialized: () => true,
    getInstance: () => ({
      save: (_category: string, settings: Record<string, unknown>) => {
        state.stored = structuredClone(settings);
      },
      load: () => (state.stored ? structuredClone(state.stored) : undefined),
      exists: () => state.stored !== undefined,
      checkHealth: () => "ok",
    }),
  },
}));

vi.mock("../../../admin/policies", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../admin/policies")>()),
  loadPolicies: vi.fn(() => ({ connectors: { blocked: [...state.blocked] } })),
}));

vi.mock("../../client/MCPClientManager", () => ({
  MCPClientManager: {
    getInstance: () => ({
      getServerStatus: () => null,
      disconnectServer: async () => undefined,
      connectServer: async () => undefined,
    }),
  },
}));

import type { WorkdayAgentModel } from "../../../../shared/types";
import { MASKED_VALUE, MCPSettingsManager } from "../../settings";
import { isMcpSignInCancelled } from "../mcp-oauth";
import { addRemoteOAuthServer } from "../mcp-server-authorization";
import {
  agentModelFromDefinition,
  buildAgentDefinitionBody,
  cancelWorkdayAdminSignIn,
  deriveWorkdayServicesHost,
  listAgentDefinitions,
  normalizeWorkdayHost,
  parseAgentResources,
  saveAgentDefinition,
  saveWorkdayAdminConnection,
  searchAgentResources,
  signInWorkdayAdmin,
  signOutWorkdayAdmin,
  workdayAdminEndpoints,
  type WorkdayAdminTransport,
} from "../workday-agent-setup";

const TENANT = "cdjqxhyhvf_extdev";
const ABSENCE_WID = "3cf962648a6a10001482cdbe30920000";
const PAY_WID = "aaaabbbbccccddddeeeeffff00001111";
const OPERATION_WID = "0123456789abcdef0123456789abcdef";
const SERVICE_DATES_WID = "c545581f797e100013a3ae9e78560000";

/** The definition body verified live against a Workday Developer tenant. */
const LIVE_BODY = {
  name: "CoWork",
  description: "CoWork OS desktop agent",
  version: "1.0",
  url: "https://github.com/CoWork-OS/CoWork-OS",
  documentationUrl: "https://github.com/CoWork-OS/CoWork-OS/blob/main/docs/remote-mcp-oauth.md",
  provider: { id: "Provider=SELF-BUILT" },
  platform: { id: "Platform=OTHER" },
  capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
  skills: [
    {
      id: "time_off_balances",
      name: "Time Off Balances",
      description: "Answers time off balance questions",
      inputModes: [{ type: "application/json" }],
      outputModes: [{ type: "application/json" }],
    },
  ],
  workdayConfig: [
    {
      skillId: "time_off_balances",
      executionMode: { id: "Mode=Delegate" },
      workdayResources: [
        {
          description: "Find Absence Balances",
          tool_name: "find_absence_balances",
          agent_resource: { id: ABSENCE_WID },
        },
      ],
    },
  ],
};

const MODEL: WorkdayAgentModel = {
  name: "CoWork",
  description: "CoWork OS desktop agent",
  version: "1.0",
  skills: [
    {
      id: "time_off_balances",
      name: "Time Off Balances",
      description: "Answers time off balance questions",
      executionMode: "Delegate",
      tools: [
        {
          toolName: "find_absence_balances",
          wid: ABSENCE_WID,
          description: "Find Absence Balances",
        },
      ],
    },
  ],
};

interface FakeRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface FakeWorkday {
  base: string;
  requests: FakeRequest[];
  tokenForms: URLSearchParams[];
  posted: Array<{ contentType: string; body: Record<string, unknown> }>;
  reject415: boolean;
  definitions: unknown[];
}

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

const catalog = [
  { id: ABSENCE_WID, descriptor: "find_absence_balances" },
  { id: PAY_WID, descriptor: "get_pay_slips" },
  { id: OPERATION_WID, descriptor: "Get Workers" },
  // Like the live catalog: found by its words, never by its full snake_case name.
  { id: SERVICE_DATES_WID, descriptor: "find_service_dates_for_worker", wordsOnly: true },
];

async function startFakeWorkday(): Promise<FakeWorkday> {
  const fake: FakeWorkday = {
    base: "",
    requests: [],
    tokenForms: [],
    posted: [],
    reject415: false,
    definitions: [],
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url || "/", "http://127.0.0.1");
      fake.requests.push({
        method: req.method || "",
        path: url.pathname,
        headers: req.headers,
        body: raw.toString(),
      });
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === `/ccx/oauth2/${TENANT}/token`) {
        const form = new URLSearchParams(raw.toString());
        fake.tokenForms.push(form);
        const basic = `Basic ${Buffer.from("admin-client:admin-secret").toString("base64")}`;
        if (req.headers.authorization !== basic || form.get("client_secret") !== "admin-secret")
          return json(401, { error: "invalid_client" });
        return json(200, { access_token: "admin-token", token_type: "Bearer", expires_in: 3600 });
      }
      const asor = `/ccx/api/asor/v1/${TENANT}/`;
      if (!url.pathname.startsWith(asor)) return json(404, {});
      if (req.headers.authorization !== "Bearer admin-token")
        return json(401, { error: "invalid token" });
      const route = url.pathname.slice(asor.length);
      if (route === "agentResourceSearch" && req.method === "GET") {
        const q = (url.searchParams.get("searchString") || "").toLowerCase();
        const words = q.split(/\s+/).filter(Boolean);
        const data = catalog
          .filter((row) =>
            row.wordsOnly
              ? !q.includes("_") && words.every((word) => row.descriptor.includes(word))
              : row.descriptor.toLowerCase().includes(q),
          )
          .map(({ id, descriptor }) => ({ id, descriptor }));
        return json(200, { total: data.length, data });
      }
      if (route === "agentDefinition" && req.method === "GET")
        return json(200, { total: fake.definitions.length, data: fake.definitions });
      if (route === "agentDefinition" && req.method === "POST") {
        const contentType = req.headers["content-type"] || "";
        if (contentType.startsWith("application/json")) {
          if (fake.reject415) return json(415, { error: "Unsupported Media Type" });
          const body = JSON.parse(raw.toString());
          fake.posted.push({ contentType, body });
          return json(201, { id: "agent-wid-1", ...body });
        }
        const form = await new Response(raw, {
          headers: { "content-type": contentType },
        }).formData();
        const body = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
        fake.posted.push({ contentType, body });
        return json(201, {
          id: "agent-wid-2",
          name: body.name,
          skills: JSON.parse(String(body.skills)),
          workdayConfig: JSON.parse(String(body.workdayConfig)),
        });
      }
      return json(404, {});
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

async function freePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function transportFor(fake: FakeWorkday): Promise<WorkdayAdminTransport> {
  return {
    fetchImpl: globalThis.fetch,
    endpoints: (_connection, tenant) => ({
      authorizationUrl: `${fake.base}/${tenant}/authorize`,
      tokenUrl: `${fake.base}/ccx/oauth2/${tenant}/token`,
      asorBaseUrl: `${fake.base}/ccx/api/asor/v1/${tenant}`,
    }),
    redirectUri: `https://127.0.0.1:${await freePort()}/oauth/callback`,
  };
}

/** Stands in for the browser: the tenant redirects back to the loopback with a code. */
function visitCallback(authorizeUrl: string): Promise<number> {
  const opened = new URL(authorizeUrl);
  const callback = new URL(opened.searchParams.get("redirect_uri")!);
  callback.searchParams.set("code", "admin-code");
  callback.searchParams.set("state", opened.searchParams.get("state")!);
  return new Promise((resolve, reject) => {
    https
      .get(callback, { rejectUnauthorized: false, agent: false }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      })
      .on("error", reject);
  });
}

function addWorkdayServer(name = "Workday"): string {
  return addRemoteOAuthServer({
    name,
    kind: "workday",
    region: "odp",
    tenant: TENANT,
    grant: "authorization_code",
    clientId: "agent-client",
    clientSecret: "agent-secret",
  }).id;
}

function saveConnection(serverId: string, extra: Record<string, unknown> = {}) {
  return saveWorkdayAdminConnection({
    serverId,
    tenantHost: "odpimpl.wd119.myworkday.com",
    clientId: "admin-client",
    clientSecret: "admin-secret",
    ...extra,
  });
}

async function signedIn(fake: FakeWorkday, transport: WorkdayAdminTransport): Promise<string> {
  const serverId = addWorkdayServer();
  saveConnection(serverId);
  let opened = "";
  await signInWorkdayAdmin(serverId, {
    ...transport,
    openUrl: async (url) => {
      opened = url;
      await visitCallback(url);
    },
  });
  expect(new URL(opened).pathname).toBe(`/${TENANT}/authorize`);
  return serverId;
}

beforeEach(() => {
  state.stored = undefined;
  state.blocked = [];
  MCPSettingsManager.clearCache();
});

describe("Workday admin hosts", () => {
  it("accepts tenant hosts on Workday domains and derives the services host", () => {
    expect(normalizeWorkdayHost("odpimpl.wd119.myworkday.com")).toBe("odpimpl.wd119.myworkday.com");
    expect(normalizeWorkdayHost(" https://ODPIMPL.wd119.myworkday.com/ ")).toBe(
      "odpimpl.wd119.myworkday.com",
    );
    expect(deriveWorkdayServicesHost("odpimpl.wd119.myworkday.com")).toBe(
      "odpimpl-services1.wd119.myworkday.com",
    );
    expect(deriveWorkdayServicesHost("odpimpl-services1.wd119.myworkday.com")).toBe(
      "odpimpl-services1.wd119.myworkday.com",
    );
    expect(workdayAdminEndpoints({ tenantHost: "odpimpl.wd119.myworkday.com" }, TENANT)).toEqual({
      authorizationUrl: `https://odpimpl.wd119.myworkday.com/${TENANT}/authorize`,
      tokenUrl: `https://odpimpl-services1.wd119.myworkday.com/ccx/oauth2/${TENANT}/token`,
      asorBaseUrl: `https://odpimpl-services1.wd119.myworkday.com/ccx/api/asor/v1/${TENANT}`,
    });
  });

  it("rejects http, other domains, paths and the agent gateway", () => {
    for (const bad of [
      "http://odpimpl.wd119.myworkday.com",
      "evil.example.com",
      "odpimpl.wd119.myworkday.com.evil.example",
      "myworkday.com",
      "https://odpimpl.wd119.myworkday.com/other",
      "https://odpimpl.wd119.myworkday.com:8443",
      "https://user@odpimpl.wd119.myworkday.com",
      "odp.agent.workday.com",
      "127.0.0.1",
      "",
    ])
      expect(() => normalizeWorkdayHost(bad)).toThrow();
    expect(() => workdayAdminEndpoints({ tenantHost: "a.wd5.myworkday.com" }, "../x")).toThrow(
      /tenant/,
    );
  });
});

describe("Workday admin connection", () => {
  it("stores the secret encrypted with the settings, masks it and keeps it when blank", () => {
    const serverId = addWorkdayServer();
    const summary = saveConnection(serverId, { usePkce: true });
    expect(summary).toEqual({
      tenant: TENANT,
      tenantHost: "odpimpl.wd119.myworkday.com",
      servicesHost: "odpimpl-services1.wd119.myworkday.com",
      clientId: "admin-client",
      hasClientSecret: true,
      usePkce: true,
      signedIn: false,
    });
    expect(JSON.stringify(summary)).not.toContain("admin-secret");
    for (const clientSecret of [undefined, "", "  ", MASKED_VALUE]) {
      saveConnection(serverId, { clientSecret });
      expect(MCPSettingsManager.getServer(serverId)?.workdayAdmin?.clientSecret).toBe(
        "admin-secret",
      );
    }
    const display = MCPSettingsManager.getSettingsForDisplay().servers.find(
      (server) => server.id === serverId,
    );
    expect(display?.workdayAdmin?.clientSecret).toBe(MASKED_VALUE);
    expect(JSON.stringify(display)).not.toContain("admin-secret");
    // A masked secret sent back through a generic update never replaces the stored one.
    MCPSettingsManager.updateServer(serverId, {
      workdayAdmin: { ...display!.workdayAdmin! },
    });
    expect(MCPSettingsManager.getServer(serverId)?.workdayAdmin?.clientSecret).toBe("admin-secret");
    saveConnection(serverId, { clientSecret: "new-secret" });
    expect(MCPSettingsManager.getServer(serverId)?.workdayAdmin?.clientSecret).toBe("new-secret");
    // The MCP server's own sign-in settings are untouched.
    expect(MCPSettingsManager.getServer(serverId)?.auth?.clientSecret).toBe("agent-secret");
  });

  it("stores a services host override and refuses non-Workday hosts and servers", () => {
    const serverId = addWorkdayServer();
    expect(
      saveConnection(serverId, { servicesHost: "wd2-impl-services1.workday.com" }).servicesHost,
    ).toBe("wd2-impl-services1.workday.com");
    expect(() => saveConnection(serverId, { tenantHost: "evil.example.com" })).toThrow(
      /Workday host/,
    );
    expect(() => saveConnection(serverId, { servicesHost: "http://x.wd5.myworkday.com" })).toThrow(
      /https/,
    );
    const custom = addRemoteOAuthServer({
      name: "Custom",
      kind: "custom",
      grant: "authorization_code",
      clientId: "c",
      url: "https://a.example/mcp",
      tokenUrl: "https://a.example/token",
      authorizationUrl: "https://a.example/authorize",
    }).id;
    expect(() => saveConnection(custom)).toThrow(/Workday servers/);
  });
});

describe("Workday admin sign-in", () => {
  it("signs in with Basic and body client credentials and keeps the token in memory", async () => {
    const fake = await startFakeWorkday();
    const transport = await transportFor(fake);
    const serverId = addWorkdayServer();
    saveConnection(serverId);
    let opened = "";
    const result = await signInWorkdayAdmin(serverId, {
      ...transport,
      openUrl: async (url) => {
        opened = url;
        await visitCallback(url);
      },
    });
    const authorize = new URL(opened);
    expect(authorize.searchParams.get("response_type")).toBe("code");
    expect(authorize.searchParams.get("client_id")).toBe("admin-client");
    expect(authorize.searchParams.get("code_challenge")).toBeNull();
    const form = fake.tokenForms[0]!;
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "authorization_code",
      code: "admin-code",
      redirect_uri: transport.redirectUri,
      client_id: "admin-client",
      client_secret: "admin-secret",
    });
    expect(Object.keys(result)).toEqual(["expiresAt"]);
    expect(result.expiresAt! - Date.now()).toBeGreaterThan(3_500_000);
    // Never persisted, never shown.
    expect(JSON.stringify(state.stored)).not.toContain("admin-token");
    expect(JSON.stringify(MCPSettingsManager.getSettingsForDisplay())).not.toContain("admin-token");
    expect(saveConnection(serverId).signedIn).toBe(true);
    // Changing the connection signs the admin out.
    expect(saveConnection(serverId, { clientId: "other-client" }).signedIn).toBe(false);
    await expect(listAgentDefinitions(serverId, transport)).resolves.toEqual({
      status: "signed_out",
    });
  });

  it("sends a PKCE challenge and verifier only when the connection asks for it", async () => {
    const fake = await startFakeWorkday();
    const transport = await transportFor(fake);
    const serverId = addWorkdayServer();
    saveConnection(serverId, { usePkce: true });
    let challenge = "";
    await signInWorkdayAdmin(serverId, {
      ...transport,
      openUrl: async (url) => {
        challenge = new URL(url).searchParams.get("code_challenge") || "";
        await visitCallback(url);
      },
    });
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fake.tokenForms[0]!.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{64}$/);
  });

  it("cancels quietly before any token request", async () => {
    const fake = await startFakeWorkday();
    const transport = await transportFor(fake);
    const serverId = addWorkdayServer();
    saveConnection(serverId);
    let opened!: () => void;
    const openedPromise = new Promise<void>((resolve) => (opened = resolve));
    const pending = signInWorkdayAdmin(serverId, { ...transport, openUrl: () => opened() });
    await openedPromise;
    expect(cancelWorkdayAdminSignIn(serverId)).toBe(true);
    const error = await pending.catch((reason: unknown) => reason);
    expect(isMcpSignInCancelled(error)).toBe(true);
    expect(fake.tokenForms).toHaveLength(0);
    expect(cancelWorkdayAdminSignIn(serverId)).toBe(false);
  });

  it("is refused for a server blocked by admin policy", async () => {
    const fake = await startFakeWorkday();
    const transport = await transportFor(fake);
    const serverId = addWorkdayServer("Blocked Workday");
    saveConnection(serverId);
    state.blocked = ["Blocked Workday"];
    await expect(
      signInWorkdayAdmin(serverId, { ...transport, openUrl: () => undefined }),
    ).rejects.toThrow(/blocked by your administrator/);
    await expect(listAgentDefinitions(serverId, transport)).rejects.toThrow(
      /blocked by your administrator/,
    );
    expect(fake.requests).toHaveLength(0);
  });
});

describe("Workday agent definitions", () => {
  it("searches the catalog for MCP tools by default", async () => {
    const fake = await startFakeWorkday();
    const transport = await transportFor(fake);
    const serverId = await signedIn(fake, transport);
    const mcpOnly = await searchAgentResources(serverId, "e", transport);
    expect(mcpOnly.resources.map((row) => row.toolName)).toEqual([
      "find_absence_balances",
      "get_pay_slips",
      "find_service_dates_for_worker",
    ]);
    expect(mcpOnly.matched).toBe(4);
    const all = await searchAgentResources(serverId, "e", { ...transport, mcpOnly: false });
    expect(all.resources).toContainEqual({
      wid: OPERATION_WID,
      toolName: "Get Workers",
      kind: "operation",
    });
    const search = fake.requests.find((request) => request.path.endsWith("agentResourceSearch"));
    expect(search?.headers.authorization).toBe("Bearer admin-token");
  });

  it("finds a tool that the catalog only matches by its words", async () => {
    const fake = await startFakeWorkday();
    const transport = await transportFor(fake);
    const serverId = await signedIn(fake, transport);
    const found = await searchAgentResources(serverId, "find_service_dates_for_worker", transport);
    expect(found.resources[0]).toEqual({
      wid: SERVICE_DATES_WID,
      toolName: "find_service_dates_for_worker",
      kind: "mcp",
    });
    const model = structuredClone(MODEL);
    model.skills[0]!.tools.push({
      toolName: "find_service_dates_for_worker",
      wid: SERVICE_DATES_WID,
      description: "",
    });
    const saved = await saveAgentDefinition(serverId, model, transport);
    expect(saved.status).toBe("saved");
    expect(fake.posted).toHaveLength(1);
  });

  it("refuses to post while a tool WID is missing from the catalog", async () => {
    const fake = await startFakeWorkday();
    const transport = await transportFor(fake);
    const serverId = await signedIn(fake, transport);
    const model = structuredClone(MODEL);
    model.skills[0]!.tools.push(
      { toolName: "get_pay_slips", wid: "ffffffffffffffffffffffffffffffff", description: "" },
      { toolName: "find_absence_balances", wid: PAY_WID, description: "" },
    );
    const result = await saveAgentDefinition(serverId, model, transport);
    expect(result).toEqual({
      status: "missing_tools",
      missing: [
        { toolName: "find_absence_balances", wid: PAY_WID, reason: "not_found" },
        { toolName: "get_pay_slips", wid: "ffffffffffffffffffffffffffffffff", reason: "not_found" },
      ],
    });
    expect(fake.requests.filter((request) => request.method === "POST")).toHaveLength(1); // token only
    expect(fake.posted).toHaveLength(0);
  });

  it("posts the exact agentDefinition JSON shape Workday accepts", async () => {
    const fake = await startFakeWorkday();
    const transport = await transportFor(fake);
    const serverId = await signedIn(fake, transport);
    const result = await saveAgentDefinition(serverId, MODEL, transport);
    expect(fake.posted).toHaveLength(1);
    expect(fake.posted[0]!.contentType).toBe("application/json");
    expect(fake.posted[0]!.body).toEqual(LIVE_BODY);
    expect(result).toEqual({
      status: "saved",
      id: "agent-wid-1",
      name: "CoWork",
      skills: ["time_off_balances"],
      toolCount: 1,
    });
  });

  it("retries as multipart form data when JSON is refused with 415", async () => {
    const fake = await startFakeWorkday();
    fake.reject415 = true;
    const transport = await transportFor(fake);
    const serverId = await signedIn(fake, transport);
    const result = await saveAgentDefinition(serverId, MODEL, transport);
    expect(fake.posted).toHaveLength(1);
    expect(fake.posted[0]!.contentType).toMatch(/^multipart\/form-data; boundary=/);
    const fields = fake.posted[0]!.body;
    expect(fields.name).toBe("CoWork");
    expect(fields.version).toBe("1.0");
    expect(JSON.parse(String(fields.workdayConfig))).toEqual(LIVE_BODY.workdayConfig);
    expect(JSON.parse(String(fields.provider))).toEqual({ id: "Provider=SELF-BUILT" });
    expect(result).toMatchObject({ status: "saved", id: "agent-wid-2", toolCount: 1 });
  });

  it("rejects an invalid model before any request", async () => {
    const fake = await startFakeWorkday();
    const transport = await transportFor(fake);
    const serverId = await signedIn(fake, transport);
    const before = fake.requests.length;
    for (const bad of [
      { ...MODEL, name: "x".repeat(101) },
      { ...MODEL, skills: [{ ...MODEL.skills[0]!, id: "Bad-Id" }] },
      {
        ...MODEL,
        skills: [{ ...MODEL.skills[0]!, tools: [{ ...MODEL.skills[0]!.tools[0]!, wid: "123" }] }],
      },
      { ...MODEL, skills: [{ ...MODEL.skills[0]!, executionMode: "Sometimes" }] },
      { ...MODEL, skills: [MODEL.skills[0]!, MODEL.skills[0]!] },
      { ...MODEL, url: "http://insecure.example" },
      { ...MODEL, extra: true },
    ])
      await expect(saveAgentDefinition(serverId, bad, transport)).rejects.toThrow(
        /Invalid agent definition/,
      );
    expect(fake.requests.length).toBe(before);
  });

  it("lists definitions as editable models and maps them back to the same body", async () => {
    const fake = await startFakeWorkday();
    fake.definitions = [
      {
        id: "def-1",
        name: "CoWork",
        description: "CoWork OS desktop agent",
        version: "1.0",
        url: "https://github.com/CoWork-OS/CoWork-OS",
        skills: [
          {
            id: "time_off_balances",
            name: "Time Off Balances",
            description: "Answers time off balance questions",
          },
        ],
        workdayConfig: [
          {
            skillId: "time_off_balances",
            executionMode: { id: "9f8e7d6c5b4a", descriptor: "Delegate" },
            workdayResources: [
              {
                description: "Find Absence Balances",
                tool_name: "find_absence_balances",
                agent_resource: { id: ABSENCE_WID, descriptor: "find_absence_balances" },
              },
            ],
          },
          {
            skill: { descriptor: "pay_review" },
            executionMode: { id: "1234", descriptor: "Ambient" },
            workdayResources: [{ agent_resource: { id: PAY_WID, descriptor: "get_pay_slips" } }],
          },
        ],
      },
    ];
    const transport = await transportFor(fake);
    const serverId = await signedIn(fake, transport);
    const listed = await listAgentDefinitions(serverId, transport);
    expect(listed.status).toBe("ok");
    if (listed.status !== "ok") return;
    expect(listed.total).toBe(1);
    const model = listed.agents[0]!;
    expect(model).toEqual({
      id: "def-1",
      name: "CoWork",
      description: "CoWork OS desktop agent",
      version: "1.0",
      url: "https://github.com/CoWork-OS/CoWork-OS",
      skills: [
        { ...MODEL.skills[0]! },
        {
          id: "pay_review",
          name: "pay_review",
          description: "",
          executionMode: "Ambient",
          tools: [{ toolName: "get_pay_slips", wid: PAY_WID, description: "get_pay_slips" }],
        },
      ],
    });
    const body = buildAgentDefinitionBody({ ...model, skills: [model.skills[0]!] });
    expect(body).toEqual(LIVE_BODY);
    expect(buildAgentDefinitionBody(model).workdayConfig).toContainEqual({
      skillId: "pay_review",
      executionMode: { id: "Mode=Ambient" },
      workdayResources: [
        {
          description: "get_pay_slips",
          tool_name: "get_pay_slips",
          agent_resource: { id: PAY_WID },
        },
      ],
    });
    expect(agentModelFromDefinition({}).skills).toEqual([]);
  });

  it("forgets the admin token on a 401 and reports sign-in required", async () => {
    const fake = await startFakeWorkday();
    const transport = await transportFor(fake);
    const serverId = await signedIn(fake, transport);
    signOutWorkdayAdmin(serverId);
    await expect(searchAgentResources(serverId, "absence", transport)).rejects.toThrow(
      /Sign in to Workday/,
    );
    // A token Workday rejects is dropped.
    const again = await signedIn(fake, transport);
    const rejecting: WorkdayAdminTransport = {
      ...transport,
      fetchImpl: async (url, init) =>
        url.includes("/asor/")
          ? new Response(JSON.stringify({ error: "expired" }), { status: 401 })
          : globalThis.fetch(url, init),
    };
    await expect(searchAgentResources(again, "absence", rejecting)).rejects.toThrow(
      /sign in again/,
    );
    await expect(listAgentDefinitions(again, transport)).resolves.toEqual({
      status: "signed_out",
    });
  });

  it("parses catalog rows from any collection key and skips malformed rows", () => {
    for (const key of ["data", "results", "items"])
      expect(parseAgentResources({ [key]: catalog })).toHaveLength(catalog.length);
    expect(parseAgentResources(catalog)).toHaveLength(catalog.length);
    expect(
      parseAgentResources([
        { id: "not-a-wid", descriptor: "x_y" },
        { id: ABSENCE_WID.toUpperCase(), descriptor: "find_absence_balances" },
        { id: ABSENCE_WID, descriptor: "duplicate_row" },
        { id: PAY_WID },
      ]),
    ).toEqual([{ wid: ABSENCE_WID, toolName: "find_absence_balances", kind: "mcp" }]);
  });
});
