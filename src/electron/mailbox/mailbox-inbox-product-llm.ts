import { LLMProviderFactory } from "../agent/llm/provider-factory";
import { recordLlmCallError, recordLlmCallSuccess } from "../agent/llm/usage-telemetry";
import type { LLMMessage } from "../agent/llm/types";

const QUICK_REPLY_MAX_TOKENS = 500;
const SIMILAR_THREADS_MAX_TOKENS = 1400;

function chooseCheapMailboxModel(): { providerType: string; modelKey: string; modelId: string } | null {
  try {
    const settings = LLMProviderFactory.loadSettings();
    const providerType = settings.providerType;
    const routing = LLMProviderFactory.getProviderRoutingSettings(settings, providerType);
    const preferredKey =
      routing.automatedTaskModelKey || routing.cheapModelKey || settings.modelKey || "";
    if (!preferredKey) return null;
    const selection = LLMProviderFactory.resolveTaskModelSelection({
      providerType,
      modelKey: preferredKey,
    });
    return {
      providerType: selection.providerType,
      modelKey: selection.modelKey,
      modelId: selection.modelId,
    };
  } catch {
    return null;
  }
}

function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return "{}";
  return text.slice(start, end + 1);
}

export async function mailboxLlmQuickReplies(input: {
  workspaceId: string;
  threadId: string;
  subject: string;
  summary: string;
  latestSnippet: string;
}): Promise<{ suggestions: string[]; error?: string }> {
  const modelSelection = chooseCheapMailboxModel();
  if (!modelSelection) {
    return {
      suggestions: [],
      error: "No AI model configured for mailbox suggestions. Choose a model in Settings.",
    };
  }

  const provider = LLMProviderFactory.createProvider();
  const system = [
    "You help write short email replies.",
    "Return strict JSON only: { \"suggestions\": string[] }",
    "Provide exactly 3 suggestions, each under 220 characters, professional and actionable.",
    "Do not include signatures or placeholder names; use neutral wording.",
  ].join(" ");

  const messages: LLMMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              threadId: input.threadId,
              subject: input.subject,
              summary: input.summary,
              latestSnippet: input.latestSnippet,
            },
            null,
            2,
          ),
        },
      ],
    },
  ];

  try {
    const response = await provider.createMessage({
      model: modelSelection.modelId,
      maxTokens: QUICK_REPLY_MAX_TOKENS,
      system,
      messages,
    });
    recordLlmCallSuccess(
      {
        workspaceId: input.workspaceId,
        sourceKind: "mailbox_quick_reply",
        sourceId: input.threadId,
        providerType: provider.type,
        modelKey: modelSelection.modelKey,
        modelId: modelSelection.modelId,
      },
      response.usage,
    );
    const text = response.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n")
      .trim();
    const jsonText = extractJsonObject(text);
    const parsed = JSON.parse(jsonText) as { suggestions?: unknown };
    const raw = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
    const out = raw
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .map((s) => s.trim().slice(0, 280));
    return { suggestions: out.slice(0, 3) };
  } catch (error) {
    recordLlmCallError(
      {
        workspaceId: input.workspaceId,
        sourceKind: "mailbox_quick_reply",
        sourceId: input.threadId,
        providerType: provider.type,
        modelKey: modelSelection.modelKey,
        modelId: modelSelection.modelId,
      },
      error,
    );
    return { suggestions: [], error: "Could not generate quick replies. Check your AI connection and try again." };
  }
}

export type SimilarThreadCandidate = { threadId: string; subject: string; snippet: string };

export async function mailboxLlmSimilarThreadIds(input: {
  workspaceId: string;
  seedThreadId: string;
  seedSubject: string;
  seedSnippet: string;
  seedSummary: string;
  viewName: string;
  instructions: string;
  candidates: SimilarThreadCandidate[];
}): Promise<{ threadIds: string[]; rationale?: string; error?: string }> {
  const modelSelection = chooseCheapMailboxModel();
  if (!modelSelection) {
    return {
      threadIds: [],
      error: "No AI model configured for saved view preview. Choose a model in Settings.",
    };
  }

  const provider = LLMProviderFactory.createProvider();
  const system = [
    "You match email threads to a user-defined saved view.",
    "Return strict JSON only:",
    '{ "matches": [ { "threadId": string, "score": number } ], "rationale": string }',
    "score is 0.0 to 1.0 for similarity to the seed thread and instructions.",
    "Include threads that plausibly belong in the same bucket as the seed.",
    "Exclude the seed thread id from matches if present.",
    "Cap matches at 35 entries, scores >= 0.35.",
  ].join(" ");

  const messages: LLMMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              viewName: input.viewName,
              instructions: input.instructions,
              seed: {
                threadId: input.seedThreadId,
                subject: input.seedSubject,
                snippet: input.seedSnippet,
                summary: input.seedSummary,
              },
              candidates: input.candidates.map((c) => ({
                threadId: c.threadId,
                subject: c.subject,
                snippet: c.snippet,
              })),
            },
            null,
            2,
          ),
        },
      ],
    },
  ];

  try {
    const response = await provider.createMessage({
      model: modelSelection.modelId,
      maxTokens: SIMILAR_THREADS_MAX_TOKENS,
      system,
      messages,
    });
    recordLlmCallSuccess(
      {
        workspaceId: input.workspaceId,
        sourceKind: "mailbox_saved_view_preview",
        sourceId: input.seedThreadId,
        providerType: provider.type,
        modelKey: modelSelection.modelKey,
        modelId: modelSelection.modelId,
      },
      response.usage,
    );
    const text = response.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n")
      .trim();
    const jsonText = extractJsonObject(text);
    const parsed = JSON.parse(jsonText) as {
      matches?: Array<{ threadId?: string; score?: number }>;
      rationale?: string;
    };
    const matches = Array.isArray(parsed.matches) ? parsed.matches : [];
    const ids = matches
      .filter((m) => typeof m.threadId === "string" && typeof m.score === "number" && m.score >= 0.35)
      .filter((m) => m.threadId !== input.seedThreadId)
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .map((m) => m.threadId as string)
      .slice(0, 40);
    return {
      threadIds: ids,
      rationale: typeof parsed.rationale === "string" ? parsed.rationale : undefined,
    };
  } catch (error) {
    recordLlmCallError(
      {
        workspaceId: input.workspaceId,
        sourceKind: "mailbox_saved_view_preview",
        sourceId: input.seedThreadId,
        providerType: provider.type,
        modelKey: modelSelection.modelKey,
        modelId: modelSelection.modelId,
      },
      error,
    );
    return {
      threadIds: [],
      error: "Could not preview similar threads. Check your AI connection and try again.",
    };
  }
}
