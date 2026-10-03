import { createRequire } from "module";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFtsMatchQuery,
  buildFtsPhraseQuery,
  escapeLikePattern,
  extractFtsTerms,
  extractKeywords,
  foldForMatch,
  likeContainsPattern,
  LIKE_ESCAPE_CLAUSE,
  termCoverage,
} from "../fts-query";

const require = createRequire(import.meta.url);
const BetterSqlite3 = (() => {
  try {
    const Module = require("better-sqlite3") as typeof import("better-sqlite3");
    new Module(":memory:").close();
    return Module;
  } catch {
    return null;
  }
})();
const describeWithNativeDb = BetterSqlite3 ? describe : describe.skip;
const databases: Array<import("better-sqlite3").Database> = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("extractFtsTerms", () => {
  it("keeps Turkish, German, accented and non-Latin words whole", () => {
    expect(extractFtsTerms("İstanbul'daki şehir planı ılık")).toEqual([
      "İstanbul'daki",
      "şehir",
      "planı",
      "ılık",
    ]);
    expect(extractFtsTerms("Größe der Straße, Übersicht")).toEqual([
      "Größe",
      "der",
      "Straße",
      "Übersicht",
    ]);
    expect(extractFtsTerms("café crème naïve")).toEqual(["café", "crème", "naïve"]);
    expect(extractFtsTerms("Привет мир 東京")).toEqual(["Привет", "мир", "東京"]);
  });

  it("keeps file names, paths and identifiers as one term", () => {
    expect(extractFtsTerms("open executor.ts and src/app.tsx:42 (task-id_123)")).toEqual(
      ["open", "executor.ts", "and", "src/app.tsx:42", "task-id_123"].filter(
        (term) => term !== "and",
      ),
    );
  });

  it("drops bare operator words next to real terms, case-insensitively", () => {
    expect(extractFtsTerms("cats AND dogs OR NOT birds NEAR fish")).toEqual([
      "cats",
      "dogs",
      "birds",
      "fish",
    ]);
    expect(extractFtsTerms("NOT")).toEqual(["NOT"]);
  });

  it("de-duplicates case- and accent-insensitively and caps count and length", () => {
    expect(extractFtsTerms("Cafe café CAFE")).toEqual(["Cafe"]);
    const many = Array.from({ length: 40 }, (_, index) => `term${index}`).join(" ");
    expect(extractFtsTerms(many)).toHaveLength(12);
    expect(extractFtsTerms(many, { maxTerms: 3 })).toEqual(["term0", "term1", "term2"]);
    expect(Array.from(extractFtsTerms("x".repeat(500))[0]!)).toHaveLength(64);
  });

  it("strips FTS syntax characters", () => {
    expect(extractFtsTerms('"quoted" col:umn* ^start (paren) -minus +plus')).toEqual([
      "quoted",
      "col:umn",
      "start",
      "paren",
      "minus",
      "plus",
    ]);
  });
});

describe("buildFtsMatchQuery", () => {
  it("quotes every term and joins by mode", () => {
    expect(buildFtsMatchQuery("deploy staging")).toBe('"deploy" AND "staging"');
    expect(buildFtsMatchQuery("deploy staging", { mode: "any", prefix: true })).toBe(
      '"deploy"* OR "staging"*',
    );
    expect(buildFtsMatchQuery("executor.ts")).toBe('"executor.ts"');
  });

  it("drops stopwords from any-term queries only, unless nothing else is left", () => {
    expect(buildFtsMatchQuery("when do we ship the postgres 16 migration", { mode: "any" })).toBe(
      '"ship" OR "postgres" OR "16" OR "migration"',
    );
    expect(buildFtsMatchQuery("who owns the payments service", { mode: "any" })).toBe(
      '"owns" OR "payments" OR "service"',
    );
    // Turkish, German, French and Spanish function words.
    expect(buildFtsMatchQuery("haftalık toplantı ne zaman ve", { mode: "any" })).toBe(
      '"haftalık" OR "toplantı" OR "zaman"',
    );
    expect(buildFtsMatchQuery("Wer muss die Reviews freigeben", { mode: "any" })).toBe(
      '"muss" OR "Reviews" OR "freigeben"',
    );
    expect(buildFtsMatchQuery("quand est la réunion", { mode: "any" })).toBe('"réunion"');
    expect(buildFtsMatchQuery("cuándo es la reunión", { mode: "any" })).toBe('"reunión"');
    // All-terms mode keeps every term.
    expect(buildFtsMatchQuery("the postgres migration")).toBe(
      '"the" AND "postgres" AND "migration"',
    );
    // A query of only stopwords is still searched.
    expect(buildFtsMatchQuery("what is this", { mode: "any" })).toBe('"what" OR "is" OR "this"');
    expect(buildFtsMatchQuery("the", { mode: "any", dropStopwords: false })).toBe('"the"');
  });

  it("returns null when nothing searchable remains", () => {
    expect(buildFtsMatchQuery("")).toBeNull();
    expect(buildFtsMatchQuery("  ***  ()  ")).toBeNull();
  });

  it("builds marker phrases", () => {
    expect(buildFtsPhraseQuery("[suggestion-feedback:acted_on]")).toBe(
      '"suggestion-feedback:acted_on"',
    );
    expect(buildFtsPhraseQuery("[AND]")).toBeNull();
  });
});

describe("LIKE helpers", () => {
  it("escapes wildcards and the escape character", () => {
    expect(escapeLikePattern("100%_done\\x")).toBe("100\\%\\_done\\\\x");
    expect(likeContainsPattern(" a_b ")).toBe("%a\\_b%");
    expect(LIKE_ESCAPE_CLAUSE).toBe("ESCAPE '\\'");
  });
});

describe("extractKeywords", () => {
  it("reduces a long prompt to at most 12 distinctive terms", () => {
    const prompt =
      "Please can you look at the executor.ts file and fix the flaky retry logic in the " +
      "deployment pipeline? The retry logic should back off. Also update the docs for the " +
      "deployment pipeline and make sure the tests in executor.test.ts pass. " +
      "Lütfen İstanbul ofisindeki dağıtım planını da kontrol et. Die Größe der Datei ist wichtig.";
    const keywords = extractKeywords(prompt);
    expect(keywords.length).toBeLessThanOrEqual(12);
    expect(keywords).toEqual(
      expect.arrayContaining(["executor.ts", "retry", "deployment", "pipeline"]),
    );
    for (const stopword of ["the", "and", "Please", "can", "you", "Lütfen", "der"]) {
      expect(keywords).not.toContain(stopword);
    }
  });

  it("honours a smaller cap", () => {
    expect(extractKeywords("alpha beta gamma delta epsilon", 2)).toHaveLength(2);
  });
});

describe("termCoverage and foldForMatch", () => {
  it("matches case- and accent-insensitively", () => {
    expect(foldForMatch("İSTANBUL Größe Café")).toBe("istanbul große cafe");
    expect(termCoverage("Visited the CAFÉ in İstanbul", "cafe istanbul")).toBe(1);
    expect(termCoverage("Visited the café", "cafe istanbul")).toBe(0.5);
    expect(termCoverage("", "cafe")).toBe(0);
  });
});

describeWithNativeDb("buildFtsMatchQuery against SQLite FTS5", () => {
  function createIndex(tokenizer: string) {
    const db = new BetterSqlite3!(":memory:");
    databases.push(db);
    db.exec(`CREATE VIRTUAL TABLE docs USING fts5(text, tokenize='${tokenizer}')`);
    const insert = db.prepare(`INSERT INTO docs(rowid, text) VALUES (?, ?)`);
    const rows = [
      "İstanbul'daki şehir planı onaylandı",
      "Die Größe der Übersicht wurde angepasst",
      "Le café crème était naïve",
      "Edited src/electron/agent/executor.ts to fix the retry loop",
      "cats and dogs living together",
      "The deployment finished on staging",
      "Discount: 100% off for user_name",
    ];
    rows.forEach((text, index) => insert.run(index + 1, text));
    const match = (query: string, options = {}) => {
      const fts = buildFtsMatchQuery(query, { prefix: true, ...options });
      if (!fts) return [];
      return (
        db.prepare(`SELECT rowid FROM docs WHERE docs MATCH ? ORDER BY rowid`).all(fts) as Array<{
          rowid: number;
        }>
      ).map((row) => row.rowid);
    };
    return { db, match };
  }

  it("finds Unicode text, file names and prefixes", () => {
    const { match } = createIndex("unicode61 remove_diacritics 2");
    expect(match("şehir")).toEqual([1]);
    expect(match("ŞEHİR planı")).toEqual([1]);
    // Folding is not locale-aware: dotless ı stays distinct from I/i.
    expect(match("ŞEHİR PLANI")).toEqual([]);
    expect(match("istanbul")).toEqual([1]);
    expect(match("größe übersicht")).toEqual([2]);
    expect(match("GRÖSSE")).toEqual([]);
    expect(match("cafe creme")).toEqual([3]);
    expect(match("naive")).toEqual([3]);
    expect(match("executor.ts")).toEqual([4]);
    expect(match("agent/executor.ts")).toEqual([4]);
    expect(match("deploy")).toEqual([6]);
    expect(match("user_name")).toEqual([7]);
  });

  it("never throws on operator-like or hostile input", () => {
    const { match } = createIndex("unicode61");
    expect(match("cats AND dogs")).toEqual([5]);
    expect(match("cats OR")).toEqual([5]);
    expect(match("NOT")).toEqual([]);
    expect(match("NEAR(cats dogs)")).toEqual([5]);
    for (const hostile of [
      '"',
      '"unterminated',
      "text:column",
      "*",
      "^start",
      "a AND (b OR",
      "100%",
      "-cats",
      "{col1 col2}: x",
    ]) {
      expect(() => match(hostile)).not.toThrow();
    }
  });
});
