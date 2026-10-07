import { z } from "zod";
import { createHash } from "node:crypto";
import { APPROVAL_REQUEST_TIMEOUT_MS } from "../agent/approval-timeouts";
import type { ApprovalRequest } from "../../shared/types";
import {
  approvalDraftPresentation,
  RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID,
  responsibilityActionReviewPresentation,
  type InlineApprovalDraftReview,
  type ApprovalDraftPreview,
} from "../../shared/approval-draft-presentation";
import { approvalRequestRevisionHash } from "../agent/approval-revision";
const schema = z.object({
  id: z.string().min(1).max(200),
  taskId: z.string().min(1).max(200),
  type: z.string().min(1).max(100),
  description: z.string().max(10000),
  details: z.unknown(),
  requestedAt: z.number().int().nonnegative(),
});
/** Local approval audience only. Recheck caller authority after the worker returns private bytes. */
export async function readAuthorizedApprovalDraftPreview(
  data: unknown,
  dependencies: {
    findById(id: string): Promise<{ taskId: string } | undefined>;
    authorize(taskId: string): Promise<unknown>;
    draftPreviews(id: string, revision: string): Promise<ApprovalDraftPreview[]>;
  },
): Promise<ApprovalDraftPreview[]> {
  const request = schema.parse(data);
  const approval = await dependencies.findById(request.id);
  if (!approval || approval.taskId !== request.taskId)
    throw new Error("Approval request not found");
  await dependencies.authorize(approval.taskId);
  const revision = approvalRequestRevisionHash({
    ...request,
    type: request.type as ApprovalRequest["type"],
  });
  const previews = await dependencies.draftPreviews(request.id, revision);
  await dependencies.authorize(approval.taskId);
  return previews;
}

const inlineSchema = z.object({
  inputRequestId: z.string().min(1).max(200),
  taskId: z.string().min(1).max(200),
});
/** Resolve only the durable input link; never infer an approval from question text. */
export async function readAuthorizedInlineApprovalDraftReview(
  data: unknown,
  dependencies: {
    findInput(
      id: string,
    ): Promise<{ taskId: string; status: string; questions?: Array<{ id: string }> } | undefined>;
    getApprovalBinding(
      id: string,
    ): Promise<{ approvalId: string; taskId: string; revisionHash: string } | undefined>;
    findApproval(id: string): Promise<ApprovalRequest | undefined>;
    authorize(taskId: string): Promise<unknown>;
    draftPreviews(id: string, revision: string): Promise<ApprovalDraftPreview[]>;
    responsibilityActionAuthorityCurrent?(approval: ApprovalRequest): Promise<boolean>;
  },
): Promise<InlineApprovalDraftReview | undefined> {
  const request = inlineSchema.parse(data);
  const input = await dependencies.findInput(request.inputRequestId);
  if (!input || input.taskId !== request.taskId || input.status !== "pending") return;
  const questionRequiresReview = Boolean(
    input.questions?.some(
      (question) => question.id === RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID,
    ),
  );
  await dependencies.authorize(input.taskId);
  const binding = await dependencies.getApprovalBinding(request.inputRequestId);
  if (!binding || binding.taskId !== input.taskId) return;
  const currentApproval = async () => {
    const approval = await dependencies.findApproval(binding.approvalId);
    if (
      !approval ||
      approval.id !== binding.approvalId ||
      approval.taskId !== input.taskId ||
      approval.status !== "pending" ||
      !Number.isSafeInteger(approval.requestedAt) ||
      approval.requestedAt > Date.now() ||
      Date.now() >= approval.requestedAt + APPROVAL_REQUEST_TIMEOUT_MS ||
      approvalRequestRevisionHash(approval) !== binding.revisionHash
    )
      return;
    const actionReview = responsibilityActionReviewPresentation(approval.details);
    if (questionRequiresReview || actionReview.state !== "absent") {
      if (
        !dependencies.responsibilityActionAuthorityCurrent ||
        !(await dependencies.responsibilityActionAuthorityCurrent(approval))
      )
        return;
    }
    return approval;
  };
  const approval = await currentApproval();
  if (!approval) return;
  const draft = approvalDraftPresentation(approval.details);
  const parsedActionReview = responsibilityActionReviewPresentation(approval.details);
  const actionReviewRequired = questionRequiresReview || parsedActionReview.state !== "absent";
  const requiredFailure = (): InlineApprovalDraftReview => ({
    draft: draft ?? { state: "unavailable" },
    previews: [],
    responsibilityActionReview: { required: true, state: "invalid" },
  });
  if (!draft) return actionReviewRequired ? requiredFailure() : undefined;
  const previews =
    draft.state === "bound"
      ? await dependencies.draftPreviews(binding.approvalId, binding.revisionHash)
      : [];
  let responsibilityActionReview: InlineApprovalDraftReview["responsibilityActionReview"];
  if (actionReviewRequired) {
    const details = approval.details as Record<string, unknown> | undefined;
    const review = parsedActionReview.state === "valid" ? parsedActionReview.review : undefined;
    const reviewFiles = details?.reviewFiles;
    const params = details?.params as Record<string, unknown> | undefined;
    const fileEntry =
      draft.state === "bound"
        ? draft.files.find((file) => file.reference === review?.canonicalPath)
        : undefined;
    const exactContent = review ? Buffer.from(review.content, "utf8") : Buffer.alloc(0);
    const valid = Boolean(
      questionRequiresReview &&
      approval.type === "workspace_write" &&
      details?.tool === "write_file" &&
      params?.path === review?.canonicalPath &&
      Array.isArray(reviewFiles) &&
      reviewFiles.length === 1 &&
      reviewFiles[0] === review?.canonicalPath &&
      fileEntry &&
      (fileEntry.status === "present" || fileEntry.status === "missing"),
    );
    const digestMatches = Boolean(
      review &&
      exactContent.toString("utf8") === review.content &&
      exactContent.length === review.contentBytes &&
      createHash("sha256").update(exactContent).digest("hex") === review.contentSha256,
    );
    if (review && valid && digestMatches && draft.state === "bound") {
      responsibilityActionReview = {
        required: true,
        state: "valid",
        review,
      };
    } else {
      responsibilityActionReview = { required: true, state: "invalid" };
    }
  }
  // A decision, rebind or audience revocation during the read must withhold private bytes.
  const afterInput = await dependencies.findInput(request.inputRequestId);
  const afterBinding = await dependencies.getApprovalBinding(request.inputRequestId);
  if (
    !afterInput ||
    afterInput.taskId !== input.taskId ||
    afterInput.status !== "pending" ||
    !afterBinding ||
    afterBinding.taskId !== binding.taskId ||
    afterBinding.approvalId !== binding.approvalId ||
    afterBinding.revisionHash !== binding.revisionHash ||
    !(await currentApproval())
  )
    return;
  await dependencies.authorize(input.taskId);
  return {
    draft,
    previews,
    ...(responsibilityActionReview ? { responsibilityActionReview } : {}),
  };
}
