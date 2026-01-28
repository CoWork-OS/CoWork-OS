import { Workspace } from '../../../shared/types';
import { AgentDaemon } from '../daemon';
import { BrowserService } from '../browser/browser-service';

/**
 * BrowserTools provides browser automation capabilities to the agent
 */
export class BrowserTools {
  private browserService: BrowserService;

  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string
  ) {
    this.browserService = new BrowserService(workspace, {
      headless: true,
      timeout: 60000  // 60 seconds - enough time for browser launch + navigation
    });
  }

  /**
   * Get the tool definitions for browser automation
   */
  static getToolDefinitions() {
    return [
      {
        name: 'browser_navigate',
        description: 'Navigate the browser to a URL. Opens the browser if not already open.',
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
            }
          }
        }
      },
      {
        name: 'browser_get_content',
        description: 'Get the text content, links, and forms from the current page',
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
        const result = await this.browserService.screenshot(
          input.filename,
          input.full_page || false
        );
        // Construct full path for the screenshot
        const path = require('path');
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
        const result = await this.browserService.click(input.selector);
        this.daemon.logEvent(this.taskId, 'browser_action', {
          action: 'click',
          selector: input.selector,
          success: result.success
        });
        return result;
      }

      case 'browser_fill': {
        const result = await this.browserService.fill(input.selector, input.value);
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
          input.delay || 50
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
