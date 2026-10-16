import { describe, expect, it } from "vitest";
import {
  browserPartitionFor,
  browserPartitionForTask,
  isBrowserPartitionAllowedForTask,
} from "../browser-profile";

describe("browser profiles", () => {
  const workspaceId = "0b4f6a0e-6a3e-4a3a-9b0e-1c2d3e4f5a6b";
  const botId = "7d2c1e9a-3b4f-4c5d-8e6f-7a8b9c0d1e2f";
  const otherBotId = "11111111-2222-4333-8444-555555555555";

  it("uses the workspace profile for ordinary tasks", () => {
    expect(browserPartitionForTask(workspaceId)).toBe(browserPartitionFor(workspaceId));
  });

  it("gives each bot its own profile in a workspace", () => {
    const mine = browserPartitionForTask(workspaceId, botId);
    const other = browserPartitionForTask(workspaceId, otherBotId);
    expect(mine).not.toBe(browserPartitionFor(workspaceId));
    expect(mine).not.toBe(other);
    expect(mine.length).toBeLessThanOrEqual("persist:cowork-browser-".length + 80);
    expect(/^[A-Za-z0-9._:-]{1,160}$/.test(mine.slice("persist:".length))).toBe(true);
  });

  it("lets a task show pages only on its own profile", () => {
    const mine = browserPartitionForTask(workspaceId, botId);
    const workspaceProfile = browserPartitionFor(workspaceId);
    expect(isBrowserPartitionAllowedForTask(mine, botId)).toBe(true);
    expect(isBrowserPartitionAllowedForTask(workspaceProfile, botId)).toBe(false);
    expect(isBrowserPartitionAllowedForTask(mine, otherBotId)).toBe(false);
    expect(isBrowserPartitionAllowedForTask(mine, undefined)).toBe(false);
    expect(isBrowserPartitionAllowedForTask(workspaceProfile, undefined)).toBe(true);
    expect(isBrowserPartitionAllowedForTask("persist:other", undefined)).toBe(false);
  });
});
