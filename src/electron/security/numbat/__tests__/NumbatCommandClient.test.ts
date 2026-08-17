import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { runNumbatCommand } from "../NumbatCommandClient";

afterEach(() => vi.clearAllMocks());

function binary() {
  return {
    path: "/trusted/numbat",
    sha256: "test-sha256",
    version: "test",
    commit: "test-commit",
    schemaVersion: "0.2.0",
    source: "bundled" as const,
  };
}

describe("runNumbatCommand", () => {
  it("rejects output stream errors and terminates the child", async () => {
    const stdout = new EventEmitter();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    spawnMock.mockReturnValue(child);

    const command = runNumbatCommand({ binary: binary(), args: ["status"] });
    stdout.emit("error", new Error("stream failed"));

    await expect(command).rejects.toThrow("Failed to read Numbat command output: stream failed");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("redacts and bounds stderr in command failures", async () => {
    const stderr = new EventEmitter();
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr,
      kill: vi.fn(),
    });
    spawnMock.mockReturnValue(child);

    const command = runNumbatCommand({ binary: binary(), args: ["status"] });
    stderr.emit("data", Buffer.from("AWS_SECRET_ACCESS_KEY=do-not-leak"));
    child.emit("close", 1);

    await expect(command).rejects.toThrow(/AWS_SECRET_ACCESS_KEY=\[REDACTED\]/);
    await expect(command).rejects.not.toThrow(/do-not-leak/);
  });
});
