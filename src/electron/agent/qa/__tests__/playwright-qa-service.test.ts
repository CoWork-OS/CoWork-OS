import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { describe, expect, it, vi } from "vitest";
import { PlaywrightQAService } from "../playwright-qa-service";

function makeWorkspace() {
  const root = path.join(os.tmpdir(), `cowork-qa-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  return {
    id: `ws-${randomUUID()}`,
    name: "QA Workspace",
    path: root,
    createdAt: Date.now(),
    permissions: { read: false, write: false, delete: false, network: false, shell: false },
  };
}

describe("PlaywrightQAService", () => {
  it("clears the active run during cleanup", async () => {
    const service = new PlaywrightQAService(makeWorkspace());
    const browserClose = vi.fn().mockResolvedValue(undefined);
    const kill = vi.fn();
    Object.assign(service, { browserService: { close: browserClose } });
    Object.assign(service, { serverProcess: { killed: false, kill } });
    Object.assign(service, {
      currentRun: {
        id: "run-1",
        taskId: "task-1",
        status: "idle",
        config: { targetUrl: "http://localhost:3000" },
        checks: [],
        interactionLog: [],
        issues: [],
        fixAttempts: 0,
        durationMs: 0,
        startedAt: Date.now(),
      },
    });

    await service.cleanup();

    expect(browserClose).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(service.getCurrentRun()).toBeNull();
  });
});
