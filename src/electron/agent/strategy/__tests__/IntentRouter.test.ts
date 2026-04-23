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

  it("routes Box file inventory questions to execution intent", () => {
    const routed = IntentRouter.route("Box files", "which files I have on box?");
    expect(routed.intent).toBe("execution");
  });

  it("routes Dropbox content listing questions to execution intent", () => {
    const routed = IntentRouter.route("Dropbox listing", "what files are in my dropbox");
    expect(routed.intent).toBe("execution");
  });

  it("routes iCloud Drive content listing questions to execution intent", () => {
    const routed = IntentRouter.route("iCloud listing", "what files are in my iCloud Drive");
    expect(routed.intent).toBe("execution");
  });

  it("routes live iCloud sync status questions on the current Mac to execution intent", () => {
    const routed = IntentRouter.route(
      "iCloud upload status",
      "can you see whats being uploaded to icloud from my mac now?",
    );

    expect(routed.intent).toBe("execution");
    expect(routed.conversationMode).toBe("task");
    expect(routed.signals).toContain("live-cloud-sync-status");
  });

  it("routes vague latest-draft screen-context prompts to execution intent", () => {
    const routed = IntentRouter.route("Draft sync", "sync the latest draft from the same doc");
    expect(routed.intent).toBe("execution");
    expect(routed.signals).toContain("needs-tool-inspection");
  });

  it("routes SSH connectivity troubleshooting prompts to execution in operations domain", () => {
    const prompt = [
      "This is the azure VM private address but I cannot connect to it",
      "alice@host % ssh user@10.213.136.68",
      "Connection closed by 10.213.136.68 port 22",
      "Zscaler is open on my mac",
    ].join("\n");

    const routed = IntentRouter.route("SSH private VM issue", prompt);
    expect(routed.intent).toBe("execution");
    expect(routed.domain).toBe("operations");
    expect(routed.signals).toContain("shell-troubleshooting");
  });

  it("routes interactive website build prompts to execution instead of advice", () => {
    const prompt =
      'Make an interactive website that scrolls horizontally with a timeline and include a "what if" toggle.';
    const routed = IntentRouter.route("Build site", prompt);
    expect(routed.intent).toBe("execution");
  });

  it("routes explicit skill activation prompts to execution", () => {
    const routed = IntentRouter.route(
      "Novel task",
      "Use the novelist skill. Seed: a climatologist discovers a city that only exists during fog.",
    );
    expect(routed.intent).toBe("execution");
    expect(routed.conversationMode).toBe("task");
    expect(routed.signals).toContain("explicit-skill-invocation");
  });

  it("routes hyphenated explicit skill activation prompts to execution", () => {
    const routed = IntentRouter.route(
      "Research task",
      "Use the autoresearch-report skill. Question: how do genetic changes over time contribute to Alzheimer's?",
    );
    expect(routed.intent).toBe("execution");
    expect(routed.conversationMode).toBe("task");
    expect(routed.signals).toContain("explicit-skill-invocation");
  });

  it("does not let feature-language 'what if' force thinking intent", () => {
    const prompt =
      'Build CoworkOS distro and start implementation; include a "what if" mode in the installer wizard.';
    const routed = IntentRouter.route("CoworkOS", prompt);
    expect(routed.intent).not.toBe("thinking");
    expect(routed.intent).not.toBe("advice");
  });

  describe("redirect intent", () => {
    it("routes the canonical failure case — 'ignore X fixes, focus on new features'", () => {
      const prompt =
        "ignore the openclaw related fixes for its codebase and focus on new features or enhancements";
      const routed = IntentRouter.route("", prompt);
      expect(routed.intent).toBe("redirect");
      expect(routed.conversationMode).toBe("task");
      expect(routed.signals).toContain("redirect-ignore-pivot");
    });

    it("routes 'ignore X and do Y' pattern", () => {
      const routed = IntentRouter.route("", "ignore the bug fixes and work on the dashboard instead");
      expect(routed.intent).toBe("redirect");
    });

    it("routes explicit pivot language", () => {
      const routed = IntentRouter.route("", "let's pivot to building the authentication flow");
      expect(routed.intent).toBe("redirect");
      expect(routed.signals).toContain("redirect-explicit-pivot");
    });

    it("routes change direction language", () => {
      const routed = IntentRouter.route("", "change direction and focus on the payment module");
      expect(routed.intent).toBe("redirect");
    });

    it("routes 'instead of X, focus on Y' contrast pattern", () => {
      const routed = IntentRouter.route(
        "",
        "instead of refactoring the old code, focus on writing new tests",
      );
      expect(routed.intent).toBe("redirect");
      expect(routed.signals).toContain("redirect-contrast");
    });

    it("routes 'rather than X, do Y' pattern", () => {
      const routed = IntentRouter.route(
        "",
        "rather than fixing the existing bugs, build the new feature",
      );
      expect(routed.intent).toBe("redirect");
    });

    it("routes 'forget that, work on X instead' negate-and-pivot pattern", () => {
      const routed = IntentRouter.route("", "forget that approach and instead focus on the API layer");
      expect(routed.intent).toBe("redirect");
      expect(routed.signals).toContain("redirect-negate-pivot");
    });

    it("routes 'don't do X, focus on Y' negate-and-pivot pattern", () => {
      const routed = IntentRouter.route(
        "",
        "don't fix the styling issues, focus on the backend logic instead",
      );
      expect(routed.intent).toBe("redirect");
    });

    it("routes scope-narrowing 'focus only on Y' pattern", () => {
      const routed = IntentRouter.route("", "focus only on the new features, not the old bugs");
      expect(routed.intent).toBe("redirect");
      expect(routed.signals).toContain("redirect-scope-narrow");
    });

    it("always maps redirect intent to task conversationMode", () => {
      const prompts = [
        "ignore X and focus on Y",
        "pivot to building the new module",
        "instead of X do Y",
        "forget that and concentrate on new features",
      ];
      for (const prompt of prompts) {
        const routed = IntentRouter.route("", prompt);
        if (routed.intent === "redirect") {
          expect(routed.conversationMode).toBe("task");
        }
      }
    });

    it("does not incorrectly route simple chat messages as redirect", () => {
      const chatMessages = ["hello", "thanks for the help", "how are you?", "what did you find?"];
      for (const msg of chatMessages) {
        const routed = IntentRouter.route("", msg);
        expect(routed.intent).not.toBe("redirect");
      }
    });

    it("does not incorrectly route plain execution tasks as redirect", () => {
      const routed = IntentRouter.route("", "build a REST API for user authentication");
      expect(routed.intent).not.toBe("redirect");
    });
  });
});
