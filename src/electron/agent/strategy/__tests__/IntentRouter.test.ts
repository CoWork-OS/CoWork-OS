import { describe, expect, it } from "vitest";
import { IntentRouter } from "../IntentRouter";

describe("IntentRouter", () => {
  it("ignores AGENT_STRATEGY_CONTEXT blocks when scoring intent", () => {
    const rawPrompt = "hello";
    const decoratedPrompt = `${rawPrompt}

[AGENT_STRATEGY_CONTEXT_V1]
intent=deep_work
execution_contract:
- comprehensive
- long-running
[/AGENT_STRATEGY_CONTEXT_V1]`;

    const raw = IntentRouter.route("Hi", rawPrompt);
    const decorated = IntentRouter.route("Hi", decoratedPrompt);

    expect(decorated.intent).toBe(raw.intent);
    expect(decorated.domain).toBe(raw.domain);
  });

  it("keeps execution intent stable after prompt decoration", () => {
    const rawPrompt = "Search for today's Formula 1 news and summarize key driver and team updates";
    const decoratedPrompt = `${rawPrompt}

[AGENT_STRATEGY_CONTEXT_V1]
intent=execution
bounded_research=true
[/AGENT_STRATEGY_CONTEXT_V1]`;

    const raw = IntentRouter.route("Daily F1", rawPrompt);
    const decorated = IntentRouter.route("Daily F1", decoratedPrompt);

    expect(raw.intent).toBe("execution");
    expect(decorated.intent).toBe(raw.intent);
    expect(decorated.complexity).toBe(raw.complexity);
  });

  it("classifies research report compilation prompts as research domain", () => {
    const prompt =
      "Research the latest trends in AI agents from the last 1 day and compile findings into a comprehensive report.";
    const routed = IntentRouter.route("Daily AI Agent Trends Research", prompt);

    expect(routed.intent).toBe("execution");
    expect(routed.domain).toBe("research");
  });

  it("keeps compile-to-code prompts in code domain when paired with technical context", () => {
    const prompt = "Compile the TypeScript codebase and fix build errors in the repo.";
    const routed = IntentRouter.route("Fix compile failures", prompt);

    expect(routed.domain).toBe("code");
  });

  it("routes legal/doc path-heavy workflows without forcing code or deep_work", () => {
    const prompt =
      "Discover candidate files using glob patterns like **/*purchase*agreement*.* and **/*demand*letter*.*," +
      " then read each resolved document, analyze clause-level changes, and write a negotiation report.";
    const routed = IntentRouter.route("Legal negotiation review workflow", prompt);

    expect(routed.intent).toBe("workflow");
    expect(routed.domain).not.toBe("code");
    expect(routed.intent).not.toBe("deep_work");
  });
});
