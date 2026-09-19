import type {
  JevChoiceQuestion,
  JevContent,
  JevJsonValue,
  JevQuestion,
  JevQuestions,
  JevRequest,
  JevRequestPayload,
  JevScoreQuestion,
} from "./types";
import { DecisionClientError } from "./http-client";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown, seen: Set<object>): value is JevJsonValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    const valid = value.every((item) => isJsonValue(item, seen));
    seen.delete(value);
    return valid;
  }
  if (!isPlainObject(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Object.values(value).every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
}

function isContent(value: unknown): value is JevContent {
  if (typeof value === "string" || value === null) return true;
  if (Array.isArray(value)) return isJsonValue(value, new Set());
  return isPlainObject(value) && isJsonValue(value, new Set());
}

function validationError(message: string): DecisionClientError {
  return new DecisionClientError("validation", message, { provider: "Jev" });
}

function assertContent(value: unknown, path: string): asserts value is JevContent {
  if (!isContent(value)) {
    throw validationError(
      `${path} must be text or JSON-compatible structured content; unsupported non-text content was provided.`,
    );
  }
}

function assertQuestion(question: unknown, path: string): asserts question is JevQuestion {
  if (!isPlainObject(question)) {
    throw validationError(`${path} must be an object with a supported Jev question type.`);
  }
  if (question.type !== "noul" && question.type !== "choice" && question.type !== "score") {
    throw validationError(`${path}.type must be one of "noul", "choice", or "score".`);
  }
  if (!("instructions" in question)) {
    throw validationError(`${path}.instructions is required.`);
  }
  assertContent(question.instructions, `${path}.instructions`);

  if (question.type === "noul") {
    if (question.criteria === undefined) return;
    if (!isPlainObject(question.criteria)) {
      throw validationError(`${path}.criteria must describe the true and false outcomes.`);
    }
    for (const key of ["true", "false"] as const) {
      if (key in question.criteria)
        assertContent(question.criteria[key], `${path}.criteria.${key}`);
    }
    return;
  }

  if (question.type === "choice") {
    const choice = question as unknown as JevChoiceQuestion;
    if (!isPlainObject(choice.criteria) || Object.keys(choice.criteria).length < 2) {
      throw validationError(`${path}.criteria must contain at least two choice options.`);
    }
    for (const [key, value] of Object.entries(choice.criteria)) {
      if (!key.trim()) throw validationError(`${path}.criteria contains an empty option name.`);
      assertContent(value, `${path}.criteria.${key}`);
    }
    return;
  }

  const score = question as unknown as JevScoreQuestion;
  if (!Array.isArray(score.criteria) || score.criteria.length < 2) {
    throw validationError(`${path}.criteria must contain at least two ordered score levels.`);
  }
  score.criteria.forEach((value, index) => assertContent(value, `${path}.criteria[${index}]`));
}

export function validateJevRequest(request: JevRequest): void {
  if (!request || typeof request !== "object") {
    throw validationError("A Jev request object is required.");
  }
  assertContent(request.state, "state");
  if (request.state === null) {
    throw validationError("state must be a string, JSON object, or array; null is not supported.");
  }
  if (request.model !== undefined && (typeof request.model !== "string" || !request.model.trim())) {
    throw validationError("model must be a non-empty string when provided.");
  }
  if (!isPlainObject(request.questions) || Object.keys(request.questions).length === 0) {
    throw validationError("questions must be a non-empty object keyed by question id.");
  }
  for (const [id, question] of Object.entries(request.questions)) {
    if (!id.trim()) throw validationError("questions cannot contain an empty question id.");
    assertQuestion(question, `questions.${id}`);
  }
}

export function createJevRequestPayload(
  request: JevRequest,
  defaultModel: string,
): JevRequestPayload {
  validateJevRequest(request);
  const model = request.model ?? defaultModel;
  if (!model.trim()) throw validationError("A non-empty Jev model is required.");
  return {
    state: request.state,
    model,
    questions: request.questions as JevQuestions,
  };
}

export function isJsonCompatible(value: unknown): value is JevJsonValue {
  return isJsonValue(value, new Set());
}
