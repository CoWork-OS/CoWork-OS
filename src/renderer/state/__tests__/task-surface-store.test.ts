import { describe, expect, it } from "vitest";

import type { TaskEvent } from "../../../shared/types";
import { buildComposerDraftKey, createEmptyComposerDraft } from "../../../shared/composer-drafts";
import { TaskSurfaceStore } from "../task-surface-store";
import { TaskViewCache, type TaskSurfaceKey } from "../task-view-cache";

const key = (taskId: string): TaskSurfaceKey => ({
  scope: "local",
  workspaceId: "workspace-1",
  taskId,
  surface: "main",
});

const event = (id: string, taskId: string, timestamp: number, seq?: number): TaskEvent => ({
  id,
  eventId: id,
  taskId,
  timestamp,
  ...(seq === undefined ? {} : { seq }),
  type: "progress_update" as TaskEvent["type"],
  payload: { id },
  schemaVersion: 2,
});

describe("TaskSurfaceStore", () => {
  it("increments generations and rejects late writes for the old surface", () => {
    const store = new TaskSurfaceStore();
    const a = store.switchTo(key("a"));
    const b = store.switchTo(key("b"));

    expect(store.isCurrent(a.key, a.generation)).toBe(false);
    expect(store.isCurrent(b.key, b.generation)).toBe(true);
    expect(
      store.setTimeline(
        a.key,
        {
          events: [event("a-1", "a", 1)],
          cursor: null,
          hasMoreHistory: false,
        },
        a.generation,
      ),
    ).toBeNull();
    expect(store.getSnapshot(key("a"))?.timeline.events).toEqual([]);
  });

  it("restores a cached task timeline and draft after returning to A", () => {
    const store = new TaskSurfaceStore();
    const a = store.switchTo(key("a"));
    store.setTimeline(
      a.key,
      {
        events: [event("a-1", "a", 2, 2)],
        cursor: null,
        hasMoreHistory: false,
      },
      a.generation,
    );
    store.setDraft(
      a.key,
      createEmptyComposerDraft({ scope: "local", workspaceId: "workspace-1", taskId: "a" }),
    );
    store.switchTo(key("b"));
    const returned = store.switchTo(key("a"));

    expect(returned.snapshot.timeline.events.map((item) => item.id)).toEqual(["a-1"]);
    expect(returned.snapshot.composerDraft?.draftKey).toBe("local:workspace-1:a:main");
  });

  it("orders by sequence and replaces duplicate identities", () => {
    const store = new TaskSurfaceStore();
    const selected = store.switchTo(key("a"));
    store.setTimeline(
      selected.key,
      {
        events: [event("same", "a", 20, 2), event("late", "a", 30, 3)],
        cursor: null,
        hasMoreHistory: false,
      },
      selected.generation,
    );
    store.setTimeline(
      selected.key,
      {
        events: [event("same", "a", 10, 2), event("early", "a", 5, 1)],
        cursor: null,
        hasMoreHistory: false,
      },
      selected.generation,
    );

    expect(store.getSnapshot(key("a"))?.timeline.events.map((item) => item.id)).toEqual([
      "early",
      "same",
      "late",
    ]);
  });
});

describe("TaskViewCache", () => {
  it("evicts least recently used surfaces by task count", () => {
    const cache = new TaskViewCache({ maxTasks: 2, maxBytes: 1024 * 1024 });
    cache.set(key("a"), { ...new TaskSurfaceStore().switchTo(key("a")).snapshot });
    cache.set(key("b"), { ...new TaskSurfaceStore().switchTo(key("b")).snapshot });
    cache.get(key("a"));
    cache.set(key("c"), { ...new TaskSurfaceStore().switchTo(key("c")).snapshot });

    expect(cache.has(key("a"))).toBe(true);
    expect(cache.has(key("b"))).toBe(false);
    expect(cache.has(key("c"))).toBe(true);
  });
});

describe("composer draft keys", () => {
  it("isolates local, side-chat, and remote drafts", () => {
    expect(buildComposerDraftKey({ scope: "local", workspaceId: "w", taskId: "t" })).toBe(
      "local:w:t:main",
    );
    expect(
      buildComposerDraftKey({
        scope: "local",
        workspaceId: "w",
        taskId: "t",
        surface: "side-chat",
      }),
    ).toBe("local:w:t:side-chat");
    expect(
      buildComposerDraftKey({
        scope: "remote",
        workspaceId: "w",
        taskId: "t",
        remoteDeviceId: "d",
      }),
    ).toBe("remote:w:d:t:main");
  });
});
