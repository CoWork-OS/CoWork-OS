import { useState, useEffect, useCallback, useMemo } from "react";
import type { InputRequest } from "../../../shared/types";

export type InputRequestAnswers = Record<string, { optionLabel?: string; otherText?: string }>;

interface StructuredInputPromptCardProps {
  request: InputRequest;
  onSubmit: (answers: InputRequestAnswers) => void;
  onDismiss: () => void;
}

export function StructuredInputPromptCard({ request, onSubmit, onDismiss }: StructuredInputPromptCardProps) {
  const questions = Array.isArray(request.questions) ? request.questions : [];
  const [selectedOptionByQuestion, setSelectedOptionByQuestion] = useState<Record<string, number>>({});
  const [otherTextByQuestion, setOtherTextByQuestion] = useState<Record<string, string>>({});
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(0);

  useEffect(() => {
    const nextSelected: Record<string, number> = {};
    for (const question of questions) {
      if (typeof question?.id === "string" && question.id.trim()) {
        nextSelected[question.id] = 0;
      }
    }
    setSelectedOptionByQuestion(nextSelected);
    setOtherTextByQuestion({});
    setActiveQuestionIndex(0);
  }, [request.id, questions]);

  const updateSelection = useCallback(
    (questionId: string, nextIndex: number) => {
      setSelectedOptionByQuestion((prev) => ({
        ...prev,
        [questionId]: Math.max(0, nextIndex),
      }));
    },
    [],
  );

  const isQuestionAnswered = useCallback(
    (question: InputRequest["questions"][number]) => {
      if (!question || typeof question?.id !== "string") return false;
      const selected = selectedOptionByQuestion[question.id];
      if (typeof selected !== "number") return false;
      const options = Array.isArray(question.options) ? question.options : [];
      const isOther = selected === options.length;
      if (!isOther) return true;
      return (otherTextByQuestion[question.id] || "").trim().length > 0;
    },
    [otherTextByQuestion, selectedOptionByQuestion],
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
  const activeSelected =
    activeQuestion && typeof selectedOptionByQuestion[activeQuestion.id] === "number"
      ? selectedOptionByQuestion[activeQuestion.id]
      : 0;
  const activeOtherSelected = activeSelected === activeOptions.length;

  const getActiveOptionCount = useCallback(() => activeOptions.length + 1, [activeOptions.length]);

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
    () => questions.length > 0 && questions.every((question) => isQuestionAnswered(question)),
    [isQuestionAnswered, questions],
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!questions.length || !activeQuestion) return;

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

      if (/^[1-4]$/.test(event.key) && !typingInInput) {
        const nextIndex = Number(event.key) - 1;
        if (nextIndex < optionCount) {
          event.preventDefault();
          updateSelection(activeQuestion.id, nextIndex);
        }
        return;
      }

      if (event.key === "ArrowUp" && !typingInInput) {
        event.preventDefault();
        updateSelection(activeQuestion.id, Math.max(0, selected - 1));
        return;
      }
      if (event.key === "ArrowDown" && !typingInInput) {
        event.preventDefault();
        updateSelection(activeQuestion.id, Math.min(optionCount - 1, selected + 1));
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
          onSubmit(buildAnswers());
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
  ]);

  if (!activeQuestion) {
    return null;
  }

  return (
    <div className="input-request-composer-shell" role="dialog" aria-modal="true" aria-label="Structured input required">
      <div className="input-request-card input-request-card-inline">
        <div className="input-request-progress">
          <span className="input-request-header">{activeQuestion.header || "Question"}</span>
          <span className="input-request-progress-index">
            {Math.min(activeQuestionIndex + 1, questions.length)} / {questions.length}
          </span>
        </div>
        <div className="input-request-title">{activeQuestion.question}</div>
        <div className="input-request-options">
          {activeOptions.map((option, optionIndex) => (
            <button
              key={`${activeQuestion.id}-option-${optionIndex}`}
              className={`input-request-option ${activeSelected === optionIndex ? "selected" : ""}`}
              onClick={() => {
                updateSelection(activeQuestion.id, optionIndex);
              }}
            >
              <span className="input-request-option-index">{optionIndex + 1}.</span>
              <span className="input-request-option-copy">
                <span className="input-request-option-label">{option.label}</span>
                <span className="input-request-option-description">{option.description}</span>
              </span>
            </button>
          ))}
          <button
            className={`input-request-option ${activeOtherSelected ? "selected" : ""}`}
            onClick={() => {
              updateSelection(activeQuestion.id, activeOptions.length);
            }}
          >
            <span className="input-request-option-index">{activeOptions.length + 1}.</span>
            <span className="input-request-option-copy">
              <span className="input-request-option-label">Other</span>
              <span className="input-request-option-description">Type a custom response</span>
            </span>
          </button>
        </div>
        {activeOtherSelected && (
          <textarea
            className="input-request-other"
            placeholder="Tell Codex what to do differently..."
            value={otherTextByQuestion[activeQuestion.id] || ""}
            onChange={(event) =>
              setOtherTextByQuestion((prev) => ({
                ...prev,
                [activeQuestion.id]: event.target.value,
              }))
            }
          />
        )}
        <div className="input-request-hint">Use 1-4 to choose, Enter to continue, Esc to dismiss.</div>
        <div className="input-request-actions">
          <button className="input-request-dismiss" onClick={onDismiss}>
            Dismiss
          </button>
          <button
            className="input-request-dismiss"
            onClick={goToPreviousQuestion}
            disabled={activeQuestionIndex === 0}
          >
            Back
          </button>
          {activeQuestionIndex < questions.length - 1 ? (
            <button
              className="input-request-submit"
              onClick={goToNextQuestion}
              disabled={!currentQuestionAnswered}
            >
              Next
            </button>
          ) : (
            <button
              className="input-request-submit"
              onClick={() => onSubmit(buildAnswers())}
              disabled={!canSubmit}
            >
              Submit
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
