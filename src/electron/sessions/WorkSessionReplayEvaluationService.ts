import type {
  WorkSessionItem,
  WorkSessionItemKind,
  WorkSessionReplayEvaluationResult,
  WorkSessionReplayFixture,
  WorkSessionStatus,
} from "../../shared/types";
import { workSessionProjectionChecksum } from "../database/WorkSessionProjectionRepository";

export interface WorkSessionReplayAssertions {
  expectedTerminalStatus?: string;
  mustContainAll?: string[];
  mustCreatePaths?: string[];
}

export interface WorkSessionReplayEvaluationOptions {
  fixtureId?: string;
  assertions?: WorkSessionReplayAssertions;
}

const TERMINAL_STATUS: Record<string, WorkSessionStatus> = {
  task_completed: "completed",
  follow_up_completed: "completed",
  agent_completed: "completed",
  orchestration_run_completed: "completed",
  pipeline_completed: "completed",
  task_failed: "failed",
  follow_up_failed: "failed",
  agent_failed: "failed",
  orchestration_run_failed: "failed",
  pipeline_failed: "failed",
  "turn.completed": "completed",
  "turn.partial_success": "partial_success",
  "turn.failed": "failed",
  "turn.cancelled": "cancelled",
  task_cancelled: "cancelled",
};

const SECRET_VALUE =
  /(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|bearer\s+[A-Za-z0-9._-]{12,})/i;
const NON_SECRET_SECURITY_MARKERS = new Set([
  "allow",
  "allowed",
  "approve",
  "approved",
  "deny",
  "denied",
  "grant",
  "granted",
  "none",
  "missing",
  "unknown",
  "unconfigured",
]);
const REPLAY_WAIT_EVENT_TYPES = new Set([
  "approval_requested",
  "input_request_created",
  "reconnect_requested",
  "child_wait",
  "task_paused",
  "task_interrupted",
  "verification_pending_user_action",
  "auto_continuation_blocked",
  "follow_up_turn_recovery_blocked",
  "safety_stop_triggered",
  "mode_gate_blocked",
]);
const LIFECYCLE_WAIT_PREFIXES = [
  "task_paused:",
  "task_interrupted:",
  "verification_pending_user_action:",
  "auto_continuation_blocked:",
  "follow_up_turn_recovery_blocked:",
  "safety_stop_triggered:",
  "mode_gate_blocked:",
  "reconnect_requested:",
  "child_wait:",
];
const REPLAY_RESUME_EVENT_TYPES = new Set([
  "task_resumed",
  "approval_granted",
  "approval_approved",
  "input_response",
  "input_request_resolved",
  "input_request_dismissed",
  "reconnect_succeeded",
  "wait_resolved",
]);
const MAX_REPLAY_OBSERVED_TEXT = 512;
const MAX_REPLAY_OBSERVED_TEXT_LENGTH = 2_048;

export interface WorkSessionReplayState {
  status: WorkSessionStatus;
  lastSequence: number;
  itemCount: number;
  pendingWaits: string[];
  pendingChildren: string[];
  failedChildren: string[];
  approvedRequests: string[];
  revokedPolicy: boolean;
  verificationSeen: boolean;
  sideEffects: string[];
  changedPaths: string[];
  observedText: string[];
  credentialLeak: boolean;
  findings: string[];
}

function payloadRecord(item: WorkSessionItem): Record<string, unknown> {
  const raw = item.payload;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const nested = raw.payload;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return { ...raw, ...(nested as Record<string, unknown>) };
  }
  return raw;
}

function eventType(item: WorkSessionItem): string {
  const payload = payloadRecord(item);
  return typeof payload.eventType === "string"
    ? payload.eventType
    : typeof payload.event === "string"
      ? payload.event
      : item.kind;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRedacted(value: unknown): boolean {
  const normalized = text(value).toLowerCase();
  return normalized === "[redacted]" || normalized.includes("redacted") || normalized === "***";
}

function containsCredentialLeak(value: unknown, key = ""): boolean {
  if (typeof value === "string") {
    if (isRedacted(value)) return false;
    if (SECRET_VALUE.test(value)) return true;
    if (
      !/(?:api[_-]?key|authorization|cookie|credential|password|private[_-]?key|secret|token)/i.test(
        key,
      )
    ) {
      return false;
    }
    const normalized = value.trim().toLowerCase();
    return !NON_SECRET_SECURITY_MARKERS.has(normalized);
  }
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => containsCredentialLeak(entry, key));
  return Object.entries(value as Record<string, unknown>).some(([entryKey, entryValue]) =>
    containsCredentialLeak(entryValue, entryKey),
  );
}

function uniquePush(items: string[], value: string): void {
  if (value && !items.includes(value)) items.push(value);
}

function boundedUniquePush(items: string[], value: string, max: number): void {
  if (!value || items.includes(value) || items.length >= max) return;
  items.push(value);
}

function remove(items: string[], value: string): void {
  const index = items.indexOf(value);
  if (index >= 0) items.splice(index, 1);
}

function sideEffectKey(payload: Record<string, unknown>): string | undefined {
  for (const candidate of [payload.sideEffectKey, payload.operationKey, payload.idempotencyKey]) {
    const value = text(candidate);
    if (value) return value;
  }
  return undefined;
}

function requestIdentity(payload: Record<string, unknown>): string {
  const direct = [
    payload.requestId,
    payload.approvalId,
    payload.inputRequestId,
    payload.approvalRequestId,
  ];
  for (const candidate of direct) {
    const value = text(candidate);
    if (value) return value;
  }
  for (const key of ["approval", "request", "inputRequest"]) {
    const nested = payload[key];
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) continue;
    const value = text((nested as Record<string, unknown>).id);
    if (value) return value;
  }
  return "";
}

function normalizePath(value: unknown): string {
  return text(value).replace(/\\/g, "/").replace(/\/+/g, "/");
}

function collectReplayEvidence(
  next: WorkSessionReplayState,
  type: string,
  payload: Record<string, unknown>,
): void {
  for (const candidate of [
    payload.path,
    payload.from,
    payload.to,
    payload.outputPath,
    payload.filePath,
  ]) {
    const path = normalizePath(candidate);
    // These collections are correctness indexes for replay assertions and
    // duplicate-side-effect detection.  Keeping them complete prevents an
    // item after the old 4,096-entry cap from silently evading grading.
    if (path) uniquePush(next.changedPaths, path);
  }

  const evidence = `${type} ${JSON.stringify(payload)}`.slice(0, MAX_REPLAY_OBSERVED_TEXT_LENGTH);
  boundedUniquePush(next.observedText, evidence, MAX_REPLAY_OBSERVED_TEXT);
}

function normalizeReplayTerminalStatus(value: unknown): WorkSessionStatus | undefined {
  const normalized = text(value).toLowerCase();
  if (normalized === "ok" || normalized === "completed") return "completed";
  if (
    normalized === "waiting" ||
    normalized === "paused" ||
    normalized === "blocked" ||
    normalized === "needs_user_action" ||
    normalized === "awaiting_approval" ||
    normalized === "awaiting_verification"
  ) {
    return "waiting";
  }
  if (normalized === "partial_success") return "partial_success";
  if (normalized === "resume_available") return "partial_success";
  if (normalized === "failed") return "failed";
  if (normalized === "cancelled") return "cancelled";
  return undefined;
}

function isTerminalReplayStatus(status: WorkSessionStatus): boolean {
  return (
    status === "completed" ||
    status === "partial_success" ||
    status === "failed" ||
    status === "cancelled"
  );
}

function terminalStatusForEvent(
  type: string,
  payload: Record<string, unknown>,
): WorkSessionStatus | undefined {
  const explicit = normalizeReplayTerminalStatus(payload.terminalStatus || payload.terminal_status);
  if (explicit) return explicit;
  const eventStatus = normalizeReplayTerminalStatus(payload.status);
  if (eventStatus && (type === "task_status" || type === "task_completed")) return eventStatus;
  return TERMINAL_STATUS[type];
}

export function createEmptyWorkSessionReplayState(): WorkSessionReplayState {
  return {
    status: "pending",
    lastSequence: 0,
    itemCount: 0,
    pendingWaits: [],
    pendingChildren: [],
    failedChildren: [],
    approvedRequests: [],
    revokedPolicy: false,
    verificationSeen: false,
    sideEffects: [],
    changedPaths: [],
    observedText: [],
    credentialLeak: false,
    findings: [],
  };
}

/** Pure reducer used by isolated replay and by projection checksum tests. */
export function reduceWorkSessionReplayState(
  state: WorkSessionReplayState,
  item: WorkSessionItem,
): WorkSessionReplayState {
  const next: WorkSessionReplayState = {
    ...state,
    pendingWaits: [...state.pendingWaits],
    pendingChildren: [...state.pendingChildren],
    failedChildren: [...state.failedChildren],
    approvedRequests: [...state.approvedRequests],
    sideEffects: [...state.sideEffects],
    changedPaths: [...state.changedPaths],
    observedText: [...state.observedText],
    findings: [...state.findings],
    lastSequence: Math.max(state.lastSequence, item.sequence),
    itemCount: state.itemCount + 1,
  };
  if (item.sequence <= state.lastSequence) {
    uniquePush(next.findings, `non_monotonic_sequence:${item.sequence}`);
  }

  const type = eventType(item);
  const payload = payloadRecord(item);
  collectReplayEvidence(next, type, payload);
  if (containsCredentialLeak(payload)) next.credentialLeak = true;
  if (next.credentialLeak) uniquePush(next.findings, "credential_leak");

  const requestId = requestIdentity(payload);
  if (
    item.kind === "approval" ||
    item.kind === "input_request" ||
    REPLAY_WAIT_EVENT_TYPES.has(type)
  ) {
    if (type.endsWith("granted") || type.endsWith("resolved")) {
      remove(next.pendingWaits, requestId);
    } else if (type.endsWith("denied") || type.endsWith("cancelled")) {
      remove(next.pendingWaits, requestId);
    } else {
      uniquePush(next.pendingWaits, requestId || `${type}:${item.sequence}`);
    }
  }
  if (
    REPLAY_WAIT_EVENT_TYPES.has(type) &&
    !type.endsWith("granted") &&
    !type.endsWith("resolved") &&
    !type.endsWith("denied") &&
    !type.endsWith("cancelled")
  ) {
    next.status = "waiting";
  }
  if (["approval_granted", "approval_approved"].includes(type)) {
    uniquePush(next.approvedRequests, requestId || `approval:${item.sequence}`);
  }
  if (["approval_denied", "approval_cancelled", "policy_revoked"].includes(type)) {
    remove(next.approvedRequests, requestId);
  }
  if (["task_resumed", "input_response", "reconnect_succeeded", "wait_resolved"].includes(type)) {
    if (type === "task_resumed" && !requestId) {
      for (let index = next.pendingWaits.length - 1; index >= 0; index -= 1) {
        if (LIFECYCLE_WAIT_PREFIXES.some((prefix) => next.pendingWaits[index].startsWith(prefix))) {
          next.pendingWaits.splice(index, 1);
        }
      }
    } else {
      remove(next.pendingWaits, requestId);
    }
  }
  if (REPLAY_RESUME_EVENT_TYPES.has(type) && !isTerminalReplayStatus(next.status)) {
    next.status = next.pendingWaits.length > 0 ? "waiting" : "executing";
  }

  if (type === "verification_passed" || type === "verification_completed") {
    next.verificationSeen = true;
  }
  if (type === "policy_revoked" || type === "permission_revoked") {
    next.revokedPolicy = true;
    next.approvedRequests.length = 0;
  }

  if (type === "child_started" || type === "child_session_started") {
    uniquePush(
      next.pendingChildren,
      text(payload.childSessionId || payload.childTaskId) || `child:${item.sequence}`,
    );
  }
  if (type === "child_completed" || type === "child_session_completed") {
    const childId = text(payload.childSessionId || payload.childTaskId) || `child:${item.sequence}`;
    remove(next.pendingChildren, childId);
    if (text(payload.outcome).toLowerCase() === "failed") uniquePush(next.failedChildren, childId);
  }
  if (type === "child_failed" || type === "child_session_failed") {
    const childId = text(payload.childSessionId || payload.childTaskId) || `child:${item.sequence}`;
    remove(next.pendingChildren, childId);
    uniquePush(next.failedChildren, childId);
  }

  const isSideEffect =
    (item.kind === "tool_call" || type === "side_effect") &&
    (payload.sideEffect === true || payload.externalSideEffect === true || type === "side_effect");
  if (isSideEffect) {
    const key = sideEffectKey(payload) || `${type}:${item.sequence}`;
    if (next.sideEffects.includes(key)) uniquePush(next.findings, `duplicate_side_effect:${key}`);
    else uniquePush(next.sideEffects, key);
    const approved =
      payload.approved === true ||
      payload.authorized === true ||
      text(payload.policyDecision).toLowerCase() === "allow" ||
      (requestId ? next.approvedRequests.includes(requestId) : false);
    if (next.revokedPolicy || !approved) uniquePush(next.findings, `authorization_bypass:${key}`);
  }

  const terminal = terminalStatusForEvent(type, payload);
  if (terminal) {
    next.status = terminal;
    if (terminal === "completed") {
      if (next.pendingWaits.length > 0) uniquePush(next.findings, "false_success:pending_wait");
      if (next.pendingChildren.length > 0) uniquePush(next.findings, "false_success:pending_child");
      if (next.failedChildren.length > 0) uniquePush(next.findings, "false_success:failed_child");
      if (payload.requiredVerification === true && !next.verificationSeen) {
        uniquePush(next.findings, "false_success:verification_missing");
      }
    }
  }
  return next;
}

function projectionState(state: WorkSessionReplayState): Omit<WorkSessionReplayState, "findings"> {
  const { findings: _findings, ...projection } = state;
  return projection;
}

export function replayWorkSessionItems(items: WorkSessionItem[]): WorkSessionReplayState {
  return [...items]
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
    .reduce(reduceWorkSessionReplayState, createEmptyWorkSessionReplayState());
}

export function evaluateIsolatedReplay(
  items: WorkSessionItem[],
  fixtureOrOptions?: string | WorkSessionReplayEvaluationOptions,
  legacyAssertions?: WorkSessionReplayAssertions,
): WorkSessionReplayEvaluationResult {
  const options: WorkSessionReplayEvaluationOptions =
    typeof fixtureOrOptions === "string"
      ? { fixtureId: fixtureOrOptions, assertions: legacyAssertions }
      : fixtureOrOptions || { assertions: legacyAssertions };
  const ordered = [...items].sort(
    (left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id),
  );
  const midpoint = Math.ceil(ordered.length / 2);
  const incremental = ordered
    .slice(0, midpoint)
    .reduce(reduceWorkSessionReplayState, createEmptyWorkSessionReplayState());
  const incrementalFinal = ordered
    .slice(midpoint)
    .reduce(reduceWorkSessionReplayState, incremental);
  const full = replayWorkSessionItems(ordered);
  const incrementalChecksum = workSessionProjectionChecksum(projectionState(incrementalFinal));
  const fullRebuildChecksum = workSessionProjectionChecksum(projectionState(full));
  const findings = [...new Set(full.findings)];
  if (ordered.length === 0) findings.push("missing_replay_items");

  const assertions = options.assertions || {};
  const expectedStatus = normalizeReplayTerminalStatus(assertions.expectedTerminalStatus);
  if (expectedStatus && full.status !== expectedStatus) {
    findings.push(`expected terminal_status=${expectedStatus}, replay=${full.status}`);
  }
  const observedText = full.observedText.join("\n").toLowerCase();
  for (const needle of Array.isArray(assertions.mustContainAll) ? assertions.mustContainAll : []) {
    const normalizedNeedle = text(needle).toLowerCase();
    if (normalizedNeedle && !observedText.includes(normalizedNeedle)) {
      findings.push(`missing required replay text: "${needle}"`);
    }
  }
  for (const requiredPath of Array.isArray(assertions.mustCreatePaths)
    ? assertions.mustCreatePaths
    : []) {
    const normalizedPath = normalizePath(requiredPath);
    if (
      normalizedPath &&
      !full.changedPaths.some((candidate) => candidate.endsWith(normalizedPath))
    ) {
      findings.push(`missing required changed path: "${requiredPath}"`);
    }
  }
  return {
    ...(options.fixtureId ? { fixtureId: options.fixtureId } : {}),
    isolated: true,
    incrementalChecksum,
    fullRebuildChecksum,
    projectionsMatch: incrementalChecksum === fullRebuildChecksum,
    itemCount: ordered.length,
    replayStatus: full.status,
    pendingWaitCount: full.pendingWaits.length,
    findings,
    passed: incrementalChecksum === fullRebuildChecksum && findings.length === 0,
  };
}

function fixtureItem(
  sessionId: string,
  sequence: number,
  kind: WorkSessionItemKind,
  eventType: string,
  payload: Record<string, unknown> = {},
): WorkSessionItem {
  return {
    id: `${sessionId}:item:${sequence}`,
    sessionId,
    turnId: `${sessionId}:turn:1`,
    sequence,
    kind,
    actor: kind === "tool_call" ? "tool" : "agent",
    payload: { eventType, payload },
    redactionClass: "standard",
    createdAt: sequence,
  };
}

export function createDeterministicWorkSessionReplayFixtures(): WorkSessionReplayFixture[] {
  const make = (
    id: string,
    kind: WorkSessionReplayFixture["kind"],
    items: WorkSessionItem[],
    status: WorkSessionStatus = "completed",
  ) => ({
    id,
    kind,
    items,
    expected: { status, pendingWaits: 0, findings: 0 as const },
  });
  return [
    make("crash-recovery", "crash", [
      fixtureItem("crash-recovery", 1, "status", "task_started"),
      fixtureItem("crash-recovery", 2, "status", "task_interrupted", { reason: "crash" }),
      fixtureItem("crash-recovery", 3, "status", "task_resumed"),
      fixtureItem("crash-recovery", 4, "evidence", "verification_passed"),
      fixtureItem("crash-recovery", 5, "status", "task_completed"),
    ]),
    make("compaction-recovery", "compaction", [
      fixtureItem("compaction-recovery", 1, "message", "assistant_message", { text: "checkpoint" }),
      fixtureItem("compaction-recovery", 2, "compaction", "context_compaction_started"),
      fixtureItem("compaction-recovery", 3, "compaction", "context_compaction_completed", {
        preserved: true,
      }),
      fixtureItem("compaction-recovery", 4, "evidence", "verification_passed"),
      fixtureItem("compaction-recovery", 5, "status", "task_completed"),
    ]),
    make("approval-roundtrip", "approval", [
      fixtureItem("approval-roundtrip", 1, "approval", "approval_requested", {
        requestId: "approval-1",
      }),
      fixtureItem("approval-roundtrip", 2, "approval", "approval_granted", {
        requestId: "approval-1",
      }),
      fixtureItem("approval-roundtrip", 3, "tool_call", "side_effect", {
        requestId: "approval-1",
        sideEffect: true,
        sideEffectKey: "write:report",
        approved: true,
      }),
      fixtureItem("approval-roundtrip", 4, "tool_result", "tool_result"),
      fixtureItem("approval-roundtrip", 5, "evidence", "verification_passed"),
      fixtureItem("approval-roundtrip", 6, "status", "task_completed"),
    ]),
    make("credential-redaction", "credential", [
      fixtureItem("credential-redaction", 1, "tool_result", "tool_result", {
        credential: "[redacted]",
        authorization: "[redacted]",
      }),
      fixtureItem("credential-redaction", 2, "evidence", "verification_passed"),
      fixtureItem("credential-redaction", 3, "status", "task_completed"),
    ]),
    make(
      "policy-revocation",
      "policy_revocation",
      [
        fixtureItem("policy-revocation", 1, "approval", "approval_requested", {
          requestId: "approval-2",
        }),
        fixtureItem("policy-revocation", 2, "approval", "approval_granted", {
          requestId: "approval-2",
        }),
        fixtureItem("policy-revocation", 3, "status", "policy_revoked"),
        fixtureItem("policy-revocation", 4, "approval", "approval_denied", {
          requestId: "approval-2",
        }),
        fixtureItem("policy-revocation", 5, "status", "task_failed", { reason: "policy revoked" }),
      ],
      "failed",
    ),
    make("child-session-join", "child_session", [
      fixtureItem("child-session-join", 1, "status", "child_started", {
        childSessionId: "child-1",
      }),
      fixtureItem("child-session-join", 2, "status", "child_completed", {
        childSessionId: "child-1",
        outcome: "complete",
      }),
      fixtureItem("child-session-join", 3, "evidence", "verification_passed"),
      fixtureItem("child-session-join", 4, "status", "task_completed"),
    ]),
  ];
}

export function evaluateDeterministicReplayFixtures(): WorkSessionReplayEvaluationResult[] {
  return createDeterministicWorkSessionReplayFixtures().map((fixture) => {
    const result = evaluateIsolatedReplay(fixture.items, fixture.id);
    const replay = replayWorkSessionItems(fixture.items);
    const expectationFindings: string[] = [];
    if (replay.status !== fixture.expected.status) {
      expectationFindings.push(
        `fixture_expected_status:${fixture.expected.status}:replay=${replay.status}`,
      );
    }
    if (replay.pendingWaits.length !== fixture.expected.pendingWaits) {
      expectationFindings.push(
        `fixture_expected_pending_waits:${fixture.expected.pendingWaits}:replay=${replay.pendingWaits.length}`,
      );
    }
    const findings = [...new Set([...result.findings, ...expectationFindings])];
    return {
      ...result,
      findings,
      passed: result.passed && findings.length === 0,
    };
  });
}
