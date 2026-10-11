import { afterEach, describe, expect, it, vi } from "vitest";
import { createVoiceSettingsAutosave } from "../VoiceSettings";
import { DEFAULT_VOICE_SETTINGS } from "../../../shared/types";

describe("VoiceSettings autosave", () => {
  afterEach(() => vi.useRealTimers());

  it("flushes the last queued credential patch when disposed", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (patch) => ({ ...DEFAULT_VOICE_SETTINGS, ...patch }));
    const autosave = createVoiceSettingsAutosave(save, vi.fn());
    autosave.queue({ openaiApiKey: "last-typed-key" });
    autosave.dispose();
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith({ openaiApiKey: "last-typed-key" }));
  });

  it("does not apply an older response after a newer edit is queued", async () => {
    let resolveFirst!: (value: typeof DEFAULT_VOICE_SETTINGS) => void;
    const save = vi.fn(
      () => new Promise<typeof DEFAULT_VOICE_SETTINGS>((resolve) => (resolveFirst = resolve)),
    );
    const onSaved = vi.fn();
    const autosave = createVoiceSettingsAutosave(save, onSaved, 10_000);
    autosave.queue({ openaiApiKey: "first" });
    const firstFlush = autosave.flush();
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith({ openaiApiKey: "first" }));
    autosave.queue({ openaiApiKey: "second" });
    resolveFirst({ ...DEFAULT_VOICE_SETTINGS, openaiApiKey: "first" });
    await firstFlush;
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("serializes a slow first save before the final unmount patch", async () => {
    let resolveFirst!: (value: typeof DEFAULT_VOICE_SETTINGS) => void;
    const persisted: string[] = [];
    const save = vi.fn(async (patch) => {
      if (patch.openaiApiKey === "first") {
        return await new Promise<typeof DEFAULT_VOICE_SETTINGS>((resolve) => {
          resolveFirst = (value) => {
            persisted.push(value.openaiApiKey ?? "");
            resolve(value);
          };
        });
      }
      persisted.push(patch.openaiApiKey ?? "");
      return { ...DEFAULT_VOICE_SETTINGS, ...patch };
    });
    const autosave = createVoiceSettingsAutosave(save, vi.fn(), 10_000);
    autosave.queue({ openaiApiKey: "first" });
    const first = autosave.flush();
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith({ openaiApiKey: "first" }));
    autosave.queue({ openaiApiKey: "second" });
    const last = autosave.flush();
    resolveFirst({ ...DEFAULT_VOICE_SETTINGS, openaiApiKey: "first" });
    await Promise.all([first, last]);
    expect(persisted).toEqual(["first", "second"]);
  });

  it("serializes immediate controls with debounced edits without stale overwrite", async () => {
    let resolveFirst!: (value: typeof DEFAULT_VOICE_SETTINGS) => void;
    const save = vi.fn((patch) => {
      if (patch.openaiApiKey === "typed") {
        return new Promise<typeof DEFAULT_VOICE_SETTINGS>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve({ ...DEFAULT_VOICE_SETTINGS, ...patch });
    });
    const onSaved = vi.fn();
    const autosave = createVoiceSettingsAutosave(save, onSaved, 10_000);

    autosave.queue({ openaiApiKey: "typed" });
    const debounced = autosave.flush();
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith({ openaiApiKey: "typed" }));
    const immediate = autosave.saveNow({ enabled: true });
    resolveFirst({ ...DEFAULT_VOICE_SETTINGS, openaiApiKey: "typed" });
    await Promise.all([debounced, immediate]);

    expect(save).toHaveBeenNthCalledWith(2, { enabled: true });
    expect(onSaved).toHaveBeenLastCalledWith({ ...DEFAULT_VOICE_SETTINGS, enabled: true });
  });

  it("retains a failed immediate patch for a later flush", async () => {
    let fail = true;
    const onError = vi.fn();
    const save = vi.fn(async (patch) => {
      if (fail) {
        fail = false;
        throw new Error("temporary failure");
      }
      return { ...DEFAULT_VOICE_SETTINGS, ...patch };
    });
    const autosave = createVoiceSettingsAutosave(save, vi.fn(), 10_000, onError);

    await autosave.saveNow({ enabled: true });
    expect(onError).toHaveBeenCalledOnce();
    await autosave.flush();
    expect(save).toHaveBeenNthCalledWith(2, { enabled: true });
  });

  it("preserves typing while an immediate control response is pending", async () => {
    let resolveImmediate!: (value: typeof DEFAULT_VOICE_SETTINGS) => void;
    let persisted = { ...DEFAULT_VOICE_SETTINGS, openaiApiKey: "stored" };
    let displayed: typeof DEFAULT_VOICE_SETTINGS = { ...persisted };
    const save = vi.fn(async (patch) => {
      persisted = { ...persisted, ...patch };
      const snapshot = { ...persisted };
      if (patch.enabled === true) {
        return await new Promise<typeof DEFAULT_VOICE_SETTINGS>((resolve) => {
          resolveImmediate = resolve;
        });
      }
      return snapshot;
    });
    const autosave = createVoiceSettingsAutosave(
      save,
      (updated) => {
        displayed = updated;
      },
      10_000,
    );
    const immediate = autosave.saveNow({ enabled: true });
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    autosave.queue({ openaiApiKey: "new typing" });
    displayed = { ...displayed, openaiApiKey: "new typing" };
    resolveImmediate({ ...persisted, openaiApiKey: "stored" });
    await immediate;
    expect(displayed.openaiApiKey).toBe("new typing");
    await autosave.flush();
    expect(displayed.openaiApiKey).toBe("new typing");
    expect(persisted.openaiApiKey).toBe("new typing");
  });
});
