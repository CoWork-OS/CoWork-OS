import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeetingArtifactStore, artifactIdFor } from "../artifact-store";
import { parseWebVtt, renderMeetingMarkdown } from "../vtt";
import { TeamsArtifactPipeline } from "../teams/teams-artifact-pipeline";
import { TeamsGraphClient, TeamsGraphError } from "../teams/teams-graph-client";
import { TEAMS_MEETING_DEFAULTS, type TeamsMeetingSettings } from "../teams/teams-meeting-settings";

const VTT = `WEBVTT

00:00:01.000 --> 00:00:04.000
<v Ada Lovelace>Let's review the launch plan.</v>

00:00:04.500 --> 00:00:06.000
<v Ada Lovelace>First, the rollout dates.</v>

00:00:06.500 --> 00:00:09.000
<v Grace Hopper>Ship on &quot;Tuesday&quot; &amp; monitor.</v>
`;

const NOW = Date.parse("2026-09-25T12:00:00Z");
const JOIN_URL = "https://teams.microsoft.com/l/meetup-join/abc";

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("parseWebVtt", () => {
  it("merges consecutive cues per speaker and decodes entities", () => {
    const cues = parseWebVtt(VTT);
    expect(cues).toEqual([
      {
        start: "00:00:01.000",
        end: "00:00:06.000",
        speaker: "Ada Lovelace",
        text: "Let's review the launch plan. First, the rollout dates.",
      },
      {
        start: "00:00:06.500",
        end: "00:00:09.000",
        speaker: "Grace Hopper",
        text: 'Ship on "Tuesday" & monitor.',
      },
    ]);
  });

  it("renders Markdown without letting transcript text inject structure", () => {
    const markdown = renderMeetingMarkdown({
      title: "Plan # review",
      provider: "Microsoft Teams",
      cues: [
        {
          start: "00:01:02.000",
          end: "00:01:03.000",
          speaker: "Eve",
          text: "# not a heading [x](y)",
        },
      ],
      retrievedAt: "2026-09-25T12:00:00.000Z",
    });
    expect(markdown).toContain("# Plan \\# review");
    expect(markdown).toContain("**Eve** `01:02`");
    expect(markdown).toContain("\\# not a heading \\[x\\](y)");
  });
});

describe("TeamsGraphClient", () => {
  it("refreshes an expired token once after a 401 and retries 429 with Retry-After", async () => {
    let tokens = {
      clientId: "client",
      accessToken: "old",
      refreshToken: "refresh",
      tokenExpiresAt: Date.now() + 3600_000,
    };
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      calls.push(auth);
      if (auth === "Bearer old")
        return json({ error: { code: "InvalidAuthenticationToken" } }, 401);
      if (calls.length === 2) return json({}, 429, { "Retry-After": "2" });
      return json({ ok: true });
    });
    const sleep = vi.fn(async () => undefined);
    const client = new TeamsGraphClient({
      loadTokens: () => tokens,
      saveTokens: (next) => {
        tokens = { ...tokens, ...next };
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      refresh: vi.fn(async () => ({ accessToken: "new", expiresIn: 3600 })),
    });

    await expect(client.json("GET", "/me")).resolves.toEqual({ ok: true });
    expect(calls).toEqual(["Bearer old", "Bearer new", "Bearer new"]);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(tokens.accessToken).toBe("new");
  });

  it("classifies tenant policy blocks and refuses non-Graph hosts", async () => {
    const client = new TeamsGraphClient({
      loadTokens: () => ({ accessToken: "t" }),
      saveTokens: () => undefined,
      fetchImpl: (async () =>
        json(
          {
            error: { code: "Forbidden", innerError: { code: "GraphAccessToTranscriptsDisabled" } },
          },
          403,
        )) as unknown as typeof fetch,
    });
    await expect(client.json("GET", "/me/onlineMeetings/x/transcripts")).rejects.toMatchObject({
      kind: "tenant_blocked",
    });
    await expect(client.json("GET", "https://evil.example.com/steal")).rejects.toBeInstanceOf(
      TeamsGraphError,
    );
  });
});

describe("TeamsArtifactPipeline", () => {
  let root: string;
  let settings: TeamsMeetingSettings;
  let graph: (url: string, init?: RequestInit) => Response;
  let requests: Array<{ url: string; method: string; body?: unknown }>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "teams-pipeline-"));
    settings = {
      ...TEAMS_MEETING_DEFAULTS,
      enabled: true,
      clientId: "client",
      accessToken: "token",
      tokenExpiresAt: Date.now() + 3600_000,
      userId: "user-1",
      clientState: "secret-client-state",
    };
    requests = [];
    graph = (url) => {
      if (url.includes("/me/calendarView")) {
        return json({
          value: [
            {
              subject: "Launch review",
              start: { dateTime: "2026-09-25T09:00:00.0000000", timeZone: "UTC" },
              end: { dateTime: "2026-09-25T10:00:00.0000000", timeZone: "UTC" },
              organizer: { emailAddress: { name: "Ada Lovelace" } },
              isOnlineMeeting: true,
              onlineMeetingProvider: "teamsForBusiness",
              onlineMeeting: { joinUrl: JOIN_URL },
            },
            {
              subject: "Still running",
              start: { dateTime: "2026-09-25T11:30:00", timeZone: "UTC" },
              end: { dateTime: "2026-09-25T12:30:00", timeZone: "UTC" },
              isOnlineMeeting: true,
              onlineMeetingProvider: "teamsForBusiness",
              onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/later" },
            },
          ],
        });
      }
      if (url.includes("/me/onlineMeetings?$filter="))
        return json({ value: [{ id: "meeting-1" }] });
      if (url.endsWith("/me/onlineMeetings/meeting-1/transcripts")) {
        return json({ value: [{ id: "transcript-1" }] });
      }
      if (url.includes("/transcripts/transcript-1/content"))
        return new Response(VTT, { status: 200 });
      if (url.endsWith("/recordings"))
        return json({ value: [{ id: "rec-1", createdDateTime: "x" }] });
      if (url.endsWith("/subscriptions")) {
        return json({
          id: "sub-1",
          expirationDateTime: new Date(NOW + 70 * 3600_000).toISOString(),
        });
      }
      return json({ error: { code: "NotFound" } }, 404);
    };
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function createPipeline() {
    const client = new TeamsGraphClient({
      loadTokens: () => settings,
      saveTokens: (next) => {
        settings = { ...settings, ...next };
      },
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({
          url,
          method: init?.method || "GET",
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        });
        return graph(url, init);
      }) as unknown as typeof fetch,
      sleep: async () => undefined,
    });
    const store = new MeetingArtifactStore(path.join(root, "artifacts"));
    const pipeline = new TeamsArtifactPipeline({
      stateDir: path.join(root, "state"),
      store,
      client,
      loadSettings: () => settings,
      now: () => NOW,
    });
    return { pipeline, store };
  }

  it("turns an ended meeting's transcript into a local artifact exactly once", async () => {
    const { pipeline, store } = createPipeline();
    const status = await pipeline.syncNow();

    expect(status).toMatchObject({ state: "idle", pendingJobs: 0, artifactCount: 1 });
    const [artifact] = store.list();
    expect(artifact).toMatchObject({
      id: artifactIdFor("teams", "meeting-1|transcript-1"),
      title: "Launch review",
      organizer: "Ada Lovelace",
      startTime: "2026-09-25T09:00:00.000Z",
      cueCount: 2,
      recordings: [{ id: "rec-1", createdDateTime: "x" }],
      sourceRef: { meetingId: "meeting-1", transcriptId: "transcript-1" },
    });
    expect(store.readMarkdown(artifact.id)).toContain("**Grace Hopper**");
    // The meeting that has not ended yet was not resolved.
    expect(requests.some((request) => request.url.includes("later"))).toBe(false);

    const transcriptFetches = () =>
      requests.filter((request) => request.url.includes("/content")).length;
    expect(transcriptFetches()).toBe(1);
    await pipeline.syncNow();
    expect(transcriptFetches()).toBe(1);

    // State survives a restart: a new pipeline does not refetch either.
    const { pipeline: restarted } = createPipeline();
    await restarted.syncNow();
    expect(transcriptFetches()).toBe(1);
  });

  it("retries failed transcript fetches with backoff and reports persistent failures", async () => {
    const base = graph;
    graph = (url, init) =>
      url.includes("/content")
        ? json({ error: { code: "ServiceUnavailable" } }, 500)
        : base(url, init);
    const { pipeline } = createPipeline();

    const first = await pipeline.syncNow();
    expect(first).toMatchObject({ pendingJobs: 1, artifactCount: 0 });
    await pipeline.syncNow();
    // Backoff: the second pass does not retry immediately.
    expect(requests.filter((request) => request.url.includes("/content"))).toHaveLength(1);
  });

  it("stops with an honest state when the tenant blocks transcript access", async () => {
    const base = graph;
    graph = (url, init) =>
      url.endsWith("/transcripts")
        ? json(
            {
              error: {
                code: "Forbidden",
                innerError: { code: "GraphAccessToTranscriptsDisabled" },
              },
            },
            403,
          )
        : base(url, init);
    const { pipeline } = createPipeline();

    const status = await pipeline.syncNow();
    expect(status.state).toBe("blocked");
    expect(status.lastError).toMatch(/tenant administrator/);
  });

  it("skips meetings the user did not organize", async () => {
    const base = graph;
    graph = (url, init) =>
      url.endsWith("/transcripts") ? json({ error: { code: "Forbidden" } }, 403) : base(url, init);
    const { pipeline } = createPipeline();

    expect(await pipeline.syncNow()).toMatchObject({ state: "idle", artifactCount: 0 });
  });

  it("answers Graph validation and trusts only notifications with the right clientState", async () => {
    settings.notificationPublicUrl = "https://hooks.example.com";
    const { pipeline } = createPipeline();
    await (pipeline as unknown as { ensureSubscription: () => Promise<void> }).ensureSubscription();
    const created = requests.find((request) => request.url.endsWith("/subscriptions"));
    expect(created?.body).toMatchObject({
      resource: "users/user-1/onlineMeetings/getAllTranscripts",
      notificationUrl: "https://hooks.example.com/teams-meetings/notifications",
      lifecycleNotificationUrl: "https://hooks.example.com/teams-meetings/lifecycle",
      includeResourceData: false,
      clientState: "secret-client-state",
    });

    const server = http.createServer(
      (req, res) => void pipeline.handleNotificationRequest(req, res),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const validation = await fetch(
        `${base}/teams-meetings/notifications?validationToken=${encodeURIComponent("abc 123")}`,
        { method: "POST" },
      );
      expect(await validation.text()).toBe("abc 123");

      const forged = await fetch(`${base}/teams-meetings/notifications`, {
        method: "POST",
        body: JSON.stringify({ value: [{ subscriptionId: "sub-1", clientState: "wrong" }] }),
      });
      expect(forged.status).toBe(202);
      expect(pipeline.status().subscription?.lastNotificationAt).toBeUndefined();

      await fetch(`${base}/teams-meetings/notifications`, {
        method: "POST",
        body: JSON.stringify({
          value: [{ subscriptionId: "sub-1", clientState: "secret-client-state" }],
        }),
      });
      await vi.waitFor(() =>
        expect(pipeline.status().subscription?.lastNotificationAt).toBeDefined(),
      );
    } finally {
      await pipeline.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("renews the subscription on reauthorizationRequired and recreates it when removed", async () => {
    settings.notificationPublicUrl = "https://hooks.example.com";
    const base = graph;
    graph = (url, init) =>
      init?.method === "PATCH"
        ? json({ expirationDateTime: new Date(NOW + 70 * 3600_000).toISOString() })
        : base(url, init);
    const { pipeline } = createPipeline();
    const internal = pipeline as unknown as {
      ensureSubscription: () => Promise<void>;
      handleTrustedNotification: (event?: string) => Promise<void>;
    };
    await internal.ensureSubscription();

    await internal.handleTrustedNotification("reauthorizationRequired");
    expect(requests.some((request) => request.method === "PATCH")).toBe(true);

    await internal.handleTrustedNotification("subscriptionRemoved");
    expect(requests.filter((request) => request.url.endsWith("/subscriptions"))).toHaveLength(2);
    await pipeline.stop();
  });
});
