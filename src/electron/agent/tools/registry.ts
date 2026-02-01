import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { Workspace, GatewayContextType, AgentConfig, AgentType, Task } from '../../../shared/types';
import { AgentDaemon } from '../daemon';
import { FileTools } from './file-tools';
import { SkillTools } from './skill-tools';
import { SearchTools } from './search-tools';
import { WebFetchTools } from './web-fetch-tools';
import { GlobTools } from './glob-tools';
import { GrepTools } from './grep-tools';
import { EditTools } from './edit-tools';
import { BrowserTools } from './browser-tools';
import { ShellTools } from './shell-tools';
import { ImageTools } from './image-tools';
import { SystemTools } from './system-tools';
import { CronTools } from './cron-tools';
import { CanvasTools } from './canvas-tools';
import { LLMTool } from '../llm/types';
import { SearchProviderFactory } from '../search';
import { MCPClientManager } from '../../mcp/client/MCPClientManager';
import { MCPSettingsManager } from '../../mcp/settings';
import { isToolAllowedQuick } from '../../security/policy-manager';
import { BuiltinToolsSettingsManager } from './builtin-settings';
import { getCustomSkillLoader } from '../custom-skill-loader';
import { PersonalityManager } from '../../settings/personality-manager';
import { PersonalityId, PersonaId, PERSONALITY_DEFINITIONS, PERSONA_DEFINITIONS } from '../../../shared/types';

/**
 * ToolRegistry manages all available tools and their execution
 * Integrates with SecurityPolicyManager for context-aware tool filtering
 */
export class ToolRegistry {
  private fileTools: FileTools;
  private skillTools: SkillTools;
  private searchTools: SearchTools;
  private webFetchTools: WebFetchTools;
  private globTools: GlobTools;
  private grepTools: GrepTools;
  private editTools: EditTools;
  private browserTools: BrowserTools;
  private shellTools: ShellTools;
  private imageTools: ImageTools;
  private systemTools: SystemTools;
  private cronTools: CronTools;
  private canvasTools: CanvasTools;
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
    this.webFetchTools = new WebFetchTools(workspace, daemon, taskId);
    this.globTools = new GlobTools(workspace, daemon, taskId);
    this.grepTools = new GrepTools(workspace, daemon, taskId);
    this.editTools = new EditTools(workspace, daemon, taskId);
    this.browserTools = new BrowserTools(workspace, daemon, taskId);
    this.shellTools = new ShellTools(workspace, daemon, taskId);
    this.imageTools = new ImageTools(workspace, daemon, taskId);
    this.systemTools = new SystemTools(workspace, daemon, taskId);
    this.cronTools = new CronTools(workspace, daemon, taskId);
    this.canvasTools = new CanvasTools(workspace, daemon, taskId);
    this.gatewayContext = gatewayContext;
  }

  /**
   * Get the current workspace
   */
  getWorkspace(): Workspace {
    return this.workspace;
  }

  /**
   * Update the workspace for all tools
   * Used when switching workspaces mid-task
   */
  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
    this.fileTools.setWorkspace(workspace);
    this.skillTools.setWorkspace(workspace);
    this.searchTools.setWorkspace(workspace);
    this.webFetchTools.setWorkspace(workspace);
    this.globTools.setWorkspace(workspace);
    this.grepTools.setWorkspace(workspace);
    this.editTools.setWorkspace(workspace);
    this.browserTools.setWorkspace(workspace);
    this.shellTools.setWorkspace(workspace);
    this.imageTools.setWorkspace(workspace);
    this.systemTools.setWorkspace(workspace);
    this.cronTools.setWorkspace(workspace);
    this.canvasTools.setWorkspace(workspace);
  }

  /**
   * Set the gateway context for tool filtering
   * Used when task originates from Telegram/Discord/etc.
   */
  setGatewayContext(context: GatewayContextType | undefined): void {
    this.gatewayContext = context;
  }

  /**
   * Send stdin input to the currently running shell command
   */
  sendStdin(input: string): boolean {
    return this.shellTools.sendStdin(input);
  }

  /**
   * Check if a shell command is currently running
   */
  hasActiveShellProcess(): boolean {
    return this.shellTools.hasActiveProcess();
  }

  /**
   * Kill the currently running shell command (send SIGINT)
   * @param force - If true, send SIGKILL immediately instead of graceful escalation
   */
  killShellProcess(force?: boolean): boolean {
    return this.shellTools.killProcess(force);
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
      ...GlobTools.getToolDefinitions(),
      ...GrepTools.getToolDefinitions(),
      ...EditTools.getToolDefinitions(),
      ...WebFetchTools.getToolDefinitions(),
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

    // Always add canvas tools (enables visual workspace)
    allTools.push(...CanvasTools.getToolDefinitions());

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
      if (['revise_plan', 'set_personality', 'set_persona', 'set_agent_name', 'set_user_name', 'set_response_style', 'set_quirks', 'spawn_agent', 'wait_for_agent', 'get_agent_status', 'list_agents'].includes(tool.name)) {
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
  private planRevisionHandler?: (newSteps: Array<{ description: string }>, reason: string, clearRemaining: boolean) => void;

  /**
   * Set the callback for handling plan revisions
   */
  setPlanRevisionHandler(handler: (newSteps: Array<{ description: string }>, reason: string, clearRemaining: boolean) => void): void {
    this.planRevisionHandler = handler;
  }

  /**
   * Callback for handling workspace switches (set by executor)
   */
  private workspaceSwitchHandler?: (newWorkspace: Workspace) => Promise<void>;

  /**
   * Set the callback for handling workspace switches
   */
  setWorkspaceSwitchHandler(handler: (newWorkspace: Workspace) => Promise<void>): void {
    this.workspaceSwitchHandler = handler;
  }

  /**
   * Switch to a different workspace
   * Used internally by switch_workspace tool
   */
  async switchWorkspace(input: { path?: string; workspace_id?: string }): Promise<{
    success: boolean;
    workspace?: { id: string; name: string; path: string };
    error?: string;
  }> {
    const { path: workspacePath, workspace_id } = input;

    if (!workspacePath && !workspace_id) {
      return {
        success: false,
        error: 'Either path or workspace_id must be provided',
      };
    }

    if (!this.workspaceSwitchHandler) {
      return {
        success: false,
        error: 'Workspace switching is not available in this context',
      };
    }

    try {
      // Look up the workspace
      let newWorkspace: Workspace | undefined;

      if (workspace_id) {
        newWorkspace = this.daemon.getWorkspaceById(workspace_id);
        if (!newWorkspace) {
          return {
            success: false,
            error: `Workspace not found with id: ${workspace_id}`,
          };
        }
      } else if (workspacePath) {
        newWorkspace = this.daemon.getWorkspaceByPath(workspacePath);
        if (!newWorkspace) {
          // Try to create a new workspace for this path
          const pathModule = await import('path');
          const fsModule = await import('fs');

          // Check if path exists and is a directory
          if (!fsModule.existsSync(workspacePath)) {
            return {
              success: false,
              error: `Path does not exist: ${workspacePath}`,
            };
          }

          const stats = fsModule.statSync(workspacePath);
          if (!stats.isDirectory()) {
            return {
              success: false,
              error: `Path is not a directory: ${workspacePath}`,
            };
          }

          // Create a new workspace for this path
          const name = pathModule.basename(workspacePath);
          newWorkspace = this.daemon.createWorkspace(name, workspacePath);
        }
      }

      if (!newWorkspace) {
        return {
          success: false,
          error: 'Failed to find or create workspace',
        };
      }

      // Call the switch handler to update executor and task
      await this.workspaceSwitchHandler(newWorkspace);

      // Update the local workspace reference
      this.setWorkspace(newWorkspace);

      return {
        success: true,
        workspace: {
          id: newWorkspace.id,
          name: newWorkspace.name,
          path: newWorkspace.path,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to switch workspace',
      };
    }
  }

  /**
   * Get human-readable tool descriptions
   */
  getToolDescriptions(): string {
    let descriptions = `
File Operations:
- read_file: Read contents of a file (supports plain text, DOCX, and PDF)
- write_file: Write content to a file (creates or overwrites). Use edit_file for targeted changes instead.
- edit_file: Surgical text replacement (preferred over write_file for modifications)
- copy_file: Copy a file (supports binary files like DOCX, PDF, images)
- list_directory: List files and folders in a directory
- rename_file: Rename or move a file
- delete_file: Delete a file (requires approval)
- create_directory: Create a new directory
- search_files: Basic file search. Use glob for pattern matching, grep for content search instead.

Skills:
- create_spreadsheet: Create Excel spreadsheets with data and formulas
- create_document: Create Word documents or PDFs
- edit_document: Edit/append content to existing DOCX files
- create_presentation: Create PowerPoint presentations
- organize_folder: Organize and structure files in folders
- use_skill: Invoke a custom skill by ID to help accomplish tasks (see available skills below)

Skill Management (create, modify, duplicate skills):
- skill_list: List all skills with metadata (source, path, status)
- skill_get: Get full JSON content of a skill by ID
- skill_create: Create a new custom skill
- skill_duplicate: Duplicate an existing skill with modifications (great for variations)
- skill_update: Update an existing skill (managed/workspace only, not bundled)
- skill_delete: Delete a skill (managed/workspace only, not bundled)
Skills are stored in ~/Library/Application Support/cowork-oss/skills/ (managed) or workspace/skills/ (workspace).

Code Tools (PREFERRED for code navigation and editing):
- glob: Fast pattern-based file search (e.g., "**/*.ts", "src/**/*.test.ts")
  Use this FIRST to find files by pattern - much faster than search_files.
- grep: Powerful regex content search (e.g., "async function.*fetch", "class\\s+\\w+")
  Use this FIRST for searching file contents - supports full regex.
- edit_file: Surgical text replacement in files (old_string -> new_string)
  Use this INSTEAD of write_file for targeted changes - safer and preserves structure.

Web Fetch (PREFERRED for reading web content):
- web_fetch: Fetch and read content from a URL as markdown (fast, lightweight, no browser needed)
  Use this FIRST when you need to read any web page, documentation, GitHub repo, or article.
- http_request: Make raw HTTP requests like curl (GET, POST, PUT, DELETE, etc.)
  Use this for APIs, raw file downloads, or when you need custom headers/body.

Browser Automation (use only when interaction is needed):
- browser_navigate: Navigate to a URL (use only for pages requiring JS or when you need to interact)
- browser_screenshot: Take a screenshot of the page
- browser_get_content: Get page text, links, and forms (use after navigate, for inspecting interactive elements)
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

Web Search (for finding URLs, not reading them):
- web_search: Search the web for information (web, news, images)
  Use to FIND relevant pages. To READ a specific URL, use web_fetch instead.`;
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

Live Canvas (Visual Workspace):
- canvas_create: Create a new canvas session for displaying interactive content
- canvas_push: Push HTML/CSS/JS content to the canvas. REQUIRED parameters: session_id and content (the HTML string).
  Example: canvas_push({ session_id: "abc-123", content: "<!DOCTYPE html><html><body><h1>Hello</h1></body></html>" })
- canvas_show: OPTIONAL - Only use if user needs full interactivity (clicking buttons, forms)
- canvas_hide: Hide the canvas window
- canvas_close: Close a canvas session
- canvas_eval: Execute JavaScript in the canvas context
- canvas_snapshot: Take a screenshot of the canvas
- canvas_list: List all active canvas sessions
IMPORTANT: When using canvas_push, you MUST provide the 'content' parameter with the full HTML string to display.

Plan Control:
- revise_plan: Modify remaining plan steps when obstacles are encountered or new information discovered
- switch_workspace: Switch to a different workspace/working directory. Use when you need to work in a different folder.
- set_personality: Change the assistant's communication style (professional, friendly, concise, creative, technical, casual).
- set_persona: Change the assistant's character persona (jarvis, friday, hal, computer, alfred, intern, sensei, pirate, noir, or none).
- set_response_style: Adjust response preferences (emoji_usage, response_length, code_comments, explanation_depth).
- set_quirks: Set personality quirks (catchphrase, sign_off, analogy_domain).
- set_agent_name: Set or change the assistant's name when the user wants to give you a name.
- set_user_name: Store the user's name when they introduce themselves (e.g., "I'm Alice", "My name is Bob").`;

    // Add custom skills available for use_skill
    const skillLoader = getCustomSkillLoader();
    const skillDescriptions = skillLoader.getSkillDescriptionsForModel();
    if (skillDescriptions) {
      descriptions += `

Custom Skills (invoke with use_skill tool):
${skillDescriptions}`;
    }

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
    if (name === 'use_skill') return await this.executeUseSkill(input);

    // Skill management tools
    if (name === 'skill_list') return await this.executeSkillList(input);
    if (name === 'skill_get') return await this.executeSkillGet(input);
    if (name === 'skill_create') return await this.executeSkillCreate(input);
    if (name === 'skill_duplicate') return await this.executeSkillDuplicate(input);
    if (name === 'skill_update') return await this.executeSkillUpdate(input);
    if (name === 'skill_delete') return await this.executeSkillDelete(input);

    // Code tools (glob, grep, edit)
    if (name === 'glob') return await this.globTools.glob(input);
    if (name === 'grep') return await this.grepTools.grep(input);
    if (name === 'edit_file') return await this.editTools.editFile(input);

    // Web fetch tools (preferred for reading web content)
    if (name === 'web_fetch') return await this.webFetchTools.webFetch(input);
    if (name === 'http_request') return await this.webFetchTools.httpRequest(input);

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

    // Canvas tools
    if (name === 'canvas_create') return await this.canvasTools.createCanvas(input.title);
    if (name === 'canvas_push') {
      console.log(`[ToolRegistry] canvas_push input keys:`, Object.keys(input || {}));
      console.log(`[ToolRegistry] canvas_push session_id:`, input?.session_id);
      console.log(`[ToolRegistry] canvas_push content present:`, 'content' in (input || {}), `content length:`, input?.content?.length ?? 'N/A');
      return await this.canvasTools.pushContent(input.session_id, input.content, input.filename);
    }
    if (name === 'canvas_show') return await this.canvasTools.showCanvas(input.session_id);
    if (name === 'canvas_hide') return this.canvasTools.hideCanvas(input.session_id);
    if (name === 'canvas_close') return await this.canvasTools.closeCanvas(input.session_id);
    if (name === 'canvas_eval') return await this.canvasTools.evalScript(input.session_id, input.script);
    if (name === 'canvas_snapshot') return await this.canvasTools.takeSnapshot(input.session_id);
    if (name === 'canvas_list') return this.canvasTools.listSessions();

    // Meta tools
    if (name === 'revise_plan') {
      if (!this.planRevisionHandler) {
        throw new Error('Plan revision not available at this time');
      }
      const newSteps = input.newSteps || [];
      const reason = input.reason || 'No reason provided';
      const clearRemaining = input.clearRemaining || false;
      this.planRevisionHandler(newSteps, reason, clearRemaining);

      let message = '';
      if (clearRemaining) {
        message = `Plan revised: Cleared remaining steps. `;
      }
      if (newSteps.length > 0) {
        message += `${newSteps.length} new steps added. `;
      }
      message += `Reason: ${reason}`;

      return {
        success: true,
        message: message.trim(),
        clearedRemaining: clearRemaining,
      };
    }

    if (name === 'switch_workspace') {
      return await this.switchWorkspace(input);
    }

    if (name === 'set_personality') {
      return this.setPersonality(input);
    }

    if (name === 'set_agent_name') {
      return this.setAgentName(input);
    }

    if (name === 'set_user_name') {
      return this.setUserName(input);
    }

    if (name === 'set_persona') {
      return this.setPersona(input);
    }

    if (name === 'set_response_style') {
      return this.setResponseStyle(input);
    }

    if (name === 'set_quirks') {
      return this.setQuirks(input);
    }

    // Sub-Agent / Parallel Agent tools
    if (name === 'spawn_agent') {
      return await this.spawnAgent(input);
    }
    if (name === 'wait_for_agent') {
      return await this.waitForAgent(input);
    }
    if (name === 'get_agent_status') {
      return await this.getAgentStatus(input);
    }
    if (name === 'list_agents') {
      return await this.listAgents(input);
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
   * Execute the use_skill tool - invokes a custom skill by ID
   */
  private async executeUseSkill(input: { skill_id: string; parameters?: Record<string, any> }): Promise<any> {
    const { skill_id, parameters = {} } = input;

    const skillLoader = getCustomSkillLoader();
    const skill = skillLoader.getSkill(skill_id);

    if (!skill) {
      // List available skills to help the agent
      const availableSkills = skillLoader.listModelInvocableSkills().map(s => s.id);
      return {
        success: false,
        error: `Skill '${skill_id}' not found`,
        available_skills: availableSkills.slice(0, 20), // Show up to 20 skills
        hint: 'Use one of the available skill IDs listed above',
      };
    }

    // Check if skill can be invoked by model
    if (skill.invocation?.disableModelInvocation) {
      return {
        success: false,
        error: `Skill '${skill_id}' cannot be invoked automatically`,
        reason: 'This skill is configured for manual invocation only',
      };
    }

    // Check for required parameters
    const missingParams: string[] = [];
    if (skill.parameters) {
      for (const param of skill.parameters) {
        if (param.required && !(param.name in parameters) && param.default === undefined) {
          missingParams.push(param.name);
        }
      }
    }

    if (missingParams.length > 0) {
      return {
        success: false,
        error: `Missing required parameters: ${missingParams.join(', ')}`,
        skill_id,
        parameters: skill.parameters?.map(p => ({
          name: p.name,
          type: p.type,
          description: p.description,
          required: p.required,
          default: p.default,
          options: p.options,
        })),
      };
    }

    // Expand the skill prompt with provided parameters
    const expandedPrompt = skillLoader.expandPrompt(skill, parameters);

    // Log the skill invocation
    this.daemon.logEvent(this.taskId, 'log', {
      message: `Using skill: ${skill.name}`,
      skillId: skill_id,
      parameters,
    });

    return {
      success: true,
      skill_id,
      skill_name: skill.name,
      skill_description: skill.description,
      expanded_prompt: expandedPrompt,
      instruction: 'Execute the task according to the expanded_prompt above. Follow its instructions to complete the user\'s request.',
    };
  }

  /**
   * List all skills with metadata
   */
  private async executeSkillList(input: {
    source?: 'all' | 'bundled' | 'managed' | 'workspace';
    include_disabled?: boolean;
  }): Promise<any> {
    const { source = 'all', include_disabled = true } = input;
    const skillLoader = getCustomSkillLoader();

    let skills = skillLoader.listSkills();

    // Filter by source if specified
    if (source !== 'all') {
      skills = skills.filter(s => s.source === source);
    }

    // Filter out disabled if requested
    if (!include_disabled) {
      skills = skills.filter(s => s.enabled !== false);
    }

    // Format for agent consumption
    const formattedSkills = skills.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      category: s.category || 'General',
      icon: s.icon || '',
      source: s.source,
      filePath: s.filePath,
      enabled: s.enabled !== false,
      hasParameters: (s.parameters?.length || 0) > 0,
      parameterCount: s.parameters?.length || 0,
    }));

    return {
      success: true,
      total: formattedSkills.length,
      skills: formattedSkills,
      directories: {
        bundled: skillLoader.getBundledSkillsDir(),
        managed: skillLoader.getManagedSkillsDir(),
        workspace: skillLoader.getWorkspaceSkillsDir(),
      },
    };
  }

  /**
   * Get full details of a specific skill
   */
  private async executeSkillGet(input: { skill_id: string }): Promise<any> {
    const { skill_id } = input;
    const skillLoader = getCustomSkillLoader();
    const skill = skillLoader.getSkill(skill_id);

    if (!skill) {
      const availableSkills = skillLoader.listSkills().map(s => s.id);
      return {
        success: false,
        error: `Skill '${skill_id}' not found`,
        available_skills: availableSkills.slice(0, 30),
        hint: 'Use skill_list to see all available skills',
      };
    }

    // Return full skill definition (useful for duplication/modification)
    return {
      success: true,
      skill: {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        prompt: skill.prompt,
        icon: skill.icon,
        category: skill.category,
        priority: skill.priority,
        parameters: skill.parameters,
        enabled: skill.enabled,
        type: skill.type,
        invocation: skill.invocation,
        requires: skill.requires,
        source: skill.source,
        filePath: skill.filePath,
      },
    };
  }

  /**
   * Create a new skill
   */
  private async executeSkillCreate(input: {
    id: string;
    name: string;
    description: string;
    prompt: string;
    icon?: string;
    category?: string;
    parameters?: Array<{
      name: string;
      type: 'string' | 'number' | 'boolean' | 'select';
      description: string;
      required?: boolean;
      default?: string | number | boolean;
      options?: string[];
    }>;
    enabled?: boolean;
  }): Promise<any> {
    const skillLoader = getCustomSkillLoader();

    // Check if skill with this ID already exists
    const existing = skillLoader.getSkill(input.id);
    if (existing) {
      return {
        success: false,
        error: `Skill with ID '${input.id}' already exists`,
        existing_skill: {
          id: existing.id,
          name: existing.name,
          source: existing.source,
        },
        hint: 'Use a different ID or use skill_update to modify the existing skill',
      };
    }

    // Validate ID format
    if (!/^[a-z0-9-]+$/.test(input.id)) {
      return {
        success: false,
        error: 'Invalid skill ID format',
        hint: 'Skill ID should be lowercase, using only letters, numbers, and hyphens (e.g., "my-custom-skill")',
      };
    }

    try {
      const newSkill = await skillLoader.createSkill({
        id: input.id,
        name: input.name,
        description: input.description,
        prompt: input.prompt,
        icon: input.icon || '',
        category: input.category || 'Custom',
        parameters: input.parameters,
        enabled: input.enabled !== false,
      });

      this.daemon.logEvent(this.taskId, 'log', {
        message: `Created new skill: ${newSkill.name}`,
        skillId: newSkill.id,
      });

      return {
        success: true,
        message: `Skill '${newSkill.name}' created successfully`,
        skill: {
          id: newSkill.id,
          name: newSkill.name,
          source: newSkill.source,
          filePath: newSkill.filePath,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: `Failed to create skill: ${error.message}`,
      };
    }
  }

  /**
   * Duplicate an existing skill with modifications
   */
  private async executeSkillDuplicate(input: {
    source_skill_id: string;
    new_id: string;
    modifications?: {
      name?: string;
      description?: string;
      prompt?: string;
      icon?: string;
      category?: string;
      parameters?: any[];
    };
  }): Promise<any> {
    const { source_skill_id, new_id, modifications = {} } = input;
    const skillLoader = getCustomSkillLoader();

    // Get the source skill
    const sourceSkill = skillLoader.getSkill(source_skill_id);
    if (!sourceSkill) {
      return {
        success: false,
        error: `Source skill '${source_skill_id}' not found`,
        hint: 'Use skill_list to see available skills',
      };
    }

    // Check if new ID already exists
    const existing = skillLoader.getSkill(new_id);
    if (existing) {
      return {
        success: false,
        error: `Skill with ID '${new_id}' already exists`,
        hint: 'Use a different ID for the duplicate',
      };
    }

    // Validate new ID format
    if (!/^[a-z0-9-]+$/.test(new_id)) {
      return {
        success: false,
        error: 'Invalid skill ID format',
        hint: 'Skill ID should be lowercase, using only letters, numbers, and hyphens',
      };
    }

    try {
      // Create the duplicated skill with modifications
      const newSkill = await skillLoader.createSkill({
        id: new_id,
        name: modifications.name || `${sourceSkill.name} (Copy)`,
        description: modifications.description || sourceSkill.description,
        prompt: modifications.prompt || sourceSkill.prompt,
        icon: modifications.icon || sourceSkill.icon,
        category: modifications.category || sourceSkill.category,
        parameters: modifications.parameters || sourceSkill.parameters,
        priority: sourceSkill.priority,
        enabled: true,
      });

      this.daemon.logEvent(this.taskId, 'log', {
        message: `Duplicated skill '${sourceSkill.name}' as '${newSkill.name}'`,
        sourceSkillId: source_skill_id,
        newSkillId: new_id,
      });

      return {
        success: true,
        message: `Skill duplicated successfully`,
        source_skill: {
          id: sourceSkill.id,
          name: sourceSkill.name,
        },
        new_skill: {
          id: newSkill.id,
          name: newSkill.name,
          source: newSkill.source,
          filePath: newSkill.filePath,
        },
        modifications_applied: Object.keys(modifications),
      };
    } catch (error: any) {
      return {
        success: false,
        error: `Failed to duplicate skill: ${error.message}`,
      };
    }
  }

  /**
   * Update an existing skill
   */
  private async executeSkillUpdate(input: {
    skill_id: string;
    updates: {
      name?: string;
      description?: string;
      prompt?: string;
      icon?: string;
      category?: string;
      parameters?: any[];
      enabled?: boolean;
    };
  }): Promise<any> {
    const { skill_id, updates } = input;
    const skillLoader = getCustomSkillLoader();

    const skill = skillLoader.getSkill(skill_id);
    if (!skill) {
      return {
        success: false,
        error: `Skill '${skill_id}' not found`,
        hint: 'Use skill_list to see available skills',
      };
    }

    // Check if skill can be updated
    if (skill.source === 'bundled') {
      return {
        success: false,
        error: `Cannot update bundled skill '${skill_id}'`,
        hint: 'Bundled skills are read-only. Use skill_duplicate to create an editable copy.',
        skill_source: skill.source,
      };
    }

    try {
      const updatedSkill = await skillLoader.updateSkill(skill_id, updates);
      if (!updatedSkill) {
        return {
          success: false,
          error: 'Failed to update skill',
        };
      }

      this.daemon.logEvent(this.taskId, 'log', {
        message: `Updated skill: ${updatedSkill.name}`,
        skillId: skill_id,
        updatedFields: Object.keys(updates),
      });

      return {
        success: true,
        message: `Skill '${updatedSkill.name}' updated successfully`,
        updated_fields: Object.keys(updates),
        skill: {
          id: updatedSkill.id,
          name: updatedSkill.name,
          source: updatedSkill.source,
          filePath: updatedSkill.filePath,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: `Failed to update skill: ${error.message}`,
      };
    }
  }

  /**
   * Delete a skill
   */
  private async executeSkillDelete(input: { skill_id: string }): Promise<any> {
    const { skill_id } = input;
    const skillLoader = getCustomSkillLoader();

    const skill = skillLoader.getSkill(skill_id);
    if (!skill) {
      return {
        success: false,
        error: `Skill '${skill_id}' not found`,
        hint: 'Use skill_list to see available skills',
      };
    }

    // Check if skill can be deleted
    if (skill.source === 'bundled') {
      return {
        success: false,
        error: `Cannot delete bundled skill '${skill_id}'`,
        hint: 'Bundled skills are read-only and cannot be deleted.',
        skill_source: skill.source,
      };
    }

    try {
      const deleted = await skillLoader.deleteSkill(skill_id);
      if (!deleted) {
        return {
          success: false,
          error: 'Failed to delete skill',
        };
      }

      this.daemon.logEvent(this.taskId, 'log', {
        message: `Deleted skill: ${skill.name}`,
        skillId: skill_id,
      });

      return {
        success: true,
        message: `Skill '${skill.name}' deleted successfully`,
        deleted_skill: {
          id: skill.id,
          name: skill.name,
          source: skill.source,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: `Failed to delete skill: ${error.message}`,
      };
    }
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
      {
        name: 'use_skill',
        description:
          'Use a custom skill by ID to help accomplish a task. Skills are pre-configured prompt templates ' +
          'that provide specialized capabilities. Use this when a skill matches what you need to do. ' +
          'The skill\'s expanded prompt will be injected into your context to guide execution.',
        input_schema: {
          type: 'object',
          properties: {
            skill_id: {
              type: 'string',
              description: 'The ID of the skill to use (e.g., "git-commit", "code-review", "translate")',
            },
            parameters: {
              type: 'object',
              description: 'Parameter values for the skill. Check skill description for required parameters.',
              additionalProperties: true,
            },
          },
          required: ['skill_id'],
        },
      },
      // Skill Management Tools
      {
        name: 'skill_list',
        description:
          'List all available skills with their metadata including source (bundled, managed, workspace), ' +
          'file paths, and status. Use this to discover what skills exist and where they are stored.',
        input_schema: {
          type: 'object',
          properties: {
            source: {
              type: 'string',
              enum: ['all', 'bundled', 'managed', 'workspace'],
              description: 'Filter skills by source. Default is "all".',
            },
            include_disabled: {
              type: 'boolean',
              description: 'Include disabled skills in the list. Default is true.',
            },
          },
        },
      },
      {
        name: 'skill_get',
        description:
          'Get the full JSON content and metadata of a specific skill by ID. ' +
          'Returns the complete skill definition including prompt, parameters, and configuration.',
        input_schema: {
          type: 'object',
          properties: {
            skill_id: {
              type: 'string',
              description: 'The ID of the skill to retrieve',
            },
          },
          required: ['skill_id'],
        },
      },
      {
        name: 'skill_create',
        description:
          'Create a new custom skill. The skill will be saved to the managed skills directory ' +
          '(~/Library/Application Support/cowork-oss/skills/). Provide the full skill definition.',
        input_schema: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Unique identifier for the skill (lowercase, hyphens allowed, e.g., "my-custom-skill")',
            },
            name: {
              type: 'string',
              description: 'Human-readable name for the skill',
            },
            description: {
              type: 'string',
              description: 'Brief description of what the skill does',
            },
            prompt: {
              type: 'string',
              description: 'The prompt template. Use {{paramName}} for parameter placeholders.',
            },
            icon: {
              type: 'string',
              description: 'Emoji icon for the skill (optional)',
            },
            category: {
              type: 'string',
              description: 'Category for grouping (e.g., "Research", "Development", "Writing")',
            },
            parameters: {
              type: 'array',
              description: 'Array of parameter definitions',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Parameter name (used in {{name}} placeholders)' },
                  type: { type: 'string', enum: ['string', 'number', 'boolean', 'select'], description: 'Parameter type' },
                  description: { type: 'string', description: 'Parameter description' },
                  required: { type: 'boolean', description: 'Whether the parameter is required' },
                  default: { type: 'string', description: 'Default value' },
                  options: { type: 'array', items: { type: 'string' }, description: 'Options for select type' },
                },
                required: ['name', 'type', 'description'],
              },
            },
            enabled: {
              type: 'boolean',
              description: 'Whether the skill is enabled. Default is true.',
            },
          },
          required: ['id', 'name', 'description', 'prompt'],
        },
      },
      {
        name: 'skill_duplicate',
        description:
          'Duplicate an existing skill with a new ID and optional modifications. ' +
          'Great for creating variations of existing skills (e.g., changing time ranges, targets).',
        input_schema: {
          type: 'object',
          properties: {
            source_skill_id: {
              type: 'string',
              description: 'The ID of the skill to duplicate',
            },
            new_id: {
              type: 'string',
              description: 'The ID for the new duplicated skill',
            },
            modifications: {
              type: 'object',
              description: 'Fields to modify in the duplicated skill (name, description, prompt, etc.)',
              properties: {
                name: { type: 'string', description: 'New name for the skill' },
                description: { type: 'string', description: 'New description' },
                prompt: { type: 'string', description: 'New prompt template' },
                icon: { type: 'string', description: 'New icon' },
                category: { type: 'string', description: 'New category' },
                parameters: { type: 'array', description: 'New parameters array' },
              },
            },
          },
          required: ['source_skill_id', 'new_id'],
        },
      },
      {
        name: 'skill_update',
        description:
          'Update an existing skill. Only managed and workspace skills can be updated (not bundled). ' +
          'Provide only the fields you want to change.',
        input_schema: {
          type: 'object',
          properties: {
            skill_id: {
              type: 'string',
              description: 'The ID of the skill to update',
            },
            updates: {
              type: 'object',
              description: 'Fields to update',
              properties: {
                name: { type: 'string', description: 'New name' },
                description: { type: 'string', description: 'New description' },
                prompt: { type: 'string', description: 'New prompt template' },
                icon: { type: 'string', description: 'New icon' },
                category: { type: 'string', description: 'New category' },
                parameters: { type: 'array', description: 'New parameters array' },
                enabled: { type: 'boolean', description: 'Enable/disable the skill' },
              },
            },
          },
          required: ['skill_id', 'updates'],
        },
      },
      {
        name: 'skill_delete',
        description:
          'Delete a skill. Only managed and workspace skills can be deleted (not bundled). ' +
          'This permanently removes the skill file.',
        input_schema: {
          type: 'object',
          properties: {
            skill_id: {
              type: 'string',
              description: 'The ID of the skill to delete',
            },
          },
          required: ['skill_id'],
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
        description:
          `Search the web for information using search engines. Use this to FIND relevant URLs/pages on a topic. ` +
          `NOTE: If you already have a specific URL to read, use web_fetch instead - it directly fetches the content. ` +
          `Configured providers: ${configuredProviders.map((p) => p.name).join(', ')}`,
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
   * Set the agent's personality
   */
  private setPersonality(input: { personality: string }): {
    success: boolean;
    personality: string;
    description: string;
    message: string;
  } {
    const personalityId = input.personality as PersonalityId;
    const validIds: PersonalityId[] = ['professional', 'friendly', 'concise', 'creative', 'technical', 'casual'];

    if (!validIds.includes(personalityId)) {
      throw new Error(`Invalid personality: ${personalityId}. Valid options are: ${validIds.join(', ')}`);
    }

    // Save the new personality
    PersonalityManager.setActivePersonality(personalityId);

    // Get the personality definition for the response
    const personality = PERSONALITY_DEFINITIONS.find(p => p.id === personalityId);
    const description = personality?.description || '';
    const name = personality?.name || personalityId;

    console.log(`[ToolRegistry] Personality changed to: ${personalityId}`);

    return {
      success: true,
      personality: personalityId,
      description,
      message: `Personality changed to "${name}". ${description}. This will take effect in future responses.`,
    };
  }

  /**
   * Set the agent's name
   */
  private setAgentName(input: { name: string }): {
    success: boolean;
    name: string;
    message: string;
  } {
    const newName = input.name?.trim();

    if (!newName || newName.length === 0) {
      throw new Error('Name cannot be empty');
    }

    if (newName.length > 50) {
      throw new Error('Name is too long (max 50 characters)');
    }

    // Save the new name
    PersonalityManager.setAgentName(newName);

    console.log(`[ToolRegistry] Agent name changed to: ${newName}`);

    return {
      success: true,
      name: newName,
      message: `Great! From now on, I'll go by "${newName}". Nice to meet you!`,
    };
  }

  /**
   * Set the agent's persona (character overlay)
   */
  private setPersona(input: { persona: string }): {
    success: boolean;
    persona: string;
    name: string;
    description: string;
    message: string;
  } {
    const personaId = input.persona as PersonaId;
    const validIds: PersonaId[] = ['none', 'jarvis', 'friday', 'hal', 'computer', 'alfred', 'intern', 'sensei', 'pirate', 'noir'];

    if (!validIds.includes(personaId)) {
      throw new Error(`Invalid persona: ${personaId}. Valid options are: ${validIds.join(', ')}`);
    }

    // Save the new persona
    PersonalityManager.setActivePersona(personaId);

    // Get the persona definition for the response
    const persona = PERSONA_DEFINITIONS.find(p => p.id === personaId);
    const description = persona?.description || '';
    const name = persona?.name || personaId;

    console.log(`[ToolRegistry] Persona changed to: ${personaId}`);

    let message = '';
    if (personaId === 'none') {
      message = 'Persona cleared. I\'ll respond without any character overlay.';
    } else {
      message = `Persona changed to "${name}". ${description}. This character style will be applied in future responses.`;
    }

    return {
      success: true,
      persona: personaId,
      name,
      description,
      message,
    };
  }

  /**
   * Set the user's name (for relationship tracking)
   */
  private setUserName(input: { name: string }): {
    success: boolean;
    name: string;
    message: string;
  } {
    const userName = input.name?.trim();

    if (!userName || userName.length === 0) {
      throw new Error('Name cannot be empty');
    }

    if (userName.length > 100) {
      throw new Error('Name is too long (max 100 characters)');
    }

    // Save the user's name
    PersonalityManager.setUserName(userName);

    console.log(`[ToolRegistry] User name set to: ${userName}`);

    const agentName = PersonalityManager.getAgentName();

    return {
      success: true,
      name: userName,
      message: `Nice to meet you, ${userName}! I'm ${agentName}. I'll remember your name for our future conversations.`,
    };
  }

  /**
   * Set response style preferences
   */
  private setResponseStyle(input: {
    emoji_usage?: string;
    response_length?: string;
    code_comments?: string;
    explanation_depth?: string;
  }): {
    success: boolean;
    changes: string[];
    message: string;
  } {
    const changes: string[] = [];
    const style: any = {};

    // Validate and apply emoji usage
    if (input.emoji_usage) {
      const validEmoji = ['none', 'minimal', 'moderate', 'expressive'];
      if (!validEmoji.includes(input.emoji_usage)) {
        throw new Error(`Invalid emoji_usage: ${input.emoji_usage}. Valid options: ${validEmoji.join(', ')}`);
      }
      style.emojiUsage = input.emoji_usage;
      changes.push(`emoji usage: ${input.emoji_usage}`);
    }

    // Validate and apply response length
    if (input.response_length) {
      const validLength = ['terse', 'balanced', 'detailed'];
      if (!validLength.includes(input.response_length)) {
        throw new Error(`Invalid response_length: ${input.response_length}. Valid options: ${validLength.join(', ')}`);
      }
      style.responseLength = input.response_length;
      changes.push(`response length: ${input.response_length}`);
    }

    // Validate and apply code comment style
    if (input.code_comments) {
      const validComments = ['minimal', 'moderate', 'verbose'];
      if (!validComments.includes(input.code_comments)) {
        throw new Error(`Invalid code_comments: ${input.code_comments}. Valid options: ${validComments.join(', ')}`);
      }
      style.codeCommentStyle = input.code_comments;
      changes.push(`code comments: ${input.code_comments}`);
    }

    // Validate and apply explanation depth
    if (input.explanation_depth) {
      const validDepth = ['expert', 'balanced', 'teaching'];
      if (!validDepth.includes(input.explanation_depth)) {
        throw new Error(`Invalid explanation_depth: ${input.explanation_depth}. Valid options: ${validDepth.join(', ')}`);
      }
      style.explanationDepth = input.explanation_depth;
      changes.push(`explanation depth: ${input.explanation_depth}`);
    }

    if (changes.length === 0) {
      throw new Error('No valid style options provided. Use emoji_usage, response_length, code_comments, or explanation_depth.');
    }

    PersonalityManager.setResponseStyle(style);
    console.log(`[ToolRegistry] Response style updated:`, changes);

    return {
      success: true,
      changes,
      message: `Response style updated: ${changes.join(', ')}. Changes will apply to future responses.`,
    };
  }

  /**
   * Sanitize user input to prevent prompt injection
   * Removes control characters and limits potentially harmful patterns
   */
  private sanitizeQuirkInput(input: string): string {
    if (!input) return '';

    // Remove control characters and null bytes
    let sanitized = input.replace(/[\x00-\x1F\x7F]/g, '');

    // Remove patterns that could be used for prompt injection
    // These patterns try to override system instructions
    const dangerousPatterns = [
      /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?)/gi,
      /disregard\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?)/gi,
      /forget\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?)/gi,
      /new\s+instructions?:/gi,
      /system\s*:/gi,
      /\[INST\]/gi,
      /<<SYS>>/gi,
      /<\|im_start\|>/gi,
      /###\s*(instruction|system|human|assistant)/gi,
    ];

    for (const pattern of dangerousPatterns) {
      sanitized = sanitized.replace(pattern, '[filtered]');
    }

    return sanitized.trim();
  }

  /**
   * Set personality quirks
   */
  private setQuirks(input: {
    catchphrase?: string;
    sign_off?: string;
    analogy_domain?: string;
  }): {
    success: boolean;
    changes: string[];
    message: string;
  } {
    const changes: string[] = [];
    const quirks: any = {};

    // Maximum lengths for quirk fields
    const MAX_CATCHPHRASE_LENGTH = 100;
    const MAX_SIGNOFF_LENGTH = 150;

    // Apply catchphrase with validation
    if (input.catchphrase !== undefined) {
      if (input.catchphrase && input.catchphrase.length > MAX_CATCHPHRASE_LENGTH) {
        throw new Error(`Catchphrase too long (max ${MAX_CATCHPHRASE_LENGTH} characters, got ${input.catchphrase.length})`);
      }
      const sanitized = this.sanitizeQuirkInput(input.catchphrase || '');
      quirks.catchphrase = sanitized;
      if (sanitized) {
        changes.push(`catchphrase: "${sanitized}"`);
      } else {
        changes.push('catchphrase cleared');
      }
    }

    // Apply sign-off with validation
    if (input.sign_off !== undefined) {
      if (input.sign_off && input.sign_off.length > MAX_SIGNOFF_LENGTH) {
        throw new Error(`Sign-off too long (max ${MAX_SIGNOFF_LENGTH} characters, got ${input.sign_off.length})`);
      }
      const sanitized = this.sanitizeQuirkInput(input.sign_off || '');
      quirks.signOff = sanitized;
      if (sanitized) {
        changes.push(`sign-off: "${sanitized}"`);
      } else {
        changes.push('sign-off cleared');
      }
    }

    // Validate and apply analogy domain
    if (input.analogy_domain !== undefined) {
      const validDomains = ['none', 'cooking', 'sports', 'space', 'music', 'nature', 'gaming', 'movies', 'construction'];
      if (!validDomains.includes(input.analogy_domain)) {
        throw new Error(`Invalid analogy_domain: ${input.analogy_domain}. Valid options: ${validDomains.join(', ')}`);
      }
      quirks.analogyDomain = input.analogy_domain;
      if (input.analogy_domain === 'none') {
        changes.push('analogy domain cleared');
      } else {
        changes.push(`analogy domain: ${input.analogy_domain}`);
      }
    }

    if (changes.length === 0) {
      throw new Error('No quirk options provided. Use catchphrase, sign_off, or analogy_domain.');
    }

    PersonalityManager.setQuirks(quirks);
    console.log(`[ToolRegistry] Quirks updated:`, changes);

    return {
      success: true,
      changes,
      message: `Personality quirks updated: ${changes.join(', ')}. Changes will apply to future responses.`,
    };
  }

  // ============ Sub-Agent / Parallel Agent Methods ============

  /**
   * Get the current task's depth (nesting level)
   */
  private async getCurrentTaskDepth(): Promise<number> {
    const currentTask = await this.daemon.getTaskById(this.taskId);
    return currentTask?.depth ?? 0;
  }

  /**
   * Resolve model preference to a specific model key
   */
  private resolveModelPreference(preference: string | undefined): string {
    switch (preference) {
      case 'same':
        // Use the current global settings - daemon will handle this
        return '';
      case 'cheaper':
      case 'haiku':
        return 'haiku-4-5';
      case 'smarter':
      case 'opus':
        return 'opus-4-5';
      case 'sonnet':
        return 'sonnet-4-5';
      default:
        // Default to cheaper model for sub-agents
        return 'haiku-4-5';
    }
  }

  /**
   * Resolve personality preference
   */
  private resolvePersonality(preference: string | undefined): PersonalityId | undefined {
    if (!preference || preference === 'same') {
      return undefined; // Inherit from parent
    }
    const validPersonalities: PersonalityId[] = ['professional', 'friendly', 'concise', 'creative', 'technical', 'casual'];
    if (validPersonalities.includes(preference as PersonalityId)) {
      return preference as PersonalityId;
    }
    return 'concise'; // Default for sub-agents
  }

  /**
   * Spawn a child agent to work on a subtask
   */
  private async spawnAgent(input: {
    prompt: string;
    title?: string;
    model_preference?: string;
    personality?: string;
    wait?: boolean;
    max_turns?: number;
  }): Promise<{
    success: boolean;
    task_id?: string;
    title?: string;
    message: string;
    result?: any;
    error?: string;
  }> {
    const { prompt, title, model_preference, personality, wait = false, max_turns = 20 } = input;

    // Validate prompt
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new Error('spawn_agent requires a non-empty prompt');
    }

    // Check depth limit to prevent runaway spawning
    const currentDepth = await this.getCurrentTaskDepth();
    const maxDepth = 3;
    if (currentDepth >= maxDepth) {
      return {
        success: false,
        message: `Cannot spawn agent: maximum nesting depth (${maxDepth}) reached. Consider breaking the task into smaller parts or completing this task first.`,
        error: 'MAX_DEPTH_REACHED',
      };
    }

    // Resolve model and personality
    const modelKey = this.resolveModelPreference(model_preference);
    const personalityId = this.resolvePersonality(personality);

    // Build agent config
    const agentConfig: AgentConfig = {
      maxTurns: max_turns,
      retainMemory: false, // Sub-agents don't retain memory
    };

    if (modelKey) {
      agentConfig.modelKey = modelKey;
    }
    if (personalityId) {
      agentConfig.personalityId = personalityId;
    }

    // Generate title if not provided
    const taskTitle = title || `Sub-task: ${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}`;

    // Log spawn attempt
    this.daemon.logEvent(this.taskId, 'agent_spawned', {
      childTaskTitle: taskTitle,
      modelPreference: model_preference,
      personality: personality,
      maxTurns: max_turns,
      parentDepth: currentDepth,
    });

    try {
      // Create the child task via daemon
      const childTask = await this.daemon.createChildTask({
        title: taskTitle,
        prompt: prompt,
        workspaceId: this.workspace.id,
        parentTaskId: this.taskId,
        agentType: 'sub',
        agentConfig,
        depth: currentDepth + 1,
      });

      console.log(`[ToolRegistry] Spawned child agent: ${childTask.id} (depth: ${currentDepth + 1})`);

      // If wait=true, wait for completion
      if (wait) {
        const result = await this.waitForAgentInternal(childTask.id, 300);
        return {
          success: result.success,
          task_id: childTask.id,
          title: taskTitle,
          message: result.message,
          result: result.resultSummary,
          error: result.error,
        };
      }

      return {
        success: true,
        task_id: childTask.id,
        title: taskTitle,
        message: `Sub-agent spawned successfully. Task ID: ${childTask.id}. Use wait_for_agent or get_agent_status to check progress.`,
      };
    } catch (error: any) {
      console.error(`[ToolRegistry] Failed to spawn agent:`, error);
      this.daemon.logEvent(this.taskId, 'error', {
        tool: 'spawn_agent',
        error: error.message,
      });
      return {
        success: false,
        message: `Failed to spawn agent: ${error.message}`,
        error: error.message,
      };
    }
  }

  /**
   * Internal method to wait for an agent to complete
   */
  private async waitForAgentInternal(taskId: string, timeoutSeconds: number): Promise<{
    success: boolean;
    status: string;
    message: string;
    resultSummary?: string;
    error?: string;
  }> {
    const timeoutMs = timeoutSeconds * 1000;
    const startTime = Date.now();
    const pollInterval = 1000; // Check every second

    while (Date.now() - startTime < timeoutMs) {
      const task = await this.daemon.getTaskById(taskId);

      if (!task) {
        return {
          success: false,
          status: 'not_found',
          message: `Task ${taskId} not found`,
          error: 'TASK_NOT_FOUND',
        };
      }

      // Check if task is complete
      if (['completed', 'failed', 'cancelled'].includes(task.status)) {
        const isSuccess = task.status === 'completed';

        // Log result event to parent
        this.daemon.logEvent(this.taskId, isSuccess ? 'agent_completed' : 'agent_failed', {
          childTaskId: taskId,
          childStatus: task.status,
          resultSummary: task.resultSummary,
          error: task.error,
        });

        return {
          success: isSuccess,
          status: task.status,
          message: isSuccess
            ? `Agent completed successfully`
            : `Agent ${task.status}: ${task.error || 'Unknown error'}`,
          resultSummary: task.resultSummary,
          error: task.error,
        };
      }

      // Wait before polling again
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    // Timeout reached
    return {
      success: false,
      status: 'timeout',
      message: `Timeout waiting for agent ${taskId} (${timeoutSeconds}s)`,
      error: 'TIMEOUT',
    };
  }

  /**
   * Wait for a spawned agent to complete
   */
  private async waitForAgent(input: {
    task_id: string;
    timeout_seconds?: number;
  }): Promise<{
    success: boolean;
    status: string;
    task_id: string;
    message: string;
    result_summary?: string;
    error?: string;
  }> {
    const { task_id, timeout_seconds = 300 } = input;

    if (!task_id) {
      throw new Error('wait_for_agent requires a task_id');
    }

    const result = await this.waitForAgentInternal(task_id, timeout_seconds);

    return {
      success: result.success,
      status: result.status,
      task_id: task_id,
      message: result.message,
      result_summary: result.resultSummary,
      error: result.error,
    };
  }

  /**
   * Get status of spawned agents
   */
  private async getAgentStatus(input: {
    task_ids?: string[];
  }): Promise<{
    agents: Array<{
      task_id: string;
      title: string;
      status: string;
      agent_type: string;
      model_key?: string;
      result_summary?: string;
      error?: string;
      created_at: number;
      completed_at?: number;
    }>;
    message: string;
  }> {
    const { task_ids } = input;

    let tasks: Task[];

    if (task_ids && task_ids.length > 0) {
      // Get specific tasks
      tasks = [];
      for (const id of task_ids) {
        const task = await this.daemon.getTaskById(id);
        if (task) {
          tasks.push(task);
        }
      }
    } else {
      // Get all child tasks of current task
      tasks = await this.daemon.getChildTasks(this.taskId);
    }

    const agents = tasks.map(task => ({
      task_id: task.id,
      title: task.title,
      status: task.status,
      agent_type: task.agentType || 'main',
      model_key: task.agentConfig?.modelKey,
      result_summary: task.resultSummary,
      error: task.error,
      created_at: task.createdAt,
      completed_at: task.completedAt,
    }));

    return {
      agents,
      message: `Found ${agents.length} agent(s)`,
    };
  }

  /**
   * List all spawned child agents for the current task
   */
  private async listAgents(input: {
    status_filter?: 'all' | 'running' | 'completed' | 'failed';
  }): Promise<{
    agents: Array<{
      task_id: string;
      title: string;
      status: string;
      agent_type: string;
      model_key?: string;
      depth: number;
      created_at: number;
    }>;
    summary: {
      total: number;
      running: number;
      completed: number;
      failed: number;
    };
    message: string;
  }> {
    const { status_filter = 'all' } = input;

    // Get all child tasks
    let tasks = await this.daemon.getChildTasks(this.taskId);

    // Apply filter
    if (status_filter !== 'all') {
      const runningStatuses = ['pending', 'queued', 'planning', 'executing', 'paused'];
      const completedStatuses = ['completed'];
      const failedStatuses = ['failed', 'cancelled'];

      tasks = tasks.filter(task => {
        switch (status_filter) {
          case 'running':
            return runningStatuses.includes(task.status);
          case 'completed':
            return completedStatuses.includes(task.status);
          case 'failed':
            return failedStatuses.includes(task.status);
          default:
            return true;
        }
      });
    }

    // Calculate summary from all child tasks (not filtered)
    const allTasks = await this.daemon.getChildTasks(this.taskId);
    const summary = {
      total: allTasks.length,
      running: allTasks.filter(t => ['pending', 'queued', 'planning', 'executing', 'paused'].includes(t.status)).length,
      completed: allTasks.filter(t => t.status === 'completed').length,
      failed: allTasks.filter(t => ['failed', 'cancelled'].includes(t.status)).length,
    };

    const agents = tasks.map(task => ({
      task_id: task.id,
      title: task.title,
      status: task.status,
      agent_type: task.agentType || 'main',
      model_key: task.agentConfig?.modelKey,
      depth: task.depth ?? 0,
      created_at: task.createdAt,
    }));

    return {
      agents,
      summary,
      message: status_filter === 'all'
        ? `Found ${agents.length} child agent(s)`
        : `Found ${agents.length} ${status_filter} agent(s) (${summary.total} total)`,
    };
  }

  /**
   * Define meta tools for execution control
   */
  private getMetaToolDefinitions(): LLMTool[] {
    return [
      {
        name: 'revise_plan',
        description:
          'Revise the execution plan. Use this when you encounter unexpected obstacles, ' +
          'discover that the original plan is insufficient, need to stop execution, or find a better approach. ' +
          'Can add new steps, clear remaining steps, or both.',
        input_schema: {
          type: 'object',
          properties: {
            reason: {
              type: 'string',
              description: 'Brief explanation of why the plan needs to be revised (e.g., "discovered missing dependency", "required path not found - need user input")',
            },
            clearRemaining: {
              type: 'boolean',
              description: 'Set to true to CLEAR/REMOVE all remaining pending steps. Use when the task cannot proceed (e.g., required files not found). Default is false.',
            },
            newSteps: {
              type: 'array',
              description: 'Array of new steps to add to the plan. Can be empty [] when clearing remaining steps.',
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
          required: ['reason'],
        },
      },
      {
        name: 'switch_workspace',
        description:
          'Switch to a different workspace/working directory. Use this when you need to work in a different folder ' +
          'than the current workspace. You can specify either a path to the folder or a workspace ID. ' +
          'If the path doesn\'t have an existing workspace, a new one will be created.',
        input_schema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Absolute path to the folder to switch to (e.g., "/Users/user/projects/myapp")',
            },
            workspace_id: {
              type: 'string',
              description: 'ID of an existing workspace to switch to',
            },
          },
        },
      },
      {
        name: 'set_personality',
        description:
          'Change the assistant\'s communication style and personality. Use this when the user asks you to be more friendly, ' +
          'professional, concise, creative, technical, or casual. Available personalities: professional (formal, business-oriented), ' +
          'friendly (warm, encouraging), concise (brief, to-the-point), creative (imaginative, expressive), ' +
          'technical (detailed, precise), casual (relaxed, informal). The change takes effect for all future interactions.',
        input_schema: {
          type: 'object',
          properties: {
            personality: {
              type: 'string',
              enum: ['professional', 'friendly', 'concise', 'creative', 'technical', 'casual'],
              description: 'The personality to switch to',
            },
          },
          required: ['personality'],
        },
      },
      {
        name: 'set_persona',
        description:
          'Change the assistant\'s character persona. Personas are character overlays inspired by famous AI assistants. ' +
          'Use this when the user asks to change persona, act like a character, or wants a specific AI personality. ' +
          'Available personas: jarvis (sophisticated butler), friday (friendly colleague), hal (calm/formal), ' +
          'computer (Star Trek efficient), alfred (refined gentleman), intern (eager learner), sensei (wise teacher), ' +
          'pirate (swashbuckling adventurer), noir (1940s detective). Use "none" to remove persona overlay.',
        input_schema: {
          type: 'object',
          properties: {
            persona: {
              type: 'string',
              enum: ['none', 'jarvis', 'friday', 'hal', 'computer', 'alfred', 'intern', 'sensei', 'pirate', 'noir'],
              description: 'The persona to adopt (or "none" to clear)',
            },
          },
          required: ['persona'],
        },
      },
      {
        name: 'set_agent_name',
        description:
          'Set or change the assistant\'s name. Use this when the user wants to give you a name, rename you, or asks ' +
          '"what should I call you?" The name will be remembered and used in all future interactions. ' +
          'Default name is "CoWork" if not customized.',
        input_schema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'The new name for the assistant (e.g., "Jarvis", "Friday", "Max")',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'set_user_name',
        description:
          'Store the user\'s name when they introduce themselves. Use this PROACTIVELY when the user tells you their name ' +
          '(e.g., "I\'m Alice", "My name is Bob", "Call me Charlie"). This helps personalize future interactions. ' +
          'The name will be remembered across sessions and used in greetings and context.',
        input_schema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'The user\'s name as they introduced themselves',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'set_response_style',
        description:
          'Adjust how the assistant responds. Use when the user asks for different response styles like "use more emojis", ' +
          '"be more brief", "explain things simply", or "add more code comments". All parameters are optional - only set what the user wants to change.',
        input_schema: {
          type: 'object',
          properties: {
            emoji_usage: {
              type: 'string',
              enum: ['none', 'minimal', 'moderate', 'expressive'],
              description: 'How much to use emojis: none (never), minimal (rarely), moderate (sometimes), expressive (frequently)',
            },
            response_length: {
              type: 'string',
              enum: ['terse', 'balanced', 'detailed'],
              description: 'Response verbosity: terse (very brief), balanced (normal), detailed (comprehensive)',
            },
            code_comments: {
              type: 'string',
              enum: ['minimal', 'moderate', 'verbose'],
              description: 'Code commenting style: minimal (essential only), moderate (helpful comments), verbose (detailed explanations)',
            },
            explanation_depth: {
              type: 'string',
              enum: ['expert', 'balanced', 'teaching'],
              description: 'How deeply to explain: expert (assume knowledge), balanced (normal), teaching (thorough explanations)',
            },
          },
        },
      },
      {
        name: 'set_quirks',
        description:
          'Set personality quirks like catchphrases, sign-offs, or analogy themes. Use when the user wants the assistant ' +
          'to have a signature phrase, end responses a certain way, or use analogies from a specific domain. ' +
          'Pass empty string to clear a quirk.',
        input_schema: {
          type: 'object',
          properties: {
            catchphrase: {
              type: 'string',
              description: 'A signature phrase to occasionally use (e.g., "At your service!", "Consider it done!")',
            },
            sign_off: {
              type: 'string',
              description: 'How to end longer responses (e.g., "Happy coding!", "May the force be with you!")',
            },
            analogy_domain: {
              type: 'string',
              enum: ['none', 'cooking', 'sports', 'space', 'music', 'nature', 'gaming', 'movies', 'construction'],
              description: 'Theme for analogies and examples: none (no preference), or a specific domain',
            },
          },
        },
      },
      // Sub-Agent / Parallel Agent tools
      {
        name: 'spawn_agent',
        description:
          'Spawn a new agent (sub-task) to work on a specific task independently. Use this to delegate work, ' +
          'perform parallel operations, or use a cheaper/faster model for batch work. Sub-agents do not retain ' +
          'memory after completion. Returns immediately with the spawned task ID - use wait_for_agent or ' +
          'get_agent_status to check progress. Maximum nesting depth is 3 levels.',
        input_schema: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: 'The task/instruction for the spawned agent. Be specific and include all context needed.',
            },
            title: {
              type: 'string',
              description: 'A short title for the subtask (optional, derived from prompt if not provided)',
            },
            model_preference: {
              type: 'string',
              enum: ['same', 'cheaper', 'smarter'],
              description: 'Model selection: "same" uses parent model, "cheaper" selects Haiku (fast/cheap), "smarter" selects Opus (most capable). Default: "cheaper" for cost optimization.',
            },
            personality: {
              type: 'string',
              enum: ['same', 'professional', 'technical', 'concise', 'creative', 'friendly'],
              description: 'Personality for the spawned agent. "same" inherits from parent. Default: "concise"',
            },
            wait: {
              type: 'boolean',
              description: 'If true, wait for the agent to complete before returning (blocking). Default: false (async)',
            },
            max_turns: {
              type: 'number',
              description: 'Maximum number of LLM turns for the sub-agent. Default: 20',
            },
          },
          required: ['prompt'],
        },
      },
      {
        name: 'wait_for_agent',
        description:
          'Wait for a spawned agent to complete and retrieve its results. Returns the agent\'s final status, ' +
          'result summary, and any error information. Use this to synchronize with sub-agents when you need ' +
          'their results before proceeding.',
        input_schema: {
          type: 'object',
          properties: {
            task_id: {
              type: 'string',
              description: 'The task ID of the spawned agent (returned by spawn_agent)',
            },
            timeout_seconds: {
              type: 'number',
              description: 'Maximum time to wait in seconds. Default: 300 (5 minutes)',
            },
          },
          required: ['task_id'],
        },
      },
      {
        name: 'get_agent_status',
        description:
          'Check the status of spawned agents. Returns current status, progress, and any results. ' +
          'Use this for non-blocking status checks.',
        input_schema: {
          type: 'object',
          properties: {
            task_ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of task IDs to check. If empty or omitted, returns status of all child agents.',
            },
          },
        },
      },
      {
        name: 'list_agents',
        description:
          'List all spawned child agents for the current task. Shows their status, model, title, and progress.',
        input_schema: {
          type: 'object',
          properties: {
            status_filter: {
              type: 'string',
              enum: ['all', 'running', 'completed', 'failed'],
              description: 'Filter agents by status. Default: "all"',
            },
          },
        },
      },
    ];
  }
}
