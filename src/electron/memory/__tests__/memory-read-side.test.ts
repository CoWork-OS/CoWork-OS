import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const personalityStyle = vi.hoisted(() => ({
  current: { responseLength: "balanced", emojiUsage: "minimal" } as Record<string, string>,
}));

vi.mock("../../settings/personality-manager", () => ({
  PersonalityManager: {
    getUserName: vi.fn(() => undefined),
    setUserName: vi.fn(),
    loadSettings: vi.fn(() => ({ responseStyle: personalityStyle.current })),
  },
}));

import { MemoryItemsRepository } from "../MemoryItemsRepository";
import { MemoryWriter } from "../MemoryWriter";
import {
  hasExplicitResponseStyle,
  installMemoryReadSide,
  isMemoryReadSideActive,
  setExplicitResponseStyleState,
  withSettingsResponseStyleMirror,
  type MemoryReadSideHandle,
} from "../memory-read-side";
import { preferredNameCandidate, responseStyleCandidate } from "../memory-items-lanes";
import { createMemoryItemsTestDb, nativeSqliteAvailable } from "./memory-items-test-db";

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("memory read side", () => {
  let db: Database.Database;
  let repository: MemoryItemsRepository;
  let writer: MemoryWriter;
  let handle: MemoryReadSideHandle | null;
  let userName: string | undefined;
  const deps = {
    getUserName: () => userName,
    setUserName: vi.fn((name: string) => {
      userName = name || undefined;
    }),
  };

  const settle = async () => {
    await writer.flush();
    await handle?.idle();
    await writer.flush();
    await handle?.idle();
  };

  beforeEach(async () => {
    db = await createMemoryItemsTestDb(["ws-1"]);
    repository = new MemoryItemsRepository(db);
    writer = new MemoryWriter({ repository });
    userName = undefined;
    deps.setUserName.mockClear();
    setExplicitResponseStyleState(false);
    handle = null;
  });

  afterEach(() => {
    handle?.dispose();
    db.close();
  });

  it("does nothing until the lane migration has finished", async () => {
    handle = installMemoryReadSide(writer, deps);
    await writer.ingest(preferredNameCandidate("Alice", { source: "user_stated" })!);
    await settle();
    expect(deps.setUserName).not.toHaveBeenCalled();
    expect(isMemoryReadSideActive()).toBe(false);
  });

  it("keeps PersonalityManager on the user-stated name (PROMPT-7)", async () => {
    await repository.recordLaneMigration({});
    handle = installMemoryReadSide(writer, deps);
    await settle();
    expect(isMemoryReadSideActive()).toBe(true);

    // Onboarding name, then set_user_name: the newer user statement wins.
    await writer.ingest({
      content: "Preferred name: Alice",
      kind: "identity",
      scope: "global",
      subjectKey: "preferred_name",
      source: "user_stated",
      sourceRef: { store: "user_profile", id: "onboarding" },
      pinned: true,
    });
    await settle();
    expect(userName).toBe("Alice");

    await writer.ingest(preferredNameCandidate("Bob", { source: "user_stated" })!);
    await settle();
    expect(userName).toBe("Bob");

    // A later inferred profile name is outranked and does not revert or replace it.
    const inferred = await writer.ingest({
      content: "Preferred name: Carol",
      kind: "identity",
      scope: "global",
      subjectKey: "preferred_name",
      source: "inferred",
    });
    await settle();
    expect(inferred).toMatchObject({ status: "skipped", reason: "outranked" });
    expect(userName).toBe("Bob");
  });

  it("adopts the live PersonalityManager name once after the migration", async () => {
    await writer.ingest({
      content: "Preferred name: Alice",
      kind: "identity",
      scope: "global",
      subjectKey: "preferred_name",
      source: "user_stated",
      mode: "migration",
      sourceRef: { store: "user_profile", id: "onboarding" },
    });
    await repository.recordLaneMigration({});
    userName = "Bob";

    handle = installMemoryReadSide(writer, deps);
    await settle();

    const [active] = await repository.list({
      workspaceId: null,
      subjectKey: "preferred_name",
      statuses: ["active"],
    });
    expect(active.content).toBe("Preferred name: Bob");
    expect(userName).toBe("Bob");
  });

  it("clears the name when the preferred_name item is deleted", async () => {
    await repository.recordLaneMigration({});
    handle = installMemoryReadSide(writer, deps);
    await writer.ingest(preferredNameCandidate("Dana", { source: "user_stated" })!);
    await settle();
    expect(userName).toBe("Dana");

    await writer.setStatusBySourceRef("personality", "user_name", "deleted");
    await settle();
    expect(userName).toBeUndefined();
  });

  it("tracks whether the user chose a response style explicitly", async () => {
    await repository.recordLaneMigration({});
    handle = installMemoryReadSide(writer, deps);

    await writer.ingest(
      responseStyleCandidate(
        { responseLength: "detailed" },
        { source: "inferred", store: "adaptive_style" },
      )!,
    );
    await settle();
    expect(hasExplicitResponseStyle()).toBe(false);

    await writer.ingest(
      responseStyleCandidate(
        { responseLength: "terse" },
        { source: "user_stated", store: "personality" },
      )!,
    );
    await settle();
    expect(hasExplicitResponseStyle()).toBe(true);
  });

  it("records a response style chosen in Settings as user-stated, and only when it changed", async () => {
    await repository.recordLaneMigration({});
    handle = installMemoryReadSide(writer, deps);
    MemoryWriter.setInstance(writer);
    try {
      await writer.ingest(
        responseStyleCandidate(
          { responseLength: "detailed" },
          { source: "inferred", store: "adaptive_style" },
        )!,
      );
      await settle();

      // A save that leaves the style alone writes nothing.
      withSettingsResponseStyleMirror(() => undefined);
      await settle();
      expect(hasExplicitResponseStyle()).toBe(false);

      const result = withSettingsResponseStyleMirror(() => {
        personalityStyle.current = { responseLength: "terse", emojiUsage: "none" };
        return "saved";
      });
      expect(result).toBe("saved");
      await settle();
      expect(hasExplicitResponseStyle()).toBe(true);
      const [item] = await repository.list({
        workspaceId: null,
        scope: "global",
        subjectKey: "response_style",
        statuses: ["active"],
      });
      expect(item.source).toBe("user_stated");
      expect(item.content).toContain("none emoji");
    } finally {
      MemoryWriter.setInstance(null);
    }
  });
});
