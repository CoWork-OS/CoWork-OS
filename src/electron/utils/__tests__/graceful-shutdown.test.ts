import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import * as typescript from "typescript";
import { describe, expect, it, vi } from "vitest";
import { installGracefulShutdown } from "../graceful-shutdown";

class TestApp extends EventEmitter {
  exits = 0;
  quit() {
    let prevented = false;
    this.emit("before-quit", {
      preventDefault: () => {
        prevented = true;
      },
    });
    if (!prevented) this.exits += 1;
  }
}

describe("graceful Electron shutdown", () => {
  it("holds repeated quit requests until pending task writes finish, then closes storage", async () => {
    const app = new TestApp();
    const events: string[] = [];
    let finishTask!: () => void;
    const task = new Promise<void>((resolve) => {
      finishTask = resolve;
    });
    let databaseOpen = true;
    const stopAgent = vi.fn(async () => {
      events.push("snapshot");
      await task;
      expect(databaseOpen).toBe(true);
      events.push("interrupted");
    });
    installGracefulShutdown(
      app,
      [
        { name: "agent", run: stopAgent },
        {
          name: "database",
          run: () => {
            databaseOpen = false;
            events.push("close");
          },
        },
      ],
      vi.fn(),
    );

    app.quit();
    app.quit();
    expect(app.exits).toBe(0);
    await vi.waitFor(() => expect(stopAgent).toHaveBeenCalledTimes(1));
    expect(events).toEqual(["snapshot"]);
    finishTask();
    await vi.waitFor(() => expect(app.exits).toBe(1));
    expect(events).toEqual(["snapshot", "interrupted", "close"]);
  });

  it("continues persistence and cleanup after synchronous and asynchronous service failures", async () => {
    const app = new TestApp();
    const persist = vi.fn();
    const close = vi.fn();
    const report = vi.fn();
    installGracefulShutdown(
      app,
      [
        {
          name: "producer",
          run: () => {
            throw new Error("stop failed");
          },
        },
        { name: "agent", run: persist },
        {
          name: "mcp",
          run: async () => {
            throw new Error("disconnect failed");
          },
        },
        { name: "database", run: close },
      ],
      report,
    );
    app.quit();
    await vi.waitFor(() => expect(app.exits).toBe(1));
    expect(persist).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(report.mock.calls.map(([name]) => name)).toEqual(["producer", "mcp"]);
  });

  it("still completes when error reporting throws and does not rerun cleanup on reentry", async () => {
    const app = new TestApp();
    const cleanup = vi.fn(() => {
      throw new Error("failure");
    });
    installGracefulShutdown(app, [{ name: "cleanup", run: cleanup }], () => {
      throw new Error("logger failure");
    });
    app.quit();
    await vi.waitFor(() => expect(app.exits).toBe(1));
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
  it("reports a hung service and still reaches task persistence and quit", async () => {
    const app = new TestApp();
    const persist = vi.fn();
    const report = vi.fn();
    installGracefulShutdown(
      app,
      [
        { name: "hung producer", run: () => new Promise(() => {}) },
        { name: "agent", run: persist },
      ],
      report,
      10,
    );
    app.quit();
    await vi.waitFor(() => expect(app.exits).toBe(1));
    expect(persist).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      "hung producer",
      expect.objectContaining({ message: "Shutdown step timed out after 10ms" }),
    );
  });

  it("keeps dependency release steps alive when worker quiescence times out", async () => {
    const app = new TestApp();
    const report = vi.fn();
    const persist = vi.fn();
    const mcpClose = vi.fn();
    const memoryClose = vi.fn();
    const databaseClose = vi.fn();
    installGracefulShutdown(
      app,
      [
        { name: "agent daemon", run: () => new Promise(() => {}) },
        { name: "task persistence", run: persist },
        { name: "MCP servers", requiresQuiescence: true, run: mcpClose },
        { name: "memory", requiresQuiescence: true, run: memoryClose },
        { name: "database", requiresQuiescence: true, run: databaseClose },
      ],
      report,
      10,
    );

    app.quit();
    await vi.waitFor(() => expect(app.exits).toBe(1));
    expect(persist).toHaveBeenCalledTimes(1);
    expect(mcpClose).not.toHaveBeenCalled();
    expect(memoryClose).not.toHaveBeenCalled();
    expect(databaseClose).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(
      "agent daemon",
      expect.objectContaining({ message: "Shutdown step timed out after 10ms" }),
    );
  });

  it("headless SIGTERM exits nonzero and skips database release after delayed worker timeout", async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "cowork-daemon-shutdown-"));
    const transpiledRunner = typescript.transpileModule(
      readFileSync(path.join(repoRoot, "src/electron/utils/graceful-shutdown.ts"), "utf8"),
      {
        compilerOptions: {
          module: typescript.ModuleKind.CommonJS,
          target: typescript.ScriptTarget.ES2022,
          esModuleInterop: true,
        },
      },
    ).outputText;
    const runnerPath = path.join(tempRoot, "graceful-shutdown.cjs");
    writeFileSync(runnerPath, transpiledRunner, "utf8");

    const childScript = `
      const { runShutdownSteps } = require(${JSON.stringify(runnerPath)});
      console.log("READY");
      process.on("SIGTERM", () => {
        void runShutdownSteps([
          { name: "agent daemon", run: () => new Promise(() => {}) },
          { name: "database", requiresQuiescence: true, run: () => console.log("database-closed") },
        ], (name, error) => console.error(name, error.message), 20)
          .then((result) => { console.log(JSON.stringify(result)); process.exit(result.quiescent ? 0 : 1); });
      });
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["-e", childScript], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    try {
      await vi.waitFor(() => expect(stdout).toContain("READY"), { timeout: 2_000 });
      child.kill("SIGTERM");
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`headless shutdown child timed out: ${stdout}\n${stderr}`));
          }, 2_000);
          child.once("error", reject);
          child.once("exit", (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal });
          });
        },
      );

      expect(exit.code).toBe(1);
      expect(stdout).not.toContain("database-closed");
      expect(stdout).toContain('"quiescent":false');
      expect(stdout).toContain('"database"');
    } finally {
      if (!child.killed) child.kill("SIGKILL");
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
