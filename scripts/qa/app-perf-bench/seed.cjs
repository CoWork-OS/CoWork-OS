// Seeds a disposable CoWork profile shaped like a heavy real profile.
// Run with: ELECTRON_RUN_AS_NODE=1 COWORK_USER_DATA_DIR=<dir> electron seed.cjs <repoRoot>
const path = require("node:path");
const fs = require("node:fs");
const root = process.argv[2];
const dist = (p) => path.join(root, "dist/electron", p);
const { DatabaseManager } = require(dist("electron/database/schema.js"));
const { SecureSettingsRepository } = require(dist("electron/database/SecureSettingsRepository.js"));
const { WorkspaceStore, TaskStore, TaskEventRepository } = require(
  dist("electron/database/repositories.js"),
);
const { normalizeTaskEventToTimelineV2 } = require(dist("shared/timeline-v2.js"));

const WORKSPACES = Number(process.env.SEED_WORKSPACES || 290);
const TASKS = Number(process.env.SEED_TASKS || 1700);

// Deterministic PRNG so every profile is identical.
let seed = 1234567;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const words =
  "the agent reviewed workspace files and updated the plan before running tests then summarized findings with citations for the report draft and next steps".split(
    " ",
  );
const text = (chars) => {
  let out = "";
  while (out.length < chars) out += words[Math.floor(rand() * words.length)] + " ";
  return out.slice(0, chars);
};
const md = (chars) =>
  `## Summary\n\n${text(Math.floor(chars * 0.3))}\n\n- ${text(60)}\n- ${text(60)}\n- ${text(60)}\n\n\`\`\`ts\nconst value = ${JSON.stringify(text(40))};\nexport function run() { return value.length; }\n\`\`\`\n\n${text(Math.floor(chars * 0.5))}`;

// Legacy type mix and payload sizes measured from a heavy real profile.
const MIX = [
  ["step_started", 17, 300],
  ["step_completed", 16, 300],
  ["log", 8, 230],
  ["progress_update", 7, 300],
  ["llm_usage", 7, 300],
  ["tool_result", 7, 12000],
  ["llm_output_budget", 6, 220],
  ["tool_call", 5, 540],
  ["assistant_message", 5, 1400],
  ["user_message", 1, 2200],
  ["step_failed", 1, 550],
  ["command_output", 1, 1500],
];
const MIX_TOTAL = MIX.reduce((s, m) => s + m[1], 0);
const pickType = () => {
  let r = rand() * MIX_TOTAL;
  for (const m of MIX) {
    r -= m[1];
    if (r <= 0) return m;
  }
  return MIX[0];
};

function payloadFor(legacyType, size, i, taskNo) {
  switch (legacyType) {
    case "user_message":
      return { message: text(size) };
    case "assistant_message":
      return { message: md(size) };
    case "tool_call":
      return {
        tool: ["read_file", "run_command", "web_search", "write_file"][i % 4],
        input: { path: `src/module-${i % 50}.ts`, query: text(80) },
        toolUseId: `tu-${taskNo}-${i}`,
      };
    case "tool_result":
      return {
        tool: ["read_file", "run_command", "web_search", "write_file"][i % 4],
        result: { success: true, content: text(size) },
        toolUseId: `tu-${taskNo}-${i - 1}`,
      };
    case "command_output":
      return { command: "npm test", output: text(size), type: "stdout" };
    case "step_started":
    case "step_completed":
    case "step_failed":
      return {
        step: { id: `step-${Math.floor(i / 6)}`, description: text(90) },
        message: text(Math.max(20, size - 150)),
      };
    default:
      return { message: text(size) };
  }
}

// Event-count distribution of tasks that have events (from the real profile).
function eventCountFor(taskIndex) {
  if (taskIndex < 4) return [4500, 3200, 2600, 2000][taskIndex];
  const r = rand();
  if (r < 0.24) return 20 + Math.floor(rand() * 30);
  if (r < 0.65) return 50 + Math.floor(rand() * 150);
  return 200 + Math.floor(rand() * 400);
}

const dbManager = new DatabaseManager();
try {
  const db = dbManager.getDatabase();
  new SecureSettingsRepository(db).save("appearance", {
    themeMode: "light",
    visualTheme: "warm",
    accentColor: "cyan",
    transparencyEffectsEnabled: true,
    uiDensity: "focused",
    timelineVerbosity: "summary",
    devRunLoggingEnabled: false,
    disclaimerAccepted: true,
    onboardingCompleted: true,
    onboardingCompletedAt: new Date().toISOString(),
  });
  const workspaceRepo = new WorkspaceStore(db);
  const taskRepo = new TaskStore(db);
  const eventRepo = new TaskEventRepository(db);
  const base = path.join(process.env.COWORK_USER_DATA_DIR, "workspaces");
  const workspaces = [];
  for (let w = 0; w < WORKSPACES; w++) {
    const wsPath = path.join(base, `ws-${String(w).padStart(3, "0")}`);
    fs.mkdirSync(wsPath, { recursive: true });
    workspaces.push(
      workspaceRepo.create(`Bench workspace ${w}`, wsPath, {
        read: true,
        write: true,
        delete: false,
        network: false,
        shell: false,
      }),
    );
  }
  const now = Date.now();
  let totalEvents = 0;
  const statuses = ["completed", "completed", "completed", "failed", "cancelled"];
  const insertAll = db.transaction(() => {
    for (let t = 0; t < TASKS; t++) {
      // The newest tasks (lowest t) carry the events, like a real profile.
      const hasEvents = t < 500;
      const ws = t < 40 ? workspaces[t % 4] : workspaces[Math.floor(rand() * workspaces.length)];
      const task = taskRepo.create({
        title: t < 4 ? `Bench heavy session ${t + 1}` : `Bench session ${t + 1}: ${text(40)}`,
        prompt: text(300),
        status: statuses[t % statuses.length],
        workspaceId: ws.id,
        source: "manual",
        agentConfig: { executionMode: "execute", allowUserInput: true },
        resultSummary: text(200),
      });
      const created = now - t * 3_600_000;
      db.prepare(
        "UPDATE tasks SET created_at = ?, updated_at = ?, completed_at = ? WHERE id = ?",
      ).run(created, created + 600_000, created + 600_000, task.id);
      if (!hasEvents) continue;
      const count = eventCountFor(t);
      // Conversation turns: a user message, ~60-120 work events with a few assistant
      // replies, and an assistant answer to close the turn (real-profile ratios).
      let turnLeft = 0;
      for (let i = 0; i < count; i++) {
        let picked;
        if (turnLeft <= 0) {
          picked = ["user_message", 0, 800];
          turnLeft = 60 + Math.floor(rand() * 60);
        } else if (turnLeft === 1) {
          picked = ["assistant_message", 0, 1400];
        } else {
          picked = pickType();
          if (picked[0] === "user_message") picked = ["assistant_message", 0, 1400];
        }
        turnLeft--;
        const legacyType = picked[0];
        const size = picked[2];
        const ts = created + i * 250;
        const payload = payloadFor(legacyType, Math.floor(size * (0.5 + rand())), i, t);
        const v2 = normalizeTaskEventToTimelineV2({
          taskId: task.id,
          type: legacyType,
          payload,
          timestamp: ts,
          eventId: `ev-${t}-${i}`,
          seq: i + 1,
        });
        eventRepo.create(v2);
        totalEvents++;
      }
    }
  });
  insertAll();
  const row = db.prepare("SELECT COUNT(*) n, SUM(LENGTH(payload)) b FROM task_events").get();
  console.log(
    JSON.stringify({
      workspaces: WORKSPACES,
      tasks: TASKS,
      events: row.n,
      payloadMb: row.b / 1048576,
    }),
  );
} finally {
  dbManager.close();
}
