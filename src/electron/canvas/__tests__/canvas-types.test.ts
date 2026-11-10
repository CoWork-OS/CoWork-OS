/**
 * Canvas Types & Protocol Tests
 *
 * Validates canvas-related type definitions, protocol method constants,
 * and IPC channel definitions are consistent and complete.
 */

import { describe, it, expect } from "vitest";
import { Methods, Events } from "../../control-plane/protocol";
import { IPC_CHANNELS } from "../../../shared/types";
import type {
  CanvasSession,
  CanvasCheckpoint,
  CanvasEvent,
  CanvasSnapshot,
} from "../../../shared/types";

describe("Canvas Protocol Methods", () => {
  it("defines all 10 canvas methods", () => {
    expect(Methods.CANVAS_LIST).toBe("canvas.list");
    expect(Methods.CANVAS_GET).toBe("canvas.get");
    expect(Methods.CANVAS_SNAPSHOT).toBe("canvas.snapshot");
    expect(Methods.CANVAS_CONTENT).toBe("canvas.content");
    expect(Methods.CANVAS_PUSH).toBe("canvas.push");
    expect(Methods.CANVAS_EVAL).toBe("canvas.eval");
    expect(Methods.CANVAS_CHECKPOINT_SAVE).toBe("canvas.checkpoint.save");
    expect(Methods.CANVAS_CHECKPOINT_LIST).toBe("canvas.checkpoint.list");
    expect(Methods.CANVAS_CHECKPOINT_RESTORE).toBe("canvas.checkpoint.restore");
    expect(Methods.CANVAS_CHECKPOINT_DELETE).toBe("canvas.checkpoint.delete");
  });

  it("defines canvas events", () => {
    expect(Events.CANVAS_CONTENT_PUSHED).toBe("canvas.content_pushed");
    expect(Events.CANVAS_SESSION_UPDATED).toBe("canvas.session_updated");
  });
});

describe("Canvas IPC Channels", () => {
  it("defines the canvas IPC channels the renderer calls", () => {
    expect(IPC_CHANNELS.CANVAS_GET_SESSION).toBe("canvas:getSession");
    expect(IPC_CHANNELS.CANVAS_LIST_SESSIONS).toBe("canvas:listSessions");
    expect(IPC_CHANNELS.CANVAS_SHOW).toBe("canvas:show");
    expect(IPC_CHANNELS.CANVAS_CLOSE).toBe("canvas:close");
    expect(IPC_CHANNELS.CANVAS_SNAPSHOT).toBe("canvas:snapshot");
    expect(IPC_CHANNELS.CANVAS_EXPORT_HTML).toBe("canvas:exportHTML");
    expect(IPC_CHANNELS.CANVAS_EXPORT_TO_FOLDER).toBe("canvas:exportToFolder");
    expect(IPC_CHANNELS.CANVAS_OPEN_IN_BROWSER).toBe("canvas:openInBrowser");
    expect(IPC_CHANNELS.CANVAS_GET_SESSION_DIR).toBe("canvas:getSessionDir");
  });
});

describe("Canvas Type Shapes", () => {
  it("CanvasCheckpoint has required fields", () => {
    const checkpoint: CanvasCheckpoint = {
      id: "cp-1",
      sessionId: "session-1",
      label: "Test Checkpoint",
      files: { "index.html": "<h1>Hello</h1>" },
      createdAt: Date.now(),
    };

    expect(checkpoint.id).toBe("cp-1");
    expect(checkpoint.sessionId).toBe("session-1");
    expect(checkpoint.label).toBe("Test Checkpoint");
    expect(checkpoint.files["index.html"]).toBe("<h1>Hello</h1>");
    expect(checkpoint.createdAt).toBeGreaterThan(0);
  });

  it("CanvasEvent supports checkpoint_saved and checkpoint_restored types", () => {
    const savedEvent: CanvasEvent = {
      type: "checkpoint_saved",
      sessionId: "session-1",
      taskId: "task-1",
      timestamp: Date.now(),
      checkpoint: { id: "cp-1", label: "Before changes" },
    };

    const restoredEvent: CanvasEvent = {
      type: "checkpoint_restored",
      sessionId: "session-1",
      taskId: "task-1",
      timestamp: Date.now(),
      checkpoint: { id: "cp-1", label: "Before changes" },
    };

    expect(savedEvent.type).toBe("checkpoint_saved");
    expect(savedEvent.checkpoint?.id).toBe("cp-1");
    expect(restoredEvent.type).toBe("checkpoint_restored");
  });

  it("CanvasSession has all expected fields", () => {
    const session: CanvasSession = {
      id: "session-1",
      taskId: "task-1",
      workspaceId: "ws-1",
      sessionDir: "/tmp/canvas/session-1",
      status: "active",
      createdAt: Date.now(),
      lastUpdatedAt: Date.now(),
    };

    expect(session.id).toBe("session-1");
    expect(session.status).toBe("active");
    expect(session.mode).toBeUndefined();
  });

  it("CanvasSnapshot has all expected fields", () => {
    const snapshot: CanvasSnapshot = {
      sessionId: "session-1",
      imageBase64: "base64data",
      width: 900,
      height: 700,
    };

    expect(snapshot.sessionId).toBe("session-1");
    expect(snapshot.width).toBe(900);
    expect(snapshot.height).toBe(700);
  });
});

describe("Canvas Protocol Method Naming Convention", () => {
  it("all canvas methods follow canvas.* namespace", () => {
    const canvasMethods = Object.entries(Methods)
      .filter(([key]) => key.startsWith("CANVAS_"))
      .map(([, value]) => value);

    expect(canvasMethods.length).toBe(10);
    for (const method of canvasMethods) {
      expect(method).toMatch(/^canvas\./);
    }
  });

  it("all canvas events follow canvas.* namespace", () => {
    const canvasEvents = Object.entries(Events)
      .filter(([key]) => key.startsWith("CANVAS_"))
      .map(([, value]) => value);

    expect(canvasEvents.length).toBe(2);
    for (const event of canvasEvents) {
      expect(event).toMatch(/^canvas\./);
    }
  });
});
