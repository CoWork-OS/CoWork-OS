import { createRequire } from "module";
import { afterEach, describe, expect, it } from "vitest";
import { YouTubeTranscriptStore } from "../YouTubeTranscriptStore";

const require = createRequire(import.meta.url);
const BetterSqlite3Module = (() => {
  try {
    return require("better-sqlite3") as typeof import("better-sqlite3");
  } catch {
    return null;
  }
})();

const BetterSqlite3 = (() => {
  if (!BetterSqlite3Module) return null;
  try {
    const probe = new BetterSqlite3Module(":memory:");
    probe.close();
    return BetterSqlite3Module;
  } catch {
    return null;
  }
})();

const describeWithNativeDb = BetterSqlite3 ? describe : describe.skip;
const databases: Array<import("better-sqlite3").Database> = [];

function createDb(): import("better-sqlite3").Database {
  if (!BetterSqlite3) throw new Error("better-sqlite3 unavailable");
  const db = new BetterSqlite3(":memory:");
  databases.push(db);
  return db;
}

afterEach(() => {
  YouTubeTranscriptStore.setDatabaseForTests(null);
  for (const db of databases.splice(0)) {
    db.close();
  }
});

describeWithNativeDb("YouTubeTranscriptStore", () => {
  it("saves videos and finds transcript segments with natural-language questions", async () => {
    YouTubeTranscriptStore.setDatabaseForTests(createDb());
    await YouTubeTranscriptStore.saveVideo("workspace-1", {
      videoId: "dQw4w9WgXcQ",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      title: "Planning Demo",
      channel: "CoWork",
      fetchedAt: 1_700_000_000,
    });
    await YouTubeTranscriptStore.saveSegments("workspace-1", "dQw4w9WgXcQ", [
      {
        videoId: "dQw4w9WgXcQ",
        startMs: 12_000,
        endMs: 18_000,
        text: "The implementation plan avoids external APIs and relies on local transcripts.",
        source: "manual",
        language: "en",
      },
    ]);

    const hits = await YouTubeTranscriptStore.search({
      query: "What is the implementation plan about APIs?",
      workspaceId: "workspace-1",
      limit: 5,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.title).toBe("Planning Demo");
    expect(hits[0]?.url).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=12s");
  });

  it("limits searches to the requested videos", async () => {
    YouTubeTranscriptStore.setDatabaseForTests(createDb());
    for (const videoId of ["dQw4w9WgXcQ", "abc123_DEF45"]) {
      await YouTubeTranscriptStore.saveVideo("workspace-1", {
        videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        title: videoId,
        fetchedAt: 1_700_000_000,
      });
      await YouTubeTranscriptStore.saveSegments("workspace-1", videoId, [
        {
          videoId,
          startMs: 0,
          text: "local transcript search implementation",
          source: "manual",
          language: "en",
        },
      ]);
    }

    const hits = await YouTubeTranscriptStore.search({
      query: "transcript implementation",
      workspaceId: "workspace-1",
      videoIds: ["abc123_DEF45"],
      limit: 5,
    });

    expect(hits.map((hit) => hit.videoId)).toEqual(["abc123_DEF45"]);
  });

  it("does not leak videos or transcript hits across workspaces", async () => {
    YouTubeTranscriptStore.setDatabaseForTests(createDb());
    await YouTubeTranscriptStore.saveVideo("workspace-1", {
      videoId: "dQw4w9WgXcQ",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      title: "Private Workspace Video",
      fetchedAt: 1_700_000_000,
    });
    await YouTubeTranscriptStore.saveSegments("workspace-1", "dQw4w9WgXcQ", [
      {
        videoId: "dQw4w9WgXcQ",
        startMs: 0,
        text: "workspace scoped transcript implementation",
        source: "manual",
        language: "en",
      },
    ]);

    expect(await YouTubeTranscriptStore.listVideos("workspace-2")).toEqual([]);
    expect(
      await YouTubeTranscriptStore.search({
        workspaceId: "workspace-2",
        query: "workspace scoped transcript",
      }),
    ).toEqual([]);
  });
});
