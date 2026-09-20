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

  it("clears a submitted draft using its original owner after the active owner changes", async () => {
    const clear = vi.fn(async () => ({ cleared: true, releasedAttachments: 0 }));
    const store = new ComposerDraftStore({ transport: { clear } });
    const submittedInput = { scope: "local" as const, workspaceId: "w", taskId: "old-task" };
    const submitted = store.update(submittedInput, { text: "accepted before task switch" });
    const nextInput = { scope: "local" as const, workspaceId: "w", taskId: "new-task" };
    store.update(nextInput, { text: "new task draft" });

    expect(await store.clearAfterAcceptedDraft(submitted, submitted.revision)).toBe(true);
    expect(clear).toHaveBeenCalledWith(
      expect.objectContaining({ draftKey: submitted.draftKey, taskId: "old-task" }),
    );
    expect(store.get(submitted.draftKey)).toBeNull();
    expect(store.get("local:w:new-task:main")?.text).toBe("new task draft");
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

  it("does not let an in-flight load resurrect an accepted draft", async () => {
    let resolveLoad:
      | ((draft: ReturnType<typeof createEmptyComposerDraft> | null) => void)
      | undefined;
    const clear = vi.fn(async () => ({ cleared: true, releasedAttachments: 0 }));
    const store = new ComposerDraftStore({
      transport: {
        get: () => new Promise((resolve) => (resolveLoad = resolve)),
        clear,
      },
    });
    const input = { scope: "local" as const, workspaceId: "w", taskId: "a" };
    const submitted = store.update(input, { text: "accepted while loading" });
    const loading = store.load(input);
    const clearing = store.clearAfterAccepted(input, submitted.revision);

    await expect(clearing).resolves.toBe(true);
    const persisted = createEmptyComposerDraft(input, submitted.revision);
    persisted.text = submitted.text;
    resolveLoad?.(persisted);
    await loading;

    expect(store.get(submitted.draftKey)).toBeNull();
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

  it("waits for an in-flight upsert before clearing an accepted draft", async () => {
    const events: string[] = [];
    let resolveUpsert: (() => void) | undefined;
    const upsert = vi.fn(
      () =>
        new Promise<{ accepted: boolean; draft: ReturnType<typeof createEmptyComposerDraft> }>(
          (resolve) => {
            events.push("upsert:start");
            resolveUpsert = () => {
              events.push("upsert:end");
              resolve({ accepted: true, draft: submitted });
            };
          },
        ),
    );
    const clear = vi.fn(async () => {
      events.push("clear");
      return { cleared: true, releasedAttachments: 0 };
    });
    const store = new ComposerDraftStore({ transport: { upsert, clear }, debounceMs: 0 });
    const input = { scope: "local" as const, workspaceId: "w", taskId: "a" };
    const submitted = store.update(input, { text: "accepted while flushing" });
    const flushing = store.flush(submitted.draftKey);
    await vi.waitFor(() => expect(upsert).toHaveBeenCalledOnce());

    const clearing = store.clearAfterAccepted(input, submitted.revision);
    expect(clear).not.toHaveBeenCalled();

    resolveUpsert?.();
    await flushing;
    await expect(clearing).resolves.toBe(true);
    expect(events).toEqual(["upsert:start", "upsert:end", "clear"]);
    expect(store.get(submitted.draftKey)).toBeNull();
  });

  it("blocks a flush that starts during an accepted clear", async () => {
    let resolveClear: (() => void) | undefined;
    const clear = vi.fn(
      () =>
        new Promise<{ cleared: boolean; releasedAttachments: number }>((resolve) => {
          resolveClear = () => resolve({ cleared: true, releasedAttachments: 0 });
        }),
    );
    const upsert = vi.fn(async (draft: ReturnType<typeof createEmptyComposerDraft>) => ({
      accepted: true,
      draft,
    }));
    const store = new ComposerDraftStore({ transport: { clear, upsert } });
    const input = { scope: "local" as const, workspaceId: "w", taskId: "a" };
    const submitted = store.update(input, { text: "accepted before a late flush" });
    const clearing = store.clearAfterAccepted(input, submitted.revision);
    await vi.waitFor(() => expect(clear).toHaveBeenCalledOnce());

    const flushing = store.flush(submitted.draftKey);
    await Promise.resolve();
    expect(upsert).not.toHaveBeenCalled();

    resolveClear?.();
    await Promise.all([clearing, flushing]);
    expect(upsert).not.toHaveBeenCalled();
    expect(store.get(submitted.draftKey)).toBeNull();
  });
});
