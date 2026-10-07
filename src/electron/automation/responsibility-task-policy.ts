import { assertTaskNotStopped } from "./BotWorkControlStore";
import { getAutomationRuntime } from "./AutomationRuntime";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  botResponsibilityRunSchema,
  evaluateResponsibilityOperation,
  type BotResponsibilityRun,
  type ResponsibilityOperation,
} from "../../shared/bot-responsibility";
import { CHANNEL_TYPES } from "../../shared/gateway-channel-types";
import { ChannelHistoryStore } from "../agent/tools/channel-history-sql";
import {
  assertResponsibilityHistoryChannelInstance,
  BotResponsibilityStore,
  readResponsibilityTaskChannelInstance,
  readResponsibilityTaskRun,
} from "./responsibility-store";
import { serviceStatements } from "../database/service-statements";
import { approvalRequestRevisionHash } from "../agent/approval-revision";
import { APPROVAL_REQUEST_TIMEOUT_MS } from "../agent/approval-timeouts";
import { assertApprovalDraftsCurrent } from "../database/approval-drafts";
import { RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID } from "../../shared/approval-draft-presentation";

export type TrustedResponsibilityOperation = ResponsibilityOperation & { effect: "read" | "write" };
export type ResponsibilityActionReviewRun = Pick<
  BotResponsibilityRun,
  "id" | "revision" | "controlVersion" | "workspaceId" | "agentRoleId"
>;
export interface ResponsibilityActionReviewPayload {
  version: 1;
  operation: { connectorId: "workspace_files"; method: "write_file" };
  canonicalPath: string;
  content: string;
  contentSha256: string;
  contentBytes: number;
  responsibilityRun: ResponsibilityActionReviewRun;
  /** Display aid for the reviewer; authority still comes from the exact review. */
  targetGrant?: ResponsibilityReviewTargetGrant;
}
export interface ResponsibilityReviewTargetGrant {
  permitted: boolean;
  grantedTargets: string[];
}
export interface ResponsibilityActionReviewClaimInput {
  taskId: string;
  workspaceId: string;
  workspacePath: string;
  approvalId: string;
  requestRevisionHash: string;
  executionId: string;
  canonicalPath: string;
  contentSha256: string;
  contentBytes: number;
  responsibilityRun: ResponsibilityActionReviewRun;
  runtime: string;
}
export interface ReusableResponsibilityActionReview {
  approvalId: string;
  requestRevisionHash: string;
  baseRevision: { status: "present" | "missing"; path: string; sha256?: string; size?: number };
}
export type ResponsibilityActionReviewOutcome = "committed" | "uncertain";
/** These are native file handlers with known semantics, not model/MCP annotations.
 * Unknown tools stay unavailable until a trusted adapter supplies exact scoping. */
export function fileResponsibilityOperation(
  name: string,
  input: unknown,
  workspacePath: string,
): TrustedResponsibilityOperation | null {
  const effects: Record<string, "read" | "write"> = {
    read_file: "read",
    list_directory: "read",
    write_file: "write",
  };
  if (
    (!Object.hasOwn(effects, name) && name !== "channel_history" && name !== "mailbox_action") ||
    !input ||
    typeof input !== "object"
  )
    return null;
  const params = input as Record<string, unknown>;
  if (name === "channel_history") {
    const channel = typeof params.channel === "string" ? params.channel.trim() : "";
    const chat = typeof params.chat_id === "string" ? params.chat_id.trim() : "";
    if (!CHANNEL_TYPES.some((type) => type === channel) || !chat) return null;
    return { connectorId: `gateway:${channel}`, method: name, resourceId: chat, effect: "read" };
  }
  if (name === "mailbox_action") {
    const action = params.action;
    const accountId = params.account_id;
    if (
      (action !== "list_threads" && action !== "get_thread") ||
      typeof accountId !== "string" ||
      !accountId ||
      accountId !== accountId.trim() ||
      accountId.length > 512
    )
      return null;
    return { connectorId: "mailbox", method: action, resourceId: accountId, effect: "read" };
  }
  const raw = params.path;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const workspaceRoot = path.resolve(workspacePath);
  let relative: string;
  if (path.isAbsolute(raw)) {
    let canonicalRoot: string;
    try {
      canonicalRoot = fs.realpathSync.native(workspaceRoot);
    } catch {
      return null;
    }
    let candidate = path.resolve(raw);
    const suffix: string[] = [];
    let canonicalTarget: string | null = null;
    while (true) {
      try {
        canonicalTarget = path.resolve(fs.realpathSync.native(candidate), ...suffix);
        break;
      } catch {
        const parent = path.dirname(candidate);
        if (parent === candidate) return null;
        suffix.unshift(path.basename(candidate));
        candidate = parent;
      }
    }
    relative = path.relative(canonicalRoot, canonicalTarget);
  } else {
    relative = path.relative(workspaceRoot, path.resolve(workspaceRoot, raw));
  }
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    return null;
  return {
    connectorId: "workspace_files",
    method: name,
    resourceId: relative.split(path.sep).join("/") || ".",
    effect: effects[name],
  };
}

/** Reads persisted lineage for every tool, including ancestors of older tasks.
 * Runs as one services-worker unit; caller input cannot supply a policy revision. */
export function assertResponsibilityTaskPolicy(
  db: Database.Database,
  taskId: string,
  workspaceId: string,
  operation: TrustedResponsibilityOperation | null,
  runtime: string = "node",
  phase: "tool" | "start" = "tool",
  allowSelectedActionReview = false,
): boolean {
  assertTaskNotStopped(db, taskId);
  const store = new BotResponsibilityStore(db);
  const seen = new Set<string>();
  let cursor: string | undefined = taskId;
  let expected: string | undefined;
  let governed = false;
  while (cursor) {
    if (seen.has(cursor) || seen.size >= 64)
      throw new Error("Responsibility task lineage is invalid");
    seen.add(cursor);
    const task = db
      .prepare("SELECT workspace_id,parent_task_id,agent_config FROM tasks WHERE id=?")
      .get(cursor) as
      | { workspace_id: string; parent_task_id: string | null; agent_config: string | null }
      | undefined;
    if (!task) {
      if (expected) throw new Error("Responsibility task lineage is unavailable");
      return governed;
    }

    const config = task.agent_config ? JSON.parse(task.agent_config) : {};
    const durable = readResponsibilityTaskRun(db, cursor);
    const supplied =
      config.responsibilityRun === undefined
        ? undefined
        : botResponsibilityRunSchema.parse(config.responsibilityRun);
    if (durable && supplied && JSON.stringify(durable) !== JSON.stringify(supplied))
      throw new Error("Responsibility task lineage was replaced");
    const ref = durable ?? supplied;
    const binding = ref
      ? store.getForEngine(ref.engine.kind, ref.engine.id)
      : config.automationRoutineId
        ? store.getForEngine("routine", config.automationRoutineId)
        : null;
    if (ref && !binding) throw new Error("Responsibility binding is unavailable");
    if (binding) {
      governed = true;
      if (task.workspace_id !== workspaceId)
        throw new Error("Responsibility task workspace mismatch");
      if (cursor !== taskId && !expected)
        throw new Error("Responsibility child is missing immutable lineage");
      if (!ref) throw new Error("Responsibility task is missing immutable lineage");
      if (ref.revision !== binding.revision)
        throw new Error("Responsibility revision changed or scope mismatch");
      if (binding.state !== "active") throw new Error("Responsibility execution is paused");
      if (
        ref.id !== binding.id ||
        ref.workspaceId !== workspaceId ||
        ref.agentRoleId !== binding.agentRoleId ||
        ref.revision !== binding.revision ||
        ref.controlVersion !== binding.controlVersion
      )
        throw new Error("Responsibility revision changed or scope mismatch");
      const key = JSON.stringify(ref);
      if (expected && expected !== key) throw new Error("Responsibility child scope mismatch");
      expected = key;
      const bot = db
        .prepare("SELECT is_active FROM agent_roles WHERE id=?")
        .get(binding.agentRoleId) as { is_active: number } | undefined;
      if (bot?.is_active !== 1) throw new Error("Responsibility bot is unavailable");
      if (binding.state !== "active") throw new Error("Responsibility execution is paused");
      const issues = store.activationIssues(
        { workspaceId: binding.workspaceId, agentRoleId: binding.agentRoleId },
        binding.definition,
      );
      if (issues.length) throw new Error(issues.join(" "));
      if (binding.definition.backend === "desktop" && runtime !== "desktop")
        throw new Error("Responsibility is waiting for a desktop runtime");
      if (config.externalRuntime)
        throw new Error("Responsibility external runtime has no scope handoff");
      if (phase === "start") {
        cursor = task.parent_task_id ?? undefined;
        continue;
      }
      if (!operation) throw new Error("Responsibility tool has no trusted scope adapter");
      const decision = evaluateResponsibilityOperation({
        definition: binding.definition,
        revision: ref.revision,
        currentRevision: binding.revision,
        active: true,
        operation,
        catalog: [operation],
        currentPolicyAllows: true,
      });
      if (!decision.allowed) {
        const selectedNativeWriteReview =
          allowSelectedActionReview &&
          decision.reason === "review_required" &&
          operation.connectorId === "workspace_files" &&
          operation.method === "write_file" &&
          operation.effect === "write";
        if (!selectedNativeWriteReview)
          throw new Error(`Responsibility tool denied: ${decision.reason}`);
      }
    } else if (expected) throw new Error("Responsibility ancestor lineage mismatch");
    cursor = task.parent_task_id ?? undefined;
  }
  return governed;
}

/** Whether a reviewed write target is one of the responsibility's permitted files. */
export function responsibilityReviewTargetGrantInUnit(
  db: Database.Database,
  taskId: string,
  canonicalPath: string,
): ResponsibilityReviewTargetGrant | null {
  const run = readResponsibilityTaskRun(db, taskId);
  if (!run) return null;
  const current = botResponsibilityRunSchema.safeParse(run);
  if (!current.success) return null;
  const binding = new BotResponsibilityStore(db).getForEngine(
    current.data.engine.kind,
    current.data.engine.id,
  );
  if (!binding) return null;
  const grantedTargets = binding.definition.permittedActions
    .filter((action) => action.connectorId === "workspace_files" && action.method === "write_file")
    .map((action) => action.resourceId)
    .slice(0, 20);
  return { permitted: grantedTargets.includes(canonicalPath), grantedTargets };
}

export async function getResponsibilityReviewTargetGrant(
  db: Database.Database,
  taskId: string,
  canonicalPath: string,
): Promise<ResponsibilityReviewTargetGrant | null> {
  return serviceStatements(db).unit("botResponsibility_reviewTargetGrant", [taskId, canonicalPath]);
}

/**
 * Canonical workspace-relative target for a `write_file` path as the model supplied it
 * (relative or absolute), normalized exactly like the responsibility policy. Null when
 * the path is outside the workspace or names the workspace root.
 */
export function responsibilityWriteReviewTarget(
  rawPath: unknown,
  workspacePath: string,
): string | null {
  const operation = fileResponsibilityOperation("write_file", { path: rawPath }, workspacePath);
  return operation?.resourceId && operation.resourceId !== "." ? operation.resourceId : null;
}

/** Returns a current exact run only for a selected native write covered by the review UI. */
export function responsibilityActionReviewContextInUnit(
  db: Database.Database,
  taskId: string,
  workspaceId: string,
  workspacePath: string,
  canonicalPath: string,
  runtime: string = "node",
): ResponsibilityActionReviewRun | null {
  if (typeof canonicalPath !== "string" || !canonicalPath || canonicalPath.length > 512)
    throw new Error("Invalid responsibility review path");
  const operation = fileResponsibilityOperation(
    "write_file",
    { path: canonicalPath },
    workspacePath,
  );
  if (!operation || operation.resourceId !== canonicalPath)
    throw new Error("Responsibility review target is not a canonical workspace path");
  const governed = assertResponsibilityTaskPolicy(
    db,
    taskId,
    workspaceId,
    operation,
    runtime,
    "tool",
    true,
  );
  if (!governed) return null;
  const run = readResponsibilityTaskRun(db, taskId);
  if (!run) throw new Error("Responsibility review run receipt is unavailable");
  const current = botResponsibilityRunSchema.parse(run);
  const binding = new BotResponsibilityStore(db).getForEngine(
    current.engine.kind,
    current.engine.id,
  );
  if (!binding) throw new Error("Responsibility review binding is unavailable");
  const selected = binding.definition.permittedActions.some(
    (action) =>
      action.connectorId === operation.connectorId &&
      action.method === operation.method &&
      action.resourceId === operation.resourceId,
  );
  const requiresReview =
    binding.definition.mode === "act" &&
    (binding.definition.reviewBoundary === "all_effects" || !selected);
  if (!requiresReview) return null;
  return {
    id: current.id,
    revision: current.revision,
    controlVersion: current.controlVersion,
    workspaceId: current.workspaceId,
    agentRoleId: current.agentRoleId,
  };
}

/** Atomically revalidates the reviewed request and claims its sole write execution. */
export function claimResponsibilityActionReviewInUnit(
  db: Database.Database,
  input: ResponsibilityActionReviewClaimInput,
): boolean {
  const requiredText = (value: unknown, name: string, max: number): string => {
    if (typeof value !== "string" || !value.trim() || value.length > max)
      throw new Error(`Invalid responsibility action review ${name}`);
    return value;
  };
  const taskId = requiredText(input.taskId, "task", 128);
  const workspaceId = requiredText(input.workspaceId, "workspace", 128);
  const workspacePath = requiredText(input.workspacePath, "workspace path", 4096);
  const approvalId = requiredText(input.approvalId, "approval", 128);
  const requestRevisionHash = requiredText(input.requestRevisionHash, "request revision", 64);
  const executionId = requiredText(input.executionId, "execution", 128);
  const canonicalPath = requiredText(input.canonicalPath, "path", 512);
  const contentSha256 = requiredText(input.contentSha256, "content hash", 64);
  if (!/^[0-9a-f]{64}$/.test(requestRevisionHash) || !/^[0-9a-f]{64}$/.test(contentSha256))
    throw new Error("Invalid responsibility action review digest");
  if (
    !Number.isSafeInteger(input.contentBytes) ||
    input.contentBytes < 0 ||
    input.contentBytes > 256000
  )
    throw new Error("Invalid responsibility action review content size");
  const rawRun = input.responsibilityRun as Record<string, unknown> | null;
  if (
    !rawRun ||
    typeof rawRun.id !== "string" ||
    !Number.isSafeInteger(rawRun.revision) ||
    (rawRun.revision as number) < 1 ||
    !Number.isSafeInteger(rawRun.controlVersion) ||
    (rawRun.controlVersion as number) < 0 ||
    typeof rawRun.workspaceId !== "string" ||
    typeof rawRun.agentRoleId !== "string"
  )
    throw new Error("Invalid responsibility action review run");
  // Once a one-time claim exists, no later invocation can consume the same
  // approval again. Check this before re-evaluating live policy: the original
  // task or responsibility may have completed or been paused since the write.
  const existingClaim = db
    .prepare(
      "SELECT task_id, request_revision_hash, execution_id, outcome FROM responsibility_action_review_claims WHERE approval_id = ?",
    )
    .get(approvalId) as
    | {
        task_id: string;
        request_revision_hash: string;
        execution_id: string;
        outcome: string;
      }
    | undefined;
  if (existingClaim)
    return (
      existingClaim.task_id === taskId &&
      existingClaim.request_revision_hash === requestRevisionHash &&
      existingClaim.execution_id === executionId &&
      existingClaim.outcome === "claimed"
    );

  const currentReviewRun = responsibilityActionReviewContextInUnit(
    db,
    taskId,
    workspaceId,
    workspacePath,
    canonicalPath,
    input.runtime,
  );
  if (
    !currentReviewRun ||
    JSON.stringify(currentReviewRun) !== JSON.stringify(input.responsibilityRun)
  )
    throw new Error("Responsibility action review binding changed");

  const row = db
    .prepare(
      "SELECT id, task_id, type, description, details, status, requested_at FROM approvals WHERE id = ?",
    )
    .get(approvalId) as
    | {
        id: string;
        task_id: string;
        type: string;
        description: string;
        details: string;
        status: string;
        requested_at: number;
      }
    | undefined;
  if (!row || row.task_id !== taskId || row.type !== "workspace_write" || row.status !== "approved")
    throw new Error("Responsibility action review approval is unavailable");
  if (
    !Number.isSafeInteger(row.requested_at) ||
    Date.now() >= row.requested_at + APPROVAL_REQUEST_TIMEOUT_MS
  )
    throw new Error("Responsibility action review approval expired");
  let details: Record<string, unknown>;
  try {
    details = JSON.parse(row.details) as Record<string, unknown>;
  } catch {
    throw new Error("Responsibility action review approval is invalid");
  }
  const review = details.responsibilityActionReview as
    | ResponsibilityActionReviewPayload
    | undefined;
  const params = details.params as Record<string, unknown> | undefined;
  const reviewRun = review?.responsibilityRun;
  if (
    details.tool !== "write_file" ||
    params?.path !== canonicalPath ||
    !Array.isArray(details.reviewFiles) ||
    details.reviewFiles.length !== 1 ||
    details.reviewFiles[0] !== canonicalPath ||
    review?.version !== 1 ||
    review.operation?.connectorId !== "workspace_files" ||
    review.operation?.method !== "write_file" ||
    review.canonicalPath !== canonicalPath ||
    typeof review.content !== "string" ||
    review.contentSha256 !== contentSha256 ||
    review.contentBytes !== input.contentBytes ||
    !reviewRun ||
    JSON.stringify({
      id: reviewRun.id,
      revision: reviewRun.revision,
      controlVersion: reviewRun.controlVersion,
      workspaceId: reviewRun.workspaceId,
      agentRoleId: reviewRun.agentRoleId,
    }) !== JSON.stringify(input.responsibilityRun)
  )
    throw new Error("Responsibility action review does not match the proposed write");
  const reviewedBytes = Buffer.from(review.content, "utf8");
  if (
    reviewedBytes.length !== input.contentBytes ||
    reviewedBytes.toString("utf8") !== review.content ||
    createHash("sha256").update(reviewedBytes).digest("hex") !== contentSha256
  )
    throw new Error("Responsibility action review content changed");
  let currentRequestRevision: string;
  try {
    currentRequestRevision = approvalRequestRevisionHash({
      taskId: row.task_id,
      type: row.type as Any,
      description: row.description,
      details,
      requestedAt: row.requested_at,
    });
  } catch {
    throw new Error("Responsibility action review request exceeds the approval limit");
  }
  if (currentRequestRevision !== requestRevisionHash)
    throw new Error("Responsibility action review request changed");
  const approval = {
    id: row.id,
    taskId: row.task_id,
    type: row.type as Any,
    description: row.description,
    details,
    status: row.status as Any,
    requestedAt: row.requested_at,
  };
  const draftRevision = details.draftRevision as Record<string, unknown> | undefined;
  const draftEntries = draftRevision?.entries as Array<Record<string, unknown>> | undefined;
  if (
    draftRevision?.version !== 1 ||
    draftRevision.state !== "bound" ||
    draftRevision.workspaceId !== workspaceId ||
    !Array.isArray(draftEntries) ||
    draftEntries.length !== 1 ||
    draftEntries[0]?.reference !== canonicalPath
  )
    throw new Error("Responsibility action review has no trusted base revision");
  assertApprovalDraftsCurrent(db, approval as Any);

  const decision = db
    .prepare(
      "SELECT action, request_revision_hash FROM responsibility_action_review_decisions WHERE approval_id = ?",
    )
    .get(approvalId) as { action: string; request_revision_hash: string } | undefined;
  if (
    !decision ||
    decision.action !== "allow_once" ||
    decision.request_revision_hash !== requestRevisionHash
  )
    throw new Error("Responsibility action review has no one-time approval decision");

  const claimed = db
    .prepare(
      `INSERT INTO responsibility_action_review_claims
        (approval_id, task_id, request_revision_hash, execution_id, consumed_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(approval_id) DO NOTHING`,
    )
    .run(approvalId, taskId, requestRevisionHash, executionId, Date.now());
  return claimed.changes === 1;
}

/** Finds one exact, explicitly approved inline review whose write was never claimed. */
export function findReusableResponsibilityActionReviewInUnit(
  db: Database.Database,
  taskId: string,
  workspaceId: string,
  workspacePath: string,
  proposed: ResponsibilityActionReviewPayload,
  runtime: string = "node",
): ReusableResponsibilityActionReview | null {
  const currentRun = responsibilityActionReviewContextInUnit(
    db,
    taskId,
    workspaceId,
    workspacePath,
    proposed.canonicalPath,
    runtime,
  );
  if (!currentRun || JSON.stringify(currentRun) !== JSON.stringify(proposed.responsibilityRun))
    return null;

  const rows = db
    .prepare(
      `SELECT a.id, a.task_id, a.type, a.description, a.details, a.status, a.requested_at,
              d.action, d.request_revision_hash,
              l.task_id AS linked_task_id, l.revision_hash AS linked_revision_hash,
              i.status AS input_status, i.questions, i.answers
       FROM approvals a
       JOIN responsibility_action_review_decisions d ON d.approval_id = a.id
       JOIN approval_input_links l ON l.approval_id = a.id
       JOIN input_requests i ON i.id = l.input_id
       LEFT JOIN responsibility_action_review_claims c ON c.approval_id = a.id
       WHERE a.task_id = ? AND a.type = 'workspace_write' AND a.status = 'approved'
         AND d.action = 'allow_once' AND c.approval_id IS NULL
       ORDER BY a.requested_at DESC`,
    )
    .all(taskId) as Array<Record<string, unknown>>;

  const candidates: ReusableResponsibilityActionReview[] = [];
  for (const row of rows) {
    if (
      row.task_id !== taskId ||
      row.linked_task_id !== taskId ||
      row.input_status !== "submitted" ||
      !Number.isSafeInteger(row.requested_at) ||
      Date.now() >= (row.requested_at as number) + APPROVAL_REQUEST_TIMEOUT_MS ||
      typeof row.id !== "string" ||
      typeof row.description !== "string" ||
      typeof row.details !== "string" ||
      typeof row.request_revision_hash !== "string" ||
      row.linked_revision_hash !== row.request_revision_hash
    )
      continue;

    let details: Record<string, unknown>;
    let questions: unknown;
    let answers: unknown;
    try {
      details = JSON.parse(row.details) as Record<string, unknown>;
      questions = JSON.parse(String(row.questions));
      answers = JSON.parse(String(row.answers));
    } catch {
      continue;
    }
    const storedReview = details.responsibilityActionReview as
      | ResponsibilityActionReviewPayload
      | undefined;
    const params = details.params as Record<string, unknown> | undefined;
    const decisionQuestions = questions as Array<Record<string, unknown>>;
    const decisionAnswers = answers as Record<string, Record<string, unknown>>;
    const answer = decisionAnswers?.[RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID];
    const decisionQuestion = decisionQuestions?.[0];
    const options = decisionQuestion?.options as Array<Record<string, unknown>> | undefined;
    if (
      details.tool !== "write_file" ||
      params?.path !== proposed.canonicalPath ||
      !Array.isArray(details.reviewFiles) ||
      details.reviewFiles.length !== 1 ||
      details.reviewFiles[0] !== proposed.canonicalPath ||
      storedReview?.version !== 1 ||
      storedReview.operation?.connectorId !== "workspace_files" ||
      storedReview.operation?.method !== "write_file" ||
      storedReview.canonicalPath !== proposed.canonicalPath ||
      storedReview.content !== proposed.content ||
      storedReview.contentSha256 !== proposed.contentSha256 ||
      storedReview.contentBytes !== proposed.contentBytes ||
      JSON.stringify(storedReview.responsibilityRun) !==
        JSON.stringify(proposed.responsibilityRun) ||
      !Array.isArray(decisionQuestions) ||
      decisionQuestions.length !== 1 ||
      decisionQuestion?.id !== RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID ||
      !Array.isArray(options) ||
      options.length !== 2 ||
      options[0]?.label !== "Deny once" ||
      options[1]?.label !== "Allow once" ||
      Object.keys(decisionAnswers || {}).length !== 1 ||
      answer?.optionLabel !== "Allow once" ||
      Object.keys(answer || {}).some((key) => key !== "optionLabel")
    )
      continue;

    const approval = {
      id: row.id,
      taskId,
      type: "workspace_write" as const,
      description: row.description,
      details,
      status: "approved" as const,
      requestedAt: row.requested_at as number,
    };
    let requestRevisionHash: string;
    try {
      requestRevisionHash = approvalRequestRevisionHash(approval);
      if (requestRevisionHash !== row.request_revision_hash) continue;
      assertApprovalDraftsCurrent(db, approval);
    } catch {
      continue;
    }

    const draftRevision = details.draftRevision as Record<string, unknown> | undefined;
    const entries = draftRevision?.entries as Array<Record<string, unknown>> | undefined;
    const entry = entries?.[0];
    if (
      draftRevision?.version !== 1 ||
      draftRevision.state !== "bound" ||
      draftRevision.workspaceId !== workspaceId ||
      !Array.isArray(entries) ||
      entries.length !== 1 ||
      entry?.reference !== proposed.canonicalPath ||
      (entry.status !== "present" && entry.status !== "missing") ||
      typeof entry.path !== "string" ||
      (entry.status === "present" &&
        (!Number.isSafeInteger(entry.size) ||
          (entry.size as number) < 0 ||
          (entry.size as number) > 4 * 1024 * 1024 ||
          typeof entry.sha256 !== "string" ||
          !/^[0-9a-f]{64}$/.test(entry.sha256)))
    )
      continue;
    candidates.push({
      approvalId: row.id,
      requestRevisionHash,
      baseRevision: {
        status: entry.status,
        path: entry.path,
        ...(entry.status === "present"
          ? { sha256: entry.sha256 as string, size: entry.size as number }
          : {}),
      },
    });
  }
  return candidates.length === 1 ? candidates[0]! : null;
}

/** Pending waits survive restart only while their exact marked request is untouched. */
export function responsibilityActionReviewCanWaitInUnit(
  db: Database.Database,
  approvalId: string,
  taskId: string,
  requestRevisionHash: string,
): boolean {
  const row = db
    .prepare(
      "SELECT task_id,type,details,status,requested_at,description FROM approvals WHERE id=?",
    )
    .get(approvalId) as
    | {
        task_id: string;
        type: string;
        details: string;
        status: string;
        requested_at: number;
        description: string;
      }
    | undefined;
  if (
    !row ||
    row.task_id !== taskId ||
    row.type !== "workspace_write" ||
    row.status !== "pending" ||
    !Number.isSafeInteger(row.requested_at) ||
    Date.now() >= row.requested_at + APPROVAL_REQUEST_TIMEOUT_MS
  )
    return false;
  let details: Record<string, unknown>;
  try {
    details = JSON.parse(row.details) as Record<string, unknown>;
    if (
      approvalRequestRevisionHash({
        taskId,
        type: "workspace_write",
        description: row.description,
        details,
        requestedAt: row.requested_at,
      }) !== requestRevisionHash
    )
      return false;
  } catch {
    return false;
  }
  const review = details.responsibilityActionReview as Record<string, unknown> | undefined;
  if (details.tool !== "write_file" || review?.version !== 1) return false;
  const decision = db
    .prepare("SELECT 1 AS found FROM responsibility_action_review_decisions WHERE approval_id=?")
    .get(approvalId);
  const claim = db
    .prepare("SELECT 1 AS found FROM responsibility_action_review_claims WHERE approval_id=?")
    .get(approvalId);
  return !decision && !claim;
}

export function finishResponsibilityActionReviewInUnit(
  db: Database.Database,
  approvalId: string,
  requestRevisionHash: string,
  executionId: string,
  outcome: ResponsibilityActionReviewOutcome,
): boolean {
  if (
    typeof approvalId !== "string" ||
    !approvalId.trim() ||
    approvalId.length > 128 ||
    typeof executionId !== "string" ||
    !executionId.trim() ||
    executionId.length > 128 ||
    typeof requestRevisionHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(requestRevisionHash) ||
    !["committed", "uncertain"].includes(outcome)
  )
    throw new Error("Invalid responsibility action review outcome");
  const updated = db
    .prepare(
      `UPDATE responsibility_action_review_claims
       SET outcome = ?, committed_at = ?
       WHERE approval_id = ? AND request_revision_hash = ? AND execution_id = ? AND outcome = 'claimed'`,
    )
    .run(
      outcome,
      outcome === "committed" ? Date.now() : null,
      approvalId,
      requestRevisionHash,
      executionId,
    );
  if (updated.changes === 1) return true;
  const existing = db
    .prepare(
      "SELECT outcome, request_revision_hash, execution_id FROM responsibility_action_review_claims WHERE approval_id = ?",
    )
    .get(approvalId) as
    | { outcome: string; request_revision_hash: string; execution_id: string }
    | undefined;
  return Boolean(
    existing &&
    existing.outcome === outcome &&
    existing.request_revision_hash === requestRevisionHash &&
    existing.execution_id === executionId,
  );
}

/** Performs the responsibility check and reads the cache in one read-unit snapshot.
 * The channel id comes from the trusted host repository lookup; a governed read also
 * verifies it still matches the unique enabled configured instance before reading. */
export function readResponsibilityChannelHistoryInUnit(
  db: Database.Database,
  taskId: string,
  channelType: string,
  channelId: string,
  chatId: string,
  sinceMs: number | null,
  direction: "incoming" | "outgoing" | "both",
  limit: number,
  runtime: string = "node",
): Array<Record<string, unknown>> {
  if (typeof taskId !== "string" || !taskId.trim() || taskId.length > 128)
    throw new Error("Invalid responsibility history task");
  if (typeof channelType !== "string" || !channelType.trim() || channelType.length > 128)
    throw new Error("Invalid history channel type");
  if (typeof channelId !== "string" || !channelId.trim() || channelId.length > 128)
    throw new Error("Invalid history channel instance");
  if (typeof chatId !== "string" || !chatId.trim() || chatId.length > 4096)
    throw new Error("Invalid history chat id");
  if (sinceMs !== null && (typeof sinceMs !== "number" || !Number.isFinite(sinceMs)))
    throw new Error("Invalid history time filter");
  if (!["incoming", "outgoing", "both"].includes(direction))
    throw new Error("Invalid history direction");
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new Error("Invalid history limit");

  const task = db.prepare("SELECT workspace_id FROM tasks WHERE id=?").get(taskId) as
    | { workspace_id: string }
    | undefined;
  const operation = fileResponsibilityOperation(
    "channel_history",
    { channel: channelType, chat_id: chatId },
    "",
  );
  const governed = assertResponsibilityTaskPolicy(
    db,
    taskId,
    task?.workspace_id ?? "",
    operation,
    runtime,
  );
  if (governed) {
    const admittedChannelId = readResponsibilityTaskChannelInstance(db, taskId, channelType);
    if (!admittedChannelId)
      throw new Error("Responsibility history channel instance receipt is unavailable");
    if (admittedChannelId !== channelId)
      throw new Error("Responsibility history channel instance changed since task admission");
    assertResponsibilityHistoryChannelInstance(db, channelType, channelId);
  }
  return new ChannelHistoryStore(db).chatMessages(channelId, chatId, sinceMs, direction, limit);
}

export async function readResponsibilityChannelHistory(
  db: Database.Database,
  taskId: string,
  channelType: string,
  channelId: string,
  chatId: string,
  sinceMs: number | null,
  direction: "incoming" | "outgoing" | "both",
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  return serviceStatements(db).unit("botResponsibility_readChannelHistory", [
    taskId,
    channelType,
    channelId,
    chatId,
    sinceMs,
    direction,
    limit,
    getAutomationRuntime()?.snapshot().runtime ?? "node",
  ]);
}

export async function enforceResponsibilityToolPolicy(
  db: Database.Database,
  taskId: string,
  workspaceId: string,
  workspacePath: string,
  name: string,
  input: unknown,
  allowSelectedActionReview = false,
): Promise<void> {
  await serviceStatements(db).unit("botResponsibility_assertTaskPolicy", [
    taskId,
    workspaceId,
    fileResponsibilityOperation(name, input, workspacePath),
    getAutomationRuntime()?.snapshot().runtime ?? "node",
    "tool",
    allowSelectedActionReview,
  ]);
}

export async function getResponsibilityActionReviewContext(
  db: Database.Database,
  taskId: string,
  workspaceId: string,
  workspacePath: string,
  canonicalPath: string,
): Promise<ResponsibilityActionReviewRun | null> {
  return serviceStatements(db).unit("botResponsibility_actionReviewContext", [
    taskId,
    workspaceId,
    workspacePath,
    canonicalPath,
    getAutomationRuntime()?.snapshot().runtime ?? "node",
  ]);
}

export async function claimResponsibilityActionReview(
  db: Database.Database,
  input: ResponsibilityActionReviewClaimInput,
): Promise<boolean> {
  return serviceStatements(db).unit("botResponsibility_claimActionReview", [input]);
}

export async function findReusableResponsibilityActionReview(
  db: Database.Database,
  taskId: string,
  workspaceId: string,
  workspacePath: string,
  proposed: ResponsibilityActionReviewPayload,
): Promise<ReusableResponsibilityActionReview | null> {
  return serviceStatements(db).unit("botResponsibility_findReusableActionReview", [
    taskId,
    workspaceId,
    workspacePath,
    proposed,
    getAutomationRuntime()?.snapshot().runtime ?? "node",
  ]);
}

export async function responsibilityActionReviewCanWait(
  db: Database.Database,
  approvalId: string,
  taskId: string,
  requestRevisionHash: string,
): Promise<boolean> {
  return serviceStatements(db).unit("botResponsibility_actionReviewCanWait", [
    approvalId,
    taskId,
    requestRevisionHash,
  ]);
}

export async function finishResponsibilityActionReview(
  db: Database.Database,
  approvalId: string,
  requestRevisionHash: string,
  executionId: string,
  outcome: ResponsibilityActionReviewOutcome,
): Promise<boolean> {
  return serviceStatements(db).unit("botResponsibility_finishActionReview", [
    approvalId,
    requestRevisionHash,
    executionId,
    outcome,
  ]);
}

export async function enforceResponsibilityTaskStart(
  db: Database.Database,
  taskId: string,
  workspaceId: string,
): Promise<void> {
  await serviceStatements(db).unit("botResponsibility_assertTaskPolicy", [
    taskId,
    workspaceId,
    null,
    getAutomationRuntime()?.snapshot().runtime ?? "node",
    "start",
  ]);
}

export function assertResponsibilityHistoryPolicy(
  db: Database.Database,
  taskId: string,
  input: unknown,
  runtime: string,
): void {
  const scope = db
    .prepare(
      "SELECT t.workspace_id,w.path FROM tasks t JOIN workspaces w ON w.id=t.workspace_id WHERE t.id=?",
    )
    .get(taskId) as { workspace_id: string; path: string } | undefined;
  if (scope)
    assertResponsibilityTaskPolicy(
      db,
      taskId,
      scope.workspace_id,
      fileResponsibilityOperation("channel_history", input, scope.path),
      runtime,
    );
}
export async function enforceResponsibilityHistoryPolicy(
  db: Database.Database,
  taskId: string,
  input: unknown,
): Promise<void> {
  await serviceStatements(db).unit("botResponsibility_assertHistoryPolicy", [
    taskId,
    input,
    getAutomationRuntime()?.snapshot().runtime ?? "node",
  ]);
}
