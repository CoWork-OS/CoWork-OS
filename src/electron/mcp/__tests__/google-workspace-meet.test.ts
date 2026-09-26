import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MEET_SCOPE = "https://www.googleapis.com/auth/meetings.space.readonly";
const BASE_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/calendar",
];

function jsonResponse(data: Any, status = 200): Any {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(data),
    text: vi.fn().mockResolvedValue(JSON.stringify(data)),
  };
}

async function loadConnector(scopes: string[]) {
  vi.resetModules();
  process.env.GOOGLE_ACCESS_TOKEN = "test-token";
  process.env.GOOGLE_SCOPES = scopes.join(" ");
  return import("../../../../connectors/google-workspace-mcp/src/index");
}

describe("google-workspace Meet tools", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GOOGLE_ACCESS_TOKEN;
    delete process.env.GOOGLE_SCOPES;
  });

  it("requires the opt-in Meet scope", async () => {
    const { executeGoogleWorkspaceToolForTest } = await loadConnector(BASE_SCOPES);
    await expect(
      executeGoogleWorkspaceToolForTest("google-workspace.meet_conferences_list", {}),
    ).rejects.toThrow(/Google Meet is not enabled/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("builds validated filters for conference listing", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        conferenceRecords: [{ name: "conferenceRecords/c1", endTime: "t" }],
      }) as Response,
    );
    const { executeGoogleWorkspaceToolForTest } = await loadConnector([...BASE_SCOPES, MEET_SCOPE]);

    const result = await executeGoogleWorkspaceToolForTest(
      "google-workspace.meet_conferences_list",
      {
        meetingCode: "ABC-mnop-xyz",
        startAfter: "2026-09-01T00:00:00Z",
      },
    );

    const url = new URL(String(vi.mocked(fetch).mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe("https://meet.googleapis.com/v2/conferenceRecords");
    expect(url.searchParams.get("filter")).toBe(
      'space.meeting_code = "abc-mnop-xyz" AND start_time >= "2026-09-01T00:00:00Z"',
    );
    expect(result.data.conferences[0]).toMatchObject({ name: "conferenceRecords/c1", ended: true });

    await expect(
      executeGoogleWorkspaceToolForTest("google-workspace.meet_conferences_list", {
        meetingCode: 'x" OR 1=1',
      }),
    ).rejects.toThrow(/meetingCode/);
  });

  it("resolves transcript speakers and renders Markdown", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/entries")) {
        return jsonResponse({
          transcriptEntries: [
            {
              participant: "conferenceRecords/c1/participants/p1",
              startTime: "10:00",
              text: "Hello",
            },
            {
              participant: "conferenceRecords/c1/participants/p1",
              startTime: "10:01",
              text: "Agenda #1",
            },
            {
              participant: "conferenceRecords/c1/participants/p2",
              startTime: "10:02",
              text: "Thanks",
            },
          ],
        }) as Response;
      }
      return jsonResponse({
        participants: [
          { name: "conferenceRecords/c1/participants/p1", signedinUser: { displayName: "Ada" } },
          { name: "conferenceRecords/c1/participants/p2", anonymousUser: { displayName: "Guest" } },
        ],
      }) as Response;
    });
    const { executeGoogleWorkspaceToolForTest } = await loadConnector([MEET_SCOPE]);

    const result = await executeGoogleWorkspaceToolForTest(
      "google-workspace.meet_transcript_entries",
      {
        transcript: "conferenceRecords/c1/transcripts/t1",
        format: "markdown",
      },
    );

    expect(result.data.entries.map((entry: Any) => entry.speaker)).toEqual(["Ada", "Ada", "Guest"]);
    expect(result.data.markdown).toContain("**Ada** `10:00`\nHello\nAgenda \\#1");
    expect(result.data.markdown).toContain("**Guest** `10:02`\nThanks");

    await expect(
      executeGoogleWorkspaceToolForTest("google-workspace.meet_transcript_entries", {
        transcript: "conferenceRecords/../x",
      }),
    ).rejects.toThrow(/transcript must look like/);
  });

  it("aggregates attendance and artifact metadata for a conference", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/participants")) {
        return jsonResponse({
          participants: [
            {
              name: "p1",
              signedinUser: { displayName: "Ada" },
              earliestStartTime: "09:00",
              latestEndTime: "10:00",
            },
          ],
        }) as Response;
      }
      if (url.includes("/recordings")) {
        return jsonResponse({
          recordings: [
            {
              name: "r1",
              state: "FILE_GENERATED",
              driveDestination: { exportUri: "https://drive/x" },
            },
          ],
        }) as Response;
      }
      if (url.includes("/transcripts"))
        return jsonResponse({ transcripts: [{ name: "t1" }] }) as Response;
      if (url.includes("/smartNotes")) return jsonResponse({}, 404) as Response;
      return jsonResponse({ name: "conferenceRecords/c1", startTime: "09:00" }) as Response;
    });
    const { executeGoogleWorkspaceToolForTest } = await loadConnector([MEET_SCOPE]);

    const result = await executeGoogleWorkspaceToolForTest("google-workspace.meet_conference_get", {
      conferenceRecord: "conferenceRecords/c1",
    });
    expect(result.data).toMatchObject({
      attendance: [{ displayName: "Ada", earliestStartTime: "09:00", latestEndTime: "10:00" }],
      recordings: [{ name: "r1", exportUri: "https://drive/x" }],
      transcripts: [{ name: "t1" }],
      smartNotes: [],
    });
  });
});
