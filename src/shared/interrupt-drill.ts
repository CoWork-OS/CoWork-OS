/**
 * `cowork drill interrupt` (agent-first roadmap WP10): start a task, stop it halfway, and show
 * what actually changed. These are pure functions over a task's events, its contract and its
 * replay result, so the same report comes from a live run and from a recorded fixture.
 */

export interface DrillTaskEvent {
  type?: string;
  legacyType?: string;
  payload?: Record<string, unknown> | null;
  timestamp?: number;
}

export interface DrillRequirement {
  id: string;
  description: string;
  status: string;
  required?: boolean;
}

export interface DrillWait {
  kind: string;
  reason?: string;
}

/** A call that was running when the task stopped (`agent_interrupt_confirmed.inFlight`). */
export interface DrillInFlightCall {
  toolName: string;
  outcome: string;
  effect?: string;
  target?: string;
  idempotencyKey?: string;
}

export interface InterruptDrillInput {
  taskId: string;
  events: DrillTaskEvent[];
  requirements?: DrillRequirement[];
  /** Waits still open after the stop (approvals, input, reconnects). */
  waits?: DrillWait[];
  /** The replay evaluator's verdict, when it was run. */
  replay?: { replayStatus?: string; pendingWaitCount?: number; findings?: string[] };
}

export interface InterruptDrillReport {
  taskId: string;
  /** The runtime confirmed the stop (`agent_interrupt_confirmed`). */
  interrupted: boolean;
  status?: string;
  requirements: DrillRequirement[];
  filesChanged: string[];
  inFlight: DrillInFlightCall[];
  pendingWaits: DrillWait[];
  replayStatus?: string;
  findings: string[];
  resume: string[];
}

/** What a fixture expects; only the fields it names are checked. */
export interface InterruptDrillExpectation {
  interrupted?: boolean;
  status?: string;
  filesChanged?: string[];
  inFlight?: Array<Pick<DrillInFlightCall, "toolName" | "outcome"> & { target?: string }>;
  pendingWaits?: number;
  replayStatus?: string;
  findings?: string[];
  requirementStatuses?: Record<string, string>;
}

/** A recorded drill: the events of a stopped task, or a prompt to run live. */
export interface InterruptDrillFixture {
  id: string;
  description?: string;
  /** Live runs: the task prompt, and how many tool calls to let through before stopping. */
  prompt?: string;
  interruptAfterToolCalls?: number;
  /** Replay runs: a stopped task as recorded. */
  taskId?: string;
  events?: DrillTaskEvent[];
  requirements?: DrillRequirement[];
  waits?: DrillWait[];
  expected?: InterruptDrillExpectation;
}

const FILE_EVENT_TYPES = new Set(["file_created", "file_modified", "file_deleted"]);

/** The event's own type; timeline events carry the original in `legacyType`. */
export function drillEventType(event: DrillTaskEvent): string {
  const nested = event.payload?.legacyType;
  return String(event.legacyType || (typeof nested === "string" ? nested : "") || event.type || "");
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function inFlightFrom(payload: Record<string, unknown> | null | undefined): DrillInFlightCall[] {
  const list = Array.isArray(payload?.inFlight) ? (payload!.inFlight as unknown[]) : [];
  return list.flatMap((entry) => {
    const call = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
    const toolName = text(call?.toolName);
    if (!call || !toolName) return [];
    return [
      {
        toolName,
        outcome: text(call.outcome) ?? "unknown",
        ...(text(call.effect) ? { effect: text(call.effect) } : {}),
        ...(text(call.target) ? { target: text(call.target) } : {}),
        ...(text(call.idempotencyKey) ? { idempotencyKey: text(call.idempotencyKey) } : {}),
      },
    ];
  });
}

export function buildInterruptDrillReport(input: InterruptDrillInput): InterruptDrillReport {
  let interrupted = false;
  let status: string | undefined;
  let inFlight: DrillInFlightCall[] = [];
  const files = new Set<string>();
  for (const event of input.events) {
    const type = drillEventType(event);
    if (type === "agent_interrupt_confirmed") {
      interrupted = true;
      inFlight = inFlightFrom(event.payload);
      status = text(event.payload?.status) ?? status;
    } else if (FILE_EVENT_TYPES.has(type)) {
      const filePath = text(event.payload?.path) ?? text(event.payload?.filePath);
      if (filePath) files.add(filePath);
    } else if (type === "task_cancelled" || type === "task_completed" || type === "task_failed") {
      status = type.replace(/^task_/, "");
    }
  }
  const findings = input.replay?.findings ?? [];
  return {
    taskId: input.taskId,
    interrupted,
    ...(status ? { status } : {}),
    requirements: input.requirements ?? [],
    filesChanged: [...files].sort(),
    inFlight,
    pendingWaits: input.waits ?? [],
    ...(input.replay?.replayStatus ? { replayStatus: input.replay.replayStatus } : {}),
    findings,
    resume: [
      `cowork handoff export --task ${input.taskId}`,
      "cowork handoff import <package folder> --environment <environmentId> --dry-run",
    ],
  };
}

/** The report as terminal lines. */
export function renderInterruptDrillReport(report: InterruptDrillReport): string[] {
  const lines = [
    `Interrupt drill for task ${report.taskId}`,
    `  Stop confirmed: ${report.interrupted ? "yes" : "no"}${report.status ? ` (${report.status})` : ""}`,
  ];
  if (report.replayStatus) lines.push(`  Replay status: ${report.replayStatus}`);
  lines.push(
    report.requirements.length > 0
      ? "  Contract requirements:"
      : "  Contract requirements: none recorded",
  );
  for (const requirement of report.requirements) {
    lines.push(`    - [${requirement.status}] ${requirement.description}`);
  }
  lines.push(
    report.filesChanged.length > 0
      ? `  Files changed (${report.filesChanged.length}): ${report.filesChanged.join(", ")}`
      : "  Files changed: none",
  );
  if (report.inFlight.length === 0) {
    lines.push("  Calls in flight at the stop: none");
  } else {
    lines.push("  Calls in flight at the stop (check these before retrying):");
    for (const call of report.inFlight) {
      lines.push(
        `    - ${call.toolName}${call.target ? ` on ${call.target}` : ""}: outcome ${call.outcome}` +
          (call.idempotencyKey ? ` (idempotency key ${call.idempotencyKey})` : ""),
      );
    }
  }
  lines.push(
    report.pendingWaits.length > 0
      ? `  Pending waits: ${report.pendingWaits.map((wait) => wait.reason || wait.kind).join("; ")}`
      : "  Pending waits: none",
  );
  if (report.findings.length > 0) lines.push(`  Replay findings: ${report.findings.join(", ")}`);
  lines.push("  To resume elsewhere:", ...report.resume.map((command) => `    ${command}`));
  return lines;
}

/** Differences between a report and what a fixture expects; empty when it matches. */
export function compareInterruptDrill(
  report: InterruptDrillReport,
  expected: InterruptDrillExpectation,
): string[] {
  const problems: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (expected.interrupted !== undefined && report.interrupted !== expected.interrupted) {
    problems.push(`interrupted: expected ${expected.interrupted}, got ${report.interrupted}`);
  }
  if (expected.status !== undefined && report.status !== expected.status) {
    problems.push(`status: expected ${expected.status}, got ${report.status ?? "none"}`);
  }
  if (expected.filesChanged && !same(report.filesChanged, [...expected.filesChanged].sort())) {
    problems.push(`filesChanged: expected ${JSON.stringify(expected.filesChanged)}`);
  }
  if (expected.inFlight) {
    const actual = report.inFlight.map((call) => ({
      toolName: call.toolName,
      outcome: call.outcome,
      ...(call.target ? { target: call.target } : {}),
    }));
    if (!same(actual, expected.inFlight)) {
      problems.push(`inFlight: expected ${JSON.stringify(expected.inFlight)}`);
    }
  }
  if (expected.pendingWaits !== undefined && report.pendingWaits.length !== expected.pendingWaits) {
    problems.push(
      `pendingWaits: expected ${expected.pendingWaits}, got ${report.pendingWaits.length}`,
    );
  }
  if (expected.replayStatus !== undefined && report.replayStatus !== expected.replayStatus) {
    problems.push(
      `replayStatus: expected ${expected.replayStatus}, got ${report.replayStatus ?? "none"}`,
    );
  }
  if (expected.findings && !same(report.findings, expected.findings)) {
    problems.push(`findings: expected ${JSON.stringify(expected.findings)}`);
  }
  for (const [id, status] of Object.entries(expected.requirementStatuses ?? {})) {
    const actual = report.requirements.find((requirement) => requirement.id === id)?.status;
    if (actual !== status)
      problems.push(`requirement ${id}: expected ${status}, got ${actual ?? "none"}`);
  }
  return problems;
}
