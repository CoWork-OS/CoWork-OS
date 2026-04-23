import { ConversationMode, TaskDomain } from "../../../shared/types";

export type RoutedIntent =
  | "chat"
  | "advice"
  | "planning"
  | "execution"
  | "mixed"
  | "thinking"
  | "workflow"
  | "deep_work"
  | "redirect";

export type TaskComplexity = "low" | "medium" | "high";

export interface IntentRoute {
  intent: RoutedIntent;
  confidence: number;
  conversationMode: ConversationMode;
  answerFirst: boolean;
  signals: string[];
  complexity: TaskComplexity;
  domain: TaskDomain;
}

interface IntentScores {
  chat: number;
  advice: number;
  planning: number;
  execution: number;
  thinking: number;
  redirect: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class IntentRouter {
  private static normalizeSkillInvocationQuery(text: string): string {
    return String(text || "")
      .toLowerCase()
      .replace(/[-_\s]+/g, " ")
      .trim();
  }

  private static queryContainsSkillInvocationPhrase(query: string, phrase: string): boolean {
    const normalizedQuery = this.normalizeSkillInvocationQuery(query);
    const normalizedPhrase = this.normalizeSkillInvocationQuery(phrase);
    if (!normalizedQuery || !normalizedPhrase) return false;

    const pattern = normalizedPhrase
      .split(" ")
      .filter(Boolean)
      .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+");
    if (!pattern) return false;

    return new RegExp(`(?:^|[^a-z0-9])${pattern}(?:$|[^a-z0-9])`, "i").test(normalizedQuery);
  }

  private static isExplicitSkillInvocation(text: string): boolean {
    const normalized = this.normalizeSkillInvocationQuery(text);
    if (!normalized) return false;

    const activationCue =
      /\b(?:use|run|call|invoke|activate|apply|launch|start|enable|turn on|work on|help with|help me with)\b/;
    if (!activationCue.test(normalized)) return false;

    return this.queryContainsSkillInvocationPhrase(normalized, "skill");
  }

  private static getRedirectSignals(lower: string): string[] {
    const signals: string[] = [];

    if (
      /\bignore\b[\s\S]{0,150}\b(?:focus|work|do|build|create|handle|tackle|look\s+at|concentrate|instead)\b/i.test(
        lower,
      )
    ) {
      signals.push("redirect-ignore-pivot");
    }

    if (
      /\b(?:pivot\s+to|redirect\s+to|change\s+(?:the\s+)?(?:direction|focus|approach|course)|new\s+direction|different\s+direction)\b/i.test(
        lower,
      ) ||
      /\blet'?s?\s+(?:instead|pivot|redirect|change\s+(?:the\s+)?(?:direction|focus|approach))\b/i.test(
        lower,
      )
    ) {
      signals.push("redirect-explicit-pivot");
    }

    if (
      /\b(?:instead\s+of|rather\s+than)\b[\s\S]{0,150}\b(?:focus|work|do|build|create|look|tackle|explore|concentrate)\b/i.test(
        lower,
      )
    ) {
      signals.push("redirect-contrast");
    }

    if (
      /\b(?:don'?t|skip|forget|drop|abandon|leave|set\s+aside)\b[\s\S]{0,100}\b(?:focus|instead|concentrate|and\s+(?:focus|work|do|build|look|tackle))\b/i.test(
        lower,
      )
    ) {
      signals.push("redirect-negate-pivot");
    }

    if (
      /\b(?:focus\s+(?:only|just|solely|exclusively)\s+on|only\s+(?:focus|work)\s+on|concentrate\s+(?:only\s+)?on\s+(?:the\s+)?(?:new|other|different))\b/i.test(
        lower,
      )
    ) {
      signals.push("redirect-scope-narrow");
    }

    return signals;
  }

  static isRedirectIntent(text: string): boolean {
    const lower = (text || "").toLowerCase();
    return this.getRedirectSignals(lower).length > 0;
  }

  private static stripStrategyContext(text: string): string {
    if (!text) return text;
    const open = "[AGENT_STRATEGY_CONTEXT_V1]";
    const close = "[/AGENT_STRATEGY_CONTEXT_V1]";
    const openIndex = text.indexOf(open);
    if (openIndex === -1) return text;
    const closeIndex = text.indexOf(close, openIndex);
    if (closeIndex === -1) {
      return text.slice(0, openIndex).trim();
    }
    const before = text.slice(0, openIndex).trim();
    const after = text.slice(closeIndex + close.length).trim();
    return [before, after].filter(Boolean).join("\n\n").trim();
  }

  private static inferDomain(lower: string): TaskDomain {
    const compileCodeSignal =
      /\bcompile\b/.test(lower) &&
      /\b(code|coding|typescript|javascript|python|rust|java|node|repo|repository|branch|commit|pull request|pr|diff|test|build|lint|debug|bug|stack trace|api|sdk|binary|program)\b/.test(
        lower,
      );

    const codeKeywordSignal =
      /\b(code|coding|typescript|javascript|python|rust|java|node|repo|repository|branch|commit|pull request|pr|diff|test|build|lint|debug|bug|stack trace|api|sdk)\b/.test(
        lower,
      );
    const pathLikeSignal = /\/[a-z0-9_./-]+/.test(lower);
    const codePathCue =
      /\b(src|dist|lib|package\.json|tsconfig|node_modules|dockerfile|makefile|readme\.md)\b/.test(
        lower,
      ) || /\.[a-z0-9]{1,5}\b/.test(lower);
    const codeSignal =
      codeKeywordSignal ||
      compileCodeSignal ||
      /`[^`]+`/.test(lower) ||
      (pathLikeSignal && codePathCue && codeKeywordSignal);
    if (codeSignal) return "code";

    const operationsSignal =
      /\b(deploy|deployment|docker|kubernetes|k8s|terraform|infra|infrastructure|server|production|staging|cloud|monitoring|on-call|incident|sre|devops|vm|virtual machine|vnet|subnet|vpn|firewall|dns|ssh|private ip|zscaler)\b/.test(
        lower,
      );
    if (operationsSignal) return "operations";

    const writingSignal =
      /\b(write|draft|email|memo|proposal|blog|copywriting|linkedin post|tweet|script|rewrite|edit tone|grammar)\b/.test(
        lower,
      );
    if (writingSignal) return "writing";

    const researchSignal =
      /\b(research|investigate|look up|find out|analyze|analysis|compare|benchmark|sources?|citations?|market scan|trend)\b/.test(
        lower,
      );
    if (researchSignal) return "research";

    return "general";
  }

  static route(title: string, prompt: string): IntentRoute {
    const sanitizedPrompt = this.stripStrategyContext(String(prompt || ""));
    const text = `${title || ""}\n${sanitizedPrompt}`.trim();
    const lower = text.toLowerCase();
    const scores: IntentScores = { chat: 0, advice: 0, planning: 0, execution: 0, thinking: 0, redirect: 0 };
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
      /\b(create|build|make|edit|write|fix|deploy|run|install|execute|open|search|fetch|schedule|configure|implement|check|read|review|find|analyze|examine|inspect|list|show|scan|look|update|modify|delete|remove|rename|move|copy|test|verify|continue|commit|push|pull|merge|raise|raised|cherry-?pick|rebase|revert|publish|release|tag|submit|approve|request|close|research|investigate|summarize|compare|generate|draft|prepare|export|troubleshoot|diagnose|explore|spawn|crawl|scrape|extract|index|monitor|track|profile|audit|map|catalog|enumerate|parse|process|transform|migrate|sync|import|clone|fork|draw|paint|illustrate|render|sketch)\b/.test(
        lower,
      ),
    );
    add(
      "execution",
      2,
      "execution-target",
      /\b(files?|folders?|repos?|projects?|commands?|scripts?|code|apps?|databases?|tests?|workspaces?|docs?|documents?|directories?|packages?|prs?|pull\s*requests?|branches?|commits?|releases?|tags?|issues?|pipelines?|builds?|reports?|presentations?|spreadsheets?|data|results|findings|sources|summary|analysis|insights|metrics|websites?|web\s*pages?|webapps?|frontend|landing\s*pages?)\b/.test(
        lower,
      ),
    );
    add(
      "execution",
      2,
      "path-or-command",
      /`[^`]+`|\/[a-z0-9_./-]+|\bnpm\b|\byarn\b|\bpnpm\b|\bgit\b/.test(lower),
    );
    add(
      "execution",
      4,
      "explicit-skill-invocation",
      this.isExplicitSkillInvocation(lower),
    );
    const shellCommandMentioned =
      /\b(ssh|scp|sftp|ping|traceroute|mtr|nc|netcat|telnet|dig|nslookup|nmap|ifconfig|ipconfig|route)\b/.test(
        lower,
      );
    const connectivityIssueMentioned =
      /\b(can(?:not|'t)\s+connect|unable to connect|connection\s+(?:closed|refused|reset|timed?\s*out)|no route to host|network is unreachable|host unreachable|permission denied|port\s+\d+)\b/.test(
        lower,
      );
    const terminalTranscriptMentioned = /(?:^|\n)\S+@\S+[^\n]*(?:[$%#])\s+/.test(text);
    add(
      "execution",
      4,
      "shell-troubleshooting",
      shellCommandMentioned && connectivityIssueMentioned,
    );
    add(
      "execution",
      2,
      "terminal-transcript",
      terminalTranscriptMentioned && shellCommandMentioned,
    );
    add("advice", 1, "question-form", /\?/.test(text));
    add(
      "execution",
      3,
      "needs-tool-inspection",
      /\b(my screen|my display|screenshot|on screen|latest draft|same doc|what is this|why is this failing|the failing one|disk space|storage|battery|cpu|memory|ram|running apps?|running process|installed|clipboard|weather|temperature|stock price|exchange rate|current time|what time)\b/i.test(
        lower,
      ),
    );
    const cloudProviderMentioned =
      /\b(box|dropbox|one[\s-]?drive|google drive|sharepoint|notion|i[\s-]?cloud(?:\s+drive)?)\b/.test(
        lower,
      );
    const cloudFileObjectMentioned =
      /\b(files?|folders?|documents?|docs?|pages?|items?|storage|content)\b/.test(lower);
    const cloudQueryIntent =
      /\b(list|show|find|search|fetch|read|get|open|what|which|where|have|see)\b/.test(lower);
    add(
      "execution",
      3,
      "cloud-storage-file-access",
      cloudProviderMentioned && cloudFileObjectMentioned,
    );
    add(
      "execution",
      2,
      "cloud-storage-query",
      cloudProviderMentioned && cloudQueryIntent,
    );
    add(
      "execution",
      3,
      "live-cloud-sync-status",
      /\bi[\s-]?cloud\b/.test(lower) &&
        /\b(upload(?:ed|ing)?|sync(?:ing|ed)?|downloading|status|activity)\b/.test(lower) &&
        /\b(my|this)\s+mac\b|\bon my mac\b|\bfrom my mac\b|\bright now\b|\bnow\b/.test(lower),
    );
    // Image creation: draw, create image, generate picture, etc.
    add(
      "execution",
      4,
      "image-creation-intent",
      /\b(draw|paint|illustrate|render|sketch)\b.*\b(in|of|a|an|the)\b/.test(lower) ||
        /\b(create|generate|make)\s+(?:an?\s+)?(?:image|picture|photo|illustration)\s+(?:of|with)\b/i.test(
          lower,
        ),
    );

    // Redirect / re-scope intent — user is pivoting away from prior work to a new direction.
    // Scored separately so it can win decisively over "execution" when both are present.
    const redirectSignals = this.getRedirectSignals(lower);
    add("redirect", 5, "redirect-ignore-pivot", redirectSignals.includes("redirect-ignore-pivot"));
    add("redirect", 5, "redirect-explicit-pivot", redirectSignals.includes("redirect-explicit-pivot"));
    add("redirect", 4, "redirect-contrast", redirectSignals.includes("redirect-contrast"));
    add("redirect", 4, "redirect-negate-pivot", redirectSignals.includes("redirect-negate-pivot"));
    add("redirect", 3, "redirect-scope-narrow", redirectSignals.includes("redirect-scope-narrow"));

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
      /\b(pros and cons|trade-?offs|devil'?s advocate|on the other hand|explore (the |my )?(idea|options|angles))\b/.test(
        lower,
      ),
    );
    add(
      "thinking",
      2,
      "what-if-exploration",
      /\bwhat if\b/.test(lower) &&
        /\?/.test(text) &&
        !/\b(toggle|mode|button|switch|option|panel|feature|tab)\b/.test(lower),
    );

    // Workflow detection — sequential multi-phase prompts ("research X then create Y then email Z")
    const workflowConnectives =
      /\b(then|after that|after this|next|and then|finally|once done|once that'?s done|step \d|→|➜|->)\b/i;
    const hasWorkflowConnectives = workflowConnectives.test(lower);
    const actionVerbMatches =
      lower.match(
        /\b(create|build|make|edit|write|fix|deploy|run|install|execute|configure|implement|update|modify|delete|remove|test|verify|research|analyze|summarize|generate|send|email|present|export|schedule|review|compile|draft|prepare|deliver|share|upload|publish|troubleshoot|diagnose)\b/g,
      ) || [];
    const uniqueActionVerbs = new Set(actionVerbMatches).size;

    add(
      "execution",
      0, // don't add score, just detect
      "workflow-pipeline",
      hasWorkflowConnectives && uniqueActionVerbs >= 3,
    );

    // Deep work detection — long-running autonomous tasks
    const hasDeepWorkSignal =
      /\b(deep\s+work|fire\s+and\s+forget|long[- ]running|autonomous(?:ly)?|end[- ]to[- ]end|from\s+scratch|comprehensive|production[- ]ready|full[- ]stack|set\s+(?:it\s+)?up\s+(?:everything|all)|build\s+(?:me\s+)?a\s+(?:complete|full|entire)|kick\s+(?:it\s+)?off\s+and)\b/i.test(
        lower,
      );
    if (hasDeepWorkSignal) {
      signals.push("deep-work-signal");
    }

    const planningLike = scores.planning + scores.advice;
    const executionLike = scores.execution;
    const chatLike = scores.chat;
    const thinkingLike = scores.thinking;
    const redirectLike = scores.redirect;

    // Complexity scoring: how multi-faceted or demanding is this prompt?
    const wordCount = text.split(/\s+/).length;
    const actionVerbCount = (
      lower.match(
        /\b(create|build|make|edit|write|fix|deploy|run|install|execute|configure|implement|update|modify|delete|remove|test|verify|troubleshoot|diagnose)\b/g,
      ) || []
    ).length;
    const hasMultipleSteps =
      /\b(then|after that|next|also|additionally|and then|finally|first|second|third)\b/.test(
        lower,
      );

    // Deep work should require an explicit autonomy signal from the user.
    const isDeepWork =
      hasDeepWorkSignal && executionLike >= 3 && (wordCount > 100 || uniqueActionVerbs >= 4);

    let intent: RoutedIntent;
    // Redirect: checked first — a pivot message wins over all other intents,
    // including deep_work. "build this end-to-end from scratch" is still a
    // redirect if it's prefaced by "forget the current plan and…".
    if (redirectLike >= 3) {
      intent = "redirect";
      // Deep work: long-running autonomous execution
    } else if (isDeepWork) {
      intent = "deep_work";
      // Multi-phase workflow: 3+ distinct action verbs with sequential connectives
    } else if (hasWorkflowConnectives && uniqueActionVerbs >= 3 && executionLike >= 3) {
      intent = "workflow";
    } else if (thinkingLike >= 3 && executionLike < 3) {
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

    const confidenceBase = Math.max(chatLike, planningLike, executionLike, thinkingLike, redirectLike);
    const confidenceSpread = Math.abs(planningLike + executionLike - chatLike);
    const confidence = clamp(0.55 + confidenceBase * 0.08 + confidenceSpread * 0.02, 0.55, 0.95);

    const conversationMode: ConversationMode =
      intent === "chat"
        ? "chat"
        : intent === "thinking"
          ? "think"
          : intent === "execution" || intent === "workflow" || intent === "deep_work" || intent === "redirect"
            ? "task"
            : "hybrid";

    const answerFirst =
      intent === "advice" || intent === "planning" || intent === "mixed" || intent === "thinking";

    let complexity: TaskComplexity;
    if (wordCount > 150 || actionVerbCount >= 4 || (hasMultipleSteps && actionVerbCount >= 2)) {
      complexity = "high";
    } else if (wordCount > 60 || actionVerbCount >= 2 || hasMultipleSteps) {
      complexity = "medium";
    } else {
      complexity = "low";
    }

    const domain = this.inferDomain(lower);

    return {
      intent,
      confidence,
      conversationMode,
      answerFirst,
      signals,
      complexity,
      domain,
    };
  }
}
