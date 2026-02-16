import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { Workspace, GatewayContextType, AgentConfig, AgentType, Task, TaskEvent, TOOL_GROUPS, ToolGroupName } from '../../../shared/types';
import { AgentDaemon } from '../daemon';
import { FileTools } from './file-tools';
import { SkillTools } from './skill-tools';
import { SearchTools } from './search-tools';
import { WebFetchTools } from './web-fetch-tools';
import { GlobTools } from './glob-tools';
import { GrepTools } from './grep-tools';
import { EditTools } from './edit-tools';
import { MontyTools } from './monty-tools';
import { BrowserTools } from './browser-tools';
import { ShellTools } from './shell-tools';
import { ImageTools } from './image-tools';
import { VisionTools } from './vision-tools';
import { SystemTools } from './system-tools';
import { CronTools } from './cron-tools';
import { CanvasTools } from './canvas-tools';
import { VisualTools } from './visual-tools';
import { MentionTools } from './mention-tools';
import { XTools } from './x-tools';
import { NotionTools } from './notion-tools';
import { BoxTools } from './box-tools';
import { OneDriveTools } from './onedrive-tools';
import { GoogleDriveTools } from './google-drive-tools';
import { GmailTools } from './gmail-tools';
import { GoogleCalendarTools } from './google-calendar-tools';
import { AppleCalendarTools } from './apple-calendar-tools';
import { AppleRemindersTools } from './apple-reminders-tools';
import { DropboxTools } from './dropbox-tools';
import { SharePointTools } from './sharepoint-tools';
import { VoiceCallTools } from './voice-call-tools';
import { ChannelTools } from './channel-tools';
import { EmailImapTools } from './email-imap-tools';
import { ChannelRepository } from '../../database/repositories';
import { readFilesByPatterns } from './read-files';
import { LLMTool } from '../llm/types';
import { SearchProviderFactory } from '../search';
import { MCPClientManager } from '../../mcp/client/MCPClientManager';
import { MCPSettingsManager } from '../../mcp/settings';
import { MCPRegistryManager } from '../../mcp/registry/MCPRegistryManager';
import type { MCPServerConfig } from '../../mcp/types';
import { isToolAllowedQuick } from '../../security/policy-manager';
import { evaluateMontyToolPolicy } from '../../security/monty-tool-policy';
import { BuiltinToolsSettingsManager } from './builtin-settings';
import { getCustomSkillLoader } from '../custom-skill-loader';
import { PersonalityManager } from '../../settings/personality-manager';
import { PersonalityId, PersonaId, PERSONALITY_DEFINITIONS, PERSONA_DEFINITIONS } from '../../../shared/types';
import { resolveModelPreferenceToModelKey, resolvePersonalityPreference } from '../../../shared/agent-preferences';
import { isHeadlessMode } from '../../utils/runtime-mode';
import { HooksSettingsManager } from '../../hooks/settings';

function sanitizeFilename(raw: string, maxLen = 120): string {
  const base = path.basename(String(raw || '').trim() || 'artifact');
  const cleaned = base
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLen);
  return cleaned || 'artifact';
}

function guessExtFromMime(mimeType?: string): string {
  const mime = (mimeType || '').toLowerCase();
  if (mime === 'image/png') return '.png';
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/gif') return '.gif';
  if (mime === 'image/bmp') return '.bmp';
  return '';
}

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
  private montyTools: MontyTools;
  private browserTools: BrowserTools;
  private shellTools: ShellTools;
  private imageTools: ImageTools;
  private visionTools: VisionTools;
  private systemTools: SystemTools;
  private cronTools: CronTools;
  private canvasTools: CanvasTools;
  private visualTools: VisualTools;
  private mentionTools: MentionTools;
  private xTools: XTools;
  private notionTools: NotionTools;
  private boxTools: BoxTools;
  private oneDriveTools: OneDriveTools;
  private googleDriveTools: GoogleDriveTools;
  private gmailTools: GmailTools;
  private googleCalendarTools: GoogleCalendarTools;
  private appleCalendarTools: AppleCalendarTools;
  private appleRemindersTools: AppleRemindersTools;
  private dropboxTools: DropboxTools;
  private sharePointTools: SharePointTools;
  private voiceCallTools: VoiceCallTools;
  private channelTools?: ChannelTools;
  private emailImapTools?: EmailImapTools;
  private gatewayContext?: GatewayContextType;
  private deniedTools: Set<string> = new Set();
  private deniedGroups: Set<ToolGroupName> = new Set();
  private denyAllTools = false;
  private shadowedToolsLogged = false;

  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
    gatewayContext?: GatewayContextType,
    toolRestrictions?: string[]
  ) {
    this.fileTools = new FileTools(workspace, daemon, taskId);
    this.skillTools = new SkillTools(workspace, daemon, taskId);
    this.searchTools = new SearchTools(workspace, daemon, taskId);
    this.webFetchTools = new WebFetchTools(workspace, daemon, taskId);
    this.globTools = new GlobTools(workspace, daemon, taskId);
    this.grepTools = new GrepTools(workspace, daemon, taskId);
    this.editTools = new EditTools(workspace, daemon, taskId);
    this.montyTools = new MontyTools(workspace, daemon, taskId, this.fileTools);
    this.browserTools = new BrowserTools(workspace, daemon, taskId);
    this.shellTools = new ShellTools(workspace, daemon, taskId);
    this.imageTools = new ImageTools(workspace, daemon, taskId);
    this.visionTools = new VisionTools(workspace, daemon, taskId);
    this.systemTools = new SystemTools(workspace, daemon, taskId);
    this.cronTools = new CronTools(workspace, daemon, taskId);
    this.canvasTools = new CanvasTools(workspace, daemon, taskId);
    this.visualTools = new VisualTools(workspace, daemon, taskId);
    this.mentionTools = new MentionTools(workspace.id, taskId, daemon);
    this.xTools = new XTools(workspace, daemon, taskId);
    this.notionTools = new NotionTools(workspace, daemon, taskId);
    this.boxTools = new BoxTools(workspace, daemon, taskId);
    this.oneDriveTools = new OneDriveTools(workspace, daemon, taskId);
    this.googleDriveTools = new GoogleDriveTools(workspace, daemon, taskId);
    this.gmailTools = new GmailTools(workspace, daemon, taskId);
    this.googleCalendarTools = new GoogleCalendarTools(workspace, daemon, taskId);
    this.appleCalendarTools = new AppleCalendarTools(workspace, daemon, taskId);
    this.appleRemindersTools = new AppleRemindersTools(workspace, daemon, taskId);
    this.dropboxTools = new DropboxTools(workspace, daemon, taskId);
    this.sharePointTools = new SharePointTools(workspace, daemon, taskId);
    this.voiceCallTools = new VoiceCallTools(workspace, daemon, taskId);
    // Some unit tests stub daemon as a plain object. Make channel history tools optional.
    const dbGetter = (daemon as any)?.getDatabase;
    if (typeof dbGetter === 'function') {
      const db = dbGetter.call(daemon);
      this.channelTools = new ChannelTools(db, daemon, taskId);
      this.emailImapTools = new EmailImapTools(db, daemon, taskId);
    }
    this.gatewayContext = gatewayContext;
    this.applyToolRestrictions(toolRestrictions);
  }

  private applyToolRestrictions(restrictions?: string[]): void {
    this.deniedTools = new Set();
    this.deniedGroups = new Set();
    this.denyAllTools = false;
    if (!restrictions || restrictions.length === 0) return;

    for (const raw of restrictions) {
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (!value) continue;

      // Special marker meaning "deny all tools" (used as a safe default on corrupted policy data).
      if (value === '*') {
        this.denyAllTools = true;
        continue;
      }

      // Context policies may specify tool group names (e.g., "group:memory") or
      // individual tool names (e.g., "read_clipboard").
      if (Object.prototype.hasOwnProperty.call(TOOL_GROUPS, value)) {
        this.deniedGroups.add(value as ToolGroupName);
      } else {
        this.deniedTools.add(value);
      }
    }
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
    this.montyTools.setWorkspace(workspace);
    this.browserTools.setWorkspace(workspace);
    this.shellTools.setWorkspace(workspace);
    this.imageTools.setWorkspace(workspace);
    this.visionTools.setWorkspace(workspace);
    this.systemTools.setWorkspace(workspace);
    this.cronTools.setWorkspace(workspace);
    this.canvasTools.setWorkspace(workspace);
    this.visualTools.setWorkspace(workspace);
    this.xTools.setWorkspace(workspace);
    this.notionTools.setWorkspace(workspace);
    this.boxTools.setWorkspace(workspace);
    this.oneDriveTools.setWorkspace(workspace);
    this.googleDriveTools.setWorkspace(workspace);
    this.gmailTools.setWorkspace(workspace);
    this.googleCalendarTools.setWorkspace(workspace);
    this.appleCalendarTools.setWorkspace(workspace);
    this.appleRemindersTools.setWorkspace(workspace);
    this.dropboxTools.setWorkspace(workspace);
    this.sharePointTools.setWorkspace(workspace);
    this.voiceCallTools.setWorkspace(workspace);
  }

  /**
   * Enforce new canvas sessions for follow-up messages by setting a cutoff timestamp.
   * Sessions created before the cutoff will be rejected for canvas_push/open_url.
   */
  setCanvasSessionCutoff(cutoff: number | null): void {
    this.canvasTools.setSessionCutoff(cutoff);
  }

  getLatestCanvasSessionId(): string | null {
    const latestSession = this.canvasTools.getLatestActiveSessionForTask();
    return latestSession?.id || null;
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
    if (this.denyAllTools) {
      return false;
    }
    if (this.deniedTools.has(toolName)) {
      return false;
    }
    for (const groupName of this.deniedGroups) {
      const tools = TOOL_GROUPS[groupName] as readonly string[] | undefined;
      if (tools && tools.includes(toolName)) {
        return false;
      }
    }
    return isToolAllowedQuick(toolName, this.workspace, this.gatewayContext);
  }

  /**
   * Get all available tools in provider-agnostic format
   * Filters tools based on workspace permissions, gateway context, and user settings
   * Sorts tools by priority (high priority tools first)
   */
  getTools(): LLMTool[] {
    const headless = isHeadlessMode();
    const allTools: LLMTool[] = [
      ...this.getFileToolDefinitions(),
      ...this.getSkillToolDefinitions(),
      ...GlobTools.getToolDefinitions(),
      ...GrepTools.getToolDefinitions(),
      ...EditTools.getToolDefinitions(),
      ...MontyTools.getToolDefinitions(),
      ...WebFetchTools.getToolDefinitions(),
      ...BrowserTools.getToolDefinitions(),
    ];

    // Only add search tool if a provider is configured
    if (SearchProviderFactory.isAnyProviderConfigured()) {
      allTools.push(...this.getSearchToolDefinitions());
    }

    // Only add X/Twitter tool if integration is enabled
    if (XTools.isEnabled()) {
      allTools.push(...this.getXToolDefinitions());
    }

    // Only add Notion tool if integration is enabled
    if (NotionTools.isEnabled()) {
      allTools.push(...this.getNotionToolDefinitions());
    }

    // Only add Box tool if integration is enabled
    if (BoxTools.isEnabled()) {
      allTools.push(...this.getBoxToolDefinitions());
    }

    // Only add OneDrive tool if integration is enabled
    if (OneDriveTools.isEnabled()) {
      allTools.push(...this.getOneDriveToolDefinitions());
    }

    // Only add Google Workspace tools if the integration is enabled.
    // When disabled, exposing these tools causes the planner to repeatedly choose them and fail.
    if (GoogleDriveTools.isEnabled()) {
      allTools.push(...this.getGoogleDriveToolDefinitions());
    }
    if (GmailTools.isEnabled()) {
      allTools.push(...this.getGmailToolDefinitions());
    }
    if (GoogleCalendarTools.isEnabled()) {
      allTools.push(...this.getGoogleCalendarToolDefinitions());
    }

    // Apple Calendar tools (macOS only)
    if (AppleCalendarTools.isAvailable()) {
      allTools.push(...this.getAppleCalendarToolDefinitions());
    }

    // Apple Reminders tools (macOS only)
    if (AppleRemindersTools.isAvailable()) {
      allTools.push(...this.getAppleRemindersToolDefinitions());
    }

    // Only add Dropbox tool if integration is enabled
    if (DropboxTools.isEnabled()) {
      allTools.push(...this.getDropboxToolDefinitions());
    }

    // Only add SharePoint tool if integration is enabled
    if (SharePointTools.isEnabled()) {
      allTools.push(...this.getSharePointToolDefinitions());
    }

    // Voice call tools (outbound phone calls)
    allTools.push(...this.getVoiceCallToolDefinitions());

    // Only add shell tool if workspace has shell permission
    if (this.workspace.permissions.shell) {
      allTools.push(...this.getShellToolDefinitions());
    }

    // Always add image tools; they will surface setup guidance if API keys are missing
    allTools.push(...ImageTools.getToolDefinitions());

    // Vision tools (image understanding); may surface setup guidance if API keys are missing
    allTools.push(...VisionTools.getToolDefinitions());

    // Always add system tools (they enable broader system interaction)
    allTools.push(...SystemTools.getToolDefinitions({ headless }));

    // Always add cron/scheduling tools (enables task scheduling)
    allTools.push(...CronTools.getToolDefinitions());

    // Canvas/visual tools require a desktop UI; skip in headless mode (VPS/server).
    if (!headless) {
      allTools.push(...CanvasTools.getToolDefinitions());
      allTools.push(...VisualTools.getToolDefinitions());
    }

    // Always add mention tools (enables multi-agent collaboration)
    allTools.push(...MentionTools.getToolDefinitions());

    // Channel history tools (local gateway message log)
    if (this.channelTools) {
      allTools.push(...ChannelTools.getToolDefinitions());
    }

    // Email IMAP tools (direct mailbox access, only if configured/enabled)
    if (this.emailImapTools && this.emailImapTools.isAvailable()) {
      allTools.push(...EmailImapTools.getToolDefinitions());
    }

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
      if ([
        'revise_plan',
        'task_history',
        'set_personality',
        'set_persona',
        'set_agent_name',
        'set_user_name',
        'set_response_style',
        'set_quirks',
        'integration_setup',
        'spawn_agent',
        'wait_for_agent',
        'get_agent_status',
        'list_agents',
        'send_agent_message',
        'capture_agent_events',
        'cancel_agent',
        'pause_agent',
        'resume_agent',
      ].includes(tool.name)) {
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
   * Query prior task history from the local database.
   * This is a privacy-sensitive tool; it may be blocked in shared gateway contexts.
   */
  private taskHistory(input: {
    period: 'today' | 'yesterday' | 'last_7_days' | 'last_30_days' | 'custom';
    from?: string;
    to?: string;
    limit?: number;
    workspace_id?: string;
    query?: string;
    include_messages?: boolean;
  }): any {
    const period = input?.period;
    const allowed: Array<typeof period> = ['today', 'yesterday', 'last_7_days', 'last_30_days', 'custom'];
    if (!period || !allowed.includes(period)) {
      throw new Error(`Invalid period. Expected one of: ${allowed.join(', ')}`);
    }

    return this.daemon.queryTaskHistory({
      period,
      from: input.from,
      to: input.to,
      limit: input.limit,
      workspaceId: input.workspace_id,
      query: input.query,
      includeMessages: input.include_messages,
    });
  }

  /**
   * Query prior task event logs (tool calls, messages, feedback, file ops) from the local database.
   * Privacy-sensitive; should be blocked in shared gateway contexts.
   */
  private taskEvents(input: {
    period: 'today' | 'yesterday' | 'last_7_days' | 'last_30_days' | 'custom';
    from?: string;
    to?: string;
    limit?: number;
    workspace_id?: string;
    types?: string[];
    include_payload?: boolean;
  }): any {
    const period = input?.period;
    const allowed: Array<typeof period> = ['today', 'yesterday', 'last_7_days', 'last_30_days', 'custom'];
    if (!period || !allowed.includes(period)) {
      throw new Error(`Invalid period. Expected one of: ${allowed.join(', ')}`);
    }

    return this.daemon.queryTaskEvents({
      period,
      from: input.from,
      to: input.to,
      limit: input.limit,
      workspaceId: input.workspace_id,
      types: input.types,
      includePayload: input.include_payload,
    });
  }

  /**
   * Get human-readable tool descriptions
   */
  getToolDescriptions(visibleTools?: string[]): string {
    const visibleToolSet = visibleTools?.length
      ? new Set(visibleTools.map((tool) => tool.trim()).filter(Boolean))
      : null;
    const isVisible = (toolName: string): boolean => !visibleToolSet || visibleToolSet.has(toolName);
    const hasAnyVisibleTools = (...toolNames: string[]): boolean =>
      !visibleToolSet || toolNames.some((toolName) => isVisible(toolName));

    const googleWorkspaceEnabled =
      GmailTools.isEnabled() || GoogleCalendarTools.isEnabled() || GoogleDriveTools.isEnabled();

    let emailChannelStatus = 'unknown';
    try {
      // Some unit tests stub daemon as a plain object. Keep this best-effort.
      const dbGetter = (this.daemon as any)?.getDatabase;
      if (typeof dbGetter === 'function') {
        const channelRepo = new ChannelRepository(dbGetter.call(this.daemon));
        const emailChannel = channelRepo.findByType('email');
        if (!emailChannel) {
          emailChannelStatus = 'not configured';
        } else {
          const enabledText = emailChannel.enabled ? 'enabled' : 'configured (disabled)';
          const statusText = typeof emailChannel.status === 'string' && emailChannel.status.trim().length > 0
            ? emailChannel.status.trim()
            : 'unknown';
          const hint = statusText === 'error'
            ? ' (currently failing to connect; check Settings > Channels > Email)'
            : '';
          emailChannelStatus = `${enabledText}, status=${statusText}${hint}`;
        }
      } else {
        emailChannelStatus = 'unavailable (no database access in this context)';
      }
    } catch {
      emailChannelStatus = 'unknown (failed to read local channel config)';
    }

    let descriptions = `
Integration Status:
- Google Workspace integration (gmail_action/calendar_action/google_drive_action): ${googleWorkspaceEnabled ? 'ENABLED' : 'DISABLED (enable in Settings > Integrations > Google Workspace)'}
- Email channel (IMAP/SMTP): ${emailChannelStatus}

File Operations:
- read_file: Read contents of a file (supports plain text, DOCX, PDF, and PPTX)
- read_files: Read multiple files matched by glob patterns (supports exclusion patterns with leading "!")
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
- use_skill: Invoke a custom skill by ID to help accomplish tasks (see available skills below). Use explicit IDs for deterministic workflows ("Use the <skill id> skill."). If the skill writes files, use the "{artifactDir}" placeholder for deterministic workspace output.

Skill Management (create, modify, duplicate skills):
- skill_list: List all skills with metadata (source, path, status)
- skill_get: Get full JSON content of a skill by ID
- skill_create: Create a new custom skill
- skill_duplicate: Duplicate an existing skill with modifications (great for variations)
- skill_update: Update an existing skill (managed/workspace only, not bundled)
- skill_delete: Delete a skill (managed/workspace only, not bundled)
Skills are stored in ~/Library/Application Support/cowork-os/skills/ (managed) or workspace/skills/ (workspace).

Code Tools (PREFERRED for code navigation and editing):
- glob: Fast pattern-based file search (e.g., "**/*.ts", "src/**/*.test.ts")
  Use this FIRST to find files by pattern - much faster than search_files.
- grep: Powerful regex content search (e.g., "async function.*fetch", "class\\s+\\w+")
  Use this FIRST for searching file contents - supports full regex.
- edit_file: Surgical text replacement in files (old_string -> new_string)
  Use this INSTEAD of write_file for targeted changes - safer and preserves structure.
- monty_run: Deterministic, sandboxed Python-subset compute for post-processing tool results.
- monty_list_transforms / monty_run_transform: Run workspace-local transforms from .cowork/transforms/.
- monty_transform_file: Apply a transform to a file and write output without returning full file contents to the LLM.
- extract_json: Extract and parse JSON from messy text (prose + code fences).

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

    descriptions += `

Image Generation:
- generate_image: Generate images from text descriptions using an image-capable model.
  - Uses the best configured image provider automatically (Azure OpenAI / OpenAI / Gemini), independent of the active chat model.
  - If multiple image providers are configured, it will try the default first and use others as fallbacks unless explicitly overridden.
  - If no image provider is configured, the tool returns setup guidance.`;

    descriptions += `

Vision (Image Understanding):
- analyze_image: Analyze an image file from the workspace (screenshots/photos)
  - Extract text, describe items, answer questions, summarize what is shown
  - Uses a vision-capable provider (OpenAI/Anthropic/Gemini); the tool will prompt setup guidance if missing.`;

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
- search_memories: Search workspace memories and imported conversations for past context

Scheduling:
- schedule_task: Schedule tasks to run at specific times or intervals
  - Create reminders: "remind me to X at Y"
  - Recurring tasks: "every day at 9am, do X"
  - One-time tasks: "at 3pm tomorrow, do X"
  - Cron schedules: standard cron expressions supported

${hasAnyVisibleTools(
  'canvas_create',
  'canvas_push',
  'canvas_open_url',
  'canvas_show',
  'canvas_hide',
  'canvas_close',
  'canvas_eval',
  'canvas_snapshot',
  'canvas_list'
)
  ? `
Live Canvas (Visual Workspace):
- canvas_create: Create a new canvas session for displaying interactive content when the user explicitly asks for live UI, dashboard, or in-app browsing.
- canvas_push: Push HTML/CSS/JS content to the canvas. session_id and/or content may be omitted for recovery fallback.
  Only use for explicit visual-output tasks (interactive interfaces, charts, rich previews, app-style content).
  Do NOT use for status updates, summaries, planning, file operations, or checklist-style tasks.
  Example: canvas_push({ session_id: "abc-123", content: "<!DOCTYPE html><html><body><h1>Hello</h1></body></html>" })
  If session_id is not provided, the tool can attempt to continue the latest active canvas session for this task.
- canvas_open_url: Open a remote web page inside the canvas window for full in-app browsing (use for sites that block embedding)
- canvas_show: OPTIONAL - Only use if user needs full interactivity (clicking buttons, forms)
- canvas_hide: Hide the canvas window
- canvas_close: Close a canvas session
- canvas_eval: Execute JavaScript in the canvas context
- canvas_snapshot: Take a screenshot of the canvas
- canvas_list: List all active canvas sessions
IMPORTANT: When using canvas_push for visual output, provide content when available.
If omitted, the runtime fills in a safe fallback so execution can continue.
`
  : ''}

${hasAnyVisibleTools('visual_open_annotator', 'visual_update_annotator')
  ? `
Agentic Image Iteration (Visual Annotator):
- visual_open_annotator: Open an image annotation UI in Live Canvas for a workspace image
- visual_update_annotator: Update an existing annotator session with a new image iteration
The annotator sends [Canvas Interaction] messages back to the running task with structured JSON feedback.
`
  : ''}

${this.channelTools ? `
Channel Message Log (Local Gateway):
- channel_list_chats: List recently active chats for a channel (discover chat IDs)
- channel_history: Fetch recent messages for a specific chat ID (use for summarization/monitoring)` : ''}

		Plan Control:
		- revise_plan: Modify remaining plan steps when obstacles are encountered or new information discovered
		- task_history: Query recent task history/messages (use for "what did we talk about yesterday?")
		- switch_workspace: Switch to a different workspace/working directory. Use when you need to work in a different folder.
		- integration_setup: Inspect/configure integrations from chat (e.g., enable email sending via Resend, ask for missing API keys, provide setup links).
		- set_personality: Change the assistant's communication style (professional, friendly, concise, creative, technical, casual).
	- set_persona: Change the assistant's character persona (jarvis, friday, hal, computer, alfred, intern, sensei, pirate, noir, companion, or none).
	- set_response_style: Adjust response preferences (emoji_usage, response_length, code_comments, explanation_depth).
	- set_quirks: Set personality quirks (catchphrase, sign_off, analogy_domain).
- set_agent_name: Set or change the assistant's name when the user wants to give you a name.
- set_user_name: Store the user's name when they introduce themselves (e.g., "I'm Alice", "My name is Bob").`;

    // Add custom skills available for use_skill
    const skillLoader = getCustomSkillLoader();
    const availableToolNames = new Set(this.getTools().map((tool) => tool.name));
    const skillDescriptions = skillLoader.getSkillDescriptionsForModel({ availableToolNames });
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
    // Optional workspace-local policy hook (.cowork/policy/tools.monty).
    // Fail-open on policy script errors to avoid bricking tool execution.
    try {
      const policy = await evaluateMontyToolPolicy({
        workspace: this.workspace,
        toolName: name,
        toolInput: input,
        gatewayContext: this.gatewayContext,
      });

      if (policy.decision === 'deny') {
        const reason = policy.reason ? `: ${policy.reason}` : '';
        throw new Error(`Tool "${name}" blocked by workspace policy${reason}`);
      }

      // Avoid double-prompts for tools that already enforce approvals internally.
      const selfGated = name === 'run_command' || name === 'delete_file';
      if (policy.decision === 'require_approval' && !selfGated) {
        const requester = (this.daemon as any)?.requestApproval;
        if (typeof requester !== 'function') {
          throw new Error(`Tool "${name}" requires approval, but approval system is unavailable in this context`);
        }
        const approved = await requester.call(
          this.daemon,
          this.taskId,
          'external_service',
          `Approve tool call: ${name}`,
          {
            tool: name,
            params: input ?? null,
            reason: policy.reason || null,
          }
        );
        if (!approved) {
          const reason = policy.reason ? `: ${policy.reason}` : '';
          throw new Error(`Tool "${name}" approval denied${reason}`);
        }
      }
    } catch (err) {
      // Only block if the policy explicitly denied or required approval and was not approved.
      const msg = String((err as any)?.message || '');
      if (/blocked by workspace policy|approval denied|requires approval/i.test(msg)) {
        throw err;
      }
    }

    // File tools
    if (name === 'read_file') return await this.fileTools.readFile(input.path);
    if (name === 'read_files') return await readFilesByPatterns(input, { globTools: this.globTools, fileTools: this.fileTools });
    if (name === 'write_file') return await this.fileTools.writeFile(input.path, input.content);
    if (name === 'copy_file') return await this.fileTools.copyFile(input.sourcePath, input.destPath);
    if (name === 'list_directory') return await this.fileTools.listDirectory(input.path);
    if (name === 'list_directory_with_sizes') return await this.fileTools.listDirectoryWithSizes(input.path);
    if (name === 'get_file_info') return await this.fileTools.getFileInfo(input.path);
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
    if (name === 'monty_run') return await this.montyTools.montyRun(input);
    if (name === 'monty_list_transforms') return await this.montyTools.listTransforms(input);
    if (name === 'monty_run_transform') return await this.montyTools.runTransform(input);
    if (name === 'monty_transform_file') return await this.montyTools.transformFile(input);
    if (name === 'extract_json') return await this.montyTools.extractJson(input);

    // Web fetch tools (preferred for reading web content)
    if (name === 'web_fetch') return await this.webFetchTools.webFetch(input);
    if (name === 'http_request') return await this.webFetchTools.httpRequest(input);

    // Browser tools
    if (BrowserTools.isBrowserTool(name)) {
      return await this.browserTools.executeTool(name, input);
    }

    // Search tools
    if (name === 'web_search') return await this.searchTools.webSearch(input);

    // X/Twitter tools
    if (name === 'x_action') return await this.xTools.executeAction(input);

    // Notion tools
    if (name === 'notion_action') return await this.notionTools.executeAction(input);

    // Box tools
    if (name === 'box_action') return await this.boxTools.executeAction(input);

    // OneDrive tools
    if (name === 'onedrive_action') return await this.oneDriveTools.executeAction(input);

    // Google Drive tools
    if (name === 'google_drive_action') return await this.googleDriveTools.executeAction(input);

    // Gmail tools
    if (name === 'gmail_action') return await this.gmailTools.executeAction(input);

    // Google Calendar tools
    if (name === 'calendar_action') return await this.googleCalendarTools.executeAction(input);

    // Apple Calendar tools (macOS)
    if (name === 'apple_calendar_action') return await this.appleCalendarTools.executeAction(input);

    // Apple Reminders tools (macOS)
    if (name === 'apple_reminders_action') return await this.appleRemindersTools.executeAction(input);

    // Dropbox tools
    if (name === 'dropbox_action') return await this.dropboxTools.executeAction(input);

    // SharePoint tools
    if (name === 'sharepoint_action') return await this.sharePointTools.executeAction(input);

    // Voice call tools
    if (name === 'voice_call') return await this.voiceCallTools.executeAction(input);

    // Shell tools
    if (name === 'run_command') return await this.shellTools.runCommand(input.command, input);

    // Image tools
    if (name === 'generate_image') return await this.imageTools.generateImage(input);

    // Vision tools
    if (name === 'analyze_image') return await this.visionTools.analyzeImage(input);

    // System tools
    if (name === 'system_info') return await this.systemTools.getSystemInfo();
    if (name === 'search_memories') return await this.systemTools.searchMemories(input);
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
      const canvasInput = input || {};
      const rawSessionId = canvasInput.session_id;
      const inferredSessionId = rawSessionId || this.getLatestCanvasSessionId();
      if (!canvasInput.session_id && inferredSessionId) {
        canvasInput.session_id = inferredSessionId;
      }
      try {
        return await this.canvasTools.pushContent(canvasInput.session_id, canvasInput.content, canvasInput.filename);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown canvas push error';
        this.daemon.logEvent(this.taskId, 'tool_error', {
          tool: 'canvas_push',
          error: message,
          softFailure: true,
        });
        return {
          success: true,
          warning:
            'Canvas preview could not be refreshed right now, but execution can continue without it.',
          fallback: true,
        };
      }
    }
    if (name === 'canvas_open_url') return await this.canvasTools.openUrl(input.session_id, input.url, input.show);
    if (name === 'canvas_show') return await this.canvasTools.showCanvas(input.session_id);
    if (name === 'canvas_hide') return this.canvasTools.hideCanvas(input.session_id);
    if (name === 'canvas_close') return await this.canvasTools.closeCanvas(input.session_id);
    if (name === 'canvas_eval') return await this.canvasTools.evalScript(input.session_id, input.script);
    if (name === 'canvas_snapshot') return await this.canvasTools.takeSnapshot(input.session_id);
    if (name === 'canvas_list') return this.canvasTools.listSessions();
    if (name === 'canvas_checkpoint') return await this.canvasTools.saveCheckpoint(input.session_id, input.label);
    if (name === 'canvas_restore') return await this.canvasTools.restoreCheckpoint(input.session_id, input.checkpoint_id);
    if (name === 'canvas_checkpoints') return this.canvasTools.listCheckpoints(input.session_id);

    // Visual annotator tools
    if (name === 'visual_open_annotator') return await this.visualTools.openImageAnnotator(input);
    if (name === 'visual_update_annotator') return await this.visualTools.updateImageAnnotator(input);

    // Channel history tools
    if (name === 'channel_list_chats' || name === 'channel_history') {
      if (!this.channelTools) {
        throw new Error('Channel history tools unavailable (database not accessible)');
      }
      if (name === 'channel_list_chats') return await this.channelTools.listChats(input);
      return await this.channelTools.channelHistory(input);
    }

    // Email IMAP tools (direct inbox access)
    if (name === 'email_imap_unread') {
      if (!this.emailImapTools) {
        throw new Error('Email IMAP tools unavailable (database not accessible)');
      }
      return await this.emailImapTools.listUnread(input);
    }

    // Mention tools (multi-agent collaboration)
    if (name === 'list_agent_roles') return await this.mentionTools.listAgentRoles();
    if (name === 'mention_agent') return await this.mentionTools.mentionAgent(input);
    if (name === 'get_pending_mentions') return await this.mentionTools.getPendingMentions();
    if (name === 'acknowledge_mention') return await this.mentionTools.acknowledgeMention(input.mentionId);
    if (name === 'complete_mention') return await this.mentionTools.completeMention(input.mentionId);

    // Meta tools
    if (name === 'task_history') {
      return this.taskHistory(input);
    }
    if (name === 'task_events') {
      return this.taskEvents(input);
    }

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

    if (name === 'integration_setup') {
      return await this.integrationSetup(input);
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
	    if (name === 'send_agent_message') {
	      return await this.sendAgentMessage(input);
	    }
	    if (name === 'capture_agent_events') {
	      return await this.captureAgentEvents(input);
	    }
	    if (name === 'cancel_agent') {
	      return await this.cancelAgent(input);
	    }
	    if (name === 'pause_agent') {
	      return await this.pauseAgent(input);
	    }
	    if (name === 'resume_agent') {
	      return await this.resumeAgent(input);
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

    // Guard against using puppeteer_evaluate for Node/shell execution
    if (mcpToolName === 'puppeteer_evaluate') {
      const script = typeof input?.script === 'string' ? input.script : '';
      if (/(require\s*\(|child_process|execSync|exec\(|spawn\()/i.test(script)) {
        throw new Error(
          "MCP tool 'puppeteer_evaluate' cannot run Node shell APIs. " +
          "Use run_command for shell commands or browser_evaluate for DOM-only scripts."
        );
      }
    }

    // At this point, we know it's a valid MCP tool - any errors should be propagated
    console.log(`[ToolRegistry] Executing MCP tool: ${mcpToolName}`);

    try {
      const result = await mcpManager.callTool(mcpToolName, input);
      // Format MCP result and process any generated files
      return await this.formatMCPResult(result, mcpToolName, input);
    } catch (error: any) {
      const message = String(error?.message || '');
      if (/access denied\s*-\s*path outside allowed directories/i.test(message)) {
        return {
          success: false,
          error:
            `MCP tool '${mcpToolName}' cannot access that path from its configured roots. ` +
            'Use workspace file tools (list_directory/read_file/write_file) for this workspace, or run in an allowed directory.',
          source: 'mcp',
          tool: mcpToolName,
        };
      }
      // Tool was registered but execution failed - propagate the error with context
      throw new Error(`MCP tool '${mcpToolName}' failed: ${message}`);
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
      const savedImageFilenames: string[] = [];
      for (const content of result.content) {
        if (content.type === 'image' && content.data) {
          // Save inline image to workspace
          const mimeType: string | undefined = content.mimeType || undefined;
          const ext = guessExtFromMime(mimeType) || '.png';
          const rawNameCandidate =
            (typeof input?.filePath === 'string' && input.filePath.trim())
              ? path.basename(input.filePath)
              : (typeof input?.filename === 'string' && input.filename.trim())
                ? path.basename(input.filename)
                : (typeof input?.name === 'string' && input.name.trim())
                  ? String(input.name).trim()
                  : `mcp-screenshot-${Date.now()}`;

          let filename = sanitizeFilename(rawNameCandidate);
          if (!path.extname(filename)) {
            filename += ext;
          }

          let outputPath = path.join(this.workspace.path, filename);
          if (fs.existsSync(outputPath)) {
            const stem = path.basename(filename, path.extname(filename));
            const unique = `${stem}-${Date.now()}${path.extname(filename) || ext}`;
            filename = unique;
            outputPath = path.join(this.workspace.path, filename);
          }

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
            this.daemon.registerArtifact(this.taskId, outputPath, mimeType || 'image/png');
            savedImageFilenames.push(filename);

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
        const baseText = textParts.join('\n');
        if (savedImageFilenames.length > 0) {
          const suffix = savedImageFilenames
            .map((f) => `Saved image: ${f}`)
            .join('\n');
          return `${baseText}\n${suffix}`;
        }
        return baseText;
      }

      if (savedImageFilenames.length > 0) {
        return savedImageFilenames.length === 1
          ? `Saved image: ${savedImageFilenames[0]}`
          : savedImageFilenames.map((f) => `Saved image: ${f}`).join('\n');
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

    const status = await skillLoader.getSkillStatusEntry(skill_id);
    if (status && !status.eligible) {
      if (status.disabled) {
        return {
          success: false,
          error: `Skill '${skill_id}' is disabled`,
          reason: 'The selected skill is disabled in configuration.',
          suggestion: 'Enable it in skill settings or use an alternative skill.',
        };
      }

      if (status.blockedByAllowlist) {
        return {
          success: false,
          error: `Skill '${skill_id}' is blocked by skill allowlist/denylist policy`,
          reason: 'Current workspace/instance policy does not allow this skill.',
        };
      }

      const missing = status.missing;
      const missingItems = [
        ...missing.bins.map((bin) => `bin:${bin}`),
        ...missing.anyBins.map((bin) => `any-bin:${bin}`),
        ...missing.env.map((env) => `env:${env}`),
        ...missing.config.map((cfg) => `config:${cfg}`),
        ...missing.os.map((os) => `os:${os}`),
      ];

      if (missingItems.length > 0) {
        return {
          success: false,
          error: `Skill '${skill_id}' is not currently executable`,
          reason: 'Missing or invalid skill prerequisites.',
          missing_requirements: missing,
          missing_items: missingItems,
          suggestion: 'Install required binaries/tools, set required environment variables, or switch OS context, then retry.',
        };
      }
    }

    // Enforce tool-level requirements at invocation time.
    // This prevents selecting CLI-oriented skills when run_command/shell access is unavailable.
    const toolNames = new Set(this.getTools().map((tool) => tool.name));
    const requiredToolsFromSkill = Array.isArray((skill.requires as any)?.tools)
      ? ((skill.requires as any).tools as unknown[])
          .filter((tool): tool is string => typeof tool === 'string' && tool.trim().length > 0)
      : [];
    const inferredRequiredTools: string[] = [];
    const hasBinaryRequirements =
      (Array.isArray(skill.requires?.bins) && skill.requires.bins.length > 0) ||
      (Array.isArray(skill.requires?.anyBins) && skill.requires.anyBins.length > 0);
    if (hasBinaryRequirements) {
      inferredRequiredTools.push('run_command');
    }

    const requiredTools = Array.from(new Set([...requiredToolsFromSkill, ...inferredRequiredTools]));
    const missingTools = requiredTools.filter((tool) => !toolNames.has(tool));
    if (missingTools.length > 0) {
      return {
        success: false,
        error: `Skill '${skill_id}' is not currently executable`,
        reason: `Missing required tools: ${missingTools.join(', ')}`,
        missing_tools: missingTools,
        suggestion: 'Enable the missing tools/integrations in this workspace context or use a different skill.',
      };
    }

    // Check for required parameters
    const artifactDir = path.join(this.workspace.path, 'artifacts', 'skills', this.taskId, skill_id);
    try {
      if (!fs.existsSync(artifactDir)) {
        await fsPromises.mkdir(artifactDir, { recursive: true });
      }
    } catch {
      // Best-effort: keep tool usable even when the workspace path is restricted.
    }

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
    const expandedPrompt = skillLoader.expandPrompt(skill, parameters, { artifactDir });

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
    const promptWithBaseDir = skillLoader.expandBaseDir(skill.prompt, skill);
    return {
      success: true,
      skill: {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        prompt: promptWithBaseDir,
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
        description: 'Read the contents of a file in the workspace. Supports plain text files, DOCX (Word documents), PDF, and PPTX. For DOCX/PDF/PPTX, extracts and returns the text content.',
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
        name: 'read_files',
        description:
          'Read multiple files in one call using glob patterns. Useful for quickly attaching context without many read_file calls. ' +
          'Supports exclusion patterns by prefixing with "!". Example: ["src/**/*.ts", "!src/**/__tests__/**"].',
        input_schema: {
          type: 'object',
          properties: {
            patterns: {
              type: 'array',
              items: { type: 'string' },
              description: 'Glob patterns to include/exclude. Prefix a pattern with "!" to exclude.',
            },
            path: {
              type: 'string',
              description:
                'Base directory for globs (relative to workspace unless absolute path is allowed). Defaults to workspace root.',
            },
            maxFiles: {
              type: 'number',
              description: 'Maximum number of files to include (default: 12, max: 100)',
            },
            maxResults: {
              type: 'number',
              description: 'Maximum glob matches per pattern (default: 500, max: 5000)',
            },
            maxTotalChars: {
              type: 'number',
              description: 'Maximum total characters across returned file contents (default: 30000, max: 200000)',
            },
          },
          required: ['patterns'],
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
        name: 'list_directory_with_sizes',
        description: 'List files and folders in a directory with size summary (MCP-style output)',
        input_schema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Relative or absolute path to the directory',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'get_file_info',
        description: 'Get file or directory metadata (size, timestamps, permissions)',
        input_schema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Path to the file or directory',
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
          '(~/Library/Application Support/cowork-os/skills/). Provide the full skill definition.',
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
                parameters: {
                  type: 'array',
                  description: 'New parameters array',
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
                parameters: {
                  type: 'array',
                  description: 'New parameters array',
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
          `Search the web for information. This is the PRIMARY tool for research tasks - finding news, trends, discussions, and information on any topic. ` +
          `Use this FIRST for research, then use web_fetch if you need to read specific URLs from the results. ` +
          `Do NOT use browser_navigate for research - web_search is faster and more efficient. ` +
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
   * Define X/Twitter tools (bird CLI)
   */
  private getXToolDefinitions(): LLMTool[] {
    return [
      {
        name: 'x_action',
        description:
          'Use the connected X/Twitter account to read, search, and post. ' +
          'Posting actions (tweet/reply/follow/unfollow) require user approval. ' +
          'If X blocks a request (rate limit/challenge/auth/access issue), this tool attempts browser-mode fallback for read/write actions.',
        input_schema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [
                'whoami',
                'read',
                'thread',
                'replies',
                'search',
                'user_tweets',
                'mentions',
                'home',
                'tweet',
                'reply',
                'follow',
                'unfollow',
              ],
              description: 'Action to perform',
            },
            id_or_url: {
              type: 'string',
              description: 'Tweet URL or ID (for read/thread/replies/reply)',
            },
            query: {
              type: 'string',
              description: 'Search query (for search)',
            },
            user: {
              type: 'string',
              description: 'User handle (with or without @) for user_tweets/mentions/follow/unfollow',
            },
            text: {
              type: 'string',
              description: 'Text for tweet/reply',
            },
            timeline: {
              type: 'string',
              enum: ['for_you', 'following'],
              description: 'Timeline for home (default: for_you)',
            },
            count: {
              type: 'number',
              description: 'Max results (1-50) for search/mentions/home/user_tweets',
            },
            media: {
              type: 'array',
              description: 'Media file paths (workspace-relative). Up to 4 images or 1 video.',
              items: { type: 'string' },
            },
            alt: {
              type: 'string',
              description: 'Alt text for media (single string)',
            },
          },
          required: ['action'],
        },
      },
    ];
  }

  /**
   * Define Notion tools
   */
  private getNotionToolDefinitions(): LLMTool[] {
    return [
      {
        name: 'notion_action',
        description:
          'Use the connected Notion account to search, read, and update pages/data sources. ' +
          'Write actions (create/update/append) require user approval.',
        input_schema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [
                'search',
                'list_users',
                'get_user',
                'get_page',
                'get_page_property',
                'get_database',
                'get_block',
                'get_block_children',
                'update_block',
                'delete_block',
                'create_page',
                'update_page',
                'append_blocks',
                'query_data_source',
                'get_data_source',
                'create_data_source',
                'update_data_source',
              ],
              description: 'Action to perform',
            },
            query: {
              type: 'string',
              description: 'Search query (for search)',
            },
            user_id: {
              type: 'string',
              description: 'User ID (for get_user)',
            },
            page_id: {
              type: 'string',
              description: 'Page ID (for get_page/update_page)',
            },
            property_id: {
              type: 'string',
              description: 'Property ID (for get_page_property)',
            },
            block_id: {
              type: 'string',
              description: 'Block ID (for get_block/get_block_children/append_blocks/update_block/delete_block)',
            },
            block_type: {
              type: 'string',
              description: 'Block type key for update_block (e.g., "paragraph")',
            },
            block: {
              type: 'object',
              description: 'Block payload for update_block (e.g., { rich_text: [...] })',
            },
            data_source_id: {
              type: 'string',
              description: 'Data source ID (for query_data_source/get_data_source)',
            },
            database_id: {
              type: 'string',
              description: 'Database ID (for create_page/get_database)',
            },
            parent_page_id: {
              type: 'string',
              description: 'Parent page ID (for create_page or create_data_source)',
            },
            properties: {
              type: 'object',
              description: 'Notion properties payload for create/update',
            },
            children: {
              type: 'array',
              description: 'Block children payload for append_blocks',
              items: { type: 'object' },
            },
            filter: {
              type: 'object',
              description: 'Filter object for search/query',
            },
            sort: {
              type: 'object',
              description: 'Sort object for search',
            },
            sorts: {
              type: 'array',
              description: 'Sorts array for search/query',
              items: { type: 'object' },
            },
            start_cursor: {
              type: 'string',
              description: 'Pagination cursor',
            },
            page_size: {
              type: 'number',
              description: 'Pagination page size',
            },
            archived: {
              type: 'boolean',
              description: 'Archive/unarchive page (for update_page)',
            },
            icon: {
              type: 'object',
              description: 'Icon payload (for create/update)',
            },
            cover: {
              type: 'object',
              description: 'Cover payload (for create/update)',
            },
            title: {
              type: 'string',
              description: 'Title for create_data_source/update_data_source',
            },
            is_inline: {
              type: 'boolean',
              description: 'Create inline data source (for create_data_source)',
            },
            payload: {
              type: 'object',
              description: 'Raw request body to send directly (advanced use)',
            },
          },
          required: ['action'],
        },
      },
    ];
  }

  /**
   * Define Box tools
   */
  private getBoxToolDefinitions(): LLMTool[] {
    return [
      {
        name: 'box_action',
        description:
          'Use the connected Box account to search, read, and manage files/folders. ' +
          'Write actions (create/upload/delete) require user approval.',
        input_schema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [
                'get_current_user',
                'search',
                'get_file',
                'get_folder',
                'list_folder_items',
                'create_folder',
                'delete_file',
                'delete_folder',
                'upload_file',
              ],
              description: 'Action to perform',
            },
            query: {
              type: 'string',
              description: 'Search query (for search)',
            },
            limit: {
              type: 'number',
              description: 'Max results (for search/list_folder_items)',
            },
            offset: {
              type: 'number',
              description: 'Offset for pagination (for search/list_folder_items)',
            },
            fields: {
              type: 'string',
              description: 'Comma-separated fields to return',
            },
            type: {
              type: 'string',
              enum: ['file', 'folder', 'web_link'],
              description: 'Filter search results by type',
            },
            ancestor_folder_ids: {
              type: 'string',
              description: 'Comma-separated ancestor folder IDs for search',
            },
            file_extensions: {
              type: 'string',
              description: 'Comma-separated file extensions for search',
            },
            content_types: {
              type: 'string',
              description: 'Comma-separated content types for search',
            },
            scope: {
              type: 'string',
              description: 'Search scope (e.g., user_content)',
            },
            folder_id: {
              type: 'string',
              description: 'Folder ID (for get_folder/list_folder_items/delete_folder)',
            },
            file_id: {
              type: 'string',
              description: 'File ID (for get_file/delete_file)',
            },
            parent_id: {
              type: 'string',
              description: 'Parent folder ID (for create_folder/upload_file). Defaults to root.',
            },
            name: {
              type: 'string',
              description: 'Name for create_folder/upload_file',
            },
            file_path: {
              type: 'string',
              description: 'Workspace-relative path to upload (for upload_file)',
            },
          },
          required: ['action'],
        },
      },
    ];
  }

  /**
   * Define OneDrive tools
   */
  private getOneDriveToolDefinitions(): LLMTool[] {
    return [
      {
        name: 'onedrive_action',
        description:
          'Use the connected OneDrive account to search, read, and manage files/folders. ' +
          'Write actions (create/upload/delete) require user approval.',
        input_schema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [
                'get_drive',
                'search',
                'list_children',
                'get_item',
                'create_folder',
                'upload_file',
                'delete_item',
              ],
              description: 'Action to perform',
            },
            drive_id: {
              type: 'string',
              description: 'Drive ID override (optional)',
            },
            item_id: {
              type: 'string',
              description: 'Item ID (for get_item/list_children/delete_item)',
            },
            query: {
              type: 'string',
              description: 'Search query (for search)',
            },
            parent_id: {
              type: 'string',
              description: 'Parent folder ID (for create_folder/upload_file)',
            },
            name: {
              type: 'string',
              description: 'Name for create_folder or uploaded file',
            },
            conflict_behavior: {
              type: 'string',
              enum: ['rename', 'fail', 'replace'],
              description: 'Conflict behavior for create_folder',
            },
            file_path: {
              type: 'string',
              description: 'Workspace-relative path to upload (for upload_file)',
            },
            remote_path: {
              type: 'string',
              description: 'Remote path (for upload_file, relative to root)',
            },
          },
          required: ['action'],
        },
      },
    ];
  }

  /**
   * Define Google Drive tools
   */
  private getGoogleDriveToolDefinitions(): LLMTool[] {
    return [
      {
        name: 'google_drive_action',
        description:
          'Use the connected Google Drive account to search, read, and manage files/folders. ' +
          'Write actions (create/upload/delete) require user approval.',
        input_schema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [
                'get_current_user',
                'list_files',
                'get_file',
                'create_folder',
                'upload_file',
                'delete_file',
              ],
              description: 'Action to perform',
            },
            query: {
              type: 'string',
              description: 'Search query (Drive query syntax) for list_files',
            },
            page_size: {
              type: 'number',
              description: 'Max results (for list_files)',
            },
            page_token: {
              type: 'string',
              description: 'Pagination token (for list_files)',
            },
            fields: {
              type: 'string',
              description: 'Fields selector (for list_files/get_file)',
            },
            file_id: {
              type: 'string',
              description: 'File ID (for get_file/delete_file)',
            },
            parent_id: {
              type: 'string',
              description: 'Parent folder ID (for create_folder/upload_file)',
            },
            name: {
              type: 'string',
              description: 'Name for create_folder/upload_file',
            },
            file_path: {
              type: 'string',
              description: 'Workspace-relative path to upload (for upload_file)',
            },
          },
          required: ['action'],
        },
      },
    ];
  }

  /**
   * Define Gmail tools
   */
  private getGmailToolDefinitions(): LLMTool[] {
    return [
      {
        name: 'gmail_action',
        description:
          'Use the connected Gmail account to search, read, and send messages. ' +
          'Write actions (send/trash) require user approval.',
        input_schema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [
                'get_profile',
                'list_messages',
                'get_message',
                'get_thread',
                'list_labels',
                'send_message',
                'trash_message',
              ],
              description: 'Action to perform',
            },
            query: {
              type: 'string',
              description: 'Gmail search query (for list_messages)',
            },
            page_size: {
              type: 'number',
              description: 'Max results (for list_messages)',
            },
            page_token: {
              type: 'string',
              description: 'Pagination token (for list_messages)',
            },
            label_ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'Label IDs filter (for list_messages)',
            },
            include_spam_trash: {
              type: 'boolean',
              description: 'Include spam/trash (for list_messages)',
            },
            message_id: {
              type: 'string',
              description: 'Message ID (for get_message/trash_message)',
            },
            thread_id: {
              type: 'string',
              description: 'Thread ID (for get_thread/send_message)',
            },
            format: {
              type: 'string',
              enum: ['full', 'metadata', 'minimal', 'raw'],
              description: 'Message format (for get_message/get_thread)',
            },
            metadata_headers: {
              type: 'array',
              items: { type: 'string' },
              description: 'Metadata headers to include (for metadata format)',
            },
            to: {
              type: 'string',
              description: 'Recipient email (for send_message)',
            },
            cc: {
              type: 'string',
              description: 'CC recipients (for send_message)',
            },
            bcc: {
              type: 'string',
              description: 'BCC recipients (for send_message)',
            },
            subject: {
              type: 'string',
              description: 'Email subject (for send_message)',
            },
            body: {
              type: 'string',
              description: 'Email body (for send_message)',
            },
            raw: {
              type: 'string',
              description: 'Base64url encoded RFC 2822 message (for send_message)',
            },
          },
          required: ['action'],
        },
      },
    ];
  }

  /**
   * Define Google Calendar tools
   */
  private getGoogleCalendarToolDefinitions(): LLMTool[] {
    return [
      {
        name: 'calendar_action',
        description:
          'Use the connected Google Calendar account to list and manage events. ' +
          'Write actions (create/update/delete) require user approval.',
        input_schema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [
                'list_calendars',
                'list_events',
                'get_event',
                'create_event',
                'update_event',
                'delete_event',
              ],
              description: 'Action to perform',
            },
            calendar_id: {
              type: 'string',
              description: 'Calendar ID (defaults to primary)',
            },
            event_id: {
              type: 'string',
              description: 'Event ID (for get/update/delete)',
            },
            query: {
              type: 'string',
              description: 'Search query (for list_events)',
            },
            time_min: {
              type: 'string',
              description: 'ISO start time (for list_events)',
            },
            time_max: {
              type: 'string',
              description: 'ISO end time (for list_events)',
            },
            max_results: {
              type: 'number',
              description: 'Max results (for list_events)',
            },
            page_token: {
              type: 'string',
              description: 'Pagination token (for list_events)',
            },
            single_events: {
              type: 'boolean',
              description: 'Expand recurring events (for list_events)',
            },
            order_by: {
              type: 'string',
              enum: ['startTime', 'updated'],
              description: 'Order results (for list_events)',
            },
            summary: {
              type: 'string',
              description: 'Event summary (for create/update)',
            },
            description: {
              type: 'string',
              description: 'Event description (for create/update)',
            },
            location: {
              type: 'string',
              description: 'Event location (for create/update)',
            },
            start: {
              type: 'string',
              description: 'Event start ISO time (for create/update)',
            },
            end: {
              type: 'string',
              description: 'Event end ISO time (for create/update)',
            },
            attendees: {
              type: 'array',
              items: { type: 'string' },
              description: 'Attendee emails (for create/update)',
            },
            time_zone: {
              type: 'string',
              description: 'IANA time zone (for create/update)',
            },
            payload: {
              type: 'object',
              description: 'Raw event payload override (for create/update)',
            },
          },
          required: ['action'],
        },
      },
    ];
  }

  /**
   * Define Apple Calendar tools (macOS only)
   */
  private getAppleCalendarToolDefinitions(): LLMTool[] {
    return [
      {
        name: 'apple_calendar_action',
        description:
          'Use the local Apple Calendar app on macOS to list and manage events. ' +
          'Write actions (create/update/delete) require user approval.',
        input_schema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [
                'list_calendars',
                'list_events',
                'get_event',
                'create_event',
                'update_event',
                'delete_event',
              ],
              description: 'Action to perform',
            },
            calendar_id: {
              type: 'string',
              description: 'Calendar identifier (calendarIdentifier) or calendar name (optional; defaults to a writable calendar)',
            },
            event_id: {
              type: 'string',
              description: 'Event UID (for get/update/delete)',
            },
            query: {
              type: 'string',
              description: 'Search query (for list_events; matched against summary/notes/location)',
            },
            time_min: {
              type: 'string',
              description: 'ISO start time (for list_events; default: now)',
            },
            time_max: {
              type: 'string',
              description: 'ISO end time (for list_events; default: now + 7 days)',
            },
            max_results: {
              type: 'number',
              description: 'Max results (for list_events; default: 50, max: 500)',
            },
            summary: {
              type: 'string',
              description: 'Event summary (for create/update)',
            },
            description: {
              type: 'string',
              description: 'Event notes (for create/update)',
            },
            location: {
              type: 'string',
              description: 'Event location (for create/update)',
            },
            start: {
              type: 'string',
              description: 'Event start ISO time (for create/update)',
            },
            end: {
              type: 'string',
              description: 'Event end ISO time (for create/update)',
            },
          },
          required: ['action'],
        },
      },
    ];
  }

  /**
   * Define Apple Reminders tools (macOS only)
   */
  private getAppleRemindersToolDefinitions(): LLMTool[] {
    return [
      {
        name: 'apple_reminders_action',
        description:
          'Use the local Apple Reminders app on macOS to list and manage reminders. ' +
          'Write actions (create/update/complete/delete) require user approval.',
        input_schema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [
                'list_lists',
                'list_reminders',
                'get_reminder',
                'create_reminder',
                'update_reminder',
                'complete_reminder',
                'delete_reminder',
              ],
              description: 'Action to perform',
            },
            list_id: {
              type: 'string',
              description: 'List identifier (id) or list name (optional; defaults to the first list)',
            },
            reminder_id: {
              type: 'string',
              description: 'Reminder identifier (for get/update/complete/delete)',
            },
            query: {
              type: 'string',
              description: 'Search query (for list_reminders; matched against title/notes/list name)',
            },
            include_completed: {
              type: 'boolean',
              description: 'Include completed reminders (for list_reminders; default: false)',
            },
            due_min: {
              type: 'string',
              description: 'ISO start time for due-date filtering (for list_reminders; optional)',
            },
            due_max: {
              type: 'string',
              description: 'ISO end time for due-date filtering (for list_reminders; optional)',
            },
            max_results: {
              type: 'number',
              description: 'Max results (for list_reminders; default: 100, max: 500)',
            },
            title: {
              type: 'string',
              description: 'Reminder title (for create/update)',
            },
            notes: {
              type: 'string',
              description: 'Reminder notes (for create/update)',
            },
            due: {
              type: 'string',
              description: 'ISO due datetime (for create/update)',
            },
          },
          required: ['action'],
        },
      },
    ];
  }

  /**
   * Define Dropbox tools
   */
  private getDropboxToolDefinitions(): LLMTool[] {
    return [
      {
        name: 'dropbox_action',
        description:
          'Use the connected Dropbox account to search, read, and manage files/folders. ' +
          'Write actions (create/upload/delete) require user approval.',
        input_schema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [
                'get_current_user',
                'list_folder',
                'list_folder_continue',
                'search',
                'get_metadata',
                'create_folder',
                'delete_item',
                'upload_file',
              ],
              description: 'Action to perform',
            },
            path: {
              type: 'string',
              description: 'Dropbox path (for list_folder/get_metadata/create_folder/delete_item/upload_file)',
            },
            query: {
              type: 'string',
              description: 'Search query (for search)',
            },
            limit: {
              type: 'number',
              description: 'Max results (for list/search)',
            },
            cursor: {
              type: 'string',
              description: 'Pagination cursor (for list_folder_continue)',
            },
            name: {
              type: 'string',
              description: 'Name for upload_file',
            },
            parent_path: {
              type: 'string',
              description: 'Parent folder path (for upload_file when path not provided)',
            },
            file_path: {
              type: 'string',
              description: 'Workspace-relative path to upload (for upload_file)',
            },
          },
          required: ['action'],
        },
      },
    ];
  }

  /**
   * Define SharePoint tools
   */
  private getSharePointToolDefinitions(): LLMTool[] {
    return [
      {
        name: 'sharepoint_action',
        description:
          'Use the connected SharePoint account to search sites and manage drive items. ' +
          'Write actions (create/upload/delete) require user approval.',
        input_schema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [
                'get_current_user',
                'search_sites',
                'get_site',
                'list_site_drives',
                'list_drive_items',
                'get_item',
                'create_folder',
                'upload_file',
                'delete_item',
              ],
              description: 'Action to perform',
            },
            site_id: {
              type: 'string',
              description: 'Site ID (for get_site/list_site_drives)',
            },
            drive_id: {
              type: 'string',
              description: 'Drive ID (for list/get/create/upload/delete)',
            },
            item_id: {
              type: 'string',
              description: 'Item ID (for list_drive_items/get_item/delete_item)',
            },
            query: {
              type: 'string',
              description: 'Search query (for search_sites)',
            },
            parent_id: {
              type: 'string',
              description: 'Parent folder ID (for create_folder/upload_file)',
            },
            name: {
              type: 'string',
              description: 'Name for create_folder/upload_file',
            },
            conflict_behavior: {
              type: 'string',
              enum: ['rename', 'fail', 'replace'],
              description: 'Conflict behavior for create_folder',
            },
            file_path: {
              type: 'string',
              description: 'Workspace-relative path to upload (for upload_file)',
            },
            remote_path: {
              type: 'string',
              description: 'Remote path (for upload_file, relative to root)',
            },
          },
          required: ['action'],
        },
      },
    ];
  }

  /**
   * Define voice call tools (outbound phone calls)
   */
  private getVoiceCallToolDefinitions(): LLMTool[] {
    return [
      {
        name: 'voice_call',
        description:
          'Initiate an outbound phone call via ElevenLabs Agents + Twilio integration. ' +
          'Placing a call requires user approval. You can also list configured agents and phone numbers.',
        input_schema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['list_agents', 'list_phone_numbers', 'initiate_call'],
              description: 'Action to perform',
            },
            to_number: {
              type: 'string',
              description: 'Destination phone number in E.164 format (e.g., "+15555550123")',
            },
            agent_id: {
              type: 'string',
              description:
                'ElevenLabs Agent ID. Optional if you set a default Agent ID in Settings > Voice > Phone Calls.',
            },
            agent_phone_number_id: {
              type: 'string',
              description:
                'ElevenLabs agent phone number ID to use for outbound calls. Optional if configured in Settings > Voice > Phone Calls.',
            },
            dynamic_variables: {
              type: 'object',
              description:
                'Dynamic variables to pass into the call. These can be referenced by the agent configuration.',
              additionalProperties: true,
            },
            conversation_config_override: {
              type: 'object',
              description:
                'Optional per-call conversation config override object (advanced).',
              additionalProperties: true,
            },
            prompt: {
              type: 'string',
              description:
                'Convenience: set conversation_config_override.agent.prompt.prompt for this call (advanced).',
            },
            first_message: {
              type: 'string',
              description:
                'Convenience: set conversation_config_override.agent.first_message for this call (advanced).',
            },
            conversation_initiation_client_data: {
              type: 'object',
              description:
                'Advanced: pass the full conversation initiation client data object. If provided, it overrides dynamic_variables/prompt/first_message/conversation_config_override.',
              additionalProperties: true,
            },
            cursor: {
              type: 'string',
              description: 'Pagination cursor (for list actions)',
            },
            page_size: {
              type: 'number',
              description: 'Page size (for list actions)',
            },
            include_archived: {
              type: 'boolean',
              description: 'Include archived entries (for list actions)',
            },
          },
          required: ['action'],
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

  private async integrationSetup(input: {
    action?: string;
    provider?: string;
    api_key?: string;
    webhook_secret?: string;
    base_url?: string;
    enable_inbound?: boolean;
    connect_now?: boolean;
    allow_unsafe_external_content?: boolean;
  }): Promise<{
    success: boolean;
    action: 'inspect' | 'configure';
    provider: 'resend';
    installed: boolean;
    configured: boolean;
    connected: boolean;
    email_sending_ready: boolean;
    inbound: {
      requested: boolean;
      hooks_enabled: boolean;
      preset_enabled: boolean;
      endpoint_path: string;
      token_configured: boolean;
      signing_secret_configured: boolean;
    };
    missing_inputs: Array<{
      field: 'api_key';
      label: string;
      prompt: string;
      create_url: string;
      docs_url: string;
    }>;
    links: {
      dashboard: string;
      create_api_key: string;
      api_keys_docs: string;
      webhooks_docs: string;
    };
    message: string;
    notes?: string[];
    connection_error?: string;
    health_error?: string;
    health_text?: string;
    server_id?: string;
  }> {
    const action: 'inspect' | 'configure' = input?.action === 'configure' ? 'configure' : 'inspect';
    const provider = (input?.provider || 'resend').trim().toLowerCase();
    if (provider !== 'resend') {
      throw new Error(`Unsupported provider: ${provider}. Currently supported: resend`);
    }

    const links = this.getResendSetupLinks();
    const enableInbound = Boolean(input?.enable_inbound);
    const connectNow = input?.connect_now !== false;
    const mcpClient = MCPClientManager.getInstance();
    const providedApiKey = typeof input?.api_key === 'string' ? input.api_key.trim() : '';
    const providedBaseUrl = typeof input?.base_url === 'string' ? input.base_url.trim() : '';
    const providedWebhookSecret =
      typeof input?.webhook_secret === 'string' ? input.webhook_secret.trim() : undefined;

    MCPSettingsManager.initialize();

    let settings = MCPSettingsManager.loadSettings();
    let server = this.findResendConnectorServer(settings);
    let installError: string | undefined;
    let installedNow = false;

    if (action === 'configure' && !server) {
      try {
        await MCPRegistryManager.installServer('resend');
        installedNow = true;
      } catch (error: any) {
        const message = error?.message || String(error);
        if (!/already installed/i.test(message)) {
          installError = message;
        }
      }

      settings = MCPSettingsManager.loadSettings();
      server = this.findResendConnectorServer(settings);
    }

    const existingApiKey = server?.env?.RESEND_API_KEY?.trim() || '';
    const resolvedApiKey = providedApiKey || existingApiKey;
    const resolvedBaseUrl = providedBaseUrl || server?.env?.RESEND_BASE_URL?.trim() || 'https://api.resend.com';

    const missingInputs: Array<{
      field: 'api_key';
      label: string;
      prompt: string;
      create_url: string;
      docs_url: string;
    }> = [];
    if (!resolvedApiKey) {
      missingInputs.push({
        field: 'api_key',
        label: 'Resend API key',
        prompt: 'Provide your Resend API key (starts with re_) so I can finish setup.',
        create_url: links.create_api_key,
        docs_url: links.api_keys_docs,
      });
    }

    if (action === 'inspect') {
      let connected = false;
      let serverId: string | undefined;
      if (server) {
        serverId = server.id;
        try {
          connected = mcpClient.getServerStatus(server.id)?.status === 'connected';
        } catch {
          connected = false;
        }
      }

      HooksSettingsManager.initialize();
      const hooks = HooksSettingsManager.loadSettings();
      return {
        success: true,
        action,
        provider: 'resend',
        installed: Boolean(server),
        configured: Boolean(resolvedApiKey),
        connected,
        email_sending_ready: Boolean(server && resolvedApiKey && connected),
        inbound: {
          requested: false,
          hooks_enabled: hooks.enabled,
          preset_enabled: hooks.presets.includes('resend'),
          endpoint_path: `${hooks.path || '/hooks'}/resend`,
          token_configured: Boolean(hooks.token),
          signing_secret_configured: Boolean(hooks.resend?.webhookSecret),
        },
        missing_inputs: missingInputs,
        links,
        server_id: serverId,
        message: server
          ? (resolvedApiKey
            ? 'Resend connector is installed. Provide missing values or ask to configure/connect if needed.'
            : 'Resend connector is installed but API key is missing.')
          : 'Resend connector is not installed yet.',
        notes: [
          'Use action="configure" with api_key to enable email sending.',
          'If you also want inbound email automation, set enable_inbound=true (webhook signing secret is recommended).',
        ],
      };
    }

    if (!server) {
      return {
        success: false,
        action,
        provider: 'resend',
        installed: false,
        configured: false,
        connected: false,
        email_sending_ready: false,
        inbound: {
          requested: enableInbound,
          hooks_enabled: false,
          preset_enabled: false,
          endpoint_path: '/hooks/resend',
          token_configured: false,
          signing_secret_configured: false,
        },
        missing_inputs: missingInputs,
        links,
        message: 'Could not install or locate the Resend connector.',
        notes: installError ? [installError] : undefined,
      };
    }

    const env: Record<string, string> = {
      ...(server.env || {}),
      RESEND_BASE_URL: resolvedBaseUrl,
    };
    if (resolvedApiKey) {
      env.RESEND_API_KEY = resolvedApiKey;
    }

    const updated = MCPSettingsManager.updateServer(server.id, {
      env,
      enabled: Boolean(resolvedApiKey),
    });
    if (!updated) {
      throw new Error(`Failed to update Resend connector settings for server ${server.id}`);
    }

    let connected = false;
    try {
      connected = mcpClient.getServerStatus(server.id)?.status === 'connected';
    } catch {
      connected = false;
    }

    let connectionError: string | undefined;
    if (connectNow && resolvedApiKey && !connected) {
      try {
        await mcpClient.connectServer(server.id);
        connected = true;
      } catch (error: any) {
        connectionError = error?.message || String(error);
        try {
          connected = mcpClient.getServerStatus(server.id)?.status === 'connected';
          if (connected) {
            connectionError = undefined;
          }
        } catch {
          connected = false;
        }
      }
    }

    let healthError: string | undefined;
    let healthText: string | undefined;
    if (connected) {
      try {
        const health = await mcpClient.callTool('resend.health', {});
        healthText = this.extractMcpTextContent(health) || undefined;
        if (health?.isError) {
          healthError = healthText || 'Connector health call returned an error';
        }
      } catch (error: any) {
        healthError = error?.message || String(error);
      }
    }

    let hooksEnabled = false;
    let presetEnabled = false;
    let hookPath = '/hooks/resend';
    let hookTokenConfigured = false;
    let hookSigningSecretConfigured = false;

    if (enableInbound) {
      HooksSettingsManager.initialize();
      let hooks = HooksSettingsManager.loadSettings();

      if (!hooks.enabled) {
        hooks = HooksSettingsManager.enableHooks();
      }

      const nextPresets = new Set(hooks.presets || []);
      nextPresets.add('resend');

      let nextWebhookSecret = hooks.resend?.webhookSecret;
      if (providedWebhookSecret !== undefined) {
        nextWebhookSecret = providedWebhookSecret || undefined;
      }

      hooks = HooksSettingsManager.updateConfig({
        ...hooks,
        presets: Array.from(nextPresets),
        resend: {
          ...hooks.resend,
          webhookSecret: nextWebhookSecret,
          allowUnsafeExternalContent:
            typeof input.allow_unsafe_external_content === 'boolean'
              ? input.allow_unsafe_external_content
              : hooks.resend?.allowUnsafeExternalContent,
        },
      });

      hooksEnabled = hooks.enabled;
      presetEnabled = hooks.presets.includes('resend');
      hookPath = `${hooks.path || '/hooks'}/resend`;
      hookTokenConfigured = Boolean(hooks.token);
      hookSigningSecretConfigured = Boolean(hooks.resend?.webhookSecret);
    } else {
      HooksSettingsManager.initialize();
      const hooks = HooksSettingsManager.loadSettings();
      hooksEnabled = hooks.enabled;
      presetEnabled = hooks.presets.includes('resend');
      hookPath = `${hooks.path || '/hooks'}/resend`;
      hookTokenConfigured = Boolean(hooks.token);
      hookSigningSecretConfigured = Boolean(hooks.resend?.webhookSecret);
    }

    const emailSendingReady = Boolean(resolvedApiKey && connected && !healthError);
    const notes: string[] = [];
    if (installedNow) notes.push('Installed Resend connector.');
    if (enableInbound) {
      notes.push(
        `Inbound endpoint configured at ${hookPath}. Use your hooks token with this URL when registering webhook endpoints.`,
      );
      if (!hookSigningSecretConfigured) {
        notes.push(
          'Webhook signing secret is recommended. You can set it with webhook_secret in a follow-up configure call.',
        );
      }
    }
    if (!resolvedApiKey) {
      notes.push('API key is still missing. Provide api_key and run configure again.');
    }

    return {
      success: emailSendingReady && (enableInbound ? presetEnabled : true),
      action,
      provider: 'resend',
      installed: true,
      configured: Boolean(resolvedApiKey),
      connected,
      email_sending_ready: emailSendingReady,
      inbound: {
        requested: enableInbound,
        hooks_enabled: hooksEnabled,
        preset_enabled: presetEnabled,
        endpoint_path: hookPath,
        token_configured: hookTokenConfigured,
        signing_secret_configured: hookSigningSecretConfigured,
      },
      missing_inputs: missingInputs,
      links,
      server_id: server.id,
      connection_error: connectionError,
      health_error: healthError,
      health_text: healthText,
      message: emailSendingReady
        ? 'Resend email sending is configured and healthy.'
        : (resolvedApiKey
          ? 'Resend connector is configured, but connection/health still needs attention.'
          : 'Resend connector is installed; API key is required to finish setup.'),
      notes: notes.length > 0 ? notes : undefined,
    };
  }

  private getResendSetupLinks(): {
    dashboard: string;
    create_api_key: string;
    api_keys_docs: string;
    webhooks_docs: string;
  } {
    return {
      dashboard: 'https://resend.com/dashboard',
      create_api_key: 'https://resend.com/api-keys',
      api_keys_docs: 'https://resend.com/docs/dashboard/api-keys/introduction',
      webhooks_docs: 'https://resend.com/docs/dashboard/webhooks/introduction',
    };
  }

  private findResendConnectorServer(settings: { servers: MCPServerConfig[] }): MCPServerConfig | undefined {
    return settings.servers.find((server) => {
      const lowerName = (server.name || '').toLowerCase();
      if (lowerName === 'resend' || lowerName.includes('resend')) return true;

      const command = (server.command || '').toLowerCase();
      if (command.includes('resend')) return true;

      const args = (server.args || []).map((arg) => String(arg).toLowerCase());
      return args.some((arg) => arg.includes('resend-mcp') || arg.includes('/connectors/resend'));
    });
  }

  private extractMcpTextContent(result: any): string {
    const content = Array.isArray(result?.content) ? result.content : [];
    const texts = content
      .filter((item: any) => item && item.type === 'text' && typeof item.text === 'string')
      .map((item: any) => item.text);
    return texts.join('\n').trim();
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
    const validIds: PersonaId[] = ['none', 'jarvis', 'friday', 'hal', 'computer', 'alfred', 'intern', 'sensei', 'pirate', 'noir', 'companion'];

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

  private async resolveDescendantTask(taskIdInput: unknown): Promise<
    | { ok: true; taskId: string; task: Task }
    | { ok: false; taskId?: string; error: 'TASK_ID_REQUIRED' | 'TASK_NOT_FOUND' | 'FORBIDDEN'; message: string }
  > {
    const taskId = typeof taskIdInput === 'string' ? taskIdInput.trim() : '';
    if (!taskId) {
      return { ok: false, error: 'TASK_ID_REQUIRED', message: 'task_id is required' };
    }
    if (taskId === this.taskId) {
      return { ok: false, taskId, error: 'FORBIDDEN', message: 'task_id must refer to a child task (not the current task)' };
    }

    const task = await this.daemon.getTaskById(taskId);
    if (!task) {
      return { ok: false, taskId, error: 'TASK_NOT_FOUND', message: `Task ${taskId} not found` };
    }

    // Walk parent chain to ensure the target task is a descendant of the current task.
    // Depth is already bounded elsewhere, but keep a hard guard to avoid cycles.
    let cursor: Task | undefined = task;
    for (let i = 0; i < 20; i++) {
      const parentId = cursor.parentTaskId;
      if (!parentId) break;
      if (parentId === this.taskId) {
        return { ok: true, taskId, task };
      }
      cursor = await this.daemon.getTaskById(parentId);
      if (!cursor) break;
    }

    return { ok: false, taskId, error: 'FORBIDDEN', message: `Task ${taskId} is not a child of the current task` };
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
    const modelPref = typeof model_preference === 'string' ? model_preference.trim().toLowerCase() : '';
    const personalityPref = typeof personality === 'string' ? personality.trim().toLowerCase() : '';

    // Default behavior for tool-spawned sub-agents: cheaper model + concise personality,
    // unless the caller explicitly asks to inherit ("same").
    const modelKey = modelPref === 'same' ? undefined : (resolveModelPreferenceToModelKey(model_preference) ?? 'haiku-4-5');
    const personalityId: PersonalityId | undefined = personalityPref === 'same'
      ? undefined
      : (resolvePersonalityPreference(personality) ?? 'concise');

    // Build agent config
    const agentConfig: AgentConfig = {
      maxTurns: max_turns,
      retainMemory: false, // Sub-agents don't retain memory
    };

    if (modelKey) agentConfig.modelKey = modelKey;
    if (personalityId) agentConfig.personalityId = personalityId;

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
    const resolved = await this.resolveDescendantTask(taskId);
    if (!resolved.ok) {
      return {
        success: false,
        status: resolved.error === 'TASK_NOT_FOUND' ? 'not_found' : 'forbidden',
        message: resolved.message,
        error: resolved.error,
      };
    }

    const resolvedTaskId = resolved.taskId;

    const timeoutMs = timeoutSeconds * 1000;
    const startTime = Date.now();
    const pollInterval = 1000; // Check every second

    while (Date.now() - startTime < timeoutMs) {
      const task = await this.daemon.getTaskById(resolvedTaskId);

      if (!task) {
        return {
          success: false,
          status: 'not_found',
          message: `Task ${resolvedTaskId} not found`,
          error: 'TASK_NOT_FOUND',
        };
      }

      // Check if task is complete
      if (['completed', 'failed', 'cancelled'].includes(task.status)) {
        const isSuccess = task.status === 'completed';

        // Log result event to parent
        this.daemon.logEvent(this.taskId, isSuccess ? 'agent_completed' : 'agent_failed', {
          childTaskId: resolvedTaskId,
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
	          error: typeof task.error === 'string' ? task.error : undefined,
	        };
	      }

      // Wait before polling again
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    // Timeout reached
    return {
      success: false,
      status: 'timeout',
      message: `Timeout waiting for agent ${resolvedTaskId} (${timeoutSeconds}s)`,
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

	    let tasks: Task[] = [];
	    const rejected: Array<{
	      task_id: string;
	      status: string;
	      error?: string;
	    }> = [];

	    if (task_ids && task_ids.length > 0) {
	      // Get specific tasks (restricted to descendants only)
	      for (const id of task_ids) {
	        const resolved = await this.resolveDescendantTask(id);
	        if (!resolved.ok) {
	          const taskId = resolved.taskId || (typeof id === 'string' ? id : String(id));
	          rejected.push({
	            task_id: taskId,
	            status: resolved.error === 'TASK_NOT_FOUND' ? 'not_found' : 'forbidden',
	            error: resolved.message,
	          });
	          continue;
	        }
	        tasks.push(resolved.task);
	      }
	    } else {
	      // Get all child tasks of current task
	      tasks = await this.daemon.getChildTasks(this.taskId);
	    }

		    const agents = [
		      ...tasks.map((task) => ({
		        task_id: task.id,
		        title: task.title,
		        status: task.status,
		        agent_type: task.agentType || 'main',
		        model_key: task.agentConfig?.modelKey,
		        result_summary: task.resultSummary,
		        error: typeof task.error === 'string' ? task.error : undefined,
		        created_at: task.createdAt,
		        completed_at: task.completedAt,
		      })),
	      ...rejected.map((item) => ({
	        task_id: item.task_id,
	        title: '(unavailable)',
	        status: item.status,
	        agent_type: 'unknown',
	        error: item.error,
	        created_at: 0,
	      })),
	    ];

	    return {
	      agents,
	      message: `Found ${tasks.length} agent(s)${rejected.length > 0 ? ` (${rejected.length} rejected)` : ''}`,
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

  private truncateForSummary(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars) + '...';
  }

  private summarizeAgentEvent(event: TaskEvent): { timestamp: number; type: string; summary: string } {
    const payload = event.payload ?? {};
    const maxChars = 900;

    const toolName = typeof payload?.tool === 'string'
      ? payload.tool
      : (typeof payload?.name === 'string' ? payload.name : '');

    switch (event.type) {
      case 'assistant_message': {
        const content =
          (typeof payload?.content === 'string' && payload.content) ||
          (typeof payload?.message === 'string' && payload.message) ||
          '';
        return { timestamp: event.timestamp, type: event.type, summary: this.truncateForSummary(content || '[assistant_message]', maxChars) };
      }
      case 'tool_call': {
        return { timestamp: event.timestamp, type: event.type, summary: toolName ? `tool_call ${toolName}` : 'tool_call' };
      }
      case 'tool_result': {
        const raw =
          typeof payload?.result === 'string'
            ? payload.result
            : (payload?.result ? JSON.stringify(payload.result) : '');
        const summary = toolName ? `tool_result ${toolName}: ${raw}` : `tool_result: ${raw}`;
        return { timestamp: event.timestamp, type: event.type, summary: this.truncateForSummary(summary, maxChars) };
      }
      case 'tool_error': {
        const error = typeof payload?.error === 'string' ? payload.error : '';
        const summary = toolName ? `tool_error ${toolName}: ${error}` : `tool_error: ${error}`;
        return { timestamp: event.timestamp, type: event.type, summary: this.truncateForSummary(summary, maxChars) };
      }
      case 'file_created':
      case 'file_modified':
      case 'file_deleted': {
        const pathValue = typeof payload?.path === 'string' ? payload.path : '';
        return {
          timestamp: event.timestamp,
          type: event.type,
          summary: pathValue ? `${event.type}: ${pathValue}` : event.type,
        };
      }
      case 'step_started':
      case 'step_completed':
      case 'step_failed': {
        const desc = typeof payload?.step?.description === 'string' ? payload.step.description : '';
        const err = typeof payload?.error === 'string' ? payload.error : '';
        const suffix = err ? ` (${err})` : '';
        return {
          timestamp: event.timestamp,
          type: event.type,
          summary: this.truncateForSummary(desc ? `${event.type}: ${desc}${suffix}` : `${event.type}${suffix}`, maxChars),
        };
      }
      case 'error': {
        const error = typeof payload?.error === 'string' ? payload.error : '';
        return { timestamp: event.timestamp, type: event.type, summary: this.truncateForSummary(error ? `error: ${error}` : 'error', maxChars) };
      }
      default: {
        let raw = '';
        try {
          raw = JSON.stringify(payload);
        } catch {
          raw = String(payload);
        }
        return { timestamp: event.timestamp, type: event.type, summary: this.truncateForSummary(raw || event.type, maxChars) };
      }
    }
  }

  private async sendAgentMessage(input: { task_id: unknown; message: unknown }): Promise<{
    success: boolean;
    task_id?: string;
    message: string;
    error?: string;
  }> {
    const resolved = await this.resolveDescendantTask(input?.task_id);
    if (!resolved.ok) {
      return { success: false, task_id: resolved.taskId, message: resolved.message, error: resolved.error };
    }

    const message = typeof input?.message === 'string' ? input.message.trim() : '';
    if (!message) {
      return { success: false, task_id: resolved.taskId, message: 'message is required', error: 'MESSAGE_REQUIRED' };
    }

    await this.daemon.sendMessage(resolved.taskId, message);
    return { success: true, task_id: resolved.taskId, message: 'Message sent' };
  }

  private async captureAgentEvents(input: { task_id: unknown; limit?: unknown; types?: unknown }): Promise<{
    success: boolean;
    task_id?: string;
    events?: Array<{ timestamp: number; type: string; summary: string }>;
    message: string;
    error?: string;
  }> {
    const resolved = await this.resolveDescendantTask(input?.task_id);
    if (!resolved.ok) {
      return { success: false, task_id: resolved.taskId, message: resolved.message, error: resolved.error };
    }

    const limit = typeof input?.limit === 'number' && Number.isFinite(input.limit)
      ? Math.min(Math.max(input.limit, 1), 100)
      : 30;

    const requestedTypes = Array.isArray(input?.types)
      ? input.types.filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter(Boolean)
      : undefined;

    // Exclude tool_result by default — it echoes full tool output and can
    // be very large. Callers can explicitly request it via the types param.
    const defaultTypes: string[] = [
      'assistant_message',
      'tool_call',
      'tool_error',
      'error',
      'log',
      'file_created',
      'file_modified',
      'file_deleted',
      'sub_agent_result',
    ];

    const types = (requestedTypes && requestedTypes.length > 0) ? requestedTypes : defaultTypes;
    const events = this.daemon.getTaskEvents(resolved.taskId, { limit, types });
    const summarized = events.map((event) => this.summarizeAgentEvent(event));

    return {
      success: true,
      task_id: resolved.taskId,
      events: summarized,
      message: `Captured ${summarized.length} event(s)`,
    };
  }

  private async cancelAgent(input: { task_id: unknown }): Promise<{
    success: boolean;
    task_id?: string;
    message: string;
    error?: string;
  }> {
    const resolved = await this.resolveDescendantTask(input?.task_id);
    if (!resolved.ok) {
      return { success: false, task_id: resolved.taskId, message: resolved.message, error: resolved.error };
    }

    if (['completed', 'failed', 'cancelled'].includes(resolved.task.status)) {
      return { success: false, task_id: resolved.taskId, message: `Task is already ${resolved.task.status}`, error: 'TASK_ALREADY_FINISHED' };
    }

    await this.daemon.cancelTask(resolved.taskId);
    // Ensure DB status reflects the cancellation even when called outside renderer IPC.
    this.daemon.updateTask(resolved.taskId, { status: 'cancelled', completedAt: Date.now() });

    return { success: true, task_id: resolved.taskId, message: 'Task cancelled' };
  }

  private async pauseAgent(input: { task_id: unknown }): Promise<{
    success: boolean;
    task_id?: string;
    message: string;
    error?: string;
  }> {
    const resolved = await this.resolveDescendantTask(input?.task_id);
    if (!resolved.ok) {
      return { success: false, task_id: resolved.taskId, message: resolved.message, error: resolved.error };
    }

    if (!['planning', 'executing'].includes(resolved.task.status)) {
      return { success: false, task_id: resolved.taskId, message: `Cannot pause task in status "${resolved.task.status}"`, error: 'TASK_NOT_RUNNING' };
    }

    await this.daemon.pauseTask(resolved.taskId);
    this.daemon.updateTaskStatus(resolved.taskId, 'paused');
    this.daemon.logEvent(resolved.taskId, 'task_paused', { message: 'Task paused by parent agent', parentTaskId: this.taskId });

    return { success: true, task_id: resolved.taskId, message: 'Task paused' };
  }

  private async resumeAgent(input: { task_id: unknown }): Promise<{
    success: boolean;
    task_id?: string;
    message: string;
    error?: string;
  }> {
    const resolved = await this.resolveDescendantTask(input?.task_id);
    if (!resolved.ok) {
      return { success: false, task_id: resolved.taskId, message: resolved.message, error: resolved.error };
    }

    if (resolved.task.status !== 'paused') {
      return { success: false, task_id: resolved.taskId, message: `Cannot resume task in status "${resolved.task.status}"`, error: 'TASK_NOT_PAUSED' };
    }

    const resumed = await this.daemon.resumeTask(resolved.taskId);
    if (!resumed) {
      return { success: false, task_id: resolved.taskId, message: 'Task has no active executor — it may need to be re-queued', error: 'NO_EXECUTOR' };
    }

    const refreshed = await this.daemon.getTaskById(resolved.taskId);
    if (refreshed && refreshed.status !== 'executing') {
      this.daemon.updateTaskStatus(resolved.taskId, 'executing');
      this.daemon.logEvent(resolved.taskId, 'task_resumed', { message: 'Task resumed by parent agent', parentTaskId: this.taskId });
    }

    return { success: true, task_id: resolved.taskId, message: 'Task resumed' };
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
        name: 'integration_setup',
        description:
          'Inspect or configure integrations directly from chat. ' +
          'Use this when the user asks to enable email sending or connect Resend. ' +
          'If credentials are missing, this tool returns required inputs and direct setup links.',
        input_schema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['inspect', 'configure'],
              description: 'inspect = show readiness/missing inputs, configure = apply settings',
            },
            provider: {
              type: 'string',
              enum: ['resend'],
              description: 'Integration provider to configure',
            },
            api_key: {
              type: 'string',
              description: 'Provider API key (for Resend, starts with re_)',
            },
            base_url: {
              type: 'string',
              description: 'Optional API base URL override (default: https://api.resend.com)',
            },
            connect_now: {
              type: 'boolean',
              description: 'Whether to connect/test immediately after configuration (default: true)',
            },
            enable_inbound: {
              type: 'boolean',
              description: 'Enable inbound webhook preset configuration (/hooks/resend)',
            },
            webhook_secret: {
              type: 'string',
              description:
                'Optional webhook signing secret for inbound verification (Resend Svix secret, usually starts with whsec_)',
            },
            allow_unsafe_external_content: {
              type: 'boolean',
              description: 'Set allowUnsafeExternalContent for inbound mapped tasks',
            },
          },
        },
      },
      {
        name: 'task_history',
        description:
          'Query your recent task history and messages from the local database. ' +
          'Use this to answer questions like "What did we talk about yesterday?", ' +
          '"Show me my last 10 tasks", or "What did I ask earlier today?".',
        input_schema: {
          type: 'object',
          properties: {
            period: {
              type: 'string',
              enum: ['today', 'yesterday', 'last_7_days', 'last_30_days', 'custom'],
              description: 'Time period to query',
            },
            from: {
              type: 'string',
              description:
                'For custom: start time as ISO string (e.g., "2026-02-06T00:00:00Z"). If omitted, defaults are used.',
            },
            to: {
              type: 'string',
              description:
                'For custom: end time as ISO string (e.g., "2026-02-07T00:00:00Z"). If omitted, defaults are used.',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of tasks to return (1-50). Default: 20',
            },
            workspace_id: {
              type: 'string',
              description: 'Optional workspace ID to restrict results to',
            },
            query: {
              type: 'string',
              description: 'Optional substring filter applied to task title and prompt',
            },
            include_messages: {
              type: 'boolean',
              description: 'Include last user/assistant message per task (default: true)',
            },
          },
          required: ['period'],
        },
      },
      {
        name: 'task_events',
        description:
          'Query task event logs (tool calls, tool results, assistant/user messages, feedback, file ops) from the local database. ' +
          'Use this to build accurate digests and stats without scraping filesystem logs.',
        input_schema: {
          type: 'object',
          properties: {
            period: {
              type: 'string',
              enum: ['today', 'yesterday', 'last_7_days', 'last_30_days', 'custom'],
              description: 'Time period to query',
            },
            from: {
              type: 'string',
              description:
                'For custom: start time as ISO string (e.g., "2026-02-06T00:00:00Z"). If omitted, defaults are used.',
            },
            to: {
              type: 'string',
              description:
                'For custom: end time as ISO string (e.g., "2026-02-07T00:00:00Z"). If omitted, defaults are used.',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of events to return (1-500). Default: 200',
            },
            workspace_id: {
              type: 'string',
              description: 'Optional workspace ID to restrict results to',
            },
            types: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional list of event types to include (e.g., ["tool_call","user_feedback"])',
            },
            include_payload: {
              type: 'boolean',
              description: 'Include a compact payload preview for each event (default: true)',
            },
          },
          required: ['period'],
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
          'pirate (swashbuckling adventurer), noir (1940s detective), companion (warm, thoughtful presence). ' +
          'Use "none" to remove persona overlay.',
        input_schema: {
          type: 'object',
          properties: {
            persona: {
              type: 'string',
              enum: ['none', 'jarvis', 'friday', 'hal', 'computer', 'alfred', 'intern', 'sensei', 'pirate', 'noir', 'companion'],
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
      {
        name: 'send_agent_message',
        description:
          'Send a follow-up message to a descendant child agent task. Use this to clarify instructions, provide missing ' +
          'context, or steer a running sub-agent. This tool only works for tasks spawned by the current task (descendants).',
        input_schema: {
          type: 'object',
          properties: {
            task_id: {
              type: 'string',
              description: 'The descendant child task ID',
            },
            message: {
              type: 'string',
              description: 'The message to send to the child task',
            },
          },
          required: ['task_id', 'message'],
        },
      },
      {
        name: 'capture_agent_events',
        description:
          'Capture recent events/output from a descendant child agent task. Returns a compact, summarized event list. ' +
          'This tool only works for tasks spawned by the current task (descendants).',
        input_schema: {
          type: 'object',
          properties: {
            task_id: {
              type: 'string',
              description: 'The descendant child task ID',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of recent events to return (default: 30, max: 100)',
            },
            types: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional list of event types to include (defaults to a safe, high-signal subset)',
            },
          },
          required: ['task_id'],
        },
      },
      {
        name: 'cancel_agent',
        description:
          'Cancel a descendant child agent task. This tool only works for tasks spawned by the current task (descendants).',
        input_schema: {
          type: 'object',
          properties: {
            task_id: {
              type: 'string',
              description: 'The descendant child task ID',
            },
          },
          required: ['task_id'],
        },
      },
      {
        name: 'pause_agent',
        description:
          'Pause a running descendant child agent task. This tool only works for tasks spawned by the current task (descendants).',
        input_schema: {
          type: 'object',
          properties: {
            task_id: {
              type: 'string',
              description: 'The descendant child task ID',
            },
          },
          required: ['task_id'],
        },
      },
      {
        name: 'resume_agent',
        description:
          'Resume a paused descendant child agent task. This tool only works for tasks spawned by the current task (descendants).',
        input_schema: {
          type: 'object',
          properties: {
            task_id: {
              type: 'string',
              description: 'The descendant child task ID',
            },
          },
          required: ['task_id'],
        },
      },
    ];
  }
}
