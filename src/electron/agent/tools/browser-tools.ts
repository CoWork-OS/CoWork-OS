import * as path from 'path';
import { Workspace } from '../../../shared/types';
import { AgentDaemon } from '../daemon';
import { BrowserService } from '../browser/browser-service';

/**
 * BrowserTools provides browser automation capabilities to the agent
 */
export class BrowserTools {
  private browserService: BrowserService;
  private browserState: { headless: boolean; profile: string | null; browserChannel: 'chromium' | 'chrome' | 'brave' } = {
    headless: true,
    profile: null,
    browserChannel: 'chromium',
  };

  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string
  ) {
    this.browserService = new BrowserService(workspace, {
      headless: true,
      timeout: 90000  // 90 seconds - time for browser launch + navigation + consent popup handling
    });
  }

  /**
   * Update the workspace for this tool
   * Recreates the browser service with the new workspace
   */
  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
    // Recreate browser service with new workspace (and reset to defaults)
    this.browserService = new BrowserService(workspace, {
      headless: true,
      timeout: 90000
    });
    this.browserState = { headless: true, profile: null, browserChannel: 'chromium' };
  }

  private getTimeoutMs(input: unknown): number | undefined {
    const toolInput = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    const rawTimeout = toolInput?.timeout_ms;
    if (typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0) {
      return Math.round(rawTimeout);
    }
    return undefined;
  }

  private getPersistentUserDataDir(profile: string): string {
    const safe = path
      .basename(profile.trim())
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .slice(0, 64) || 'default';
    return path.join(this.workspace.path, '.cowork', 'browser-profiles', safe);
  }

  private async ensureBrowserConfigured(opts: { headless?: unknown; profile?: unknown; browser_channel?: unknown }): Promise<void> {
    const requestedHeadless = typeof opts.headless === 'boolean' ? opts.headless : undefined;
    const profileRaw = typeof opts.profile === 'string' ? opts.profile.trim() : undefined;
    const requestedProfile = profileRaw !== undefined ? (profileRaw ? profileRaw : null) : undefined;
    const channelRaw = typeof opts.browser_channel === 'string' ? opts.browser_channel.trim().toLowerCase() : '';
    const requestedChannel =
      channelRaw === 'chrome' || channelRaw === 'chromium' || channelRaw === 'brave'
        ? channelRaw
        : undefined;

    const nextHeadless = requestedHeadless ?? this.browserState.headless;
    const nextProfile = requestedProfile ?? this.browserState.profile;
    const nextChannel = requestedChannel ?? this.browserState.browserChannel;

    if (
      nextHeadless === this.browserState.headless &&
      nextProfile === this.browserState.profile &&
      nextChannel === this.browserState.browserChannel
    ) {
      return;
    }

    await this.browserService.close();
    this.browserService = new BrowserService(this.workspace, {
      headless: nextHeadless,
      timeout: 90000,
      userDataDir: nextProfile ? this.getPersistentUserDataDir(nextProfile) : undefined,
      channel: nextChannel,
    });
    this.browserState = { headless: nextHeadless, profile: nextProfile, browserChannel: nextChannel };
  }

  /**
   * Get the tool definitions for browser automation
   */
  static getToolDefinitions() {
    return [
      {
        name: 'browser_navigate',
        description:
          'Navigate the browser to a URL. Opens the browser if not already open. ' +
          'Optional: set headless=false to open a visible browser window. ' +
          'Optional: set profile to enable a persistent browser profile (cookies/storage persist across tasks). ' +
          'Optional: set browser_channel to "chrome" (system Google Chrome) or "brave" (system Brave); default is bundled Chromium. ' +
          'NOTE: For RESEARCH tasks (finding news, trends, discussions), use web_search instead - it aggregates results from multiple sources. ' +
          'For simply reading a specific URL, use web_fetch - it is faster and lighter. ' +
          'Use browser_navigate ONLY when you need to interact with the page (click, fill forms, take screenshots) or when the page requires JavaScript rendering.',
        input_schema: {
          type: 'object' as const,
          properties: {
            url: {
              type: 'string',
              description: 'The URL to navigate to'
            },
            wait_until: {
              type: 'string',
              enum: ['load', 'domcontentloaded', 'networkidle'],
              description: 'When to consider navigation complete. Default: load'
            },
            headless: {
              type: 'boolean',
              description: 'Run browser headless (default: true). Set false for a visible window.'
            },
            profile: {
              type: 'string',
              description:
                'Optional persistent profile name. If set, cookies/storage persist across tasks under .cowork/browser-profiles/<profile>.'
            },
            browser_channel: {
              type: 'string',
              enum: ['chromium', 'chrome', 'brave'],
              description: 'Which browser binary to use (default: chromium). "chrome" requires Google Chrome; "brave" requires Brave (or BRAVE_PATH).'
            }
          },
          required: ['url']
        }
      },
      {
        name: 'browser_screenshot',
        description: 'Take a screenshot of the current page',
        input_schema: {
          type: 'object' as const,
          properties: {
            filename: {
              type: 'string',
              description: 'Filename for the screenshot (optional, will generate if not provided)'
            },
            full_page: {
              type: 'boolean',
              description: 'Capture the full scrollable page. Default: false'
            },
            require_selector: {
              type: 'string',
              description: 'Optional CSS selector that must be present/visible before taking the screenshot'
            },
            disallow_url_contains: {
              type: 'array',
              items: { type: 'string' },
              description: 'If current URL contains any of these substrings, abort screenshot'
            },
            max_wait_ms: {
              type: 'number',
              description: 'Max wait time for require_selector (ms). Default: 10000'
            },
            allow_consent: {
              type: 'boolean',
              description: 'Allow screenshots of consent pages (default: false)'
            }
          }
        }
      },
      {
        name: 'browser_get_content',
        description:
          'Get the text content, links, and forms from the current page. ' +
          'NOTE: For RESEARCH tasks, use web_search first - it is more efficient for finding information across multiple sources. ' +
          'If you just need to read a specific URL, use web_fetch - it is faster and does not require opening a browser. ' +
          'Use this only after browser_navigate when you need JavaScript-rendered content or to inspect forms/links for interaction.',
        input_schema: {
          type: 'object' as const,
          properties: {}
        }
      },
      {
        name: 'browser_click',
        description: 'Click on an element on the page',
        input_schema: {
          type: 'object' as const,
          properties: {
            selector: {
              type: 'string',
              description: 'CSS selector or text selector (e.g., "button.submit", "text=Login", "#myButton")'
            },
            timeout_ms: {
              type: 'number',
              description: 'Action timeout in ms. Use 60000+ for slow pages (default: 90_000)'
            }
          },
          required: ['selector']
        }
      },
      {
        name: 'browser_fill',
        description: 'Fill a form field with text',
        input_schema: {
          type: 'object' as const,
          properties: {
            selector: {
              type: 'string',
              description: 'CSS selector for the input field (e.g., "input[name=email]", "#username")'
            },
            value: {
              type: 'string',
              description: 'The text to fill in'
            },
            timeout_ms: {
              type: 'number',
              description: 'Action timeout in ms. Use 60000+ for slow pages (default: 90_000)'
            }
          },
          required: ['selector', 'value']
        }
      },
      {
        name: 'browser_type',
        description: 'Type text character by character (useful for search boxes with autocomplete)',
        input_schema: {
          type: 'object' as const,
          properties: {
            selector: {
              type: 'string',
              description: 'CSS selector for the input field'
            },
            text: {
              type: 'string',
              description: 'The text to type'
            },
            delay: {
              type: 'number',
              description: 'Delay between keystrokes in ms. Default: 50'
            },
            timeout_ms: {
              type: 'number',
              description: 'Action timeout in ms. Use 60000+ for slow pages (default: 90_000)'
            }
          },
          required: ['selector', 'text']
        }
      },
      {
        name: 'browser_press',
        description: 'Press a keyboard key (e.g., Enter, Tab, Escape)',
        input_schema: {
          type: 'object' as const,
          properties: {
            key: {
              type: 'string',
              description: 'The key to press (e.g., "Enter", "Tab", "Escape", "ArrowDown")'
            }
          },
          required: ['key']
        }
      },
      {
        name: 'browser_wait',
        description: 'Wait for an element to appear on the page',
        input_schema: {
          type: 'object' as const,
          properties: {
            selector: {
              type: 'string',
              description: 'CSS selector to wait for'
            },
            timeout: {
              type: 'number',
              description: 'Max time to wait in ms. Default: 30000'
            }
          },
          required: ['selector']
        }
      },
      {
        name: 'browser_scroll',
        description: 'Scroll the page',
        input_schema: {
          type: 'object' as const,
          properties: {
            direction: {
              type: 'string',
              enum: ['up', 'down', 'top', 'bottom'],
              description: 'Direction to scroll'
            },
            amount: {
              type: 'number',
              description: 'Pixels to scroll (for up/down). Default: 500'
            }
          },
          required: ['direction']
        }
      },
      {
        name: 'browser_select',
        description: 'Select an option from a dropdown',
        input_schema: {
          type: 'object' as const,
          properties: {
            selector: {
              type: 'string',
              description: 'CSS selector for the select element'
            },
            value: {
              type: 'string',
              description: 'Value to select'
            }
          },
          required: ['selector', 'value']
        }
      },
      {
        name: 'browser_get_text',
        description: 'Get the text content of an element',
        input_schema: {
          type: 'object' as const,
          properties: {
            selector: {
              type: 'string',
              description: 'CSS selector for the element'
            }
          },
          required: ['selector']
        }
      },
      {
        name: 'browser_evaluate',
        description: 'Execute JavaScript code in the browser context',
        input_schema: {
          type: 'object' as const,
          properties: {
            script: {
              type: 'string',
              description: 'JavaScript code to execute'
            }
          },
          required: ['script']
        }
      },
      {
        name: 'browser_back',
        description: 'Go back in browser history',
        input_schema: {
          type: 'object' as const,
          properties: {}
        }
      },
      {
        name: 'browser_forward',
        description: 'Go forward in browser history',
        input_schema: {
          type: 'object' as const,
          properties: {}
        }
      },
      {
        name: 'browser_reload',
        description: 'Reload the current page',
        input_schema: {
          type: 'object' as const,
          properties: {}
        }
      },
      {
        name: 'browser_save_pdf',
        description: 'Save the current page as a PDF',
        input_schema: {
          type: 'object' as const,
          properties: {
            filename: {
              type: 'string',
              description: 'Filename for the PDF (optional)'
            }
          }
        }
      },
      {
        name: 'browser_close',
        description: 'Close the browser',
        input_schema: {
          type: 'object' as const,
          properties: {}
        }
      }
    ];
  }

  /**
   * Execute a browser tool
   */
  async executeTool(toolName: string, input: any): Promise<any> {
    switch (toolName) {
      case 'browser_navigate': {
        await this.ensureBrowserConfigured({
          headless: input?.headless,
          profile: input?.profile,
          browser_channel: input?.browser_channel,
        });
        const result = await this.browserService.navigate(
          input.url,
          input.wait_until || 'load'
        );
        this.daemon.logEvent(this.taskId, 'browser_action', {
          action: 'navigate',
          url: result.url,
          title: result.title
        });
        return result;
      }

      case 'browser_screenshot': {
        const {
          filename,
          full_page,
          require_selector,
          disallow_url_contains,
          max_wait_ms,
          allow_consent
        } = input || {};

        if (require_selector) {
          const waitResult = await this.browserService.waitForSelector(require_selector, max_wait_ms || 10000);
          if (!waitResult.success) {
            throw new Error(`Required selector not found: ${require_selector}`);
          }
        }

        if (!allow_consent) {
          const currentUrl = await this.browserService.getCurrentUrl();
          if (currentUrl.includes('consent.google.com')) {
            throw new Error('Consent page detected; dismiss consent before taking screenshot.');
          }
        }

        if (Array.isArray(disallow_url_contains) && disallow_url_contains.length > 0) {
          const currentUrl = await this.browserService.getCurrentUrl();
          for (const fragment of disallow_url_contains) {
            if (fragment && currentUrl.includes(fragment)) {
              throw new Error(`Current URL matches disallowed fragment: ${fragment}`);
            }
          }
        }

        const result = await this.browserService.screenshot(
          filename,
          full_page || false
        );
        // Construct full path for the screenshot
        const fullPath = path.join(this.workspace.path, result.path);

        this.daemon.logEvent(this.taskId, 'file_created', {
          path: result.path,
          type: 'screenshot'
        });

        // Register as artifact so it can be sent back to the user
        this.daemon.registerArtifact(this.taskId, fullPath, 'image/png');

        return result;
      }

      case 'browser_get_content': {
        const result = await this.browserService.getContent();
        this.daemon.logEvent(this.taskId, 'browser_action', {
          action: 'get_content',
          url: result.url
        });
        return result;
      }

      case 'browser_click': {
        const result = await this.browserService.click(input.selector, this.getTimeoutMs(input));
        this.daemon.logEvent(this.taskId, 'browser_action', {
          action: 'click',
          selector: input.selector,
          success: result.success
        });
        return result;
      }

      case 'browser_fill': {
        const result = await this.browserService.fill(input.selector, input.value, this.getTimeoutMs(input));
        this.daemon.logEvent(this.taskId, 'browser_action', {
          action: 'fill',
          selector: input.selector,
          success: result.success
        });
        return result;
      }

      case 'browser_type': {
        const result = await this.browserService.type(
          input.selector,
          input.text,
          input.delay || 50,
          this.getTimeoutMs(input),
        );
        this.daemon.logEvent(this.taskId, 'browser_action', {
          action: 'type',
          selector: input.selector,
          success: result.success
        });
        return result;
      }

      case 'browser_press': {
        const result = await this.browserService.press(input.key);
        this.daemon.logEvent(this.taskId, 'browser_action', {
          action: 'press',
          key: input.key,
          success: result.success
        });
        return result;
      }

      case 'browser_wait': {
        const result = await this.browserService.waitForSelector(
          input.selector,
          input.timeout
        );
        this.daemon.logEvent(this.taskId, 'browser_action', {
          action: 'wait',
          selector: input.selector,
          success: result.success
        });
        return result;
      }

      case 'browser_scroll': {
        const result = await this.browserService.scroll(
          input.direction,
          input.amount
        );
        this.daemon.logEvent(this.taskId, 'browser_action', {
          action: 'scroll',
          direction: input.direction
        });
        return result;
      }

      case 'browser_select': {
        const result = await this.browserService.select(input.selector, input.value);
        this.daemon.logEvent(this.taskId, 'browser_action', {
          action: 'select',
          selector: input.selector,
          success: result.success
        });
        return result;
      }

      case 'browser_get_text': {
        const result = await this.browserService.getText(input.selector);
        return result;
      }

      case 'browser_evaluate': {
        const script = typeof input?.script === 'string' ? input.script : '';
        if (/(require\s*\(|child_process|execSync|exec\(|spawn\()/i.test(script)) {
          throw new Error('browser_evaluate cannot run Node.js APIs. Use run_command for shell commands.');
        }
        const result = await this.browserService.evaluate(input.script);
        this.daemon.logEvent(this.taskId, 'browser_action', {
          action: 'evaluate',
          success: result.success
        });
        return result;
      }

      case 'browser_back': {
        const result = await this.browserService.goBack();
        this.daemon.logEvent(this.taskId, 'browser_action', {
          action: 'back',
          url: result.url
        });
        return result;
      }

      case 'browser_forward': {
        const result = await this.browserService.goForward();
        this.daemon.logEvent(this.taskId, 'browser_action', {
          action: 'forward',
          url: result.url
        });
        return result;
      }

      case 'browser_reload': {
        const result = await this.browserService.reload();
        this.daemon.logEvent(this.taskId, 'browser_action', {
          action: 'reload',
          url: result.url
        });
        return result;
      }

      case 'browser_save_pdf': {
        const result = await this.browserService.savePdf(input.filename);
        this.daemon.logEvent(this.taskId, 'file_created', {
          path: result.path,
          type: 'pdf'
        });
        return result;
      }

      case 'browser_close': {
        await this.browserService.close();
        this.daemon.logEvent(this.taskId, 'browser_action', {
          action: 'close'
        });
        return { success: true };
      }

      default:
        throw new Error(`Unknown browser tool: ${toolName}`);
    }
  }

  /**
   * Check if a tool name is a browser tool
   */
  static isBrowserTool(toolName: string): boolean {
    return toolName.startsWith('browser_');
  }

  /**
   * Close the browser when done
   */
  async cleanup(): Promise<void> {
    await this.browserService.close();
  }
}
