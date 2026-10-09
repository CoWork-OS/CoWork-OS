import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  BROWSER_HISTORY_SCHEMA_SQL,
  BrowserHistoryStore,
  MAX_BROWSER_HISTORY_ENTRIES,
} from "../BrowserHistoryRepository";
import { sanitizeHistoryUrl } from "../../../shared/browser-profile";

function store() {
  const db = new Database(":memory:");
  db.exec(BROWSER_HISTORY_SCHEMA_SQL);
  return { db, history: new BrowserHistoryStore(db) };
}

describe("browser history URLs", () => {
  it("keeps web pages without credentials, fragments or secret parameters", () => {
    expect(
      sanitizeHistoryUrl("https://user:pw@example.com/a?q=shoes&access_token=abc&code=xyz#top"),
    ).toBe("https://example.com/a?q=shoes");
    expect(
      sanitizeHistoryUrl(
        "https://s3.example/obj?X-Amz-Signature=abc&client_secret=s&jwt=x&q=keep&page=2",
      ),
    ).toBe("https://s3.example/obj?q=keep&page=2");
    expect(sanitizeHistoryUrl("https://app.example/reset/9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c")).toBe(
      "https://app.example/reset/redacted",
    );
    expect(sanitizeHistoryUrl("https://blog.example/posts/how-to-write-good-tests")).toBe(
      "https://blog.example/posts/how-to-write-good-tests",
    );
    expect(sanitizeHistoryUrl("file:///Users/me/secret.html")).toBeNull();
    expect(sanitizeHistoryUrl("about:blank")).toBeNull();
    expect(sanitizeHistoryUrl("not a url")).toBeNull();
  });
});

describe("BrowserHistoryStore", () => {
  it("records visits per profile and counts repeats", () => {
    const { history } = store();
    history.recordVisit({
      profileKey: "ws1",
      url: "https://example.com/",
      title: "Example",
      visitedAt: 1,
    });
    const again = history.recordVisit({
      profileKey: "ws1",
      url: "https://example.com/#section",
      title: "",
      visitedAt: 5,
    });
    expect(again).toMatchObject({
      url: "https://example.com/",
      title: "Example",
      visitCount: 2,
      lastVisitAt: 5,
    });
    history.recordVisit({
      profileKey: "ws2",
      url: "https://example.com/",
      title: "Other",
      visitedAt: 2,
    });
    expect(history.list({ profileKey: "ws1" })).toHaveLength(1);
    expect(history.recordVisit({ profileKey: "ws1", url: "file:///x.html" })).toBeNull();
  });

  it("ranks URL prefix matches above title matches and treats LIKE characters literally", () => {
    const { history } = store();
    history.recordVisit({
      profileKey: "p",
      url: "https://docs.example.com/guide",
      title: "Guide",
      visitedAt: 1,
    });
    history.recordVisit({
      profileKey: "p",
      url: "https://news.site/",
      title: "Read the docs today",
      visitedAt: 2,
    });
    history.recordVisit({
      profileKey: "p",
      url: "https://other.site/100%25",
      title: "Percent",
      visitedAt: 3,
    });
    expect(history.search({ profileKey: "p", query: "docs" }).map((entry) => entry.url)).toEqual([
      "https://docs.example.com/guide",
      "https://news.site/",
    ]);
    expect(history.search({ profileKey: "p", query: "%" }).map((entry) => entry.url)).toEqual([
      "https://other.site/100%25",
    ]);
  });

  it("updates titles, removes entries and clears by time range", () => {
    const { history, db } = store();
    const first = history.recordVisit({
      profileKey: "p",
      url: "https://a.example/",
      visitedAt: 100,
    });
    history.recordVisit({ profileKey: "p", url: "https://b.example/", visitedAt: 200 });
    history.updatePage({ profileKey: "p", url: "https://a.example/", title: "Alpha" });
    expect(history.findById(first!.id)?.title).toBe("Alpha");

    expect(history.clear({ profileKey: "p", since: 150 })).toBe(1);
    expect(history.list({ profileKey: "p" }).map((entry) => entry.url)).toEqual([
      "https://a.example/",
    ]);
    expect(history.remove({ profileKey: "p", ids: [first!.id] })).toBe(1);
    expect(history.list({ profileKey: "p" })).toEqual([]);
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM browser_history_visits").get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
  });

  it("keeps at most the newest entries per profile", () => {
    const { history, db } = store();
    const insert = db.prepare(
      `INSERT INTO browser_history (id, profile_key, url, title, visit_count, first_visit_at, last_visit_at)
       VALUES (?, 'p', ?, '', 1, ?, ?)`,
    );
    const total = MAX_BROWSER_HISTORY_ENTRIES + 300;
    db.transaction(() => {
      for (let index = 0; index < total; index += 1) {
        insert.run(`id-${index}`, `https://site.example/${index}`, index, index);
      }
    })();
    history.recordVisit({ profileKey: "p", url: "https://site.example/new", visitedAt: total + 1 });
    const count = (
      db.prepare("SELECT COUNT(*) AS count FROM browser_history WHERE profile_key = 'p'").get() as {
        count: number;
      }
    ).count;
    expect(count).toBe(MAX_BROWSER_HISTORY_ENTRIES);
    expect(history.findById("id-0")).toBeUndefined();
  });
});
