import type { LLMProvider } from "../agent/llm/types";

export type ProbeStatus = "pass" | "fail" | "unknown";

export interface FirstTaskModelPreflight {
  endpoint: ProbeStatus;
  model: ProbeStatus;
  toolCalls: ProbeStatus;
  reason?: "authentication" | "endpoint" | "model" | "tool_support" | "timeout";
}

/** One explicit, small inference call verifies the selected model can request a tool. */
export async function probeFirstTaskModel(
  provider: Pick<LLMProvider, "createMessage">,
  modelId: string,
  timeoutMs = 20_000,
): Promise<FirstTaskModelPreflight> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const request = provider.createMessage({
      model: modelId,
      // Reasoning tokens count against the output budget, so keep effort low and leave
      // room for the tool call; a tiny budget makes reasoning models look tool-less.
      maxTokens: 1024,
      reasoningEffort: "low",
      system:
        "Check tool-call support. Call sample_probe with the code OK. Do not answer in prose.",
      messages: [{ role: "user", content: "Call sample_probe now." }],
      tools: [
        {
          name: "sample_probe",
          description: "Harmless capability check; no file or network operation occurs.",
          input_schema: {
            type: "object",
            properties: { code: { type: "string" } },
            required: ["code"],
          },
        },
      ],
      toolChoice: "auto",
      signal: controller.signal,
    });
    const response = await Promise.race([
      request,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          reject(new Error("First task model probe timed out"));
        }, timeoutMs);
      }),
    ]);
    const usedTool = response.content.some(
      (item) =>
        item.type === "tool_use" &&
        item.name === "sample_probe" &&
        item.input?.code === "OK" &&
        !item.inputError,
    );
    return {
      endpoint: "pass",
      model: "pass",
      toolCalls: usedTool ? "pass" : "fail",
      ...(usedTool ? {} : { reason: "tool_support" as const }),
    };
  } catch (error) {
    const status =
      typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 0;
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (controller.signal.aborted || /timeout|timed out/.test(message)) {
      return { endpoint: "unknown", model: "unknown", toolCalls: "unknown", reason: "timeout" };
    }
    if (
      status === 401 ||
      status === 403 ||
      /unauthori[sz]ed|invalid api key|authentication/.test(message)
    ) {
      return { endpoint: "fail", model: "unknown", toolCalls: "unknown", reason: "authentication" };
    }
    if (/model not found|unknown model|model unavailable|model does not exist/.test(message)) {
      return { endpoint: "pass", model: "fail", toolCalls: "unknown", reason: "model" };
    }
    if (status === 404) {
      return { endpoint: "unknown", model: "unknown", toolCalls: "unknown", reason: "endpoint" };
    }
    return { endpoint: "fail", model: "unknown", toolCalls: "unknown", reason: "endpoint" };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
