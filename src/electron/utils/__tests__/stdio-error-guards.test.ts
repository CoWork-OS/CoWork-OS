import { EventEmitter } from "node:events";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { installStdioErrorGuards } from "../stdio-error-guards";

describe("stdio error guards", () => {
  it("handles a closed output pipe without logging to that pipe and can be removed", () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const dispose = installStdioErrorGuards([stdout, stderr]);
    const brokenPipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    expect(() => stdout.emit("error", brokenPipe)).not.toThrow();
    expect(() => stderr.emit("error", brokenPipe)).not.toThrow();
    expect(() =>
      stderr.emit(
        "error",
        Object.assign(new Error("closed output"), { code: "ERR_STREAM_DESTROYED" }),
      ),
    ).not.toThrow();
    dispose();
    expect(stdout.listenerCount("error")).toBe(0);
    expect(stderr.listenerCount("error")).toBe(0);
  });

  it("preserves unexpected stream errors", () => {
    const stream = new EventEmitter();
    const dispose = installStdioErrorGuards([stream]);
    const error = Object.assign(new Error("I/O failure"), { code: "EIO" });
    expect(() => stream.emit("error", error)).toThrow(error);
    dispose();
  });

  it("finishes shutdown after the launcher closes both real output pipes", async () => {
    const child = fork(
      fileURLToPath(new URL("./fixtures/stdio-detached-launcher.mjs", import.meta.url)),
      [fileURLToPath(new URL("../stdio-error-guards.ts", import.meta.url))],
      { silent: true, execArgv: ["--experimental-strip-types"] },
    );
    const messages: unknown[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Detached launcher did not exit")),
          3_000,
        );
        child.on("message", (message) => {
          messages.push(message);
          if (message === "ready") {
            child.stdout?.destroy();
            child.stderr?.destroy();
            child.send("detach");
          }
        });
        child.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once("exit", (code) => {
          clearTimeout(timeout);
          if (code === 0) resolve();
          else reject(new Error(`Detached launcher child exited with ${code}`));
        });
      });
      expect(messages).toContainEqual({ completed: true, uncaughtCount: 0 });
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }, 5_000);
});
