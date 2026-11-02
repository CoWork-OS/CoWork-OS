#!/usr/bin/env node
/**
 * Launch wrapper for the secrets upgrade smoke: starts the app and copies everything it
 * writes to stdout and stderr into a file from the moment the process starts.
 *
 * Playwright attaches its own readers to the app's stdio when it spawns the process, so a
 * listener the smoke adds after `_electron.launch` resolves has already missed whatever the
 * app logged while starting (the "SecureSettingsRepository initialized" line among it).
 * Running the app through this wrapper puts the file writer in place before the app exists,
 * so the smoke's log checks read a complete transcript.
 *
 * Playwright puts its own switches (`--inspect=0`, `--remote-debugging-port=0`) before the
 * arguments it is given, so the app's executable cannot travel in argv: it comes from the
 * environment, and every argument is passed to it unchanged. On POSIX this file is the
 * executable itself (shebang); on Windows `secrets-upgrade-smoke-launch.cmd` runs it.
 *
 *   COWORK_SMOKE_EXECUTABLE  the app's executable (required)
 *   COWORK_SMOKE_LOG_FILE    receives the app's stdout and stderr (appended)
 *   COWORK_SMOKE_PID_FILE    receives the app's process id, for samples and kills (optional)
 * The variables are removed from the app's environment. stdout and stderr are also passed
 * through unchanged, so Playwright still finds its "Debugger listening" line.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

const executable = process.env.COWORK_SMOKE_EXECUTABLE;
const args = process.argv.slice(2);
if (!executable) {
  process.stderr.write("secrets-upgrade-smoke-launch: COWORK_SMOKE_EXECUTABLE is not set\n");
  process.exit(2);
}

const logFile = process.env.COWORK_SMOKE_LOG_FILE;
const pidFile = process.env.COWORK_SMOKE_PID_FILE;
const env = { ...process.env };
delete env.COWORK_SMOKE_EXECUTABLE;
delete env.COWORK_SMOKE_LOG_FILE;
delete env.COWORK_SMOKE_PID_FILE;

const sink = logFile ? fs.openSync(logFile, "a") : null;
const child = spawn(executable, args, { stdio: ["inherit", "pipe", "pipe"], env });
child.on("error", (error) => {
  process.stderr.write(`secrets-upgrade-smoke-launch: ${error.message}\n`);
  process.exitCode = 127;
});
if (pidFile && child.pid) fs.writeFileSync(pidFile, String(child.pid));

const copy = (from, to) =>
  from.on("data", (chunk) => {
    if (sink !== null) fs.writeSync(sink, chunk);
    to.write(chunk);
  });
copy(child.stdout, process.stdout);
copy(child.stderr, process.stderr);

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("close", (code, signal) => {
  if (sink !== null) fs.closeSync(sink);
  // Let stdout drain instead of calling process.exit, which could truncate the last chunk.
  process.exitCode = code ?? (signal ? 1 : 0);
});
