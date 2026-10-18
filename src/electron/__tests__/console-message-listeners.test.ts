import type { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickInputWindow } from "../tray/QuickInputWindow";

const state = vi.hoisted(() => ({ windows: [] as Array<{ webContents: EventEmitter }> }));

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  const display = {
    id: 1,
    bounds: { x: 0, y: 0, width: 1280, height: 800 },
    workArea: { x: 0, y: 0, width: 1280, height: 780 },
    workAreaSize: { width: 1280, height: 780 },
  };
  class Window extends EventEmitter {
    id = state.windows.length + 1;
    webContents = Object.assign(new EventEmitter(), {
      executeJavaScript: vi.fn(async () => ""),
    });
    isDestroyed = vi.fn(() => false);
    loadURL = vi.fn(async () => {});
    setVisibleOnAllWorkspaces = vi.fn();
    setAlwaysOnTop = vi.fn();
    setBounds = vi.fn();
    destroy = vi.fn();

    constructor() {
      super();
      state.windows.push(this);
    }
  }
  return {
    BrowserWindow: Window,
    screen: {
      getCursorScreenPoint: () => ({ x: 100, y: 100 }),
      getDisplayNearestPoint: () => display,
      getDisplayMatching: () => display,
      getPrimaryDisplay: () => display,
      getAllDisplays: () => [display],
      on: vi.fn(),
      removeListener: vi.fn(),
    },
    shell: {},
    ipcMain: { on: vi.fn(), handle: vi.fn() },
    clipboard: { writeText: vi.fn() },
  };
});

beforeEach(() => {
  state.windows.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Electron console-message event details", () => {
  it("dispatches only exact quick-input controls from event.message", () => {
    const input = new QuickInputWindow();
    const hooks = input as unknown as {
      submitFromWindow: QuickInputWindow["submitFromWindow"];
      copyResponse: QuickInputWindow["copyResponse"];
      resetForNewTask: QuickInputWindow["resetForNewTask"];
    };
    const submit = vi.spyOn(hooks, "submitFromWindow").mockResolvedValue(undefined);
    const copy = vi.spyOn(hooks, "copyResponse").mockResolvedValue(undefined);
    const reset = vi.spyOn(hooks, "resetForNewTask").mockImplementation(() => {});
    const hide = vi.spyOn(input, "hide").mockImplementation(() => {});
    const openMain = vi.fn();
    input.setOnOpenMain(openMain);
    input.show();
    const contents = state.windows[0].webContents;
    expect(contents.listeners("console-message")[0]).toHaveLength(1);
    contents.emit("console-message", { message: "ordinary page log" });
    contents.emit("console-message", { message: "prefix __QUICK_INPUT_SUBMIT__" });
    expect(submit).not.toHaveBeenCalled();
    for (const action of ["SUBMIT", "CLOSE", "COPY", "OPEN_MAIN", "NEW_WINDOW"])
      contents.emit("console-message", { message: `__QUICK_INPUT_${action}__` });
    for (const handler of [submit, hide, copy, openMain, reset])
      expect(handler).toHaveBeenCalledExactlyOnceWith();
  });
});
