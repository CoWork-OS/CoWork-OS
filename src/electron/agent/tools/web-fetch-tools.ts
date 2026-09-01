import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import { LLMTool } from "../llm/types";
import { evaluateNetworkPolicy } from "../../security/network-policy";
import { ProtectedCredentialService } from "../../security/protected-credential-service";

const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const MAX_PROTECTED_CREDENTIAL_PREFIX_LENGTH = 256;

function redactSecret(value: string, secret?: string): string {
  if (!secret) return value;
  return value.split(secret).join("[REDACTED]");
}

/**
 * WebFetchTools provides lightweight URL fetching without browser automation.
 * This is faster and more efficient than browser tools for reading web content.
 * Converts HTML to readable markdown format.
 * Also includes curl-like http_request tool for raw HTTP requests.
 */
export class WebFetchTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
    private protectedCredentialService?: ProtectedCredentialService,
  ) {}

  /**
   * Update the workspace for this tool
   */
  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  private ensureDomainAllowed(url: string): void {
    this.ensureNetworkAllowed(url, "web_fetch");
  }

  private ensureNetworkAllowed(url: string, toolName: string): void {
    const decision = evaluateNetworkPolicy({
      url,
      toolName,
      networkEnabled: this.workspace.permissions?.network,
      accessNetworkMode: this.workspace.permissions?.accessNetworkMode,
      profileDomainRules: this.workspace.permissions?.accessDomainRules,
    });
    this.daemon.logEvent(this.taskId, "network_policy_decision", decision);
    if (decision.action === "allow") return;
    if (decision.reason === "legacy_guardrail_domain_denied") {
      throw new Error(`Domain not allowed: "${url}"`);
    }
    throw new Error(`Network access denied for "${url}": ${decision.reason}`);
  }

  private async fetchWithPolicyCheckedRedirects(
    url: string,
    init: RequestInit,
    toolName: string,
    followRedirects = true,
  ): Promise<Response> {
    let currentUrl = url;
    let currentInit: RequestInit = { ...init };

    for (let redirectCount = 0; redirectCount <= 10; redirectCount += 1) {
      const parsedUrl = new URL(currentUrl);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        throw new Error("Only HTTP and HTTPS URLs are supported");
      }
      this.ensureNetworkAllowed(parsedUrl.toString(), toolName);

      const response = await fetch(currentUrl, {
        ...currentInit,
        redirect: "manual",
      });

      if (!followRedirects || !this.isRedirectResponse(response.status)) {
        return response;
      }

      const location = response.headers.get("location");
      if (!location) {
        return response;
      }

      const nextUrl = new URL(location, parsedUrl);
      if (!["http:", "https:"].includes(nextUrl.protocol)) {
        throw new Error("Only HTTP and HTTPS redirect URLs are supported");
      }
      this.ensureNetworkAllowed(nextUrl.toString(), toolName);

      currentUrl = nextUrl.toString();
      currentInit = this.buildRedirectInit(currentInit, response.status);
    }

    throw new Error("Too many redirects");
  }

  private isRedirectResponse(status: number): boolean {
    return [301, 302, 303, 307, 308].includes(status);
  }

  private buildRedirectInit(init: RequestInit, status: number): RequestInit {
    const method = String(init.method || "GET").toUpperCase();
    if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
      const { body: _body, ...rest } = init;
      return {
        ...rest,
        method: "GET",
      };
    }
    return { ...init };
  }

  private resolveProtectedCredential(
    credentialId: unknown,
    destination: string,
    credentialHeader: unknown,
    credentialPrefix: unknown,
  ): { used: false } | { used: true; secret: string; headerName: string; prefix: string } {
    if (credentialId === undefined || credentialId === null || credentialId === "") {
      return { used: false };
    }
    if (typeof credentialId !== "string" || !credentialId.trim()) {
      throw new Error("credentialId must be a non-empty protected credential id.");
    }
    if (!this.protectedCredentialService) {
      throw new Error("Protected credential support is unavailable in this runtime.");
    }

    const headerName = credentialHeader === undefined ? "Authorization" : credentialHeader;
    if (typeof headerName !== "string" || !HTTP_HEADER_NAME_PATTERN.test(headerName.trim())) {
      throw new Error("credentialHeader must be a valid HTTP header name.");
    }
    const prefix = credentialPrefix === undefined ? "Bearer " : credentialPrefix;
    if (
      typeof prefix !== "string" ||
      prefix.length > MAX_PROTECTED_CREDENTIAL_PREFIX_LENGTH ||
      /[\r\n]/.test(prefix)
    ) {
      throw new Error("credentialPrefix must be a short value without line breaks.");
    }

    return {
      used: true,
      secret: this.protectedCredentialService.resolveForDestination(
        credentialId.trim(),
        destination,
      ),
      headerName: headerName.trim(),
      prefix,
    };
  }

  private applyProtectedCredentialHeader(
    headers: Record<string, string>,
    credential:
      | { used: false }
      | { used: true; secret: string; headerName: string; prefix: string },
  ): void {
    if (!credential.used) return;
    const normalizedHeaderName = credential.headerName.toLowerCase();
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === normalizedHeaderName) delete headers[key];
    }
    headers[credential.headerName] = `${credential.prefix}${credential.secret}`;
  }

  /**
   * Get tool definitions for WebFetch tools
   */
  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: "web_fetch",
        description:
          "Fetch and read content from a SPECIFIC URL. PREFERRED for reading a known page. Returns the page content as readable text/markdown. " +
          "Use this when you have an exact URL to read (from search results, user-provided, or known documentation). " +
          "For RESEARCH/DISCOVERY tasks (finding information on a topic), use web_search FIRST instead. " +
          "Much faster than browser tools. Use browser_navigate only for interactive pages or JavaScript-heavy content.",
        input_schema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The URL to fetch content from",
            },
            selector: {
              type: "string",
              description:
                'Optional CSS selector to extract specific content (e.g., "article", "main", ".content")',
            },
            includeLinks: {
              type: "boolean",
              description: "Whether to include links in the output (default: true)",
            },
            maxLength: {
              type: "number",
              description: "Maximum content length to return (default: 50000 characters)",
            },
            credentialId: {
              type: "string",
              description:
                "Optional protected credential id. The secret is resolved only in the main process and is never returned to the agent.",
            },
            credentialHeader: {
              type: "string",
              description: "Header name for the protected credential (default: Authorization).",
            },
            credentialPrefix: {
              type: "string",
              description:
                "Prefix placed before the protected credential (default: 'Bearer '). Use an empty string for a raw key.",
            },
          },
          required: ["url"],
        },
      },
      {
        name: "http_request",
        description:
          "Make HTTP requests like curl. Supports all HTTP methods, custom headers, and request bodies. " +
          "Returns raw response without HTML-to-markdown conversion. " +
          "Use this for APIs, raw file downloads, or when you need full control over the HTTP request. " +
          "For reading web pages as markdown, prefer web_fetch instead. For research/discovery, prefer web_search first and then web_fetch specific source URLs instead of hand-building search engine requests.",
        input_schema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The URL to make the request to",
            },
            method: {
              type: "string",
              enum: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
              description: "HTTP method (default: GET)",
            },
            headers: {
              type: "object",
              description:
                'Custom headers as key-value pairs (e.g., {"Authorization": "Bearer token", "Content-Type": "application/json"})',
              additionalProperties: { type: "string" },
            },
            body: {
              type: "string",
              description:
                "Request body for POST/PUT/PATCH requests. For JSON, stringify the object first.",
            },
            timeout: {
              type: "number",
              description: "Request timeout in milliseconds (default: 30000)",
            },
            followRedirects: {
              type: "boolean",
              description: "Whether to follow redirects (default: true)",
            },
            maxLength: {
              type: "number",
              description: "Maximum response length to return (default: 100000 characters)",
            },
            credentialId: {
              type: "string",
              description:
                "Optional protected credential id. The secret is resolved only in the main process and is never returned to the agent.",
            },
            credentialHeader: {
              type: "string",
              description: "Header name for the protected credential (default: Authorization).",
            },
            credentialPrefix: {
              type: "string",
              description:
                "Prefix placed before the protected credential (default: 'Bearer '). Use an empty string for a raw key.",
            },
          },
          required: ["url"],
        },
      },
    ];
  }

  /**
   * Fetch content from a URL and convert to readable format
   */
  async webFetch(input: {
    url: string;
    selector?: string;
    includeLinks?: boolean;
    maxLength?: number;
    credentialId?: string;
    credentialHeader?: string;
    credentialPrefix?: string;
  }): Promise<{
    success: boolean;
    url: string;
    title?: string;
    content: string;
    contentLength: number;
    error?: string;
  }> {
    const {
      url,
      selector,
      includeLinks = true,
      maxLength = 50000,
      credentialId,
      credentialHeader,
      credentialPrefix,
    } = input;
    let credentialSecret: string | undefined;

    this.daemon.logEvent(this.taskId, "log", {
      message: `Fetching: ${url}`,
    });

    try {
      // Validate URL
      const parsedUrl = new URL(url);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        throw new Error("Only HTTP and HTTPS URLs are supported");
      }
      const credential = this.resolveProtectedCredential(
        credentialId,
        parsedUrl.toString(),
        credentialHeader,
        credentialPrefix,
      );
      if (credential.used) credentialSecret = credential.secret;
      const requestHeaders: Record<string, string> = {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      };
      this.applyProtectedCredentialHeader(requestHeaders, credential);

      // Fetch with timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      const response = await this.fetchWithPolicyCheckedRedirects(
        url,
        {
          signal: controller.signal,
          headers: requestHeaders,
        },
        "web_fetch",
        !credential.used,
      );

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const contentType = response.headers.get("content-type") || "";
      let content: string;
      let title: string | undefined;

      if (contentType.includes("application/json")) {
        // JSON response - format nicely, with fallback to raw text
        const rawText = await response.text();
        try {
          const json = JSON.parse(rawText);
          content = JSON.stringify(json, null, 2);
        } catch {
          // Invalid JSON - return raw text
          content = rawText;
        }
        title = "JSON Response";
      } else if (contentType.includes("text/plain")) {
        // Plain text
        content = await response.text();
        title = "Plain Text";
      } else {
        // HTML - convert to markdown
        const html = await response.text();
        const result = this.htmlToMarkdown(html, selector, includeLinks);
        content = result.content;
        title = result.title;
      }

      // Truncate if needed
      if (content.length > maxLength) {
        content = content.substring(0, maxLength) + "\n\n... [Content truncated]";
      }
      content = redactSecret(content, credentialSecret);
      title = title ? redactSecret(title, credentialSecret) : title;

      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "web_fetch",
        result: {
          url,
          title,
          contentLength: content.length,
          truncated: content.length > maxLength,
        },
      });

      return {
        success: true,
        url,
        title,
        content,
        contentLength: content.length,
      };
    } catch (error: Any) {
      const errorMessage = redactSecret(
        error.name === "AbortError" ? "Request timed out" : error.message,
        credentialSecret,
      );

      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "web_fetch",
        error: errorMessage,
      });

      return {
        success: false,
        url,
        content: "",
        contentLength: 0,
        error: errorMessage,
      };
    }
  }

  /**
   * Make an HTTP request like curl - returns raw response
   */
  async httpRequest(input: {
    url: string;
    method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS";
    headers?: Record<string, string>;
    body?: string;
    timeout?: number;
    followRedirects?: boolean;
    maxLength?: number;
    credentialId?: string;
    credentialHeader?: string;
    credentialPrefix?: string;
  }): Promise<{
    success: boolean;
    url: string;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
    contentLength: number;
    error?: string;
  }> {
    const {
      url,
      method = "GET",
      headers = {},
      body,
      timeout = 30000,
      followRedirects = true,
      maxLength = 100000,
      credentialId,
      credentialHeader,
      credentialPrefix,
    } = input;
    let credentialSecret: string | undefined;

    this.daemon.logEvent(this.taskId, "log", {
      message: `HTTP ${method}: ${url}`,
    });

    try {
      const normalizedUrl = this.normalizeHttpRequestUrl(url);

      // Validate URL
      const parsedUrl = new URL(normalizedUrl);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        throw new Error("Only HTTP and HTTPS URLs are supported");
      }
      const credential = this.resolveProtectedCredential(
        credentialId,
        parsedUrl.toString(),
        credentialHeader,
        credentialPrefix,
      );
      if (credential.used) credentialSecret = credential.secret;

      // Setup abort controller for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      // Default headers
      const requestHeaders: Record<string, string> = {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        ...headers,
      };
      this.applyProtectedCredentialHeader(requestHeaders, credential);

      // Make the request
      const response = await this.fetchWithPolicyCheckedRedirects(
        normalizedUrl,
        {
          method,
          headers: requestHeaders,
          body: ["POST", "PUT", "PATCH"].includes(method) ? body : undefined,
          signal: controller.signal,
        },
        "http_request",
        followRedirects && !credential.used,
      );

      clearTimeout(timeoutId);

      // Extract response headers
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = redactSecret(value, credentialSecret);
      });

      // Get response body
      let responseBody: string;
      const contentType = response.headers.get("content-type") || "";

      if (method === "HEAD") {
        responseBody = ""; // HEAD requests don't have a body
      } else if (contentType.includes("application/json")) {
        // Try to parse as JSON, fallback to raw text if parsing fails
        const rawText = await response.text();
        try {
          const json = JSON.parse(rawText);
          responseBody = JSON.stringify(json, null, 2);
        } catch {
          // Invalid JSON - return raw text
          responseBody = rawText;
        }
      } else {
        responseBody = await response.text();
      }

      // Truncate if needed
      const truncated = responseBody.length > maxLength;
      if (truncated) {
        responseBody = responseBody.substring(0, maxLength) + "\n\n... [Response truncated]";
      }
      responseBody = redactSecret(responseBody, credentialSecret);

      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "http_request",
        result: {
          url,
          normalizedUrl: normalizedUrl !== url ? normalizedUrl : undefined,
          method,
          status: response.status,
          contentLength: responseBody.length,
          truncated,
        },
      });

      return {
        success: response.ok,
        url,
        status: response.status,
        statusText: redactSecret(response.statusText, credentialSecret),
        headers: responseHeaders,
        body: responseBody,
        contentLength: responseBody.length,
      };
    } catch (error: Any) {
      const errorMessage = redactSecret(
        error.name === "AbortError" ? "Request timed out" : error.message,
        credentialSecret,
      );

      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "http_request",
        error: errorMessage,
      });

      return {
        success: false,
        url,
        status: 0,
        statusText: "Error",
        headers: {},
        body: "",
        contentLength: 0,
        error: errorMessage,
      };
    }
  }

  private normalizeHttpRequestUrl(rawUrl: string): string {
    const url = String(rawUrl || "").trim();
    for (const prefix of [
      "https://r.jina.ai/http://r.jina.ai/http://",
      "http://r.jina.ai/http://r.jina.ai/http://",
    ]) {
      if (url.startsWith(prefix)) {
        const scheme = prefix.startsWith("http://") ? "http" : "https";
        return `${scheme}://r.jina.ai/http://${url.slice(prefix.length)}`;
      }
    }

    for (const prefix of ["https://r.jina.ai/http://", "http://r.jina.ai/http://"]) {
      if (!url.startsWith(prefix)) continue;
      const proxiedTarget = url.slice(prefix.length);
      if (/^https?:\/\//i.test(proxiedTarget)) {
        throw new Error(
          "Malformed proxied URL: nested absolute target after r.jina.ai/http://. Use a single proxied target host/path.",
        );
      }
    }

    return url;
  }

  /**
   * Convert HTML to readable markdown format
   */
  private htmlToMarkdown(
    html: string,
    selector?: string,
    includeLinks: boolean = true,
  ): { content: string; title?: string } {
    // Extract title
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? this.decodeHtmlEntities(titleMatch[1].trim()) : undefined;

    // If selector provided, try to extract that section
    let targetHtml = html;
    if (selector) {
      // Simple selector matching for common patterns
      const selectorPatterns: Record<string, RegExp> = {
        article: /<article[^>]*>([\s\S]*?)<\/article>/gi,
        main: /<main[^>]*>([\s\S]*?)<\/main>/gi,
        ".content": /<[^>]+class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/\w+>/gi,
        ".post": /<[^>]+class="[^"]*post[^"]*"[^>]*>([\s\S]*?)<\/\w+>/gi,
        ".article": /<[^>]+class="[^"]*article[^"]*"[^>]*>([\s\S]*?)<\/\w+>/gi,
        "#content": /<[^>]+id="content"[^>]*>([\s\S]*?)<\/\w+>/gi,
        "#main": /<[^>]+id="main"[^>]*>([\s\S]*?)<\/\w+>/gi,
      };

      const pattern = selectorPatterns[selector.toLowerCase()];
      if (pattern) {
        const match = pattern.exec(html);
        if (match) {
          targetHtml = match[1] || match[0];
        }
      }
    }

    // Remove unwanted elements
    targetHtml = targetHtml
      // Remove script tags
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
      // Remove style tags
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
      // Remove noscript tags
      .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, "")
      // Remove nav elements
      .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, "")
      // Remove footer elements
      .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, "")
      // Remove header elements (but keep h1-h6)
      .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, "")
      // Remove aside elements
      .replace(/<aside\b[^<]*(?:(?!<\/aside>)<[^<]*)*<\/aside>/gi, "")
      // Remove HTML comments
      .replace(/<!--[\s\S]*?-->/g, "")
      // Remove SVG elements
      .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, "");

    // Convert HTML to markdown-like text
    let content = targetHtml
      // Headers
      .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
      .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
      .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
      .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n")
      .replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n")
      .replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n")
      // Paragraphs
      .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "\n$1\n")
      // Line breaks
      .replace(/<br\s*\/?>/gi, "\n")
      // Bold
      .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
      // Italic
      .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*")
      // Code blocks
      .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n```\n$1\n```\n")
      .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n")
      // Inline code
      .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
      // Blockquotes
      .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, "\n> $1\n")
      // Lists
      .replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, "\n$1\n")
      .replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, "\n$1\n")
      .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n")
      // Tables (simplified)
      .replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, "\n$1\n")
      .replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, "$1\n")
      .replace(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi, "| $1 ")
      // Horizontal rules
      .replace(/<hr\s*\/?>/gi, "\n---\n")
      // Divs and spans (just extract content)
      .replace(/<div[^>]*>([\s\S]*?)<\/div>/gi, "\n$1\n")
      .replace(/<span[^>]*>([\s\S]*?)<\/span>/gi, "$1");

    // Handle links
    if (includeLinks) {
      content = content.replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
    } else {
      content = content.replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, "$1");
    }

    // Handle images (as markdown)
    content = content.replace(/<img[^>]+alt="([^"]*)"[^>]+src="([^"]*)"[^>]*>/gi, "![$1]($2)");
    content = content.replace(/<img[^>]+src="([^"]*)"[^>]+alt="([^"]*)"[^>]*>/gi, "![$2]($1)");
    content = content.replace(/<img[^>]+src="([^"]*)"[^>]*>/gi, "![image]($1)");

    // Remove remaining HTML tags
    content = content.replace(/<[^>]+>/g, "");

    // Decode HTML entities
    content = this.decodeHtmlEntities(content);

    // Clean up whitespace
    content = content
      // Multiple newlines to double newline
      .replace(/\n{3,}/g, "\n\n")
      // Multiple spaces to single space
      .replace(/ {2,}/g, " ")
      // Trim lines
      .split("\n")
      .map((line) => line.trim())
      .join("\n")
      // Remove empty lines at start/end
      .trim();

    return { content, title };
  }

  /**
   * Decode HTML entities
   */
  private decodeHtmlEntities(text: string): string {
    const entities: Record<string, string> = {
      "&amp;": "&",
      "&lt;": "<",
      "&gt;": ">",
      "&quot;": '"',
      "&#39;": "'",
      "&apos;": "'",
      "&nbsp;": " ",
      "&mdash;": "—",
      "&ndash;": "–",
      "&hellip;": "...",
      "&copy;": "(c)",
      "&reg;": "(R)",
      "&trade;": "(TM)",
      "&bull;": "*",
      "&rarr;": "->",
      "&larr;": "<-",
      "&laquo;": "<<",
      "&raquo;": ">>",
    };

    let result = text;
    for (const [entity, char] of Object.entries(entities)) {
      result = result.replace(new RegExp(entity, "g"), char);
    }

    // Handle numeric entities
    result = result.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
    result = result.replace(/&#x([a-fA-F0-9]+);/g, (_, code) =>
      String.fromCharCode(parseInt(code, 16)),
    );

    return result;
  }
}
