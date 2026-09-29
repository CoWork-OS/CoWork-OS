/* Local fixed-zero-external-spend Ollama-compatible fixture for adapter smoke cases. */
const http = require("node:http");
const scenario = process.argv[2];
const port = Number(process.argv[3]);
const statsPath = process.argv[4];
const maxRequests = 12;
let chatAttempts = 0;
let admittedRequests = 0;
let rejectedRequests = 0;
let completedResponses = 0;
let inputTokens = 0;
let outputTokens = 0;
let wrote = false;
let read = false;

function writeStats() {
  if (!statsPath) return;
  const usageComplete = admittedRequests > 0 && completedResponses === admittedRequests;
  try {
    require("node:fs").writeFileSync(statsPath, JSON.stringify({
      chatAttempts,
      admittedRequests,
      rejectedRequests,
      completedResponses,
      tokens: usageComplete ? { inputTokens, outputTokens } : null,
      usageStatus: admittedRequests === 0 ? "missing" : usageComplete ? "complete" : "partial",
      externalSpendUsd: 0,
      externalSpendKnown: true,
    }), { mode: 0o600 });
  } catch {}
}

function sendJson(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

const server = http.createServer(async (request, response) => {
  let bodyText = "";
  for await (const chunk of request) {
    bodyText += chunk.toString("utf8");
    if (bodyText.length > 2 * 1024 * 1024) {
      sendJson(response, 413, { error: "fixture request too large" });
      return;
    }
  }
  if (request.url === "/api/tags") {
    sendJson(response, 200, { models: [{ name: "p04-fixture", model: "p04-fixture" }] });
    return;
  }
  if (request.url === "/api/show") {
    sendJson(response, 200, {
      modelfile: "FROM p04-fixture",
      parameters: "",
      model_info: { "llama.context_length": 32768 },
      details: { family: "llama" },
    });
    return;
  }
  if (request.url !== "/api/chat") {
    sendJson(response, 404, { error: "fixture route not found" });
    return;
  }
  chatAttempts += 1;
  if (admittedRequests >= maxRequests) {
    rejectedRequests += 1;
    writeStats();
    sendJson(response, 429, { error: "fixture request cap reached" });
    return;
  }
  admittedRequests += 1;
  writeStats();
  if (scenario === "timeout") {
    const timer = setTimeout(() => sendJson(response, 200, { done: true, message: { role: "assistant", content: "late fixture response" } }), 60000);
    response.on("close", () => clearTimeout(timer));
    return;
  }

  let input = {};
  try {
    input = JSON.parse(bodyText || "{}");
  } catch {
    sendJson(response, 400, { error: "fixture request JSON is invalid" });
    return;
  }
  const offered = Array.isArray(input.tools) ? input.tools.map((tool) => tool && tool.function && tool.function.name).filter(Boolean) : [];
  const message = { role: "assistant", content: "" };
  if (scenario !== "no-proof" && offered.includes("write_file") && !wrote) {
    wrote = true;
    message.tool_calls = [{ function: { name: "write_file", arguments: {
      path: "p04-result.txt",
      content: scenario === "wrong" ? "P04_NATIVE_HARBOR_WRONG" : "P04_NATIVE_HARBOR_OK",
    } } }];
  } else if (scenario !== "no-proof" && offered.includes("read_file") && !read) {
    read = true;
    message.tool_calls = [{ function: { name: "read_file", arguments: { path: "p04-result.txt" } } }];
  } else {
    message.content = scenario === "no-proof"
      ? "Done. I created and checked p04-result.txt."
      : "Done. I created and read p04-result.txt.";
  }
  sendJson(response, 200, {
    model: "p04-fixture",
    message,
    done: true,
    done_reason: "stop",
    prompt_eval_count: 17,
    eval_count: 4,
  });
  completedResponses += 1;
  inputTokens += 17;
  outputTokens += 4;
  writeStats();
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write("P04_PROVIDER_READY " + String(port) + "\n");
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
