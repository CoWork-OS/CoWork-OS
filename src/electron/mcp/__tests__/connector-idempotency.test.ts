import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "0123456789abcdef0123456789abcdef";
const meta = (key = KEY) => ({ "cowork.idempotencyKey": key, "cowork.attemptId": "attempt-1" });

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

/** A fetch that answers each call from `respond`, building a fresh Response every time. */
function stubFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => respond(String(url), init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const noResponse = () => {
  throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
};

function body(result: Any) {
  return JSON.parse(result.content[0].text);
}

async function load<T>(path: string): Promise<T> {
  vi.resetModules();
  return (await import(path)) as T;
}

describe("connector idempotent writes", () => {
  beforeEach(() => {
    for (const [key, value] of Object.entries(ENV)) process.env[key] = value;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of Object.keys(ENV)) delete process.env[key];
  });

  it("Jira creates once per key and reports already_exists on the retry", async () => {
    const fetchMock = stubFetch(() => json({ id: "10001", key: "OPS-1" }, 201));
    const { callJiraToolForTest } = await load<Any>("../../../../connectors/jira-mcp/src/index");
    const call = (key?: string) =>
      callJiraToolForTest({
        name: "jira.create_issue",
        arguments: { projectKey: "OPS", issueType: "Task", fields: { summary: "Rotate keys" } },
        ...(key ? { _meta: meta(key) } : {}),
      });

    const first = await call(KEY);
    const retry = await call(KEY);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.structuredContent).toEqual({ status: "created" });
    expect(body(first)).toMatchObject({ status: "created", data: { key: "OPS-1" } });
    expect(retry.structuredContent).toMatchObject({ status: "already_exists" });
    expect(body(retry)).toMatchObject({ status: "already_exists", data: { key: "OPS-1" } });

    // Without a key every call writes, as before.
    await call();
    await call();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("Jira reports an unanswered create as unknown, then finds the issue it made", async () => {
    let creates = 0;
    const fetchMock = stubFetch((url) => {
      if (url.endsWith("/issue")) {
        creates += 1;
        return noResponse();
      }
      return json({ issues: [{ id: "10001", key: "OPS-1", fields: { summary: "Rotate keys" } }] });
    });
    const { callJiraToolForTest } = await load<Any>("../../../../connectors/jira-mcp/src/index");
    const call = () =>
      callJiraToolForTest({
        name: "jira.create_issue",
        arguments: { projectKey: "OPS", issueType: "Task", fields: { summary: "Rotate keys" } },
        _meta: meta(),
      });

    const first = await call();
    expect(first.isError).toBe(true);
    expect(first.structuredContent).toMatchObject({ status: "unknown" });

    const retry = await call();
    expect(creates).toBe(1);
    expect(retry.structuredContent).toMatchObject({ status: "already_exists" });
    expect(body(retry).data).toEqual({ id: "10001", key: "OPS-1" });
    const search = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/search"));
    expect(JSON.parse(String(search![1].body)).jql).toBe(
      'project = "OPS" AND summary ~ "\\"Rotate keys\\"" AND created >= -1d ORDER BY created DESC',
    );
  });

  it("Jira still refuses definite API errors instead of calling them unknown", async () => {
    stubFetch(() => json({ errorMessages: ["Project does not exist"] }, 400));
    const { callJiraToolForTest } = await load<Any>("../../../../connectors/jira-mcp/src/index");
    const result = await callJiraToolForTest({
      name: "jira.create_issue",
      arguments: { projectKey: "NOPE", issueType: "Task", fields: { summary: "x" } },
      _meta: meta(),
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });

  it("Salesforce creates once per key, and an explicit idempotencyKey argument wins", async () => {
    const fetchMock = stubFetch(() => json({ id: "001xx", success: true }, 201));
    const { callSalesforceToolForTest } = await load<Any>(
      "../../../../connectors/salesforce-mcp/src/index",
    );
    const call = (args: Record<string, unknown>, key?: string) =>
      callSalesforceToolForTest({
        name: "salesforce.create_record",
        arguments: { object: "Account", fields: { Name: "Acme" }, ...args },
        ...(key ? { _meta: meta(key) } : {}),
      });

    await call({}, KEY);
    expect((await call({}, KEY)).structuredContent).toMatchObject({ status: "already_exists" });
    await call({ idempotencyKey: "caller-key-1" }, KEY);
    expect(
      (await call({ idempotencyKey: "caller-key-1" }, "ffffffffffffffffffffffffffffffff"))
        .structuredContent,
    ).toMatchObject({ status: "already_exists" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("Salesforce looks up a same-Name record after an unanswered create", async () => {
    let creates = 0;
    const fetchMock = stubFetch((url) => {
      if (url.includes("/sobjects/")) {
        creates += 1;
        return noResponse();
      }
      return json({ totalSize: 1, records: [{ Id: "001xx" }] });
    });
    const { callSalesforceToolForTest } = await load<Any>(
      "../../../../connectors/salesforce-mcp/src/index",
    );
    const call = () =>
      callSalesforceToolForTest({
        name: "salesforce.create_record",
        arguments: { object: "Account", fields: { Name: "O'Brien Ltd" } },
        _meta: meta(),
      });

    expect((await call()).structuredContent).toMatchObject({ status: "unknown" });
    const retry = await call();
    expect(creates).toBe(1);
    expect(retry.structuredContent).toMatchObject({ status: "already_exists" });
    const query = decodeURIComponent(
      String(fetchMock.mock.calls.find(([url]) => String(url).includes("query?q="))![0]),
    );
    expect(query).toContain("WHERE Name = 'O\\'Brien Ltd' AND CreatedDate = LAST_N_DAYS:1");
  });

  it("HubSpot creates once per key and reports a duplicate contact as already_exists", async () => {
    const fetchMock = stubFetch(() => json({ id: "501", properties: {} }, 201));
    const { callHubSpotToolForTest } = await load<Any>(
      "../../../../connectors/hubspot-mcp/src/index",
    );
    const call = (key?: string) =>
      callHubSpotToolForTest({
        name: "hubspot.create_object",
        arguments: { objectType: "contacts", properties: { email: "pat@example.com" } },
        ...(key ? { _meta: meta(key) } : {}),
      });
    await call(KEY);
    expect((await call(KEY)).structuredContent).toMatchObject({ status: "already_exists" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    stubFetch(() =>
      json(
        {
          status: "error",
          message: "Contact already exists. Existing ID: 777",
          category: "CONFLICT",
        },
        409,
      ),
    );
    const duplicate = await call("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
    expect(duplicate.structuredContent).toMatchObject({ status: "already_exists" });
    expect(body(duplicate).data).toEqual({ id: "777" });
  });

  it("Resend sends the key as its Idempotency-Key and sends once per key", async () => {
    const fetchMock = stubFetch(() => json({ id: "email-1" }));
    const { callResendToolForTest } = await load<Any>(
      "../../../../connectors/resend-mcp/src/index",
    );
    const call = () =>
      callResendToolForTest({
        name: "resend.send_email",
        arguments: { from: "a@example.com", to: "b@example.com", subject: "Hi", text: "Hello" },
        _meta: meta(),
      });

    expect((await call()).structuredContent).toEqual({ status: "created" });
    expect((await call()).structuredContent).toMatchObject({ status: "already_exists" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1].headers as Record<string, string>)["Idempotency-Key"]).toBe(
      KEY,
    );
  });

  it("ignores a malformed _meta key", async () => {
    const fetchMock = stubFetch(() => json({ id: "email-1" }));
    const { callResendToolForTest } = await load<Any>(
      "../../../../connectors/resend-mcp/src/index",
    );
    const call = () =>
      callResendToolForTest({
        name: "resend.send_email",
        arguments: { from: "a@example.com", to: "b@example.com", subject: "Hi", text: "Hello" },
        _meta: { "cowork.idempotencyKey": "bad key with spaces" },
      });
    await call();
    await call();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].headers as Record<string, string>).not.toHaveProperty(
      "Idempotency-Key",
    );
  });

  it("the connector template's example write tool follows the same contract", async () => {
    const { callExampleToolForTest } = await load<Any>(
      "../../../../connectors/templates/mcp-connector/src/index",
    );
    const call = () =>
      callExampleToolForTest({
        name: "example.create_item",
        arguments: { title: "First" },
        _meta: meta(),
      });
    const first = await call();
    const retry = await call();
    expect(first.structuredContent).toEqual({ status: "created" });
    expect(retry.structuredContent).toMatchObject({ status: "already_exists" });
    expect(body(retry).data.id).toBe(body(first).data.id);
  });
});
