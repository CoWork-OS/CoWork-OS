// Synthetic local model driving the actual daemon and battery adapter. No paid model calls.
// Run after build:daemon, with --false-completion for the negative candidate case.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");
const runtimeRoot = path.resolve(__dirname, "../..");
const batteryRoot = runtimeRoot;
if (process.platform === "win32")
  throw new Error(
    "This optional native smoke fixture currently requires POSIX process groups; the battery itself supports Windows.",
  );
if (!fs.existsSync(path.join(runtimeRoot, "dist/daemon/daemon/main.js")))
  throw new Error("Run npm run build:daemon before this smoke fixture.");
const { BoundedControlPlaneClient, runScenario } = require(
  path.join(batteryRoot, "scripts/qa/run_battery.cjs"),
);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p03-native-cp-"));
const profile = path.join(dir, "profile");
const workspace = path.join(dir, "workspace");
fs.mkdirSync(profile, { mode: 0o700 });
fs.mkdirSync(workspace, { mode: 0o700 });
const output = path.join(workspace, "native-probe.txt");
const expected = "NATIVE_P03_TOOL_DISPATCH_OK";
const falseCompletion = process.argv.includes("--false-completion");
const evidence = {
  kind: "synthetic model driving actual native Node daemon",
  case: falseCompletion
    ? "reject completion claim without the correct artifact"
    : "write and read back via native tools",
  dir,
  requests: [],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let child,
  client,
  childError,
  rawLog = "",
  writeSent = false,
  readSent = false,
  interrupted = false;
const running = () => child && child.pid && child.exitCode === null && child.signalCode === null;
const provider = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  let input = {};
  try {
    input = JSON.parse(body || "{}");
  } catch {}
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/tags")
    return res.end(
      JSON.stringify({ models: [{ name: "fixture-model:latest", model: "fixture-model:latest" }] }),
    );
  if (req.url !== "/api/chat")
    return res.end(
      JSON.stringify({
        model_info: { "llama.context_length": 32768 },
        details: { family: "llama" },
      }),
    );
  const tools = (input.tools || []).map((t) => t.function?.name);
  const message = { role: "assistant", content: "" };
  if (!falseCompletion && tools.includes("write_file") && !writeSent) {
    writeSent = true;
    message.tool_calls = [
      {
        function: {
          name: "write_file",
          arguments: { path: "native-probe.txt", content: expected },
        },
      },
    ];
  } else if (!falseCompletion && tools.includes("read_file") && !readSent) {
    readSent = true;
    message.tool_calls = [
      { function: { name: "read_file", arguments: { path: "native-probe.txt" } } },
    ];
  } else {
    message.content = "Created native-probe.txt and checked its contents: " + expected;
  }
  evidence.requests.push({
    route: req.url,
    offeredTools: tools.length,
    call: message.tool_calls?.[0]?.function.name || "text",
    number: evidence.requests.length + 1,
  });
  res.end(
    JSON.stringify({
      model: input.model || "fixture-model",
      message,
      done: true,
      done_reason: "stop",
      prompt_eval_count: 20,
      eval_count: 10,
    }),
  );
});
function interrupt() {
  interrupted = true;
  client?.close();
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  }
  provider.closeAllConnections();
}
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
}
(async () => {
  await new Promise((resolve, reject) => {
    provider.once("error", reject);
    provider.listen(0, "127.0.0.1", resolve);
  });
  const port = await freePort();
  child = spawn(
    process.execPath,
    [
      path.join(runtimeRoot, "dist/daemon/daemon/main.js"),
      "--headless",
      "--enable-control-plane",
      "--import-env-settings",
      "--user-data-dir",
      profile,
    ],
    {
      cwd: runtimeRoot,
      detached: true,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: os.tmpdir(),
        LANG: "en_US.UTF-8",
        COWORK_USER_DATA_DIR: profile,
        COWORK_HEADLESS: "1",
        COWORK_CONTROL_PLANE_HOST: "127.0.0.1",
        COWORK_CONTROL_PLANE_PORT: String(port),
        COWORK_IMPORT_ENV_SETTINGS: "1",
        COWORK_LLM_PROVIDER: "ollama",
        OLLAMA_BASE_URL: "http://127.0.0.1:" + provider.address().port,
        OLLAMA_MODEL: "fixture-model",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.once("error", (error) => {
    childError = error;
  });
  child.stdout.on("data", (b) => {
    rawLog += b.toString();
  });
  child.stderr.on("data", (b) => {
    rawLog += b.toString();
  });
  const until = Date.now() + 25000;
  let token;
  while (Date.now() < until) {
    token = rawLog.match(/Control Plane token: (\S+)/)?.[1];
    if (token && rawLog.includes("Control Plane listening:")) break;
    if (interrupted) throw new Error("smoke fixture interrupted");
    if (childError) throw childError;
    if (!running()) throw new Error("daemon exited during startup");
    await sleep(100);
  }
  if (!token) throw new Error("owned daemon startup timeout");
  client = new BoundedControlPlaneClient({
    url: "ws://127.0.0.1:" + port,
    token,
    deviceName: "p03-independent-native-probe",
  });
  await client.connect(Date.now() + 5000);
  const created = await client.request(
    "workspace.create",
    { name: "P03 isolated native acceptance", path: workspace },
    Date.now() + 5000,
  );
  const workspaceId = created.workspace?.id || created.id;
  if (!workspaceId) throw new Error("workspace response has no identity");
  const constrainedClient = {
    request: (method, params, deadline) =>
      client.request(
        method,
        method === "task.create"
          ? {
              ...params,
              shellAccess: false,
              budgetTokens: 5000,
              agentConfig: {
                permissionMode: "bypass_permissions",
                shellAccess: false,
                allowedTools: ["write_file", "read_file", "list_directory"],
                retainMemory: false,
              },
            }
          : params,
        deadline,
      ),
  };
  evidence.result = await runScenario(
    constrainedClient,
    {
      name: "p03-independent-native-text",
      outRel: "native-probe.txt",
      message:
        "Create native-probe.txt containing exactly " +
        expected +
        ". Read it back to check it, then finish. Do not use other files or network tools.",
      verify: (p) => ({
        ok: fs.existsSync(p) && fs.readFileSync(p, "utf8") === expected,
        semanticCheck: "exact file content independently read back",
      }),
    },
    {
      mode: "live",
      workspaceId,
      workspacePath: workspace,
      profileDir: profile,
      runtimePid: child.pid,
      timeoutMs: 45000,
      totalDeadlineAt: Date.now() + 45000,
      pollMs: 100,
      approvalMode: "stop",
      approveTypes: new Set(),
    },
  );
  evidence.artifact = {
    exists: fs.existsSync(output),
    exactContents: fs.existsSync(output) && fs.readFileSync(output, "utf8") === expected,
  };
  evidence.success = falseCompletion
    ? Boolean(!evidence.result.ok && !evidence.artifact.exactContents && !writeSent && !readSent)
    : Boolean(evidence.result.ok && evidence.artifact.exactContents && writeSent && readSent);
  if (!evidence.success) process.exitCode = 1;
})()
  .catch((error) => {
    evidence.error = error.message;
    evidence.success = false;
    process.exitCode = 1;
  })
  .finally(async () => {
    if (client?.ws) client.ws.terminate();
    client?.close();
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
      for (let i = 0; i < 50 && running(); i++) await sleep(100);
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
      for (let i = 0; i < 20 && running(); i++) await sleep(50);
    }
    provider.closeAllConnections();
    await new Promise((r) => provider.close(r));
    evidence.daemon = {
      pid: child?.pid,
      stopped: !running(),
      exitCode: child?.exitCode,
      signalCode: child?.signalCode,
    };
    evidence.artifactAfterShutdown = {
      exists: fs.existsSync(output),
      exactContents: fs.existsSync(output) && fs.readFileSync(output, "utf8") === expected,
    };
    if (
      running() ||
      interrupted ||
      (!falseCompletion && !evidence.artifactAfterShutdown.exactContents)
    ) {
      evidence.success = false;
      process.exitCode = 1;
    }
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    fs.writeFileSync(
      path.join(dir, "runtime.log"),
      rawLog.replace(/(Control Plane token:)\s*\S+/g, "$1 [redacted]"),
      { mode: 0o600 },
    );
    fs.writeFileSync(path.join(dir, "evidence.json"), JSON.stringify(evidence, null, 2), {
      mode: 0o600,
    });
    console.log(JSON.stringify(evidence, null, 2));
  });
