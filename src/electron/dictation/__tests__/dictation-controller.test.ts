import { describe, expect, it, vi } from "vitest";
import {
  DICTATION_MESSAGES,
  DictationController,
  MAX_DICTATION_BYTES,
  MAX_DICTATION_MS,
  tidyTranscript,
  type DictationDeps,
  type DictationView,
} from "../dictation-controller";

const SPEECH = new Uint8Array(4_000);

function setup(overrides: Partial<DictationDeps> = {}) {
  const views: DictationView[] = [];
  const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  const cancelKey: boolean[] = [];
  const overlay = {
    show: vi.fn(async (view: DictationView) => {
      views.push(view);
    }),
    start: vi.fn(async () => ({ ok: true })),
    stop: vi.fn(async (): Promise<Uint8Array | null> => SPEECH),
    cancel: vi.fn(async () => {}),
    hide: vi.fn(),
  };
  const deps: DictationDeps = {
    overlay,
    microphoneAccess: vi.fn(async () => "granted" as const),
    transcriptionReady: () => true,
    transcribe: vi.fn(async () => "  Hello there.  "),
    deliver: vi.fn(async () => "pasted" as const),
    frontmostApp: vi.fn(async () => "com.apple.TextEdit:42"),
    setCancelKey: (active) => cancelKey.push(active),
    schedule: (callback, ms) => {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return () => {
        timer.cleared = true;
      };
    },
    ...overrides,
  };
  const controller = new DictationController(deps);
  const fire = (ms: number) => {
    for (const timer of timers.filter((t) => t.ms === ms && !t.cleared)) timer.callback();
  };
  return { controller, deps, overlay, views, timers, cancelKey, fire };
}

describe("DictationController", () => {
  it("listens on the first press and pastes the trimmed text on the second", async () => {
    const { controller, deps, overlay, views, cancelKey, fire } = setup();
    await controller.toggle();
    expect(controller.currentPhase).toBe("recording");
    expect(views.at(-1)).toEqual({ state: "listening", message: DICTATION_MESSAGES.listening });
    expect(cancelKey.at(-1)).toBe(true);

    await controller.toggle();
    expect(deps.transcribe).toHaveBeenCalledWith(Buffer.from(SPEECH));
    expect(deps.deliver).toHaveBeenCalledWith("Hello there.", { paste: true });
    expect(views.map((view) => view.state)).toEqual(["listening", "working", "done"]);
    expect(cancelKey.at(-1)).toBe(false);

    fire(900);
    expect(overlay.hide).toHaveBeenCalled();
    expect(controller.currentPhase).toBe("idle");
  });

  it("says when the text was copied instead of pasted", async () => {
    const { controller, views } = setup({ deliver: vi.fn(async () => "copied" as const) });
    await controller.toggle();
    await controller.toggle();
    expect(views.at(-1)).toEqual({ state: "done", message: DICTATION_MESSAGES.copied });
  });

  it("asks for a provider before touching the microphone", async () => {
    const { controller, deps, overlay, views } = setup({ transcriptionReady: () => false });
    await controller.toggle();
    expect(deps.microphoneAccess).not.toHaveBeenCalled();
    expect(overlay.start).not.toHaveBeenCalled();
    expect(views).toEqual([{ state: "error", message: DICTATION_MESSAGES.noProvider }]);
  });

  it("explains a blocked or missing microphone", async () => {
    const denied = setup({ microphoneAccess: vi.fn(async () => "denied" as const) });
    await denied.controller.toggle();
    expect(denied.overlay.start).not.toHaveBeenCalled();
    expect(denied.views.at(-1)?.message).toBe(DICTATION_MESSAGES.microphoneBlocked);

    const missing = setup();
    missing.overlay.start.mockResolvedValueOnce({ ok: false, error: "NotFoundError" } as never);
    await missing.controller.toggle();
    expect(missing.views.at(-1)?.message).toBe(DICTATION_MESSAGES.noMicrophone);
    expect(missing.cancelKey.at(-1)).toBe(false);
  });

  it("drops a click with no speech without calling the provider", async () => {
    const { controller, deps, overlay, views } = setup();
    overlay.stop.mockResolvedValueOnce(new Uint8Array(10));
    await controller.toggle();
    await controller.toggle();
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(views.at(-1)?.message).toBe(DICTATION_MESSAGES.nothingHeard);
  });

  it("refuses audio over the upload limit", async () => {
    const { controller, deps, overlay, views } = setup();
    overlay.stop.mockResolvedValueOnce(new Uint8Array(MAX_DICTATION_BYTES + 1));
    await controller.toggle();
    await controller.toggle();
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(views.at(-1)?.message).toBe(DICTATION_MESSAGES.tooLong);
  });

  it("keeps the provider's error out of the overlay", async () => {
    const log = vi.fn();
    const { controller, views, deps } = setup({
      transcribe: vi.fn(async () => {
        throw new Error('OpenAI STT failed: {"error":"bad key sk-abc"}');
      }),
      log,
    });
    await controller.toggle();
    await controller.toggle();
    expect(views.at(-1)).toEqual({ state: "error", message: DICTATION_MESSAGES.transcribeFailed });
    expect(deps.deliver).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("transcription failed"));
    expect(log.mock.calls.flat().join(" ")).not.toContain("sk-abc");
  });

  it("only copies when you switched apps while dictating", async () => {
    const frontmostApp = vi
      .fn()
      .mockResolvedValueOnce("com.apple.TextEdit:42")
      .mockResolvedValueOnce("com.apple.Terminal:77");
    const { controller, deps, views } = setup({
      frontmostApp,
      deliver: vi.fn(async () => "copied" as const),
    });
    await controller.toggle();
    await controller.toggle();
    expect(deps.deliver).toHaveBeenCalledWith("Hello there.", { paste: false });
    expect(views.at(-1)?.message).toBe(DICTATION_MESSAGES.switchedApps);
  });

  it("pastes when the app in front can't be told", async () => {
    const { controller, deps } = setup({ frontmostApp: vi.fn(async () => null) });
    await controller.toggle();
    await controller.toggle();
    expect(deps.deliver).toHaveBeenCalledWith("Hello there.", { paste: true });
  });

  it("says so when the old clipboard couldn't be put back", async () => {
    const { controller, views } = setup({
      deliver: vi.fn(async () => "pasted_clipboard_lost" as const),
    });
    await controller.toggle();
    await controller.toggle();
    expect(views.at(-1)?.message).toBe(DICTATION_MESSAGES.clipboardLost);
  });

  it("gives Escape back when the overlay fails to open", async () => {
    const { controller, overlay, cancelKey } = setup();
    overlay.show.mockRejectedValueOnce(new Error("window gone"));
    await controller.toggle();
    expect(cancelKey).toEqual([true, false]);
    expect(controller.currentPhase).toBe("idle");
    expect(overlay.hide).toHaveBeenCalled();
  });

  it("pastes one line, so a terminal never gets a Return", () => {
    expect(tidyTranscript("  First line.\nSecond line.\r\n\n Third.  ")).toBe(
      "First line. Second line. Third.",
    );
    expect(tidyTranscript("a  \t b")).toBe("a b");
  });

  it("does not paste when nothing was said", async () => {
    const { controller, deps, views } = setup({ transcribe: vi.fn(async () => "   ") });
    await controller.toggle();
    await controller.toggle();
    expect(deps.deliver).not.toHaveBeenCalled();
    expect(views.at(-1)?.message).toBe(DICTATION_MESSAGES.nothingHeard);
  });

  it("cancels while listening and drops the recording", async () => {
    const { controller, deps, overlay, cancelKey } = setup();
    await controller.toggle();
    await controller.cancel();
    expect(overlay.cancel).toHaveBeenCalled();
    expect(overlay.hide).toHaveBeenCalled();
    expect(overlay.stop).not.toHaveBeenCalled();
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(cancelKey.at(-1)).toBe(false);
    expect(controller.currentPhase).toBe("idle");
  });

  it("throws away a transcript that arrives after a cancel", async () => {
    let release: (text: string) => void = () => {};
    const { controller, deps } = setup({
      transcribe: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            release = resolve;
          }),
      ),
    });
    await controller.toggle();
    const finishing = controller.toggle();
    await vi.waitFor(() => expect(deps.transcribe).toHaveBeenCalled());
    await controller.cancel();
    release("late words");
    await finishing;
    expect(deps.deliver).not.toHaveBeenCalled();
    expect(controller.currentPhase).toBe("idle");
  });

  it("ignores the shortcut while writing down", async () => {
    let release: (text: string) => void = () => {};
    const { controller, deps, overlay } = setup({
      transcribe: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            release = resolve;
          }),
      ),
    });
    await controller.toggle();
    const finishing = controller.toggle();
    await vi.waitFor(() => expect(deps.transcribe).toHaveBeenCalled());
    await controller.toggle();
    expect(overlay.start).toHaveBeenCalledTimes(1);
    release("ok");
    await finishing;
    expect(deps.deliver).toHaveBeenCalledWith("ok", { paste: true });
  });

  it("stops by itself after the longest dictation", async () => {
    const { controller, deps, fire } = setup();
    await controller.toggle();
    fire(MAX_DICTATION_MS);
    await vi.waitFor(() => expect(deps.deliver).toHaveBeenCalled());
  });

  it("starts again while a message is still showing", async () => {
    const { controller, overlay } = setup({ transcriptionReady: () => true });
    await controller.toggle();
    await controller.toggle();
    expect(controller.currentPhase).toBe("showing");
    await controller.toggle();
    expect(controller.currentPhase).toBe("recording");
    expect(overlay.start).toHaveBeenCalledTimes(2);
  });
});
