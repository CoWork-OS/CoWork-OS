import { describe, expect, it } from "vitest";

import {
  createNavigationHistory,
  getNavigationAvailability,
  recordNavigationEntry,
  stepNavigationHistory,
  toNavigationEntry,
} from "../navigation-history";

const at = (view: string, taskId: string | null = null) => toNavigationEntry(view, taskId, "main");

describe("navigation history", () => {
  it("records new locations and skips repeats of the current one", () => {
    let history = createNavigationHistory<string>();
    history = recordNavigationEntry(history, at("main", "task-1"));
    history = recordNavigationEntry(history, at("main", "task-1"));
    history = recordNavigationEntry(history, at("inboxAgent"));

    expect(history.entries).toEqual([at("main", "task-1"), at("inboxAgent")]);
    expect(getNavigationAvailability(history)).toEqual({ canGoBack: true, canGoForward: false });
  });

  it("ignores the open session outside the main view", () => {
    expect(at("automations", "task-1")).toEqual({ view: "automations", taskId: null });
  });

  it("steps back and forward, and drops forward entries on a new location", () => {
    let history = createNavigationHistory<string>();
    for (const entry of [at("main", "a"), at("main", "b"), at("agents")]) {
      history = recordNavigationEntry(history, entry);
    }

    const back = stepNavigationHistory(history, -1);
    expect(back?.entry).toEqual(at("main", "b"));
    history = back!.history;
    expect(getNavigationAvailability(history)).toEqual({ canGoBack: true, canGoForward: true });

    history = recordNavigationEntry(history, at("build"));
    expect(history.entries).toEqual([at("main", "a"), at("main", "b"), at("build")]);
    expect(stepNavigationHistory(history, 1)).toBeNull();
  });

  it("keeps only the most recent entries", () => {
    let history = createNavigationHistory<string>();
    for (let index = 0; index < 5; index += 1) {
      history = recordNavigationEntry(history, at("main", `task-${index}`), 3);
    }
    expect(history.entries.map((entry) => entry.taskId)).toEqual(["task-2", "task-3", "task-4"]);
    expect(history.index).toBe(2);
  });
});
