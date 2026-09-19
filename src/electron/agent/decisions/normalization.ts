import type {
  JevAnswer,
  JevChoiceAnswer,
  JevContent,
  JevJsonValue,
  JevNoulAnswer,
  JevQuestion,
  JevRequestPayload,
  JevResponse,
  JevScoreAnswer,
  JevUsage,
} from "./types";
import { DecisionClientError } from "./http-client";
import { isJsonCompatible } from "./validation";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownProperty(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function responseError(providerName: string, detail: string): DecisionClientError {
  return new DecisionClientError(
    "response",
    `${providerName} returned an invalid Jev response: ${detail}`,
    { provider: providerName },
  );
}

function requiredRecord(
  value: unknown,
  path: string,
  providerName: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw responseError(providerName, `${path} must be an object.`);
  return value;
}

function requiredString(value: unknown, path: string, providerName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw responseError(providerName, `${path} must be a non-empty string.`);
  }
  return value;
}

function requiredNumber(value: unknown, path: string, providerName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw responseError(providerName, `${path} must be a finite number.`);
  }
  return value;
}

function probabilityMap(
  value: unknown,
  path: string,
  providerName: string,
): Record<string, number> {
  const record = requiredRecord(value, path, providerName);
  const result: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [key, probability] of Object.entries(record)) {
    const number = requiredNumber(probability, `${path} entry`, providerName);
    if (number < 0 || number > 1) {
      throw responseError(providerName, `${path} contains a probability outside 0..1.`);
    }
    result[key] = number;
  }
  return result;
}

function contentRecord(
  value: unknown,
  path: string,
  providerName: string,
): Record<string, JevContent> {
  const record = requiredRecord(value, path, providerName);
  const result: Record<string, JevContent> = Object.create(null) as Record<string, JevContent>;
  for (const [key, content] of Object.entries(record)) {
    if (!isJsonCompatible(content) || !isContent(content)) {
      throw responseError(providerName, `${path} contains unsupported content.`);
    }
    result[key] = content;
  }
  return result;
}

function isContent(value: unknown): value is JevContent {
  return value === null || typeof value === "string" || isRecord(value) || Array.isArray(value);
}

function normalizeAnswer(
  value: unknown,
  expectedType: JevQuestion["type"] | undefined,
  path: string,
  providerName: string,
): JevAnswer {
  const answer = requiredRecord(value, path, providerName);
  const type = answer.type;
  if (type !== "noul" && type !== "choice" && type !== "score") {
    throw responseError(providerName, `${path}.type is unsupported.`);
  }
  if (expectedType && type !== expectedType) {
    throw responseError(providerName, `${path}.type does not match the requested question.`);
  }

  if (type === "noul") {
    const noul: JevNoulAnswer = {
      type,
      noul: requiredNumber(answer.noul, `${path}.noul`, providerName),
    };
    if (noul.noul < 0 || noul.noul > 1) {
      throw responseError(providerName, `${path}.noul must be between 0 and 1.`);
    }
    return noul;
  }

  if (type === "choice") {
    const choice: JevChoiceAnswer = {
      type,
      choice: requiredString(answer.choice, `${path}.choice`, providerName),
      probabilities: probabilityMap(answer.probabilities, `${path}.probabilities`, providerName),
      confidence: requiredNumber(answer.confidence, `${path}.confidence`, providerName),
    };
    if (choice.confidence < 0 || choice.confidence > 1) {
      throw responseError(providerName, `${path}.confidence must be between 0 and 1.`);
    }
    return choice;
  }

  const score: JevScoreAnswer = {
    type,
    score: requiredNumber(answer.score, `${path}.score`, providerName),
    legend: contentRecord(answer.legend, `${path}.legend`, providerName),
    probabilities: probabilityMap(answer.probabilities, `${path}.probabilities`, providerName),
    confidence: requiredNumber(answer.confidence, `${path}.confidence`, providerName),
  };
  if (score.confidence < 0 || score.confidence > 1) {
    throw responseError(providerName, `${path}.confidence must be between 0 and 1.`);
  }
  return score;
}

function usageNumber(
  usage: Record<string, unknown>,
  snakeName: string,
  camelName: string,
  providerName: string,
): number {
  return requiredNumber(usage[snakeName] ?? usage[camelName], `usage.${snakeName}`, providerName);
}

function normalizeUsage(value: unknown, providerName: string): JevUsage {
  const raw = requiredRecord(value, "usage", providerName);
  const usage: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(raw)) {
    if (
      key !== "input_tokens" &&
      key !== "output_tokens" &&
      key !== "inputTokens" &&
      key !== "outputTokens"
    ) {
      usage[key] = item;
    }
  }
  const inputTokens = usageNumber(raw, "input_tokens", "inputTokens", providerName);
  const outputTokens = usageNumber(raw, "output_tokens", "outputTokens", providerName);
  usage.input_tokens = inputTokens;
  usage.output_tokens = outputTokens;
  if (inputTokens < 0 || outputTokens < 0) {
    throw responseError(providerName, "usage token counts cannot be negative.");
  }
  if (raw.cost !== undefined) usage.cost = requiredNumber(raw.cost, "usage.cost", providerName);
  return usage as JevUsage;
}

function normalizeProvider(value: unknown, providerName: string): JevResponse["provider"] {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim()) return value;
  if (isRecord(value) && isJsonCompatible(value)) return value as { [key: string]: JevJsonValue };
  throw responseError(providerName, "provider must be a string or JSON object when present.");
}

function unwrapResponse(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  if ("answers" in value) return value;
  for (const key of ["data", "result", "response"]) {
    const nested = value[key];
    if (isRecord(nested) && "answers" in nested) return nested;
  }
  return value;
}

export function normalizeJevResponse(
  value: unknown,
  request: JevRequestPayload,
  providerName: string,
): JevResponse {
  const response = unwrapResponse(value);
  const model = requiredString(response.model, "model", providerName);
  const rawAnswers = requiredRecord(response.answers, "answers", providerName);
  const answers: Record<string, JevAnswer> = Object.create(null) as Record<string, JevAnswer>;

  let answerIndex = 0;
  for (const [id, answer] of Object.entries(rawAnswers)) {
    if (!ownProperty(request.questions, id)) {
      throw responseError(providerName, "answers contains an unexpected question id.");
    }
    const question = request.questions[id];
    if (!question) {
      throw responseError(providerName, "answers contains an unexpected question id.");
    }
    answers[id] = normalizeAnswer(answer, question.type, `answers[${answerIndex}]`, providerName);
    answerIndex += 1;
  }
  for (const id of Object.keys(request.questions)) {
    if (!ownProperty(answers, id)) {
      throw responseError(providerName, "answers is missing one or more requested questions.");
    }
  }

  const normalized: JevResponse = {
    model,
    answers,
    usage: normalizeUsage(response.usage, providerName),
  };
  const provider = normalizeProvider(response.provider, providerName);
  if (provider !== undefined) normalized.provider = provider;
  if (response.id !== undefined) normalized.id = requiredString(response.id, "id", providerName);
  return normalized;
}
