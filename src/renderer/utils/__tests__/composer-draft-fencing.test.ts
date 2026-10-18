import { describe, expect, it, vi } from "vitest";
import type { ComposerDraft } from "../../../shared/composer-drafts";
import { ComposerDraftStore, type ComposerDraftTransport } from "../../state/composer-draft-store";

import {
  clearAcceptedComposerDraft,
  clearAcceptedComposerDraftFence,
  isSameAcceptedComposerDraftFence,
  isSameComposerDraftSubmission,
  isTaskCreationAccepted,
} from "../composer-draft-fencing";

function createDraftPersistence() {
  const persisted = new Map<string, ComposerDraft>();
  const transport: ComposerDraftTransport = {
    get: async ({ draftKey }) => persisted.get(draftKey) ?? null,
    upsert: async (draft) => {
      // Match the main-process repository: equal revisions are rejected.
      const previous = persisted.get(draft.draftKey);
      const accepted = !previous || draft.revision > previous.revision;
      if (accepted) persisted.set(draft.draftKey, draft);
      return { accepted, draft: persisted.get(draft.draftKey) ?? null };
    },
    clear: async ({ draftKey, revision }) => {
      const saved = persisted.get(draftKey);
      const cleared = Boolean(saved && saved.revision <= (revision ?? Infinity));
      if (cleared) persisted.delete(draftKey);
      return { cleared, releasedAttachments: 0 };
    },
  };
  return { transport, store: new ComposerDraftStore({ transport }) };
}

describe("composer draft submission fencing", () => {
  it.each([
    ["different owner", true],
    ["different owner", false],
    ["newer revision", true],
    ["newer revision", false],
  ])(
    "preserves send B's %s fence when send A settles first (B clears=%s)",
    async (change, clearsB) => {
      const submittedA = { draftKey: "local:w:a:main", taskId: "a", revision: 1, text: "Send A" };
      const submittedB =
        change === "different owner"
          ? { draftKey: "local:w:b:main", taskId: "b", revision: 1, text: "Send B" }
          : { ...submittedA, revision: 2, text: "Send B" };
      let fence: typeof submittedA | null = null;
      let visible = submittedB.text;
      let resolveA!: (value: boolean) => void;
      let resolveB!: (value: boolean) => void;
      const clearA = new Promise<boolean>((resolve) => {
        resolveA = resolve;
      });
      const clearB = new Promise<boolean>((resolve) => {
        resolveB = resolve;
      });
      const finish = async (
        submitted: typeof submittedA,
        isCurrent: boolean,
        clear: Promise<boolean>,
      ) => {
        const accepted = await clearAcceptedComposerDraft({
          isCurrentSubmission: () => isCurrent,
          clearVisible: () => {
            fence = submitted;
            visible = "";
          },
          clearPersisted: () => clear,
          restoreVisible: () => {
            if (fence === submitted) {
              visible = submitted.text;
              fence = null;
            }
          },
        });
        if (accepted) fence = clearAcceptedComposerDraftFence(fence, submitted);
      };

      const pendingA = finish(submittedA, false, clearA);
      const pendingB = finish(submittedB, true, clearB);
      expect(fence).toBe(submittedB);
      resolveA(true);
      await pendingA;

      expect(fence).toBe(submittedB);
      expect(visible).toBe("");
      resolveB(Boolean(clearsB));
      await pendingB;

      expect(fence).toBeNull();
      expect(visible).toBe(clearsB ? "" : submittedB.text);
    },
  );

  it.each([null, "previous-task"])(
    "does not restore an accepted draft after navigation and restart (submitted task=%s)",
    async (taskId) => {
      const { store, transport } = createDraftPersistence();
      const input = { scope: "local" as const, workspaceId: "w", taskId };
      const submitted = store.update(input, { text: "Create a shopping spreadsheet" });
      await store.flush(submitted.draftKey);

      // Task creation flushes the old composer and selects the task before
      // resolving. A pending follow-up can also settle after navigation.
      await store.flush(submitted.draftKey);
      const nextInput = { ...input, taskId: "new-task" };
      const next = store.update(nextInput, { text: "A new unsent follow-up" });
      const clearVisible = vi.fn();
      const restoreVisible = vi.fn();
      await expect(
        clearAcceptedComposerDraft({
          isCurrentSubmission: () => false,
          clearVisible,
          clearPersisted: () => store.clearAfterAcceptedDraft(submitted, submitted.revision),
          restoreVisible,
        }),
      ).resolves.toBe(true);
      await store.flushAll();

      const restarted = new ComposerDraftStore({ transport });
      await expect(restarted.load(input)).resolves.toBeNull();
      expect((await restarted.load(nextInput))?.text).toBe(next.text);
      expect(clearVisible).not.toHaveBeenCalled();
      expect(restoreVisible).not.toHaveBeenCalled();
    },
  );

  it("retains a newer edit to the submitted owner after the older send is accepted", async () => {
    const { store, transport } = createDraftPersistence();
    const input = { scope: "local" as const, workspaceId: "w", taskId: null };
    const submitted = store.update(input, { text: "First request" });
    const newer = store.update(input, { text: "Next request still being written" });
    const clearVisible = vi.fn();
    const restoreVisible = vi.fn();

    await expect(
      clearAcceptedComposerDraft({
        isCurrentSubmission: () => false,
        clearVisible,
        clearPersisted: () => store.clearAfterAcceptedDraft(submitted, submitted.revision),
        restoreVisible,
      }),
    ).resolves.toBe(false);
    await store.flushAll();

    expect((await new ComposerDraftStore({ transport }).load(input))?.text).toBe(newer.text);
    expect(clearVisible).not.toHaveBeenCalled();
    expect(restoreVisible).not.toHaveBeenCalled();
  });

  it.each([false, new Error("Task could not be created")])(
    "retains a draft across restart when sending is rejected (%s)",
    async (outcome) => {
      const { store, transport } = createDraftPersistence();
      const input = { scope: "local" as const, workspaceId: "w", taskId: null };
      const submitted = store.update(input, { text: "Keep this request for another attempt" });
      const clearPersisted = vi.fn(() =>
        store.clearAfterAcceptedDraft(submitted, submitted.revision),
      );
      const send = async () => {
        if (outcome instanceof Error) throw outcome;
        return outcome;
      };
      try {
        if (isTaskCreationAccepted(await send())) {
          await clearAcceptedComposerDraft({
            isCurrentSubmission: () => true,
            clearVisible: vi.fn(),
            clearPersisted,
            restoreVisible: vi.fn(),
          });
        }
      } catch {
        // The composer reports the send failure without retiring the draft.
      }
      await store.flushAll();

      expect((await new ComposerDraftStore({ transport }).load(input))?.text).toBe(submitted.text);
      expect(clearPersisted).not.toHaveBeenCalled();
    },
  );

  it("restores the visible submitted text when durable deletion fails", async () => {
    const { store, transport } = createDraftPersistence();
    transport.clear = async () => {
      throw new Error("Draft storage unavailable");
    };
    const input = { scope: "local" as const, workspaceId: "w", taskId: null };
    const submitted = store.update(input, { text: "Keep this recoverable" });
    let visible = submitted.text;

    await expect(
      clearAcceptedComposerDraft({
        isCurrentSubmission: () => true,
        clearVisible: () => {
          visible = "";
        },
        clearPersisted: () => store.clearAfterAcceptedDraft(submitted, submitted.revision),
        restoreVisible: () => {
          visible = submitted.text;
        },
      }),
    ).resolves.toBe(false);

    expect(visible).toBe(submitted.text);
    expect(store.get(submitted.draftKey)?.text).toBe(submitted.text);
    await store.flushAll();
  });

  it("treats only explicit task-creation false as rejection", () => {
    expect(isTaskCreationAccepted(undefined)).toBe(true);
    expect(isTaskCreationAccepted(true)).toBe(true);
    expect(isTaskCreationAccepted(false)).toBe(false);
  });

  it("rejects a clear when the key, revision, or text changed", () => {
    const base = {
      submittedDraftKey: "local:workspace:task:main",
      currentDraftKey: "local:workspace:task:main",
      submittedRevision: 4,
      currentRevision: 4,
      submittedText: "keep this",
      currentText: "keep this",
    };
    expect(isSameComposerDraftSubmission(base)).toBe(true);
    expect(isSameComposerDraftSubmission({ ...base, currentRevision: 5 })).toBe(false);
    expect(isSameComposerDraftSubmission({ ...base, currentText: "keep this plus more" })).toBe(
      false,
    );
    expect(
      isSameComposerDraftSubmission({ ...base, currentDraftKey: "local:workspace:other:main" }),
    ).toBe(false);
  });

  it("keeps an optimistic clear scoped to the same task and draft revision", () => {
    const base = {
      fenceDraftKey: "local:workspace:task:main",
      currentDraftKey: "local:workspace:task:main",
      fenceTaskId: "task",
      currentTaskId: "task",
      fenceRevision: 9,
      currentRevision: 9,
    };
    expect(isSameAcceptedComposerDraftFence(base)).toBe(true);
    expect(isSameAcceptedComposerDraftFence({ ...base, currentTaskId: "other-task" })).toBe(false);
    expect(isSameAcceptedComposerDraftFence({ ...base, currentRevision: 10 })).toBe(false);
  });
});
