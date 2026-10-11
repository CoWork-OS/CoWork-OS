import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Load the real client class without starting its stdio server.
function loadClient(provider: string, name: string, fetch: ReturnType<typeof vi.fn>) {
  const file = path.resolve(`connectors/${provider}-mcp/src/index.ts`);
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = source.statements.find(
    (statement) => ts.isClassDeclaration(statement) && statement.name?.text === name,
  );
  if (!declaration) throw new Error(`Missing client ${name}`);
  const code = ts.transpileModule(declaration.getText(source) + `\nglobalThis.Client = ${name};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const context = vm.createContext({
    fetch,
    Date,
    URL,
    parseRateLimit: () => undefined,
    deriveNextCursor: () => undefined,
  });
  vm.runInContext(code, context);
  const client = new (context.Client as any)({
    instanceUrl: "https://connector.example",
    apiVersion: "60.0",
    baseUrl: "https://connector.example",
  });
  client.getBaseUrl = () => "https://connector.example";
  client.getAuthHeader = async () => "Bearer synthetic";
  client.ensureAuthHeader = async () => "Bearer synthetic";
  client.ensureAccessToken = async () => "synthetic";
  client.canRefresh = () => true;
  client.refreshAccessToken = vi.fn(async () => {});
  client.extractErrorMessage = async () => "unauthorized";
  return client;
}

describe.each([
  ["hubspot", "HubSpotClient"],
  ["jira", "JiraClient"],
  ["salesforce", "SalesforceClient"],
  ["zendesk", "ZendeskClient"],
])("%s OAuth retry boundary", (provider, name) => {
  it("rejects a repeated 401 after a single refresh", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const client = loadClient(provider, name, fetch);
    await expect(client.requestJson("GET", "records")).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(client.refreshAccessToken).toHaveBeenCalledTimes(1);
  });
  it("returns a successful retry after refreshing", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response('{"records":[1]}', { status: 200 }));
    const client = loadClient(provider, name, fetch);
    await expect(client.requestJson("GET", "records")).resolves.toMatchObject({
      data: { records: [1] },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(client.refreshAccessToken).toHaveBeenCalledTimes(1);
  });
});
