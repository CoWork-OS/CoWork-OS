import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const WORKSPACE_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/chat.messages",
  "https://www.googleapis.com/auth/chat.spaces.readonly",
];
const CONTACTS_SCOPE = "https://www.googleapis.com/auth/contacts.readonly";

function jsonResponse(data: Any, status = 200): Any {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(data),
    text: vi.fn().mockResolvedValue(JSON.stringify(data)),
  };
}

async function loadConnector(scopes?: string[]) {
  vi.resetModules();
  process.env.GOOGLE_ACCESS_TOKEN = "test-token";
  if (scopes) process.env.GOOGLE_SCOPES = scopes.join(" ");
  else delete process.env.GOOGLE_SCOPES;
  return import("../../../../connectors/google-workspace-mcp/src/index");
}

describe("google-workspace contacts tools", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GOOGLE_ACCESS_TOKEN;
    delete process.env.GOOGLE_SCOPES;
  });

  it("refuses to call the People API when Contacts was not granted", async () => {
    const { executeGoogleWorkspaceToolForTest } = await loadConnector(WORKSPACE_SCOPES);

    await expect(
      executeGoogleWorkspaceToolForTest("google-workspace.contacts_search", { query: "ada" }),
    ).rejects.toThrow(/Google Contacts is not enabled/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("warms the search cache once and normalizes results", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({}) as Response).mockResolvedValue(
      jsonResponse({
        results: [
          {
            person: {
              resourceName: "people/c1",
              names: [{ displayName: "Ada Lovelace", metadata: { primary: true } }],
              emailAddresses: [{ value: "ada@example.com", metadata: { primary: true } }],
              phoneNumbers: [{ value: "+44 20 0000", canonicalForm: "+44200000" }],
            },
          },
        ],
      }) as Response,
    );
    const { executeGoogleWorkspaceToolForTest } = await loadConnector([
      ...WORKSPACE_SCOPES,
      CONTACTS_SCOPE,
    ]);

    const first = await executeGoogleWorkspaceToolForTest("google-workspace.contacts_search", {
      query: "ada",
    });
    await executeGoogleWorkspaceToolForTest("google-workspace.contacts_search", { query: "bob" });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0][0])).toContain("query=&");
    expect(String(fetchMock.mock.calls[1][0])).toContain("query=ada");
    expect(first.data.contacts[0]).toMatchObject({
      resourceName: "people/c1",
      displayName: "Ada Lovelace",
      emails: [{ value: "ada@example.com", primary: true }],
      phones: [{ value: "+44 20 0000", canonical: "+44200000" }],
    });
    expect(first.data.contacts[0].raw).toBeUndefined();
  });

  it("falls back to a full listing when the sync token has expired", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { status: "FAILED_PRECONDITION", reason: "EXPIRED_SYNC_TOKEN" } },
          410,
        ) as Response,
      )
      .mockResolvedValueOnce(
        jsonResponse({
          connections: [{ resourceName: "people/c2", names: [{ displayName: "Grace" }] }],
          nextSyncToken: "sync-2",
        }) as Response,
      );
    const { executeGoogleWorkspaceToolForTest } = await loadConnector([
      ...WORKSPACE_SCOPES,
      CONTACTS_SCOPE,
    ]);

    const result = await executeGoogleWorkspaceToolForTest("google-workspace.contacts_list", {
      syncToken: "stale",
      pageToken: "old-page",
    });

    expect(String(fetchMock.mock.calls[0][0])).toContain("syncToken=stale");
    expect(String(fetchMock.mock.calls[1][0])).not.toContain("syncToken=");
    expect(String(fetchMock.mock.calls[1][0])).not.toContain("pageToken=");
    expect(result.data).toMatchObject({
      fullSync: true,
      syncTokenExpired: true,
      nextSyncToken: "sync-2",
      contacts: [{ resourceName: "people/c2", displayName: "Grace" }],
    });
  });

  it("validates resource names and person fields", async () => {
    const { executeGoogleWorkspaceToolForTest } = await loadConnector([CONTACTS_SCOPE]);

    await expect(
      executeGoogleWorkspaceToolForTest("google-workspace.contacts_get", {
        resourceName: "people/../me",
      }),
    ).rejects.toThrow(/resourceName/);
    await expect(
      executeGoogleWorkspaceToolForTest("google-workspace.contacts_get", {
        resourceName: "people/c1",
        personFields: "names&x=1",
      }),
    ).rejects.toThrow(/personFields/);
  });

  it("reports the optional Contacts capability in health", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ user: { emailAddress: "me@example.com" } }) as Response,
    );
    const { executeGoogleWorkspaceToolForTest } = await loadConnector(WORKSPACE_SCOPES);

    const health = await executeGoogleWorkspaceToolForTest("google-workspace.health", {});
    expect(health.data.optionalCapabilities).toEqual({ contacts: "missing", meet: "missing" });
  });
});
