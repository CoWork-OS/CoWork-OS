import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";

/** Exercise the real filesystem store with no access to the application database. */
export async function checkpointCrashRoundTrip(workspace: string, snapshot: unknown) {
  const entry = path.join(workspace, "checkpoint-worker.cjs");
  const input = path.join(workspace, "snapshot-input.json");
  const checkpointLockRoot = path.join(workspace, "isolated-checkpoint-locks");
  await fs.writeFile(input, JSON.stringify(snapshot));
  await build({
    stdin: {
      contents: `
        import fs from "node:fs";
        import { TranscriptStore } from "./src/electron/memory/TranscriptStore";
        TranscriptStore.setDatabaseForTests(null);
        const [mode, workspace, input] = process.argv.slice(2);
        if (mode === "write") {
          TranscriptStore.writeCheckpoint(workspace, "task-1", JSON.parse(fs.readFileSync(input, "utf8")))
            .then(() => {
              process.send({ committed: true });
              setInterval(() => {}, 1000);
            }).catch(error => { console.error(error); process.exit(1); });
        } else {
          const checkpoint = TranscriptStore.loadCheckpointSync(workspace, "task-1");
          if (!checkpoint) process.exit(2);
          process.stdout.write(JSON.stringify(checkpoint));
        }
      `,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: entry,
    logLevel: "silent",
    plugins: [
      {
        name: "isolate-application-database",
        setup(builder) {
          builder.onResolve({ filter: /^better-sqlite3$/ }, () => ({
            path: createRequire(import.meta.url).resolve("better-sqlite3"),
            external: true,
          }));
          builder.onResolve({ filter: /\/database\/schema$/ }, () => ({
            path: "database",
            namespace: "test-db",
          }));
          builder.onLoad({ filter: /.*/, namespace: "test-db" }, () => ({
            contents: "export const DatabaseManager = {};",
            loader: "js",
          }));
        },
      },
    ],
  });
  const writer = spawn(process.execPath, [entry, "write", workspace, input], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: {
      ...process.env,
      COWORK_CHECKPOINT_LOCK_ROOT: checkpointLockRoot,
    },
  });
  let stderr = "";
  writer.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Checkpoint writer timed out: ${stderr}`)),
        10_000,
      );
      writer.once("message", (message) => {
        clearTimeout(timer);
        if ((message as { committed?: boolean }).committed) resolve();
        else reject(new Error("Unexpected writer receipt"));
      });
      writer.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      writer.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Writer exited ${code}: ${stderr}`));
      });
    });
    const exited = new Promise<void>((resolve) => writer.once("exit", () => resolve()));
    writer.kill("SIGKILL");
    await exited;
    const reader = spawnSync(process.execPath, [entry, "read", workspace, input], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        COWORK_CHECKPOINT_LOCK_ROOT: checkpointLockRoot,
      },
    });
    if (reader.status !== 0) throw new Error(`Fresh checkpoint reader failed: ${reader.stderr}`);
    return JSON.parse(reader.stdout);
  } finally {
    if (writer.exitCode === null && writer.signalCode === null) writer.kill("SIGKILL");
  }
}
