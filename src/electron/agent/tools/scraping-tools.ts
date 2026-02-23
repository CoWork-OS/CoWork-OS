import { spawn, type ChildProcess } from "child_process";
import * as path from "path";
import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import { LLMTool } from "../llm/types";
import { ScrapingSettingsManager } from "../../scraping/scraping-settings";

/**
 * ScrapingTools provides advanced web scraping capabilities powered by Scrapling.
 * Features anti-bot bypass, adaptive element tracking, stealth browsing, and structured data extraction.
 */
export class ScrapingTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {}

  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  /**
   * Check if scraping tools are enabled in settings
   */
  static isEnabled(): boolean {
    return ScrapingSettingsManager.isEnabled();
  }

  /**
   * Get tool definitions for Scraping tools
   */
  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: "scrape_page",
        description:
          "Scrape a web page with advanced anti-bot bypass and stealth capabilities. " +
          "Supports three fetcher modes: 'default' (fast HTTP with TLS fingerprinting), " +
          "'stealth' (browser-based with Cloudflare bypass), 'playwright' (full browser for JS-heavy sites). " +
          "Use this instead of web_fetch when sites block simple requests, require JavaScript rendering, " +
          "or have anti-bot protection (Cloudflare, CAPTCHAs, etc.). " +
          "Can extract text, links, images, and tables from the page.",
        input_schema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The URL to scrape",
            },
            fetcher: {
              type: "string",
              enum: ["default", "stealth", "playwright"],
              description:
                "Fetcher type. 'default': fast HTTP with TLS impersonation. " +
                "'stealth': browser with Cloudflare/Turnstile bypass. " +
                "'playwright': full browser for JS-rendered content. Default: 'default'",
            },
            selector: {
              type: "string",
              description:
                "CSS selector to extract specific content (e.g., '.product-card', 'article', '#main-content')",
            },
            wait_for: {
              type: "string",
              description:
                "CSS selector to wait for before extracting (useful for JS-rendered content). Only works with stealth/playwright fetcher.",
            },
            extract_links: {
              type: "boolean",
              description: "Extract all links from the page (default: false)",
            },
            extract_images: {
              type: "boolean",
              description: "Extract all image URLs from the page (default: false)",
            },
            extract_tables: {
              type: "boolean",
              description: "Extract all tables as structured data (default: false)",
            },
            headless: {
              type: "boolean",
              description:
                "Run browser in headless mode (default: true). Set to false for debugging.",
            },
            max_content_length: {
              type: "number",
              description: "Maximum content length to return (default: 100000 characters)",
            },
          },
          required: ["url"],
        },
      },
      {
        name: "scrape_multiple",
        description:
          "Scrape multiple URLs in a single operation. Efficient for batch extraction " +
          "from a list of pages (e.g., search results, product listings, article links). " +
          "Returns content from each URL with the same anti-bot bypass capabilities. " +
          "Limited to 20 URLs per batch.",
        input_schema: {
          type: "object",
          properties: {
            urls: {
              type: "array",
              items: { type: "string" },
              description: "Array of URLs to scrape (max 20)",
            },
            fetcher: {
              type: "string",
              enum: ["default", "stealth", "playwright"],
              description: "Fetcher type to use for all URLs (default: 'default')",
            },
            selector: {
              type: "string",
              description: "CSS selector to extract from each page (applied to all URLs)",
            },
            max_content_length: {
              type: "number",
              description: "Maximum content length per URL (default: 50000 characters)",
            },
          },
          required: ["urls"],
        },
      },
      {
        name: "scrape_extract",
        description:
          "Extract structured data from a web page. Automatically detects and extracts " +
          "tables, lists, headings, and metadata. Can also use custom CSS selectors " +
          "for targeted extraction. Best for pulling specific data points like prices, " +
          "product details, contact information, or any structured content.",
        input_schema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The URL to extract data from",
            },
            extract_type: {
              type: "string",
              enum: ["auto", "tables", "lists", "headings", "meta", "custom"],
              description:
                "What to extract. 'auto' extracts everything. 'custom' uses the selectors parameter. Default: 'auto'",
            },
            selectors: {
              type: "object",
              description:
                'Custom CSS selectors for extraction (only with extract_type: "custom"). ' +
                "Keys are field names, values are CSS selectors. " +
                'Example: {"prices": ".price", "titles": "h2.product-name"}',
              additionalProperties: { type: "string" },
            },
            fetcher: {
              type: "string",
              enum: ["default", "stealth", "playwright"],
              description: "Fetcher type (default: 'default')",
            },
          },
          required: ["url"],
        },
      },
      {
        name: "scrape_session",
        description:
          "Run a multi-step scraping session with persistent browser state. " +
          "Useful for workflows that require login, navigation, and then extraction. " +
          "Steps execute in sequence, maintaining cookies and session state between them. " +
          "Always uses the Playwright fetcher for full browser capability.",
        input_schema: {
          type: "object",
          properties: {
            steps: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  action: {
                    type: "string",
                    enum: ["navigate", "extract"],
                    description: "Step action type",
                  },
                  url: {
                    type: "string",
                    description: "URL to navigate to (for 'navigate' action)",
                  },
                  selector: {
                    type: "string",
                    description: "CSS selector (for 'extract' action)",
                  },
                  wait_for: {
                    type: "string",
                    description: "CSS selector to wait for after navigation",
                  },
                },
                required: ["action"],
              },
              description: "Array of steps to execute in sequence",
            },
            headless: {
              type: "boolean",
              description: "Run in headless mode (default: true)",
            },
          },
          required: ["steps"],
        },
      },
      {
        name: "scraping_status",
        description:
          "Check if the Scrapling library is installed and available. " +
          "Returns installation status and version. Use this to verify setup " +
          "before attempting scraping operations.",
        input_schema: {
          type: "object",
          properties: {},
        },
      },
    ];
  }

  /**
   * Execute a scraping tool by name
   */
  async executeTool(name: string, input: any): Promise<any> {
    if (name === "scraping_status") return await this.getStatus();
    if (name === "scrape_page") return await this.scrapePage(input);
    if (name === "scrape_multiple") return await this.scrapeMultiple(input);
    if (name === "scrape_extract") return await this.extractStructured(input);
    if (name === "scrape_session") return await this.scrapeSession(input);
    throw new Error(`Unknown scraping tool: ${name}`);
  }

  /**
   * Check if a tool name belongs to scraping tools
   */
  static isScrapingTool(name: string): boolean {
    return [
      "scrape_page",
      "scrape_multiple",
      "scrape_extract",
      "scrape_session",
      "scraping_status",
    ].includes(name);
  }

  // ─── Private Implementation ──────────────────────────

  private async getStatus(): Promise<any> {
    return await this.callBridge("status", {});
  }

  private async scrapePage(input: {
    url: string;
    fetcher?: string;
    selector?: string;
    wait_for?: string;
    extract_links?: boolean;
    extract_images?: boolean;
    extract_tables?: boolean;
    headless?: boolean;
    max_content_length?: number;
  }): Promise<any> {
    const settings = ScrapingSettingsManager.loadSettings();

    this.daemon.logEvent(this.taskId, "log", {
      message: `Scraping: ${input.url} (fetcher: ${input.fetcher || settings.defaultFetcher})`,
    });

    const params: Record<string, any> = {
      ...input,
      fetcher: input.fetcher || settings.defaultFetcher,
      headless: input.headless ?? settings.headless,
      timeout: settings.timeout,
      max_content_length: input.max_content_length || settings.maxContentLength,
    };

    if (settings.proxy.enabled && settings.proxy.url) {
      params.proxy = settings.proxy.url;
    }

    const result = await this.callBridge("scrape_page", params);

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "scrape_page",
      result: {
        url: input.url,
        success: result.success,
        contentLength: result.content?.length || 0,
        title: result.title,
      },
    });

    return result;
  }

  private async scrapeMultiple(input: {
    urls: string[];
    fetcher?: string;
    selector?: string;
    max_content_length?: number;
  }): Promise<any> {
    const settings = ScrapingSettingsManager.loadSettings();

    this.daemon.logEvent(this.taskId, "log", {
      message: `Batch scraping ${input.urls.length} URLs`,
    });

    const params: Record<string, any> = {
      ...input,
      fetcher: input.fetcher || settings.defaultFetcher,
      max_content_length: input.max_content_length || 50000,
    };

    const result = await this.callBridge("scrape_multiple", params);

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "scrape_multiple",
      result: {
        total: result.total || 0,
        success: result.success,
      },
    });

    return result;
  }

  private async extractStructured(input: {
    url: string;
    extract_type?: string;
    selectors?: Record<string, string>;
    fetcher?: string;
  }): Promise<any> {
    const settings = ScrapingSettingsManager.loadSettings();

    this.daemon.logEvent(this.taskId, "log", {
      message: `Extracting structured data from: ${input.url}`,
    });

    const params: Record<string, any> = {
      ...input,
      fetcher: input.fetcher || settings.defaultFetcher,
    };

    const result = await this.callBridge("extract_structured", params);

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "scrape_extract",
      result: {
        url: input.url,
        success: result.success,
        extractType: input.extract_type || "auto",
      },
    });

    return result;
  }

  private async scrapeSession(input: {
    steps: Array<{
      action: string;
      url?: string;
      selector?: string;
      value?: string;
      wait_for?: string;
    }>;
    headless?: boolean;
  }): Promise<any> {
    const settings = ScrapingSettingsManager.loadSettings();

    this.daemon.logEvent(this.taskId, "log", {
      message: `Running scraping session with ${input.steps.length} steps`,
    });

    const params: Record<string, any> = {
      ...input,
      headless: input.headless ?? settings.headless,
    };

    const result = await this.callBridge("scrape_session", params);

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "scrape_session",
      result: {
        success: result.success,
        stepCount: input.steps.length,
      },
    });

    return result;
  }

  /**
   * Call the Python bridge script with a command
   */
  private callBridge(action: string, params: Record<string, any>): Promise<any> {
    return new Promise((resolve) => {
      const settings = ScrapingSettingsManager.loadSettings();
      const pythonPath = settings.pythonPath || "python3";

      const bridgePath = path.resolve(__dirname, "..", "..", "scraping", "scrapling-bridge.py");

      const child: ChildProcess = spawn(pythonPath, [bridgePath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.on("error", (error: Error) => {
        if ((error as any).code === "ENOENT") {
          resolve({
            success: false,
            error: `Python not found at '${pythonPath}'. Install Python 3 or update the Python path in Scraping settings.`,
            code: "PYTHON_NOT_FOUND",
          });
        } else {
          resolve({
            success: false,
            error: `Bridge error: ${error.message}`,
            code: "BRIDGE_ERROR",
          });
        }
      });

      child.on("close", (code: number | null) => {
        if (code !== 0 && !stdout.trim()) {
          const errorMsg = stderr.trim() || `Bridge exited with code ${code}`;
          // Check for common Python import errors
          if (errorMsg.includes("ModuleNotFoundError") || errorMsg.includes("No module named")) {
            resolve({
              success: false,
              error: "Scrapling is not installed. Run: pip install scrapling && scrapling install",
              code: "NOT_INSTALLED",
              details: errorMsg,
            });
          } else {
            resolve({
              success: false,
              error: errorMsg,
              code: "BRIDGE_EXIT_ERROR",
            });
          }
          return;
        }

        // Parse the last line of stdout as JSON response
        const lines = stdout.trim().split("\n");
        const lastLine = lines[lines.length - 1];

        try {
          const result = JSON.parse(lastLine);
          resolve(result);
        } catch {
          resolve({
            success: false,
            error: `Failed to parse bridge response: ${lastLine.slice(0, 500)}`,
            code: "PARSE_ERROR",
          });
        }
      });

      // Send the command
      const command = JSON.stringify({ action, params });
      child.stdin?.write(command + "\n");
      child.stdin?.end();

      // Timeout after configured duration
      const timeout = settings.timeout + 10000; // Extra 10s for bridge overhead
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Process may have already exited
        }
        resolve({
          success: false,
          error: `Scraping operation timed out after ${timeout / 1000}s`,
          code: "TIMEOUT",
        });
      }, timeout);
    });
  }
}
