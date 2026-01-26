import { Workspace } from '../../../shared/types';
import { AgentDaemon } from '../daemon';
import { FileTools } from './file-tools';
import { SkillTools } from './skill-tools';
import { SearchTools } from './search-tools';
import { BrowserTools } from './browser-tools';
import { ShellTools } from './shell-tools';
import { ImageTools } from './image-tools';
import { SystemTools } from './system-tools';
import { LLMTool } from '../llm/types';
import { SearchProviderFactory } from '../search';

/**
 * ToolRegistry manages all available tools and their execution
 */
export class ToolRegistry {
  private fileTools: FileTools;
  private skillTools: SkillTools;
  private searchTools: SearchTools;
  private browserTools: BrowserTools;
  private shellTools: ShellTools;
  private imageTools: ImageTools;
  private systemTools: SystemTools;

  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string
  ) {
    this.fileTools = new FileTools(workspace, daemon, taskId);
    this.skillTools = new SkillTools(workspace, daemon, taskId);
    this.searchTools = new SearchTools(workspace, daemon, taskId);
    this.browserTools = new BrowserTools(workspace, daemon, taskId);
    this.shellTools = new ShellTools(workspace, daemon, taskId);
    this.imageTools = new ImageTools(workspace, daemon, taskId);
    this.systemTools = new SystemTools(workspace, daemon, taskId);
  }

  /**
   * Get all available tools in provider-agnostic format
   */
  getTools(): LLMTool[] {
    const tools = [
      ...this.getFileToolDefinitions(),
      ...this.getSkillToolDefinitions(),
      ...BrowserTools.getToolDefinitions(),
    ];

    // Only add search tool if a provider is configured
    if (SearchProviderFactory.isAnyProviderConfigured()) {
      tools.push(...this.getSearchToolDefinitions());
    }

    // Only add shell tool if workspace has shell permission
    if (this.workspace.permissions.shell) {
      tools.push(...this.getShellToolDefinitions());
    }

    // Only add image tools if Gemini API is configured
    if (ImageTools.isAvailable()) {
      tools.push(...ImageTools.getToolDefinitions());
    }

    // Always add system tools (they enable broader system interaction)
    tools.push(...SystemTools.getToolDefinitions());

    // Add meta tools for execution control
    tools.push(...this.getMetaToolDefinitions());

    return tools;
  }

  /**
   * Callback for handling plan revisions (set by executor)
   */
  private planRevisionHandler?: (newSteps: Array<{ description: string }>, reason: string) => void;

  /**
   * Set the callback for handling plan revisions
   */
  setPlanRevisionHandler(handler: (newSteps: Array<{ description: string }>, reason: string) => void): void {
    this.planRevisionHandler = handler;
  }

  /**
   * Get human-readable tool descriptions
   */
  getToolDescriptions(): string {
    let descriptions = `
File Operations:
- read_file: Read contents of a file
- write_file: Write content to a file (creates or overwrites)
- list_directory: List files and folders in a directory
- rename_file: Rename or move a file
- delete_file: Delete a file (requires approval)
- create_directory: Create a new directory
- search_files: Search for files by name or content

Skills:
- create_spreadsheet: Create Excel spreadsheets with data and formulas
- create_document: Create Word documents or PDFs
- create_presentation: Create PowerPoint presentations
- organize_folder: Organize and structure files in folders

Browser Automation:
- browser_navigate: Navigate to a URL
- browser_screenshot: Take a screenshot of the page
- browser_get_content: Get page text, links, and forms
- browser_click: Click on an element
- browser_fill: Fill a form field
- browser_type: Type text character by character
- browser_press: Press a keyboard key
- browser_wait: Wait for an element to appear
- browser_scroll: Scroll the page
- browser_select: Select dropdown option
- browser_get_text: Get element text content
- browser_evaluate: Execute JavaScript
- browser_back/forward: Navigate history
- browser_reload: Reload the page
- browser_save_pdf: Save page as PDF
- browser_close: Close the browser`;

    // Add search if configured
    if (SearchProviderFactory.isAnyProviderConfigured()) {
      descriptions += `

Web Search:
- web_search: Search the web for information (web, news, images)`;
    }

    // Add shell if permitted
    if (this.workspace.permissions.shell) {
      descriptions += `

Shell Commands:
- run_command: Execute shell commands (requires user approval)`;
    }

    // Add image generation if Gemini is configured
    if (ImageTools.isAvailable()) {
      descriptions += `

Image Generation (Nano Banana):
- generate_image: Generate images from text descriptions using AI
  - nano-banana: Fast generation for quick iterations
  - nano-banana-pro: High-quality generation for production use`;
    }

    // System tools are always available
    descriptions += `

System Tools:
- system_info: Get OS, CPU, memory, and user info
- read_clipboard: Read system clipboard contents
- write_clipboard: Write text to system clipboard
- take_screenshot: Capture screen and save to workspace
- open_application: Open an app by name
- open_url: Open URL in default browser
- open_path: Open file/folder with default application
- show_in_folder: Reveal file in Finder/Explorer
- get_env: Read environment variable
- get_app_paths: Get system paths (home, downloads, etc.)

Plan Control:
- revise_plan: Modify remaining plan steps when obstacles are encountered or new information discovered`;

    return descriptions.trim();
  }

  /**
   * Execute a tool by name
   */
  async executeTool(name: string, input: any): Promise<any> {
    // File tools
    if (name === 'read_file') return await this.fileTools.readFile(input.path);
    if (name === 'write_file') return await this.fileTools.writeFile(input.path, input.content);
    if (name === 'list_directory') return await this.fileTools.listDirectory(input.path);
    if (name === 'rename_file') return await this.fileTools.renameFile(input.oldPath, input.newPath);
    if (name === 'delete_file') return await this.fileTools.deleteFile(input.path);
    if (name === 'create_directory') return await this.fileTools.createDirectory(input.path);
    if (name === 'search_files') return await this.fileTools.searchFiles(input.query, input.path);

    // Skill tools
    if (name === 'create_spreadsheet') return await this.skillTools.createSpreadsheet(input);
    if (name === 'create_document') return await this.skillTools.createDocument(input);
    if (name === 'create_presentation') return await this.skillTools.createPresentation(input);
    if (name === 'organize_folder') return await this.skillTools.organizeFolder(input);

    // Browser tools
    if (BrowserTools.isBrowserTool(name)) {
      return await this.browserTools.executeTool(name, input);
    }

    // Search tools
    if (name === 'web_search') return await this.searchTools.webSearch(input);

    // Shell tools
    if (name === 'run_command') return await this.shellTools.runCommand(input.command, input);

    // Image tools
    if (name === 'generate_image') return await this.imageTools.generateImage(input);

    // System tools
    if (name === 'system_info') return await this.systemTools.getSystemInfo();
    if (name === 'read_clipboard') return await this.systemTools.readClipboard();
    if (name === 'write_clipboard') return await this.systemTools.writeClipboard(input.text);
    if (name === 'take_screenshot') return await this.systemTools.takeScreenshot(input);
    if (name === 'open_application') return await this.systemTools.openApplication(input.appName);
    if (name === 'open_url') return await this.systemTools.openUrl(input.url);
    if (name === 'open_path') return await this.systemTools.openPath(input.path);
    if (name === 'show_in_folder') return await this.systemTools.showInFolder(input.path);
    if (name === 'get_env') return await this.systemTools.getEnvVariable(input.name);
    if (name === 'get_app_paths') return this.systemTools.getAppPaths();

    // Meta tools
    if (name === 'revise_plan') {
      if (!this.planRevisionHandler) {
        throw new Error('Plan revision not available at this time');
      }
      const newSteps = input.newSteps || [];
      const reason = input.reason || 'No reason provided';
      this.planRevisionHandler(newSteps, reason);
      return {
        success: true,
        message: `Plan revised: ${newSteps.length} new steps added. Reason: ${reason}`,
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  }

  /**
   * Cleanup resources (call when task is done)
   */
  async cleanup(): Promise<void> {
    await this.browserTools.cleanup();
  }

  /**
   * Define file operation tools
   */
  private getFileToolDefinitions(): LLMTool[] {
    return [
      {
        name: 'read_file',
        description: 'Read the contents of a file in the workspace',
        input_schema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Relative path to the file within the workspace',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'write_file',
        description: 'Write content to a file in the workspace (creates or overwrites)',
        input_schema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Relative path to the file within the workspace',
            },
            content: {
              type: 'string',
              description: 'Content to write to the file',
            },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: 'list_directory',
        description: 'List files and folders in a directory',
        input_schema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Relative path to the directory (or "." for workspace root)',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'rename_file',
        description: 'Rename or move a file',
        input_schema: {
          type: 'object',
          properties: {
            oldPath: {
              type: 'string',
              description: 'Current path of the file',
            },
            newPath: {
              type: 'string',
              description: 'New path for the file',
            },
          },
          required: ['oldPath', 'newPath'],
        },
      },
      {
        name: 'delete_file',
        description: 'Delete a file (requires user approval)',
        input_schema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Path to the file to delete',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'create_directory',
        description: 'Create a new directory',
        input_schema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Path for the new directory',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'search_files',
        description: 'Search for files by name or content',
        input_schema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query (filename or content)',
            },
            path: {
              type: 'string',
              description: 'Directory to search in (optional, defaults to workspace root)',
            },
          },
          required: ['query'],
        },
      },
    ];
  }

  /**
   * Define skill tools
   */
  private getSkillToolDefinitions(): LLMTool[] {
    return [
      {
        name: 'create_spreadsheet',
        description: 'Create an Excel spreadsheet with data, formulas, and formatting',
        input_schema: {
          type: 'object',
          properties: {
            filename: { type: 'string', description: 'Name of the Excel file (without extension)' },
            sheets: {
              type: 'array',
              description: 'Array of sheets to create',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Sheet name' },
                  data: {
                    type: 'array',
                    description: '2D array of cell values (rows of columns)',
                    items: {
                      type: 'array',
                      description: 'Row of cell values',
                      items: { type: 'string', description: 'Cell value' },
                    },
                  },
                },
              },
            },
          },
          required: ['filename', 'sheets'],
        },
      },
      {
        name: 'create_document',
        description: 'Create a formatted Word document or PDF',
        input_schema: {
          type: 'object',
          properties: {
            filename: { type: 'string', description: 'Name of the document' },
            format: { type: 'string', enum: ['docx', 'pdf'], description: 'Output format' },
            content: {
              type: 'array',
              description: 'Document content blocks',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['heading', 'paragraph', 'list'] },
                  text: { type: 'string' },
                  level: { type: 'number', description: 'For headings: 1-6' },
                },
              },
            },
          },
          required: ['filename', 'format', 'content'],
        },
      },
      {
        name: 'create_presentation',
        description: 'Create a PowerPoint presentation',
        input_schema: {
          type: 'object',
          properties: {
            filename: { type: 'string', description: 'Name of the presentation' },
            slides: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  content: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
          required: ['filename', 'slides'],
        },
      },
      {
        name: 'organize_folder',
        description: 'Organize files in a folder by type, date, or custom rules',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Folder path to organize' },
            strategy: {
              type: 'string',
              enum: ['by_type', 'by_date', 'custom'],
              description: 'Organization strategy',
            },
            rules: { type: 'object', description: 'Custom organization rules (if strategy is custom)' },
          },
          required: ['path', 'strategy'],
        },
      },
    ];
  }

  /**
   * Define search tools
   */
  private getSearchToolDefinitions(): LLMTool[] {
    const providers = SearchProviderFactory.getAvailableProviders();
    const configuredProviders = providers.filter((p) => p.configured);
    const allSupportedTypes = [
      ...new Set(configuredProviders.flatMap((p) => p.supportedTypes)),
    ];

    return [
      {
        name: 'web_search',
        description: `Search the web for information. Configured providers: ${configuredProviders.map((p) => p.name).join(', ')}`,
        input_schema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'The search query',
            },
            searchType: {
              type: 'string',
              enum: allSupportedTypes,
              description: `Type of search. Available: ${allSupportedTypes.join(', ')}`,
            },
            maxResults: {
              type: 'number',
              description: 'Maximum number of results (default: 10, max: 20)',
            },
            provider: {
              type: 'string',
              enum: configuredProviders.map((p) => p.type),
              description: `Override the search provider. Available: ${configuredProviders.map((p) => p.type).join(', ')}`,
            },
            dateRange: {
              type: 'string',
              enum: ['day', 'week', 'month', 'year'],
              description: 'Filter results by date range',
            },
            region: {
              type: 'string',
              description: 'Region code for localized results (e.g., "us", "uk", "de")',
            },
          },
          required: ['query'],
        },
      },
    ];
  }

  /**
   * Define shell tools
   */
  private getShellToolDefinitions(): LLMTool[] {
    return [
      {
        name: 'run_command',
        description:
          'Execute a shell command in the workspace directory. IMPORTANT: This tool requires user approval before execution. The user will see the command and can approve or deny it. Use this for installing packages (npm, pip, brew), running build commands, git operations, or any terminal commands.',
        input_schema: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'The shell command to execute (e.g., "npm install", "git status", "ls -la")',
            },
            cwd: {
              type: 'string',
              description: 'Working directory for the command (optional, defaults to workspace root)',
            },
            timeout: {
              type: 'number',
              description: 'Timeout in milliseconds (optional, default: 60000, max: 300000)',
            },
          },
          required: ['command'],
        },
      },
    ];
  }

  /**
   * Define meta tools for execution control
   */
  private getMetaToolDefinitions(): LLMTool[] {
    return [
      {
        name: 'revise_plan',
        description:
          'Revise the execution plan by adding new steps. Use this when you encounter unexpected obstacles, ' +
          'discover that the original plan is insufficient, or find a better approach. ' +
          'The new steps will be added to the remaining plan and executed after the current step completes.',
        input_schema: {
          type: 'object',
          properties: {
            reason: {
              type: 'string',
              description: 'Brief explanation of why the plan needs to be revised (e.g., "discovered missing dependency", "found better approach")',
            },
            newSteps: {
              type: 'array',
              description: 'Array of new steps to add to the plan',
              items: {
                type: 'object',
                properties: {
                  description: {
                    type: 'string',
                    description: 'Description of what this step should accomplish',
                  },
                },
                required: ['description'],
              },
            },
          },
          required: ['reason', 'newSteps'],
        },
      },
    ];
  }
}
