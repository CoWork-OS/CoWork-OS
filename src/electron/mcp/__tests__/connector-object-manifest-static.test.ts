import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyToolActions } from "../inventory/connector-inventory";
import {
  isObjectManifestTool,
  validateObjectManifest,
  type ConnectorObjectManifest,
} from "../object-manifest";
import { MCP_OBJECT_MANIFEST_META_KEY } from "../types";

const ENV: Record<string, string> = {
  HUBSPOT_ACCESS_TOKEN: "test-token",
  ZENDESK_SUBDOMAIN: "example",
  ZENDESK_EMAIL: "agent@example.com",
  ZENDESK_API_TOKEN: "test-token",
  JIRA_BASE_URL: "https://example.atlassian.net",
  JIRA_EMAIL: "agent@example.com",
  JIRA_API_TOKEN: "test-token",
  LINEAR_API_KEY: "lin_test",
};
/** Read by the connectors but not set above; cleared so the host environment cannot leak in. */
const UNSET = ["ZENDESK_BASE_URL"];

type ListedTool = { name: string; _meta?: Record<string, unknown> };

type ConnectorCase = {
  name: string;
  path: string;
  call: string;
  list: string;
  /** The connector's write tools, as the inventory classifies them. */
  writes: string[];
};

const CASES: ConnectorCase[] = [
  {
    name: "hubspot",
    path: "hubspot-mcp/src/index",
    call: "callHubSpotToolForTest",
    list: "listHubSpotToolsForTest",
    writes: ["hubspot.create_object", "hubspot.update_object"],
  },
  {
    name: "zendesk",
    path: "zendesk-mcp/src/index",
    call: "callZendeskToolForTest",
    list: "listZendeskToolsForTest",
    writes: ["zendesk.create_ticket", "zendesk.update_ticket"],
  },
  {
    name: "jira",
    path: "jira-mcp/src/index",
    call: "callJiraToolForTest",
    list: "listJiraToolsForTest",
    writes: ["jira.create_issue", "jira.update_issue"],
  },
  {
    name: "linear",
    path: "linear-mcp/src/index",
    call: "callLinearToolForTest",
    list: "listLinearToolsForTest",
    writes: [],
  },
];

const CONNECTORS = "../../../../connectors";

async function load<T>(path: string): Promise<T> {
  vi.resetModules();
  return (await import(path)) as T;
}

/** A static manifest makes no API call: any fetch fails the call and the test. */
function failOnFetch() {
  const fetchMock = vi.fn(async (url: string) => {
    throw new Error(`describe_objects must not call the API (${url})`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function describeObjects(connector: ConnectorCase) {
  const mod = await load<Any>(`${CONNECTORS}/${connector.path}`);
  const fetchMock = failOnFetch();
  const result = await mod[connector.call]({
    name: `${connector.name}.describe_objects`,
    arguments: {},
  });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(result.isError, connector.name).toBeFalsy();
  return { result, tools: mod[connector.list]() as ListedTool[] };
}

/** The validated manifest; a manifest with any warning fails. */
async function manifestOf(connector: ConnectorCase): Promise<ConnectorObjectManifest> {
  const { result, tools } = await describeObjects(connector);
  const validation = validateObjectManifest(result.structuredContent, tools as Any);
  if (!validation.ok) throw new Error(`${connector.name}: ${validation.error}`);
  expect(validation.warnings, connector.name).toEqual([]);
  return validation.manifest;
}

const byName = (name: string) => CASES.find((connector) => connector.name === name)!;

describe("static connector object manifests", () => {
  beforeEach(() => {
    for (const key of UNSET) delete process.env[key];
    for (const [key, value] of Object.entries(ENV)) process.env[key] = value;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of [...Object.keys(ENV), ...UNSET]) delete process.env[key];
  });

  describe.each(CASES)("$name", (connector) => {
    it("lists describe_objects last, flagged as the object manifest", async () => {
      const mod = await load<Any>(`${CONNECTORS}/${connector.path}`);
      const tools = mod[connector.list]() as ListedTool[];
      const manifestTool = tools.at(-1);
      expect(manifestTool?.name).toBe(`${connector.name}.describe_objects`);
      expect(manifestTool?._meta?.[MCP_OBJECT_MANIFEST_META_KEY]).toBe(true);
      expect(isObjectManifestTool(manifestTool)).toBe(true);
      expect(tools.filter((tool) => isObjectManifestTool(tool))).toHaveLength(1);
    });

    it("returns the same manifest as structured content and as JSON text", async () => {
      const { result } = await describeObjects(connector);
      expect(result.content[0].type).toBe("text");
      expect(result.structuredContent).toEqual(JSON.parse(result.content[0].text));
    });

    it("returns a manifest the validator accepts without warnings", async () => {
      const { result, tools } = await describeObjects(connector);
      const toolNames = tools.map((tool) => tool.name);
      const raw = result.structuredContent as { connector: string; tools: Array<{ name: string }> };
      expect(raw.connector).toBe(connector.name);
      for (const entry of raw.tools) expect(toolNames, entry.name).toContain(entry.name);

      const manifest = await manifestOf(connector);
      expect(manifest.tools.map((tool) => tool.name)).toEqual(raw.tools.map((tool) => tool.name));
    });

    it("covers every write tool with an external_write entry", async () => {
      const { tools } = await describeObjects(connector);
      const writes = tools
        .map((tool) => tool.name)
        .filter((name) => classifyToolActions([name]).includes("write"));
      expect(writes).toEqual(connector.writes);

      const manifest = await manifestOf(connector);
      for (const name of writes) {
        const entry = manifest.tools.find((tool) => tool.name === name);
        expect(entry, name).toBeDefined();
        expect(entry!.risk, name).toBe("external_write");
        expect(entry!.effect, name).not.toBe("read");
      }
    });
  });

  it("names the HubSpot object types the tools take as objectType", async () => {
    const manifest = await manifestOf(byName("hubspot"));
    expect(manifest.objects.map((object) => object.type)).toEqual([
      "contacts",
      "companies",
      "deals",
      "tickets",
    ]);
    for (const object of manifest.objects) {
      expect(object.fieldsPath).toBe("properties");
      expect(object.urlTemplate).toBeUndefined();
    }
    for (const tool of manifest.tools) expect(tool.objectArg, tool.name).toBe("objectType");
    const deals = manifest.objects.find((object) => object.type === "deals");
    expect(deals?.statusField).toEqual({
      name: "dealstage",
      values: [
        "appointmentscheduled",
        "qualifiedtobuy",
        "presentationscheduled",
        "decisionmakerboughtin",
        "contractsent",
        "closedwon",
        "closedlost",
      ],
      closed: ["closedwon", "closedlost"],
    });
  });

  it("links Zendesk tickets to their agent page only when the account URL is set", async () => {
    const ticketUrl = async () =>
      (await manifestOf(byName("zendesk"))).objects.find((object) => object.type === "ticket")
        ?.urlTemplate;

    expect(await ticketUrl()).toBe("https://example.zendesk.com/agent/tickets/{id}");

    process.env.ZENDESK_BASE_URL = "https://support.example.com/";
    expect(await ticketUrl()).toBe("https://support.example.com/agent/tickets/{id}");

    delete process.env.ZENDESK_BASE_URL;
    delete process.env.ZENDESK_SUBDOMAIN;
    expect(await ticketUrl()).toBeUndefined();
  });

  it("links Jira issues to their browse page only when the site URL is set", async () => {
    const issueUrl = async () =>
      (await manifestOf(byName("jira"))).objects.find((object) => object.type === "issue")
        ?.urlTemplate;

    expect(await issueUrl()).toBe("https://example.atlassian.net/browse/{id}");

    // The OAuth API gateway is not where an issue's page lives.
    process.env.JIRA_BASE_URL = "https://api.atlassian.com/ex/jira/cloud-id";
    expect(await issueUrl()).toBeUndefined();

    delete process.env.JIRA_BASE_URL;
    expect(await issueUrl()).toBeUndefined();
  });

  it("limits Zendesk ticket search to tickets unless the query names a type", async () => {
    const mod = await load<Any>(`${CONNECTORS}/zendesk-mcp/src/index`);
    const requests: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        requests.push(new URL(String(url)));
        return new Response(JSON.stringify({ results: [], count: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const search = async (query: string) => {
      const result = await mod.callZendeskToolForTest({
        name: "zendesk.search_tickets",
        arguments: { query },
      });
      expect(result.isError, query).toBeFalsy();
      const request = requests.at(-1)!;
      expect(request.pathname).toBe("/api/v2/search.json");
      return request.searchParams.get("query");
    };

    expect(await search("status:open printer")).toBe("type:ticket status:open printer");
    // `ticket_type:` is a ticket field, not a result type.
    expect(await search("ticket_type:incident")).toBe("type:ticket ticket_type:incident");
    expect(await search("TYPE:ticket status:open")).toBe("type:ticket status:open");
    // Another result type would put users under data.results, read as tickets.
    expect(await search("status:open type:user")).toBe("type:ticket status:open");
    expect(await search("-type:ticket acme")).toBe("type:ticket acme");
  });

  it("lists only the Linear fields its GraphQL queries select", async () => {
    const mod = await load<Any>(`${CONNECTORS}/linear-mcp/src/index`);
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)).query);
        const data = { issue: { id: "1" }, issues: { nodes: [] }, projects: { nodes: [] } };
        return new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const queryOf = async (name: string, args: Record<string, unknown>) => {
      await mod.callLinearToolForTest({ name: `linear.${name}`, arguments: args });
      return sent.at(-1)!;
    };
    const issueQueries =
      (await queryOf("get_issue", { id: "ENG-1" })) +
      (await queryOf("search_issues", { query: "crash" }));
    const projectQuery = await queryOf("list_projects", {});
    /** `state.name` is selected when the query has `state { … name … }`. */
    const selects = (query: string, path: string) => {
      const [root, leaf] = path.split(".");
      return leaf
        ? new RegExp(`\\b${root}\\s*\\{[^}]*\\b${leaf}\\b`).test(query)
        : new RegExp(`\\b${root}\\b`).test(query);
    };

    const manifest = await manifestOf(byName("linear"));
    const queries: Record<string, string> = { issue: issueQueries, project: projectQuery };
    for (const object of manifest.objects) {
      for (const field of object.fields) {
        expect(selects(queries[object.type], field.name), `${object.type}.${field.name}`).toBe(
          true,
        );
      }
    }
  });

  it("gives Linear reads only, with no url template", async () => {
    const manifest = await manifestOf(byName("linear"));
    expect(manifest.tools.every((tool) => tool.effect === "read" && tool.risk === "read")).toBe(
      true,
    );
    for (const object of manifest.objects) expect(object.urlTemplate).toBeUndefined();
  });
});
