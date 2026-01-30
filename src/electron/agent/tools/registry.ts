import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { Workspace, GatewayContextType } from '../../../shared/types';
import { AgentDaemon } from '../daemon';
import { FileTools } from './file-tools';
import { SkillTools } from './skill-tools';
import { SearchTools } from './search-tools';
import { BrowserTools } from './browser-tools';
import { ShellTools } from './shell-tools';
import { ImageTools } from './image-tools';
import { SystemTools } from './system-tools';
import { CronTools } from './cron-tools';
import { LLMTool } from '../llm/types';
import { SearchProviderFactory } from '../search';
import { MCPClientManager } from '../../mcp/client/MCPClientManager';
import { MCPSettingsManager } from '../../mcp/settings';
import { isToolAllowedQuick } from '../../security/policy-manager';
import { BuiltinToolsSettingsManager } from './builtin-settings';

/**
 * ToolRegistry manages all available tools and their execution
 * Integrates with SecurityPolicyManager for context-aware tool filtering
 */
export class ToolRegistry {
  private fileTools: FileTools;
  private skillTools: SkillTools;
  private searchTools: SearchTools;
  private browserTools: BrowserTools;
  private shellTools: ShellTools;
  private imageTools: ImageTools;
  private systemTools: SystemTools;
  private cronTools: CronTools;
  private gatewayContext?: GatewayContextType;
  private shadowedToolsLogged = false;

  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
    gatewayContext?: GatewayContextType
  ) {
    this.fileTools = new FileTools(workspace, daemon, taskId);
    this.skillTools = new SkillTools(workspace, daemon, taskId);
    this.searchTools = new SearchTools(workspace, daemon, taskId);
    this.browserTools = new BrowserTools(workspace, daemon, taskId);
    this.shellTools = new ShellTools(workspace, daemon, taskId);
    this.imageTools = new ImageTools(workspace, daemon, taskId);
    this.systemTools = new SystemTools(workspace, daemon, taskId);
    this.cronTools = new CronTools(workspace, daemon, taskId);
    this.gatewayContext = gatewayContext;
  }

  /**
   * Set the gateway context for tool filtering
   * Used when task originates from Telegram/Discord/etc.
   */
  setGatewayContext(context: GatewayContextType | undefined): void {
    this.gatewayContext = context;
  }

  /**
   * Check if a tool is allowed based on security policy
   */
  isToolAllowed(toolName: string): boolean {
    return isToolAllowedQuick(toolName, this.workspace, this.gatewayContext);
  }

  /**
   * Get all available tools in provider-agnostic format
   * Filters tools based on workspace permissions, gateway context, and user settings
   * Sorts tools by priority (high priority tools first)
   */
  getTools(): LLMTool[] {
    const allTools: LLMTool[] = [
      ...this.getFileToolDefinitions(),
      ...this.getSkillToolDefinitions(),
      ...BrowserTools.getToolDefinitions(),
    ];

    // Only add search tool if a provider is configured
    if (SearchProviderFactory.isAnyProviderConfigured()) {
      allTools.push(...this.getSearchToolDefinitions());
    }

    // Only add shell tool if workspace has shell permission
    if (this.workspace.permissions.shell) {
      allTools.push(...this.getShellToolDefinitions());
    }

    // Only add image tools if Gemini API is configured
    if (ImageTools.isAvailable()) {
      allTools.push(...ImageTools.getToolDefinitions());
    }

    // Always add system tools (they enable broader system interaction)
    allTools.push(...SystemTools.getToolDefinitions());

    // Always add cron/scheduling tools (enables task scheduling)
    allTools.push(...CronTools.getToolDefinitions());

    // Add meta tools for execution control
    allTools.push(...this.getMetaToolDefinitions());

    // Collect built-in tool names before adding MCP tools
    const builtinToolNames = new Set(allTools.map(t => t.name));

    // Add MCP tools from connected servers, filtering out those that shadow built-in tools
    const settings = MCPSettingsManager.loadSettings();
    const prefix = settings.toolNamePrefix || 'mcp_';
    const mcpTools = this.getMCPToolDefinitions();
    const shadowedTools: string[] = [];

    for (const mcpTool of mcpTools) {
      const baseName = mcpTool.name.slice(prefix.length);
      if (builtinToolNames.has(baseName)) {
        // Skip MCP tools that shadow built-in tools - prefer built-in versions
        shadowedTools.push(mcpTool.name);
      } else {
        allTools.push(mcpTool);
      }
    }

    if (shadowedTools.length > 0 && !this.shadowedToolsLogged) {
      console.log(`[ToolRegistry] Skipped ${shadowedTools.length} MCP tools that shadow built-in tools:`,
        shadowedTools.join(', '));
      this.shadowedToolsLogged = true;
    }

    // Filter tools based on security policy (workspace + gateway context)
    let filteredTools = allTools.filter(tool => this.isToolAllowed(tool.name));

    // Filter tools based on user's built-in tool settings
    const disabledBySettings: string[] = [];
    filteredTools = filteredTools.filter(tool => {
      // MCP tools are not affected by built-in settings
      if (tool.name.startsWith(prefix)) {
        return true;
      }
      // Meta tools are always enabled
      if (tool.name === 'revise_plan') {
        return true;
      }
      // Check built-in tool settings
      const isEnabled = BuiltinToolsSettingsManager.isToolEnabled(tool.name);
      if (!isEnabled) {
        disabledBySettings.push(tool.name);
      }
      return isEnabled;
    });

    // Log filtered tools for debugging
    const blockedTools = allTools.filter(tool => !this.isToolAllowed(tool.name));
    if (blockedTools.length > 0 && this.gatewayContext) {
      console.log(`[ToolRegistry] Blocked ${blockedTools.length} tools for ${this.gatewayContext} context:`,
        blockedTools.map(t => t.name).join(', '));
    }
    if (disabledBySettings.length > 0) {
      console.log(`[ToolRegistry] Disabled ${disabledBySettings.length} tools by user settings:`,
        disabledBySettings.join(', '));
    }

    // Sort tools by priority (high first, then normal, then low)
    // This helps influence which tools the LLM is more likely to choose
    const priorityOrder = { high: 0, normal: 1, low: 2 };
    filteredTools.sort((a, b) => {
      // MCP tools always come after built-in tools at the same priority
      const aIsMcp = a.name.startsWith(prefix);
      const bIsMcp = b.name.startsWith(prefix);

      const aPriority = aIsMcp ? 'normal' : BuiltinToolsSettingsManager.getToolPriority(a.name);
      const bPriority = bIsMcp ? 'normal' : BuiltinToolsSettingsManager.getToolPriority(b.name);

      const diff = priorityOrder[aPriority] - priorityOrder[bPriority];
      if (diff !== 0) return diff;

      // Within same priority, put built-in tools first
      if (aIsMcp && !bIsMcp) return 1;
      if (!aIsMcp && bIsMcp) return -1;

      return 0;
    });

    return filteredTools;
  }

  /**
   * Get MCP tools from connected servers
   */
  private getMCPToolDefinitions(): LLMTool[] {
    try {
      const mcpManager = MCPClientManager.getInstance();
      const mcpTools = mcpManager.getAllTools();
      const settings = MCPSettingsManager.loadSettings();
      const prefix = settings.toolNamePrefix || 'mcp_';

      return mcpTools.map((tool: { name: string; description?: string; inputSchema: any }) => ({
        name: `${prefix}${tool.name}`,
        description: tool.description || `MCP tool: ${tool.name}`,
        input_schema: tool.inputSchema,
      }));
    } catch (error) {
      // MCP not initialized yet, return empty array
      return [];
    }
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
- read_file: Read contents of a file (supports plain text, DOCX, and PDF)
- write_file: Write content to a file (creates or overwrites)
- copy_file: Copy a file (supports binary files like DOCX, PDF, images)
- list_directory: List files and folders in a directory
- rename_file: Rename or move a file
- delete_file: Delete a file (requires approval)
- create_directory: Create a new directory
- search_files: Search for files by name or content

Skills:
- create_spreadsheet: Create Excel spreadsheets with data and formulas
- create_document: Create Word documents or PDFs
- edit_document: Edit/append content to existing DOCX files
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
- run_applescript: Execute AppleScript on macOS (control apps, automate tasks)

Scheduling:
- schedule_task: Schedule tasks to run at specific times or intervals
  - Create reminders: "remind me to X at Y"
  - Recurring tasks: "every day at 9am, do X"
  - One-time tasks: "at 3pm tomorrow, do X"
  - Cron schedules: standard cron expressions supported

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
    if (name === 'copy_file') return await this.fileTools.copyFile(input.sourcePath, input.destPath);
    if (name === 'list_directory') return await this.fileTools.listDirectory(input.path);
    if (name === 'rename_file') return await this.fileTools.renameFile(input.oldPath, input.newPath);
    if (name === 'delete_file') return await this.fileTools.deleteFile(input.path);
    if (name === 'create_directory') return await this.fileTools.createDirectory(input.path);
    if (name === 'search_files') return await this.fileTools.searchFiles(input.query, input.path);

    // Skill tools
    if (name === 'create_spreadsheet') return await this.skillTools.createSpreadsheet(input);
    if (name === 'create_document') return await this.skillTools.createDocument(input);
    if (name === 'edit_document') return await this.skillTools.editDocument(input);
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
    if (name === 'run_applescript') return await this.systemTools.runAppleScript(input.script);

    // Cron/scheduling tools
    if (name === 'schedule_task') return await this.cronTools.executeAction(input);

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

    // MCP tools (prefixed with mcp_ by default)
    const mcpToolResult = await this.tryExecuteMCPTool(name, input);
    if (mcpToolResult !== null) {
      return mcpToolResult;
    }

    throw new Error(`Unknown tool: ${name}`);
  }

  /**
   * Try to execute an MCP tool if the name matches
   */
  private async tryExecuteMCPTool(name: string, input: any): Promise<any | null> {
    const settings = MCPSettingsManager.loadSettings();
    const prefix = settings.toolNamePrefix || 'mcp_';

    // Not an MCP tool if it doesn't have the prefix
    if (!name.startsWith(prefix)) {
      return null;
    }

    const mcpToolName = name.slice(prefix.length);

    // Try to get the MCP manager - if not initialized, this is not an MCP tool call
    let mcpManager: MCPClientManager;
    try {
      mcpManager = MCPClientManager.getInstance();
    } catch (error) {
      // MCP not initialized
      return null;
    }

    // Check if the tool is registered
    if (!mcpManager.hasTool(mcpToolName)) {
      return null;
    }

    // At this point, we know it's a valid MCP tool - any errors should be propagated
    console.log(`[ToolRegistry] Executing MCP tool: ${mcpToolName}`);

    try {
      const result = await mcpManager.callTool(mcpToolName, input);
      // Format MCP result and process any generated files
      return await this.formatMCPResult(result, mcpToolName, input);
    } catch (error: any) {
      // Tool was registered but execution failed - propagate the error with context
      throw new Error(`MCP tool '${mcpToolName}' failed: ${error.message}`);
    }
  }

  /**
   * Format MCP call result for agent consumption
   * Also handles file artifacts (screenshots, etc.) from MCP tools
   */
  private async formatMCPResult(result: any, toolName?: string, input?: any): Promise<any> {
    if (!result) return { success: true };

    // Check if it's an MCP CallResult format
    if (result.content && Array.isArray(result.content)) {
      if (result.isError) {
        throw new Error(result.content.map((c: any) => c.text || '').join('\n') || 'MCP tool execution failed');
      }

      // Handle image content from MCP tools (e.g., take_screenshot)
      for (const content of result.content) {
        if (content.type === 'image' && content.data) {
          // Save inline image to workspace
          const filename = input?.filePath
            ? path.basename(input.filePath)
            : `mcp-screenshot-${Date.now()}.png`;
          const outputPath = path.join(this.workspace.path, filename);

          try {
            const imageBuffer = Buffer.from(content.data, 'base64');
            await fsPromises.writeFile(outputPath, imageBuffer);

            // Emit file_created event
            this.daemon.logEvent(this.taskId, 'file_created', {
              path: filename,
              type: 'screenshot',
              source: 'mcp',
            });

            // Register as artifact
            this.daemon.registerArtifact(this.taskId, outputPath, content.mimeType || 'image/png');

            console.log(`[ToolRegistry] Saved MCP image artifact: ${filename}`);
          } catch (error) {
            console.error(`[ToolRegistry] Failed to save MCP image:`, error);
          }
        }
      }

      // Combine text content
      const textParts = result.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text);

      if (textParts.length > 0) {
        return textParts.join('\n');
      }

      // Return raw result if no text content
      return result;
    }

    // Handle file paths in MCP results (when filePath parameter was provided)
    if (input?.filePath && typeof input.filePath === 'string') {
      const providedPath = input.filePath;
      const filename = path.basename(providedPath);
      const workspacePath = path.join(this.workspace.path, filename);

      // Check various possible locations for the file
      const possiblePaths = [
        providedPath, // Absolute path as provided
        path.resolve(providedPath), // Resolved relative path
        path.join(process.cwd(), providedPath), // Relative to current working directory
        workspacePath, // Already in workspace
      ];

      for (const sourcePath of possiblePaths) {
        try {
          if (fs.existsSync(sourcePath)) {
            // File found - copy to workspace if not already there
            if (sourcePath !== workspacePath && !sourcePath.startsWith(this.workspace.path)) {
              await fsPromises.copyFile(sourcePath, workspacePath);
              console.log(`[ToolRegistry] Copied MCP file to workspace: ${sourcePath} -> ${workspacePath}`);
            }

            // Emit file_created event with workspace-relative path
            this.daemon.logEvent(this.taskId, 'file_created', {
              path: filename,
              type: 'screenshot',
              source: 'mcp',
            });

            // Register as artifact if it's an image
            const ext = path.extname(filename).toLowerCase();
            const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
            if (imageExtensions.includes(ext)) {
              const mimeTypes: Record<string, string> = {
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.gif': 'image/gif',
                '.webp': 'image/webp',
                '.bmp': 'image/bmp',
              };
              this.daemon.registerArtifact(this.taskId, workspacePath, mimeTypes[ext] || 'image/png');
            }

            break;
          }
        } catch (error) {
          // Continue checking other paths
        }
      }
    }

    // Return as-is if not in MCP format
    return result;
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
        description: 'Read the contents of a file in the workspace. Supports plain text files, DOCX (Word documents), and PDF files. For DOCX and PDF, extracts and returns the text content.',
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
        name: 'copy_file',
        description: 'Copy a file to a new location. Supports binary files (DOCX, PDF, images, etc.) and preserves exact file content.',
        input_schema: {
          type: 'object',
          properties: {
            sourcePath: {
              type: 'string',
              description: 'Path to the source file to copy',
            },
            destPath: {
              type: 'string',
              description: 'Path for the destination file (the copy)',
            },
          },
          required: ['sourcePath', 'destPath'],
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
        name: 'edit_document',
        description: 'Edit an existing Word document (DOCX). Supports multiple actions: append (default), move_section, insert_after_section, list_sections. Use this to modify existing documents without recreating them from scratch.',
        input_schema: {
          type: 'object',
          properties: {
            sourcePath: {
              type: 'string',
              description: 'Path to the existing DOCX file to edit',
            },
            destPath: {
              type: 'string',
              description: 'Optional: Path for the output file. If not specified, the source file will be overwritten.',
            },
            action: {
              type: 'string',
              enum: ['append', 'move_section', 'insert_after_section', 'list_sections'],
              description: 'Action to perform: append (default) adds content at end, move_section moves a section to a new position, insert_after_section inserts content after a specific section, list_sections lists all sections',
            },
            newContent: {
              type: 'array',
              description: 'For append/insert_after_section: Content blocks to add',
              items: {
                type: 'object',
                properties: {
                  type: {
                    type: 'string',
                    enum: ['heading', 'paragraph', 'list', 'table'],
                    description: 'Type of content block',
                  },
                  text: {
                    type: 'string',
                    description: 'Text content for the block',
                  },
                  level: {
                    type: 'number',
                    description: 'For headings: level 1-6',
                  },
                  items: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'For lists: array of list items',
                  },
                  rows: {
                    type: 'array',
                    items: {
                      type: 'array',
                      items: { type: 'string' },
                    },
                    description: 'For tables: 2D array of cell values',
                  },
                },
                required: ['type', 'text'],
              },
            },
            sectionToMove: {
              type: 'string',
              description: 'For move_section: Section number or heading text to move (e.g., "8" or "Ticket Indexing")',
            },
            afterSection: {
              type: 'string',
              description: 'For move_section: Section number or heading text after which to place the moved section (e.g., "7" or "Data Storage")',
            },
            insertAfterSection: {
              type: 'string',
              description: 'For insert_after_section: Section number or heading text after which to insert new content',
            },
          },
          required: ['sourcePath'],
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
