import { createRequire } from "module";
import { afterEach, describe, expect, it } from "vitest";
import { YouTubeQuestionService } from "../YouTubeQuestionService";
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

describeWithNativeDb("YouTubeQuestionService", () => {
  it("answers from already-ingested transcript segments without fetching the network", async () => {
    YouTubeTranscriptStore.setDatabaseForTests(createDb());
    await YouTubeTranscriptStore.saveVideo("workspace-1", {
      videoId: "dQw4w9WgXcQ",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      title: "Local Video",
      fetchedAt: 1_700_000_000,
    });
    await YouTubeTranscriptStore.saveSegments("workspace-1", "dQw4w9WgXcQ", [
      {
        videoId: "dQw4w9WgXcQ",
        startMs: 2_000,
        text: "The feature answers questions by searching the local transcript index.",
        source: "manual",
        language: "en",
      },
    ]);

    const result = await new YouTubeQuestionService("workspace-1", "/tmp/workspace").ask({
      question: "How does the feature answer questions?",
      videoIds: ["dQw4w9WgXcQ"],
    });

    expect(result.ok).toBe(true);
    expect(result.answer).toContain("Local Video at 0:02");
    expect(result.sources[0]?.url).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=2s");
  });

  it("returns validation errors for empty questions", async () => {
    const result = await new YouTubeQuestionService("workspace-1", "/tmp/workspace").ask({
      question: " ",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Question is required.");
  });
});
