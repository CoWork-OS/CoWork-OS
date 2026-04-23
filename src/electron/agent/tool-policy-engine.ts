import {
  ConversationMode,
  ExecutionMode,
  TaskDomain,
  ToolDecision,
  type RuntimeToolMetadata,
} from "../../shared/types";
import { isComputerUseToolName } from "../../shared/computer-use-contract";

export type ToolLane =
  | "core"
  | "code"
  | "research"
  | "browser"
  | "integration"
  | "artifact"
  | "memory"
  | "system"
  | "admin"
  | "orchestration";

export type ToolExposure = "always" | "conditional" | "explicit_only";

export interface ToolExposureMetadata {
  lane: ToolLane;
  exposure: ToolExposure;
  overlapGroup?: string;
}

export interface ToolAvailabilityContext extends ToolPolicyContext {
  taskText?: string;
  recentlyUsedTools?: Iterable<string>;
  requiredTools?: Iterable<string>;
}

export interface ToolAvailabilityResult {
  decision: "allow" | "defer";
  reason?: string;
  metadata: ToolExposureMetadata;
}

export interface ToolPolicyContext {
  executionMode?: ExecutionMode;
  taskDomain?: TaskDomain;
  conversationMode?: ConversationMode;
  taskIntent?: string;
  shellEnabled?: boolean;
}

export interface ToolPolicyResult {
  decision: ToolDecision;
  reason?: string;
  mode: ExecutionMode;
  domain: TaskDomain;
}

export interface BlockedTool {
  name: string;
  decision: ToolDecision;
  reason?: string;
}

const EXPLICIT_ONLY_TOOLS = new Set([
  "set_personality",
  "set_persona",
  "set_agent_name",
  "set_user_name",
  "set_response_style",
  "set_quirks",
  "set_vibes",
  "update_lore",
  "manage_heartbeat",
  "integration_setup",
]);

const ORCHESTRATION_TOOLS = new Set([
  "spawn_agent",
  "orchestrate_agents",
  "wait_for_agent",
  "get_agent_status",
  "get_orchestration_status",
  "list_agents",
  "send_agent_message",
  "capture_agent_events",
  "cancel_agent",
  "pause_agent",
  "resume_agent",
]);

const INTEGRATION_TOOLS = new Set([
  "x_action",
  "notion_action",
  "box_action",
  "onedrive_action",
  "google_drive_action",
  "gmail_action",
  "mailbox_action",
  "calendar_action",
  "apple_calendar_action",
  "apple_reminders_action",
  "dropbox_action",
  "sharepoint_action",
  "voice_call",
]);

const ARTIFACT_TOOLS = new Set([
  "create_document",
  "generate_document",
  "compile_latex",
  "create_spreadsheet",
  "generate_spreadsheet",
  "create_presentation",
  "generate_presentation",
  "edit_document",
  "create_diagram",
  "generate_image",
  "analyze_image",
  "read_pdf_visual",
  "parse_document",
  // Video generation tools
  "generate_video",
  "get_video_generation_job",
  "cancel_video_generation_job",
]);

const CONDITIONAL_SYSTEM_TOOLS = new Set([
  "read_clipboard",
  "write_clipboard",
  "take_screenshot",
  "open_application",
  "open_url",
  "open_path",
  "show_in_folder",
  "get_env",
  "get_app_paths",
  "run_applescript",
  "screen_context_resolve",
]);

const ALWAYS_VISIBLE_TOOLS = new Set([
  "read_file",
  "read_files",
  "write_file",
  "edit_file",
  "copy_file",
  "list_directory",
  "get_file_info",
  "search_files",
  "create_directory",
  "rename_file",
  "delete_file",
  "glob",
  "grep",
  "count_text",
  "text_metrics",
  "run_command",
  "web_fetch",
  "web_search",
  "http_request",
  "revise_plan",
  "request_user_input",
  "task_history",
  "scratchpad_write",
  "scratchpad_read",
  "search_memories",
  "search_quotes",
  "search_sessions",
  "memory_topics_load",
  "memory_save",
  "memory_curate",
  "memory_curated_read",
  "supermemory_profile",
  "supermemory_search",
  "supermemory_remember",
  "supermemory_forget",
  "system_info",
  "Skill",
]);

const SESSION_CHECKLIST_TOOLS = new Set([
  "task_list_create",
  "task_list_update",
  "task_list_list",
]);

const INTEGRATION_INTENT_PATTERN =
  /\b(gmail|google drive|google calendar|calendar|notion|box|dropbox|onedrive|sharepoint|slack|jira|linear|hubspot|salesforce|asana|discord|zendesk|servicenow|okta|resend|connector|integration|crm|inbox|email|drive|cloud storage|mcp)\b/i;
const BROWSER_INTENT_PATTERN =
  /\b(browser|website|web page|web app|page|dom|click|button|form|login|navigate|url|screenshot|visual|render|preview|open in browser)\b/i;
const ARTIFACT_INTENT_PATTERN =
  /\b(docx|pdf|document|report|spreadsheet|excel|xlsx|presentation|slides?|powerpoint|diagram|flowchart|mermaid|chart|graph|erd|gantt|timeline|mindmap|image|visualization)\b/i;
const PDF_VISUAL_INTENT_PATTERN =
  /\b(pdf|document|page|pages)\b[\s\S]{0,80}\b(layout|visual|format(?:ting)?|design|style|appearance|colors?|font|typography|structure|scan(?:ned)?|ocr|image[- ]based|image[- ]only|handwrit(?:ing|ten)|look(?:s|ing)?)\b|\b(layout|visual|format(?:ting)?|design|style|appearance|colors?|font|typography|structure|scan(?:ned)?|ocr|image[- ]based|image[- ]only|handwrit(?:ing|ten))\b[\s\S]{0,80}\b(pdf|document|page|pages)\b/i;
/** Matches prompts that request AI image generation (draw, picture, create image, etc.) */
const IMAGE_CREATION_INTENT_PATTERN =
  /\b(draw|picture|photo|paint|illustrate|render|sketch)\b|create\s+(?:an?\s+)?(?:image|picture|photo|illustration)|generate\s+(?:an?\s+)?(?:image|picture|photo)|make\s+(?:an?\s+)?(?:image|picture|photo|illustration)/i;
/** Matches prompts that request AI video generation (create video, generate video, etc.) */
const VIDEO_CREATION_INTENT_PATTERN =
  /\b(video|clip|animation|footage|reel|movie)\b|create\s+(?:an?\s+)?video|generate\s+(?:an?\s+)?video|make\s+(?:an?\s+)?video|record\s+(?:an?\s+)?video/i;
const SYSTEM_INTENT_PATTERN =
  /\b(clipboard|screenshot|finder|application|open app|open url|environment variable|env var|applescript|desktop automation)\b/i;
/** Native / full-desktop control — last resort after MCP, browser, and shell. */
const COMPUTER_USE_INTENT_PATTERN =
  /\b(computer use|desktop automation|native app|native macos|macos app|control my (mac|screen|desktop)|not in browser|gui only|ios simulator|simulator|xcode|system preferences|menu bar)\b/i;
const SCREEN_CONTEXT_INTENT_PATTERN =
  /\b(failing one|on screen|latest draft|same doc|what is this|why is this failing|screen context|right side|left side|top right|top left|bottom right|bottom left)\b/i;
const EXPLICIT_APPLESCRIPT_INTENT_PATTERN =
  /\b(applescript|osascript|script editor|apple script|tell application|system events)\b/i;
const NATIVE_APP_REFERENCE_PATTERN =
  /\b(calculator|notes?|finder|preview|textedit|system settings|system preferences|simulator|ios simulator|xcode|mail|messages|photos|music|quicktime|terminal|iterm|warp|cursor|vscode|visual studio code|menu bar|dock|spotlight|native app|desktop app|macos app)\b/i;
const NATIVE_GUI_ACTION_PATTERN =
  /\b(click|tap|press|type|enter|select|choose|toggle|drag|drop|scroll|hover|move (?:the )?mouse|cursor|navigate|create|rename|delete|compose|reply|submit)\b/i;
const NATIVE_APP_OPEN_PATTERN =
  /\b(open|launch|activate|bring(?:ing)? .* front|focus|switch to|use)\b/i;
const WEB_SURFACE_PATTERN =
  /\b(browser|website|web page|web app|dom|url|https?:\/\/|localhost|127\.0\.0\.1|chrome|safari|firefox|brave|edge|browser tab|webview)\b/i;
const ORCHESTRATION_INTENT_PATTERN =
  /\b(spawn agent|sub-?agent|child task|child agent|delegate|parallel agent|orchestrate|multi-agent|handoff|coordinate agents|agent team)\b/i;
const ADMIN_INTENT_PATTERN =
  /\b(personality|persona|agent name|user name|response style|quirks|vibes|lore|heartbeat|integration setup)\b/i;

function normalizeTaskText(taskText?: string): string {
  return String(taskText || "").trim().toLowerCase();
}

function hasBrowserSurfaceIntent(taskText: string): boolean {
  return WEB_SURFACE_PATTERN.test(taskText);
}

export function hasPdfVisualIntent(taskText: string): boolean {
  return PDF_VISUAL_INTENT_PATTERN.test(taskText);
}

export function hasNativeDesktopGuiIntent(taskText: string): boolean {
  if (!taskText) return false;
  if (COMPUTER_USE_INTENT_PATTERN.test(taskText)) return true;
  const hasNativeAppReference = NATIVE_APP_REFERENCE_PATTERN.test(taskText);
  const hasGuiAction = NATIVE_GUI_ACTION_PATTERN.test(taskText);
  const hasOpenOrFocusAction = NATIVE_APP_OPEN_PATTERN.test(taskText);

  if (hasNativeAppReference && (hasGuiAction || hasOpenOrFocusAction)) {
    return true;
  }

  if (hasBrowserSurfaceIntent(taskText)) return false;

  return hasOpenOrFocusAction && hasGuiAction;
}

function hasToolAffinity(toolName: string, tools?: Iterable<string>): boolean {
  if (!tools) return false;
  const target = toolName.trim().toLowerCase();
  for (const entry of tools) {
    if (String(entry || "").trim().toLowerCase() === target) return true;
  }
  return false;
}

function inferToolExposureMetadata(
  toolName: string,
  runtime?: RuntimeToolMetadata,
): ToolExposureMetadata {
  if (runtime) {
    const primaryTag = runtime.capabilityTags[0];
    const lane =
      primaryTag === "shell"
        ? "code"
        : primaryTag === "mcp"
          ? "integration"
          : (primaryTag as ToolLane | undefined);
    if (lane) {
      return {
        lane,
        exposure: runtime.exposure,
      };
    }
  }
  if (EXPLICIT_ONLY_TOOLS.has(toolName)) {
    return { lane: "admin", exposure: "explicit_only", overlapGroup: "admin_controls" };
  }
  if (ORCHESTRATION_TOOLS.has(toolName)) {
    return { lane: "orchestration", exposure: "explicit_only", overlapGroup: "multi_agent" };
  }
  if (SESSION_CHECKLIST_TOOLS.has(toolName)) {
    return { lane: "core", exposure: "conditional", overlapGroup: "session_checklist" };
  }
  if (INTEGRATION_TOOLS.has(toolName) || toolName.endsWith("_action") || toolName.startsWith("mcp_")) {
    return { lane: "integration", exposure: "conditional", overlapGroup: "integration" };
  }
  if (toolName.startsWith("browser_") || toolName.startsWith("canvas_")) {
    return {
      lane: toolName.startsWith("canvas_") ? "artifact" : "browser",
      exposure: "conditional",
      overlapGroup: toolName.startsWith("canvas_") ? "canvas" : "browser",
    };
  }
  if (ARTIFACT_TOOLS.has(toolName)) {
    const overlapGroup =
      toolName.includes("document") || toolName.includes("presentation") || toolName.includes("spreadsheet")
        ? "artifact_generation"
        : toolName === "create_diagram"
          ? "diagram_generation"
          : toolName.includes("image") || toolName.includes("pdf")
            ? "vision_or_image"
            : undefined;
    return { lane: "artifact", exposure: "conditional", overlapGroup };
  }
  if (
    toolName === "search_memories" ||
    toolName === "search_quotes" ||
    toolName === "search_sessions" ||
    toolName === "memory_topics_load" ||
    toolName === "memory_save" ||
    toolName === "memory_curate" ||
    toolName === "memory_curated_read" ||
    toolName === "supermemory_profile" ||
    toolName === "supermemory_search" ||
    toolName === "supermemory_remember" ||
    toolName === "supermemory_forget" ||
    toolName.startsWith("scratchpad_")
  ) {
    return { lane: "memory", exposure: "always", overlapGroup: "memory" };
  }
  if (CONDITIONAL_SYSTEM_TOOLS.has(toolName)) {
    return {
      lane: "system",
      exposure: "conditional",
      overlapGroup: toolName === "screen_context_resolve" ? "chronicle" : "system_interaction",
    };
  }
  if (isComputerUseToolName(toolName)) {
    return { lane: "system", exposure: "conditional", overlapGroup: "computer_use" };
  }
  if (toolName === "web_search" || toolName === "web_fetch" || toolName === "http_request") {
    return { lane: "research", exposure: "always", overlapGroup: "web_access" };
  }
  if (toolName === "glob" || toolName === "grep") {
    return { lane: "code", exposure: "always", overlapGroup: "code_navigation" };
  }
  if (ALWAYS_VISIBLE_TOOLS.has(toolName) || isReadOnlyByPrefix(toolName)) {
    return { lane: "core", exposure: "always" };
  }
  return { lane: "system", exposure: "conditional" };
}

export function getToolExposureMetadata(toolName: string): ToolExposureMetadata {
  return inferToolExposureMetadata(String(toolName || "").trim());
}

export function evaluateToolAvailability(
  toolName: string,
  ctx: ToolAvailabilityContext,
  runtime?: RuntimeToolMetadata,
): ToolAvailabilityResult {
  const normalizedToolName = String(toolName || "").trim();
  const metadata = inferToolExposureMetadata(normalizedToolName, runtime);
  if (!normalizedToolName) {
    return { decision: "defer", reason: "empty_tool_name", metadata };
  }

  if (hasToolAffinity(normalizedToolName, ctx.requiredTools)) {
    return { decision: "allow", metadata };
  }
  if (hasToolAffinity(normalizedToolName, ctx.recentlyUsedTools)) {
    return { decision: "allow", metadata };
  }
  if (metadata.exposure === "always") {
    return { decision: "allow", metadata };
  }

  const taskText = normalizeTaskText(ctx.taskText);
  if (!taskText) {
    return { decision: "defer", reason: `hidden_without_task_signal:${metadata.lane}`, metadata };
  }

  if (normalizedToolName === "read_pdf_visual") {
    return hasPdfVisualIntent(taskText)
      ? { decision: "allow", metadata }
      : { decision: "defer", reason: "pdf_visual_intent_missing", metadata };
  }

  switch (metadata.lane) {
    case "admin":
      return ADMIN_INTENT_PATTERN.test(taskText)
        ? { decision: "allow", metadata }
        : { decision: "defer", reason: "explicit_admin_intent_required", metadata };
    case "orchestration":
      return ORCHESTRATION_INTENT_PATTERN.test(taskText)
        ? { decision: "allow", metadata }
        : { decision: "defer", reason: "explicit_multi_agent_intent_required", metadata };
    case "integration":
      return INTEGRATION_INTENT_PATTERN.test(taskText)
        ? { decision: "allow", metadata }
        : { decision: "defer", reason: "integration_intent_missing", metadata };
    case "browser":
      return BROWSER_INTENT_PATTERN.test(taskText)
        ? { decision: "allow", metadata }
        : { decision: "defer", reason: "browser_intent_missing", metadata };
    case "artifact":
      if (
        ARTIFACT_INTENT_PATTERN.test(taskText) ||
        IMAGE_CREATION_INTENT_PATTERN.test(taskText) ||
        VIDEO_CREATION_INTENT_PATTERN.test(taskText) ||
        ctx.taskDomain === "writing" ||
        ctx.taskDomain === "media" ||
        ctx.taskIntent === "planning"
      ) {
        return { decision: "allow", metadata };
      }
      return { decision: "defer", reason: "artifact_intent_missing", metadata };
    case "system":
      if (normalizedToolName === "open_application") {
        return hasNativeDesktopGuiIntent(taskText) ||
          SYSTEM_INTENT_PATTERN.test(taskText) ||
          ctx.taskDomain === "operations"
          ? { decision: "allow", metadata }
          : { decision: "defer", reason: "system_intent_missing", metadata };
      }
      if (normalizedToolName === "run_applescript") {
        if (EXPLICIT_APPLESCRIPT_INTENT_PATTERN.test(taskText)) {
          return { decision: "allow", metadata };
        }
        if (hasNativeDesktopGuiIntent(taskText)) {
          return { decision: "defer", reason: "prefer_computer_use_for_native_gui", metadata };
        }
        return SYSTEM_INTENT_PATTERN.test(taskText) || ctx.taskDomain === "operations"
          ? { decision: "allow", metadata }
          : { decision: "defer", reason: "system_intent_missing", metadata };
      }
      if (normalizedToolName === "screen_context_resolve") {
        const trimmedTaskText = taskText.trim();
        const barePointerReference = /^(this|that)\??$/i.test(trimmedTaskText);
        return hasNativeDesktopGuiIntent(taskText) ||
          barePointerReference ||
          SCREEN_CONTEXT_INTENT_PATTERN.test(taskText) ||
          SYSTEM_INTENT_PATTERN.test(taskText)
          ? { decision: "allow", metadata: { ...metadata, overlapGroup: "chronicle" } }
          : { decision: "defer", reason: "screen_context_intent_missing", metadata };
      }
      if (isComputerUseToolName(normalizedToolName)) {
        return hasNativeDesktopGuiIntent(taskText) || ctx.taskDomain === "operations"
          ? { decision: "allow", metadata }
          : { decision: "defer", reason: "computer_use_intent_missing", metadata };
      }
      return SYSTEM_INTENT_PATTERN.test(taskText) || ctx.taskDomain === "operations"
        ? { decision: "allow", metadata }
        : { decision: "defer", reason: "system_intent_missing", metadata };
    default:
      return { decision: "allow", metadata };
  }
}

const READONLY_GIT_TOOLS = new Set([
  "git_status",
  "git_diff",
  "git_log",
  "git_show",
  "git_branch",
  "git_ls_files",
  "git_blame",
  "git_refs",
]);

const ALWAYS_MUTATING = new Set([
  "run_command",
  "run_applescript",
  "schedule_task",
  "spawn_agent",
  "orchestrate_agents",
  "send_agent_message",
  "cancel_agent",
  "pause_agent",
  "resume_agent",
  "switch_workspace",
  "browser_click",
  "browser_type",
  "browser_drag",
  "browser_scroll",
  "browser_select_option",
  "browser_press_key",
  "browser_handle_dialog",
  "browser_file_upload",
  "browser_go_back",
  "browser_refresh",
  "browser_new_tab",
  "browser_close_tab",
  "browser_close",
  "cloud_sandbox_create",
  "cloud_sandbox_exec",
  "cloud_sandbox_write_file",
  "cloud_sandbox_delete",
  "domain_register",
  "domain_dns_add",
  "domain_dns_delete",
  "x402_fetch",
  "execute_code",
  "click",
  "double_click",
  "move_mouse",
  "drag",
  "scroll",
  "type_text",
  "keypress",
  "wait",
  "screenshot",
]);

const MUTATING_PREFIXES = [
  "create_",
  "write_",
  "edit_",
  "delete_",
  "rename_",
  "move_",
  "copy_",
  "generate_",
  "publish_",
  "deploy_",
  "submit_",
  "approve_",
  "merge_",
  "rebase_",
  "revert_",
  "push_",
  "mint_",
  "airdrop_",
];

const READONLY_PREFIXES = [
  "read_",
  "list_",
  "get_",
  "search_",
  "find_",
  "inspect_",
  "check_",
  "task_",
  "web_",
];

function isReadOnlyByPrefix(toolName: string): boolean {
  return READONLY_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

function isMutatingGitTool(toolName: string): boolean {
  return toolName.startsWith("git_") && !READONLY_GIT_TOOLS.has(toolName);
}

function isMutatingTool(toolName: string): boolean {
  if (ALWAYS_MUTATING.has(toolName)) return true;
  if (isMutatingGitTool(toolName)) return true;
  if (toolName.endsWith("_action")) return true;
  if (toolName.startsWith("mcp_")) return true;
  if (isReadOnlyByPrefix(toolName)) return false;
  return MUTATING_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

function inferModeFromConversationMode(conversationMode?: ConversationMode): ExecutionMode | null {
  if (conversationMode === "chat" || conversationMode === "think") return "chat";
  return null;
}

export function normalizeExecutionMode(
  executionMode: ExecutionMode | undefined,
  conversationMode?: ConversationMode,
): ExecutionMode {
  if (executionMode) return executionMode;
  return inferModeFromConversationMode(conversationMode) ?? "execute";
}

export function normalizeTaskDomain(taskDomain: TaskDomain | undefined): TaskDomain {
  return taskDomain ?? "auto";
}

function applyModeGate(toolName: string, mode: ExecutionMode): string | null {
  if (mode === "chat") {
    return `Tool "${toolName}" is blocked in chat mode because chat mode is direct-answer only and does not allow tool calls.`;
  }
  if (toolName === "request_user_input") {
    if (mode === "plan" || mode === "debug") return null;
    return `Tool "${toolName}" is only available in plan or debug mode. Switch mode to plan or debug to request structured user input.`;
  }
  if (SESSION_CHECKLIST_TOOLS.has(toolName)) {
    if (mode === "execute" || mode === "verified" || mode === "debug") return null;
    return `Tool "${toolName}" is only available in execute, verified, or debug mode.`;
  }

  // Verified and debug modes allow mutations (like execute); debug adds runtime-evidence investigation.
  if (mode === "execute" || mode === "verified" || mode === "debug") return null;
  if (!isMutatingTool(toolName)) return null;

  if (mode === "plan") {
    return `Tool "${toolName}" is blocked in plan mode because it may mutate state. Switch to execute mode to run it.`;
  }
  return `Tool "${toolName}" is blocked in analyze mode. Analyze mode is read-only by design.`;
}

function applyDomainGate(toolName: string, domain: TaskDomain, shellEnabled?: boolean): string | null {
  if (domain === "auto" || domain === "code" || domain === "operations") return null;

  if (toolName === "run_command" || toolName === "run_applescript" || toolName === "execute_code") {
    if (shellEnabled) return null;
    return `Tool "${toolName}" is blocked for the "${domain}" domain. Use non-shell tools or switch domain to code/operations.`;
  }

  if (isMutatingGitTool(toolName)) {
    return `Tool "${toolName}" is blocked for the "${domain}" domain because git mutation is not expected here.`;
  }

  if (
    toolName.startsWith("cloud_sandbox_") ||
    toolName.startsWith("domain_") ||
    toolName.startsWith("wallet_") ||
    toolName.startsWith("x402_")
  ) {
    return `Tool "${toolName}" is blocked for the "${domain}" domain because it is operations-specific.`;
  }

  return null;
}

export function evaluateToolPolicy(toolName: string, ctx: ToolPolicyContext): ToolPolicyResult {
  const mode = normalizeExecutionMode(ctx.executionMode, ctx.conversationMode);
  const domain = normalizeTaskDomain(ctx.taskDomain);

  const modeReason = applyModeGate(toolName, mode);
  if (modeReason) {
    return { decision: "deny", reason: modeReason, mode, domain };
  }

  const domainReason = applyDomainGate(toolName, domain, ctx.shellEnabled);
  if (domainReason) {
    return { decision: "deny", reason: domainReason, mode, domain };
  }

  return { decision: "allow", mode, domain };
}

export function filterToolsByPolicy<T extends { name: string }>(
  tools: T[],
  ctx: ToolPolicyContext,
): { tools: T[]; blocked: BlockedTool[] } {
  const allowed: T[] = [];
  const blocked: BlockedTool[] = [];

  for (const tool of tools) {
    const decision = evaluateToolPolicy(tool.name, ctx);
    if (decision.decision === "allow") {
      allowed.push(tool);
      continue;
    }

    blocked.push({
      name: tool.name,
      decision: decision.decision,
      reason: decision.reason,
    });
  }

  return { tools: allowed, blocked };
}
