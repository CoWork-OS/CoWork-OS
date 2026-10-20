#!/usr/bin/env node
// oxlint-disable typescript/no-require-imports -- This entry point runs as both Node and Electron CommonJS.
// Run after build:electron, build:daemon and build:cli. Every process uses a disposable
// profile. The native Electron check opens only a hidden window, never the user's app/DB.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const assert = require("node:assert/strict");
const repo = path.resolve(__dirname, "../..");
const flag = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const child = process.argv.includes("--child");

async function check(target, workspacePath, native) {
  const tools = path.join(repo, "dist", target, "electron/agent/tools");
  const { GlobTools } = require(path.join(tools, "glob-tools.js"));
  const { GrepTools } = require(path.join(tools, "grep-tools.js"));
  const { readFilesByPatterns } = require(path.join(tools, "read-files.js"));
  const workspace = {
    id: "smoke",
    name: "smoke",
    path: workspacePath,
    createdAt: 0,
    permissions: { read: true, write: false, delete: false },
  };
  const daemon = { logEvent() {} };
  const globTools = new GlobTools(workspace, daemon, "smoke");
  const fileTools = {
    async readFile(file) {
      const content = await fs.promises.readFile(path.resolve(workspacePath, file), "utf8");
      return { content, size: Buffer.byteLength(content) };
    },
  };
  let maxGapMs = 0,
    ticks = 0,
    last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - last);
    last = now;
    ticks++;
  }, 5);
  await new Promise((resolve) => setTimeout(resolve, 30));
  maxGapMs = 0;
  ticks = 0;
  const started = performance.now();
  try {
    const result = await readFilesByPatterns(
      {
        patterns: ["src/**/*.ts", "docs/*.md", "!src/skip.ts"],
        maxResults: 5000,
        maxFiles: 100,
      },
      { globTools, fileTools },
    );
    assert(result.success);
    assert(result.totalMatched >= 100);
    assert(!result.files.some((file) => file.path === "src/skip.ts"));
    const grep = await new GrepTools(workspace, daemon, "smoke").grep({
      pattern: "needle",
      glob: "**/*.ts",
      maxResults: 5,
    });
    assert(grep.success, grep.error);
    assert.equal(grep.matches.length, 5);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert(ticks > 2, "host heartbeat did not run during discovery");
    assert(maxGapMs < (process.env.CI ? 1000 : 250), `host blocked for ${Math.round(maxGapMs)}ms`);
    if (native) {
      const renderer = await native.webContents.executeJavaScript(
        "({ticks: window.ticks, maxPing: window.maxPing})",
      );
      assert(renderer.ticks > 2, "renderer IPC heartbeat did not run");
      assert(
        renderer.maxPing < (process.env.CI ? 1000 : 250),
        `renderer IPC blocked for ${renderer.maxPing}ms`,
      );
      return {
        target,
        runtime: "native-electron",
        elapsedMs: Math.round(performance.now() - started),
        maxHostGapMs: Math.round(maxGapMs),
        ticks,
        renderer,
      };
    }
    return {
      target,
      runtime: process.versions.electron ? "electron-node" : "node",
      elapsedMs: Math.round(performance.now() - started),
      maxHostGapMs: Math.round(maxGapMs),
      ticks,
    };
  } finally {
    clearInterval(timer);
  }
}

if (!child) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-discovery-smoke-"));
  const fixture = path.join(directory, "workspace");
  fs.mkdirSync(path.join(fixture, "docs"), { recursive: true });
  fs.writeFileSync(path.join(fixture, "docs/readme.md"), "needle");
  for (let index = 0; index < 1500; index++) {
    const branch = path.join(fixture, "src", `branch-${index}`);
    fs.mkdirSync(branch, { recursive: true });
    fs.writeFileSync(path.join(branch, "file.ts"), "const needle = true;\n");
  }
  fs.writeFileSync(path.join(fixture, "src/skip.ts"), "needle\n");
  const electron = require("electron");
  try {
    for (const [target, runtime, native] of [
      ["electron", process.execPath, false],
      ["daemon", process.execPath, false],
      ["cli", process.execPath, false],
      ["electron", electron, false],
      ["electron", electron, true],
    ]) {
      const profile = fs.mkdtempSync(path.join(directory, "profile-"));
      const result = spawnSync(
        runtime,
        [__filename, "--child", "--target", target, "--workspace", fixture],
        {
          cwd: repo,
          encoding: "utf8",
          timeout: 45_000,
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: native ? "" : "1",
            COWORK_USER_DATA_DIR: profile,
          },
        },
      );
      assert.equal(result.status, 0, `${target}: ${result.stdout}\n${result.stderr}`);
      process.stdout.write(result.stdout);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
} else if (process.versions.electron && process.env.ELECTRON_RUN_AS_NODE !== "1") {
  const { app, BrowserWindow, ipcMain } = require("electron");
  app.setName("CoWork Discovery Check");
  app.setPath("userData", process.env.COWORK_USER_DATA_DIR);
  if (process.platform === "darwin") app.setActivationPolicy("accessory");
  app
    .whenReady()
    .then(async () => {
      const preload = path.join(process.env.COWORK_USER_DATA_DIR, "preload.cjs");
      fs.writeFileSync(
        preload,
        `const {contextBridge, ipcRenderer} = require('electron'); contextBridge.exposeInMainWorld('ping', () => ipcRenderer.invoke('discovery-ping'));`,
      );
      ipcMain.handle("discovery-ping", () => true);
      const window = new BrowserWindow({
        show: false,
        webPreferences: { preload, backgroundThrottling: false },
      });
      await window.loadURL(
        `data:text/html,${encodeURIComponent(`<script>
      window.ticks = 0; window.maxPing = 0;
      setInterval(async () => { const start = performance.now(); await window.ping(); window.maxPing = Math.max(window.maxPing, performance.now()-start); window.ticks++; }, 10);
    </script>`)}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      const result = await check(flag("--target", "electron"), flag("--workspace"), window);
      process.stdout.write(JSON.stringify(result) + "\n");
      window.destroy();
      app.exit(0);
    })
    .catch((error) => {
      console.error(error);
      app.exit(1);
    });
} else {
  check(flag("--target", "electron"), flag("--workspace")).then(
    (result) => process.stdout.write(JSON.stringify(result) + "\n"),
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
