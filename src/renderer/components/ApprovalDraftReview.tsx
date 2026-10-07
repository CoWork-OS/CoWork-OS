import { useEffect, useState } from "react";
import type { InputRequest } from "../../shared/types";
import {
  RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID,
  resolveInlineApprovalDraftReviewResponse,
} from "../../shared/approval-draft-presentation";
import type {
  ApprovalDraftPresentation,
  ApprovalDraftPreview,
  InlineApprovalDraftPresentation as Review,
  ResponsibilityActionReviewPresentation,
} from "../../shared/approval-draft-presentation";

export function ApprovalDraftPreviewText({ preview }: { preview: ApprovalDraftPreview }) {
  return (
    <>
      <pre>{preview.text}</pre>
      {preview.truncated && <p>Preview truncated. Review the full file in the workspace.</p>}
    </>
  );
}

export function ApprovalDraftReview({
  draft,
  previews,
  loading = false,
  responsibilityActionReview,
}: {
  draft?: ApprovalDraftPresentation;
  previews: ApprovalDraftPreview[];
  loading?: boolean;
  responsibilityActionReview?: ResponsibilityActionReviewPresentation;
}) {
  return (
    <>
      {draft && (
        <section className="session-approval-draft" aria-label="Draft revision for review">
          <h4>Draft for this request</h4>
          {draft.state === "unavailable" ? (
            <p>
              The draft could not be inspected. Review it in the workspace before requesting
              approval again.
            </p>
          ) : (
            <>
              <p>
                These files were captured for this request. A changed file requires a new review.
              </p>
              {draft.files.map((file) => (
                <details key={file.reference} open={draft.files.length === 1}>
                  <summary>
                    {file.reference} ·{" "}
                    {file.status === "missing"
                      ? "Missing when requested"
                      : `${file.size!.toLocaleString()} bytes`}
                  </summary>
                  {file.sha256 && (
                    <p className="session-approval-draft-version" title={file.sha256}>
                      File version {file.sha256.slice(0, 12)}
                    </p>
                  )}
                  {previews.find(
                    (preview) =>
                      preview.reference === file.reference && preview.sha256 === file.sha256,
                  ) ? (
                    <ApprovalDraftPreviewText
                      preview={previews.find(
                        (preview) =>
                          preview.reference === file.reference && preview.sha256 === file.sha256,
                      )!}
                    />
                  ) : (
                    file.status === "present" && (
                      <p>
                        {loading
                          ? "Loading this file revision…"
                          : "Text preview unavailable. Review the file in the workspace."}
                      </p>
                    )
                  )}
                </details>
              ))}
            </>
          )}
        </section>
      )}
      {responsibilityActionReview && (
        <section
          className="session-approval-draft"
          aria-label="Proposed write for responsibility review"
        >
          <h4>Proposed write for this request</h4>
          {responsibilityActionReview.state === "invalid" ? (
            <p>The proposed write review is invalid. Approval is unavailable; deny this request.</p>
          ) : (
            <>
              {responsibilityActionReview.review.targetGrant &&
                (responsibilityActionReview.review.targetGrant.permitted ? (
                  <p className="responsibility-grant-note">
                    This file is one this responsibility may write.
                  </p>
                ) : (
                  <p className="responsibility-grant-note outside" role="alert">
                    <strong>Not a permitted file.</strong> This responsibility may only write{" "}
                    {responsibilityActionReview.review.targetGrant.grantedTargets.length
                      ? responsibilityActionReview.review.targetGrant.grantedTargets.join(", ")
                      : "no files"}
                    . Allow only if you want this extra file written.
                  </p>
                ))}
              <dl>
                <dt>Target</dt>
                <dd>
                  <code>{responsibilityActionReview.review.canonicalPath}</code>
                </dd>
                <dt>SHA-256</dt>
                <dd>
                  <code>{responsibilityActionReview.review.contentSha256}</code>
                </dd>
                <dt>Content size</dt>
                <dd>{responsibilityActionReview.review.contentBytes.toLocaleString()} bytes</dd>
              </dl>
              <p>Exact proposed content</p>
              <pre aria-label="Full proposed file content">
                {responsibilityActionReview.review.content}
              </pre>
            </>
          )}
        </section>
      )}
    </>
  );
}

export type InlineResponsibilityActionReviewLoadState = "valid" | "invalid";

export function InlineApprovalDraftReview({
  request,
  onResponsibilityActionReviewStateChange,
}: {
  request: InputRequest;
  onResponsibilityActionReviewStateChange?: (
    key: string,
    state: InlineResponsibilityActionReviewLoadState,
  ) => void;
}) {
  const [review, setReview] = useState<{ key: string; value: Review }>();
  const key = `${request.taskId}:${request.id}:${request.requestedAt}:${request.status}:${JSON.stringify(request.questions)}`;
  const requiresResponsibilityActionReview = request.questions.some(
    (question) => question.id === RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID,
  );
  useEffect(() => {
    let current = true;
    setReview(undefined);
    const markInvalid = () => {
      if (!current || !requiresResponsibilityActionReview) return;
      onResponsibilityActionReviewStateChange?.(key, "invalid");
      const value = resolveInlineApprovalDraftReviewResponse(undefined, true)!;
      setReview({
        key,
        value,
      });
    };
    if (request.status === "pending") {
      const readReview =
        typeof window === "undefined" ? undefined : window.electronAPI?.getInputRequestDraftReview;
      if (!readReview) {
        markInvalid();
      } else {
        void readReview(request.id, request.taskId)
          .then((value) => {
            if (!current) return;
            const normalized = resolveInlineApprovalDraftReviewResponse(
              value,
              requiresResponsibilityActionReview,
            );
            if (!normalized) {
              if (requiresResponsibilityActionReview) markInvalid();
              return;
            }
            if (requiresResponsibilityActionReview) {
              const state =
                normalized.responsibilityActionReview?.state === "valid" ? "valid" : "invalid";
              onResponsibilityActionReviewStateChange?.(key, state);
              setReview({ key, value: normalized });
              return;
            }
            setReview({ key, value: normalized });
          })
          .catch(() => {
            if (requiresResponsibilityActionReview) markInvalid();
          });
      }
    }
    return () => {
      current = false;
    };
  }, [
    key,
    onResponsibilityActionReviewStateChange,
    request.id,
    request.status,
    request.taskId,
    requiresResponsibilityActionReview,
  ]);
  if (request.status !== "pending") return null;
  if (review?.key !== key && requiresResponsibilityActionReview) {
    return (
      <section className="session-approval-draft" aria-label="Proposed write review loading">
        <h4>Proposed write for this request</h4>
        <p>
          Loading the exact proposed content. Allow once remains unavailable until review loads.
        </p>
      </section>
    );
  }
  if (review?.key !== key) return null;
  return (
    <ApprovalDraftReview
      draft={review.value.draft}
      previews={review.value.previews}
      responsibilityActionReview={review.value.responsibilityActionReview}
    />
  );
}
