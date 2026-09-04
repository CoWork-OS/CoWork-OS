/* eslint-disable no-console */

const crypto = require("crypto");

const TERMINAL_STATUS = {
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

const WAIT_EVENT_TYPES = new Set([
  "approval_requested",
  "input_request_created",
  "verification_pending_user_action",
  "task_paused",
  "task_interrupted",
  "auto_continuation_blocked",
  "follow_up_turn_recovery_blocked",
  "safety_stop_triggered",
  "mode_gate_blocked",
  "reconnect_requested",
  "child_wait",
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

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isRedacted(value) {
  const normalized = text(value).toLowerCase();
  return normalized === "[redacted]" || normalized.includes("redacted") || normalized === "***";
}

function containsCredentialLeak(value, key = "") {
  if (typeof value === "string") {
    if (isRedacted(value)) return false;
    if (SECRET_VALUE.test(value)) return true;
    if (
      !/(?:api[_-]?key|authorization|cookie|credential|password|private[_-]?key|secret|token)/i.test(
        key,
      )
    )
      return false;
    return !NON_SECRET_SECURITY_MARKERS.has(value.trim().toLowerCase());
  }
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => containsCredentialLeak(entry, key));
  return Object.entries(value).some(([entryKey, entryValue]) =>
    containsCredentialLeak(entryValue, entryKey),
  );
}

function payloadForEvent(event) {
  const payload = event && event.payload && typeof event.payload === "object" ? event.payload : {};
  return payload && payload.payload && typeof payload.payload === "object"
    ? { ...payload, ...payload.payload }
    : payload;
}

function typeForEvent(event) {
  const payload = payloadForEvent(event);
  return (
    text(event.legacyType || payload.eventType || payload.event || event.type) || "legacy_event"
  );
}

function requestIdentity(payload) {
  for (const candidate of [
    payload && payload.requestId,
    payload && payload.approvalId,
    payload && payload.inputRequestId,
    payload && payload.approvalRequestId,
  ]) {
    const value = text(candidate);
    if (value) return value;
  }
  for (const key of ["approval", "request", "inputRequest"]) {
    const nested = payload && payload[key];
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) continue;
    const value = text(nested.id);
    if (value) return value;
  }
  return "";
}

function uniquePush(list, value) {
  if (value && !list.includes(value)) list.push(value);
}

function remove(list, value) {
  const index = list.indexOf(value);
  if (index >= 0) list.splice(index, 1);
}

function newState() {
  return {
    status: "pending",
    lastSequence: 0,
    itemCount: 0,
    pendingWaits: [],
    pendingChildren: [],
    failedChildren: [],
    approvals: [],
    revokedPolicy: false,
    verificationSeen: false,
    sideEffects: [],
    findings: [],
    changedPaths: [],
    observedText: [],
  };
}

function reduce(state, event, sequence) {
  const next = {
    ...state,
    pendingWaits: [...state.pendingWaits],
    pendingChildren: [...state.pendingChildren],
    failedChildren: [...state.failedChildren],
    approvals: [...state.approvals],
    sideEffects: [...state.sideEffects],
    findings: [...state.findings],
    changedPaths: [...state.changedPaths],
    observedText: [...state.observedText],
    itemCount: state.itemCount + 1,
    lastSequence: sequence,
  };
  if (sequence <= state.lastSequence)
    uniquePush(next.findings, `non_monotonic_sequence:${sequence}`);

  const type = typeForEvent(event);
  const payload = payloadForEvent(event);
  if (containsCredentialLeak(payload)) uniquePush(next.findings, "credential_leak");

  // Assertions must be evaluated against replay evidence, never against the
  // mutable task snapshot. Keep a bounded textual projection so a malformed
  // event cannot make a deterministic evaluator retain unbounded payloads.
  const evidence = `${type} ${JSON.stringify(payload)}`.slice(0, 2048);
  if (evidence && next.observedText.length < 512) uniquePush(next.observedText, evidence);

  for (const path of [
    payload.path,
    payload.from,
    payload.to,
    payload.outputPath,
    payload.filePath,
  ]) {
    if (typeof path === "string" && path.trim())
      uniquePush(next.changedPaths, path.trim().replace(/\\/g, "/"));
  }

  const requestId = requestIdentity(payload);
  const isApprovalOrInputItem = event.kind === "approval" || event.kind === "input_request";
  if (isApprovalOrInputItem || WAIT_EVENT_TYPES.has(type)) {
    if (type.endsWith("granted") || type.endsWith("resolved")) {
      remove(next.pendingWaits, requestId);
    } else if (type.endsWith("denied") || type.endsWith("cancelled")) {
      remove(next.pendingWaits, requestId);
    } else {
      uniquePush(next.pendingWaits, requestId || `${type}:${sequence}`);
    }
  }
  if (
    WAIT_EVENT_TYPES.has(type) &&
    !type.endsWith("granted") &&
    !type.endsWith("resolved") &&
    !type.endsWith("denied") &&
    !type.endsWith("cancelled")
  ) {
    next.status = "waiting";
  }
  if (["approval_granted", "approval_approved"].includes(type)) {
    remove(next.pendingWaits, requestId);
    uniquePush(next.approvals, requestId || `approval:${sequence}`);
  }
  if (["approval_denied", "approval_cancelled", "policy_revoked"].includes(type)) {
    remove(next.pendingWaits, requestId);
    remove(next.approvals, requestId);
  }
  if (["input_response", "wait_resolved", "reconnect_succeeded", "task_resumed"].includes(type)) {
    if (type === "task_resumed" && !requestId) {
      next.pendingWaits = next.pendingWaits.filter(
        (wait) => !LIFECYCLE_WAIT_PREFIXES.some((prefix) => wait.startsWith(prefix)),
      );
    } else {
      remove(next.pendingWaits, requestId);
    }
    remove(next.approvals, requestId);
  }
  if (
    REPLAY_RESUME_EVENT_TYPES.has(type) &&
    !["completed", "partial_success", "failed", "cancelled"].includes(next.status)
  ) {
    next.status = next.pendingWaits.length > 0 ? "waiting" : "executing";
  }

  if (type === "policy_revoked" || type === "permission_revoked") {
    next.revokedPolicy = true;
    next.approvals.length = 0;
  }
  if (type === "verification_passed" || type === "verification_completed")
    next.verificationSeen = true;

  const childId = text(payload.childSessionId || payload.childTaskId);
  if (type === "child_started" || type === "child_session_started")
    uniquePush(next.pendingChildren, childId || `child:${sequence}`);
  if (["child_completed", "child_session_completed"].includes(type)) {
    const resolved = childId || `child:${sequence}`;
    remove(next.pendingChildren, resolved);
    if (text(payload.outcome).toLowerCase() === "failed") uniquePush(next.failedChildren, resolved);
  }
  if (["child_failed", "child_session_failed"].includes(type)) {
    const failed = childId || `child:${sequence}`;
    remove(next.pendingChildren, failed);
    uniquePush(next.failedChildren, failed);
  }

  const isSideEffect =
    (event.kind === "tool_call" || type === "side_effect") &&
    (payload.sideEffect === true || payload.externalSideEffect === true || type === "side_effect");
  if (isSideEffect) {
    const key =
      text(payload.sideEffectKey || payload.operationKey || payload.idempotencyKey) ||
      `${type}:${sequence}`;
    if (next.sideEffects.includes(key)) uniquePush(next.findings, `duplicate_side_effect:${key}`);
    else next.sideEffects.push(key);
    const approved =
      payload.approved === true ||
      payload.authorized === true ||
      text(payload.policyDecision).toLowerCase() === "allow" ||
      (requestId && next.approvals.includes(requestId));
    if (next.revokedPolicy || !approved) uniquePush(next.findings, `authorization_bypass:${key}`);
  }

  const terminalStatus = terminalStatusForEvent(type, payload);
  if (terminalStatus) {
    next.status = terminalStatus;
    if (next.status === "completed") {
      if (next.pendingWaits.length) uniquePush(next.findings, "false_success:pending_wait");
      if (next.pendingChildren.length) uniquePush(next.findings, "false_success:pending_child");
      if (next.failedChildren.length) uniquePush(next.findings, "false_success:failed_child");
      if (payload.requiredVerification === true && !next.verificationSeen) {
        uniquePush(next.findings, "false_success:verification_missing");
      }
    }
  }
  return next;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, stable(nested)]),
    );
  }
  return value;
}

function checksum(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}

function projectionState(state) {
  const { findings: _findings, ...projection } = state;
  return projection;
}

function normalizeReplayTerminalStatus(value) {
  const normalized = text(value).toLowerCase();
  if (normalized === "ok") return "completed";
  if (["waiting", "paused", "blocked", "needs_user_action", "awaiting_approval", "awaiting_verification"].includes(normalized)) {
    return "waiting";
  }
  if (normalized === "resume_available") return "partial_success";
  if (["completed", "partial_success", "failed", "cancelled"].includes(normalized)) {
    return normalized;
  }
  return null;
}

function terminalStatusForEvent(type, payload) {
  const explicit = normalizeReplayTerminalStatus(
    payload && (payload.terminalStatus || payload.terminal_status),
  );
  if (explicit) return explicit;
  const eventStatus = normalizeReplayTerminalStatus(payload && payload.status);
  if (eventStatus && (type === "task_status" || type === "task_completed")) return eventStatus;
  return TERMINAL_STATUS[type] || null;
}

function replayEvents(events) {
  const ordered = [...events].sort(
    (left, right) =>
      Number(left.seq || left.sequence || 0) - Number(right.seq || right.sequence || 0) ||
      Number(left.timestamp || 0) - Number(right.timestamp || 0) ||
      String(left.id || "").localeCompare(String(right.id || "")),
  );
  return ordered.reduce(
    (state, event, index) => reduce(state, event, Number(event.seq || event.sequence || index + 1)),
    newState(),
  );
}

function evaluateIsolatedEvents(events, { taskRow, assertions } = {}) {
  const ordered = [...events].sort(
    (left, right) =>
      Number(left.seq || left.sequence || 0) - Number(right.seq || right.sequence || 0) ||
      Number(left.timestamp || 0) - Number(right.timestamp || 0) ||
      String(left.id || "").localeCompare(String(right.id || "")),
  );
  const midpoint = Math.ceil(ordered.length / 2);
  let incremental = ordered
    .slice(0, midpoint)
    .reduce(
      (state, event, index) =>
        reduce(state, event, Number(event.seq || event.sequence || index + 1)),
      newState(),
    );
  incremental = ordered
    .slice(midpoint)
    .reduce(
      (state, event, index) =>
        reduce(state, event, Number(event.seq || event.sequence || midpoint + index + 1)),
      incremental,
    );
  const full = replayEvents(ordered);
  const incrementalChecksum = checksum(projectionState(incremental));
  const fullRebuildChecksum = checksum(projectionState(full));
  const failures = [...new Set(full.findings)];
  if (ordered.length === 0) failures.push("missing_replay_items");
  const expectedTerminalStatus = normalizeReplayTerminalStatus(
    assertions && assertions.expectedTerminalStatus,
  );
  if (expectedTerminalStatus && full.status !== expectedTerminalStatus)
    failures.push(`expected terminal_status=${expectedTerminalStatus}, replay=${full.status}`);
  if (taskRow) {
    const snapshotStatus =
      normalizeReplayTerminalStatus(taskRow.terminal_status) ||
      normalizeReplayTerminalStatus(taskRow.status);
    if (snapshotStatus && full.status !== "pending" && snapshotStatus !== full.status) {
      failures.push(
        `snapshot/replay status mismatch: snapshot=${snapshotStatus}, replay=${full.status}`,
      );
    }
  }
  const mustContainAll = Array.isArray(assertions && assertions.mustContainAll)
    ? assertions.mustContainAll
    : [];
  const observedText = full.observedText.join("\n").toLowerCase();
  for (const needle of mustContainAll) {
    if (needle && !observedText.includes(String(needle).toLowerCase())) {
      failures.push(`missing required replay text: "${needle}"`);
    }
  }
  const mustCreatePaths = Array.isArray(assertions && assertions.mustCreatePaths)
    ? assertions.mustCreatePaths
    : [];
  for (const requiredPath of mustCreatePaths) {
    const normalized = String(requiredPath || "").replace(/\\/g, "/");
    if (normalized && !full.changedPaths.some((candidate) => candidate.endsWith(normalized)))
      failures.push(`missing required changed path: "${requiredPath}"`);
  }
  return {
    isolated: true,
    incrementalChecksum,
    fullRebuildChecksum,
    projectionsMatch: incrementalChecksum === fullRebuildChecksum,
    replay: full,
    failures: [...new Set(failures)],
    passed: incrementalChecksum === fullRebuildChecksum && failures.length === 0,
  };
}

function fixtureEvent(id, seq, kind, type, payload = {}) {
  return { id: `${id}:${seq}`, seq, kind, type, payload };
}

function deterministicFixtures() {
  return [
    {
      id: "crash-recovery",
      events: [
        fixtureEvent("crash-recovery", 1, "status", "task_started"),
        fixtureEvent("crash-recovery", 2, "status", "task_interrupted"),
        fixtureEvent("crash-recovery", 3, "status", "task_resumed"),
        fixtureEvent("crash-recovery", 4, "evidence", "verification_passed"),
        fixtureEvent("crash-recovery", 5, "status", "task_completed"),
      ],
    },
    {
      id: "compaction-recovery",
      events: [
        fixtureEvent("compaction-recovery", 1, "compaction", "context_compaction_started"),
        fixtureEvent("compaction-recovery", 2, "compaction", "context_compaction_completed", {
          preserved: true,
        }),
        fixtureEvent("compaction-recovery", 3, "evidence", "verification_passed"),
        fixtureEvent("compaction-recovery", 4, "status", "task_completed"),
      ],
    },
    {
      id: "approval-roundtrip",
      events: [
        fixtureEvent("approval-roundtrip", 1, "approval", "approval_requested", {
          requestId: "approval-1",
        }),
        fixtureEvent("approval-roundtrip", 2, "approval", "approval_granted", {
          requestId: "approval-1",
        }),
        fixtureEvent("approval-roundtrip", 3, "tool_call", "side_effect", {
          requestId: "approval-1",
          sideEffect: true,
          sideEffectKey: "write:report",
          approved: true,
        }),
        fixtureEvent("approval-roundtrip", 4, "tool_result", "tool_result"),
        fixtureEvent("approval-roundtrip", 5, "evidence", "verification_passed"),
        fixtureEvent("approval-roundtrip", 6, "status", "task_completed"),
      ],
    },
    {
      id: "credential-redaction",
      events: [
        fixtureEvent("credential-redaction", 1, "tool_result", "tool_result", {
          credential: "[redacted]",
          authorization: "[redacted]",
        }),
        fixtureEvent("credential-redaction", 2, "evidence", "verification_passed"),
        fixtureEvent("credential-redaction", 3, "status", "task_completed"),
      ],
    },
    {
      id: "policy-revocation",
      events: [
        fixtureEvent("policy-revocation", 1, "approval", "approval_requested", {
          requestId: "approval-2",
        }),
        fixtureEvent("policy-revocation", 2, "approval", "approval_granted", {
          requestId: "approval-2",
        }),
        fixtureEvent("policy-revocation", 3, "status", "policy_revoked"),
        fixtureEvent("policy-revocation", 4, "approval", "approval_denied", {
          requestId: "approval-2",
        }),
        fixtureEvent("policy-revocation", 5, "status", "task_failed"),
      ],
    },
    {
      id: "child-session-join",
      events: [
        fixtureEvent("child-session-join", 1, "status", "child_started", {
          childSessionId: "child-1",
        }),
        fixtureEvent("child-session-join", 2, "status", "child_completed", {
          childSessionId: "child-1",
          outcome: "complete",
        }),
        fixtureEvent("child-session-join", 3, "evidence", "verification_passed"),
        fixtureEvent("child-session-join", 4, "status", "task_completed"),
      ],
    },
  ];
}

function runDeterministicReplayFixtures() {
  return deterministicFixtures().map((fixture) => ({
    fixtureId: fixture.id,
    ...evaluateIsolatedEvents(fixture.events),
  }));
}

module.exports = { evaluateIsolatedEvents, runDeterministicReplayFixtures, deterministicFixtures };
