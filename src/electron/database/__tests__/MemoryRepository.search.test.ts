import { describe, it, expect, vi } from "vitest";

// Avoid loading the native better-sqlite3 module in unit tests.
vi.mock("better-sqlite3", () => ({
  default: class MockBetterSqlite3 {},
}));

import { MemoryRepository } from "../repositories";

describe("MemoryRepository.search", () => {
  it("retries FTS search with a relaxed OR query when the raw query returns no rows", () => {
    const row = {
      id: "mem-1",
      summary: null,
      content: '[Imported from ChatGPT - "Test"]\nPMNL sessions and Portuguese support.',
      type: "insight",
      created_at: 1710000000000,
      task_id: null,
      score: -0.25,
    };

    const all = vi.fn((ftsQuery: string) => {
      // First call: raw natural-language prompt (no OR) -> no results.
      if (!ftsQuery.includes(" OR ")) return [];
      // Second call: relaxed query should include OR and key tokens -> return result.
      if (
        ftsQuery.toLowerCase().includes("pmnl") ||
        ftsQuery.toLowerCase().includes("portuguese")
      ) {
        return [row];
      }
      return [];
    });

    const mockDb = {
      prepare: vi.fn(() => ({ all })),
    };

    const repo = new MemoryRepository(mockDb as Any);

    const query =
      "I need to write an email to the class teacher about PMNL sessions. " +
      "Check ChatGPT memory to see what I should write to get Portuguese language support.";

    const results = repo.search("ws-1", query, 20, true);

    expect(results).toHaveLength(1);
    expect(all).toHaveBeenCalledTimes(2);
    expect(String(all.mock.calls[0][0])).toContain("PMNL");
    expect(String(all.mock.calls[1][0])).toContain(" OR ");
  });

  it("retries with a relaxed query when the raw FTS query throws due to syntax/punctuation", () => {
    const row = {
      id: "mem-2",
      summary: null,
      content: '[Imported from ChatGPT - "Test"]\nPortuguese language support for Enes.',
      type: "observation",
      created_at: 1710000001000,
      task_id: null,
      score: -0.1,
    };

    const all = vi.fn((ftsQuery: string) => {
      if (ftsQuery.includes(",")) {
        throw new Error('fts5: syntax error near ","');
      }
      if (ftsQuery.includes(" OR ")) return [row];
      return [];
    });

    const mockDb = {
      prepare: vi.fn(() => ({ all })),
    };

    const repo = new MemoryRepository(mockDb as Any);

    const results = repo.search("ws-1", "PMNL, Portuguese support, Enes", 20, true);

    expect(results).toHaveLength(1);
    expect(all).toHaveBeenCalledTimes(2);
    expect(String(all.mock.calls[0][0])).toContain(",");
    expect(String(all.mock.calls[1][0])).toContain(" OR ");
  });

  it("searchImportedGlobal uses global imported filter (no workspace constraint)", () => {
    const row = {
      id: "mem-imp-1",
      summary: null,
      content: '[Imported from ChatGPT - "Any WS"]\nPMNL sessions.',
      type: "insight",
      created_at: 1710000002000,
      task_id: null,
      score: -0.2,
    };

    const all = vi.fn((ftsQuery: string) => {
      // Only return a row when the relaxed OR query is used, to prove retry works.
      if (!ftsQuery.includes(" OR ")) return [];
      return [row];
    });

    const mockDb = {
      prepare: vi.fn(() => ({ all })),
    };

    const repo = new MemoryRepository(mockDb as Any);
    const results = repo.searchImportedGlobal("PMNL Portuguese support", 10, true);

    expect(results).toHaveLength(1);
    // Called twice: raw and relaxed
    expect(all).toHaveBeenCalledTimes(2);
  });
});
