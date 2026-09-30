import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildComposerDraftKey,
  createEmptyComposerDraft,
  type ComposerDraft,
  type ComposerDraftGetRequest,
} from "../../shared/composer-drafts";
import {
  type BrowserComposerDraftLockManager,
  createBrowserComposerDraftBridge,
  type BrowserComposerDraftStorage,
} from "./browser-composer-draft-bridge";

const baseOwner: ComposerDraftGetRequest = {
  draftKey: buildComposerDraftKey({ scope: "local", workspaceId: "workspace-1", taskId: null }),
  scope: "local",
  workspaceId: "workspace-1",
  surface: "main",
  taskId: null,
};

function createMemoryStorage(): BrowserComposerDraftStorage & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: (key) => entries.delete(key),
  };
}

function createMemoryLockManager(): BrowserComposerDraftLockManager {
  const tails = new Map<string, Promise<void>>();
  return {
    request: async <T>(name: string, callback: () => T | Promise<T>): Promise<T> => {
      const previous = tails.get(name) ?? Promise.resolve();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.catch(() => undefined).then(() => gate);
      tails.set(name, tail);
      await previous.catch(() => undefined);
      try {
        return await callback();
      } finally {
        release();
      }
    },
  };
}

const lockManager = createMemoryLockManager();

function createDraft(patch: Partial<ComposerDraft> = {}): ComposerDraft {
  return {
    ...createEmptyComposerDraft({ scope: "local", workspaceId: "workspace-1", taskId: null }, 10),
    ...patch,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("browser composer draft bridge", () => {
  it("persists only normalized composer data under the installation and profile scope", async () => {
    const storage = createMemoryStorage();
    const first = createBrowserComposerDraftBridge({
      installationId: "installation-a",
      profileId: "profile-a",
      storage,
      lockManager,
      now: () => 20,
    });
    const sensitiveExtra = {
      ...createDraft({ text: "Keep this composer text" }),
      answers: [{ questionId: "q1", answer: "private form answer" }],
      secrets: { token: "never persist this" },
    } as ComposerDraft;

    await expect(first.methods.upsertComposerDraft(sensitiveExtra)).resolves.toMatchObject({
      accepted: true,
      draft: { text: "Keep this composer text", revision: 0 },
    });
    const raw = [...storage.entries.values()][0];
    expect(raw).toContain("Keep this composer text");
    expect(raw).not.toContain("private form answer");
    expect(raw).not.toContain("never persist this");

    const restored = createBrowserComposerDraftBridge({
      installationId: "installation-a",
      profileId: "profile-a",
      storage,
      lockManager,
      now: () => 20,
    });
    await expect(restored.methods.getComposerDraft(baseOwner)).resolves.toMatchObject({
      text: "Keep this composer text",
    });

    const otherProfile = createBrowserComposerDraftBridge({
      installationId: "installation-a",
      profileId: "profile-b",
      storage,
      now: () => 20,
    });
    await expect(otherProfile.methods.getComposerDraft(baseOwner)).resolves.toBeNull();
  });

  it("uses strictly newer revisions for upsert and fences accepted clears", async () => {
    const storage = createMemoryStorage();
    const releaseAttachments = vi.fn(() => ({ releasedAttachmentCount: 1 }));
    const bridge = createBrowserComposerDraftBridge({
      installationId: "installation-a",
      profileId: "profile-a",
      storage,
      lockManager,
      now: () => 20,
      releaseAttachments,
    });
    const attachment = {
      refId: "12345678-1234-1234-1234-123456789abc",
      name: "plan.txt",
      size: 4,
      sha256: "a".repeat(64),
      status: "available" as const,
    };
    const revisionTwo = createDraft({ text: "newer text", revision: 2, attachments: [attachment] });

    await expect(bridge.methods.upsertComposerDraft(revisionTwo)).resolves.toMatchObject({
      accepted: true,
    });
    await expect(
      bridge.methods.upsertComposerDraft(createDraft({ text: "stale text", revision: 2 })),
    ).resolves.toMatchObject({ accepted: false, draft: { text: "newer text", revision: 2 } });
    await expect(bridge.methods.clearComposerDraft({ ...baseOwner, revision: 1 })).resolves.toEqual(
      {
        cleared: false,
        releasedAttachments: 0,
      },
    );
    expect(releaseAttachments).not.toHaveBeenCalled();

    await expect(bridge.methods.clearComposerDraft({ ...baseOwner, revision: 2 })).resolves.toEqual(
      {
        cleared: true,
        releasedAttachments: 1,
      },
    );
    expect(releaseAttachments).toHaveBeenCalledWith(baseOwner, [attachment]);
    await expect(bridge.methods.getComposerDraft(baseOwner)).resolves.toBeNull();
  });

  it("validates owner keys and rejects oversized or malformed draft payloads", async () => {
    const storage = createMemoryStorage();
    const bridge = createBrowserComposerDraftBridge({
      installationId: "installation-a",
      profileId: "profile-a",
      storage,
    });
    await expect(
      bridge.methods.getComposerDraft({ ...baseOwner, draftKey: "another-workspace:task" }),
    ).rejects.toThrow("does not match its owner");
    await expect(
      bridge.methods.upsertComposerDraft(createDraft({ text: "x".repeat(100_001) })),
    ).rejects.toThrow("Invalid composer draft");
    expect(storage.entries.size).toBe(0);

    const storageKey = "cowork:browser-composer-drafts:installation-a:profile-a";
    storage.setItem(storageKey, "{broken");
    await expect(bridge.methods.getComposerDraft(baseOwner)).rejects.toThrow("left untouched");
    expect(storage.getItem(storageKey)).toBe("{broken");
  });

  it("rekeys only within the same owner scope and never overwrites the destination", async () => {
    const storage = createMemoryStorage();
    const rollback = vi.fn();
    const rekeyAttachments = vi.fn(() => ({ rekeyedAttachmentCount: 2, rollback }));
    const bridge = createBrowserComposerDraftBridge({
      installationId: "installation-a",
      profileId: "profile-a",
      storage,
      lockManager,
      now: () => 20,
      rekeyAttachments,
    });
    const nextTaskId = "task-created";
    const nextOwner: ComposerDraftGetRequest = {
      ...baseOwner,
      draftKey: buildComposerDraftKey({
        scope: "local",
        workspaceId: baseOwner.workspaceId,
        taskId: nextTaskId,
      }),
      taskId: nextTaskId,
    };
    const source = createDraft({ text: "preserve me", revision: 3 });
    await bridge.methods.upsertComposerDraft(source);

    await expect(
      bridge.methods.rekeyComposerDraft({
        ...baseOwner,
        nextDraftKey: nextOwner.draftKey,
        nextTaskId,
      }),
    ).resolves.toEqual({ rekeyed: true, rekeyedAttachmentCount: 2 });
    expect(rekeyAttachments).toHaveBeenCalledWith(baseOwner, nextOwner);
    await expect(bridge.methods.getComposerDraft(baseOwner)).resolves.toBeNull();
    await expect(bridge.methods.getComposerDraft(nextOwner)).resolves.toMatchObject({
      text: "preserve me",
      revision: 3,
      taskId: nextTaskId,
      draftKey: nextOwner.draftKey,
    });

    const occupiedTaskId = "already-present";
    const occupiedOwner: ComposerDraftGetRequest = {
      ...baseOwner,
      draftKey: buildComposerDraftKey({
        scope: "local",
        workspaceId: baseOwner.workspaceId,
        taskId: occupiedTaskId,
      }),
      taskId: occupiedTaskId,
    };
    await bridge.methods.upsertComposerDraft(
      createDraft({
        ...occupiedOwner,
        taskId: occupiedTaskId,
        draftKey: occupiedOwner.draftKey,
        revision: 0,
      }),
    );
    await expect(
      bridge.methods.rekeyComposerDraft({
        ...nextOwner,
        nextDraftKey: occupiedOwner.draftKey,
        nextTaskId: occupiedTaskId,
      }),
    ).resolves.toEqual({ rekeyed: false, rekeyedAttachmentCount: 0 });
    expect(rekeyAttachments).toHaveBeenCalledTimes(1);
  });

  it("rolls staged attachment ownership back if local draft persistence fails", async () => {
    const storage = createMemoryStorage();
    const rollback = vi.fn();
    const rekeyAttachments = vi.fn(() => ({ rekeyedAttachmentCount: 1, rollback }));
    const bridge = createBrowserComposerDraftBridge({
      installationId: "installation-a",
      profileId: "profile-a",
      storage,
      lockManager,
      now: () => 20,
      rekeyAttachments,
    });
    await bridge.methods.upsertComposerDraft(createDraft({ revision: 0 }));
    const setItem = vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const nextTaskId = "task-created";
    const nextDraftKey = buildComposerDraftKey({
      scope: "local",
      workspaceId: baseOwner.workspaceId,
      taskId: nextTaskId,
    });

    await expect(
      bridge.methods.rekeyComposerDraft({ ...baseOwner, nextDraftKey, nextTaskId }),
    ).rejects.toThrow("could not save");
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(rekeyAttachments).toHaveBeenCalledTimes(1);
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it("serializes equal-revision writes across bridge instances using the profile lock", async () => {
    const storage = createMemoryStorage();
    const options = {
      installationId: "installation-shared",
      profileId: "profile-shared",
      storage,
      lockManager,
      now: () => 20,
    };
    const first = createBrowserComposerDraftBridge(options);
    const second = createBrowserComposerDraftBridge(options);

    const results = await Promise.all([
      first.methods.upsertComposerDraft(createDraft({ text: "first edit", revision: 1 })),
      second.methods.upsertComposerDraft(createDraft({ text: "second edit", revision: 1 })),
    ]);

    expect(results.map((result) => result.accepted)).toEqual([true, false]);
    await expect(first.methods.getComposerDraft(baseOwner)).resolves.toMatchObject({
      text: "first edit",
      revision: 1,
    });
  });

  it("rejects draft writes when browser cross-tab locks are unavailable", async () => {
    vi.stubGlobal("navigator", {});
    const storage = createMemoryStorage();
    const bridge = createBrowserComposerDraftBridge({
      installationId: "installation-a",
      profileId: "profile-a",
      storage,
    });

    await expect(bridge.methods.upsertComposerDraft(createDraft({ revision: 1 }))).rejects.toThrow(
      "does not support safe cross-tab",
    );
    expect(storage.entries.size).toBe(0);
  });
});
