import { InlineApprovalDraftReview } from "../ApprovalDraftReview";
import { useState, useEffect, useCallback, useMemo } from "react";
import { RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID } from "../../../shared/approval-draft-presentation";
import type { InputRequest } from "../../../shared/types";

export type InputRequestAnswers = Record<string, { optionLabel?: string; otherText?: string }>;

type ReviewDecisionState = "pending" | "valid" | "invalid";

export function responsibilityActionReviewDecisionAllowed(
  question: InputRequest["questions"][number],
  selectedOption: number | undefined,
  reviewState: ReviewDecisionState,
): boolean {
  if (question.id !== RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID) return true;
  const label = question.options[selectedOption ?? -1]?.label.trim().toLowerCase();
  if (label === "deny once") return true;
  return label === "allow once" && reviewState === "valid";
}

export function responsibilityActionReviewOptionDisabled(
  question: InputRequest["questions"][number],
  optionIndex: number,
  reviewState: ReviewDecisionState,
): boolean {
  return (
    question.id === RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID &&
    question.options[optionIndex]?.label.trim().toLowerCase() === "allow once" &&
    reviewState !== "valid"
  );
}

interface StructuredInputPromptCardProps {
  request: InputRequest;
  onSubmit: (answers: InputRequestAnswers) => void;
  onDismiss: () => void;
}

/** True when a key event comes from inside an open modal dialog, which owns its own keys. */
export function keyEventFromModalDialog(target: EventTarget | null): boolean {
  const element = target as Element | null;
  return typeof element?.closest === "function" && element.closest('[aria-modal="true"]') !== null;
}

export function StructuredInputPromptCard({
  request,
  onSubmit,
  onDismiss,
}: StructuredInputPromptCardProps) {
  const questions = Array.isArray(request.questions) ? request.questions : [];
  const [selectedOptionByQuestion, setSelectedOptionByQuestion] = useState<Record<string, number>>(
    {},
  );
  const [otherTextByQuestion, setOtherTextByQuestion] = useState<Record<string, string>>({});
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(0);
  const reviewRequestKey = `${request.taskId}:${request.id}:${request.requestedAt}:${request.status}:${JSON.stringify(request.questions)}`;
  const [responsibilityReviewState, setResponsibilityReviewState] = useState<{
    key: string;
    state: Exclude<ReviewDecisionState, "pending">;
  }>();
  const reviewDecisionState: ReviewDecisionState =
    responsibilityReviewState?.key === reviewRequestKey
      ? responsibilityReviewState.state
      : "pending";
  const onResponsibilityActionReviewStateChange = useCallback(
    (key: string, state: "valid" | "invalid") => setResponsibilityReviewState({ key, state }),
    [],
  );

  useEffect(() => {
    const nextSelected: Record<string, number> = {};
    for (const question of questions) {
      if (typeof question?.id === "string" && question.id.trim()) {
        const safeDefault =
          question.id === RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID
            ? question.options.findIndex(
                (option) => option.label.trim().toLowerCase() === "deny once",
              )
            : -1;
        nextSelected[question.id] = safeDefault >= 0 ? safeDefault : 0;
      }
    }
    setSelectedOptionByQuestion(nextSelected);
    setOtherTextByQuestion({});
    setActiveQuestionIndex(0);
  }, [request.id, questions]);

  const updateSelection = useCallback((questionId: string, nextIndex: number) => {
    setSelectedOptionByQuestion((prev) => ({
      ...prev,
      [questionId]: Math.max(0, nextIndex),
    }));
  }, []);

  const isQuestionAnswered = useCallback(
    (question: InputRequest["questions"][number]) => {
      if (!question || typeof question?.id !== "string") return false;
      const selected = selectedOptionByQuestion[question.id];
      if (typeof selected !== "number") return false;
      const options = Array.isArray(question.options) ? question.options : [];
      const isOther = selected === options.length;
      if (!isOther)
        return responsibilityActionReviewDecisionAllowed(question, selected, reviewDecisionState);
      if (question.id === RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID) return false;
      return (otherTextByQuestion[question.id] || "").trim().length > 0;
    },
    [otherTextByQuestion, reviewDecisionState, selectedOptionByQuestion],
  );

  const activeQuestion = useMemo(() => {
    if (!questions.length) return null;
    const safeIndex = Math.max(0, Math.min(questions.length - 1, activeQuestionIndex));
    return questions[safeIndex] ?? null;
  }, [activeQuestionIndex, questions]);

  const activeOptions = useMemo(
    () => (activeQuestion && Array.isArray(activeQuestion.options) ? activeQuestion.options : []),
    [activeQuestion],
  );
  const activeIsResponsibilityReview =
    activeQuestion?.id === RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID;
  const visibleOptions = useMemo(
    () =>
      activeOptions
        .map((option, optionIndex) => ({ option, optionIndex }))
        .filter(
          ({ option }) =>
            !activeIsResponsibilityReview ||
            ["deny once", "allow once"].includes(option.label.trim().toLowerCase()),
        ),
    [activeIsResponsibilityReview, activeOptions],
  );
  const activeSelected =
    activeQuestion && typeof selectedOptionByQuestion[activeQuestion.id] === "number"
      ? selectedOptionByQuestion[activeQuestion.id]
      : 0;
  const activeOtherSelected =
    !activeIsResponsibilityReview && activeSelected === activeOptions.length;

  const getActiveOptionCount = useCallback(
    () => visibleOptions.length + (activeIsResponsibilityReview ? 0 : 1),
    [activeIsResponsibilityReview, visibleOptions.length],
  );

  const goToNextQuestion = useCallback(() => {
    setActiveQuestionIndex((prev) => Math.min(questions.length - 1, prev + 1));
  }, [questions.length]);

  const goToPreviousQuestion = useCallback(() => {
    setActiveQuestionIndex((prev) => Math.max(0, prev - 1));
  }, []);

  const currentQuestionAnswered = useMemo(
    () => (activeQuestion ? isQuestionAnswered(activeQuestion) : false),
    [activeQuestion, isQuestionAnswered],
  );

  const canSubmit = useMemo(
    () =>
      questions.length > 0 &&
      questions.every(
        (question) =>
          isQuestionAnswered(question) &&
          responsibilityActionReviewDecisionAllowed(
            question,
            selectedOptionByQuestion[question.id],
            reviewDecisionState,
          ),
      ),
    [isQuestionAnswered, questions, reviewDecisionState, selectedOptionByQuestion],
  );

  const buildAnswers = useCallback((): InputRequestAnswers => {
    const answers: InputRequestAnswers = {};
    for (const question of questions) {
      const selected = selectedOptionByQuestion[question.id];
      if (typeof selected !== "number") continue;
      if (selected < question.options.length) {
        answers[question.id] = {
          optionLabel: question.options[selected]?.label,
        };
      } else {
        answers[question.id] = {
          otherText: (otherTextByQuestion[question.id] || "").trim(),
        };
      }
    }
    return answers;
  }, [otherTextByQuestion, questions, selectedOptionByQuestion]);

  const submitIfAllowed = useCallback(() => {
    if (canSubmit) onSubmit(buildAnswers());
  }, [buildAnswers, canSubmit, onSubmit]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!questions.length || !activeQuestion) return;
      // A modal on top (e.g. the image lightbox) handles Esc and the other shortcuts itself.
      if (keyEventFromModalDialog(event.target)) return;

      if (event.key === "Escape") {
        event.preventDefault();
        onDismiss();
        return;
      }

      const activeElement = document.activeElement as HTMLElement | null;
      const activeTag = activeElement?.tagName?.toLowerCase();
      const typingInInput = activeTag === "textarea" || activeTag === "input";
      const selected = selectedOptionByQuestion[activeQuestion.id] ?? 0;
      const optionCount = getActiveOptionCount();

      // Modified digits are app shortcuts (⌘1–⌘9 open rail destinations), not option picks.
      const modified = event.metaKey || event.ctrlKey || event.altKey;
      if (/^[1-4]$/.test(event.key) && !typingInInput && !modified) {
        const nextIndex = Number(event.key) - 1;
        if (nextIndex < visibleOptions.length) {
          const option = visibleOptions[nextIndex];
          const allowed =
            !activeIsResponsibilityReview ||
            option.option.label.trim().toLowerCase() !== "allow once" ||
            reviewDecisionState === "valid";
          if (!allowed) return;
          event.preventDefault();
          updateSelection(activeQuestion.id, option.optionIndex);
        } else if (
          !activeIsResponsibilityReview &&
          nextIndex === visibleOptions.length &&
          nextIndex < optionCount
        ) {
          event.preventDefault();
          updateSelection(activeQuestion.id, activeOptions.length);
        }
        return;
      }

      if (event.key === "ArrowUp" && !typingInInput) {
        event.preventDefault();
        const currentIndex = Math.max(
          0,
          visibleOptions.findIndex((option) => option.optionIndex === selected),
        );
        const option = visibleOptions[Math.max(0, currentIndex - 1)];
        if (option) updateSelection(activeQuestion.id, option.optionIndex);
        return;
      }
      if (event.key === "ArrowDown" && !typingInInput) {
        event.preventDefault();
        const currentIndex = visibleOptions.findIndex((option) => option.optionIndex === selected);
        const option =
          visibleOptions[Math.min(visibleOptions.length - 1, Math.max(0, currentIndex) + 1)];
        if (option) updateSelection(activeQuestion.id, option.optionIndex);
        return;
      }

      if (event.key === "ArrowLeft" && !typingInInput) {
        event.preventDefault();
        goToPreviousQuestion();
        return;
      }
      if (event.key === "ArrowRight" && !typingInInput) {
        event.preventDefault();
        if (activeQuestionIndex < questions.length - 1 && currentQuestionAnswered) {
          goToNextQuestion();
        }
        return;
      }

      if (event.key === "Enter" && !typingInInput) {
        event.preventDefault();
        if (activeQuestionIndex < questions.length - 1) {
          if (currentQuestionAnswered) {
            goToNextQuestion();
          }
          return;
        }
        if (canSubmit) {
          submitIfAllowed();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    activeQuestion,
    activeQuestionIndex,
    buildAnswers,
    canSubmit,
    currentQuestionAnswered,
    getActiveOptionCount,
    goToNextQuestion,
    goToPreviousQuestion,
    onDismiss,
    onSubmit,
    questions,
    selectedOptionByQuestion,
    updateSelection,
    visibleOptions,
    activeIsResponsibilityReview,
    reviewDecisionState,
    activeOptions,
    submitIfAllowed,
  ]);

  if (!activeQuestion) {
    return null;
  }

  const optionShortcutCount = Math.min(4, getActiveOptionCount());
  const isLastQuestion = activeQuestionIndex >= questions.length - 1;

  return (
    <div
      className="input-request-composer-shell"
      role="region"
      aria-label="Structured input required"
    >
      <div className="input-request-card input-request-card-inline">
        <div className="input-request-progress">
          <span className="input-request-header">{activeQuestion.header || "Question"}</span>
          {questions.length > 1 && (
            <span
              className="input-request-steps"
              aria-label={`Question ${activeQuestionIndex + 1} of ${questions.length}`}
            >
              {questions.map((question, index) => (
                <span
                  key={question.id || index}
                  className={`input-request-step${index === activeQuestionIndex ? " active" : ""}${
                    index < activeQuestionIndex ? " done" : ""
                  }`}
                />
              ))}
            </span>
          )}
        </div>
        <InlineApprovalDraftReview
          request={request}
          onResponsibilityActionReviewStateChange={onResponsibilityActionReviewStateChange}
        />
        <div className="input-request-title">{activeQuestion.question}</div>
        <div
          className="input-request-options"
          role="radiogroup"
          aria-label={activeQuestion.question}
        >
          {visibleOptions.map(({ option, optionIndex }, displayIndex) => (
            <button
              key={`${activeQuestion.id}-option-${optionIndex}`}
              type="button"
              role="radio"
              aria-checked={activeSelected === optionIndex}
              className={`input-request-option ${activeSelected === optionIndex ? "selected" : ""}`}
              disabled={responsibilityActionReviewOptionDisabled(
                activeQuestion,
                optionIndex,
                reviewDecisionState,
              )}
              onClick={() => {
                updateSelection(activeQuestion.id, optionIndex);
              }}
            >
              <span className="input-request-option-index" aria-hidden="true">
                {displayIndex + 1}
              </span>
              <span className="input-request-option-copy">
                <span className="input-request-option-label">{option.label}</span>
                {option.description && (
                  <span className="input-request-option-description">{option.description}</span>
                )}
              </span>
            </button>
          ))}
          {!activeIsResponsibilityReview && (
            <button
              type="button"
              role="radio"
              aria-checked={activeOtherSelected}
              className={`input-request-option ${activeOtherSelected ? "selected" : ""}`}
              onClick={() => {
                updateSelection(activeQuestion.id, activeOptions.length);
              }}
            >
              <span className="input-request-option-index" aria-hidden="true">
                {visibleOptions.length + 1}
              </span>
              <span className="input-request-option-copy">
                <span className="input-request-option-label">Other</span>
                <span className="input-request-option-description">Type a custom response</span>
              </span>
            </button>
          )}
          {activeOtherSelected && (
            <textarea
              className="input-request-other"
              placeholder="Type your answer…"
              aria-label="Your answer"
              rows={2}
              autoFocus
              value={otherTextByQuestion[activeQuestion.id] || ""}
              onChange={(event) =>
                setOtherTextByQuestion((prev) => ({
                  ...prev,
                  [activeQuestion.id]: event.target.value,
                }))
              }
            />
          )}
        </div>
        <div className="input-request-actions">
          <span className="input-request-keys" aria-hidden="true">
            <kbd>1–{optionShortcutCount}</kbd> choose
            <kbd>↵</kbd> {isLastQuestion ? "submit" : "next"}
            <kbd>esc</kbd> dismiss
          </span>
          <button type="button" className="input-request-dismiss" onClick={onDismiss}>
            Dismiss
          </button>
          {activeQuestionIndex > 0 && (
            <button type="button" className="input-request-dismiss" onClick={goToPreviousQuestion}>
              Back
            </button>
          )}
          {isLastQuestion ? (
            <button
              type="button"
              className="input-request-submit"
              onClick={submitIfAllowed}
              disabled={!canSubmit}
            >
              Submit
            </button>
          ) : (
            <button
              type="button"
              className="input-request-submit"
              onClick={goToNextQuestion}
              disabled={!currentQuestionAnswered}
            >
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
