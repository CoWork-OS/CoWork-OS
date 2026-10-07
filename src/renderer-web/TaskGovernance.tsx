import { useEffect, useState } from "react";
import { BrowserHostTransport } from "./transport";
import {
  RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID,
  resolveInlineApprovalDraftReviewResponse,
  type InlineApprovalDraftReview,
  type ResponsibilityActionReview,
} from "../shared/approval-draft-presentation";

type Approval = {
  id: string;
  taskId: string;
  description: string;
  type: string;
  expectedVersion: number;
  revisionHash: string;
};
type Question = {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description: string }>;
};
export type InputRequest = {
  id: string;
  taskId: string;
  expectedVersion: number;
  questions: Question[];
  baseDraftReview?: Pick<InlineApprovalDraftReview, "draft" | "previews">;
  responsibilityActionReview?:
    | { required: true; state: "invalid" }
    | { required: true; state: "valid"; review: ResponsibilityActionReview };
};
type Answer = { optionLabel?: string; otherText?: string };
type Attempt = {
  id: string;
  key: string;
  kind: "approval" | "input_request";
  expectedVersion: number;
  expectedRevisionHash?: string;
  decision: "approved" | "denied" | "submitted" | "dismissed";
  answers?: Record<string, Answer>;
};

export function TaskGovernance({
  taskId,
  workspaceId,
  transport,
  connected,
  approvalsEnabled,
  inputsEnabled,
  storageKey,
}: {
  taskId: string;
  workspaceId: string;
  transport: BrowserHostTransport | null;
  connected: boolean;
  approvalsEnabled: boolean;
  inputsEnabled: boolean;
  storageKey: string;
}) {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [inputs, setInputs] = useState<InputRequest[]>([]);
  const [morePending, setMorePending] = useState(false);
  const [attempt, setAttempt] = useState<Attempt | null>(() => readAttempt(storageKey));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    writeAttempt(storageKey, attempt);
  }, [storageKey, attempt]);

  useEffect(() => {
    if (!hasApprovalAttemptRevisionChanged(attempt, approvals)) return;
    setAttempt(null);
    setNotice("This approval changed. Review the updated request before deciding again.");
  }, [attempt, approvals]);

  useEffect(() => {
    if (!transport || !connected || (!approvalsEnabled && !inputsEnabled)) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const [approvalResult, inputResult] = await Promise.all([
          approvalsEnabled
            ? transport.request<unknown>("approval.list", {
                taskId,
                workspaceId,
                limit: 50,
                offset: 0,
              })
            : null,
          inputsEnabled
            ? transport.request<unknown>("input_request.list", {
                taskId,
                workspaceId,
                limit: 50,
                offset: 0,
              })
            : null,
        ]);
        if (!active) return;
        setApprovals(approvalResult === null ? [] : parseApprovals(approvalResult, taskId));
        setInputs(inputResult === null ? [] : parseInputs(inputResult, taskId));
        setMorePending(
          (isRecord(approvalResult) && approvalResult.hasMore === true) ||
            (isRecord(inputResult) && inputResult.hasMore === true),
        );
        setError("");
      } catch (cause) {
        if (active) {
          setError(cause instanceof Error ? cause.message : "Could not load pending decisions.");
          setInputs((current) =>
            current.map((request) =>
              requiresResponsibilityActionReview(request)
                ? {
                    ...request,
                    responsibilityActionReview: { required: true, state: "invalid" },
                  }
                : request,
            ),
          );
        }
      } finally {
        if (active) timer = setTimeout(() => void load(), 5_000);
      }
    };
    void load();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [taskId, workspaceId, transport, connected, approvalsEnabled, inputsEnabled, refresh]);

  const reconcile = async (
    kind: "approval" | "input_request",
    id: string,
    decision: Attempt["decision"],
    expectedVersion: number,
    expectedRevisionHash?: string,
  ): Promise<boolean> => {
    if (!transport) return false;
    try {
      const result = await transport.request<unknown>(`${kind}.get`, {
        taskId,
        workspaceId,
        expectedVersion,
        ...(kind === "approval" && expectedRevisionHash ? { expectedRevisionHash } : {}),
        [kind === "approval" ? "approvalId" : "requestId"]: id,
      });
      const item = isRecord(result)
        ? result[kind === "approval" ? "approval" : "inputRequest"]
        : null;
      if (!isRecord(item)) return false;
      if (item.decision === decision) {
        setNotice("The host confirmed your decision.");
        setAttempt(null);
        setRefresh((current) => current + 1);
        return true;
      }
      if (typeof item.decision === "string" && item.decision !== decision) {
        setError("This request was resolved with a different decision. Reload its current state.");
        setAttempt(null);
        setRefresh((current) => current + 1);
        return true;
      }
    } catch {
      // Keep the same operation key available for a deliberate retry.
    }
    return false;
  };

  const respondApproval = async (approval: Approval, approved: boolean) => {
    if (
      !transport ||
      !connected ||
      busy ||
      (attempt && (attempt.kind !== "approval" || attempt.id !== approval.id))
    )
      return;
    if (attempt?.kind === "approval" && attempt.expectedRevisionHash !== approval.revisionHash) {
      setAttempt(null);
      setError("This approval changed. Review the updated request before deciding again.");
      setNotice("");
      return;
    }
    const decision = approved ? "approved" : "denied";
    if (attempt && attempt.decision !== decision) return;
    const currentAttempt = attempt ?? {
      id: approval.id,
      key: crypto.randomUUID(),
      kind: "approval" as const,
      expectedVersion: approval.expectedVersion,
      expectedRevisionHash: approval.revisionHash,
      decision,
    };
    setAttempt(currentAttempt);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await transport.request<unknown>(
        "approval.respond",
        {
          approvalId: approval.id,
          taskId,
          workspaceId,
          expectedVersion: approval.expectedVersion,
          expectedRevisionHash: approval.revisionHash,
          approved,
        },
        { operationKey: currentAttempt.key, mutation: true },
      );
      if (!isRecord(result) || result.decision !== decision) {
        throw new Error("The host did not confirm this decision.");
      }
      setAttempt(null);
      setNotice("Decision recorded by your CoWork host.");
      setRefresh((current) => current + 1);
    } catch (cause) {
      if (
        await reconcile(
          "approval",
          approval.id,
          decision,
          approval.expectedVersion,
          approval.revisionHash,
        )
      )
        return;
      setError(
        cause instanceof Error
          ? cause.message
          : "Decision outcome is unknown. Retry with the same key.",
      );
    } finally {
      setBusy(false);
    }
  };

  const respondInput = async (
    request: InputRequest,
    status: "submitted" | "dismissed",
    answers?: Record<string, Answer>,
  ) => {
    if (
      !transport ||
      !connected ||
      busy ||
      (attempt && (attempt.kind !== "input_request" || attempt.id !== request.id))
    )
      return;
    if (attempt && attempt.decision !== status) return;
    const currentAttempt = attempt
      ? { ...attempt, answers: attempt.answers ?? answers }
      : {
          id: request.id,
          key: crypto.randomUUID(),
          kind: "input_request" as const,
          expectedVersion: request.expectedVersion,
          decision: status,
          answers,
        };
    setAttempt(currentAttempt);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await transport.request<unknown>(
        "input_request.respond",
        {
          requestId: request.id,
          taskId,
          workspaceId,
          expectedVersion: request.expectedVersion,
          status,
          ...(currentAttempt.answers ? { answers: currentAttempt.answers } : {}),
        },
        { operationKey: currentAttempt.key, mutation: true },
      );
      if (!isRecord(result) || result.decision !== status) {
        throw new Error("The host did not confirm this response.");
      }
      setAttempt(null);
      setNotice("Response recorded by your CoWork host.");
      setRefresh((current) => current + 1);
    } catch (cause) {
      if (await reconcile("input_request", request.id, status, request.expectedVersion)) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "Response outcome is unknown. Retry with the same key.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (!approvalsEnabled && !inputsEnabled) return null;
  return (
    <section className="web-governance" aria-label="Pending task decisions">
      <h3>Needs your input</h3>
      {error && (
        <p className="web-inline-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="web-muted" role="status">
          {notice}
        </p>
      )}
      {attempt && (
        <>
          {attempt.kind === "input_request" &&
            attempt.decision === "submitted" &&
            !attempt.answers && (
              <p className="web-muted">
                If this response is still pending, re-enter the same answers before retrying.
                Answers were not saved in this browser.
              </p>
            )}
          <button
            className="web-check-outcome"
            type="button"
            disabled={!connected || busy}
            onClick={() => {
              setBusy(true);
              void reconcile(
                attempt.kind,
                attempt.id,
                attempt.decision,
                attempt.expectedVersion,
                attempt.expectedRevisionHash,
              )
                .then((confirmed) => {
                  if (!confirmed)
                    setError(
                      "The host has not confirmed this decision yet. Retry the same action with the same answers.",
                    );
                })
                .finally(() => setBusy(false));
            }}
          >
            Check decision outcome
          </button>
        </>
      )}
      {approvals.length === 0 && inputs.length === 0 && !error && (
        <p className="web-muted">No pending decisions for this task.</p>
      )}
      {morePending && (
        <p className="web-muted">More pending decisions will appear as these are resolved.</p>
      )}
      {approvals.map((approval) => (
        <div className="web-decision-card" key={approval.id}>
          <p className="web-eyebrow">{humanize(approval.type)} approval</p>
          <p>{approval.description}</p>
          <div className="web-decision-actions">
            <button
              type="button"
              disabled={
                !connected ||
                busy ||
                (attempt !== null &&
                  (attempt.id !== approval.id || attempt.decision !== "approved"))
              }
              onClick={() => void respondApproval(approval, true)}
            >
              {attempt?.id === approval.id && attempt.decision === "approved"
                ? "Retry approval"
                : "Approve once"}
            </button>
            <button
              type="button"
              className="web-secondary-button"
              disabled={
                !connected ||
                busy ||
                (attempt !== null && (attempt.id !== approval.id || attempt.decision !== "denied"))
              }
              onClick={() => void respondApproval(approval, false)}
            >
              {attempt?.id === approval.id && attempt.decision === "denied"
                ? "Retry denial"
                : "Deny"}
            </button>
          </div>
        </div>
      ))}
      {inputs.map((request) => (
        <InputRequestForm
          key={request.id}
          request={request}
          disabled={!connected || busy || (attempt !== null && attempt.id !== request.id)}
          locked={attempt?.id === request.id && Boolean(attempt.answers)}
          retryDecision={attempt?.id === request.id ? attempt.decision : null}
          onRespond={(status, answers) => void respondInput(request, status, answers)}
        />
      ))}
    </section>
  );
}

export function InputRequestForm({
  request,
  disabled,
  locked,
  retryDecision,
  onRespond,
}: {
  request: InputRequest;
  disabled: boolean;
  locked: boolean;
  retryDecision: Attempt["decision"] | null;
  onRespond: (status: "submitted" | "dismissed", answers?: Record<string, Answer>) => void;
}) {
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [otherTexts, setOtherTexts] = useState<Record<string, string>>({});
  const requiresActionReview = requiresResponsibilityActionReview(request);
  const validActionReview = request.responsibilityActionReview?.state === "valid";
  const currentIdentity = inputRequestIdentity(request);
  const [selectionIdentity, setSelectionIdentity] = useState(currentIdentity);
  useEffect(() => {
    setChoices({});
    setOtherTexts({});
    setSelectionIdentity("");
  }, [currentIdentity]);
  const canSubmit = inputRequestCanSubmit(request, choices, otherTexts, selectionIdentity);
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || retryDecision === "dismissed") return;
    onRespond("submitted", buildInputRequestAnswers(request, choices, otherTexts));
  };
  return (
    <form className="web-decision-card web-input-form" onSubmit={submit}>
      <p className="web-eyebrow">Question from this task</p>
      {requiresActionReview && (
        <>
          <ApprovalDraftBaseReviewCard review={request.baseDraftReview} />
          <ResponsibilityActionReviewCard review={request.responsibilityActionReview} />
        </>
      )}
      {request.questions.map((question) => (
        <fieldset key={question.id} disabled={disabled || locked}>
          <legend>{question.question}</legend>
          {question.options
            .map((option) => ({ option }))
            .filter(
              ({ option }) =>
                !requiresActionReview ||
                question.id !== RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID ||
                ["deny once", "allow once"].includes(option.label.trim().toLowerCase()),
            )
            .map(({ option }) => (
              <label key={option.label}>
                <input
                  type="radio"
                  name={`${request.id}:${question.id}`}
                  checked={choices[question.id] === option.label}
                  disabled={
                    question.id === RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID &&
                    option.label.trim().toLowerCase() === "allow once" &&
                    !validActionReview
                  }
                  onChange={() => {
                    setChoices((current) => ({ ...current, [question.id]: option.label }));
                    setSelectionIdentity(currentIdentity);
                  }}
                />
                <span>
                  {option.label}
                  {option.description ? ` — ${option.description}` : ""}
                </span>
              </label>
            ))}
          {!(
            requiresActionReview &&
            question.id === RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID
          ) && (
            <label>
              <input
                type="radio"
                name={`${request.id}:${question.id}`}
                checked={choices[question.id] === "__other__"}
                onChange={() => {
                  setChoices((current) => ({ ...current, [question.id]: "__other__" }));
                  setSelectionIdentity(currentIdentity);
                }}
              />
              <span>Other</span>
            </label>
          )}
          {choices[question.id] === "__other__" &&
            !(
              requiresActionReview &&
              question.id === RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID
            ) && (
              <textarea
                aria-label={`Other answer for ${question.header}`}
                value={otherTexts[question.id] ?? ""}
                maxLength={8_000}
                onChange={(event) => {
                  setOtherTexts((current) => ({ ...current, [question.id]: event.target.value }));
                  setSelectionIdentity(currentIdentity);
                }}
              />
            )}
        </fieldset>
      ))}
      <div className="web-decision-actions">
        <button type="submit" disabled={disabled || !canSubmit || retryDecision === "dismissed"}>
          {retryDecision === "submitted" ? "Retry response" : "Send response"}
        </button>
        <button
          type="button"
          className="web-secondary-button"
          disabled={disabled || (retryDecision !== null && retryDecision !== "dismissed")}
          onClick={() => onRespond("dismissed")}
        >
          {retryDecision === "dismissed" ? "Retry dismissal" : "Dismiss"}
        </button>
      </div>
    </form>
  );
}

export function ResponsibilityActionReviewCard({
  review,
}: {
  review: InputRequest["responsibilityActionReview"];
}) {
  return (
    <section className="web-decision-card" aria-label="Proposed write for responsibility review">
      <p className="web-eyebrow">Proposed write for this request</p>
      {review?.state !== "valid" ? (
        <p role="alert">
          The exact proposed write could not be reviewed. Allow once is unavailable.
        </p>
      ) : (
        <>
          <dl>
            <dt>Target</dt>
            <dd>
              <code>{review.review.canonicalPath}</code>
            </dd>
            <dt>SHA-256</dt>
            <dd>
              <code>{review.review.contentSha256}</code>
            </dd>
            <dt>Content size</dt>
            <dd>{review.review.contentBytes.toLocaleString()} bytes</dd>
          </dl>
          <p>Exact proposed content</p>
          <pre aria-label="Full proposed file content" style={{ whiteSpace: "pre-wrap" }}>
            {review.review.content}
          </pre>
        </>
      )}
    </section>
  );
}

export function ApprovalDraftBaseReviewCard({
  review,
}: {
  review: InputRequest["baseDraftReview"];
}) {
  return (
    <section className="web-decision-card" aria-label="Current target revision for review">
      <p className="web-eyebrow">Current target revision</p>
      {!review || review.draft.state === "unavailable" ? (
        <p>The current target revision could not be inspected.</p>
      ) : (
        <>
          <p>This is the existing file that the proposed write would replace.</p>
          {review.draft.files.map((file) => {
            const preview = review.previews.find(
              (candidate) =>
                candidate.reference === file.reference && candidate.sha256 === file.sha256,
            );
            return (
              <details key={file.reference} open={review.draft.files.length === 1}>
                <summary>
                  {file.reference} ·{" "}
                  {file.status === "missing"
                    ? "Missing when requested"
                    : `${file.size!.toLocaleString()} bytes`}
                </summary>
                {file.sha256 && <p>Current file SHA-256: {file.sha256}</p>}
                {preview ? (
                  <>
                    <pre
                      aria-label="Current target file preview"
                      style={{ whiteSpace: "pre-wrap" }}
                    >
                      {preview.text}
                    </pre>
                    {preview.truncated && <p>Current file preview is truncated.</p>}
                  </>
                ) : (
                  file.status === "present" && <p>Current file preview is unavailable.</p>
                )}
              </details>
            );
          })}
        </>
      )}
    </section>
  );
}

function parseApprovals(value: unknown, taskId: string): Approval[] {
  if (!isRecord(value) || !Array.isArray(value.approvals))
    throw new Error("The host returned invalid approvals.");
  return value.approvals.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      item.taskId !== taskId ||
      typeof item.description !== "string" ||
      typeof item.type !== "string" ||
      !Number.isSafeInteger(item.expectedVersion) ||
      typeof item.revisionHash !== "string" ||
      !REVISION_HASH_RE.test(item.revisionHash)
    ) {
      throw new Error("The host returned an invalid approval.");
    }
    return item as Approval;
  });
}

export function parseInputs(value: unknown, taskId: string): InputRequest[] {
  if (!isRecord(value) || !Array.isArray(value.inputRequests))
    throw new Error("The host returned invalid input requests.");
  return value.inputRequests.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      item.taskId !== taskId ||
      !Number.isSafeInteger(item.expectedVersion) ||
      !Array.isArray(item.questions)
    ) {
      throw new Error("The host returned an invalid input request.");
    }
    const questions = item.questions.map((question) => {
      if (
        !isRecord(question) ||
        typeof question.id !== "string" ||
        typeof question.header !== "string" ||
        typeof question.question !== "string" ||
        !Array.isArray(question.options)
      )
        throw new Error("The host returned an invalid input question.");
      const options = question.options.map((option) => {
        if (
          !isRecord(option) ||
          typeof option.label !== "string" ||
          typeof option.description !== "string"
        )
          throw new Error("The host returned an invalid input option.");
        return { label: option.label, description: option.description };
      });
      return { id: question.id, header: question.header, question: question.question, options };
    });
    const parsedRequest: InputRequest = {
      id: item.id,
      taskId,
      expectedVersion: Number(item.expectedVersion),
      questions,
    };
    if (requiresResponsibilityActionReview(parsedRequest)) {
      const baseReview = isRecord(item.draftReview) ? item.draftReview : {};
      const normalized = resolveInlineApprovalDraftReviewResponse(
        {
          draft: baseReview.draft,
          previews: baseReview.previews,
          responsibilityActionReview: item.responsibilityActionReview,
        },
        true,
      )!;
      parsedRequest.baseDraftReview = {
        draft: normalized.draft,
        previews: normalized.previews,
      };
      parsedRequest.responsibilityActionReview = normalized.responsibilityActionReview ?? {
        required: true,
        state: "invalid",
      };
    }
    return parsedRequest;
  });
}

function requiresResponsibilityActionReview(request: Pick<InputRequest, "questions">): boolean {
  return request.questions.some(
    (question) => question.id === RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID,
  );
}

export function inputRequestIdentity(request: InputRequest): string {
  return JSON.stringify({
    taskId: request.taskId,
    id: request.id,
    expectedVersion: request.expectedVersion,
    questions: request.questions,
    baseRevision:
      request.baseDraftReview?.draft.state === "bound"
        ? request.baseDraftReview.draft.files.map((file) => ({
            reference: file.reference,
            status: file.status,
            sha256: file.sha256,
            size: file.size,
          }))
        : (request.baseDraftReview?.draft.state ?? "absent"),
    responsibilityActionReview:
      request.responsibilityActionReview?.state === "valid"
        ? {
            canonicalPath: request.responsibilityActionReview.review.canonicalPath,
            contentSha256: request.responsibilityActionReview.review.contentSha256,
            contentBytes: request.responsibilityActionReview.review.contentBytes,
          }
        : (request.responsibilityActionReview?.state ?? "absent"),
  });
}

export function inputRequestCanSubmit(
  request: InputRequest,
  choices: Record<string, string>,
  otherTexts: Record<string, string>,
  selectionIdentity: string,
): boolean {
  if (selectionIdentity !== inputRequestIdentity(request)) return false;
  const complete = request.questions.every((question) => {
    const choice = choices[question.id];
    return choice && (choice !== "__other__" || Boolean(otherTexts[question.id]?.trim()));
  });
  if (!complete) return false;
  if (!requiresResponsibilityActionReview(request)) return true;
  const decisionQuestions = request.questions.filter(
    (question) => question.id === RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID,
  );
  if (decisionQuestions.length !== 1) return false;
  const decision = choices[RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID]?.trim().toLowerCase();
  if (decision === "deny once") return true;
  return decision === "allow once" && request.responsibilityActionReview?.state === "valid";
}

export function buildInputRequestAnswers(
  request: InputRequest,
  choices: Record<string, string>,
  otherTexts: Record<string, string>,
): Record<string, Answer> {
  return Object.fromEntries(
    request.questions.map((question) => [
      question.id,
      choices[question.id] === "__other__"
        ? { otherText: otherTexts[question.id]?.trim() }
        : { optionLabel: choices[question.id] },
    ]),
  );
}

function humanize(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readAttempt(storageKey: string): Attempt | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value) ||
      typeof value.id !== "string" ||
      typeof value.key !== "string" ||
      !/^[A-Za-z0-9._:-]{8,128}$/.test(value.key) ||
      (value.kind !== "approval" && value.kind !== "input_request") ||
      (value.kind === "approval" &&
        (typeof value.expectedRevisionHash !== "string" ||
          !REVISION_HASH_RE.test(value.expectedRevisionHash))) ||
      !Number.isSafeInteger(value.expectedVersion) ||
      (value.decision !== "approved" &&
        value.decision !== "denied" &&
        value.decision !== "submitted" &&
        value.decision !== "dismissed")
    )
      return null;
    return {
      id: value.id,
      key: value.key,
      kind: value.kind,
      expectedVersion: Number(value.expectedVersion),
      ...(value.kind === "approval"
        ? { expectedRevisionHash: value.expectedRevisionHash as string }
        : {}),
      decision: value.decision,
    };
  } catch {
    return null;
  }
}

export function writeAttempt(storageKey: string, attempt: Attempt | null): void {
  try {
    if (!attempt) window.sessionStorage.removeItem(storageKey);
    else {
      const { id, key, kind, expectedVersion, expectedRevisionHash, decision } = attempt;
      window.sessionStorage.setItem(
        storageKey,
        JSON.stringify({
          id,
          key,
          kind,
          expectedVersion,
          ...(kind === "approval" && expectedRevisionHash ? { expectedRevisionHash } : {}),
          decision,
        }),
      );
    }
  } catch {
    // A disabled storage backend leaves the attempt available in memory.
  }
}

const REVISION_HASH_RE = /^[0-9a-f]{64}$/;

export function hasApprovalAttemptRevisionChanged(
  attempt: Attempt | null,
  approvals: Array<Pick<Approval, "id" | "revisionHash">>,
): boolean {
  if (attempt?.kind !== "approval") return false;
  const current = approvals.find((approval) => approval.id === attempt.id);
  return Boolean(current && current.revisionHash !== attempt.expectedRevisionHash);
}
