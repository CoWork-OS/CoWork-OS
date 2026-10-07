export type ApprovalDraftPreview = {
  reference: string;
  sha256: string;
  text: string;
  truncated: boolean;
};
export type ApprovalDraftPresentation =
  | { state: "unavailable" }
  | {
      state: "bound";
      files: Array<{
        reference: string;
        status: "present" | "missing";
        sha256?: string;
        size?: number;
      }>;
    };
/** UI signal for exact, one-time responsibility write review. It grants no authority. */
export const RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID =
  "responsibility_action_review_decision";
/** Presentation only. Execution still uses the trusted approval writer's revision checks. */
export function approvalDraftPresentation(details: unknown): ApprovalDraftPresentation | undefined {
  if (!details || typeof details !== "object") return;
  const binding = (details as Record<string, unknown>).draftRevision;
  if (!binding || typeof binding !== "object") return;
  const value = binding as Record<string, unknown>;
  if (value.version !== 1) return;
  if (value.state === "unavailable") return { state: "unavailable" };
  if (
    value.state !== "bound" ||
    !Array.isArray(value.entries) ||
    value.entries.length < 1 ||
    value.entries.length > 4
  )
    return;
  const files: Extract<ApprovalDraftPresentation, { state: "bound" }>["files"] = [];
  for (const item of value.entries) {
    if (!item || typeof item !== "object") return;
    const entry = item as Record<string, unknown>;
    if (
      typeof entry.reference !== "string" ||
      !entry.reference.trim() ||
      entry.reference.length > 2048 ||
      !["present", "missing"].includes(String(entry.status))
    )
      return;
    if (entry.status === "missing") {
      files.push({ reference: entry.reference, status: "missing" });
      continue;
    }
    if (
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !Number.isSafeInteger(entry.size) ||
      Number(entry.size) < 0
    )
      return;
    files.push({
      reference: entry.reference,
      status: "present",
      sha256: entry.sha256,
      size: Number(entry.size),
    });
  }
  return { state: "bound", files };
}

export type InlineApprovalDraftReview = {
  draft: ApprovalDraftPresentation;
  previews: ApprovalDraftPreview[];
  responsibilityActionReview?:
    | { required: true; state: "invalid" }
    | { required: true; state: "valid"; review: ResponsibilityActionReview };
};

export type ResponsibilityActionReview = {
  canonicalPath: string;
  content: string;
  contentSha256: string;
  contentBytes: number;
  /** Whether the target is one of the responsibility's permitted files (display aid). */
  targetGrant?: { permitted: boolean; grantedTargets: string[] };
  responsibilityRun: {
    id: string;
    revision: number;
    controlVersion: number;
    workspaceId: string;
    agentRoleId: string;
  };
};

export type ResponsibilityActionReviewPresentation =
  | { state: "invalid" }
  | { state: "valid"; review: ResponsibilityActionReview };

/** Normalized local presentation; the host wire wrapper retains its required flag. */
export type InlineApprovalDraftPresentation = Omit<
  InlineApprovalDraftReview,
  "responsibilityActionReview"
> & {
  responsibilityActionReview?: ResponsibilityActionReviewPresentation;
};

/** Validate the renderer-facing inline response again; absence is invalid only when required. */
export function inlineResponsibilityActionReviewPresentation(
  value: unknown,
  required: boolean,
  draft?: unknown,
): ResponsibilityActionReviewPresentation | undefined {
  if (!required) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { state: "invalid" };
  const candidate = value as Record<string, unknown>;
  if (candidate.required !== true) return { state: "invalid" };
  if (candidate.state === "invalid") return { state: "invalid" };
  if (candidate.state !== "valid" || !candidate.review || typeof candidate.review !== "object")
    return { state: "invalid" };
  const review = candidate.review as Record<string, unknown>;
  const parsed = responsibilityActionReviewPresentation({
    responsibilityActionReview: {
      version: 1,
      operation: { connectorId: "workspace_files", method: "write_file" },
      ...review,
    },
  });
  if (parsed.state !== "valid" || !isBoundBaseForReview(draft, parsed.review.canonicalPath))
    return { state: "invalid" };
  return parsed;
}

function isBoundBaseForReview(draft: unknown, canonicalPath: string): boolean {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) return false;
  const candidate = draft as Record<string, unknown>;
  if (
    candidate.state !== "bound" ||
    !Array.isArray(candidate.files) ||
    candidate.files.length !== 1
  )
    return false;
  const file = candidate.files[0];
  if (!file || typeof file !== "object" || Array.isArray(file)) return false;
  const base = file as Record<string, unknown>;
  if (base.reference !== canonicalPath || !["present", "missing"].includes(String(base.status)))
    return false;
  return (
    base.status === "missing" ||
    (typeof base.sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(base.sha256) &&
      Number.isSafeInteger(base.size) &&
      Number(base.size) >= 0)
  );
}

/** Normalize the trusted IPC wrapper and turn missing mandatory review data into an invalid card. */
export function resolveInlineApprovalDraftReviewResponse(
  value: unknown,
  requiresResponsibilityActionReview: boolean,
): InlineApprovalDraftPresentation | undefined {
  const invalidMandatoryReview: InlineApprovalDraftPresentation = {
    draft: { state: "unavailable" },
    previews: [],
    responsibilityActionReview: { state: "invalid" },
  };
  if (!value || typeof value !== "object" || Array.isArray(value))
    return requiresResponsibilityActionReview ? invalidMandatoryReview : undefined;
  const candidate = value as Record<string, unknown>;
  const draft = inlineDraftPresentation(candidate.draft);
  if (!draft || !Array.isArray(candidate.previews))
    return requiresResponsibilityActionReview ? invalidMandatoryReview : undefined;
  const actionReview = inlineResponsibilityActionReviewPresentation(
    candidate.responsibilityActionReview,
    requiresResponsibilityActionReview,
    draft,
  );
  if (requiresResponsibilityActionReview && actionReview?.state !== "valid") {
    return {
      ...invalidMandatoryReview,
      draft,
      previews: inlineDraftPreviews(candidate.previews),
      responsibilityActionReview: { state: "invalid" },
    };
  }
  return {
    draft,
    previews: inlineDraftPreviews(candidate.previews),
    ...(actionReview ? { responsibilityActionReview: actionReview } : {}),
  };
}

function inlineDraftPresentation(value: unknown): ApprovalDraftPresentation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const candidate = value as Record<string, unknown>;
  if (candidate.state === "unavailable") return { state: "unavailable" };
  if (candidate.state !== "bound" || !Array.isArray(candidate.files)) return;
  return approvalDraftPresentation({
    draftRevision: { version: 1, state: "bound", entries: candidate.files },
  });
}

function inlineDraftPreviews(value: unknown[]): ApprovalDraftPreview[] {
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const preview = item as Record<string, unknown>;
    if (
      typeof preview.reference !== "string" ||
      !preview.reference.trim() ||
      typeof preview.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(preview.sha256) ||
      typeof preview.text !== "string" ||
      typeof preview.truncated !== "boolean"
    )
      return [];
    return [
      {
        reference: preview.reference,
        sha256: preview.sha256,
        text: preview.text,
        truncated: preview.truncated,
      },
    ];
  });
}

/** Presentation only. This payload never grants or broadens approval authority. */
export function responsibilityActionReviewPresentation(
  details: unknown,
): ResponsibilityActionReviewPresentation | { state: "absent" } {
  if (!details || typeof details !== "object") return { state: "absent" };
  const record = details as Record<string, unknown>;
  if (!("responsibilityActionReview" in record)) return { state: "absent" };
  if (Array.isArray(details)) return { state: "invalid" };

  const value = record.responsibilityActionReview;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { state: "invalid" };
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    !candidate.operation ||
    typeof candidate.operation !== "object" ||
    Array.isArray(candidate.operation)
  )
    return { state: "invalid" };
  const operation = candidate.operation as Record<string, unknown>;
  const canonicalPath = candidate.canonicalPath;
  const content = candidate.content;
  const contentSha256 = candidate.contentSha256;
  const contentBytes = candidate.contentBytes;
  const run = candidate.responsibilityRun;
  if (
    operation.connectorId !== "workspace_files" ||
    operation.method !== "write_file" ||
    typeof canonicalPath !== "string" ||
    !canonicalPath ||
    canonicalPath.length > 2048 ||
    canonicalPath.startsWith("/") ||
    canonicalPath.includes("\\") ||
    canonicalPath.includes("\0") ||
    /[\u0000-\u001f\u007f]/.test(canonicalPath) ||
    canonicalPath.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
    typeof content !== "string" ||
    typeof contentSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(contentSha256) ||
    !Number.isSafeInteger(contentBytes) ||
    Number(contentBytes) < 0 ||
    Number(contentBytes) > 256_000 ||
    !run ||
    typeof run !== "object" ||
    Array.isArray(run)
  )
    return { state: "invalid" };

  const encodedContent = new TextEncoder().encode(content);
  const encodedBytes = encodedContent.byteLength;
  const roundTrippedContent = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(encodedContent);
  const runRecord = run as Record<string, unknown>;
  const runId = runRecord.id;
  const revision = runRecord.revision;
  const controlVersion = runRecord.controlVersion;
  const workspaceId = runRecord.workspaceId;
  const agentRoleId = runRecord.agentRoleId;
  if (
    encodedBytes > 256_000 ||
    roundTrippedContent !== content ||
    contentBytes !== encodedBytes ||
    typeof runId !== "string" ||
    !runId.trim() ||
    runId.length > 512 ||
    !Number.isSafeInteger(revision) ||
    Number(revision) < 1 ||
    !Number.isSafeInteger(controlVersion) ||
    Number(controlVersion) < 0 ||
    typeof workspaceId !== "string" ||
    !workspaceId.trim() ||
    workspaceId.length > 512 ||
    typeof agentRoleId !== "string" ||
    !agentRoleId.trim() ||
    agentRoleId.length > 512
  )
    return { state: "invalid" };

  const grant = candidate.targetGrant as Record<string, unknown> | undefined;
  const targetGrant =
    grant &&
    typeof grant === "object" &&
    !Array.isArray(grant) &&
    typeof grant.permitted === "boolean" &&
    Array.isArray(grant.grantedTargets) &&
    grant.grantedTargets.length <= 20 &&
    grant.grantedTargets.every((target) => typeof target === "string" && target.length <= 2048)
      ? { permitted: grant.permitted, grantedTargets: grant.grantedTargets as string[] }
      : undefined;
  return {
    state: "valid",
    review: {
      canonicalPath,
      content,
      contentSha256,
      contentBytes,
      ...(targetGrant ? { targetGrant } : {}),
      responsibilityRun: {
        id: runId,
        revision: Number(revision),
        controlVersion: Number(controlVersion),
        workspaceId,
        agentRoleId,
      },
    },
  };
}
