import * as path from "path";
import * as fs from "fs";
import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import { XSettingsManager } from "../../settings/x-manager";
import { runBirdCommand } from "../../utils/x-cli";
import { BrowserTools } from "./browser-tools";
import { buildXComposeScript, buildXToggleFollowScript } from "./x-browser-scripts";

type XAction =
  | "whoami"
  | "read"
  | "thread"
  | "replies"
  | "search"
  | "user_tweets"
  | "mentions"
  | "home"
  | "tweet"
  | "reply"
  | "follow"
  | "unfollow";

type XWriteAction = "tweet" | "reply" | "follow" | "unfollow";

interface XActionInput {
  action: XAction;
  id_or_url?: string;
  query?: string;
  user?: string;
  text?: string;
  timeline?: "for_you" | "following";
  count?: number;
  media?: string[];
  alt?: string;
}

interface BrowserFallbackTweetItem {
  author?: string;
  time?: string;
  body?: string;
  url?: string;
  source: "timeline" | "thread" | "search" | "profile" | "generic";
}

const MAX_COUNT = 50;
const MAX_MEDIA = 4;

export class XTools {
  private browserTools: BrowserTools;
  private readonly browserProfileName: string;
  private static readonly BROWSER_FALLBACK_TEXT_LIMIT = 5000;
  private static readonly BROWSER_FALLBACK_PROFILE = "x-fallback";
  private static readonly WRITE_ACTIONS = new Set<XAction>([
    "tweet",
    "reply",
    "follow",
    "unfollow",
  ]);
  private static readonly FOLLOW_RETRY_ATTEMPTS = 6;
  private static readonly FOLLOW_RETRY_DELAY_MS = 750;
  private static readonly READINESS_WAIT_ATTEMPTS = 8;
  private static readonly READINESS_WAIT_DELAY_MS = 600;
  private static readonly COMMAND_RETRY_ATTEMPTS = 2;
  private static readonly COMMAND_RETRY_DELAY_MS = 600;

  private static readonly BLOCKING_PATTERNS: RegExp[] = [
    /rate.?limit/i,
    /too many requests/i,
    /rate limit exceeded/i,
    /forbidden/i,
    /unauthorized/i,
    /access denied/i,
    /authentication required/i,
    /authentication failed/i,
    /not authenticated/i,
    /captcha/i,
    /challenge/i,
    /verify your/i,
    /verify your account/i,
    /temporar/i,
    /service unavailable/i,
    /retry later/i,
    /\b403\b/i,
    /\b429\b/i,
    /timed out/i,
    /timeout/i,
    /econnreset/i,
    /enotfound/i,
    /network error/i,
    /account is locked/i,
    /account suspension/i,
    /please verify your account/i,
    /login required/i,
  ];

  private static readonly TRANSIENT_COMMAND_ERROR_PATTERNS: RegExp[] = [
    /timeout/i,
    /timed out/i,
    /econnreset/i,
    /enotfound/i,
    /network error/i,
    /getaddrinfo/i,
    /econnrefused/i,
    /socket hang up/i,
    /connection reset/i,
    /temporar/i,
  ];

  private static readonly TWEET_EDITOR_SELECTORS = [
    '[data-testid="tweetTextarea_0"]',
    '[data-testid="tweet-text"]',
    '[role="textbox"][contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    '[aria-label="Post text"]',
    '[aria-label="Post"] [contenteditable="true"]',
  ];

  private static readonly POST_BUTTON_LABELS = ["post", "tweet"];
  private static readonly REPLY_BUTTON_LABELS = ["reply", "post"];
  private static readonly FOLLOW_BUTTON_LABELS = ["follow", "unfollow", "following"];
  private static readonly TWEET_BUTTON_SELECTORS = [
    '[data-testid="tweetButton"]',
    '[data-testid="tweetButtonInline"]',
    '[data-testid="tweetButton2"]',
    '[data-testid="sendTweetButton"]',
    'button[aria-label*="Post"]',
    'button[aria-label*="Reply"]',
  ];
  private static readonly FOLLOW_BUTTON_SELECTORS = [
    '[data-testid="userActions"] button',
    '[data-testid="userActions"] [role="button"]',
    'button[data-testid*="follow"]',
    'button[data-testid*="unfollow"]',
    'button[aria-label*="Follow"]',
    'button[aria-label*="Following"]',
  ];
  private static readonly BROWSER_BLOCKING_TEXT_PATTERNS: RegExp[] = [
    /something went wrong/i,
    /challenge/i,
    /we've detected unusual activity/i,
    /suspicious/i,
    /verify your/i,
    /captcha/i,
    /suspicious activity/i,
    /rate limit/i,
    /temporar/i,
    /not available/i,
    /this account has been temporarily locked/i,
    /sign in to continue/i,
  ];

  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {
    this.browserTools = new BrowserTools(workspace, daemon, taskId);
    const taskHash = Math.abs(
      Array.from(this.taskId || "").reduce((acc, char) => acc * 31 + char.charCodeAt(0), 0),
    ).toString(36);
    this.browserProfileName = this.taskId || taskHash;
  }

  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
    this.browserTools.setWorkspace(workspace);
  }

  private static normalizeToTweetUrl(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return "https://x.com";
    if (/^\d+$/.test(trimmed) && trimmed.length <= 20) {
      return `https://x.com/i/web/status/${trimmed}`;
    }
    if (/^https?:\/\//i.test(trimmed)) {
      try {
        const parsed = new URL(trimmed);
        const hostname = parsed.hostname.toLowerCase();
        if (!hostname.includes("x.com") && !hostname.includes("twitter.com")) {
          return "https://x.com";
        }

        const statusMatch = parsed.pathname.match(/\/(?:i\/web\/)?status\/(\d{1,20})/i);
        if (statusMatch) {
          return `https://x.com/i/web/status/${statusMatch[1]}`;
        }

        return "https://x.com";
      } catch {
        return "https://x.com";
      }
    }
    const normalizedHandle = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
    if (!/^[a-zA-Z0-9_]{1,15}$/i.test(normalizedHandle)) {
      return "https://x.com";
    }
    return `https://x.com/${encodeURIComponent(normalizedHandle)}`;
  }

  private async pause(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isRetryableCommandError(message: string): boolean {
    if (!message) return false;
    return XTools.TRANSIENT_COMMAND_ERROR_PATTERNS.some((pattern) => pattern.test(message));
  }

  private getBrowserFallbackUrl(action: XAction, input: XActionInput): string {
    const handle = this.normalizeHandle(input.user);

    switch (action) {
      case "whoami":
        return "https://x.com/home";
      case "read":
      case "thread":
      case "replies":
      case "reply":
        return input.id_or_url ? XTools.normalizeToTweetUrl(input.id_or_url) : "https://x.com";
      case "search":
        return `https://x.com/search?q=${encodeURIComponent(input.query || "")}`;
      case "user_tweets":
        return handle ? `https://x.com/${handle.slice(1)}` : "https://x.com/explore";
      case "mentions":
        return "https://x.com/notifications/mentions";
      case "home":
        return "https://x.com/home";
      case "tweet":
        return "https://x.com/compose/post";
      case "follow":
      case "unfollow":
        return handle ? `https://x.com/${handle.slice(1)}` : "https://x.com";
      default:
        return "https://x.com";
    }
  }

  private isWriteAction(action: XAction): action is XWriteAction {
    return XTools.WRITE_ACTIONS.has(action);
  }

  private isLikelyBlockingError(message: string): boolean {
    if (!message) return false;
    if (/bird cli not found/i.test(message)) return false;
    if (/ENOENT/i.test(message)) return false;
    const hasBlockingSignal = XTools.BLOCKING_PATTERNS.some((pattern) => pattern.test(message));
    const hasHttpRateCode = /\b(?:401|403|429)\b/.test(message);
    const isGenericBlockedOnly = /\bblocked\b/i.test(message) && !hasHttpRateCode;
    if (
      isGenericBlockedOnly &&
      !/rate|suspend|lock|unauthori|forbid|captcha|challenge|verify|access/i.test(message)
    ) {
      return false;
    }
    return hasBlockingSignal;
  }

  private trimTextForPrompt(value?: string): string | undefined {
    if (!value) return undefined;
    if (value.length <= XTools.BROWSER_FALLBACK_TEXT_LIMIT) return value;
    return `${value.slice(0, XTools.BROWSER_FALLBACK_TEXT_LIMIT - 3)}...`;
  }

  private isLikelyBrowserBlocked(text?: string): boolean {
    if (!text) return false;
    return XTools.BROWSER_BLOCKING_TEXT_PATTERNS.some((pattern) => pattern.test(text));
  }

  private getFallbackCandidateSelectors(action: XAction): string[] {
    switch (action) {
      case "read":
      case "thread":
      case "replies":
      case "search":
      case "user_tweets":
      case "mentions":
      case "home":
      case "whoami":
      case "tweet":
      case "reply":
      case "follow":
      case "unfollow":
        return [
          '[data-testid="tweet"]',
          '[role="article"]',
          'article[data-testid="tweet"]',
          'article[role="article"]',
        ];
      default:
        return ['article[data-testid="tweet"]', 'article[role="article"]'];
    }
  }

  private async waitForBrowserReadiness(action: XAction): Promise<boolean> {
    this.daemon.logEvent(this.taskId, "log", {
      level: "info",
      category: "x_fallback",
      message: `Waiting for browser content readiness (${action})`,
    });
    const selectors = this.getFallbackCandidateSelectors(action);
    const serializedSelectors = JSON.stringify(selectors);
    for (let attempt = 0; attempt < XTools.READINESS_WAIT_ATTEMPTS; attempt++) {
      const script = `
      (async () => {
          const selectors = ${serializedSelectors};
          const hasTweetContainer = selectors.some((selector) => document.querySelectorAll(selector).length > 0);
          const hasTweetLink = selectors.some((selector) =>
            Array.from(document.querySelectorAll(selector)).some((node) => {
              if (!(node instanceof HTMLElement)) return false;
              const link = node.querySelector('a[href*="/status/"], a[href*="/i/web/status/"]');
              return !!link;
            })
          );
          return { hasTweetContainer, hasTweetLink };
        })()
      `;

      const result = await this.runBrowserScript(script);
      if (result.success && result.result && typeof result.result === "object") {
        const value = result.result as { hasTweetContainer?: boolean; hasTweetLink?: boolean };
        if (value.hasTweetLink || value.hasTweetContainer) {
          return true;
        }
      }

      await this.pause(XTools.READINESS_WAIT_DELAY_MS);
    }

    this.daemon.logEvent(this.taskId, "log", {
      level: "warn",
      category: "x_fallback",
      message: `Browser readiness timeout after ${XTools.READINESS_WAIT_ATTEMPTS} checks (${action})`,
    });
    return false;
  }

  private async waitForBrowserWriteReadiness(action: XWriteAction): Promise<boolean> {
    this.daemon.logEvent(this.taskId, "log", {
      level: "info",
      category: "x_fallback",
      message: `Waiting for browser write controls (${action})`,
    });
    const isFollowAction = action === "follow" || action === "unfollow";
    const editorSelectorsSerialized = JSON.stringify(XTools.TWEET_EDITOR_SELECTORS);
    const submitSelectorsSerialized = JSON.stringify(XTools.TWEET_BUTTON_SELECTORS);
    const followSelectorsSerialized = JSON.stringify(XTools.FOLLOW_BUTTON_SELECTORS);
    const followLabelsSerialized = JSON.stringify(XTools.FOLLOW_BUTTON_LABELS);
    const mode = isFollowAction ? "follow" : "composer";
    for (let attempt = 0; attempt < XTools.READINESS_WAIT_ATTEMPTS; attempt++) {
      const script = `
      (async () => {
        const mode = ${JSON.stringify(mode)};
        const isFollowMode = mode === 'follow';
        const editorSelectors = ${editorSelectorsSerialized};
        const submitSelectors = ${submitSelectorsSerialized};
        const followSelectors = ${followSelectorsSerialized};
        const followLabels = ${followLabelsSerialized};

        const normalize = (value) => (value || '').toLowerCase().trim();
        const isVisible = (element) => {
          const style = window.getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden') {
            return false;
          }
          return element.getClientRects().length > 0;
        };

        if (isFollowMode) {
          return followSelectors
            .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
            .some((button) => {
              if (!(button instanceof HTMLElement) || !isVisible(button)) {
                return false;
              }
              const text = normalize((button.getAttribute('aria-label') || '') + ' ' + (button.textContent || ''));
              return followLabels.some((label) => text.includes(label));
            });
        }

        const hasEditor = editorSelectors.some((selector) =>
          Array.from(document.querySelectorAll(selector)).some((node) => node instanceof HTMLElement && isVisible(node))
        );
        const hasSubmit = submitSelectors.some((selector) =>
          Array.from(document.querySelectorAll(selector)).some((node) => node instanceof HTMLElement && isVisible(node))
        );
        return hasEditor && hasSubmit;
      })()
    `;

      const scriptResult = await this.runBrowserScript(script);
      if (scriptResult.success && scriptResult.result === true) {
        return true;
      }

      await this.pause(XTools.READINESS_WAIT_DELAY_MS);
    }

    this.daemon.logEvent(this.taskId, "log", {
      level: "warn",
      category: "x_fallback",
      message: `Browser write-control timeout after ${XTools.READINESS_WAIT_ATTEMPTS} checks (${action})`,
    });
    return false;
  }

  private shouldRetryCommand(action: XAction): boolean {
    return !this.isWriteAction(action);
  }

  private async extractBrowserReadableContent(
    action: XAction,
  ): Promise<BrowserFallbackTweetItem[]> {
    const script = `
      (async () => {
        const activeAction = ${JSON.stringify(action)};
        const normalizeText = (value) => (value || '').replace(/\\s+/g, ' ').trim();
        const action = activeAction;
        const getFirst = (root, selectors) => {
          for (const selector of selectors) {
            const node = root.querySelector(selector);
            if (node) {
              return node;
            }
          }
          return null;
        };

        const extractArticleUrl = (root) => {
          const links = [
            'a[href*="/status/"]',
            'a[href*="/i/web/status/"]',
          ];
          const statusCandidate = links
            .map((selector) => root.querySelector(selector))
            .find((link) => !!link && /\\/status\\//.test(link.getAttribute('href') || ''));
          if (!statusCandidate) return '';
          const href = statusCandidate.getAttribute('href') || '';
          if (!href) return '';
          return href.startsWith('http') ? href : location.origin + href;
        };

        const dedupeBy = (items) => {
          const seen = new Set();
          return items.filter((item) => {
            const key = (item.url || '') + '|' + (item.body || '');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        };

        const sourceForAction = (inputAction) => {
          if (inputAction === 'read' || inputAction === 'thread' || inputAction === 'replies') return 'thread';
          if (inputAction === 'user_tweets') return 'profile';
          if (inputAction === 'search') return 'search';
          if (inputAction === 'home' || inputAction === 'mentions') return 'timeline';
          return 'generic';
        };
        const actionSelectors = ${JSON.stringify(this.getFallbackCandidateSelectors(action))};
        const candidates = new Set();
        const source = sourceForAction(${JSON.stringify(action)});
        const pushNodes = (selector) => {
          document.querySelectorAll(selector).forEach((node) => candidates.add(node));
        };

        actionSelectors.forEach(pushNodes);

        const tweetNodes = Array.from(candidates).filter((node) => node instanceof HTMLElement);
        const items = tweetNodes
          .map((tweet) => {
            if (tweet.closest('header, aside, nav, footer')) {
              return null;
            }

            const authorNode = getFirst(tweet, [
              '[data-testid="User-Name"]',
              '[data-testid="UserNames"]',
              'div[data-testid="User-Name"]',
              '[data-testid="UserName"]',
            ]);
            const fallbackHandleNode = getFirst(tweet, [
              '[role="link"] [dir="ltr"] span',
              'a[href*="/status/"] + div [dir="ltr"]',
              'a[href*="/i/web/status/"] + div [dir="ltr"]',
              '[role="link"] span',
            ]);
            const bodyNode = getFirst(tweet, [
              '[data-testid="tweetText"]',
              '[data-testid="tweetText"][lang]',
              'div[data-testid="tweetText"][lang]',
              '[lang][dir] [dir="ltr"]',
              '[lang]',
            ]);
            const timeNode = getFirst(tweet, [
              'time',
              'a time',
              'a[href*="/status/"] time',
            ]);

            const author = normalizeText(
              (authorNode && (authorNode.textContent || authorNode.getAttribute('aria-label'))) ||
              (fallbackHandleNode ? (fallbackHandleNode.textContent || fallbackHandleNode.getAttribute('aria-label') || '') : '')
            );
            const bodyText = normalizeText(bodyNode ? (bodyNode.textContent || '') : '');
            const time = normalizeText(timeNode ? (timeNode.getAttribute('datetime') || timeNode.textContent || '') : '');
            const tweetUrl = extractArticleUrl(tweet);
            const hasTweetLink = /\\/status\\//.test((tweetUrl || ''));
            const hasTweetText = Boolean(bodyText);
            const hasTweetLikeText = /@/.test(author) || /\\b(?:am|pm)\\b|\\d{1,2}:\\d{2}/.test(time) || hasTweetText;
            if (!hasTweetLink || !hasTweetLikeText) {
              return null;
            }

            return {
              author: author || undefined,
              time: time || undefined,
              body: bodyText || undefined,
              url: tweetUrl || undefined,
              source,
            };
          })
          .filter((item) => !!item && (
            (item.body && item.body.length > 0) ||
            (item.author && item.author.length > 0) ||
            (item.url && item.url.includes('/status/'))
          ));

        return dedupeBy(items);
      })()
    `;

    const scriptResult = await this.runBrowserScript(script);
    if (!scriptResult.success || !scriptResult.result) {
      return [];
    }
    if (!Array.isArray(scriptResult.result)) {
      return [];
    }
    return scriptResult.result as BrowserFallbackTweetItem[];
  }

  private buildFallbackMessage(action: XAction, reason: string): string {
    if (this.isWriteAction(action)) {
      return `X CLI blocked this action (${reason}). Browser fallback opened for manual completion.`;
    }
    return `X CLI blocked this action (${reason}). Read data via browser fallback.`;
  }

  private buildFallbackDetails(action: XAction, input: XActionInput) {
    const base = {
      method: "browser" as const,
      reason: "X access appears blocked or rate-limited for this request",
      url: this.getBrowserFallbackUrl(action, input),
    };

    if (action === "tweet") {
      return {
        ...base,
        draftText: input.text,
        suggestedNextAction: "compose_post",
      };
    }

    if (action === "reply") {
      return {
        ...base,
        draftText: input.text,
        replyTarget: input.id_or_url,
        suggestedNextAction: "open_reply_thread",
      };
    }

    if (action === "follow" || action === "unfollow") {
      return {
        ...base,
        targetUser: input.user,
        suggestedNextAction: "open_profile",
      };
    }

    return base;
  }

  private async runBrowserScript(
    script: string,
  ): Promise<{ success: boolean; result?: Any; error?: string }> {
    const result = await this.browserTools.executeTool("browser_evaluate", {
      script,
    });
    if (!result || typeof result !== "object" || !("success" in result)) {
      return { success: false, error: "Invalid browser script result" };
    }

    const browserResult = result as { success: boolean; result?: unknown };
    if (!browserResult.success) {
      const errorValue = (() => {
        const scriptResult = browserResult.result;
        if (!scriptResult) {
          return "Browser script failed";
        }
        if (typeof scriptResult === "string") {
          return scriptResult;
        }
        if (typeof scriptResult === "object" && scriptResult && "reason" in scriptResult) {
          return String((scriptResult as { reason?: unknown }).reason || "Browser script failed");
        }
        return String(scriptResult);
      })();

      return { success: false, error: errorValue };
    }

    return { success: true, result: browserResult.result };
  }

  private async openBrowserFallbackPage(
    url: string,
  ): Promise<{ navResult?: Any; browserChannel: "chromium" | "chrome" | "brave"; error?: string }> {
    const attempts: Array<{ browser_channel?: "chromium" | "chrome" | "brave" }> = [
      {},
      { browser_channel: "brave" },
      { browser_channel: "chrome" },
    ];

    let lastError: string | undefined;
    for (const attempt of attempts) {
      try {
        const navResult = await this.browserTools.executeTool("browser_navigate", {
          url,
          headless: false,
          profile: `${XTools.BROWSER_FALLBACK_PROFILE}-${this.browserProfileName}`,
          ...(attempt.browser_channel ? { browser_channel: attempt.browser_channel } : {}),
        });

        return {
          navResult,
          browserChannel: attempt.browser_channel || "chromium",
        };
      } catch (error: Any) {
        lastError = error?.message || "Browser fallback navigation failed";
      }
    }

    return {
      browserChannel: "chromium",
      error: lastError || "Browser fallback navigation failed",
    };
  }

  private async tryComposeInBrowser(
    text: string,
    mode: "tweet" | "reply",
  ): Promise<{
    success: boolean;
    draft: boolean;
    submitted: boolean;
    details?: {
      editorSelector?: string;
      buttonSelector?: string;
      reason?: string;
      writtenText?: string;
    };
    error?: string;
  }> {
    const buttonLabels = mode === "reply" ? XTools.REPLY_BUTTON_LABELS : XTools.POST_BUTTON_LABELS;
    const script = buildXComposeScript({
      text,
      isReplyMode: mode === "reply",
      editorSelectors: XTools.TWEET_EDITOR_SELECTORS,
      buttonLabels,
      submitSelectors: XTools.TWEET_BUTTON_SELECTORS,
    });

    const scriptResult = await this.runBrowserScript(script);
    if (!scriptResult.success || !scriptResult.result) {
      return {
        success: false,
        draft: false,
        submitted: false,
        error: scriptResult.error || "Failed to run compose script",
      };
    }

    const result = scriptResult.result;
    const typedResult = result as {
      success?: boolean;
      draft?: boolean;
      submitted?: boolean;
      reason?: string;
      editorSelector?: string;
      buttonSelector?: string;
      writtenText?: string;
    };

    if (!typedResult.success && typedResult.reason) {
      return {
        success: false,
        draft: !!typedResult.draft,
        submitted: false,
        details: {
          reason: typedResult.reason,
          editorSelector: typedResult.editorSelector,
          buttonSelector: typedResult.buttonSelector,
        },
        error: typedResult.reason,
      };
    }

    return {
      success: !!typedResult.submitted && !!typedResult.success,
      draft: !!typedResult.draft,
      submitted: !!typedResult.submitted,
      details: {
        editorSelector: typedResult.editorSelector,
        buttonSelector: typedResult.buttonSelector,
        writtenText: typedResult.writtenText,
      },
    };
  }

  private async tryToggleFollowButton(
    action: "follow" | "unfollow",
    userHandle?: string,
  ): Promise<{
    success: boolean;
    details?: {
      selector?: string;
      changed?: boolean;
      beforeText?: string;
      afterText?: string;
      attempts?: number;
      reason?: string;
    };
    error?: string;
  }> {
    const actionTarget = action;
    const expectUnfollow = actionTarget === "unfollow";
    const script = buildXToggleFollowScript({
      buttonLabels: XTools.FOLLOW_BUTTON_LABELS,
      followSelectors: XTools.FOLLOW_BUTTON_SELECTORS,
      expectUnfollow,
      actionTarget,
      maxRetries: XTools.FOLLOW_RETRY_ATTEMPTS,
      retryDelayMs: XTools.FOLLOW_RETRY_DELAY_MS,
      userHandle,
    });

    const scriptResult = await this.runBrowserScript(script);
    if (!scriptResult.success || !scriptResult.result) {
      return {
        success: false,
        error: scriptResult.error || `Failed to ${actionTarget} via browser`,
      };
    }

    const result = scriptResult.result as {
      success?: boolean;
      selector?: string;
      reason?: string;
      changed?: boolean;
      attempts?: number;
      beforeText?: string;
      afterText?: string;
    };
    if (!result.success) {
      return {
        success: false,
        error: result.reason || `Failed to ${actionTarget} on X`,
      };
    }

    if (result.changed === false) {
      return {
        success: false,
        error: `Follow/unfollow button state did not change for ${userHandle || "target user"} in browser UI.`,
        details: {
          selector: result.selector,
          beforeText: result.beforeText,
          afterText: result.afterText,
          changed: false,
          attempts: result.attempts,
          reason: result.reason,
        },
      };
    }

    return {
      success: true,
      details: {
        selector: result.selector,
        changed: result.changed,
        attempts: result.attempts,
        beforeText: result.beforeText,
        afterText: result.afterText,
      },
    };
  }

  private async runBrowserWriteFallback(
    action: XWriteAction,
    input: XActionInput,
    reason: string,
  ): Promise<Any> {
    const fallbackUrl = this.getBrowserFallbackUrl(action, input);

    const openResult = await this.openBrowserFallbackPage(fallbackUrl);
    if (!openResult.navResult) {
      const fallbackError = openResult.error || "Browser fallback navigation failed";
      return {
        success: false,
        action,
        output: `${this.buildFallbackMessage(action, reason)} Browser fallback navigation failed: ${fallbackError}`,
        fallback: {
          method: "browser",
          reason,
          requestedUrl: fallbackUrl,
          error: fallbackError,
          browserChannel: openResult.browserChannel,
        },
      };
    }

    const navResult = openResult.navResult;
    let writePageText: string | undefined;
    let writePageLikelyBlocked = false;

    try {
      const writePageContent = await this.browserTools.executeTool("browser_get_content", {});
      const contentText =
        typeof writePageContent?.text === "string" ? writePageContent.text : undefined;
      writePageText = this.trimTextForPrompt(contentText);
      writePageLikelyBlocked = this.isLikelyBrowserBlocked(writePageText);
    } catch  {
      writePageText = undefined;
      writePageLikelyBlocked = false;
    }

    if (writePageLikelyBlocked) {
      return {
        success: false,
        action,
        output: `${this.buildFallbackMessage(action, reason)} Browser page appears blocked/challenge-gated before automation.`,
        fallback: {
          ...this.buildFallbackDetails(action, input),
          requestedUrl: fallbackUrl,
          navigatedUrl: navResult?.url,
          navigationStatus: navResult?.isError ? "partial" : "loaded",
          method: "browser",
          manualAction:
            "Resolve any challenge/login in the opened browser, then retry this X action.",
          reason: "Browser challenge or login gate detected",
          browserChannel: openResult.browserChannel,
        },
      };
    }

    const isWriteReady = await this.waitForBrowserWriteReadiness(action);
    if (!isWriteReady) {
      return {
        success: false,
        action,
        output: `${this.buildFallbackMessage(action, reason)} Browser page did not expose write controls in time.`,
        fallback: {
          ...this.buildFallbackDetails(action, input),
          requestedUrl: fallbackUrl,
          navigatedUrl: navResult?.url || fallbackUrl,
          navigationStatus: navResult?.isError ? "partial" : "loaded",
          method: "browser",
          manualAction:
            "Keep the browser open and retry once the compose/follow controls are visible.",
          blockedText: writePageText,
          browserChannel: openResult.browserChannel,
        },
      };
    }

    if (action === "tweet" || action === "reply") {
      if ((input.media || []).length > 0) {
        return {
          success: false,
          action,
          output:
            this.buildFallbackMessage(action, reason) +
            " Media upload is not supported in automated browser fallback yet.",
          fallback: {
            ...this.buildFallbackDetails(action, input),
            requestedUrl: fallbackUrl,
            navigatedUrl: navResult?.url,
            navigationStatus: navResult?.isError ? "partial" : "loaded",
            manualAction: "reopen composer and attach media manually",
            mediaCount: input.media?.length || 0,
            browserChannel: openResult.browserChannel,
          },
          error: "Media fallback requires manual completion.",
        };
      }

      const composeResult = await this.tryComposeInBrowser(input.text || "", action);
      if (composeResult.success && composeResult.submitted) {
        return {
          success: true,
          action,
          output: `X CLI blocked (${reason}). Browser automation posted content from fallback flow.`,
          fallback: {
            ...this.buildFallbackDetails(action, input),
            requestedUrl: fallbackUrl,
            navigatedUrl: navResult?.url || fallbackUrl,
            navigationStatus: navResult?.isError ? "partial" : "loaded",
            submitted: true,
            draftUsed: composeResult.draft,
            method: "browser_auto",
            details: composeResult.details,
            error: undefined,
            browserChannel: openResult.browserChannel,
          },
        };
      }

      let errorMessage = composeResult.error || "Unable to complete browser compose flow";
      if (composeResult.details?.reason) {
        errorMessage = `${errorMessage} (${composeResult.details.reason})`;
      }

      return {
        success: false,
        action,
        output: `${this.buildFallbackMessage(action, reason)} ${errorMessage}`,
        fallback: {
          ...this.buildFallbackDetails(action, input),
          requestedUrl: fallbackUrl,
          navigatedUrl: navResult?.url || fallbackUrl,
          navigationStatus: navResult?.isError ? "partial" : "loaded",
          submitted: false,
          draftUsed: composeResult.draft,
          method: "browser",
          details: composeResult.details,
          browserChannel: openResult.browserChannel,
        },
      };
    }

    if (action === "follow" || action === "unfollow") {
      const normalizedHandle = this.normalizeHandle(input.user) || "";
      const followResult = await this.tryToggleFollowButton(action, input.user);
      const manualAction = normalizedHandle
        ? `Open https://x.com/${normalizedHandle.replace(/^@/, "")} and click ${action} manually.`
        : "Open the target profile in the opened browser and click follow/unfollow manually.";
      if (followResult.success) {
        return {
          success: true,
          action,
          output: `X CLI blocked (${reason}). Browser automation attempted ${action}.`,
          fallback: {
            ...this.buildFallbackDetails(action, input),
            requestedUrl: fallbackUrl,
            navigatedUrl: navResult?.url || fallbackUrl,
            navigationStatus: navResult?.isError ? "partial" : "loaded",
            method: "browser_auto",
            details: followResult.details,
            browserChannel: openResult.browserChannel,
          },
        };
      }

      return {
        success: false,
        action,
        output: `${this.buildFallbackMessage(action, reason)} Failed to execute ${action} in browser: ${followResult.error}`,
        fallback: {
          ...this.buildFallbackDetails(action, input),
          requestedUrl: fallbackUrl,
          navigatedUrl: navResult?.url || fallbackUrl,
          navigationStatus: navResult?.isError ? "partial" : "loaded",
          method: "browser",
          details: followResult.details,
          manualAction,
          blockedText: writePageText,
          browserChannel: openResult.browserChannel,
        },
      };
    }

    return {
      success: false,
      action,
      output: `${this.buildFallbackMessage(action, reason)} This action is not supported for browser write automation.`,
      fallback: {
        ...this.buildFallbackDetails(action, input),
        requestedUrl: fallbackUrl,
        navigatedUrl: navResult?.url || fallbackUrl,
        navigationStatus: navResult?.isError ? "partial" : "loaded",
        browserChannel: openResult.browserChannel,
      },
      error: "Browser write fallback does not support this action yet.",
    };
  }

  private async runBrowserFallback(
    action: XAction,
    input: XActionInput,
    reason: string,
  ): Promise<Any> {
    if (this.isWriteAction(action)) {
      return await this.runBrowserWriteFallback(action, input, reason);
    }

    const fallbackUrl = this.getBrowserFallbackUrl(action, input);
    let navResult: Any;
    let content: Any;
    let extractedItems: BrowserFallbackTweetItem[] = [];

    const openResult = await this.openBrowserFallbackPage(fallbackUrl);
    if (!openResult.navResult) {
      const fallbackError = openResult.error || "Browser fallback failed";
      return {
        success: false,
        action,
        output: `${this.buildFallbackMessage(action, reason)} Browser fallback open failed: ${fallbackError}`,
        fallback: {
          method: "browser",
          reason,
          requestedUrl: fallbackUrl,
          error: fallbackError,
          browserChannel: openResult.browserChannel,
        },
      };
    }

    navResult = openResult.navResult;
    const isReady = await this.waitForBrowserReadiness(action);
    if (!isReady) {
      return {
        success: false,
        action,
        output: `${this.buildFallbackMessage(action, reason)} Browser page did not expose tweet nodes in a timely way.`,
        fallback: {
          ...this.buildFallbackDetails(action, input),
          requestedUrl: fallbackUrl,
          navigatedUrl: navResult?.url || undefined,
          navigationStatus: navResult?.isError ? "partial" : "loaded",
          browserChannel: openResult.browserChannel,
          manualAction:
            "Browser content appears slow to load. Keep page open, wait, then retry if needed.",
        },
      };
    }

    try {
      content = await this.browserTools.executeTool("browser_get_content", {});
      extractedItems = await this.extractBrowserReadableContent(action);
    } catch (error: Any) {
      const fallbackError = error?.message || "Browser fallback failed";
      return {
        success: false,
        action,
        output: `${this.buildFallbackMessage(action, reason)} Browser fallback open failed: ${fallbackError}`,
        fallback: {
          method: "browser",
          reason,
          requestedUrl: fallbackUrl,
          error: fallbackError,
          browserChannel: openResult.browserChannel,
        },
      };
    }

    const text =
      typeof content?.text === "string" ? this.trimTextForPrompt(content.text) : undefined;
    const likelyBlocked = this.isLikelyBrowserBlocked(text);
    const hasExtractedItems = extractedItems.length > 0;
    const hasUsefulData = hasExtractedItems || !!(text && text.trim().length > 0);
    const extractionWarning =
      !hasExtractedItems && !this.isWriteAction(action)
        ? "No structured tweet items parsed from the browser content. Output includes raw page text only."
        : undefined;

    return {
      success: !this.isWriteAction(action) && !likelyBlocked && hasUsefulData,
      action,
      output:
        this.buildFallbackMessage(action, reason) +
        (likelyBlocked ? " Browser content appears to be blocked/challenge page." : "") +
        (extractionWarning ? ` ${extractionWarning}` : ""),
      data: {
        url: content?.url,
        title: content?.title,
        text,
        items: extractedItems,
        source: hasExtractedItems ? extractedItems[0]?.source || "generic" : undefined,
        hasExtractedItems,
      },
      fallback: {
        ...this.buildFallbackDetails(action, input),
        requestedUrl: fallbackUrl,
        navigatedUrl: navResult?.url || content?.url,
        navigationStatus: navResult?.isError ? "partial" : "loaded",
        browserChannel: openResult.browserChannel,
        manualAction: likelyBlocked
          ? "Keep the browser open and complete any login/challenge flow, then retry."
          : undefined,
      },
      error: this.isWriteAction(action)
        ? "Posting blocked via CLI; browser fallback opened the target page for manual completion."
        : likelyBlocked
          ? "Browser returned a blocked/challenge page; read output may be incomplete."
          : extractionWarning
            ? extractionWarning
            : undefined,
    };
  }

  static isEnabled(): boolean {
    return XSettingsManager.loadSettings().enabled;
  }

  private normalizeHandle(handle?: string): string | undefined {
    if (!handle) return undefined;
    const trimmed = handle.trim();
    if (!trimmed) return undefined;

    const safe = trimmed.replace(/[.,!?;:)\]}]+$/g, "").trim();
    if (!safe) return undefined;

    const candidateWithScheme = safe.startsWith("http") ? safe : `https://${safe}`;
    const likelyUrl = /^(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\//i;
    if (likelyUrl.test(candidateWithScheme)) {
      try {
        const parsed = new URL(candidateWithScheme);
        const hostname = parsed.hostname.toLowerCase();
        if (!hostname.includes("x.com") && !hostname.includes("twitter.com")) {
          return undefined;
        }

        const segments = parsed.pathname
          .split("/")
          .map((segment) => segment.trim())
          .filter((segment) => segment.length > 0);

        if (segments.length === 0) {
          return undefined;
        }

        const firstSegment = segments[0];
        const blockedSegments = [
          "home",
          "explore",
          "search",
          "notifications",
          "i",
          "status",
          "intent",
        ];
        if (!firstSegment || blockedSegments.includes(firstSegment.toLowerCase())) {
          return undefined;
        }

        const normalizedHandle = firstSegment.startsWith("@")
          ? firstSegment.slice(1)
          : firstSegment;
        if (!/^[a-zA-Z0-9_]{1,15}$/i.test(normalizedHandle)) {
          return undefined;
        }

        return `@${normalizedHandle}`;
      } catch {
        return undefined;
      }
    }

    const bareHandle = safe.startsWith("@") ? safe.slice(1) : safe;
    if (!/^[a-zA-Z0-9_]{1,15}$/i.test(bareHandle)) {
      return undefined;
    }
    const blockedHandles = [
      "home",
      "explore",
      "search",
      "notifications",
      "i",
      "status",
      "intent",
      "messages",
      "compose",
      "settings",
      "account",
      "help",
      "login",
      "signup",
    ];
    if (blockedHandles.includes(bareHandle.toLowerCase())) {
      return undefined;
    }
    return `@${bareHandle}`;
  }

  private resolveMediaPaths(media?: string[]): string[] {
    if (!media || media.length === 0) return [];
    if (!this.workspace.permissions.read) {
      throw new Error("Read permission not granted for media uploads");
    }

    const normalized = media
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .slice(0, MAX_MEDIA);

    const workspaceRoot = path.resolve(this.workspace.path);
    const allowedPaths = this.workspace.permissions.allowedPaths || [];
    const canReadOutside =
      this.workspace.isTemp || this.workspace.permissions.unrestrictedFileAccess;

    const isPathAllowed = (absolutePath: string): boolean => {
      if (allowedPaths.length === 0) return false;
      const normalizedPath = path.normalize(absolutePath);
      return allowedPaths.some((allowed) => {
        const normalizedAllowed = path.normalize(allowed);
        return (
          normalizedPath === normalizedAllowed ||
          normalizedPath.startsWith(normalizedAllowed + path.sep)
        );
      });
    };

    const resolved = normalized.map((item) => {
      const candidate = path.isAbsolute(item)
        ? path.normalize(item)
        : path.resolve(workspaceRoot, item);

      const relative = path.relative(workspaceRoot, candidate);
      const isInsideWorkspace = !(relative.startsWith("..") || path.isAbsolute(relative));
      if (!isInsideWorkspace && !canReadOutside && !isPathAllowed(candidate)) {
        throw new Error("Media path must be inside the workspace or in Allowed Paths");
      }
      if (!fs.existsSync(candidate)) {
        throw new Error(`Media file not found: ${item}`);
      }
      const stats = fs.statSync(candidate);
      if (!stats.isFile()) {
        throw new Error(`Media path is not a file: ${item}`);
      }
      return candidate;
    });

    return resolved;
  }

  private async requireApproval(summary: string, details: Record<string, unknown>): Promise<void> {
    const approved = await this.daemon.requestApproval(
      this.taskId,
      "external_service",
      summary,
      details,
    );

    if (!approved) {
      throw new Error("User denied X action");
    }
  }

  async executeAction(input: XActionInput): Promise<Any> {
    const settings = XSettingsManager.loadSettings();
    if (!settings.enabled) {
      throw new Error("X integration is disabled. Enable it in Settings > X (Twitter).");
    }

    const action = input.action;
    if (!action) {
      throw new Error('Missing required "action" parameter');
    }

    const args: string[] = [];

    switch (action) {
      case "whoami": {
        args.push("whoami");
        break;
      }
      case "read": {
        if (!input.id_or_url) throw new Error("Missing id_or_url for read");
        args.push("read", input.id_or_url);
        break;
      }
      case "thread": {
        if (!input.id_or_url) throw new Error("Missing id_or_url for thread");
        args.push("thread", input.id_or_url);
        break;
      }
      case "replies": {
        if (!input.id_or_url) throw new Error("Missing id_or_url for replies");
        args.push("replies", input.id_or_url);
        break;
      }
      case "search": {
        if (!input.query) throw new Error("Missing query for search");
        args.push("search", input.query);
        if (input.count) {
          const count = Math.min(Math.max(1, input.count), MAX_COUNT);
          args.push("-n", String(count));
        }
        break;
      }
      case "user_tweets": {
        const handle = this.normalizeHandle(input.user);
        if (!handle) throw new Error("Missing user for user_tweets");
        args.push("user-tweets", handle);
        if (input.count) {
          const count = Math.min(Math.max(1, input.count), MAX_COUNT);
          args.push("-n", String(count));
        }
        break;
      }
      case "mentions": {
        args.push("mentions");
        const handle = this.normalizeHandle(input.user);
        if (handle) {
          args.push("--user", handle);
        }
        if (input.count) {
          const count = Math.min(Math.max(1, input.count), MAX_COUNT);
          args.push("-n", String(count));
        }
        break;
      }
      case "home": {
        args.push("home");
        if (input.timeline === "following") {
          args.push("--following");
        }
        if (input.count) {
          const count = Math.min(Math.max(1, input.count), MAX_COUNT);
          args.push("-n", String(count));
        }
        break;
      }
      case "tweet": {
        if (!input.text) throw new Error("Missing text for tweet");
        const mediaPaths = this.resolveMediaPaths(input.media);
        const preview = input.text.length > 120 ? `${input.text.slice(0, 117)}...` : input.text;
        await this.requireApproval(`Post to X: "${preview}"`, {
          action: "tweet",
          text: input.text,
          mediaCount: mediaPaths.length,
        });
        args.push("tweet", input.text);
        for (const mediaPath of mediaPaths) {
          args.push("--media", mediaPath);
        }
        if (input.alt) {
          args.push("--alt", input.alt);
        }
        break;
      }
      case "reply": {
        if (!input.id_or_url) throw new Error("Missing id_or_url for reply");
        if (!input.text) throw new Error("Missing text for reply");
        const mediaPaths = this.resolveMediaPaths(input.media);
        const preview = input.text.length > 120 ? `${input.text.slice(0, 117)}...` : input.text;
        await this.requireApproval(`Reply on X: "${preview}"`, {
          action: "reply",
          inReplyTo: input.id_or_url,
          text: input.text,
          mediaCount: mediaPaths.length,
        });
        args.push("reply", input.id_or_url, input.text);
        for (const mediaPath of mediaPaths) {
          args.push("--media", mediaPath);
        }
        if (input.alt) {
          args.push("--alt", input.alt);
        }
        break;
      }
      case "follow": {
        const handle = this.normalizeHandle(input.user);
        if (!handle) throw new Error("Missing user for follow");
        await this.requireApproval(`Follow ${handle} on X`, { action: "follow", user: handle });
        args.push("follow", handle);
        break;
      }
      case "unfollow": {
        const handle = this.normalizeHandle(input.user);
        if (!handle) throw new Error("Missing user for unfollow");
        await this.requireApproval(`Unfollow ${handle} on X`, { action: "unfollow", user: handle });
        args.push("unfollow", handle);
        break;
      }
      default:
        throw new Error(`Unsupported action: ${action}`);
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < XTools.COMMAND_RETRY_ATTEMPTS; attempt++) {
      try {
        const result = await runBirdCommand(settings, args, { json: true });

        this.daemon.logEvent(this.taskId, "tool_result", {
          tool: "x_action",
          action,
          hasData: !!result.data,
          stderr: result.stderr ? true : false,
        });

        return {
          success: true,
          action,
          output: result.stdout,
          data: result.data,
          stderr: result.stderr || undefined,
        };
      } catch (error: Any) {
        lastError = error;
        const errorMessage = error?.message || "Failed to execute X action";

        this.daemon.logEvent(this.taskId, "tool_result", {
          tool: "x_action",
          action,
          error: errorMessage,
          blocked: this.isLikelyBlockingError(errorMessage),
        });

        if (this.isLikelyBlockingError(errorMessage)) {
          return await this.runBrowserFallback(action, input, errorMessage);
        }

        if (
          !this.shouldRetryCommand(action) ||
          !this.isRetryableCommandError(errorMessage) ||
          attempt + 1 >= XTools.COMMAND_RETRY_ATTEMPTS
        ) {
          throw error;
        }

        await this.pause(XTools.COMMAND_RETRY_DELAY_MS * (attempt + 1));
      }
    }

    throw lastError;
  }
}
