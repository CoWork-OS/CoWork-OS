import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";

const require = createRequire(import.meta.url);

interface WorkerMessage {
  kind?: "waiting" | "done" | "paused" | "error";
  error?: string;
}

interface WriterParams {
  workspacePath: string;
  taskId: string;
  content: string;
  sourceTimestamp?: number;
  barrierPath?: string;
  lockRoot?: string;
}

function workerEnvironment(lockRoot?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(lockRoot ? { COWORK_CHECKPOINT_LOCK_ROOT: lockRoot } : {}),
  };
}

async function buildWorker(workspacePath: string): Promise<string> {
  const workerPath = path.join(workspacePath, `transcript-store-worker-${randomUUID()}.cjs`);
  await build({
    stdin: {
      contents: `
        import fs from "node:fs";
        import { TranscriptStore } from "./src/electron/memory/TranscriptStore";

        TranscriptStore.setDatabaseForTests(null);
        const [mode, workspacePath, taskId, content, sourceTimestampText, barrierPath] =
          process.argv.slice(2);
        const sourceTimestamp = Number(sourceTimestampText);

        function send(message) {
          if (typeof process.send === "function") process.send(message);
        }

        async function waitForBarrier() {
          if (!barrierPath) return;
          send({ kind: "waiting" });
          while (!fs.existsSync(barrierPath)) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }

        async function main() {
          if (mode === "hold-write") {
            const originalRename = fs.promises.rename.bind(fs.promises);
            const originalCopyFile = fs.promises.copyFile.bind(fs.promises);
            let paused = false;
            const pauseBeforeCommit = async () => {
              if (paused) return;
              paused = true;
              send({ kind: "paused" });
              while (!barrierPath || !fs.existsSync(barrierPath)) {
                await new Promise((resolve) => setTimeout(resolve, 5));
              }
            };
            fs.promises.copyFile = async (sourcePath, destinationPath, ...rest) => {
              if (String(destinationPath).endsWith(".tmp")) {
                await pauseBeforeCommit();
              }
              return originalCopyFile(sourcePath, destinationPath, ...rest);
            };
            fs.promises.rename = async (sourcePath, destinationPath) => {
              if (String(destinationPath).endsWith(".json")) {
                await pauseBeforeCommit();
              }
              return originalRename(sourcePath, destinationPath);
            };
          }

          if (mode !== "hold-write") await waitForBarrier();
          await TranscriptStore.writeCheckpoint(workspacePath, taskId, {
            checkpointKind: "snapshot",
            conversationHistory: [{ role: "user", content }],
            ...(Number.isFinite(sourceTimestamp) ? { sourceTimestamp, timestamp: sourceTimestamp } : {}),
          });
          send({ kind: "done" });
        }

        main().catch((error) => {
          send({ kind: "error", error: String(error?.stack || error) });
          process.exitCode = 1;
        });
      `,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: workerPath,
    logLevel: "silent",
    plugins: [
      {
        name: "isolate-application-database",
        setup(builder) {
          builder.onResolve({ filter: /\/database\/schema$/ }, () => ({
            path: "database",
            namespace: "test-db",
          }));
          builder.onResolve({ filter: /^better-sqlite3$/ }, () => ({
            path: require.resolve("better-sqlite3"),
            external: true,
          }));
          builder.onLoad({ filter: /.*/, namespace: "test-db" }, () => ({
            contents: "export const DatabaseManager = {};",
            loader: "js",
          }));
        },
      },
    ],
  });
  return workerPath;
}

function readWorkerStderr(child: ChildProcess): { read: () => string } {
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return { read: () => stderr };
}

function waitForMessage(
  child: ChildProcess,
  expectedKind: WorkerMessage["kind"],
  stderr: { read: () => string },
): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(`Checkpoint worker timed out waiting for ${expectedKind}: ${stderr.read()}`),
      );
    }, 10_000);
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onMessage = (message: WorkerMessage) => {
      if (message.kind === "error") {
        cleanup();
        reject(new Error(`Checkpoint worker failed: ${message.error || stderr.read()}`));
      } else if (message.kind === expectedKind) {
        cleanup();
        resolve(message);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Checkpoint worker exited before ${expectedKind}: ${code ?? signal}`));
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function waitForExit(child: ChildProcess, stderr: { read: () => string }): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      if (child.exitCode === 0) resolve();
      else reject(new Error(`Checkpoint worker exited: ${child.exitCode ?? child.signalCode}`));
      return;
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Checkpoint worker exited: ${code ?? signal}: ${stderr.read()}`));
    });
  });
}

function waitForTermination(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

function spawnWriter(
  workerPath: string,
  params: WriterParams,
): {
  child: ChildProcess;
  stderr: { read: () => string };
} {
  const child = spawn(
    process.execPath,
    [
      workerPath,
      "write",
      params.workspacePath,
      params.taskId,
      params.content,
      params.sourceTimestamp === undefined ? "" : String(params.sourceTimestamp),
      params.barrierPath || "",
    ],
    {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: workerEnvironment(params.lockRoot),
    },
  );
  return { child, stderr: readWorkerStderr(child) };
}

export async function runConcurrentCheckpointWriters(
  params: Omit<WriterParams, "content" | "sourceTimestamp" | "barrierPath"> & {
    contents: string[];
    sourceTimestamp?: number;
    sourceTimestamps?: Array<number | undefined>;
  },
): Promise<void> {
  const workerPath = await buildWorker(params.workspacePath);
  const barrierPath = path.join(params.workspacePath, `checkpoint-start-${randomUUID()}`);
  const writers = params.contents.map((content, index) =>
    spawnWriter(workerPath, {
      workspacePath: params.workspacePath,
      taskId: params.taskId,
      content,
      sourceTimestamp: params.sourceTimestamps?.[index] ?? params.sourceTimestamp,
      barrierPath,
      lockRoot: params.lockRoot,
    }),
  );
  try {
    await Promise.all(writers.map(({ child, stderr }) => waitForMessage(child, "waiting", stderr)));
    await fs.writeFile(barrierPath, "start", "utf8");
    await Promise.all(
      writers.map(async ({ child, stderr }) => {
        await waitForMessage(child, "done", stderr);
        await waitForExit(child, stderr);
      }),
    );
  } finally {
    await Promise.all(
      writers.map(async ({ child }) => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await waitForTermination(child);
      }),
    );
  }
}

export async function runCheckpointWriter(params: WriterParams): Promise<void> {
  const workerPath = await buildWorker(params.workspacePath);
  const writer = spawnWriter(workerPath, params);
  try {
    if (params.barrierPath) {
      await waitForMessage(writer.child, "waiting", writer.stderr);
      await fs.writeFile(params.barrierPath, "start", "utf8");
    }
    await waitForMessage(writer.child, "done", writer.stderr);
    await waitForExit(writer.child, writer.stderr);
  } finally {
    if (writer.child.exitCode === null && writer.child.signalCode === null) {
      writer.child.kill("SIGKILL");
      await waitForTermination(writer.child);
    }
  }
}

export async function killCheckpointWriterMidFilesystemWrite(
  params: WriterParams & { releasePath: string },
): Promise<void> {
  const workerPath = await buildWorker(params.workspacePath);
  const child = spawn(
    process.execPath,
    [
      workerPath,
      "hold-write",
      params.workspacePath,
      params.taskId,
      params.content,
      params.sourceTimestamp === undefined ? "" : String(params.sourceTimestamp),
      params.releasePath,
    ],
    {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: workerEnvironment(params.lockRoot),
    },
  );
  const stderr = readWorkerStderr(child);
  try {
    await waitForMessage(child, "paused", stderr);
    child.kill("SIGKILL");
    await waitForTermination(child);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}
