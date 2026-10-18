/**
 * `cowork drill interrupt <fixture>` (agent-first roadmap WP10): start a task, stop it halfway,
 * and print what actually changed: contract requirements and their status, files changed, calls
 * in flight at the stop with their outcome, waits still open, and how to resume. A fixture with
 * recorded events replays without a daemon; `--live` runs its prompt through the control plane.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  buildInterruptDrillReport,
  drillEventType,
  type DrillTaskEvent,
  type InterruptDrillFixture,
  type InterruptDrillReport,
} from "../shared/interrupt-drill";

export interface DrillClient {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
}

export const DRILL_METHODS = {
  TASK_CREATE: "task.create",
  TASK_EVENTS: "task.events",
  TASK_CANCEL: "task.cancel",
  CONTRACT_GET: "workSession.contract.get",
  REPLAY_EVALUATE: "workSession.replay.evaluate",
} as const;

const TERMINAL_TYPES = new Set(["task_completed", "task_failed", "task_cancelled"]);
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_MS = 1_000;

type Payload = Record<string, unknown>;

function asRecord(value: unknown): Payload {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Payload) : {};
}

/** A fixture by path, or by name under `scripts/qa/drills/` in the current checkout. */
export async function loadDrillFixture(
  nameOrPath: string,
  cwd = process.cwd(),
): Promise<InterruptDrillFixture> {
  const candidates = nameOrPath.endsWith(".json")
    ? [path.resolve(cwd, nameOrPath)]
    : [path.resolve(cwd, "scripts", "qa", "drills", `${nameOrPath}.json`)];
  for (const candidate of candidates) {
    let raw: string;
    try {
      raw = await fs.readFile(candidate, "utf8");
    } catch {
      continue;
    }
    const fixture = JSON.parse(raw) as InterruptDrillFixture;
    if (typeof fixture?.id !== "string" || !fixture.id) {
      throw new Error(`Drill fixture ${candidate} has no id.`);
    }
    if (!Array.isArray(fixture.events) && typeof fixture.prompt !== "string") {
      throw new Error(`Drill fixture ${candidate} needs recorded events or a prompt.`);
    }
    return fixture;
  }
  throw new Error(`Drill fixture not found: ${candidates.join(", ")}`);
}

/** The report for a recorded stop, with no daemon involved. */
export function replayInterruptDrill(fixture: InterruptDrillFixture): InterruptDrillReport {
  if (!Array.isArray(fixture.events)) {
    throw new Error(`Drill fixture ${fixture.id} has no recorded events; run it with --live.`);
  }
  return buildInterruptDrillReport({
    taskId: fixture.taskId || `drill-${fixture.id}`,
    events: fixture.events,
    ...(fixture.requirements ? { requirements: fixture.requirements } : {}),
    ...(fixture.waits ? { waits: fixture.waits } : {}),
  });
}

async function taskEvents(client: DrillClient, taskId: string): Promise<DrillTaskEvent[]> {
  const result = asRecord(await client.request(DRILL_METHODS.TASK_EVENTS, { taskId, limit: 500 }));
  return Array.isArray(result.events) ? (result.events as DrillTaskEvent[]) : [];
}

/**
 * Run the fixture's prompt as a real task, stop it after `interruptAfterToolCalls` tool calls,
 * and read back what the runtime recorded. Needs a running daemon and a configured model.
 */
export async function runLiveInterruptDrill(
  client: DrillClient,
  input: {
    workspaceId: string;
    fixture: InterruptDrillFixture;
    timeoutMs?: number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<InterruptDrillReport> {
  const { fixture } = input;
  if (typeof fixture.prompt !== "string" || !fixture.prompt.trim()) {
    throw new Error(`Drill fixture ${fixture.id} has no prompt to run live.`);
  }
  const sleep = input.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const now = input.now ?? Date.now;
  const pollMs = input.pollMs ?? DEFAULT_POLL_MS;
  const deadline = now() + (input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const created = asRecord(
    await client.request(
      DRILL_METHODS.TASK_CREATE,
      {
        workspaceId: input.workspaceId,
        title: `Interrupt drill: ${fixture.id}`,
        prompt: fixture.prompt,
      },
      30_000,
    ),
  );
  const taskId = String(created.taskId || asRecord(created.task).id || "");
  if (!taskId) throw new Error("The daemon did not return a task id.");

  const stopAfter = Math.max(1, Math.floor(fixture.interruptAfterToolCalls ?? 1));
  let events = await taskEvents(client, taskId);
  const count = (type: string) => events.filter((event) => drillEventType(event) === type).length;
  const ended = () => events.some((event) => TERMINAL_TYPES.has(drillEventType(event)));
  while (count("tool_call") < stopAfter && !ended() && now() < deadline) {
    await sleep(pollMs);
    events = await taskEvents(client, taskId);
  }
  if (!ended()) {
    await client.request(DRILL_METHODS.TASK_CANCEL, { taskId });
    while (count("agent_interrupt_confirmed") === 0 && !ended() && now() < deadline) {
      await sleep(pollMs);
      events = await taskEvents(client, taskId);
    }
  }

  const contract = asRecord(
    await client.request(DRILL_METHODS.CONTRACT_GET, { taskId }).catch(() => null),
  );
  const replay = asRecord(
    asRecord(await client.request(DRILL_METHODS.REPLAY_EVALUATE, { taskId }).catch(() => null))
      .result,
  );
  return buildInterruptDrillReport({
    taskId,
    events,
    ...(Array.isArray(contract.requirements)
      ? { requirements: contract.requirements as InterruptDrillReport["requirements"] }
      : {}),
    ...(Array.isArray(contract.pendingWaits)
      ? { waits: contract.pendingWaits as InterruptDrillReport["pendingWaits"] }
      : {}),
    ...(Object.keys(replay).length > 0
      ? {
          replay: {
            ...(typeof replay.replayStatus === "string"
              ? { replayStatus: replay.replayStatus }
              : {}),
            findings: Array.isArray(replay.findings) ? (replay.findings as string[]) : [],
          },
        }
      : {}),
  });
}
