import { Workspace } from '../../../shared/types';
import { AgentDaemon } from '../daemon';
import { LLMTool } from '../llm/types';

/**
 * WebFetchTools provides lightweight URL fetching without browser automation.
 * This is faster and more efficient than browser tools for reading web content.
 * Converts HTML to readable markdown format.
 */
export class WebFetchTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string
  ) {}

  /**
   * Get tool definitions for WebFetch tools
   */
  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: 'web_fetch',
        description:
          'Fetch and read content from a URL. Returns the page content as readable text/markdown. ' +
          'This is the PREFERRED tool for reading web pages, documentation, articles, and GitHub repos. ' +
          'Much faster than browser automation. Use browser tools only when you need to interact with the page (click, fill forms, etc.).',
        input_schema: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'The URL to fetch content from',
            },
            selector: {
              type: 'string',
              description:
                'Optional CSS selector to extract specific content (e.g., "article", "main", ".content")',
            },
            includeLinks: {
              type: 'boolean',
              description: 'Whether to include links in the output (default: true)',
            },
            maxLength: {
              type: 'number',
              description: 'Maximum content length to return (default: 50000 characters)',
            },
          },
          required: ['url'],
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
  }): Promise<{
    success: boolean;
    url: string;
    title?: string;
    content: string;
    contentLength: number;
    error?: string;
  }> {
    const { url, selector, includeLinks = true, maxLength = 50000 } = input;

    this.daemon.logEvent(this.taskId, 'log', {
      message: `Fetching: ${url}`,
    });

    try {
      // Validate URL
      const parsedUrl = new URL(url);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error('Only HTTP and HTTPS URLs are supported');
      }

      // Fetch with timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        redirect: 'follow',
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type') || '';
      let content: string;
      let title: string | undefined;

      if (contentType.includes('application/json')) {
        // JSON response - format nicely
        const json = await response.json();
        content = JSON.stringify(json, null, 2);
        title = 'JSON Response';
      } else if (contentType.includes('text/plain')) {
        // Plain text
        content = await response.text();
        title = 'Plain Text';
      } else {
        // HTML - convert to markdown
        const html = await response.text();
        const result = this.htmlToMarkdown(html, selector, includeLinks);
        content = result.content;
        title = result.title;
      }

      // Truncate if needed
      if (content.length > maxLength) {
        content = content.substring(0, maxLength) + '\n\n... [Content truncated]';
      }

      this.daemon.logEvent(this.taskId, 'tool_result', {
        tool: 'web_fetch',
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
    } catch (error: any) {
      const errorMessage = error.name === 'AbortError' ? 'Request timed out' : error.message;

      this.daemon.logEvent(this.taskId, 'tool_result', {
        tool: 'web_fetch',
        error: errorMessage,
      });

      return {
        success: false,
        url,
        content: '',
        contentLength: 0,
        error: errorMessage,
      };
    }
  }

  /**
   * Convert HTML to readable markdown format
   */
  private htmlToMarkdown(
    html: string,
    selector?: string,
    includeLinks: boolean = true
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
        '.content': /<[^>]+class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/\w+>/gi,
        '.post': /<[^>]+class="[^"]*post[^"]*"[^>]*>([\s\S]*?)<\/\w+>/gi,
        '.article': /<[^>]+class="[^"]*article[^"]*"[^>]*>([\s\S]*?)<\/\w+>/gi,
        '#content': /<[^>]+id="content"[^>]*>([\s\S]*?)<\/\w+>/gi,
        '#main': /<[^>]+id="main"[^>]*>([\s\S]*?)<\/\w+>/gi,
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
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      // Remove style tags
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      // Remove noscript tags
      .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '')
      // Remove nav elements
      .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, '')
      // Remove footer elements
      .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, '')
      // Remove header elements (but keep h1-h6)
      .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, '')
      // Remove aside elements
      .replace(/<aside\b[^<]*(?:(?!<\/aside>)<[^<]*)*<\/aside>/gi, '')
      // Remove HTML comments
      .replace(/<!--[\s\S]*?-->/g, '')
      // Remove SVG elements
      .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '');

    // Convert HTML to markdown-like text
    let content = targetHtml
      // Headers
      .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
      .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
      .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
      .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n')
      .replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n##### $1\n')
      .replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n###### $1\n')
      // Paragraphs
      .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n')
      // Line breaks
      .replace(/<br\s*\/?>/gi, '\n')
      // Bold
      .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
      // Italic
      .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
      // Code blocks
      .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n')
      .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n')
      // Inline code
      .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
      // Blockquotes
      .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, '\n> $1\n')
      // Lists
      .replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, '\n$1\n')
      .replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, '\n$1\n')
      .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
      // Tables (simplified)
      .replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, '\n$1\n')
      .replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, '$1\n')
      .replace(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi, '| $1 ')
      // Horizontal rules
      .replace(/<hr\s*\/?>/gi, '\n---\n')
      // Divs and spans (just extract content)
      .replace(/<div[^>]*>([\s\S]*?)<\/div>/gi, '\n$1\n')
      .replace(/<span[^>]*>([\s\S]*?)<\/span>/gi, '$1');

    // Handle links
    if (includeLinks) {
      content = content.replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
    } else {
      content = content.replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, '$1');
    }

    // Handle images (as markdown)
    content = content.replace(/<img[^>]+alt="([^"]*)"[^>]+src="([^"]*)"[^>]*>/gi, '![$1]($2)');
    content = content.replace(/<img[^>]+src="([^"]*)"[^>]+alt="([^"]*)"[^>]*>/gi, '![$2]($1)');
    content = content.replace(/<img[^>]+src="([^"]*)"[^>]*>/gi, '![image]($1)');

    // Remove remaining HTML tags
    content = content.replace(/<[^>]+>/g, '');

    // Decode HTML entities
    content = this.decodeHtmlEntities(content);

    // Clean up whitespace
    content = content
      // Multiple newlines to double newline
      .replace(/\n{3,}/g, '\n\n')
      // Multiple spaces to single space
      .replace(/ {2,}/g, ' ')
      // Trim lines
      .split('\n')
      .map((line) => line.trim())
      .join('\n')
      // Remove empty lines at start/end
      .trim();

    return { content, title };
  }

  /**
   * Decode HTML entities
   */
  private decodeHtmlEntities(text: string): string {
    const entities: Record<string, string> = {
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&#39;': "'",
      '&apos;': "'",
      '&nbsp;': ' ',
      '&mdash;': '—',
      '&ndash;': '–',
      '&hellip;': '...',
      '&copy;': '(c)',
      '&reg;': '(R)',
      '&trade;': '(TM)',
      '&bull;': '*',
      '&rarr;': '->',
      '&larr;': '<-',
      '&laquo;': '<<',
      '&raquo;': '>>',
    };

    let result = text;
    for (const [entity, char] of Object.entries(entities)) {
      result = result.replace(new RegExp(entity, 'g'), char);
    }

    // Handle numeric entities
    result = result.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
    result = result.replace(/&#x([a-fA-F0-9]+);/g, (_, code) =>
      String.fromCharCode(parseInt(code, 16))
    );

    return result;
  }
}
