#!/usr/bin/env node

/* eslint-disable no-console */
const WebSocket = require("ws");

function usage() {
  console.error(
    [
      "Usage:",
      "  node bin/coworkctl.js [--url <ws://host:port>] [--token <token>] call <method> [paramsJson]",
      "  node bin/coworkctl.js [--url <ws://host:port>] [--token <token>] watch [--event <name>] [--task <taskId>] [--pretty]",
      "  node bin/coworkctl.js [--url <ws://host:port>] [--token <token>] tail <taskId> [--limit <n>] [--pretty]",
      "",
      "Env:",
      "  COWORK_CONTROL_PLANE_URL",
      "  COWORK_CONTROL_PLANE_TOKEN",
      "",
      "Examples:",
      "  node bin/coworkctl.js --token $TOKEN call workspace.list",
      '  node bin/coworkctl.js --token $TOKEN call workspace.create \'{"name":"main","path":"/workspace"}\'',
      "  node bin/coworkctl.js --token $TOKEN call approval.list",
      '  node bin/coworkctl.js --token $TOKEN call task.create \'{"title":"Test","prompt":"Say hi","workspaceId":"<id>"}\'',
      '  node bin/coworkctl.js --token $TOKEN call task.events \'{"taskId":"<id>","limit":200}\'',
      '  node bin/coworkctl.js --token $TOKEN call approval.respond \'{"approvalId":"...","approved":true}\'',
      "  node bin/coworkctl.js --token $TOKEN call config.get",
      "  node bin/coworkctl.js --token $TOKEN call channel.list",
      '  node bin/coworkctl.js --token $TOKEN call channel.create \'{"type":"telegram","name":"telegram","config":{"botToken":"..."},"securityConfig":{"mode":"pairing"}}\'',
      '  node bin/coworkctl.js --token $TOKEN call channel.test \'{"channelId":"..."}\'',
      '  node bin/coworkctl.js --token $TOKEN call channel.enable \'{"channelId":"..."}\'',
      "  node bin/coworkctl.js --token $TOKEN watch --event task.event",
      "  node bin/coworkctl.js --token $TOKEN tail <taskId>",
    ].join("\n"),
  );
}

function getFlagValue(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return undefined;
  const v = argv[idx + 1];
  if (!v || v.startsWith("--")) return undefined;
  return v;
}

function stripFlags(argv, knownFlags) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const spec = knownFlags.get(a);
    if (!spec) {
      out.push(a);
      continue;
    }
    if (spec.hasValue) i += 1; // skip value
    continue;
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const knownFlags = new Map([
    ["--url", { hasValue: true }],
    ["--token", { hasValue: true }],
    ["--device-name", { hasValue: true }],
    ["--event", { hasValue: true }],
    ["--task", { hasValue: true }],
    ["--limit", { hasValue: true }],
    ["--pretty", { hasValue: false }],
  ]);

  const url =
    getFlagValue(argv, "--url") || process.env.COWORK_CONTROL_PLANE_URL || "ws://127.0.0.1:18789";
  const token = getFlagValue(argv, "--token") || process.env.COWORK_CONTROL_PLANE_TOKEN || "";
  const deviceName = getFlagValue(argv, "--device-name") || "coworkctl";
  const eventName = getFlagValue(argv, "--event");
  const taskIdFilter = getFlagValue(argv, "--task");
  const rawLimit = getFlagValue(argv, "--limit");
  const pretty = argv.includes("--pretty");

  const args = stripFlags(argv, knownFlags);
  const cmd = args[0];
  if (!cmd || cmd === "-h" || cmd === "--help") {
    usage();
    process.exitCode = 1;
    return;
  }

  if (cmd !== "call" && cmd !== "watch" && cmd !== "tail") {
    console.error(`Unknown command: ${cmd}`);
    usage();
    process.exitCode = 1;
    return;
  }

  if (!token) {
    console.error("Missing token. Provide --token or set COWORK_CONTROL_PLANE_TOKEN.");
    process.exitCode = 1;
    return;
  }

  const ws = new WebSocket(url);

  const waitForResponse = (id) =>
    new Promise((resolve, reject) => {
      const onMessage = (data) => {
        let frame;
        try {
          frame = JSON.parse(String(data));
        } catch {
          return;
        }
        if (!frame || frame.type !== "res" || frame.id !== id) return;
        ws.off("message", onMessage);
        if (frame.ok) resolve(frame.payload);
        else reject(frame.error || { message: "Request failed" });
      };
      ws.on("message", onMessage);
    });

  const waitForOpen = () =>
    new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

  await waitForOpen();

  // Authenticate.
  ws.send(
    JSON.stringify({
      type: "req",
      id: "1",
      method: "connect",
      params: { token, deviceName },
    }),
  );

  try {
    await waitForResponse("1");
  } catch (err) {
    console.error("Auth failed:", err?.message || err);
    process.exitCode = 1;
    ws.close();
    return;
  }

  if (cmd === "watch") {
    const matches = (frame) => {
      if (!frame || frame.type !== "event") return false;
      if (eventName && frame.event !== eventName) return false;
      if (!taskIdFilter) return true;
      // Common payload pattern: task.event includes payload.taskId
      const payloadTaskId =
        frame.payload && typeof frame.payload.taskId === "string"
          ? frame.payload.taskId
          : undefined;
      return payloadTaskId === taskIdFilter;
    };

    ws.on("message", (data) => {
      let frame;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!matches(frame)) return;
      if (pretty) {
        process.stdout.write(JSON.stringify(frame, null, 2) + "\n");
      } else {
        process.stdout.write(JSON.stringify(frame) + "\n");
      }
    });

    // Keep running until interrupted.
    const onSignal = () => {
      ws.close();
      process.exit(0);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    return;
  }

  if (cmd === "tail") {
    const taskId = args[1];
    if (!taskId) {
      console.error("Missing <taskId>");
      usage();
      process.exitCode = 1;
      ws.close();
      return;
    }

    const limit = rawLimit ? Math.max(1, Math.min(2000, parseInt(rawLimit, 10) || 200)) : 200;

    // Fetch recent history.
    ws.send(
      JSON.stringify({
        type: "req",
        id: "2",
        method: "task.events",
        params: { taskId, limit },
      }),
    );

    try {
      const payload = await waitForResponse("2");
      process.stdout.write(JSON.stringify({ ok: true, payload }, null, pretty ? 2 : 0) + "\n");
    } catch (err) {
      process.stdout.write(JSON.stringify({ ok: false, error: err }, null, 2) + "\n");
      process.exitCode = 1;
      ws.close();
      return;
    }

    // Stream live updates for this task.
    const matches = (frame) => {
      if (!frame || frame.type !== "event") return false;
      if (frame.event !== "task.event") return false;
      const payloadTaskId =
        frame.payload && typeof frame.payload.taskId === "string"
          ? frame.payload.taskId
          : undefined;
      return payloadTaskId === taskId;
    };

    ws.on("message", (data) => {
      let frame;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!matches(frame)) return;
      if (pretty) {
        process.stdout.write(JSON.stringify(frame, null, 2) + "\n");
      } else {
        process.stdout.write(JSON.stringify(frame) + "\n");
      }
    });

    const onSignal = () => {
      ws.close();
      process.exit(0);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    return;
  }

  // call <method>
  const method = args[1];
  if (!method) {
    console.error("Missing <method>");
    usage();
    process.exitCode = 1;
    ws.close();
    return;
  }

  const paramsRaw = args.slice(2).join(" ").trim();
  let params = undefined;
  if (paramsRaw) {
    try {
      params = JSON.parse(paramsRaw);
    } catch (e) {
      console.error("Failed to parse paramsJson as JSON.");
      console.error(`Input: ${paramsRaw}`);
      process.exitCode = 1;
      ws.close();
      return;
    }
  }

  ws.send(
    JSON.stringify({
      type: "req",
      id: "2",
      method,
      ...(params !== undefined ? { params } : {}),
    }),
  );

  try {
    const payload = await waitForResponse("2");
    process.stdout.write(JSON.stringify({ ok: true, payload }, null, 2) + "\n");
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: err }, null, 2) + "\n");
    process.exitCode = 1;
  } finally {
    ws.close();
  }
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});
