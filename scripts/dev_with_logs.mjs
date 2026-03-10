#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DEV_LOG_SETTINGS_PATH = path.join(".cowork", "dev-log-settings.json");

function parseBoolean(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function timestampForFilename(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function prefixedLogLine(message) {
  return `[${new Date().toISOString()}] ${message}\n`;
}

function resolveCaptureEnabled() {
  const envOverride = parseBoolean(process.env.COWORK_DEV_LOG_CAPTURE);
  if (typeof envOverride === "boolean") {
    return envOverride;
  }

  try {
    const configPath = path.join(process.cwd(), DEV_LOG_SETTINGS_PATH);
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed?.captureEnabled === true;
  } catch {
    return false;
  }
}

function createLineTimestampWriter(streamA, streamB) {
  let buffer = "";

  const emitLine = (line) => {
    const entry = prefixedLogLine(line);
    streamA.write(entry);
    streamB.write(entry);
  };

  return {
    write(chunk) {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        emitLine(line);
      }
    },
    flush() {
      if (buffer.length > 0) {
        emitLine(buffer);
        buffer = "";
      }
    },
    line(message) {
      emitLine(message);
    },
  };
}

function spawnDev(startWithCapture) {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(npmCommand, ["run", "dev:start"], {
    cwd: process.cwd(),
    env: childEnv,
    stdio: startWithCapture ? ["inherit", "pipe", "pipe"] : "inherit",
  });

  return child;
}

const captureEnabled = resolveCaptureEnabled();

if (!captureEnabled) {
  const child = spawnDev(false);
  child.on("error", (error) => {
    process.stderr.write(prefixedLogLine(`Failed to start npm run dev:start: ${error.message}`));
    process.exit(1);
  });
  child.on("close", (code, signal) => {
    if (typeof code === "number") {
      process.exit(code);
      return;
    }
    process.exit(signal ? 1 : 0);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal);
    });
  }
  process.stdout.write(
    prefixedLogLine(
      "Dev log capture is disabled. Enable it in Settings > Appearance > Developer logging, or run `npm run dev:log`.",
    ),
  );
} else {
  const logsDir = path.join(process.cwd(), "logs");
  fs.mkdirSync(logsDir, { recursive: true });

  const runLogPath = path.join(logsDir, `dev-${timestampForFilename()}.log`);
  const latestLogPath = path.join(logsDir, "dev-latest.log");
  const runLogStream = fs.createWriteStream(runLogPath, { flags: "a" });
  const latestLogStream = fs.createWriteStream(latestLogPath, { flags: "w" });
  const timestampedWriter = createLineTimestampWriter(runLogStream, latestLogStream);

  const child = spawnDev(true);
  process.stdout.write(prefixedLogLine(`Logging enabled. Writing to ${runLogPath}`));
  timestampedWriter.line(`Logging enabled. Writing to ${runLogPath}`);

  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    timestampedWriter.write(chunk);
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    timestampedWriter.write(chunk);
  });

  let finalized = false;
  const finalize = (exitCode, signal) => {
    if (finalized) return;
    finalized = true;

    timestampedWriter.flush();
    const footer = signal
      ? `npm run dev:start exited via signal ${signal}`
      : `npm run dev:start exited with code ${exitCode ?? 0}`;
    process.stdout.write(prefixedLogLine(footer));
    timestampedWriter.line(footer);

    runLogStream.end();
    latestLogStream.end();

    if (typeof exitCode === "number") {
      process.exit(exitCode);
      return;
    }
    process.exit(signal ? 1 : 0);
  };

  child.on("error", (error) => {
    const message = `Failed to start npm run dev:start: ${error.message}`;
    process.stderr.write(prefixedLogLine(message));
    timestampedWriter.line(message);
    finalize(1);
  });

  child.on("close", (code, signal) => {
    finalize(code ?? undefined, signal ?? undefined);
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal);
    });
  }
}
