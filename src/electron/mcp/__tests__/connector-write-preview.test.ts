import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseWritePreview, parseWriteReceipt } from "../write-preview";

const KEY = "0123456789abcdef0123456789abcdef";
const PREVIEW = { "cowork.preview": true };

const ENV: Record<string, string> = {
  SALESFORCE_INSTANCE_URL: "https://example.my.salesforce.com",
  SALESFORCE_ACCESS_TOKEN: "test-token",
  HUBSPOT_ACCESS_TOKEN: "test-token",
  JIRA_BASE_URL: "https://example.atlassian.net",
  JIRA_EMAIL: "agent@example.com",
  JIRA_API_TOKEN: "test-token",
  RESEND_API_KEY: "re_test",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function stubFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => respond(String(url), init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function load<T>(path: string): Promise<T> {
  vi.resetModules();
  return (await import(path)) as T;
}

const CONNECTORS = "../../../../connectors";

describe("connector write previews and receipts", () => {
  beforeEach(() => {
    for (const [key, value] of Object.entries(ENV)) process.env[key] = value;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of Object.keys(ENV)) delete process.env[key];
  });

  it("each connector describes its write without calling the API", async () => {
    const fetchMock = stubFetch(() => json({}));
    const cases: Array<[string, string, Record<string, unknown>, string, RegExp]> = [
      [
        "jira-mcp/src/index",
        "callJiraToolForTest",
        {
          name: "jira.create_issue",
          arguments: { projectKey: "OPS", issueType: "Task", fields: { summary: "Rotate keys" } },
        },
        "Create a Task in Jira project OPS",
        /Summary: Rotate keys/,
      ],
      [
        "salesforce-mcp/src/index",
        "callSalesforceToolForTest",
        {
          name: "salesforce.create_record",
          arguments: { object: "Account", fields: { Name: "Acme" } },
        },
        "Create a Account record in Salesforce",
        /Name: Acme/,
      ],
      [
        "hubspot-mcp/src/index",
        "callHubSpotToolForTest",
        {
          name: "hubspot.create_object",
          arguments: { objectType: "contacts", properties: { email: "pat@example.com" } },
        },
        "Create a contacts object in HubSpot",
        /email: pat@example\.com/,
      ],
      [
        "resend-mcp/src/index",
        "callResendToolForTest",
        {
          name: "resend.send_email",
          arguments: {
            from: "a@example.com",
            to: ["b@example.com", "c@example.com"],
            subject: "Invoice",
            text: "Attached.",
          },
        },
        'Send the email "Invoice" to 2 recipients',
        /b@example\.com, c@example\.com/,
      ],
      [
        "templates/mcp-connector/src/index",
        "callExampleToolForTest",
        { name: "example.create_item", arguments: { title: "First" } },
        'Create an item titled "First"',
        /Title: First/,
      ],
    ];

    for (const [path, exportName, params, summary, line] of cases) {
      const mod = await load<Any>(`${CONNECTORS}/${path}`);
      const result = await mod[exportName]({
        ...params,
        _meta: { ...PREVIEW, "cowork.idempotencyKey": KEY },
      });
      const prepared = parseWritePreview(result);
      expect(prepared, path).toBeDefined();
      expect(prepared!.summary).toBe(summary);
      const fields = (prepared!.payload as Any).fields as Array<{ label: string; value: string }>;
      expect(fields.map((f) => `${f.label}: ${f.value}`).join("\n")).toMatch(line);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a preview does not use up the idempotency key", async () => {
    const fetchMock = stubFetch(() => json({ id: "email-1" }));
    const { callResendToolForTest } = await load<Any>(`${CONNECTORS}/resend-mcp/src/index`);
    const args = { from: "a@example.com", to: "b@example.com", subject: "Hi", text: "Hello" };
    await callResendToolForTest({
      name: "resend.send_email",
      arguments: args,
      _meta: { ...PREVIEW, "cowork.idempotencyKey": KEY },
    });
    const sent = await callResendToolForTest({
      name: "resend.send_email",
      arguments: args,
      _meta: { "cowork.idempotencyKey": KEY },
    });
    expect(sent.structuredContent).toMatchObject({ status: "created" });
    expect(fetchMock.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
  });

  it("Jira reads a created issue back and returns a verified receipt", async () => {
    const fetchMock = stubFetch((url, init) =>
      init.method === "POST"
        ? json({ id: "10001", key: "OPS-1" }, 201)
        : json({ key: "OPS-1", fields: { summary: "Rotate keys" } }),
    );
    const { callJiraToolForTest } = await load<Any>(`${CONNECTORS}/jira-mcp/src/index`);
    const result = await callJiraToolForTest({
      name: "jira.create_issue",
      arguments: { projectKey: "OPS", issueType: "Task", fields: { summary: "Rotate keys" } },
    });

    expect(String(fetchMock.mock.calls[1][0])).toContain("/issue/OPS-1");
    expect(parseWriteReceipt(result)).toMatchObject({
      status: "verified",
      summary: "Created Jira issue OPS-1",
      evidence: [
        { source: "jira:issue:OPS-1", claim: 'Issue OPS-1 exists with summary "Rotate keys"' },
      ],
    });
  });

  it("a write that cannot be read back gets an unavailable receipt, not an error", async () => {
    stubFetch((url, init) =>
      init.method === "POST" ? json({ id: "001xx", success: true }, 201) : json({}, 404),
    );
    const { callSalesforceToolForTest } = await load<Any>(`${CONNECTORS}/salesforce-mcp/src/index`);
    const result = await callSalesforceToolForTest({
      name: "salesforce.create_record",
      arguments: { object: "Account", fields: { Name: "Acme" } },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ status: "created" });
    expect(parseWriteReceipt(result)).toMatchObject({
      status: "unavailable",
      summary: "Created Salesforce Account 001xx; it could not be read back",
    });
  });

  it("a retry that finds the earlier write carries no new receipt", async () => {
    stubFetch((url, init) =>
      init.method === "POST"
        ? json({ id: "email-1" })
        : json({ id: "email-1", last_event: "delivered" }),
    );
    const { callResendToolForTest } = await load<Any>(`${CONNECTORS}/resend-mcp/src/index`);
    const call = () =>
      callResendToolForTest({
        name: "resend.send_email",
        arguments: { from: "a@example.com", to: "b@example.com", subject: "Hi", text: "Hello" },
        _meta: { "cowork.idempotencyKey": KEY },
      });

    expect(parseWriteReceipt(await call())).toMatchObject({
      status: "verified",
      evidence: [{ claim: "Email email-1 is recorded by Resend (last event: delivered)" }],
    });
    expect(parseWriteReceipt(await call())).toBeUndefined();
  });
});
