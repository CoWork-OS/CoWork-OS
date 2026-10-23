const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const script = path.join(__dirname, "run_human_battery.cjs");

function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, output }));
  });
}

test("unsupported human battery refuses configured live hooks before running scenarios", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-legacy-human-battery-"));
  const database = path.join(dir, "sentinel.db");
  const cron = path.join(dir, "cron.json");
  fs.writeFileSync(database, "untouched database sentinel\n");
  fs.writeFileSync(cron, '{"jobs":[]}\n');
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests += 1;
    request.resume();
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end("{}");
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const result = await run([], {
      COWORK_HOOKS_ORIGIN: `http://127.0.0.1:${port}`,
      COWORK_HOOKS_TOKEN: "fixture-token",
      COWORK_DB_PATH: database,
      COWORK_CRON_STORE_PATH: cron,
      COWORK_QA_WORKSPACE_ID: "fixture-workspace",
    });
    assert.equal(result.code, 1, result.output);
    assert.equal(requests, 0, "unsupported QA must not submit tasks or approvals");
    assert.match(result.output, /unsupported.*canonical runtime/i);
    assert.match(result.output, /current runtime coverage: not_executed/i);
    assert.match(result.output, /run_battery\.cjs --fixtures-only/);
    assert.match(result.output, /reminder.*memory.*history.*integration/i);
    assert.equal(fs.readFileSync(database, "utf8"), "untouched database sentinel\n");
    assert.equal(fs.readFileSync(cron, "utf8"), '{"jobs":[]}\n');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy human battery help describes its unexecuted scenario gap", async () => {
  const result = await run(["--help"], {
    COWORK_DB_PATH: path.join(os.tmpdir(), "missing-human-battery-profile", "app.db"),
  });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /current runtime coverage: not_executed/i);
  assert.match(result.output, /not migrated/i);
  assert.doesNotMatch(result.output, /\bPASS\b/);
});
