/** JSON-compatible values accepted by Jev state and question content. */
export type JevJsonValue =
  | string
  | number
  | boolean
  | null
  | JevJsonValue[]
  | { [key: string]: JevJsonValue };

/** A Jev state is text or structured JSON content. */
export type JevState = string | { [key: string]: JevJsonValue } | JevJsonValue[];

/** Text, a JSON object or array, or null for optional descriptions. */
export type JevContent = string | { [key: string]: JevJsonValue } | JevJsonValue[] | null;

export interface JevNoulCriteria {
  true?: JevContent;
  false?: JevContent;
}

export interface JevNoulQuestion {
  type: "noul";
  instructions: JevContent;
  criteria?: JevNoulCriteria;
}

export type JevChoiceCriteria = Record<string, JevContent>;

export interface JevChoiceQuestion {
  type: "choice";
  instructions: JevContent;
  criteria: JevChoiceCriteria;
}

export type JevScoreCriteria = readonly [JevContent, JevContent, ...JevContent[]];

export interface JevScoreQuestion {
  type: "score";
  instructions: JevContent;
  criteria: JevScoreCriteria;
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;
export type JevQuestions = Record<string, JevQuestion>;

export interface JevNoulAnswer {
  type: "noul";
  noul: number;
}

export interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface JevScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, JevContent>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export interface JevUsage {
  input_tokens: number;
  output_tokens: number;
  cost?: number;
  [key: string]: unknown;
}

export type JevProviderMetadata = string | { [key: string]: JevJsonValue };

export interface JevRequest<Q extends JevQuestions = JevQuestions> {
  state: JevState;
  questions: Q;
  model?: string;
}

export interface JevRequestPayload<Q extends JevQuestions = JevQuestions> extends Omit<
  JevRequest<Q>,
  "model"
> {
  model: string;
}

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: JevUsage;
  provider?: JevProviderMetadata;
  id?: string;
}

export interface DecisionRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

export interface DecisionConnectionResult {
  success: boolean;
  error?: string;
  status?: number;
  model?: string;
  provider?: JevProviderMetadata;
}
