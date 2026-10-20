import { describe, expect, it, vi } from "vitest";

import { createEmptyComposerDraft } from "../../../shared/composer-drafts";
import { ComposerDraftStore } from "../composer-draft-store";

describe("ComposerDraftStore", () => {
  it("keeps a submitted revision stable across repeated navigation and unmount flushes", async () => {
    let persisted: ReturnType<typeof createEmptyComposerDraft> | null = null;
    const upsert = vi.fn(async (draft: ReturnType<typeof createEmptyComposerDraft>) => {
      const accepted = !persisted || draft.revision > persisted.revision;
      if (accepted) persisted = draft;
      return { accepted, draft: persisted };
    });
    const store = new ComposerDraftStore({ transport: { upsert } });
    const input = { scope: "local" as const, workspaceId: "w", taskId: null };
    const submitted = store.update(input, { text: "Create a shopping spreadsheet" });

    await store.flush(submitted.draftKey);
    await store.flush(submitted.draftKey);
    await store.flushAll();

    expect(upsert).toHaveBeenCalledOnce();
    expect(store.get(submitted.draftKey)?.revision).toBe(submitted.revision);
  });

  it("acknowledges the latest revision when an edit arrives before a queued flush dispatches", async () => {
    let persisted: ReturnType<typeof createEmptyComposerDraft> | null = null;
    const upsert = vi.fn(async (draft: ReturnType<typeof createEmptyComposerDraft>) => {
      const accepted = !persisted || draft.revision > persisted.revision;
      if (accepted) persisted = draft;
      return { accepted, draft: persisted };
    });
    const store = new ComposerDraftStore({ transport: { upsert } });
    const input = { scope: "local" as const, workspaceId: "w", taskId: null };
    const first = store.update(input, { text: "First version" });
    const flushing = store.flush(first.draftKey);
    const latest = store.update(input, { text: "Complete request" });
    const secondFlush = store.flush(latest.draftKey);

    await Promise.all([flushing, secondFlush]);
    await store.flushAll();

    expect(upsert).toHaveBeenCalledOnce();
    expect(upsert).toHaveBeenCalledWith(latest);
    expect(store.get(latest.draftKey)?.revision).toBe(latest.revision);
  });

  it("still persists attachment-only edits and an explicitly emptied draft", async () => {
    const upsert = vi.fn(async (draft: ReturnType<typeof createEmptyComposerDraft>) => ({
      accepted: true,
      draft,
    }));
    const store = new ComposerDraftStore({ transport: { upsert } });
    const input = { scope: "local" as const, workspaceId: "w", taskId: null };
    const first = store.update(input, { text: "Describe the attachment" });
    await store.flush(first.draftKey);
    const attachment = {
      refId: "12345678-1234-1234-1234-123456789012",
      name: "notes.txt",
      size: 1,
      sha256: "a".repeat(64),
    };
    const staged = store.update(input, { attachments: [attachment] });
    await store.flush(staged.draftKey);
    expect(upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ attachments: [attachment], revision: staged.revision }),
    );

    const emptied = store.update(input, { text: "", attachments: [] });
    await store.flush(emptied.draftKey);
    expect(upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "", attachments: [], revision: emptied.revision }),
    );
    expect(upsert).toHaveBeenCalledTimes(3);
  });

  it("persists a draft explicitly installed with persistence enabled", async () => {
    const upsert = vi.fn(async (draft: ReturnType<typeof createEmptyComposerDraft>) => ({
      accepted: true,
      draft,
    }));
    const store = new ComposerDraftStore({ transport: { upsert } });
    const draft = createEmptyComposerDraft({ scope: "local", workspaceId: "w", taskId: null });
    draft.text = "Recovered draft";
    store.setDraft(draft, true);

    await store.flush(draft.draftKey);

    expect(upsert).toHaveBeenCalledWith(draft);
  });

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

  it("carries an unsent new-session draft to another folder and clears the source", async () => {
    const clear = vi.fn(async () => ({ cleared: true, releasedAttachments: 1 }));
    const putAttachment = vi.fn(async () => ({
      refId: "copied-ref",
      name: "image.png",
      mimeType: "image/png",
      size: 9,
      sha256: "abc",
      status: "available" as const,
    }));
    const store = new ComposerDraftStore({ transport: { clear, putAttachment }, now: () => 100 });
    const from = { scope: "local" as const, workspaceId: "scratch", taskId: null };
    const to = { scope: "local" as const, workspaceId: "project", taskId: null };
    const source = store.update(from, {
      text: "fix this",
      attachments: [
        {
          refId: "source-ref",
          name: "image.png",
          mimeType: "image/png",
          size: 9,
          sha256: "abc",
          status: "available",
        },
      ],
    });

    await expect(store.carry(from, to)).resolves.toBe(true);

    expect(putAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        draftKey: "local:project:new:main",
        workspaceId: "project",
        copyFrom: expect.objectContaining({
          draftKey: source.draftKey,
          workspaceId: "scratch",
          refId: "source-ref",
        }),
      }),
    );
    expect(store.get("local:project:new:main")).toMatchObject({
      text: "fix this",
      attachments: [expect.objectContaining({ refId: "copied-ref" })],
    });
    expect(clear).toHaveBeenCalledWith(expect.objectContaining({ draftKey: source.draftKey }));
    expect(store.get(source.draftKey)).toBeNull();
  });

  it("leaves the destination draft alone when the source is empty", async () => {
    const store = new ComposerDraftStore({ now: () => 100 });
    const from = { scope: "local" as const, workspaceId: "scratch", taskId: null };
    const to = { scope: "local" as const, workspaceId: "project", taskId: null };
    store.update(from, { text: "  " });
    store.update(to, { text: "keep" });

    await expect(store.carry(from, to)).resolves.toBe(false);
    expect(store.get("local:project:new:main")?.text).toBe("keep");
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

  it("preserves typing when a second restoration begins after the edit", async () => {
    const resolvers: Array<(draft: ReturnType<typeof createEmptyComposerDraft>) => void> = [];
    const store = new ComposerDraftStore({
      transport: { get: () => new Promise((resolve) => resolvers.push(resolve)) },
    });
    const input = { scope: "local" as const, workspaceId: "w", taskId: "a" };
    const first = store.load(input);
    const typed = store.update(input, { text: "typing before switching away and back" });
    const second = store.load(input);
    const stored = { ...createEmptyComposerDraft(input, 10), revision: 10, text: "old saved text" };
    resolvers[0](stored);
    await first;
    resolvers[1](stored);
    await second;
    expect(store.get(typed.draftKey)?.text).toBe(typed.text);
    expect(store.get(typed.draftKey)?.revision).toBe(11);
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

  it("clears an accepted draft after an automatic patch moved its revision", async () => {
    const clear = vi.fn(async () => ({ cleared: true, releasedAttachments: 1 }));
    const store = new ComposerDraftStore({ transport: { clear } });
    const input = { scope: "local" as const, workspaceId: "w", taskId: null };
    const image = {
      refId: "image-ref",
      name: "image.png",
      size: 9,
      sha256: "abc",
      status: "available" as const,
    };
    const submitted = store.update(input, { text: "sent with an image", attachments: [image] });
    // e.g. the restore path marking the attachment unavailable after the send.
    const patched = store.update(input, { attachments: [{ ...image, status: "unavailable" }] });

    expect(await store.clearAfterAcceptedDraft(submitted, submitted.revision)).toBe(true);
    expect(clear).toHaveBeenCalledWith(expect.objectContaining({ revision: patched.revision }));
    expect(store.get(submitted.draftKey)).toBeNull();
  });

  it("does not resurrect an accepted draft patched during its durable clear", async () => {
    let resolveClear: (() => void) | undefined;
    const clear = vi.fn(
      () =>
        new Promise<{ cleared: boolean; releasedAttachments: number }>((resolve) => {
          resolveClear = () => resolve({ cleared: true, releasedAttachments: 0 });
        }),
    );
    const store = new ComposerDraftStore({ transport: { clear } });
    const input = { scope: "local" as const, workspaceId: "w", taskId: null };
    const submitted = store.update(input, { text: "accepted" });
    const clearing = store.clearAfterAcceptedDraft(submitted, submitted.revision);
    await vi.waitFor(() => expect(clear).toHaveBeenCalledOnce());

    store.update(input, { mentions: [] });
    resolveClear?.();

    await expect(clearing).resolves.toBe(true);
    expect(store.get(submitted.draftKey)).toBeNull();
  });

  it("keeps only new typing, without the sent attachments, after an accepted send", async () => {
    let resolveClear: (() => void) | undefined;
    const clear = vi.fn(
      () =>
        new Promise<{ cleared: boolean; releasedAttachments: number }>((resolve) => {
          resolveClear = () => resolve({ cleared: true, releasedAttachments: 1 });
        }),
    );
    const store = new ComposerDraftStore({ transport: { clear } });
    const input = { scope: "local" as const, workspaceId: "w", taskId: null };
    const submitted = store.update(input, {
      text: "first",
      attachments: [
        { refId: "sent-ref", name: "a.png", size: 1, sha256: "x", status: "available" },
      ],
    });
    const clearing = store.clearAfterAcceptedDraft(submitted, submitted.revision);
    await vi.waitFor(() => expect(clear).toHaveBeenCalledOnce());

    store.update(input, { text: "second" });
    resolveClear?.();

    await expect(clearing).resolves.toBe(false);
    expect(store.get(submitted.draftKey)).toMatchObject({ text: "second", attachments: [] });
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

  it("reconciles a persisted revision without replacing local typing", async () => {
    let resolveLoad: ((draft: ReturnType<typeof createEmptyComposerDraft>) => void) | undefined;
    let saved = createEmptyComposerDraft({ scope: "local", workspaceId: "w", taskId: "a" }, 41);
    saved.revision = 41;
    saved.text = "old text";
    const upsert = vi.fn(async (draft: ReturnType<typeof createEmptyComposerDraft>) => {
      // Match ComposerDraftRepository.upsertIfNewer's strict revision check.
      const accepted = draft.revision > saved.revision;
      if (accepted) saved = draft;
      return { accepted, draft: saved };
    });
    const store = new ComposerDraftStore({
      transport: { get: () => new Promise((resolve) => (resolveLoad = resolve)), upsert },
    });
    const input = { scope: "local" as const, workspaceId: "w", taskId: "a" };
    const loading = store.load(input);
    const current = store.update(input, { text: "typed after restore started" });
    const persisted = createEmptyComposerDraft(input, 41);
    persisted.revision = 41;
    persisted.text = "old text";
    resolveLoad?.(persisted);
    const reconciled = await loading;

    expect(reconciled?.text).toBe(current.text);
    expect(reconciled?.revision).toBe(42);
    await store.flush(reconciled!.draftKey);
    expect(upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: current.text, revision: 42 }),
    );
    const restored = new ComposerDraftStore({ transport: { get: async () => saved } });
    expect((await restored.load(input))?.text).toBe(current.text);
  });

  it("rebases a dirty draft after an overlapping low-revision write is rejected", async () => {
    let persisted = createEmptyComposerDraft({ scope: "local", workspaceId: "w", taskId: "a" }, 10);
    persisted.revision = 10;
    persisted.text = "server text";
    const upsert = vi.fn(async (draft: ReturnType<typeof createEmptyComposerDraft>) => {
      if (draft.revision <= persisted.revision) return { accepted: false, draft: persisted };
      persisted = draft;
      return { accepted: true, draft };
    });
    const store = new ComposerDraftStore({ transport: { upsert }, debounceMs: 0 });
    const input = { scope: "local" as const, workspaceId: "w", taskId: "a" };

    const local = store.update(input, { text: "keep my newer typing" });
    await store.flush(local.draftKey);

    await vi.waitFor(() => expect(upsert).toHaveBeenCalledTimes(2));
    expect(upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: local.text, revision: 11 }),
    );
    expect(store.get(local.draftKey)?.text).toBe(local.text);
  });

  it("does not retry forever when a rejection carries no authoritative draft", async () => {
    const upsert = vi.fn(async () => ({ accepted: false, draft: null }));
    const store = new ComposerDraftStore({ transport: { upsert } as Any, debounceMs: 0 });
    const input = { scope: "local" as const, workspaceId: "w", taskId: "a" };
    const local = store.update(input, { text: "unsaved" });
    await store.flush(local.draftKey);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(store.get(local.draftKey)?.revision).toBe(local.revision);
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
