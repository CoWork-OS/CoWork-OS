import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { manifestFromToolResult, validateObjectManifest } from "../object-manifest";
import { MCP_OBJECT_MANIFEST_META_KEY } from "../types";

const CONNECTORS = "../../../../connectors";

const SALESFORCE_ENV: Record<string, string> = {
  SALESFORCE_INSTANCE_URL: "https://example.my.salesforce.com",
  SALESFORCE_ACCESS_TOKEN: "test-token",
};
const SERVICENOW_ENV: Record<string, string> = {
  SERVICENOW_INSTANCE_URL: "https://example.service-now.com",
  SERVICENOW_ACCESS_TOKEN: "test-token",
};
/** Every variable either connector reads, cleared so a developer's shell cannot leak in. */
const ALL_ENV_KEYS = [
  "SALESFORCE_INSTANCE_URL",
  "SALESFORCE_ACCESS_TOKEN",
  "SALESFORCE_CLIENT_ID",
  "SALESFORCE_CLIENT_SECRET",
  "SALESFORCE_REFRESH_TOKEN",
  "SALESFORCE_LOGIN_URL",
  "SALESFORCE_API_VERSION",
  "SERVICENOW_INSTANCE_URL",
  "SERVICENOW_INSTANCE",
  "SERVICENOW_USERNAME",
  "SERVICENOW_PASSWORD",
  "SERVICENOW_ACCESS_TOKEN",
];

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function stubFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => respond(String(url), init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function methods(fetchMock: ReturnType<typeof stubFetch>): string[] {
  return fetchMock.mock.calls.map(([, init]) => init?.method ?? "GET");
}

async function load<T>(path: string, env: Record<string, string> = {}): Promise<T> {
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  vi.resetModules();
  return (await import(path)) as T;
}

type Connector = {
  prefix: string;
  path: string;
  call: string;
  list: string;
  env: Record<string, string>;
  types: string[];
};

const SALESFORCE: Connector = {
  prefix: "salesforce",
  path: `${CONNECTORS}/salesforce-mcp/src/index`,
  call: "callSalesforceToolForTest",
  list: "listSalesforceToolsForTest",
  env: SALESFORCE_ENV,
  types: ["Account", "Contact", "Lead", "Opportunity", "Case", "Task"],
};
const SERVICENOW: Connector = {
  prefix: "servicenow",
  path: `${CONNECTORS}/servicenow-mcp/src/index`,
  call: "callServiceNowToolForTest",
  list: "listServiceNowToolsForTest",
  env: SERVICENOW_ENV,
  types: ["incident", "problem", "change_request", "sys_user"],
};

/** The connector's manifest, checked against the validator and the tools it lists. */
async function describeObjects(connector: Connector, env: Record<string, string> = {}) {
  const mod = await load<Any>(connector.path, env);
  const tools = mod[connector.list]() as Array<{ name: string; _meta?: Record<string, unknown> }>;
  const names = tools.map((tool) => tool.name);
  const result = await mod[connector.call]({
    name: `${connector.prefix}.describe_objects`,
    arguments: {},
  });
  expect(result.isError).toBeFalsy();
  const raw = manifestFromToolResult(result) as Any;
  expect(JSON.parse(result.content[0].text)).toEqual(raw);
  const validation = validateObjectManifest(raw, tools as Any);
  expect(validation).toMatchObject({ ok: true, warnings: [] });
  return { manifest: raw, tools, names };
}

const objectOf = (manifest: Any, type: string) =>
  manifest.objects.find((object: Any) => object.type === type);
const fieldOf = (manifest: Any, type: string, name: string) =>
  objectOf(manifest, type).fields.find((field: Any) => field.name === name);
const withoutUrls = (manifest: Any) =>
  manifest.objects.map(({ urlTemplate: _url, ...object }: Any) => object);

describe("connector object manifests with live enrichment", () => {
  beforeEach(() => {
    for (const key of ALL_ENV_KEYS) delete process.env[key];
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    for (const key of ALL_ENV_KEYS) delete process.env[key];
  });

  for (const connector of [SALESFORCE, SERVICENOW]) {
    it(`${connector.prefix}: without credentials returns the declared manifest and calls no API`, async () => {
      const fetchMock = stubFetch(() => json({}));
      const { manifest, tools, names } = await describeObjects(connector);

      const describeTool = tools[tools.length - 1];
      expect(describeTool.name).toBe(`${connector.prefix}.describe_objects`);
      expect(describeTool._meta?.[MCP_OBJECT_MANIFEST_META_KEY]).toBe(true);
      expect(manifest.connector).toBe(connector.prefix);
      expect(manifest.objects.map((object: Any) => object.type)).toEqual(connector.types);
      for (const tool of manifest.tools) expect(names).toContain(tool.name);
      expect(manifest.tools.map((tool: Any) => tool.name)).not.toContain(describeTool.name);
      for (const object of manifest.objects) expect(object.urlTemplate).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it(`${connector.prefix}: an API error falls back to the declared manifest`, async () => {
      stubFetch(() => json({}));
      const declared = (await describeObjects(connector)).manifest;

      const fetchMock = stubFetch(() => json([{ message: "boom", errorCode: "SERVER" }], 500));
      const { manifest } = await describeObjects(connector, connector.env);

      expect(fetchMock).toHaveBeenCalled();
      expect(methods(fetchMock).every((method) => method === "GET")).toBe(true);
      expect(withoutUrls(manifest)).toEqual(declared.objects);
      expect(manifest.tools).toEqual(declared.tools);
    });

    it(`${connector.prefix}: a live read that never answers gives the declared manifest after 12 seconds`, async () => {
      stubFetch(() => json({}));
      const declared = (await describeObjects(connector)).manifest;

      const mod = await load<Any>(connector.path, connector.env);
      const tools = mod[connector.list]();
      const fetchMock = stubFetch(() => new Promise<Response>(() => {}));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let settled = false;
      const pending = mod[connector.call]({
        name: `${connector.prefix}.describe_objects`,
        arguments: {},
      });
      void pending.finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(11_999);
      expect(fetchMock).toHaveBeenCalled();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(result.isError).toBeFalsy();
      expect(vi.getTimerCount()).toBe(0);
      const manifest = manifestFromToolResult(result) as Any;
      expect(validateObjectManifest(manifest, tools)).toMatchObject({ ok: true, warnings: [] });
      expect(withoutUrls(manifest)).toEqual(declared.objects);
      expect(manifest.tools).toEqual(declared.tools);
      for (const object of manifest.objects) expect(object.urlTemplate).toMatch(/^https:\/\//);
    });

    it(`${connector.prefix}: a live read that answers in time leaves no deadline timer behind`, async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      stubFetch(() => json([{ message: "boom", errorCode: "SERVER" }], 500));
      await describeObjects(connector, connector.env);
      expect(vi.getTimerCount()).toBe(0);
    });
  }

  it("salesforce: record links follow the https instance and are left out otherwise", async () => {
    stubFetch(() => json({}, 500));
    const { manifest } = await describeObjects(SALESFORCE, SALESFORCE_ENV);
    expect(objectOf(manifest, "Opportunity").urlTemplate).toBe(
      "https://example.my.salesforce.com/lightning/r/Opportunity/{id}/view",
    );

    const insecure = await describeObjects(SALESFORCE, {
      ...SALESFORCE_ENV,
      SALESFORCE_INSTANCE_URL: "http://example.my.salesforce.com",
    });
    for (const object of insecure.manifest.objects) expect(object.urlTemplate).toBeUndefined();
  });

  it("salesforce: the describe adds custom fields, live picklist values and the field cap", async () => {
    const custom = Array.from({ length: 200 }, (_, index) => ({
      name: `Extra_${index}__c`,
      label: `Extra ${index}`,
      type: "string",
      custom: true,
    }));
    const describes: Record<string, unknown> = {
      Account: { fields: [{ name: "Name", label: "Company", type: "string" }, ...custom] },
      Contact: {
        fields: [
          { name: "Email", label: "Email", type: "email" },
          { name: "Home_City__c", label: "Home City", type: "string", custom: true },
        ],
      },
      Opportunity: {
        fields: [
          {
            name: "StageName",
            label: "Stage",
            type: "picklist",
            picklistValues: [
              { value: "Discovery", active: true },
              { value: "Proposal", active: true },
              { value: "Legacy", active: false },
              { value: "Closed Won", active: true },
            ],
          },
          {
            name: "Region__c",
            label: "Region",
            type: "picklist",
            custom: true,
            picklistValues: [
              { value: "EMEA", active: true },
              { value: "APAC", active: true },
              { value: "Old", active: false },
            ],
          },
          { name: "Score__c", label: "Score", type: "double", custom: true },
          { name: "Win_Notes__c", label: "Win notes", type: "textarea", custom: true },
          { name: "SystemModstamp", label: "System Modstamp", type: "datetime", custom: false },
        ],
      },
      Lead: { fields: [] },
      Task: { fields: [] },
    };
    const fetchMock = stubFetch((url) => {
      const type = /\/sobjects\/([^/]+)\/describe$/.exec(new URL(url).pathname)?.[1] ?? "";
      return type in describes ? json(describes[type]) : json([{ message: "boom" }], 500);
    });

    const { manifest } = await describeObjects(SALESFORCE, SALESFORCE_ENV);

    expect(methods(fetchMock)).toEqual(Array(6).fill("GET"));
    const opportunity = objectOf(manifest, "Opportunity");
    expect(fieldOf(manifest, "Opportunity", "Region__c")).toEqual({
      name: "Region__c",
      type: "enum",
      label: "Region",
      enum: ["EMEA", "APAC"],
    });
    expect(fieldOf(manifest, "Opportunity", "Score__c")).toMatchObject({ type: "number" });
    // Free text is personal data on every object, not only on people.
    expect(fieldOf(manifest, "Opportunity", "Win_Notes__c")).toEqual({
      name: "Win_Notes__c",
      type: "text",
      label: "Win notes",
      pii: true,
    });
    expect(fieldOf(manifest, "Opportunity", "Description")).toMatchObject({ pii: true });
    expect(fieldOf(manifest, "Opportunity", "Score__c").pii).toBeUndefined();
    expect(fieldOf(manifest, "Opportunity", "SystemModstamp")).toBeUndefined();
    expect(fieldOf(manifest, "Opportunity", "Amount")).toMatchObject({ type: "currency" });
    expect(opportunity.statusField).toEqual({
      name: "StageName",
      values: ["Discovery", "Proposal", "Closed Won"],
      closed: ["Closed Won"],
    });

    const account = objectOf(manifest, "Account");
    expect(account.fields).toHaveLength(120);
    expect(account.fields[0]).toMatchObject({ name: "Id", type: "id" });
    expect(fieldOf(manifest, "Account", "Name")).toMatchObject({ label: "Company" });
    expect(fieldOf(manifest, "Account", "LastModifiedDate")).toBeDefined();
    expect(fieldOf(manifest, "Account", "Extra_0__c")).toMatchObject({ type: "string" });

    expect(fieldOf(manifest, "Contact", "Home_City__c")).toMatchObject({ pii: true });
    expect(fieldOf(manifest, "Contact", "Email")).toMatchObject({ type: "email", pii: true });
    // Case answered 500: it stays as declared.
    expect(objectOf(manifest, "Case").statusField).toEqual({
      name: "Status",
      values: ["New", "Working", "Escalated", "Closed"],
      closed: ["Closed"],
    });
  });

  it("servicenow: the dictionary adds columns and the state choices replace the declared codes", async () => {
    const fetchMock = stubFetch((url) => {
      const parsed = new URL(url);
      const query = parsed.searchParams.get("sysparm_query") ?? "";
      if (parsed.pathname.endsWith("/table/sys_dictionary") && query.startsWith("name=incident^")) {
        expect(parsed.searchParams.get("sysparm_limit")).toBe("200");
        expect(parsed.searchParams.get("sysparm_fields")).toBe(
          "element,column_label,internal_type",
        );
        return json({
          result: [
            {
              element: "u_vendor_ticket",
              column_label: "Vendor ticket",
              internal_type: { link: "https://example/x", value: "string" },
            },
            { element: "u_customer_email", column_label: "Customer email", internal_type: "email" },
            { element: "u_outage_minutes", column_label: "Outage", internal_type: "integer" },
            { element: "u_customer_notes", column_label: "Customer notes", internal_type: "html" },
            {
              element: "caller_id",
              column_label: "Reported by",
              internal_type: { value: "reference" },
            },
          ],
        });
      }
      if (parsed.pathname.endsWith("/table/sys_choice") && query.startsWith("name=incident^")) {
        expect(query).toBe(
          "name=incident^element=state^inactive=false^language=en^ORDERBYsequence",
        );
        expect(parsed.searchParams.get("sysparm_limit")).toBe("64");
        return json({
          result: ["1", "2", "18", "6", "7"].map((value) => ({ value, label: `State ${value}` })),
        });
      }
      if (parsed.pathname.endsWith("/table/sys_dictionary") && query.startsWith("name=sys_user^")) {
        return json({
          result: [
            { element: "middle_name", column_label: "Middle name", internal_type: "string" },
          ],
        });
      }
      return json({ result: [] });
    });

    const { manifest } = await describeObjects(SERVICENOW, SERVICENOW_ENV);

    // 4 dictionary reads and 3 state-choice reads (sys_user has no state field).
    expect(methods(fetchMock)).toEqual(Array(7).fill("GET"));
    expect(fieldOf(manifest, "incident", "u_vendor_ticket")).toEqual({
      name: "u_vendor_ticket",
      type: "string",
      label: "Vendor ticket",
    });
    expect(fieldOf(manifest, "incident", "u_customer_email")).toMatchObject({
      type: "email",
      pii: true,
    });
    expect(fieldOf(manifest, "incident", "u_outage_minutes")).toMatchObject({ type: "number" });
    expect(fieldOf(manifest, "incident", "u_outage_minutes").pii).toBeUndefined();
    // Free text is personal data on every table, declared or live.
    expect(fieldOf(manifest, "incident", "u_customer_notes")).toEqual({
      name: "u_customer_notes",
      type: "text",
      label: "Customer notes",
      pii: true,
    });
    expect(fieldOf(manifest, "incident", "close_notes")).toMatchObject({ type: "text", pii: true });
    expect(fieldOf(manifest, "incident", "caller_id")).toMatchObject({
      type: "reference",
      label: "Reported by",
    });
    expect(fieldOf(manifest, "incident", "short_description")).toBeDefined();
    expect(fieldOf(manifest, "incident", "state").enum).toEqual(["1", "2", "18", "6", "7"]);
    expect(objectOf(manifest, "incident").statusField).toEqual({
      name: "state",
      values: ["1", "2", "18", "6", "7"],
      closed: ["6", "7"],
    });
    expect(objectOf(manifest, "incident").urlTemplate).toBe(
      "https://example.service-now.com/nav_to.do?uri=incident.do?sys_id={id}",
    );
    expect(fieldOf(manifest, "sys_user", "middle_name")).toMatchObject({ pii: true });
    // problem got no choices back: its declared states stand.
    expect(objectOf(manifest, "problem").statusField.values).toEqual([
      "101",
      "102",
      "103",
      "104",
      "106",
      "107",
    ]);
  });
});
