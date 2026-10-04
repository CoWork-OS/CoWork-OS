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
    setResponseStyle: vi.fn((style: Record<string, string>) => {
      personalityStyle.current = { ...personalityStyle.current, ...style };
    }),
  },
}));

import { MemoryItemsRepository } from "../MemoryItemsRepository";
import { MemoryWriter } from "../MemoryWriter";
import {
  hasExplicitResponseStyle,
  installMemoryReadSide,
  isMemoryReadSideActive,
  isRevertOfStyleAdaptation,
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

  it("runs from installation (the engine installs it after the startup migration)", async () => {
    expect(isMemoryReadSideActive()).toBe(false);
    handle = installMemoryReadSide(writer, deps);
    expect(isMemoryReadSideActive()).toBe(true);
    await writer.ingest(preferredNameCandidate("Alice", { source: "user_stated" })!);
    await settle();
    expect(userName).toBe("Alice");
    handle.dispose();
    handle = null;
    expect(isMemoryReadSideActive()).toBe(false);
  });

  it("mirrors the response_style item into PersonalityManager's live style", async () => {
    personalityStyle.current = { responseLength: "balanced", emojiUsage: "minimal" };
    handle = installMemoryReadSide(writer, deps);
    await writer.ingest(
      responseStyleCandidate(
        { responseLength: "terse", emojiUsage: "minimal" },
        { source: "inferred", store: "adaptive_style", reason: "feedback" },
      )!,
    );
    await settle();
    expect(personalityStyle.current).toMatchObject({ responseLength: "terse" });

    // A user-stated style outranks later inferences, so they never reach the live style.
    await writer.ingest(
      responseStyleCandidate(
        { responseLength: "detailed", emojiUsage: "none" },
        { source: "user_stated", store: "personality", reason: "settings" },
      )!,
    );
    await writer.ingest(
      responseStyleCandidate(
        { responseLength: "terse", emojiUsage: "minimal" },
        { source: "inferred", store: "adaptive_style" },
      )!,
    );
    await settle();
    expect(personalityStyle.current).toMatchObject({ responseLength: "detailed", emojiUsage: "none" });

    // An item without a structured style (copied from the retired lane) changes nothing.
    await writer.ingest({
      content: "Response style: short answers.",
      kind: "preference",
      scope: "global",
      subjectKey: "response_style",
      source: "user_stated",
      sourceRef: { store: "adaptive_style", id: "legacy" },
    });
    await settle();
    expect(personalityStyle.current).toMatchObject({ responseLength: "detailed" });
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

  describe("stale settings saves", () => {
    const adapted = { responseLength: "terse", emojiUsage: "minimal" };
    const loadedByForm = { responseLength: "balanced", emojiUsage: "minimal" };
    const history = [{ dimension: "responseLength", fromValue: "balanced", toValue: "terse" }];

    const activeStyleItem = async () =>
      (
        await repository.list({
          workspaceId: null,
          scope: "global",
          subjectKey: "response_style",
          statuses: ["active"],
        })
      )[0];

    beforeEach(async () => {
      await repository.recordLaneMigration({});
      handle = installMemoryReadSide(writer, deps);
      MemoryWriter.setInstance(writer);
      // The engine adapted the style after the form loaded it.
      personalityStyle.current = { ...adapted };
      await writer.ingest(
        responseStyleCandidate(adapted, { source: "inferred", store: "adaptive_style" })!,
      );
      await settle();
    });

    afterEach(() => {
      MemoryWriter.setInstance(null);
      personalityStyle.current = { responseLength: "balanced", emojiUsage: "minimal" };
    });

    it("does not record a stale form copy and keeps the adapted style (baseline sent)", async () => {
      withSettingsResponseStyleMirror(
        () => {
          personalityStyle.current = { ...loadedByForm };
        },
        { baseline: loadedByForm },
      );
      await settle();
      expect(hasExplicitResponseStyle()).toBe(false);
      expect((await activeStyleItem()).source).toBe("inferred");
      // The stale copy did not revert what the engine adapted.
      expect(personalityStyle.current.responseLength).toBe("terse");
    });

    it("records a style the user changed in the form (baseline sent)", async () => {
      withSettingsResponseStyleMirror(
        () => {
          personalityStyle.current = { responseLength: "detailed", emojiUsage: "minimal" };
        },
        { baseline: loadedByForm },
      );
      await settle();
      expect(hasExplicitResponseStyle()).toBe(true);
      expect((await activeStyleItem()).source).toBe("user_stated");
    });

    it("without a baseline, does not record a save that exactly undoes the last adaptation", async () => {
      withSettingsResponseStyleMirror(
        () => {
          personalityStyle.current = { ...loadedByForm };
        },
        { adaptationHistory: history },
      );
      await settle();
      expect(hasExplicitResponseStyle()).toBe(false);

      // Any other change is still the user's choice.
      withSettingsResponseStyleMirror(
        () => {
          personalityStyle.current = { responseLength: "detailed", emojiUsage: "none" };
        },
        { adaptationHistory: history },
      );
      await settle();
      expect(hasExplicitResponseStyle()).toBe(true);
    });
  });
});

describe("isRevertOfStyleAdaptation", () => {
  const history = [
    { dimension: "responseLength", fromValue: "detailed", toValue: "balanced" },
    { dimension: "responseLength", fromValue: "balanced", toValue: "terse" },
    { dimension: "emojiUsage", fromValue: "none", toValue: "minimal" },
  ];

  it("matches only the latest adaptation of every changed dimension", () => {
    expect(
      isRevertOfStyleAdaptation(
        { responseLength: "terse", emojiUsage: "minimal" },
        { responseLength: "balanced", emojiUsage: "none" },
        history,
      ),
    ).toBe(true);
    // An older value of the dimension is not the latest adaptation.
    expect(
      isRevertOfStyleAdaptation({ responseLength: "terse" }, { responseLength: "detailed" }, history),
    ).toBe(false);
    // A changed dimension the engine never adapted is a user change.
    expect(
      isRevertOfStyleAdaptation(
        { responseLength: "terse", codeCommentStyle: "minimal" },
        { responseLength: "balanced", codeCommentStyle: "verbose" },
        history,
      ),
    ).toBe(false);
    expect(isRevertOfStyleAdaptation({ responseLength: "terse" }, { responseLength: "terse" }, history)).toBe(
      false,
    );
    expect(isRevertOfStyleAdaptation({ responseLength: "terse" }, { responseLength: "balanced" }, [])).toBe(
      false,
    );
  });
});
