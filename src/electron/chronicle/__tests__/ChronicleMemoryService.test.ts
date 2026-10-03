import { describe, expect, it, vi } from "vitest";

const captureMock = vi.hoisted(() => vi.fn());

vi.mock("../../database/schema", () => ({
  DatabaseManager: { getInstance: () => ({ getDatabase: () => ({}) }) },
}));
vi.mock("../../memory/MemoryService", () => ({
  MemoryService: { capture: captureMock },
}));
vi.mock("../ChronicleObservationRepository", () => ({
  ChronicleObservationRepository: { attachMemoryLink: vi.fn(async () => true) },
}));

import { ChronicleMemoryService } from "../ChronicleMemoryService";
import type { ChroniclePersistedObservation } from "../types";

describe("ChronicleMemoryService", () => {
  it("captures screen-context memories as private (never mirrored)", async () => {
    captureMock.mockResolvedValue({ id: "memory-1" });
    const service = new (ChronicleMemoryService as unknown as new () => ChronicleMemoryService)();
    service.applySettings({
      enabled: true,
      mode: "hybrid",
      paused: false,
      captureIntervalSeconds: 10,
      retentionMinutes: 5,
      maxFrames: 60,
      captureScope: "frontmost_display",
      backgroundGenerationEnabled: true,
      respectWorkspaceMemory: true,
      consentAcceptedAt: 1,
    });
    const observation = {
      id: "chronicle-task-1-frame-1",
      promotedAt: Date.now(),
      workspaceId: "ws-1",
      taskId: "task-1",
      query: "draft",
      destinationHints: [],
      observationId: "frame-1",
      capturedAt: Date.now(),
      displayId: "1",
      appName: "Editor",
      windowTitle: "Draft",
      imagePath: "/tmp/x.png",
      localTextSnippet: "secret text",
      confidence: 0.9,
      usedFallback: false,
      provenance: "untrusted_screen_text",
      sourceRef: null,
      width: 10,
      height: 10,
    } satisfies ChroniclePersistedObservation;

    const memory = await service.notePromotedObservation("/tmp/ws", observation);
    expect(memory).toEqual({ id: "memory-1" });
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(captureMock.mock.calls[0]?.[2]).toBe("screen_context");
    expect(captureMock.mock.calls[0]?.[4]).toBe(true);
  });
});
