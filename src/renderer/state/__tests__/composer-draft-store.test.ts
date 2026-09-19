import { describe, expect, it, vi } from "vitest";

import { createEmptyComposerDraft } from "../../../shared/composer-drafts";
import { ComposerDraftStore } from "../composer-draft-store";

describe("ComposerDraftStore", () => {
  it("restores task-scoped text and flushes the newest revision", async () => {
    const persisted = new Map<string, ReturnType<typeof createEmptyComposerDraft>>();
    const upsert = vi.fn(async (draft: ReturnType<typeof createEmptyComposerDraft>) => {
      persisted.set(draft.draftKey, draft);
      return { accepted: true, draft };
    });
    const store = new ComposerDraftStore({ transport: { upsert }, debounceMs: 1, now: () => 100 });
    const input = { scope: "local" as const, workspaceId: "w", taskId: "a" };

    const next = store.update(input, { text: "keep me" });
    await store.flush(next.draftKey);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ text: "keep me", revision: 1 }));

    const restored = new ComposerDraftStore({
      transport: { get: async () => persisted.get(next.draftKey) ?? null },
    });
    await restored.load(input);
    expect(restored.get(next.draftKey)?.text).toBe("keep me");
  });

  it("ignores a stale load after a newer load for the same key", async () => {
    const resolvers: Array<(draft: ReturnType<typeof createEmptyComposerDraft>) => void> = [];
    const store = new ComposerDraftStore({
      transport: {
        get: () =>
          new Promise((resolve) => {
            resolvers.push(resolve);
          }),
      },
    });
    const input = { scope: "local" as const, workspaceId: "w", taskId: "a" };
    const first = store.load(input);
    const second = store.load(input);
    const firstDraft = createEmptyComposerDraft(input, 1);
    firstDraft.text = "old";
    const secondDraft = createEmptyComposerDraft(input, 2);
    secondDraft.text = "new";
    resolvers[0]?.(firstDraft);
    resolvers[1]?.(secondDraft);
    await Promise.all([first, second]);

    expect(store.get(secondDraft.draftKey)?.text).toBe("new");
  });

  it("treats a failed persisted load as a cache miss", async () => {
    const store = new ComposerDraftStore({
      transport: { get: async () => Promise.reject(new Error("draft owner changed")) },
    });
    const input = { scope: "local" as const, workspaceId: "w", taskId: "a" };

    await expect(store.load(input)).resolves.toBeNull();
    expect(store.get("local:w:a:main")).toBeNull();
  });

  it("does not clear newer text when an older send is accepted", async () => {
    const clear = vi.fn(async () => ({ cleared: true, releasedAttachments: 0 }));
    const store = new ComposerDraftStore({ transport: { clear } });
    const input = { scope: "local" as const, workspaceId: "w", taskId: "a" };
    const submitted = store.update(input, { text: "first" });
    store.update(input, { text: "second" });

    expect(await store.clearAfterAccepted(input, submitted.revision)).toBe(false);
    expect(clear).not.toHaveBeenCalled();
    expect(store.get(submitted.draftKey)?.text).toBe("second");
  });

  it("does not let a late persisted load overwrite local typing", async () => {
    let resolveLoad: ((draft: ReturnType<typeof createEmptyComposerDraft>) => void) | undefined;
    const store = new ComposerDraftStore({
      transport: {
        get: () => new Promise((resolve) => (resolveLoad = resolve)),
      },
    });
    const input = { scope: "local" as const, workspaceId: "w", taskId: "a" };
    const loading = store.load(input);
    const current = store.update(input, { text: "typed locally" });
    const persisted = createEmptyComposerDraft(input, 1);
    persisted.text = "old persisted text";
    resolveLoad?.(persisted);
    await loading;

    expect(store.get(current.draftKey)?.text).toBe("typed locally");
  });

  it("clears exactly the accepted revision", async () => {
    const clear = vi.fn(async () => ({ cleared: true, releasedAttachments: 0 }));
    const store = new ComposerDraftStore({ transport: { clear } });
    const input = { scope: "local" as const, workspaceId: "w", taskId: "a" };
    const submitted = store.update(input, { text: "first" });

    expect(await store.clearAfterAccepted(input, submitted.revision)).toBe(true);
    expect(store.get(submitted.draftKey)).toBeNull();
    expect(clear).toHaveBeenCalledWith(expect.objectContaining({ revision: submitted.revision }));
  });

  it("clears an accepted revision when it was never persisted", async () => {
    const clear = vi.fn(async () => ({ cleared: false, releasedAttachments: 0 }));
    const store = new ComposerDraftStore({ transport: { clear } });
    const input = { scope: "local" as const, workspaceId: "w", taskId: "a" };
    const submitted = store.update(input, { text: "not flushed yet" });

    expect(await store.clearAfterAccepted(input, submitted.revision)).toBe(true);
    expect(store.get(submitted.draftKey)).toBeNull();
  });

  it("keeps the accepted draft until its durable clear finishes", async () => {
    let resolveClear:
      | ((result: { cleared: boolean; releasedAttachments: number }) => void)
      | undefined;
    const clear = vi.fn(
      () =>
        new Promise<{ cleared: boolean; releasedAttachments: number }>((resolve) => {
          resolveClear = resolve;
        }),
    );
    const store = new ComposerDraftStore({ transport: { clear } });
    const input = { scope: "local" as const, workspaceId: "w", taskId: "a" };
    const submitted = store.update(input, { text: "accepted follow-up" });

    const clearing = store.clearAfterAccepted(input, submitted.revision);
    expect(store.get(submitted.draftKey)?.text).toBe("accepted follow-up");

    resolveClear?.({ cleared: true, releasedAttachments: 0 });
    await expect(clearing).resolves.toBe(true);
    expect(store.get(submitted.draftKey)).toBeNull();
  });
});
