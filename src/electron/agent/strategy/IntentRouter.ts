import { ConversationMode } from "../../../shared/types";

export type RoutedIntent = "chat" | "advice" | "planning" | "execution" | "mixed" | "thinking";

export type TaskComplexity = "low" | "medium" | "high";

export interface IntentRoute {
  intent: RoutedIntent;
  confidence: number;
  conversationMode: ConversationMode;
  answerFirst: boolean;
  signals: string[];
  complexity: TaskComplexity;
}

interface IntentScores {
  chat: number;
  advice: number;
  planning: number;
  execution: number;
  thinking: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class IntentRouter {
  static route(title: string, prompt: string): IntentRoute {
    const text = `${title || ""}\n${prompt || ""}`.trim();
    const lower = text.toLowerCase();
    const scores: IntentScores = { chat: 0, advice: 0, planning: 0, execution: 0, thinking: 0 };
    const signals: string[] = [];

    const add = (
      intent: keyof IntentScores,
      points: number,
      signal: string,
      condition: boolean,
    ) => {
      if (!condition) return;
      scores[intent] += points;
      signals.push(signal);
    };

    add(
      "chat",
      3,
      "casual-greeting",
      /^(hi|hey|hello|yo|good morning|good afternoon|good evening|how are you|thanks|thank you)\b/.test(
        lower.trim(),
      ),
    );
    add(
      "chat",
      2,
      "small-talk",
      /\b(how are you|how's it going|what's up|good night)\b/.test(lower),
    );
    add(
      "advice",
      3,
      "advice-question",
      /\b(how should i|what should i|what do you suggest|recommend|advice)\b/.test(lower),
    );
    add(
      "planning",
      3,
      "strategy-language",
      /\b(strategy|roadmap|positioning|go to market|gtm|target segment|messaging|kpi|objective)\b/.test(
        lower,
      ),
    );
    add(
      "planning",
      2,
      "planning-language",
      /\b(plan|planning|phase|milestone|timeline)\b/.test(lower),
    );
    add(
      "execution",
      3,
      "action-verb",
      /\b(create|build|edit|write|fix|deploy|run|install|execute|open|search|fetch|schedule|configure|implement|check|read|review|find|analyze|examine|inspect|list|show|scan|look|update|modify|delete|remove|rename|move|copy|test|verify|continue|commit|push|pull|merge|raise|raised|cherry-?pick|rebase|revert|publish|release|tag|submit|approve|request|close)\b/.test(
        lower,
      ),
    );
    add(
      "execution",
      2,
      "execution-target",
      /\b(files?|folders?|repos?|projects?|commands?|scripts?|code|apps?|databases?|tests?|workspaces?|docs?|documents?|directories?|packages?|prs?|pull\s*requests?|branches?|commits?|releases?|tags?|issues?|pipelines?|builds?)\b/.test(
        lower,
      ),
    );
    add(
      "execution",
      2,
      "path-or-command",
      /`[^`]+`|\/[a-z0-9_.\-\/]+|\bnpm\b|\byarn\b|\bpnpm\b|\bgit\b/.test(lower),
    );
    add("advice", 1, "question-form", /\?/.test(text));
    add(
      "execution",
      3,
      "needs-tool-inspection",
      /\b(my screen|my display|screenshot|on screen|disk space|storage|battery|cpu|memory|ram|running apps?|running process|installed|clipboard|weather|temperature|stock price|exchange rate|current time|what time)\b/i.test(
        lower,
      ),
    );

    // "Think with me" mode — Socratic reasoning, not task execution
    add(
      "thinking",
      3,
      "think-with-me",
      /\b(think (with|through|about) (me|this|it)|brainstorm|let'?s think|help me (think|decide|figure|reason)|weigh (the |my )?options)\b/.test(
        lower,
      ),
    );
    add(
      "thinking",
      2,
      "exploratory-reasoning",
      /\b(pros and cons|trade-?offs|what if|devil'?s advocate|on the other hand|explore (the |my )?(idea|options|angles))\b/.test(
        lower,
      ),
    );

    const planningLike = scores.planning + scores.advice;
    const executionLike = scores.execution;
    const chatLike = scores.chat;
    const thinkingLike = scores.thinking;

    let intent: RoutedIntent;
    if (thinkingLike >= 3 && executionLike < 3) {
      intent = "thinking";
    } else if (chatLike >= 3 && planningLike === 0 && executionLike === 0 && thinkingLike === 0) {
      intent = "chat";
    } else if (planningLike >= 3 && executionLike >= 3) {
      intent = "mixed";
    } else if (scores.planning >= scores.advice && scores.planning >= 3) {
      intent = "planning";
    } else if (scores.advice >= 3 && executionLike === 0) {
      intent = "advice";
    } else if (executionLike >= 3) {
      intent = "execution";
    } else if (planningLike >= 2) {
      intent = "advice";
    } else if (planningLike >= 1 && chatLike === 0) {
      // Question with no chat signals (e.g. "have you raised this PR yet?")
      // should be treated as advice rather than defaulting to chat
      intent = "advice";
    } else {
      intent = "chat";
    }

    const confidenceBase = Math.max(chatLike, planningLike, executionLike, thinkingLike);
    const confidenceSpread = Math.abs(planningLike + executionLike - chatLike);
    const confidence = clamp(0.55 + confidenceBase * 0.08 + confidenceSpread * 0.02, 0.55, 0.95);

    const conversationMode: ConversationMode =
      intent === "chat"
        ? "chat"
        : intent === "thinking"
          ? "think"
          : intent === "execution"
            ? "task"
            : "hybrid";

    const answerFirst =
      intent === "advice" || intent === "planning" || intent === "mixed" || intent === "thinking";

    // Complexity scoring: how multi-faceted or demanding is this prompt?
    const wordCount = text.split(/\s+/).length;
    const actionVerbCount = (
      lower.match(
        /\b(create|build|edit|write|fix|deploy|run|install|execute|configure|implement|update|modify|delete|remove|test|verify)\b/g,
      ) || []
    ).length;
    const hasMultipleSteps =
      /\b(then|after that|next|also|additionally|and then|finally|first|second|third)\b/.test(
        lower,
      );

    let complexity: TaskComplexity;
    if (wordCount > 150 || actionVerbCount >= 4 || (hasMultipleSteps && actionVerbCount >= 2)) {
      complexity = "high";
    } else if (wordCount > 60 || actionVerbCount >= 2 || hasMultipleSteps) {
      complexity = "medium";
    } else {
      complexity = "low";
    }

    return {
      intent,
      confidence,
      conversationMode,
      answerFirst,
      signals,
      complexity,
    };
  }
}
