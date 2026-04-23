import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import { createHash } from "crypto";
import mermaid from "mermaid";
import {
  ApprovalType,
  EvidenceRef,
  SessionChecklistState,
  SessionChecklistToolItemInput,
  Workspace,
  GatewayContextType,
  AgentConfig,
  AgentType as _AgentType,
  Task,
  TaskEvent,
  TOOL_GROUPS,
  ToolGroupName,
  WorkspacePathAliasPolicy,
  WorkerRoleKind,
} from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import { FileTools } from "./file-tools";
import { SkillTools } from "./skill-tools";
import { SearchTools } from "./search-tools";
import { WebFetchTools } from "./web-fetch-tools";
import { GlobTools } from "./glob-tools";
import { GrepTools } from "./grep-tools";
import { EditTools } from "./edit-tools";
import { MontyTools } from "./monty-tools";
import { TextTools } from "./text-tools";
import { BrowserTools } from "./browser-tools";
import { ShellTools } from "./shell-tools";
import { ImageTools } from "./image-tools";
import { VideoTools } from "./video-tools";
import { VisionTools } from "./vision-tools";
import { SystemTools } from "./system-tools";
import { CronTools } from "./cron-tools";
import { CanvasTools } from "./canvas-tools";
import { VisualTools } from "./visual-tools";
import { MentionTools } from "./mention-tools";
import { XTools } from "./x-tools";
import { NotionTools } from "./notion-tools";
import { BoxTools } from "./box-tools";
import { OneDriveTools } from "./onedrive-tools";
import { GoogleDriveTools } from "./google-drive-tools";
import { GmailTools } from "./gmail-tools";
import { MailboxTools } from "./mailbox-tools";
import { GoogleCalendarTools } from "./google-calendar-tools";
import { AppleCalendarTools } from "./apple-calendar-tools";
import { AppleRemindersTools } from "./apple-reminders-tools";
import { DropboxTools } from "./dropbox-tools";
import { SharePointTools } from "./sharepoint-tools";
import { VoiceCallTools } from "./voice-call-tools";
import { ChannelTools } from "./channel-tools";
import { EmailImapTools } from "./email-imap-tools";
import { GitTools } from "./git-tools";
import { MemoryTools } from "./memory-tools";
import { SupermemoryTools } from "./supermemory-tools";
import { ChannelRepository } from "../../database/repositories";
import { readFilesByPatterns } from "./read-files";
import type { LLMTool, LLMToolPromptRenderContext } from "../llm/types";
import { SearchProviderFactory } from "../search";
import { MCPClientManager } from "../../mcp/client/MCPClientManager";
import { MCPSettingsManager } from "../../mcp/settings";
import { MCPRegistryManager } from "../../mcp/registry/MCPRegistryManager";
import type { MCPServerConfig, MCPTool, MCPToolProperty } from "../../mcp/types";
import {
  ConnectorCapability,
  IntegrationAuthMethod,
  IntegrationInputHint,
  Tier1IntegrationProvider,
  TIER1_CONNECTOR_IDS,
  detectConnectorCapabilityId,
  evaluateConnectorReadiness,
  getConnectorCapability,
  listTier1ConnectorCapabilities,
} from "../../mcp/connectors/capabilities";
import { startConnectorOAuth, type ConnectorOAuthRequest } from "../../mcp/oauth/connector-oauth";
import { isToolAllowedQuick } from "../../security/policy-manager";
import { evaluateMontyToolPolicy } from "../../security/monty-tool-policy";
import { BuiltinToolsSettingsManager } from "./builtin-settings";
import { getCustomSkillLoader } from "../custom-skill-loader";
import { SkillProposalService } from "../skills/SkillProposalService";
import { PersonalityManager } from "../../settings/personality-manager";
import {
  PersonalityId,
  PersonaId,
  PERSONALITY_DEFINITIONS,
  PERSONA_DEFINITIONS,
  CustomSkill,
  PendingSkillParameterCollection,
  SkillApplication,
  SkillApplicationTrigger,
  SkillContextDirectives,
} from "../../../shared/types";
import { parseLeadingSkillSlashCommand } from "../../../shared/skill-slash-commands";
import {
  resolveModelPreferenceToModelKey,
  resolvePersonalityPreference,
} from "../../../shared/agent-preferences";
import { ModelCapabilityRegistry } from "../llm/ModelCapabilityRegistry";
import { CodeExecTools } from "./code-exec-tools";
import { DocumentParserTools } from "./document-parser-tools";
import { isHeadlessMode } from "../../utils/runtime-mode";
import { sanitizeStoredPreferredName } from "../../utils/preferred-name";
import { HooksSettingsManager } from "../../hooks/settings";
import { InfraTools } from "../../infra/infra-tools";
import { InfraSettingsManager } from "../../infra/infra-settings";
import { KnowledgeGraphTools } from "./knowledge-graph-tools";
import { ScrapingTools } from "./scraping-tools";
import { DocumentTools } from "./document-tools";
import { ComputerUseTools } from "./computer-use-tools";
import { BatchImageTools } from "./batch-image-tools";
import { ScratchpadTools } from "./scratchpad-tools";
import { QATools } from "./qa-tools";
import {
  ChronicleCaptureService,
  ChronicleMemoryService,
  ChronicleObservationRepository,
  ChronicleSettingsManager,
} from "../../chronicle";
import { CitationTracker } from "../citation/CitationTracker";
import { OrchestrationRepository } from "../OrchestrationRepository";
import {
  canonicalizeToolName as canonicalizeToolNameUtil,
  getToolSemantics as getToolSemanticsUtil,
  isArtifactGenerationToolName as isArtifactGenerationToolNameUtil,
} from "../tool-semantics";
import { isComputerUseToolName } from "../../../shared/computer-use-contract";
import { writeKitFileWithSnapshot } from "../../context/kit-revisions";
import { getACPRegistry } from "../../acp";
import { RemoteAgentInvoker } from "../../acp/remote-invoker";
import { withRuntimeToolMetadataList, getDefaultRuntimeToolMetadata } from "./runtime-tool-definition";
import { ToolHandlerRegistry } from "../runtime/tool-handler-registry";
import {
  createStaticRuntimeToolSchedulerSpecResolver,
  resolveRuntimeToolSchedulerSpec,
  type RuntimeToolSchedulerSpec,
} from "../runtime/runtime-tool-scheduler-spec";
import {
  composeToolMiddleware,
  type ToolExecutionContext,
  type ToolExecutionHandler,
  type ToolExecutionMiddleware,
} from "../runtime/tool-middleware";
import { evaluateToolPolicyPipeline } from "../runtime/ToolPolicyPipeline";
import { ToolSearchService } from "../runtime/ToolSearchService";
import {
  getWorkerRoleSpec,
  resolveDelegationWorkerRole,
} from "../runtime/worker-role-registry";
import {
  TOOL_PROMPT_METADATA_VERSION,
  renderCompactToolDescription,
  renderToolForContext,
  withToolPromptMetadataList,
} from "./tool-prompting";

function sanitizeFilename(raw: string, maxLen = 120): string {
  const base = path.basename(String(raw || "").trim() || "artifact");
  const cleaned = base
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxLen);
  return cleaned || "artifact";
}

function guessExtFromMime(mimeType?: string): string {
  const mime = (mimeType || "").toLowerCase();
  if (mime === "image/png") return ".png";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/bmp") return ".bmp";
  return "";
}

const MCP_PAYMENT_TOOL_NAME = "x402_fetch";
const NETWORK_READ_TOOL_NAMES = new Set(["web_search", "web_fetch"]);
const MCP_PAYMENT_AMOUNT_PATHS = [
  ["amount"],
  ["maxAmount"],
  ["request", "amount"],
  ["request", "maxAmount"],
];
const MCP_PAYMENT_MAX_AMOUNT_USD = 100;

const MCP_PAYMENT_AMOUNT_TYPES = new Set(["number", "integer", "string"]);

const SUB_AGENT_DEFAULT_DENIED_TOOLS = [
  "spawn_agent",
  "wait_for_agent",
  "get_agent_status",
  "get_orchestration_status",
  "list_agents",
  "send_agent_message",
  "capture_agent_events",
  "cancel_agent",
  "pause_agent",
  "resume_agent",
  "orchestrate_agents",
];

const EXTRACTION_SUB_AGENT_ALLOWED_TOOLS = [
  "read_file",
  "mcp_read_text_file",
  "grep",
  "glob",
  "search_files",
  "list_directory",
  "get_file_info",
  "browser_navigate",
  "browser_get_content",
  "browser_evaluate",
  "write_file",
];

const DEFAULT_ACTIVE_SUB_AGENT_LIMIT = 3;
const ACTIVE_CHILD_AGENT_STATUSES = new Set(["pending", "queued", "planning", "executing"]);
const EXTRACTION_CONTRACT_MARKER = "[EXTRACTION_OUTPUT_CONTRACT_V1]";
const CODEX_RUNTIME_TITLE_PATTERNS = [
  /\bcodex\b/i,
  /\bcodex\s+cli\b/i,
  /\bcodex\s+(review|fix|exec|agent|task|audit|critiqu)/i,
];
const READ_MOSTLY_CODEX_PROMPT_PATTERN =
  /\b(review|analy[sz]e|analysis|plan|audit|inspect|investigate|research|summari[sz]e|critique)\b/i;

export type SpawnAgentRuntimeMode = "native" | "acpx";
export type SpawnAgentRuntimeAgent = "codex" | "claude";

export function isExplicitCodexSpawnRequest(input: {
  runtime_agent?: string;
  title?: string;
  prompt?: string;
}): boolean {
  if (
    typeof input.runtime_agent === "string" &&
    input.runtime_agent.trim().toLowerCase() === "codex"
  ) {
    return true;
  }
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (title && CODEX_RUNTIME_TITLE_PATTERNS.some((pattern) => pattern.test(title))) {
    return true;
  }
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (prompt && CODEX_RUNTIME_TITLE_PATTERNS.some((pattern) => pattern.test(prompt))) {
    return true;
  }
  return false;
}

export function resolveExternalRuntimePermissionMode(input: {
  prompt: string;
  title?: string;
  autonomousMode?: boolean;
}): "approve-reads" | "approve-all" | "deny-all" {
  if (input.autonomousMode === true) {
    return "approve-all";
  }
  const signalText = `${String(input.title || "")}\n${String(input.prompt || "")}`;
  return READ_MOSTLY_CODEX_PROMPT_PATTERN.test(signalText) ? "approve-reads" : "deny-all";
}

export function resolveSpawnAgentExternalRuntime(input: {
  runtime?: SpawnAgentRuntimeMode;
  runtime_agent?: SpawnAgentRuntimeAgent;
  title?: string;
  prompt: string;
  autonomousMode?: boolean;
  defaultCodexRuntimeMode?: "native" | "acpx";
}): AgentConfig["externalRuntime"] | undefined {
  const explicitRuntime = typeof input.runtime === "string" ? input.runtime : undefined;
  if (explicitRuntime === "native") {
    return undefined;
  }

  const codexRequested = isExplicitCodexSpawnRequest(input);
  const explicitRuntimeAgent =
    typeof input.runtime_agent === "string" ? input.runtime_agent : undefined;
  const shouldUseAcpx =
    (explicitRuntime === "acpx" && Boolean(explicitRuntimeAgent)) ||
    (input.defaultCodexRuntimeMode === "acpx" && codexRequested);

  if (!shouldUseAcpx) {
    return undefined;
  }

  if (explicitRuntime === "acpx" && !explicitRuntimeAgent) {
    return undefined;
  }

  const runtimeAgent = explicitRuntimeAgent ?? "codex";
  const permissionMode = resolveExternalRuntimePermissionMode(input);

  return {
    kind: "acpx",
    agent: runtimeAgent,
    sessionMode: "persistent",
    outputMode: "json",
    permissionMode,
  };
}

function parseBoundedIntEnv(
  envName: string,
  fallback: number,
  minValue: number,
  maxValue: number,
): number {
  const raw = process.env[envName];
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maxValue, Math.max(minValue, Math.round(parsed)));
}

function parseBooleanEnv(envName: string, fallback = true): boolean {
  const raw = process.env[envName];
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on")
    return true;
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off")
    return false;
  return fallback;
}

function isExtractionLikePrompt(prompt: string): boolean {
  const normalized = String(prompt || "").toLowerCase();
  if (!normalized) return false;

  const hasHtmlSignal =
    /(?:\.html?\b|\.xhtml\b)/i.test(normalized) ||
    normalized.includes("html page") ||
    normalized.includes("saved as html") ||
    normalized.includes("raw html") ||
    normalized.includes("page source") ||
    normalized.includes("webpage source") ||
    normalized.includes("web page source") ||
    normalized.includes("markup") ||
    normalized.includes("dom");
  const hasFileReadSignal =
    /\bread\b.{0,40}\b(file|document|page|source)\b/i.test(normalized) ||
    normalized.includes("from the workspace") ||
    normalized.includes("in the workspace");
  const hasExtractionSignal =
    /\bextract|extraction|summari(?:ze|sation)|convert|transform|clean|normalize|meaningful content|knowledge[-\s]?base|markdown\b/i.test(
      normalized,
    );

  return hasExtractionSignal && (hasHtmlSignal || hasFileReadSignal);
}

function applyExtractionOutputContract(prompt: string): string {
  if (prompt.includes(EXTRACTION_CONTRACT_MARKER)) return prompt;

  return `${prompt.trim()}\n\n${EXTRACTION_CONTRACT_MARKER}
Execution contract (must follow):
1) Keep tool usage minimal. Read the source once, then extract.
2) Do not spawn other agents.
3) If extraction is blocked, stop probing and report the blocker.
4) Final response must be strict JSON with this shape:
{"status":"success|blocked","source_file":"...","output_file":"...","sections_extracted":0,"notes":["..."]}
5) Keep JSON concise and machine-parseable (no markdown fences).`;
}

function parsePaymentAmount(rawAmount: unknown): number | null {
  if (typeof rawAmount === "number" && Number.isFinite(rawAmount) && rawAmount >= 0) {
    return rawAmount;
  }
  if (typeof rawAmount === "string") {
    const parsed = Number(rawAmount.trim());
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

function getSchemaProperty(
  schema: MCPTool["inputSchema"] | undefined,
  path: readonly string[],
): MCPToolProperty | undefined {
  let current: MCPTool["inputSchema"] | MCPToolProperty | undefined = schema;
  let index = 0;

  while (index < path.length && current) {
    const key = path[index];
    if (!current || typeof current !== "object") {
      return undefined;
    }

    const properties = current.properties;
    if (!properties || typeof properties !== "object") {
      return undefined;
    }

    const next = properties[key];
    if (!next || typeof next !== "object") {
      return undefined;
    }

    if (index === path.length - 1) {
      return next as MCPToolProperty;
    }

    current = next;
    index += 1;
  }

  return undefined;
}

function getInputValue(input: unknown, path: readonly string[]): unknown {
  let current: unknown = input;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function extractPaymentAmountFromX402Tool(
  input: unknown,
  toolSchema?: MCPTool,
): number | null {
  if (toolSchema?.name !== MCP_PAYMENT_TOOL_NAME) {
    return null;
  }
  if (!toolSchema || typeof input !== "object" || !input) {
    return null;
  }

  for (const path of MCP_PAYMENT_AMOUNT_PATHS) {
    const schemaProperty = getSchemaProperty(toolSchema.inputSchema, path);
    if (!schemaProperty?.type || !MCP_PAYMENT_AMOUNT_TYPES.has(schemaProperty.type)) {
      continue;
    }
    const value = getInputValue(input, path);
    const parsed = parsePaymentAmount(value);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

export function getMcpPaymentLimitError(input: unknown, toolSchema?: MCPTool): string | null {
  const amount = extractPaymentAmountFromX402Tool(input, toolSchema);
  if (amount === null) {
    return null;
  }

  if (amount > MCP_PAYMENT_MAX_AMOUNT_USD) {
    return `MCP payment amount is above safety cap (${MCP_PAYMENT_MAX_AMOUNT_USD} USDC): ${amount}`;
  }

  const envCap = Number(process.env.COWORK_PAYMENT_LIMIT_USD);
  if (Number.isFinite(envCap) && envCap > 0 && amount > envCap) {
    return `MCP payment amount exceeds configured cap of ${envCap} USDC: ${amount}`;
  }

  return null;
}

/**
 * ToolRegistry manages all available tools and their execution
 * Integrates with SecurityPolicyManager for context-aware tool filtering
 */
export class ToolRegistry {
  private static mermaidValidationInitialized = false;
  private fileTools: FileTools;
  private skillTools: SkillTools;
  private searchTools: SearchTools;
  private webFetchTools: WebFetchTools;
  private globTools: GlobTools;
  private grepTools: GrepTools;
  private editTools: EditTools;
  private montyTools: MontyTools;
  private textTools: TextTools;
  private browserTools: BrowserTools;
  private shellTools: ShellTools;
  private imageTools: ImageTools;
  private videoTools: VideoTools;
  private visionTools: VisionTools;
  private systemTools: SystemTools;
  private computerUseTools: ComputerUseTools;
  private batchImageTools: BatchImageTools;
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
  private mailboxTools?: MailboxTools;
  private googleCalendarTools: GoogleCalendarTools;
  private appleCalendarTools: AppleCalendarTools;
  private appleRemindersTools: AppleRemindersTools;
  private dropboxTools: DropboxTools;
  private sharePointTools: SharePointTools;
  private voiceCallTools: VoiceCallTools;
  private channelTools?: ChannelTools;
  private emailImapTools?: EmailImapTools;
  private gitTools: GitTools;
  private infraTools: InfraTools;
  private knowledgeGraphTools: KnowledgeGraphTools;
  private scrapingTools: ScrapingTools;
  private memoryTools: MemoryTools;
  private supermemoryTools: SupermemoryTools;
  private documentTools: DocumentTools;
  private scratchpadTools: ScratchpadTools;
  private qaTools: QATools;
  private citationTracker?: CitationTracker;
  private gatewayContext?: GatewayContextType;
  private _deepWorkMode = false;
  private _codeExecTools?: CodeExecTools;
  private deniedTools: Set<string> = new Set();
  private deniedGroups: Set<ToolGroupName> = new Set();
  private denyAllTools = false;
  private shadowedToolsLogged = false;
  private semanticsInvariantLogged = false;
  private cachedToolDefinitionsKey: string | null = null;
  private cachedToolDefinitions: LLMTool[] | null = null;
  private toolDescriptionsCache = new Map<string, string>();
  private resolvedSkillInvocations = new Map<string, SkillApplication>();
  private skillInvocationSequence = 0;
  private readonly handlerRegistry = new ToolHandlerRegistry();
  private readonly executionMiddlewares: ToolExecutionMiddleware[];
  private taskListHandler?: {
    create: (items: SessionChecklistToolItemInput[]) => SessionChecklistState;
    update: (items: SessionChecklistToolItemInput[]) => SessionChecklistState;
    list: () => SessionChecklistState;
  };

  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
    gatewayContext?: GatewayContextType,
    toolRestrictions?: string[],
  ) {
    this.fileTools = new FileTools(workspace, daemon, taskId);
    this.skillTools = new SkillTools(workspace, daemon, taskId);
    this.searchTools = new SearchTools(workspace, daemon, taskId);
    this.webFetchTools = new WebFetchTools(workspace, daemon, taskId);
    this.globTools = new GlobTools(workspace, daemon, taskId);
    this.grepTools = new GrepTools(workspace, daemon, taskId);
    this.editTools = new EditTools(workspace, daemon, taskId);
    this.montyTools = new MontyTools(workspace, daemon, taskId, this.fileTools);
    this.textTools = new TextTools(workspace, daemon, taskId, this.fileTools);
    this.browserTools = new BrowserTools(workspace, daemon, taskId);
    this.shellTools = new ShellTools(workspace, daemon, taskId);
    this.imageTools = new ImageTools(workspace, daemon, taskId);
    this.videoTools = new VideoTools(workspace, daemon, taskId);
    this.visionTools = new VisionTools(workspace, daemon, taskId);
    this.systemTools = new SystemTools(workspace, daemon, taskId);
    this.computerUseTools = new ComputerUseTools(workspace, daemon, taskId);
    this.batchImageTools = new BatchImageTools(workspace, daemon, taskId);
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
    this.gitTools = new GitTools(workspace, daemon, taskId);
    this.infraTools = new InfraTools(workspace, daemon, taskId);
    this.knowledgeGraphTools = new KnowledgeGraphTools(workspace, daemon, taskId);
    this.scrapingTools = new ScrapingTools(workspace, daemon, taskId);
    this.memoryTools = new MemoryTools(workspace, daemon, taskId);
    this.supermemoryTools = new SupermemoryTools(workspace, daemon, taskId);
    this.documentTools = new DocumentTools(workspace.path, taskId, (tid, fp, mime, metadata = {}) =>
      daemon.logEvent(tid, "artifact_created", { path: fp, mimeType: mime, ...metadata }),
    );
    this.scratchpadTools = new ScratchpadTools(taskId, workspace.path);
    this.qaTools = new QATools(workspace, daemon, taskId);
    // Some unit tests stub daemon as a plain object. Make channel history tools optional.
    const dbGetter = (daemon as Any)?.getDatabase;
    if (typeof dbGetter === "function") {
      const db = dbGetter.call(daemon);
      this.channelTools = new ChannelTools(db, daemon, taskId);
      this.emailImapTools = new EmailImapTools(db, daemon, taskId);
      this.mailboxTools = new MailboxTools(workspace, daemon, taskId, db);
    }
    this.gatewayContext = gatewayContext;
    this.applyToolRestrictions(toolRestrictions);
    this.executionMiddlewares = this.buildExecutionMiddlewares();
    this.registerRuntimeHandlers();
  }

  private applyToolRestrictions(restrictions?: string[]): void {
    this.deniedTools = new Set();
    this.deniedGroups = new Set();
    this.denyAllTools = false;
    this.invalidateToolCaches();
    if (!restrictions || restrictions.length === 0) return;

    for (const raw of restrictions) {
      const value = typeof raw === "string" ? raw.trim() : "";
      if (!value) continue;

      // Special marker meaning "deny all tools" (used as a safe default on corrupted policy data).
      if (value === "*") {
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

  private invalidateToolCaches(): void {
    this.cachedToolDefinitionsKey = null;
    this.cachedToolDefinitions = null;
    this.toolDescriptionsCache.clear();
  }

  private buildToolCatalogVersion(): string {
    const hash = createHash("sha1");
    const builtinSettings = BuiltinToolsSettingsManager.loadSettings();
    const mcpSettings = MCPSettingsManager.loadSettings();
    const integrationState = {
      x: XTools.isEnabled(),
      notion: NotionTools.isEnabled(),
      box: BoxTools.isEnabled(),
      oneDrive: OneDriveTools.isEnabled(),
      googleDrive: GoogleDriveTools.isEnabled(),
      gmail: GmailTools.isEnabled(),
      googleCalendar: GoogleCalendarTools.isEnabled(),
      appleCalendar: AppleCalendarTools.isAvailable(),
      appleReminders: AppleRemindersTools.isAvailable(),
      dropbox: DropboxTools.isEnabled(),
      sharePoint: SharePointTools.isEnabled(),
      scraping: ScrapingTools.isEnabled(),
      supermemory: SupermemoryTools.isEnabled(),
      voiceCall: VoiceCallTools.isEnabled(),
      imageGen: ImageTools.isAvailable(),
      videoGen: VideoTools.isAvailable(),
      knowledgeGraph: KnowledgeGraphTools.isEnabled(),
      emailImap: Boolean(this.emailImapTools?.isAvailable?.()),
      channelHistory: Boolean(this.channelTools),
    };
    let infraState: { enabled: boolean; enabledCategories?: Any } = { enabled: false };
    try {
      const infraSettings = InfraSettingsManager.loadSettings();
      infraState = {
        enabled: Boolean(infraSettings.enabled),
        enabledCategories: infraSettings.enabledCategories || null,
      };
    } catch {
      infraState = { enabled: false };
    }
    let mcpManagerVersion = 0;
    let mcpToolNames: string[] = [];
    try {
      const mcpManager = MCPClientManager.getInstance();
      mcpManagerVersion =
        typeof (mcpManager as Any).getToolCatalogVersion === "function"
          ? (mcpManager as Any).getToolCatalogVersion()
          : 0;
      mcpToolNames = mcpManager
        .getAllTools()
        .map((tool) => String(tool.name || ""))
        .filter(Boolean)
        .sort();
    } catch {
      mcpManagerVersion = 0;
      mcpToolNames = [];
    }
    hash.update(
      JSON.stringify({
        workspacePath: this.workspace.path,
        workspaceId: this.workspace.id,
        shellEnabled: this.workspace.permissions.shell,
        gatewayContext: this.gatewayContext || null,
        deniedTools: Array.from(this.deniedTools.values()).sort(),
        deniedGroups: Array.from(this.deniedGroups.values()).sort(),
        denyAllTools: this.denyAllTools,
        headless: isHeadlessMode(),
        deepWorkMode: this._deepWorkMode,
        builtinSettings,
        chronicleSettings: ChronicleSettingsManager.loadSettings(),
        integrationState,
        infraState,
        toolPrompting: TOOL_PROMPT_METADATA_VERSION,
        mcp: {
          toolNamePrefix: mcpSettings.toolNamePrefix || "mcp_",
          enabledServers: (mcpSettings.servers || [])
            .map((server) => ({
              id: server.id,
              enabled: server.enabled,
              transport: server.transport,
            }))
            .sort((a, b) => a.id.localeCompare(b.id)),
          managerVersion: mcpManagerVersion,
          toolNames: mcpToolNames,
        },
      }),
    );
    return hash.digest("hex");
  }

  getToolCatalogVersion(): string {
    return this.buildToolCatalogVersion();
  }

  private buildToolDefinitionsCacheKey(): string {
    return JSON.stringify({
      catalogVersion: this.getToolCatalogVersion(),
      workspacePath: this.workspace.path,
      workspaceId: this.workspace.id,
      shellEnabled: this.workspace.permissions.shell,
      gatewayContext: this.gatewayContext || null,
      deniedTools: Array.from(this.deniedTools.values()).sort(),
      deniedGroups: Array.from(this.deniedGroups.values()).sort(),
      denyAllTools: this.denyAllTools,
      headless: isHeadlessMode(),
      deepWorkMode: this._deepWorkMode,
    });
  }

  private buildToolDescriptionsCacheKey(
    visibleTools?: string[],
    options?: {
      renderContext?: LLMToolPromptRenderContext;
      skillRoutingQuery?: string;
      skillShortlistSize?: number;
      skillLowConfidenceThreshold?: number;
      skillTextBudgetChars?: number;
    },
  ): string {
    const hash = createHash("sha1");
    hash.update(this.buildToolDefinitionsCacheKey());
    if (Array.isArray(visibleTools) && visibleTools.length > 0) {
      hash.update(JSON.stringify([...visibleTools].map((tool) => tool.trim()).filter(Boolean).sort()));
    } else {
      hash.update("__all_tools__");
    }
    hash.update(
      JSON.stringify({
        renderContext: options?.renderContext || null,
        skillShortlistSize: options?.skillShortlistSize ?? null,
        skillLowConfidenceThreshold: options?.skillLowConfidenceThreshold ?? null,
        skillTextBudgetChars: options?.skillTextBudgetChars ?? null,
        skillRoutingQueryHash: options?.skillRoutingQuery
          ? createHash("sha1").update(options.skillRoutingQuery).digest("hex")
          : null,
      }),
    );
    return hash.digest("hex");
  }

  renderToolsForContext(
    tools: LLMTool[],
    context: LLMToolPromptRenderContext,
  ): LLMTool[] {
    return tools.map((tool) => renderToolForContext(tool, context));
  }

  private buildCompactToolDescriptions(
    visibleTools: string[],
    options?: {
      renderContext?: LLMToolPromptRenderContext;
      skillRoutingQuery?: string;
      skillShortlistSize?: number;
      skillLowConfidenceThreshold?: number;
      skillTextBudgetChars?: number;
    },
  ): string {
    const visibleToolSet = new Set(visibleTools.map((tool) => tool.trim()).filter(Boolean));
    const allTools = this.getTools();
    const toolMap = new Map(allTools.map((tool) => [tool.name, tool] as const));
    const compact = (text: unknown, maxChars = 180): string => {
      const normalized = String(text || "")
        .replace(/\s+/g, " ")
        .trim();
      if (!normalized) return "No description available.";
      return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 3)}...` : normalized;
    };

    const orderedVisibleTools = visibleTools
      .map((toolName) => toolMap.get(toolName))
      .filter((tool): tool is LLMTool => Boolean(tool));

    const lines = orderedVisibleTools.map(
      (tool) =>
        `- ${tool.name}: ${compact(
          renderCompactToolDescription(
            tool,
            options?.renderContext || {
              executionMode: "execute",
              taskDomain: "general",
              webSearchMode: "live",
              shellEnabled: this.workspace.permissions.shell,
              agentType: "main",
              workerRole: null,
              allowUserInput: true,
            },
          ),
        )}`,
    );

    const sections: string[] = [];
    if (lines.length > 0) {
      sections.push(`Available tools:\n${lines.join("\n")}`);
    }

    if (visibleToolSet.has("Skill")) {
      const skillLoader = getCustomSkillLoader();
      const availableToolNames = new Set(orderedVisibleTools.map((tool) => tool.name));
      const resolvedSkillShortlistSize =
        typeof options?.skillShortlistSize === "number" && Number.isFinite(options.skillShortlistSize)
          ? Math.min(Math.max(Math.round(options.skillShortlistSize), 1), 200)
          : parseBoundedIntEnv("COWORK_SKILL_SHORTLIST_SIZE", 20, 1, 200);
      const resolvedSkillLowConfidenceThreshold =
        typeof options?.skillLowConfidenceThreshold === "number" &&
        Number.isFinite(options.skillLowConfidenceThreshold)
          ? Math.min(Math.max(options.skillLowConfidenceThreshold, 0), 1)
          : 0.55;
      const resolvedSkillTextBudgetChars =
        typeof options?.skillTextBudgetChars === "number" &&
        Number.isFinite(options.skillTextBudgetChars)
          ? Math.max(Math.round(options.skillTextBudgetChars), 1500)
          : parseBoundedIntEnv("COWORK_SKILL_TEXT_BUDGET_CHARS", 12000, 1500, 50000);
      const skillDescriptions = skillLoader.getSkillDescriptionsForModel({
        availableToolNames,
        routingQuery: options?.skillRoutingQuery,
        shortlistSize: resolvedSkillShortlistSize,
        lowConfidenceThreshold: resolvedSkillLowConfidenceThreshold,
        textBudgetChars: resolvedSkillTextBudgetChars,
        includePrereqBlockedSkills: true,
      });
      if (skillDescriptions) {
        sections.push(`Skills Available Through The Skill Tool:\n${skillDescriptions}`);
      }
    }

    return sections.join("\n\n").trim();
  }

  private validateToolSemanticsInvariant(tools: LLMTool[]): void {
    if (this.semanticsInvariantLogged) return;

    const duplicateToolNames = tools
      .map((tool) => String(tool?.name || ""))
      .filter(Boolean)
      .filter((toolName, index, list) => list.indexOf(toolName) !== index)
      .filter((toolName, index, list) => list.indexOf(toolName) === index);

    const artifactToolPattern = /^(?:create|generate)_(?:document|spreadsheet|presentation)$/;
    const missingSemantics = tools
      .map((tool) => String(tool?.name || ""))
      .filter((toolName) => artifactToolPattern.test(toolName))
      .filter((toolName) => !getToolSemanticsUtil(toolName));
    const artifactSchemaMismatches = tools
      .map((tool) => {
        const toolName = String(tool?.name || "");
        const semantics = getToolSemanticsUtil(toolName);
        if (!semantics || !isArtifactGenerationToolNameUtil(toolName)) return null;
        if (toolName !== semantics.canonicalName) return null;
        const requiredInputSchemaKey = semantics.requiredInputSchemaKey;
        if (!requiredInputSchemaKey) return null;
        const properties = (tool as Any)?.input_schema?.properties;
        if (properties && Object.prototype.hasOwnProperty.call(properties, requiredInputSchemaKey)) {
          return null;
        }
        return `${toolName} missing required input schema key "${requiredInputSchemaKey}"`;
      })
      .filter((entry): entry is string => Boolean(entry));

    const invariantViolations = [
      ...(duplicateToolNames.length > 0
        ? [`duplicate tool names detected: ${duplicateToolNames.join(", ")}`]
        : []),
      ...(missingSemantics.length > 0
        ? [`missing semantics for artifact tools: ${missingSemantics.join(", ")}`]
        : []),
      ...artifactSchemaMismatches,
    ];

    if (invariantViolations.length > 0) {
      const message = `[ToolRegistry] Tool semantics invariant failed: ${invariantViolations.join("; ")}`;
      if (process.env.NODE_ENV === "test" || process.env.COWORK_STRICT_TOOL_INVARIANTS === "1") {
        throw new Error(message);
      }
      console.warn(message);
      this.semanticsInvariantLogged = true;
      return;
    }

    const artifactToolNames = tools
      .map((tool) => String(tool?.name || ""))
      .filter((toolName) => isArtifactGenerationToolNameUtil(toolName));
    if (artifactToolNames.length > 0) {
      console.log(
        `[ToolRegistry] Tool semantics invariant passed for: ${artifactToolNames.join(", ")}`,
      );
    }

    this.semanticsInvariantLogged = true;
  }

  /**
   * Attach a CitationTracker so web_search/web_fetch results feed citations.
   */
  setCitationTracker(tracker: CitationTracker): void {
    this.citationTracker = tracker;
  }

  getCitationTracker(): CitationTracker | undefined {
    return this.citationTracker;
  }

  /** Enable deep work mode — extends spawn_agent max_turns cap to 250 */
  setDeepWorkMode(enabled: boolean): void {
    this._deepWorkMode = enabled;
    this.invalidateToolCaches();
  }

  /**
   * Set resolved web_search domain policy for this task execution context.
   */
  setWebSearchDomainPolicy(policy: { allowedDomains?: string[]; blockedDomains?: string[] } | null): void {
    this.searchTools.setDomainPolicy(policy);
  }

  setWorkspacePathAliasPolicy(policy: WorkspacePathAliasPolicy | undefined): void {
    this.fileTools.setWorkspacePathAliasPolicy(policy);
  }

  /** Get scratchpad data for report generation and progress journaling */
  getScratchpadData(): Map<string, { content: string; timestamp: number }> {
    return this.scratchpadTools.getAll();
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
    this.textTools.setWorkspace(workspace);
    this.browserTools.setWorkspace(workspace);
    this.qaTools.setWorkspace(workspace);
    this.shellTools.setWorkspace(workspace);
    this.imageTools.setWorkspace(workspace);
    this.videoTools.setWorkspace(workspace);
    this.visionTools.setWorkspace(workspace);
    this.systemTools.setWorkspace(workspace);
    this.computerUseTools.setWorkspace(workspace);
    this.batchImageTools.setWorkspace(workspace);
    this.cronTools.setWorkspace(workspace);
    this.canvasTools.setWorkspace(workspace);
    this.visualTools.setWorkspace(workspace);
    this.xTools.setWorkspace(workspace);
    this.notionTools.setWorkspace(workspace);
    this.boxTools.setWorkspace(workspace);
    this.oneDriveTools.setWorkspace(workspace);
    this.googleDriveTools.setWorkspace(workspace);
    this.gmailTools.setWorkspace(workspace);
    this.mailboxTools?.setWorkspace(workspace);
    this.googleCalendarTools.setWorkspace(workspace);
    this.appleCalendarTools.setWorkspace(workspace);
    this.appleRemindersTools.setWorkspace(workspace);
    this.dropboxTools.setWorkspace(workspace);
    this.sharePointTools.setWorkspace(workspace);
    this.voiceCallTools.setWorkspace(workspace);
    this.gitTools.setWorkspace(workspace);
    this.knowledgeGraphTools.setWorkspace(workspace);
    this.scrapingTools.setWorkspace(workspace);
    this.memoryTools.setWorkspace(workspace);
    this.supermemoryTools.setWorkspace(workspace);
    this.documentTools.setWorkspace(workspace);
    this._codeExecTools = undefined;
    this.invalidateToolCaches();
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
    this.invalidateToolCaches();
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

  private deriveChronicleDestinationHints(input: {
    appName?: string;
    windowTitle?: string;
    localTextSnippet?: string;
  }): string[] {
    const haystack = `${input.appName || ""} ${input.windowTitle || ""} ${input.localTextSnippet || ""}`.toLowerCase();
    const hints = new Set<string>();
    if (/\bgoogle docs?|docs\.google|drive\b/.test(haystack)) hints.add("google_doc");
    if (/\bslack\b/.test(haystack)) hints.add("slack_dm");
    if (/\b(vscode|cursor|finder|xcode|repo|github)\b/.test(haystack)) hints.add("repo_file");
    if (/\b(dropbox|box|sharepoint|drive folder|onedrive)\b/.test(haystack)) {
      hints.add("drive_folder");
    }
    return Array.from(hints).slice(0, 4);
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
    const cacheKey = this.buildToolDefinitionsCacheKey();
    if (this.cachedToolDefinitionsKey === cacheKey && this.cachedToolDefinitions) {
      return this.cachedToolDefinitions.slice();
    }

    const headless = isHeadlessMode();
    const allTools: LLMTool[] = [
      ...this.getFileToolDefinitions(),
      ...this.getSkillToolDefinitions(),
      ...GlobTools.getToolDefinitions(),
      ...GrepTools.getToolDefinitions(),
      ...EditTools.getToolDefinitions(),
      ...MontyTools.getToolDefinitions(),
      ...TextTools.getToolDefinitions(),
      ...WebFetchTools.getToolDefinitions(),
      ...BrowserTools.getToolDefinitions(),
    ];

    // web_search is always available (DuckDuckGo provides free fallback)
    allTools.push(...this.getSearchToolDefinitions());

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
    if (this.mailboxTools?.isAvailable()) {
      allTools.push(...this.getMailboxToolDefinitions());
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

    // Voice call tools (outbound phone calls) — only when voice is enabled in settings
    if (VoiceCallTools.isEnabled()) {
      allTools.push(...this.getVoiceCallToolDefinitions());
    }

    // Only add shell tool if workspace has shell permission
    if (this.workspace.permissions.shell) {
      allTools.push(...this.getShellToolDefinitions());
      // Git tools: available in git repos with shell permission
      allTools.push(...GitTools.getToolDefinitions());
    }

    // Image tools — only when at least one image provider is configured
    if (ImageTools.isAvailable()) {
      allTools.push(...ImageTools.getToolDefinitions());
    }

    // Video tools — only when at least one video provider is configured
    if (VideoTools.isAvailable()) {
      allTools.push(...VideoTools.getToolDefinitions());
    }

    // Vision tools (image understanding); may surface setup guidance if API keys are missing
    allTools.push(...VisionTools.getToolDefinitions());

    // Always add system tools (they enable broader system interaction)
    allTools.push(...SystemTools.getToolDefinitions({ headless }));

    const chronicleSettings = ChronicleSettingsManager.loadSettings();
    if (
      chronicleSettings.enabled &&
      !headless &&
      !this.gatewayContext &&
      ChronicleCaptureService.getInstance().canExposeTool()
    ) {
      allTools.push({
        name: "screen_context_resolve",
        description:
          "Resolve vague on-screen references like 'this', 'that', 'latest draft', or 'why is this failing?' using Chronicle's local recent-screen buffer. Returns ranked local screen matches and only falls back to a fresh local screenshot when passive context is weak. Screen-derived text is returned as untrusted context.",
        input_schema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The current request or vague on-screen reference to resolve.",
            },
            limit: {
              type: "number",
              description: "Maximum number of ranked screen-context matches to return.",
            },
            useFallback: {
              type: "boolean",
              description:
                "Whether to capture a fresh local screenshot when the passive Chronicle match is weak.",
            },
          },
          required: ["query"],
        },
      });
    }

    // Computer use tools (native mouse/keyboard/screenshot — macOS only, not headless)
    allTools.push(...ComputerUseTools.getToolDefinitions({ headless }));

    // Batch image processing tools — only when image generation is available
    if (ImageTools.isAvailable()) {
      allTools.push(...BatchImageTools.getToolDefinitions());
    }

    // Always add cron/scheduling tools (enables task scheduling)
    allTools.push(...CronTools.getToolDefinitions());

    // Infrastructure tools (cloud sandboxes, domains, wallet, x402 payments)
    // Only add when infrastructure is enabled in settings
    try {
      const infraSettings = InfraSettingsManager.loadSettings();
      if (infraSettings.enabled) {
        allTools.push(...InfraTools.getToolDefinitions(infraSettings));
      }
    } catch {
      // InfraSettingsManager may not be initialized yet
    }

    // Canvas/visual tools require a desktop UI; skip in headless mode (VPS/server).
    if (!headless) {
      allTools.push(...CanvasTools.getToolDefinitions());
      allTools.push(...VisualTools.getToolDefinitions());
    }

    // Knowledge graph tools (entity/relationship management) — only when initialized
    if (KnowledgeGraphTools.isEnabled()) {
      allTools.push(...KnowledgeGraphTools.getToolDefinitions());
    }

    // Memory tools (explicit save during task execution)
    allTools.push(...MemoryTools.getToolDefinitions());
    if (SupermemoryTools.isEnabled()) {
      allTools.push(...SupermemoryTools.getToolDefinitions());
    }

    // Scraping tools (Scrapling integration - anti-bot, stealth, structured extraction)
    // Only add when scraping is enabled in settings
    if (ScrapingTools.isEnabled()) {
      allTools.push(...ScrapingTools.getToolDefinitions());
    }

    // Document generation tools (PDF, PPTX, XLSX)
    allTools.push(...DocumentTools.getToolDefinitions());

    // Mermaid diagram tool (renders diagrams in the UI)
    allTools.push(this.getMermaidDiagramToolDefinition());

    // Session scratchpad tools (agent self-notes during long runs)
    allTools.push(...ScratchpadTools.getToolDefinitions());

    // Playwright QA tools (automated visual testing for web apps)
    allTools.push(...QATools.getToolDefinitions());

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
    const builtinToolNames = new Set(allTools.map((t) => t.name));

    // Add MCP tools from connected servers, filtering out those that shadow built-in tools
    const settings = MCPSettingsManager.loadSettings();
    const prefix = settings.toolNamePrefix || "mcp_";
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
      console.log(
        `[ToolRegistry] Skipped ${shadowedTools.length} MCP tools that shadow built-in tools:`,
        shadowedTools.join(", "),
      );
      this.shadowedToolsLogged = true;
    }

    // Filter tools based on security policy (workspace + gateway context)
    let filteredTools = allTools.filter((tool) => this.isToolAllowed(tool.name));

    // Filter tools based on user's built-in tool settings
    const disabledBySettings: string[] = [];
    filteredTools = filteredTools.filter((tool) => {
      // MCP tools are not affected by built-in settings
      if (tool.name.startsWith(prefix)) {
        return true;
      }
      // Meta tools are always enabled
      if (
        [
          "revise_plan",
          "request_user_input",
          "task_list_create",
          "task_list_update",
          "task_list_list",
          "task_history",
          "set_personality",
          "set_persona",
          "set_agent_name",
          "set_user_name",
          "set_response_style",
          "set_quirks",
          "add_behavioral_rule",
          "set_expertise",
          "set_vibes",
          "update_lore",
          "manage_heartbeat",
          "integration_setup",
          "spawn_agent",
          "wait_for_agent",
          "get_agent_status",
          "get_orchestration_status",
          "list_agents",
          "send_agent_message",
          "capture_agent_events",
          "cancel_agent",
          "pause_agent",
          "resume_agent",
        ].includes(tool.name)
      ) {
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
    const blockedTools = allTools.filter((tool) => !this.isToolAllowed(tool.name));
    if (blockedTools.length > 0 && this.gatewayContext) {
      console.log(
        `[ToolRegistry] Blocked ${blockedTools.length} tools for ${this.gatewayContext} context:`,
        blockedTools.map((t) => t.name).join(", "),
      );
    }
    if (disabledBySettings.length > 0) {
      console.log(
        `[ToolRegistry] Disabled ${disabledBySettings.length} tools by user settings:`,
        disabledBySettings.join(", "),
      );
    }

    // Sort tools by priority (high first, then normal, then low)
    // This helps influence which tools the LLM is more likely to choose
    const priorityOrder = { high: 0, normal: 1, low: 2 };
    const sortedTools = filteredTools.sort((a, b) => {
      // MCP tools always come after built-in tools at the same priority
      const aIsMcp = a.name.startsWith(prefix);
      const bIsMcp = b.name.startsWith(prefix);

      const aPriority = aIsMcp ? "normal" : BuiltinToolsSettingsManager.getToolPriority(a.name);
      const bPriority = bIsMcp ? "normal" : BuiltinToolsSettingsManager.getToolPriority(b.name);

      const diff = priorityOrder[aPriority] - priorityOrder[bPriority];
      if (diff !== 0) return diff;

      // Within same priority, put built-in tools first
      if (aIsMcp && !bIsMcp) return 1;
      if (!aIsMcp && bIsMcp) return -1;

      return 0;
    });

    const toolsWithRuntime = withRuntimeToolMetadataList(sortedTools);
    const toolsWithPrompting = withToolPromptMetadataList(toolsWithRuntime);
    this.validateToolSemanticsInvariant(toolsWithPrompting);
    this.cachedToolDefinitionsKey = cacheKey;
    this.cachedToolDefinitions = toolsWithPrompting.slice();
    return toolsWithPrompting.slice();
  }

  getRuntimeMetadata(toolName: string) {
    return (
      this.getTools().find((tool) => tool.name === toolName)?.runtime ||
      getDefaultRuntimeToolMetadata(toolName)
    );
  }

  getApprovalType(toolName: string, input?: Any): ApprovalType | null {
    return this.getApprovalTypeForTool(toolName, input);
  }

  getMcpServerName(toolName: string): string | null {
    const settings = MCPSettingsManager.loadSettings();
    const prefix = settings.toolNamePrefix || "mcp_";
    if (!toolName.startsWith(prefix)) return null;
    const rawToolName = toolName.slice(prefix.length);
    try {
      const manager = MCPClientManager.getInstance();
      const serverId = manager.getServerIdForTool(rawToolName);
      if (!serverId) return null;
      const server = MCPSettingsManager.getServer(serverId);
      return server?.name || null;
    } catch {
      return null;
    }
  }

  private isReadOnlyHttpRequestInput(input: Any): boolean {
    const method =
      typeof input?.method === "string" && input.method.trim().length > 0
        ? input.method.trim().toUpperCase()
        : "GET";
    const hasBody = typeof input?.body === "string" && input.body.trim().length > 0;
    const headers =
      input?.headers && typeof input.headers === "object" && !Array.isArray(input.headers)
        ? Object.keys(input.headers as Record<string, unknown>)
        : [];
    const loweredHeaders = headers.map((header) => header.toLowerCase());
    const customHeaders = loweredHeaders.filter(
      (header) => !["accept", "accept-language", "user-agent"].includes(header),
    );
    return (method === "GET" || method === "HEAD") && !hasBody && customHeaders.length === 0;
  }

  private getApprovalTypeForTool(toolName: string, input?: Any): ApprovalType | null {
    const canonicalToolName = canonicalizeToolNameUtil(toolName);
    if (canonicalToolName === "Skill") return null;
    if (canonicalToolName === "run_command") return "run_command";
    if (canonicalToolName === "delete_file") return "delete_file";
    if (canonicalToolName === "web_fetch") return "network_access";
    if (canonicalToolName === "http_request") {
      return this.isReadOnlyHttpRequestInput(input) ? "network_access" : "data_export";
    }
    if (canonicalToolName === "analyze_image" || canonicalToolName === "read_pdf_visual") {
      return "data_export";
    }
    if (canonicalToolName.startsWith("mcp_")) return "external_service";
    if (canonicalToolName.endsWith("_action") || canonicalToolName === "voice_call")
      return "external_service";
    if (isComputerUseToolName(canonicalToolName)) return "computer_use";
    if (NETWORK_READ_TOOL_NAMES.has(canonicalToolName)) return null;
    return null;
  }

  private toolHandlesApprovalInternally(toolName: string): boolean {
    return (
      toolName === "run_command" ||
      toolName === "delete_file" ||
      toolName === "run_applescript" ||
      toolName === "mcp_x402_fetch" ||
      toolName.endsWith("_action") ||
      toolName === "voice_call" ||
      isComputerUseToolName(toolName)
    );
  }

  getSchedulerSpec(toolName: string, input: Any): RuntimeToolSchedulerSpec {
    const runtime = this.getRuntimeMetadata(toolName);
    const override = this.handlerRegistry.resolveSchedulerSpec(toolName, input);
    return resolveRuntimeToolSchedulerSpec(
      {
        toolName,
        input,
        runtime,
      },
      override,
    );
  }

  getDeferredTools(): LLMTool[] {
    return this.getTools().filter((tool) => tool.runtime?.deferLoad && !tool.runtime?.alwaysExpose);
  }

  searchDeferredTools(query: string, limit = 8): {
    query: string;
    matches: Array<{ name: string; description: string; score: number }>;
  } {
    const searchService = new ToolSearchService(this.getDeferredTools());
    return {
      query,
      matches: searchService.search(query, limit),
    };
  }

  private buildExecutionMiddlewares(): ToolExecutionMiddleware[] {
    const policyMiddleware: ToolExecutionMiddleware = async (context, next) => {
      const runtime = this.getRuntimeMetadata(context.request.name);
      const approvalType = this.getApprovalTypeForTool(context.request.name, context.request.input);
      const permissionEvaluation = (this.daemon as Any)?.evaluateToolPermission;
      const serverName = this.getMcpServerName(context.request.name);
      const pipeline = await evaluateToolPolicyPipeline({
        workspace: this.workspace,
        toolName: context.request.name,
        toolInput: context.request.input,
        gatewayContext: this.gatewayContext,
        policyContext: context.request.runtime?.toolPolicyContext as Any,
        approvalRequired: runtime.approvalKind !== "none" && runtime.approvalKind !== "workspace_policy"
          ? false
          : false,
        permissionEvaluation:
          typeof permissionEvaluation === "function"
            ? () =>
                permissionEvaluation.call(this.daemon, this.taskId, {
                  ...(approvalType ? { approvalType } : {}),
                  toolName: context.request.name,
                  details: {
                    tool: context.request.name,
                    params: context.request.input ?? null,
                    ...(serverName ? { serverName } : {}),
                  },
                })
            : undefined,
      });

      if (pipeline.decision === "deny") {
        const reason = pipeline.reason ? `: ${pipeline.reason}` : "";
        throw Object.assign(new Error(`Tool "${context.request.name}" blocked by policy${reason}`), {
          policyTrace: pipeline.trace,
        });
      }

      if (pipeline.decision === "require_approval") {
        if (this.toolHandlesApprovalInternally(context.request.name)) {
          const result = await next(context);
          return {
            result,
            policyTrace: pipeline.trace,
          };
        }
        const requester = (this.daemon as Any)?.requestApproval;
        if (typeof requester !== "function") {
          throw Object.assign(
            new Error(
              `Tool "${context.request.name}" requires approval, but approval system is unavailable in this context`,
            ),
            { policyTrace: pipeline.trace },
          );
        }
        const approved = await requester.call(
          this.daemon,
          this.taskId,
          approvalType || "external_service",
          `Approve tool call: ${context.request.name}`,
          {
            tool: context.request.name,
            params: context.request.input ?? null,
            reason: pipeline.reason || null,
            ...(serverName ? { serverName } : {}),
          },
        );
        if (approved !== true) {
          throw Object.assign(new Error(`Tool "${context.request.name}" approval denied`), {
            policyTrace: pipeline.trace,
          });
        }
      }

      const result = await next(context);
      return {
        result,
        policyTrace: pipeline.trace,
      };
    };

    return [policyMiddleware];
  }

  private executeWithRegisteredHandler(name: string, input: Any): Promise<Any> {
    const handler = composeToolMiddleware(
      (context: ToolExecutionContext) => this.handlerRegistry.execute(name, context),
      this.executionMiddlewares,
    );
    return handler({
      request: {
        name,
        input,
      },
    });
  }

  private registerRuntimeHandlers(): void {
    const register = (
      name: string,
      handler: ToolExecutionHandler,
      schedulerSpecResolver?: ReturnType<typeof createStaticRuntimeToolSchedulerSpecResolver>,
    ) => {
      this.handlerRegistry.register(name, handler, schedulerSpecResolver);
    };
    const registerPredicate = (
      matches: (name: string) => boolean,
      handler: ToolExecutionHandler,
      schedulerSpecResolver?: ReturnType<typeof createStaticRuntimeToolSchedulerSpecResolver>,
    ) => {
      this.handlerRegistry.registerPredicate(matches, handler, schedulerSpecResolver);
    };

    const exclusiveSchedulerSpec = createStaticRuntimeToolSchedulerSpecResolver({
      concurrencyClass: "exclusive",
      readOnly: false,
      idempotent: false,
    });
    const serialSchedulerSpec = createStaticRuntimeToolSchedulerSpecResolver({
      concurrencyClass: "serial_only",
      idempotent: false,
    });
    const readParallelSchedulerSpec = createStaticRuntimeToolSchedulerSpecResolver({
      concurrencyClass: "read_parallel",
      readOnly: true,
      idempotent: true,
    });

    register(
      "read_file",
      async ({ request }) =>
        this.fileTools.readFile(request.input.path, {
          startChar: request.input.startChar,
          maxChars: request.input.maxChars,
        }),
      readParallelSchedulerSpec,
    );
    register(
      "read_files",
      async ({ request }) =>
        readFilesByPatterns(request.input, {
          globTools: this.globTools,
          fileTools: this.fileTools,
        }),
      readParallelSchedulerSpec,
    );
    register(
      "write_file",
      async ({ request }) =>
        this.fileTools.writeFile(request.input.path, request.input.content),
      exclusiveSchedulerSpec,
    );
    register(
      "copy_file",
      async ({ request }) =>
        this.fileTools.copyFile(request.input.sourcePath, request.input.destPath),
      exclusiveSchedulerSpec,
    );
    register("list_directory", async ({ request }) => this.fileTools.listDirectory(request.input.path), readParallelSchedulerSpec);
    register(
      "list_directory_with_sizes",
      async ({ request }) =>
        this.fileTools.listDirectoryWithSizes(request.input.path),
      readParallelSchedulerSpec,
    );
    register("get_file_info", async ({ request }) => this.fileTools.getFileInfo(request.input.path), readParallelSchedulerSpec);
    register(
      "rename_file",
      async ({ request }) =>
        this.fileTools.renameFile(request.input.oldPath, request.input.newPath),
      exclusiveSchedulerSpec,
    );
    register("delete_file", async ({ request }) => this.fileTools.deleteFile(request.input.path), exclusiveSchedulerSpec);
    register("create_directory", async ({ request }) => this.fileTools.createDirectory(request.input.path), exclusiveSchedulerSpec);
    register(
      "search_files",
      async ({ request }) =>
        this.fileTools.searchFiles(request.input.query, request.input.path),
      readParallelSchedulerSpec,
    );
    register("create_spreadsheet", async ({ request }) => this.skillTools.createSpreadsheet(request.input));
    register("create_document", async ({ request }) => this.skillTools.createDocument(request.input));
    register("edit_document", async ({ request }) => this.skillTools.editDocument(request.input));
    register("edit_pdf_region", async ({ request }) => this.skillTools.editPdfRegion(request.input));
    register("create_presentation", async ({ request }) => this.skillTools.createPresentation(request.input));
    register("organize_folder", async ({ request }) => this.skillTools.organizeFolder(request.input));
    register("skill_create", async ({ request }) => this.executeSkillCreate(request.input));
    register("skill_duplicate", async ({ request }) => this.executeSkillDuplicate(request.input));
    register("skill_update", async ({ request }) => this.executeSkillUpdate(request.input));
    register("skill_delete", async ({ request }) => this.executeSkillDelete(request.input));
    register("skill_proposal", async ({ request }) => this.executeSkillProposal(request.input));
    register("glob", async ({ request }) => this.globTools.glob(request.input), readParallelSchedulerSpec);
    register("grep", async ({ request }) => this.grepTools.grep(request.input), readParallelSchedulerSpec);
    register("edit_file", async ({ request }) => this.editTools.editFile(request.input), exclusiveSchedulerSpec);
    register("count_text", async ({ request }) => this.textTools.countText(request.input));
    register("text_metrics", async ({ request }) => this.textTools.textMetrics(request.input));
    register("monty_run", async ({ request }) => this.montyTools.montyRun(request.input));
    register("monty_list_transforms", async ({ request }) => this.montyTools.listTransforms(request.input));
    register("monty_run_transform", async ({ request }) => this.montyTools.runTransform(request.input));
    register("monty_transform_file", async ({ request }) => this.montyTools.transformFile(request.input));
    register("extract_json", async ({ request }) => this.montyTools.extractJson(request.input));
    register("web_fetch", async ({ request }) => {
      const result = await this.webFetchTools.webFetch(request.input);
      if (this.citationTracker) {
        this.citationTracker.addFromFetch(request.input.url, request.input.url);
      }
      return result;
    }, readParallelSchedulerSpec);
    register("http_request", async ({ request }) => this.webFetchTools.httpRequest(request.input), readParallelSchedulerSpec);
    register("web_search", async ({ request }) => {
      const result = await this.searchTools.webSearch(request.input);
      if (this.citationTracker && result && typeof result === "object") {
        this.citationTracker.addFromSearch((result as Any).results || []);
      }
      return result;
    }, readParallelSchedulerSpec);
    register("tool_search", async ({ request }) =>
      this.searchDeferredTools(request.input?.query || "", request.input?.limit),
    );
    registerPredicate(
      (name) => BrowserTools.isBrowserTool(name),
      async ({ request }) => this.browserTools.executeTool(request.name, request.input),
      serialSchedulerSpec,
    );
    registerPredicate(
      (name) => name.startsWith("qa_"),
      async ({ request }) => this.qaTools.execute(request.name, request.input),
      serialSchedulerSpec,
    );
    register("x_action", async ({ request }) => this.xTools.executeAction(request.input));
    register("notion_action", async ({ request }) => this.notionTools.executeAction(request.input));
    register("box_action", async ({ request }) => this.boxTools.executeAction(request.input));
    register("onedrive_action", async ({ request }) => this.oneDriveTools.executeAction(request.input));
    register("google_drive_action", async ({ request }) =>
      this.googleDriveTools.executeAction(request.input),
    );
    register("gmail_action", async ({ request }) => this.gmailTools.executeAction(request.input));
    register("mailbox_action", async ({ request }) => {
      if (!this.mailboxTools) {
        throw new Error("Mailbox tools unavailable (database not accessible)");
      }
      return await this.mailboxTools.executeAction(request.input);
    });
    register("calendar_action", async ({ request }) =>
      this.googleCalendarTools.executeAction(request.input),
    );
    register("apple_calendar_action", async ({ request }) =>
      this.appleCalendarTools.executeAction(request.input),
    );
    register("apple_reminders_action", async ({ request }) =>
      this.appleRemindersTools.executeAction(request.input),
    );
    register("dropbox_action", async ({ request }) => this.dropboxTools.executeAction(request.input));
    register("sharepoint_action", async ({ request }) =>
      this.sharePointTools.executeAction(request.input),
    );
    register("voice_call", async ({ request }) => this.voiceCallTools.executeAction(request.input));
    register(
      "run_command",
      async ({ request }) =>
        this.shellTools.runCommand(request.input.command, request.input),
      exclusiveSchedulerSpec,
    );
    register("git_status", async () => this.gitTools.gitStatus());
    register("git_diff", async ({ request }) => this.gitTools.gitDiff(request.input));
    register("git_commit", async ({ request }) => this.gitTools.gitCommit(request.input));
    register("git_merge_to_base", async () => this.gitTools.gitMergeToBase());
    register("system_info", async () => this.systemTools.getSystemInfo());
    register("search_memories", async ({ request }) => this.systemTools.searchMemories(request.input));
    register("search_quotes", async ({ request }) => this.systemTools.searchQuotes(request.input), readParallelSchedulerSpec);
    register("search_sessions", async ({ request }) => this.systemTools.searchSessions(request.input), readParallelSchedulerSpec);
    register("memory_topics_load", async ({ request }) => this.systemTools.loadMemoryTopics(request.input), readParallelSchedulerSpec);
    register("memory_save", async ({ request }) => this.memoryTools.save(request.input));
    register("memory_curate", async ({ request }) => this.memoryTools.curate(request.input), exclusiveSchedulerSpec);
    register("memory_curated_read", async ({ request }) => this.memoryTools.readCurated(request.input), readParallelSchedulerSpec);
    if (SupermemoryTools.isEnabled()) {
      register("supermemory_profile", async ({ request }) => this.supermemoryTools.profile(request.input), readParallelSchedulerSpec);
      register("supermemory_search", async ({ request }) => this.supermemoryTools.search(request.input), readParallelSchedulerSpec);
      register("supermemory_remember", async ({ request }) => this.supermemoryTools.remember(request.input), exclusiveSchedulerSpec);
      register("supermemory_forget", async ({ request }) => this.supermemoryTools.forget(request.input), exclusiveSchedulerSpec);
    }
    register("scratchpad_write", async ({ request }) => this.scratchpadTools.write(request.input));
    register("scratchpad_read", async ({ request }) => this.scratchpadTools.read(request.input));
    register("read_clipboard", async () => this.systemTools.readClipboard());
    register("write_clipboard", async ({ request }) => this.systemTools.writeClipboard(request.input.text));
    register("take_screenshot", async ({ request }) => this.systemTools.takeScreenshot(request.input));
    register(
      "screen_context_resolve",
      async ({ request }) => {
        const query = typeof request.input?.query === "string" ? request.input.query : "";
        const limit =
          typeof request.input?.limit === "number" && Number.isFinite(request.input.limit)
            ? Math.max(1, Math.min(5, Math.round(request.input.limit)))
            : 3;
        const matches = await ChronicleCaptureService.getInstance().queryRecentContext({
          query,
          limit,
          useFallback: request.input?.useFallback !== false,
        });

        const evidenceRefs: EvidenceRef[] = [];
        const persistedResults = await Promise.all(
          matches.map(async (match) => {
            try {
              const record = await ChronicleObservationRepository.promote(this.workspace.path, {
                workspaceId: this.workspace.id,
                taskId: this.taskId,
                query,
                observation: match,
                destinationHints: this.deriveChronicleDestinationHints(match),
              });
              if (!record) {
                return match;
              }
              const generatedMemory = await ChronicleMemoryService.getInstance().notePromotedObservation(
                this.workspace.path,
                record,
              );
              evidenceRefs.push({
                evidenceId: record.id,
                sourceType: "screen_context",
                sourceUrlOrPath: record.imagePath,
                snippet: [record.appName, record.windowTitle, record.localTextSnippet]
                  .filter(Boolean)
                  .join(" - ")
                  .slice(0, 240),
                capturedAt: record.capturedAt,
              });
              return {
                ...match,
                observationId: record.id,
                imagePath: record.imagePath,
                sourceRef: record.sourceRef,
                provenance: record.provenance,
                ...(generatedMemory ? { memoryId: generatedMemory.id } : {}),
              };
            } catch {
              return match;
            }
          }),
        );

        if (evidenceRefs.length > 0) {
          this.daemon.logEvent(this.taskId, "timeline_evidence_attached", {
            evidenceRefs,
            status: "completed",
            actor: "agent",
            message: `Attached ${evidenceRefs.length} Chronicle screen-context evidence reference(s)`,
            legacyType: "citations_collected",
          });
        }

        return {
          success: true,
          results: persistedResults,
          usedFallback: persistedResults.some((result) => result.usedFallback),
        };
      },
      readParallelSchedulerSpec,
    );
    register("open_application", async ({ request }) => this.systemTools.openApplication(request.input.appName));
    register("open_url", async ({ request }) => this.systemTools.openUrl(request.input.url));
    register("open_path", async ({ request }) => this.systemTools.openPath(request.input.path));
    register("show_in_folder", async ({ request }) => this.systemTools.showInFolder(request.input.path));
    register("get_env", async ({ request }) => this.systemTools.getEnvVariable(request.input.name));
    register("get_app_paths", async () => this.systemTools.getAppPaths());
    register("run_applescript", async ({ request }) => this.systemTools.runAppleScript(request.input.script), exclusiveSchedulerSpec);
    register("generate_image", async ({ request }) => this.imageTools.generateImage(request.input));
    register("generate_video", async ({ request }) => this.videoTools.generateVideo(request.input));
    register("get_video_generation_job", async ({ request }) =>
      this.videoTools.getVideoGenerationJob(request.input),
    );
    register("cancel_video_generation_job", async ({ request }) =>
      this.videoTools.cancelVideoGenerationJob(request.input),
    );
    register("analyze_image", async ({ request }) => this.visionTools.analyzeImage(request.input));
    register("read_pdf_visual", async ({ request }) => this.visionTools.readPdfVisual(request.input));
    register(
      "screenshot",
      async ({ request }) =>
        this.computerUseTools.screenshot({
          app: request.input.app,
          windowTitle: request.input.windowTitle,
        }),
      serialSchedulerSpec,
    );
    register(
      "click",
      async ({ request }) =>
        this.computerUseTools.click(
          request.input.x,
          request.input.y,
          request.input.button,
          request.input.captureId,
        ),
      serialSchedulerSpec,
    );
    register(
      "double_click",
      async ({ request }) =>
        this.computerUseTools.doubleClick(
          request.input.x,
          request.input.y,
          request.input.captureId,
        ),
      serialSchedulerSpec,
    );
    register(
      "move_mouse",
      async ({ request }) =>
        this.computerUseTools.moveMouse(
          request.input.x,
          request.input.y,
          request.input.captureId,
        ),
      serialSchedulerSpec,
    );
    register(
      "drag",
      async ({ request }) => this.computerUseTools.drag(request.input.path, request.input.captureId),
      serialSchedulerSpec,
    );
    register(
      "scroll",
      async ({ request }) =>
        this.computerUseTools.scroll(
          request.input.x,
          request.input.y,
          request.input.scrollX,
          request.input.scrollY,
          request.input.captureId,
        ),
      serialSchedulerSpec,
    );
    register(
      "type_text",
      async ({ request }) => this.computerUseTools.typeText(request.input.text),
      serialSchedulerSpec,
    );
    register(
      "keypress",
      async ({ request }) => this.computerUseTools.pressKeys(request.input.keys),
      serialSchedulerSpec,
    );
    register(
      "wait",
      async ({ request }) => this.computerUseTools.wait(request.input.ms),
      serialSchedulerSpec,
    );
    register("batch_image_process", async ({ request }) => this.batchImageTools.batchProcess(request.input));
    register("schedule_task", async ({ request }) => this.cronTools.executeAction(request.input));
    registerPredicate(
      (name) =>
        name.startsWith("cloud_sandbox_") ||
        name.startsWith("domain_") ||
        name.startsWith("wallet_") ||
        name.startsWith("x402_") ||
        name === "infra_status",
      async ({ request }) => this.infraTools.executeTool(request.name, request.input),
      serialSchedulerSpec,
    );
    register("canvas_create", async ({ request }) => this.canvasTools.createCanvas(request.input.title), serialSchedulerSpec);
    register("canvas_push", async ({ request }) => {
      const canvasInput = request.input || {};
      const rawSessionId = canvasInput.session_id;
      const inferredSessionId = rawSessionId || this.getLatestCanvasSessionId();
      if (!canvasInput.session_id && inferredSessionId) {
        canvasInput.session_id = inferredSessionId;
      }
      try {
        return await this.canvasTools.pushContent(
          canvasInput.session_id,
          canvasInput.content,
          canvasInput.filename,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown canvas push error";
        this.daemon.logEvent(this.taskId, "tool_error", {
          tool: "canvas_push",
          error: message,
          softFailure: true,
        });
        return {
          success: true,
          warning:
            "Canvas preview could not be refreshed right now, but execution can continue without it.",
          fallback: true,
        };
      }
    }, serialSchedulerSpec);
    register(
      "canvas_open_url",
      async ({ request }) =>
        this.canvasTools.openUrl(
          request.input.session_id,
          request.input.url,
          request.input.show,
        ),
      serialSchedulerSpec,
    );
    register("canvas_show", async ({ request }) => this.canvasTools.showCanvas(request.input.session_id), serialSchedulerSpec);
    register("canvas_hide", async ({ request }) => this.canvasTools.hideCanvas(request.input.session_id), serialSchedulerSpec);
    register("canvas_close", async ({ request }) => this.canvasTools.closeCanvas(request.input.session_id), serialSchedulerSpec);
    register(
      "canvas_eval",
      async ({ request }) =>
        this.canvasTools.evalScript(request.input.session_id, request.input.script),
      serialSchedulerSpec,
    );
    register(
      "canvas_snapshot",
      async ({ request }) =>
        this.canvasTools.takeSnapshot(request.input.session_id),
      serialSchedulerSpec,
    );
    register("canvas_list", async () => this.canvasTools.listSessions(), serialSchedulerSpec);
    register(
      "canvas_checkpoint",
      async ({ request }) =>
        this.canvasTools.saveCheckpoint(request.input.session_id, request.input.label),
      serialSchedulerSpec,
    );
    register(
      "canvas_restore",
      async ({ request }) =>
        this.canvasTools.restoreCheckpoint(
          request.input.session_id,
          request.input.checkpoint_id,
        ),
      serialSchedulerSpec,
    );
    register(
      "canvas_checkpoints",
      async ({ request }) =>
        this.canvasTools.listCheckpoints(request.input.session_id),
      serialSchedulerSpec,
    );
    register("visual_open_annotator", async ({ request }) =>
      this.visualTools.openImageAnnotator(request.input),
    );
    register("visual_update_annotator", async ({ request }) =>
      this.visualTools.updateImageAnnotator(request.input),
    );
    register("channel_list_chats", async ({ request }) => {
      if (!this.channelTools) {
        throw new Error("Channel history tools unavailable (database not accessible)");
      }
      return await this.channelTools.listChats(request.input);
    });
    register("channel_history", async ({ request }) => {
      if (!this.channelTools) {
        throw new Error("Channel history tools unavailable (database not accessible)");
      }
      return await this.channelTools.channelHistory(request.input);
    });
    register("channel_fetch_discord_messages", async ({ request }) => {
      if (!this.channelTools) {
        throw new Error("Channel tools unavailable (database not accessible)");
      }
      return await this.channelTools.fetchDiscordMessages(request.input);
    });
    register("channel_download_discord_attachment", async ({ request }) => {
      if (!this.channelTools) {
        throw new Error("Channel tools unavailable (database not accessible)");
      }
      return await this.channelTools.downloadDiscordAttachment(request.input);
    });
    register("email_imap_unread", async ({ request }) => {
      if (!this.emailImapTools) {
        throw new Error("Email IMAP tools unavailable (database not accessible)");
      }
      return await this.emailImapTools.listUnread(request.input);
    });
    register("list_agent_roles", async () => this.mentionTools.listAgentRoles());
    register("mention_agent", async ({ request }) => this.mentionTools.mentionAgent(request.input));
    register("get_pending_mentions", async () => this.mentionTools.getPendingMentions());
    register("acknowledge_mention", async ({ request }) =>
      this.mentionTools.acknowledgeMention(request.input.mentionId),
    );
    register("complete_mention", async ({ request }) =>
      this.mentionTools.completeMention(request.input.mentionId),
    );
    register("generate_document", async ({ request }) => this.documentTools.generateDocument(request.input));
    register("compile_latex", async ({ request }) => this.documentTools.compileLatex(request.input));
    register("generate_presentation", async ({ request }) =>
      this.documentTools.generatePresentation(request.input),
    );
    register("generate_spreadsheet", async ({ request }) =>
      this.documentTools.generateSpreadsheet(request.input),
    );
    register("generate_epub", async ({ request }) => this.documentTools.generateEPUB(request.input));
    register("generate_landing_page", async ({ request }) =>
      this.documentTools.generateLandingPage(request.input),
    );
    register("generate_narration_audio", async ({ request }) =>
      this.documentTools.generateNarrationAudio(request.input),
    );
    register("create_diagram", async ({ request }) => {
      const title = typeof request.input?.title === "string" ? request.input.title : "Diagram";
      const diagram = typeof request.input?.diagram === "string" ? request.input.diagram : "";
      if (!diagram.trim()) {
        return { success: false, error: "diagram is required and must be non-empty Mermaid syntax" };
      }
      const validation = await ToolRegistry.validateMermaidDiagram(diagram);
      if (!validation.success) {
        return {
          success: false,
          error: validation.error,
        };
      }
      this.daemon.logEvent(this.taskId, "diagram_created", { title, diagram });
      return {
        success: true,
        message: `Diagram "${title}" is now displayed in the UI.`,
        ...(validation.warning ? { warning: validation.warning } : {}),
      };
    });
    register("task_history", async ({ request }) => this.taskHistory(request.input));
    register("task_events", async ({ request }) => this.taskEvents(request.input));
    register("request_user_input", async ({ request }) => this.requestUserInput(request.input));
    register(
      "task_list_create",
      async ({ request }) => this.taskListCreate(request.input),
      serialSchedulerSpec,
    );
    register(
      "task_list_update",
      async ({ request }) => this.taskListUpdate(request.input),
      serialSchedulerSpec,
    );
    register(
      "task_list_list",
      async () => this.taskListList(),
      readParallelSchedulerSpec,
    );
    register("revise_plan", async ({ request }) => {
      if (!this.planRevisionHandler) {
        throw new Error("Plan revision not available at this time");
      }
      const newSteps = request.input.newSteps || [];
      const reason = request.input.reason || "No reason provided";
      const clearRemaining = request.input.clearRemaining || false;
      this.planRevisionHandler(newSteps, reason, clearRemaining);
      let message = "";
      if (clearRemaining) {
        message = "Plan revised: Cleared remaining steps. ";
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
    });
    register("switch_workspace", async ({ request }) => this.switchWorkspace(request.input));
    register("list_projects", async ({ request }) => {
      const projects = this.daemon.listProjects({
        includeArchived: request.input?.include_archived === true,
      });
      return {
        projects: projects.map((project: Any) => ({
          id: project.id,
          name: project.name,
          status: project.status,
          description: project.description ?? null,
        })),
      };
    });
    register("list_workspaces", async () => {
      const workspaces = this.daemon.listWorkspaces();
      return {
        workspaces: workspaces.map((workspace: Any) => ({
          id: workspace.id,
          name: workspace.name,
          path: workspace.path,
        })),
      };
    });
    register("link_project_workspace", async ({ request }) => {
      const { project_id, workspace_id, is_primary } = request.input as {
        project_id: string;
        workspace_id: string;
        is_primary?: boolean;
      };
      if (!project_id || !workspace_id) {
        return { success: false, error: "project_id and workspace_id are required" };
      }
      try {
        const link = this.daemon.linkProjectWorkspace({
          projectId: project_id,
          workspaceId: workspace_id,
          isPrimary: is_primary,
        });
        return {
          success: true,
          link: {
            id: link.id,
            projectId: link.projectId,
            workspaceId: link.workspaceId,
            isPrimary: link.isPrimary,
          },
        };
      } catch (err: Any) {
        return { success: false, error: err?.message ?? "Failed to link workspace" };
      }
    });
    register("list_goals", async ({ request }) => {
      const goals = this.daemon.listGoals(request.input?.company_id);
      return {
        goals: goals.map((goal: Any) => ({
          id: goal.id,
          title: goal.title,
          status: goal.status,
          description: goal.description ?? null,
        })),
      };
    });
    register("list_issues", async ({ request }) => {
      const issues = this.daemon.listIssues({
        projectId: request.input?.project_id,
        goalId: request.input?.goal_id,
        status: Array.isArray(request.input?.status) ? request.input.status : undefined,
        limit: typeof request.input?.limit === "number" ? request.input.limit : undefined,
      });
      return {
        issues: issues.map((issue: Any) => ({
          id: issue.id,
          title: issue.title,
          status: issue.status,
          priority: issue.priority,
          projectId: issue.projectId ?? null,
          goalId: issue.goalId ?? null,
          description: issue.description ?? null,
        })),
      };
    });
    register("create_issue", async ({ request }) => {
      if (!request.input?.title) {
        return { success: false, error: "title is required" };
      }
      try {
        const issue = this.daemon.createIssue({
          title: request.input.title,
          description: request.input.description,
          projectId: request.input.project_id,
          goalId: request.input.goal_id,
          status: request.input.status,
          priority: typeof request.input.priority === "number" ? request.input.priority : 2,
        });
        return {
          success: true,
          issue: {
            id: issue.id,
            title: issue.title,
            status: issue.status,
            priority: issue.priority,
            projectId: issue.projectId ?? null,
            goalId: issue.goalId ?? null,
          },
        };
      } catch (err: Any) {
        return { success: false, error: err?.message ?? "Failed to create issue" };
      }
    });
    register("integration_setup", async ({ request }) => this.integrationSetup(request.input));
    register("set_personality", async ({ request }) => this.setPersonality(request.input));
    register("set_agent_name", async ({ request }) => this.setAgentName(request.input));
    register("set_user_name", async ({ request }) => this.setUserName(request.input));
    register("set_persona", async ({ request }) => this.setPersona(request.input));
    register("set_response_style", async ({ request }) => this.setResponseStyle(request.input));
    register("set_quirks", async ({ request }) => this.setQuirks(request.input));
    register("add_behavioral_rule", async ({ request }) => this.addBehavioralRule(request.input));
    register("set_expertise", async ({ request }) => this.setExpertise(request.input));
    register("set_vibes", async ({ request }) => this.setVibes(request.input));
    register("update_lore", async ({ request }) => this.updateLore(request.input));
    register("manage_heartbeat", async ({ request }) => this.manageHeartbeat(request.input));
    register("execute_code", async ({ request }) => this.executeCode(request.input));
    register("parse_document", async ({ request }) => this.parseDocument(request.input));
    register("acp_discover", async ({ request }) => this.acpDiscover(request.input));
    register("Skill", async ({ request }) => this.executeSkillCommand(request.input));
    register("spawn_agent", async ({ request }) => this.spawnAgent(request.input), exclusiveSchedulerSpec);
    register("wait_for_agent", async ({ request }) => this.waitForAgent(request.input));
    register("orchestrate_agents", async ({ request }) => this.orchestrateAgents(request.input), exclusiveSchedulerSpec);
    register("get_agent_status", async ({ request }) => this.getAgentStatus(request.input));
    register("list_agents", async ({ request }) => this.listAgents(request.input));
    register("send_agent_message", async ({ request }) => this.sendAgentMessage(request.input), exclusiveSchedulerSpec);
    register("capture_agent_events", async ({ request }) => this.captureAgentEvents(request.input));
    register("cancel_agent", async ({ request }) => this.cancelAgent(request.input), exclusiveSchedulerSpec);
    register("pause_agent", async ({ request }) => this.pauseAgent(request.input), exclusiveSchedulerSpec);
    register("resume_agent", async ({ request }) => this.resumeAgent(request.input), exclusiveSchedulerSpec);
    registerPredicate((name) => KnowledgeGraphTools.isKnowledgeGraphTool(name), async ({ request }) =>
      this.knowledgeGraphTools.executeTool(request.name, request.input),
    );
    registerPredicate(
      (name) => {
        const settings = MCPSettingsManager.loadSettings();
        const prefix = settings.toolNamePrefix || "mcp_";
        return name.startsWith(prefix);
      },
      async ({ request }) => this.tryExecuteMCPTool(request.name, request.input),
    );
  }

  /**
   * Get MCP tools from connected servers
   */
  private getMCPToolDefinitions(): LLMTool[] {
    try {
      const mcpManager = MCPClientManager.getInstance();
      const mcpTools = mcpManager.getAllTools();
      const settings = MCPSettingsManager.loadSettings();
      const prefix = settings.toolNamePrefix || "mcp_";
      const serverNamesById = new Map(
        (settings.servers || []).map((server) => [server.id, server.name]),
      );

      return mcpTools.map((tool: { name: string; description?: string; inputSchema: Any }) => {
        const serverId =
          typeof (mcpManager as Any).getServerIdForTool === "function"
            ? (mcpManager as Any).getServerIdForTool(tool.name)
            : null;
        const serverName = serverId ? serverNamesById.get(serverId) : null;
        const baseDescription = tool.description || `MCP tool: ${tool.name}`;

        return {
          name: `${prefix}${tool.name}`,
          description: serverName
            ? `${baseDescription} Provided by MCP server "${serverName}".`
            : baseDescription,
          input_schema: tool.inputSchema,
        };
      });
    } catch  {
      // MCP not initialized yet, return empty array
      return [];
    }
  }

  /**
   * Callback for handling plan revisions (set by executor)
   */
  private planRevisionHandler?: (
    newSteps: Array<{ description: string }>,
    reason: string,
    clearRemaining: boolean,
  ) => void;

  /**
   * Set the callback for handling plan revisions
   */
  setPlanRevisionHandler(
    handler: (
      newSteps: Array<{ description: string }>,
      reason: string,
      clearRemaining: boolean,
    ) => void,
  ): void {
    this.planRevisionHandler = handler;
  }

  setTaskListHandler(handler: {
    create: (items: SessionChecklistToolItemInput[]) => SessionChecklistState;
    update: (items: SessionChecklistToolItemInput[]) => SessionChecklistState;
    list: () => SessionChecklistState;
  }): void {
    this.taskListHandler = handler;
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
        error: "Either path or workspace_id must be provided",
      };
    }

    if (!this.workspaceSwitchHandler) {
      return {
        success: false,
        error: "Workspace switching is not available in this context",
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
          const pathModule = await import("path");
          const fsModule = await import("fs");

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
          error: "Failed to find or create workspace",
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
    } catch (error: Any) {
      return {
        success: false,
        error: error.message || "Failed to switch workspace",
      };
    }
  }

  /**
   * Query prior task history from the local database.
   * This is a privacy-sensitive tool; it may be blocked in shared gateway contexts.
   */
  private taskHistory(input: {
    period: "today" | "yesterday" | "last_7_days" | "last_30_days" | "custom";
    from?: string;
    to?: string;
    limit?: number;
    workspace_id?: string;
    query?: string;
    include_messages?: boolean;
  }): Any {
    const period = input?.period;
    const allowed: Array<typeof period> = [
      "today",
      "yesterday",
      "last_7_days",
      "last_30_days",
      "custom",
    ];
    if (!period || !allowed.includes(period)) {
      throw new Error(`Invalid period. Expected one of: ${allowed.join(", ")}`);
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
    period: "today" | "yesterday" | "last_7_days" | "last_30_days" | "custom";
    from?: string;
    to?: string;
    limit?: number;
    workspace_id?: string;
    types?: string[];
    include_payload?: boolean;
  }): Any {
    const period = input?.period;
    const allowed: Array<typeof period> = [
      "today",
      "yesterday",
      "last_7_days",
      "last_30_days",
      "custom",
    ];
    if (!period || !allowed.includes(period)) {
      throw new Error(`Invalid period. Expected one of: ${allowed.join(", ")}`);
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

  private async requestUserInput(input: {
    questions: Array<{
      header: string;
      id: string;
      question: string;
      options: Array<{ label: string; description: string }>;
    }>;
  }): Promise<{
    requestId: string;
    status: "submitted";
    answers?: Record<string, { optionLabel?: string; otherText?: string }>;
  }> {
    const currentTask = await this.daemon.getTaskById(this.taskId);
    const mode = currentTask?.agentConfig?.executionMode ?? "execute";
    if (mode !== "plan" && mode !== "debug") {
      throw new Error(
        'Tool "request_user_input" is only available in plan or debug mode. Switch mode to plan or debug and retry.',
      );
    }

    const rawQuestions = Array.isArray(input?.questions) ? input.questions : [];
    if (rawQuestions.length < 1) {
      throw new Error("request_user_input expects at least 1 question.");
    }

    const toText = (value: unknown): string =>
      typeof value === "string" ? value.trim() : String(value ?? "").trim();

    const truncateHeader = (value: string): string => {
      const cleaned = toText(value);
      if (!cleaned) return "Question";
      return cleaned.slice(0, 12);
    };

    const toSnakeCaseId = (value: string, fallback: string): string => {
      const normalized = toText(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .replace(/_+/g, "_");
      const base = normalized || fallback;
      if (/^[a-z]/.test(base)) return base;
      return `q_${base.replace(/^[^a-z]+/g, "") || "choice"}`;
    };

    const ensureUniqueId = (candidate: string, usedIds: Set<string>): string => {
      let id = candidate;
      let suffix = 2;
      while (usedIds.has(id)) {
        id = `${candidate}_${suffix}`;
        suffix += 1;
      }
      usedIds.add(id);
      return id;
    };

    const normalizeOptions = (
      optionsInput: unknown,
    ): Array<{ label: string; description: string }> => {
      const rawOptions = Array.isArray(optionsInput) ? optionsInput : [];
      const normalized: Array<{ label: string; description: string }> = [];
      const seenLabels = new Set<string>();

      for (const option of rawOptions) {
        if (normalized.length >= 3) break;
        const label =
          typeof option === "string"
            ? toText(option)
            : toText((option as Any)?.label ?? (option as Any)?.value ?? (option as Any)?.name);
        const description =
          typeof option === "string"
            ? ""
            : toText((option as Any)?.description ?? (option as Any)?.details);
        if (!label) continue;
        const dedupeKey = label.toLowerCase();
        if (seenLabels.has(dedupeKey)) continue;
        seenLabels.add(dedupeKey);
        normalized.push({
          label,
          description: description || `Choose ${label.toLowerCase()} for this preference.`,
        });
      }

      if (normalized.length >= 1) {
        const hasRecommended = normalized.some((opt) => /\(recommended\)/i.test(opt.label));
        if (!hasRecommended) {
          normalized[0] = {
            ...normalized[0],
            label: `${normalized[0].label} (Recommended)`,
          };
        }
      }

      return normalized.slice(0, 3);
    };

    const usedIds = new Set<string>();
    const questions: Array<{
      header: string;
      id: string;
      question: string;
      options: Array<{ label: string; description: string }>;
    }> = [];

    for (let index = 0; index < rawQuestions.length; index += 1) {
      if (questions.length >= 3) break;
      const rawQuestion = rawQuestions[index] as Any;
      const questionText =
        toText(rawQuestion?.question) ||
        toText(rawQuestion?.prompt) ||
        toText(rawQuestion?.title) ||
        "Choose one option.";
      const header = truncateHeader(
        toText(rawQuestion?.header) || toText(rawQuestion?.id) || `Q${index + 1}`,
      );
      const idBase = toSnakeCaseId(
        toText(rawQuestion?.id),
        toSnakeCaseId(header || `q_${index + 1}`, `q_${index + 1}`),
      );
      const id = ensureUniqueId(idBase, usedIds);
      const options = normalizeOptions(rawQuestion?.options);
      if (options.length < 2) {
        continue;
      }
      questions.push({
        header,
        id,
        question: questionText,
        options,
      });
    }

    if (questions.length < 1) {
      throw new Error(
        "request_user_input could not normalize a valid payload. Provide at least one question with 2-3 options.",
      );
    }

    const response = await this.daemon.requestUserInput(this.taskId, { questions });
    if (response.status !== "submitted") {
      throw new Error("Structured input request dismissed by user; waiting for user guidance.");
    }
    return {
      requestId: response.requestId,
      status: response.status,
      answers: response.answers,
    };
  }

  private async getTaskExecutionMode(): Promise<string> {
    const currentTask = await this.daemon.getTaskById?.(this.taskId);
    return currentTask?.agentConfig?.executionMode ?? "execute";
  }

  private withImmediateTaskListReminder(state: SessionChecklistState): SessionChecklistState & {
    immediateReminder?: string;
  } {
    if (!state.verificationNudgeNeeded || !state.nudgeReason) {
      return state;
    }
    return {
      ...state,
      immediateReminder: `CHECKLIST REMINDER:\n- ${state.nudgeReason}`,
    };
  }

  private async taskListCreate(input: {
    items?: SessionChecklistToolItemInput[];
  }): Promise<SessionChecklistState & { immediateReminder?: string }> {
    const mode = await this.getTaskExecutionMode();
    if (mode !== "execute" && mode !== "verified" && mode !== "debug") {
      throw new Error(
        'Tool "task_list_create" is only available in execute, verified, or debug mode.',
      );
    }
    if (!this.taskListHandler) {
      throw new Error("Session checklist tools are not available in this context.");
    }
    return this.withImmediateTaskListReminder(
      this.taskListHandler.create(Array.isArray(input?.items) ? input.items : []),
    );
  }

  private async taskListUpdate(input: {
    items?: SessionChecklistToolItemInput[];
  }): Promise<SessionChecklistState & { immediateReminder?: string }> {
    const mode = await this.getTaskExecutionMode();
    if (mode !== "execute" && mode !== "verified" && mode !== "debug") {
      throw new Error(
        'Tool "task_list_update" is only available in execute, verified, or debug mode.',
      );
    }
    if (!this.taskListHandler) {
      throw new Error("Session checklist tools are not available in this context.");
    }
    return this.withImmediateTaskListReminder(
      this.taskListHandler.update(Array.isArray(input?.items) ? input.items : []),
    );
  }

  private async taskListList(): Promise<SessionChecklistState> {
    const mode = await this.getTaskExecutionMode();
    if (mode !== "execute" && mode !== "verified" && mode !== "debug") {
      throw new Error(
        'Tool "task_list_list" is only available in execute, verified, or debug mode.',
      );
    }
    if (!this.taskListHandler) {
      throw new Error("Session checklist tools are not available in this context.");
    }
    return this.taskListHandler.list();
  }

  /**
   * Get human-readable tool descriptions
   */
  getToolDescriptions(
    visibleTools?: string[],
    options?: {
      renderContext?: LLMToolPromptRenderContext;
      skillRoutingQuery?: string;
      skillShortlistSize?: number;
      skillLowConfidenceThreshold?: number;
      skillTextBudgetChars?: number;
    },
  ): string {
    const cacheKey = this.buildToolDescriptionsCacheKey(visibleTools, options);
    const cached = this.toolDescriptionsCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const visibleToolSet = visibleTools?.length
      ? new Set(visibleTools.map((tool) => tool.trim()).filter(Boolean))
      : null;
    const isVisible = (toolName: string): boolean =>
      !visibleToolSet || visibleToolSet.has(toolName);
    const hasAnyVisibleTools = (...toolNames: string[]): boolean =>
      !visibleToolSet || toolNames.some((toolName) => isVisible(toolName));

    if (visibleTools?.length) {
      const compactDescriptions = this.buildCompactToolDescriptions(visibleTools, options);
      this.toolDescriptionsCache.set(cacheKey, compactDescriptions);
      return compactDescriptions;
    }

    const googleWorkspaceEnabled =
      GmailTools.isEnabled() || GoogleCalendarTools.isEnabled() || GoogleDriveTools.isEnabled();
    const notionEnabled = NotionTools.isEnabled();
    const boxEnabled = BoxTools.isEnabled();
    const oneDriveEnabled = OneDriveTools.isEnabled();
    const dropboxEnabled = DropboxTools.isEnabled();
    const sharepointEnabled = SharePointTools.isEnabled();

    let emailChannelStatus = "unknown";
    try {
      // Some unit tests stub daemon as a plain object. Keep this best-effort.
      const dbGetter = (this.daemon as Any)?.getDatabase;
      if (typeof dbGetter === "function") {
        const channelRepo = new ChannelRepository(dbGetter.call(this.daemon));
        const emailChannel = channelRepo.findByType("email");
        if (!emailChannel) {
          emailChannelStatus = "not configured";
        } else {
          const enabledText = emailChannel.enabled ? "enabled" : "configured (disabled)";
          const statusText =
            typeof emailChannel.status === "string" && emailChannel.status.trim().length > 0
              ? emailChannel.status.trim()
              : "unknown";
          const hint =
            statusText === "error"
              ? " (currently failing to connect; check Settings > Channels > Email)"
              : "";
          emailChannelStatus = `${enabledText}, status=${statusText}${hint}`;
        }
      } else {
        emailChannelStatus = "unavailable (no database access in this context)";
      }
    } catch {
      emailChannelStatus = "unknown (failed to read local channel config)";
    }

    let descriptions = `
Integration Status:
- Google Workspace integration (gmail_action/calendar_action/google_drive_action): ${googleWorkspaceEnabled ? "ENABLED" : "DISABLED (enable in Settings > Integrations > Google Workspace)"}
- Notion integration (notion_action): ${notionEnabled ? "ENABLED" : "DISABLED (enable in Settings > Integrations > Notion)"}
- Box integration (box_action): ${boxEnabled ? "ENABLED" : "DISABLED (enable in Settings > Integrations > Box)"}
- OneDrive integration (onedrive_action): ${oneDriveEnabled ? "ENABLED" : "DISABLED (enable in Settings > Integrations > OneDrive)"}
- Dropbox integration (dropbox_action): ${dropboxEnabled ? "ENABLED" : "DISABLED (enable in Settings > Integrations > Dropbox)"}
- SharePoint integration (sharepoint_action): ${sharepointEnabled ? "ENABLED" : "DISABLED (enable in Settings > Integrations > SharePoint)"}
- Email channel (IMAP/SMTP): ${emailChannelStatus}

Cloud Storage Routing (CRITICAL):
- If the user says "on/in/from Box/Dropbox/OneDrive/Google Drive/SharePoint/Notion", treat it as a cloud connector request, NOT a local workspace path.
- Do NOT interpret provider names like "box" or "dropbox" as local directories.
- For cloud file inventory/listing requests, prefer connector tools first:
  - Box root list: box_action { action: "list_folder_items", folder_id: "0" }
  - OneDrive root list: onedrive_action { action: "list_children" }
  - Google Drive list: google_drive_action { action: "list_files" }
  - Dropbox root list: dropbox_action { action: "list_folder", path: "" }
  - SharePoint root list: sharepoint_action { action: "list_drive_items" } (requires configured drive/site)
  - Notion content discovery: notion_action { action: "search" }
- Use local file tools (list_directory/glob/read_file) only for the local workspace filesystem.

File Operations:
- read_file: Read contents of a file (supports plain text, DOCX, PDF, and PPTX; supports chunked reads via startChar/maxChars)
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
- generate_spreadsheet: Generate XLSX spreadsheets from structured sheets
- create_document: Create Word/PDF (only when user explicitly requests DOCX or PDF — otherwise use write_file with .md)
- generate_document: Generate PDF documents from markdown/sections
- compile_latex: Compile a workspace .tex file into PDF using a system LaTeX engine
- edit_document: Edit/append content to existing DOCX files
- create_presentation: Create PowerPoint presentations
- generate_presentation: Generate PPTX presentations from structured slides
- generate_epub: Generate EPUB ebooks from chapter content
- generate_landing_page: Generate polished standalone HTML landing pages
- generate_narration_audio: Generate MP3 narration from text using the configured voice service
- organize_folder: Organize and structure files in folders
- Skill: Invoke a skill by ID when one clearly matches the task. If a matching skill exists, call Skill before continuing with other tools or drafting the final answer. Pass "skill" as the canonical skill ID and "args" as the raw argument string.

Skill Management (create, modify, duplicate skills):
- skill_create: Create a new custom skill
- skill_duplicate: Duplicate an existing skill with modifications (great for variations)
- skill_update: Update an existing skill (managed/workspace only, not bundled)
- skill_delete: Delete a skill (managed/workspace only, not bundled)
- skill_proposal: Create/list/approve/reject approval-gated skill proposals (no auto-mutation)
Skills are stored in ~/Library/Application Support/cowork-os/skills/ (managed) or workspace/skills/ (workspace).

Code Tools (PREFERRED for code navigation and editing):
- glob: Fast pattern-based file search (e.g., "**/*.ts", "src/**/*.test.ts")
  Use this FIRST to find files by pattern - much faster than search_files.
- grep: Powerful regex content search (e.g., "async function.*fetch", "class\\s+\\w+")
  Use this FIRST for searching file contents - supports full regex.
- edit_file: Surgical text replacement in files (old_string -> new_string)
  Use this INSTEAD of write_file for targeted changes - safer and preserves structure.
- count_text: Exact text counting (characters/words/lines/paragraphs/sentences)
  Use this FIRST for length checks and exact character targets.
- text_metrics: Comprehensive text metrics and optional character-frequency breakdown
  Use this for document validation workflows instead of custom scripts.
- monty_run: Deterministic, sandboxed Python-subset compute for post-processing tool results.
  Use monty_run only when count_text/text_metrics cannot express the computation.
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

    // Web search is always available (DuckDuckGo provides free fallback)
    descriptions += `

Web Search (for finding URLs, not reading them):
- web_search: Search the web for information${SearchProviderFactory.isAnyProviderConfigured() ? " (web, news, images)" : " (web)"}
  Use to FIND relevant pages. To READ a specific URL, use web_fetch instead.`;

    // Add shell if permitted
    if (this.workspace.permissions.shell) {
      descriptions += `

Shell Commands:
- run_command: Execute shell commands (requires user approval)`;
    }

    descriptions += `

Diagrams & Charts (PREFERRED over HTML files):
- create_diagram: Create and display a Mermaid diagram inline in the UI — no file needed.
  - Use for ANY diagram/chart/flowchart/visualization request (workflows, architecture, sequences, data models, timelines, mind maps, ERDs, Gantt charts, pie charts, etc.)
  - Supports all Mermaid diagram types: flowchart, sequenceDiagram, classDiagram, stateDiagram, erDiagram, gantt, pie, gitGraph, mindmap, timeline, etc.
  - The diagram renders live in the conversation — the user sees it immediately without opening a file.
  - ALWAYS prefer create_diagram over writing an HTML file for any visualization/diagram need.`;

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
  - Uses a vision-capable provider (Azure OpenAI/OpenAI/Anthropic/Bedrock/Gemini); the tool will prompt setup guidance if missing.
- read_pdf_visual: Visually analyze a PDF document's layout, design, and content
  - Converts PDF pages to images and analyzes them in one step (no need for pdftoppm + analyze_image separately)
  - Use only when you need visual layout, design, colors, formatting, scan/OCR interpretation, or page appearance
  - For normal text PDFs, use read_file or parse_document first; do not use read_pdf_visual for text-only extraction`;

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
- run_applescript: Execute exact AppleScript on macOS (explicit AppleScript requests or low-level fallback only)
- search_memories: Search workspace memories, .cowork/ knowledge files, and imported conversations for past context
- search_quotes: Search exact quoted wording across transcripts, task messages, imported memories, and workspace notes
- search_sessions: Search recent task/session transcripts and checkpoints for prior run context
- memory_topics_load: Load topical memory packs from \`.cowork/memory/topics\`
- memory_save: Save an observation, decision, insight, or error to workspace memory for future recall
- memory_curate: Add, replace, or remove curated hot-memory facts that should stay prompt-visible
- memory_curated_read: Inspect the current curated hot-memory entries
${hasAnyVisibleTools(
  "supermemory_profile",
  "supermemory_search",
  "supermemory_remember",
  "supermemory_forget",
)
  ? `- supermemory_profile: Load the workspace-scoped external Supermemory profile and relevant facts
- supermemory_search: Search external Supermemory memories for this workspace or approved container
- supermemory_remember: Persist a high-signal fact into external Supermemory
- supermemory_forget: Remove an outdated external Supermemory entry by ID or exact content`
  : ""}
${hasAnyVisibleTools(
  "screenshot",
  "click",
  "double_click",
  "move_mouse",
  "drag",
  "scroll",
  "type_text",
  "keypress",
  "wait",
)
  ? `

Chronicle Screen Context:
- screen_context_resolve: Resolve vague references like "this", "that", "same doc", or "why is this failing?" from the local recent-screen buffer without sending screenshots to external providers

Computer Use Tools (macOS native GUI, preferred over run_applescript for normal app interaction):
- screenshot: Capture the current controlled native app window first; retarget with app/windowTitle when switching windows
- click: Click inside the latest controlled-window screenshot using window-relative coordinates
- double_click: Double-click inside the latest controlled-window screenshot
- move_mouse: Move the pointer within the current controlled window without clicking
- drag: Drag through a screenshot-relative path inside the current controlled window
- scroll: Scroll inside the current controlled window using screenshot-relative coordinates
- type_text: Type into the currently focused native app control
- keypress: Press key chords like Return, Escape, or Cmd shortcuts in the current controlled window
- wait: Pause briefly, then refresh the controlled-window screenshot`
  : ""}

Scheduling:
- schedule_task: Schedule tasks to run at specific times or intervals
  - Create reminders: "remind me to X at Y"
  - Recurring tasks: "every day at 9am, do X"
  - One-time tasks: "at 3pm tomorrow, do X"
  - Cron schedules: standard cron expressions supported

${
  hasAnyVisibleTools(
    "canvas_create",
    "canvas_push",
    "canvas_open_url",
    "canvas_show",
    "canvas_hide",
    "canvas_close",
    "canvas_eval",
    "canvas_snapshot",
    "canvas_list",
  )
    ? `
Live Canvas (Visual Workspace):
- canvas_create: Create a new canvas session for displaying interactive content when the user explicitly asks for live UI, dashboard, or in-app browsing.
- canvas_push: Push HTML/CSS/JS content to the canvas. session_id and/or content may be omitted for recovery fallback.
  Only use for explicit visual-output tasks (interactive interfaces, charts, rich previews, app-style content).
  Do NOT use for status updates, summaries, planning, file operations, or checklist-style tasks.
  Example: canvas_push({ session_id: "abc-123", content: "<!DOCTYPE html><html><body><h1>Hello</h1></body></html>" })
  If session_id is not provided, the tool can attempt to continue the latest active canvas session for this task.
- canvas_open_url: Open a running local dev server or remote web page inside the canvas window.
- canvas_show: OPTIONAL - Only use if user needs full interactivity (clicking buttons, forms)
- canvas_hide: Hide the canvas window
- canvas_close: Close a canvas session
- canvas_eval: Execute JavaScript in the canvas context
- canvas_snapshot: Take a screenshot of the canvas
- canvas_list: List all active canvas sessions
IMPORTANT: When using canvas_push for visual output, provide content when available.
If omitted, the runtime fills in a safe fallback so execution can continue.

WEB APP BUILD + SHOW WORKFLOW:
When you build any web app, do NOT stop at code generation. Always finish by running the app and showing it in canvas. Pick the approach that fits what you built:
- Single HTML/CSS/JS file → canvas_create then canvas_push the HTML directly
- Multi-file app with a dev script (React, Next.js, Vite, Vue, etc.) → install deps if needed, start the dev server on any free port, wait for it to be ready, then canvas_create + canvas_open_url("http://localhost:<port>")
- App that builds to a static dist/ → run the build, then canvas_push the built HTML or serve it and use canvas_open_url
Use whichever workspace makes sense (the project folder or a temp dir). What matters is that the running app is visible in canvas before the task ends. Code generation alone is not a complete result.
`
    : ""
}

${
  hasAnyVisibleTools("visual_open_annotator", "visual_update_annotator")
    ? `
Agentic Image Iteration (Visual Annotator):
- visual_open_annotator: Open an image annotation UI in Live Canvas for a workspace image
- visual_update_annotator: Update an existing annotator session with a new image iteration
The annotator sends [Canvas Interaction] messages back to the running task with structured JSON feedback.
`
    : ""
}

${
  this.channelTools
    ? `
Channel Message Log (Local Gateway):
- channel_list_chats: List recently active chats for a channel (discover chat IDs)
- channel_history: Fetch recent messages for a specific chat ID (use for summarization/monitoring)
- channel_fetch_discord_messages: Fetch messages directly from Discord API (live, not local log)
- channel_download_discord_attachment: Download attachments from a Discord message`
    : ""
}

		Plan Control:
		- revise_plan: Modify remaining plan steps when obstacles are encountered or new information discovered
		- request_user_input: Ask the user a structured multiple-choice question set (plan or debug mode) and wait for selection.
		- task_list_create: Create the initial ordered session checklist for non-trivial execution work. Fails if a checklist already exists.
		- task_list_update: Replace the full ordered session checklist state while preserving supplied item ids.
		- task_list_list: Read the current session checklist and whether a verification nudge is active.
		- task_history: Query recent task history/messages (use for "what did we talk about yesterday?")
		- switch_workspace: Switch to a different workspace/working directory. Use when you need to work in a different folder.
		- integration_setup: List/inspect/configure Tier-1 integrations from chat (resend/google-workspace/jira/linear/hubspot/salesforce/zendesk/servicenow), including plan_hash stale-plan safety and optional OAuth setup.
		- set_personality: Change the assistant's communication style (professional, friendly, concise, creative, technical, casual).
	- set_persona: Change the assistant's character persona (jarvis, friday, hal, computer, alfred, intern, sensei, pirate, noir, companion, or none).
	- set_response_style: Adjust response preferences (emoji_usage, response_length, code_comments, explanation_depth).
	- set_quirks: Set personality quirks (catchphrase, sign_off, analogy_domain).
- set_vibes: Update the workspace's current energy/mode (crunch, explore, deep-focus, maintenance, playful, low-energy, default). Call when you detect a shift in the user's working energy.
- update_lore: Record a notable shared moment or reference in the workspace lore. Use after significant accomplishments, breakthroughs, or discoveries.
- manage_heartbeat: Enable or disable the heartbeat (periodic wake-up) for a digital twin / agent role. Use when asked to start or stop a twin.
- set_agent_name: Set or change the assistant's name when the user wants to give you a name.
- set_user_name: Store the user's name when they introduce themselves (e.g., "I'm Alice", "My name is Bob").`;

    // Add skills available through the Skill tool
    const skillLoader = getCustomSkillLoader();
    const availableToolNames = new Set(this.getTools().map((tool) => tool.name));
    const resolvedSkillShortlistSize =
      typeof options?.skillShortlistSize === "number" && Number.isFinite(options.skillShortlistSize)
        ? Math.min(Math.max(Math.round(options.skillShortlistSize), 1), 200)
        : parseBoundedIntEnv("COWORK_SKILL_SHORTLIST_SIZE", 20, 1, 200);
    const resolvedSkillLowConfidenceThreshold =
      typeof options?.skillLowConfidenceThreshold === "number" &&
      Number.isFinite(options.skillLowConfidenceThreshold)
        ? Math.min(Math.max(options.skillLowConfidenceThreshold, 0), 1)
        : 0.55;
    const resolvedSkillTextBudgetChars =
      typeof options?.skillTextBudgetChars === "number" &&
      Number.isFinite(options.skillTextBudgetChars)
        ? Math.max(Math.round(options.skillTextBudgetChars), 1500)
        : parseBoundedIntEnv("COWORK_SKILL_TEXT_BUDGET_CHARS", 12000, 1500, 50000);
    const skillDescriptions = skillLoader.getSkillDescriptionsForModel({
      availableToolNames,
      routingQuery: options?.skillRoutingQuery,
      shortlistSize: resolvedSkillShortlistSize,
      lowConfidenceThreshold: resolvedSkillLowConfidenceThreshold,
      textBudgetChars: resolvedSkillTextBudgetChars,
      includePrereqBlockedSkills: true,
    });
    if (skillDescriptions) {
      descriptions += `

Skills Available Through The Skill Tool:
${skillDescriptions}`;
    }

    const finalDescriptions = descriptions.trim();
    this.toolDescriptionsCache.set(cacheKey, finalDescriptions);
    return finalDescriptions;
  }

  /**
   * Execute a tool by name
   */
  async executeToolWithRuntime(
    name: string,
    input: Any,
    runtime?: Record<string, unknown>,
  ): Promise<{ result: Any; policyTrace?: Any }> {
    if (this.handlerRegistry.has(name)) {
      return await this.executeWithRegisteredHandler(name, input);
    }
    const result = await this.executeTool(name, input, runtime);
    return { result };
  }

  async executeTool(name: string, input: Any, _runtime?: Record<string, unknown>): Promise<Any> {
    if (this.handlerRegistry.has(name)) {
      const execution = await this.executeWithRegisteredHandler(name, input);
      return execution?.result ?? execution;
    }
    // Optional workspace-local policy hook (.cowork/policy/tools.monty).
    // Fail-open on policy script errors to avoid bricking tool execution.
    try {
      const policy = await evaluateMontyToolPolicy({
        workspace: this.workspace,
        toolName: name,
        toolInput: input,
        gatewayContext: this.gatewayContext,
      });

      if (policy.decision === "deny") {
        const reason = policy.reason ? `: ${policy.reason}` : "";
        throw new Error(`Tool "${name}" blocked by workspace policy${reason}`);
      }

      // Avoid double-prompts for tools that already enforce approvals internally.
      const selfGated = name === "run_command" || name === "delete_file";
      if (policy.decision === "require_approval" && !selfGated) {
        const requester = (this.daemon as Any)?.requestApproval;
        if (typeof requester !== "function") {
          throw new Error(
            `Tool "${name}" requires approval, but approval system is unavailable in this context`,
          );
        }
        const approved = await requester.call(
          this.daemon,
          this.taskId,
          "external_service",
          `Approve tool call: ${name}`,
          {
            tool: name,
            params: input ?? null,
            reason: policy.reason || null,
          },
        );
        if (approved !== true) {
          const reason = policy.reason ? `: ${policy.reason}` : "";
          throw new Error(`Tool "${name}" approval denied${reason}`);
        }
      }
    } catch (err) {
      // Only block if the policy explicitly denied or required approval and was not approved.
      const msg = String((err as Any)?.message || "");
      if (/blocked by workspace policy|approval denied|requires approval/i.test(msg)) {
        throw err;
      }
    }

    // File tools
    if (name === "read_file") {
      return await this.fileTools.readFile(input.path, {
        startChar: input.startChar,
        maxChars: input.maxChars,
      });
    }
    if (name === "read_files")
      return await readFilesByPatterns(input, {
        globTools: this.globTools,
        fileTools: this.fileTools,
      });
    if (name === "write_file") return await this.fileTools.writeFile(input.path, input.content);
    if (name === "copy_file")
      return await this.fileTools.copyFile(input.sourcePath, input.destPath);
    if (name === "list_directory") return await this.fileTools.listDirectory(input.path);
    if (name === "list_directory_with_sizes")
      return await this.fileTools.listDirectoryWithSizes(input.path);
    if (name === "get_file_info") return await this.fileTools.getFileInfo(input.path);
    if (name === "rename_file")
      return await this.fileTools.renameFile(input.oldPath, input.newPath);
    if (name === "delete_file") return await this.fileTools.deleteFile(input.path);
    if (name === "create_directory") return await this.fileTools.createDirectory(input.path);
    if (name === "search_files") return await this.fileTools.searchFiles(input.query, input.path);

    // Skill tools
    if (name === "create_spreadsheet") return await this.skillTools.createSpreadsheet(input);
    if (name === "create_document") return await this.skillTools.createDocument(input);
    if (name === "edit_document") return await this.skillTools.editDocument(input);
    if (name === "edit_pdf_region") return await this.skillTools.editPdfRegion(input);
    if (name === "create_presentation") return await this.skillTools.createPresentation(input);
    if (name === "organize_folder") return await this.skillTools.organizeFolder(input);
    if (name === "Skill") return await this.executeSkillCommand(input);

    // Skill management tools
    if (name === "skill_create") return await this.executeSkillCreate(input);
    if (name === "skill_duplicate") return await this.executeSkillDuplicate(input);
    if (name === "skill_update") return await this.executeSkillUpdate(input);
    if (name === "skill_delete") return await this.executeSkillDelete(input);
    if (name === "skill_proposal") return await this.executeSkillProposal(input);

    // Code tools (glob, grep, edit)
    if (name === "glob") return await this.globTools.glob(input);
    if (name === "grep") return await this.grepTools.grep(input);
    if (name === "edit_file") return await this.editTools.editFile(input);
    if (name === "count_text") return await this.textTools.countText(input);
    if (name === "text_metrics") return await this.textTools.textMetrics(input);
    if (name === "monty_run") return await this.montyTools.montyRun(input);
    if (name === "monty_list_transforms") return await this.montyTools.listTransforms(input);
    if (name === "monty_run_transform") return await this.montyTools.runTransform(input);
    if (name === "monty_transform_file") return await this.montyTools.transformFile(input);
    if (name === "extract_json") return await this.montyTools.extractJson(input);

    // Web fetch tools (preferred for reading web content)
    if (name === "web_fetch") {
      const result = await this.webFetchTools.webFetch(input);
      if (this.citationTracker) {
        this.citationTracker.addFromFetch(input.url, input.url);
      }
      return result;
    }
    if (name === "http_request") return await this.webFetchTools.httpRequest(input);

    // Browser tools
    if (BrowserTools.isBrowserTool(name)) {
      // Guard: prevent browser_navigate on file:// PDF URLs (triggers download, not rendering)
      if (name === "browser_navigate") {
        const url = String((input as { url?: string })?.url || "");
        if (url.startsWith("file://") && url.toLowerCase().endsWith(".pdf")) {
          return {
            content:
              "Cannot open PDF files in browser (triggers download instead of rendering). " +
              "Use read_file to extract text content, or read_pdf_visual to analyze the visual layout and design.",
            isError: true,
          };
        }
      }
      return await this.browserTools.executeTool(name, input);
    }

    // QA tools (Playwright automated visual testing)
    if (name.startsWith("qa_")) {
      const result = await this.qaTools.execute(name, input);
      // QA tools return JSON; treat explicit error payloads as tool failures.
      if (typeof result === "string") {
        try {
          const parsed = JSON.parse(result) as {
            success?: boolean;
            report?: string;
            error?: string;
          };
          if (typeof parsed.success === "boolean") {
            const content =
              typeof parsed.report === "string"
                ? parsed.report
                : typeof parsed.error === "string"
                  ? parsed.error
                  : result;
            return {
              content,
              success: parsed.success,
              isError: !parsed.success,
            };
          }
          if (typeof parsed.error === "string") {
            return { content: parsed.error, success: false, isError: true };
          }
        } catch {
          // Not JSON, use as-is
        }
      }
      return { content: result };
    }

    // Search tools
    if (name === "web_search") {
      const result = await this.searchTools.webSearch(input);
      if (this.citationTracker && result && typeof result === "object") {
        this.citationTracker.addFromSearch((result as Any).results || []);
      }
      return result;
    }

    // X/Twitter tools
    if (name === "x_action") return await this.xTools.executeAction(input);

    // Notion tools
    if (name === "notion_action") return await this.notionTools.executeAction(input);

    // Box tools
    if (name === "box_action") return await this.boxTools.executeAction(input);

    // OneDrive tools
    if (name === "onedrive_action") return await this.oneDriveTools.executeAction(input);

    // Google Drive tools
    if (name === "google_drive_action") return await this.googleDriveTools.executeAction(input);

    // Gmail tools
    if (name === "gmail_action") return await this.gmailTools.executeAction(input);
    if (name === "mailbox_action") {
      if (!this.mailboxTools) {
        throw new Error("Mailbox tools unavailable (database not accessible)");
      }
      return await this.mailboxTools.executeAction(input);
    }

    // Google Calendar tools
    if (name === "calendar_action") return await this.googleCalendarTools.executeAction(input);

    // Apple Calendar tools (macOS)
    if (name === "apple_calendar_action") return await this.appleCalendarTools.executeAction(input);

    // Apple Reminders tools (macOS)
    if (name === "apple_reminders_action")
      return await this.appleRemindersTools.executeAction(input);

    // Dropbox tools
    if (name === "dropbox_action") return await this.dropboxTools.executeAction(input);

    // SharePoint tools
    if (name === "sharepoint_action") return await this.sharePointTools.executeAction(input);

    // Voice call tools
    if (name === "voice_call") return await this.voiceCallTools.executeAction(input);

    // Shell tools
    if (name === "run_command") return await this.shellTools.runCommand(input.command, input);

    // Git tools
    if (name === "git_status") return await this.gitTools.gitStatus();
    if (name === "git_diff") return await this.gitTools.gitDiff(input);
    if (name === "git_commit") return await this.gitTools.gitCommit(input);
    if (name === "git_merge_to_base") return await this.gitTools.gitMergeToBase();

    // Image tools
    if (name === "generate_image") return await this.imageTools.generateImage(input);

    // Video tools
    if (name === "generate_video") return await this.videoTools.generateVideo(input);
    if (name === "get_video_generation_job") return await this.videoTools.getVideoGenerationJob(input);
    if (name === "cancel_video_generation_job") return await this.videoTools.cancelVideoGenerationJob(input);

    // Vision tools
    if (name === "analyze_image") return await this.visionTools.analyzeImage(input);
    if (name === "read_pdf_visual") return await this.visionTools.readPdfVisual(input);

    // System tools
    if (name === "system_info") return await this.systemTools.getSystemInfo();
    if (name === "search_memories") return await this.systemTools.searchMemories(input);
    if (name === "search_quotes") return await this.systemTools.searchQuotes(input);
    if (name === "search_sessions") return await this.systemTools.searchSessions(input);
    if (name === "memory_topics_load") return await this.systemTools.loadMemoryTopics(input);
    if (name === "memory_save") return await this.memoryTools.save(input);
    if (name === "memory_curate") return await this.memoryTools.curate(input);
    if (name === "memory_curated_read") return await this.memoryTools.readCurated(input);
    if (name === "supermemory_profile" && SupermemoryTools.isEnabled()) return await this.supermemoryTools.profile(input);
    if (name === "supermemory_search" && SupermemoryTools.isEnabled()) return await this.supermemoryTools.search(input);
    if (name === "supermemory_remember" && SupermemoryTools.isEnabled()) return await this.supermemoryTools.remember(input);
    if (name === "supermemory_forget" && SupermemoryTools.isEnabled()) return await this.supermemoryTools.forget(input);
    if (name === "scratchpad_write") return this.scratchpadTools.write(input);
    if (name === "scratchpad_read") return this.scratchpadTools.read(input);
    if (name === "read_clipboard") return await this.systemTools.readClipboard();
    if (name === "write_clipboard") return await this.systemTools.writeClipboard(input.text);
    if (name === "take_screenshot") return await this.systemTools.takeScreenshot(input);
    if (name === "open_application") return await this.systemTools.openApplication(input.appName);
    if (name === "open_url") return await this.systemTools.openUrl(input.url);
    if (name === "open_path") return await this.systemTools.openPath(input.path);
    if (name === "show_in_folder") return await this.systemTools.showInFolder(input.path);
    if (name === "get_env") return await this.systemTools.getEnvVariable(input.name);
    if (name === "get_app_paths") return this.systemTools.getAppPaths();
    if (name === "run_applescript") return await this.systemTools.runAppleScript(input.script);

    // Computer use tools (CUA)
    if (name === "screenshot")
      return await this.computerUseTools.screenshot({
        app: input.app,
        windowTitle: input.windowTitle,
      });
    if (name === "click")
      return await this.computerUseTools.click(input.x, input.y, input.button, input.captureId);
    if (name === "double_click")
      return await this.computerUseTools.doubleClick(input.x, input.y, input.captureId);
    if (name === "move_mouse")
      return await this.computerUseTools.moveMouse(input.x, input.y, input.captureId);
    if (name === "drag") return await this.computerUseTools.drag(input.path, input.captureId);
    if (name === "scroll")
      return await this.computerUseTools.scroll(
        input.x,
        input.y,
        input.scrollX,
        input.scrollY,
        input.captureId,
      );
    if (name === "type_text") return await this.computerUseTools.typeText(input.text);
    if (name === "keypress") return await this.computerUseTools.pressKeys(input.keys);
    if (name === "wait") return await this.computerUseTools.wait(input.ms);

    // Batch image processing
    if (name === "batch_image_process") return await this.batchImageTools.batchProcess(input);

    // Cron/scheduling tools
    if (name === "schedule_task") return await this.cronTools.executeAction(input);

    // Infrastructure tools (cloud sandboxes, domains, wallet, x402 payments)
    if (
      name.startsWith("cloud_sandbox_") ||
      name.startsWith("domain_") ||
      name.startsWith("wallet_") ||
      name.startsWith("x402_") ||
      name === "infra_status"
    ) {
      return await this.infraTools.executeTool(name, input);
    }

    // Canvas tools
    if (name === "canvas_create") return await this.canvasTools.createCanvas(input.title);
    if (name === "canvas_push") {
      console.log(`[ToolRegistry] canvas_push input keys:`, Object.keys(input || {}));
      console.log(`[ToolRegistry] canvas_push session_id:`, input?.session_id);
      console.log(
        `[ToolRegistry] canvas_push content present:`,
        "content" in (input || {}),
        `content length:`,
        input?.content?.length ?? "N/A",
      );
      const canvasInput = input || {};
      const rawSessionId = canvasInput.session_id;
      const inferredSessionId = rawSessionId || this.getLatestCanvasSessionId();
      if (!canvasInput.session_id && inferredSessionId) {
        canvasInput.session_id = inferredSessionId;
      }
      try {
        return await this.canvasTools.pushContent(
          canvasInput.session_id,
          canvasInput.content,
          canvasInput.filename,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown canvas push error";
        this.daemon.logEvent(this.taskId, "tool_error", {
          tool: "canvas_push",
          error: message,
          softFailure: true,
        });
        return {
          success: true,
          warning:
            "Canvas preview could not be refreshed right now, but execution can continue without it.",
          fallback: true,
        };
      }
    }
    if (name === "canvas_open_url")
      return await this.canvasTools.openUrl(input.session_id, input.url, input.show);
    if (name === "canvas_show") return await this.canvasTools.showCanvas(input.session_id);
    if (name === "canvas_hide") return this.canvasTools.hideCanvas(input.session_id);
    if (name === "canvas_close") return await this.canvasTools.closeCanvas(input.session_id);
    if (name === "canvas_eval")
      return await this.canvasTools.evalScript(input.session_id, input.script);
    if (name === "canvas_snapshot") return await this.canvasTools.takeSnapshot(input.session_id);
    if (name === "canvas_list") return this.canvasTools.listSessions();
    if (name === "canvas_checkpoint")
      return await this.canvasTools.saveCheckpoint(input.session_id, input.label);
    if (name === "canvas_restore")
      return await this.canvasTools.restoreCheckpoint(input.session_id, input.checkpoint_id);
    if (name === "canvas_checkpoints") return this.canvasTools.listCheckpoints(input.session_id);

    // Visual annotator tools
    if (name === "visual_open_annotator") return await this.visualTools.openImageAnnotator(input);
    if (name === "visual_update_annotator")
      return await this.visualTools.updateImageAnnotator(input);

    // Channel history tools
    if (name === "channel_list_chats" || name === "channel_history") {
      if (!this.channelTools) {
        throw new Error("Channel history tools unavailable (database not accessible)");
      }
      if (name === "channel_list_chats") return await this.channelTools.listChats(input);
      return await this.channelTools.channelHistory(input);
    }

    // Discord live API tools
    if (name === "channel_fetch_discord_messages") {
      if (!this.channelTools) {
        throw new Error("Channel tools unavailable (database not accessible)");
      }
      return await this.channelTools.fetchDiscordMessages(input);
    }
    if (name === "channel_download_discord_attachment") {
      if (!this.channelTools) {
        throw new Error("Channel tools unavailable (database not accessible)");
      }
      return await this.channelTools.downloadDiscordAttachment(input);
    }

    // Email IMAP tools (direct inbox access)
    if (name === "email_imap_unread") {
      if (!this.emailImapTools) {
        throw new Error("Email IMAP tools unavailable (database not accessible)");
      }
      return await this.emailImapTools.listUnread(input);
    }

    // Mention tools (multi-agent collaboration)
    if (name === "list_agent_roles") return await this.mentionTools.listAgentRoles();
    if (name === "mention_agent") return await this.mentionTools.mentionAgent(input);
    if (name === "get_pending_mentions") return await this.mentionTools.getPendingMentions();
    if (name === "acknowledge_mention")
      return await this.mentionTools.acknowledgeMention(input.mentionId);
    if (name === "complete_mention")
      return await this.mentionTools.completeMention(input.mentionId);

    // Document generation tools
    if (name === "generate_document") return await this.documentTools.generateDocument(input);
    if (name === "compile_latex") return await this.documentTools.compileLatex(input);
    if (name === "generate_presentation")
      return await this.documentTools.generatePresentation(input);
    if (name === "generate_spreadsheet") return await this.documentTools.generateSpreadsheet(input);
    if (name === "generate_epub") return await this.documentTools.generateEPUB(input);
    if (name === "generate_landing_page") return await this.documentTools.generateLandingPage(input);
    if (name === "generate_narration_audio")
      return await this.documentTools.generateNarrationAudio(input);

    // Mermaid diagram tool
    if (name === "create_diagram") {
      const title = typeof input?.title === "string" ? input.title : "Diagram";
      const diagram = typeof input?.diagram === "string" ? input.diagram : "";
      if (!diagram.trim()) {
        return { success: false, error: "diagram is required and must be non-empty Mermaid syntax" };
      }
      const validation = await ToolRegistry.validateMermaidDiagram(diagram);
      if (!validation.success) {
        return {
          success: false,
          error: validation.error,
        };
      }
      this.daemon.logEvent(this.taskId, "diagram_created", { title, diagram });
      return {
        success: true,
        message: `Diagram "${title}" is now displayed in the UI.`,
        ...(validation.warning ? { warning: validation.warning } : {}),
      };
    }

    // Meta tools
    if (name === "task_history") {
      return this.taskHistory(input);
    }
    if (name === "task_events") {
      return this.taskEvents(input);
    }
    if (name === "request_user_input") {
      return await this.requestUserInput(input);
    }
    if (name === "task_list_create") {
      return await this.taskListCreate(input);
    }
    if (name === "task_list_update") {
      return await this.taskListUpdate(input);
    }
    if (name === "task_list_list") {
      return await this.taskListList();
    }

    if (name === "revise_plan") {
      if (!this.planRevisionHandler) {
        throw new Error("Plan revision not available at this time");
      }
      const newSteps = input.newSteps || [];
      const reason = input.reason || "No reason provided";
      const clearRemaining = input.clearRemaining || false;
      this.planRevisionHandler(newSteps, reason, clearRemaining);

      let message = "";
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

    if (name === "switch_workspace") {
      return await this.switchWorkspace(input);
    }

    if (name === "list_projects") {
      const projects = this.daemon.listProjects({ includeArchived: input?.include_archived === true });
      return {
        projects: projects.map((p: Any) => ({
          id: p.id,
          name: p.name,
          status: p.status,
          description: p.description ?? null,
        })),
      };
    }

    if (name === "list_workspaces") {
      const workspaces = this.daemon.listWorkspaces();
      return {
        workspaces: workspaces.map((w: Any) => ({
          id: w.id,
          name: w.name,
          path: w.path,
        })),
      };
    }

    if (name === "link_project_workspace") {
      const { project_id, workspace_id, is_primary } = input as {
        project_id: string;
        workspace_id: string;
        is_primary?: boolean;
      };
      if (!project_id || !workspace_id) {
        return { success: false, error: "project_id and workspace_id are required" };
      }
      try {
        const link = this.daemon.linkProjectWorkspace({
          projectId: project_id,
          workspaceId: workspace_id,
          isPrimary: is_primary,
        });
        return {
          success: true,
          link: {
            id: link.id,
            projectId: link.projectId,
            workspaceId: link.workspaceId,
            isPrimary: link.isPrimary,
          },
        };
      } catch (err: Any) {
        return { success: false, error: err?.message ?? "Failed to link workspace" };
      }
    }

    if (name === "list_goals") {
      const goals = this.daemon.listGoals(input?.company_id);
      return {
        goals: goals.map((g: Any) => ({
          id: g.id,
          title: g.title,
          status: g.status,
          description: g.description ?? null,
        })),
      };
    }

    if (name === "list_issues") {
      const issues = this.daemon.listIssues({
        projectId: input?.project_id,
        goalId: input?.goal_id,
        status: Array.isArray(input?.status) ? input.status : undefined,
        limit: typeof input?.limit === "number" ? input.limit : undefined,
      });
      return {
        issues: issues.map((i: Any) => ({
          id: i.id,
          title: i.title,
          status: i.status,
          priority: i.priority,
          projectId: i.projectId ?? null,
          goalId: i.goalId ?? null,
          description: i.description ?? null,
        })),
      };
    }

    if (name === "create_issue") {
      if (!input?.title) {
        return { success: false, error: "title is required" };
      }
      try {
        const issue = this.daemon.createIssue({
          title: input.title,
          description: input.description,
          projectId: input.project_id,
          goalId: input.goal_id,
          status: input.status,
          priority: typeof input.priority === "number" ? input.priority : 2,
        });
        return {
          success: true,
          issue: {
            id: issue.id,
            title: issue.title,
            status: issue.status,
            priority: issue.priority,
            projectId: issue.projectId ?? null,
            goalId: issue.goalId ?? null,
          },
        };
      } catch (err: Any) {
        return { success: false, error: err?.message ?? "Failed to create issue" };
      }
    }

    if (name === "integration_setup") {
      return await this.integrationSetup(input);
    }

    if (name === "set_personality") {
      return this.setPersonality(input);
    }

    if (name === "set_agent_name") {
      return this.setAgentName(input);
    }

    if (name === "set_user_name") {
      return this.setUserName(input);
    }

    if (name === "set_persona") {
      return this.setPersona(input);
    }

    if (name === "set_response_style") {
      return this.setResponseStyle(input);
    }

    if (name === "set_quirks") {
      return this.setQuirks(input);
    }

    if (name === "add_behavioral_rule") {
      return this.addBehavioralRule(input);
    }

    if (name === "set_expertise") {
      return this.setExpertise(input);
    }

    if (name === "set_vibes") {
      return this.setVibes(input);
    }

    if (name === "update_lore") {
      return this.updateLore(input);
    }

    if (name === "manage_heartbeat") {
      return this.manageHeartbeat(input);
    }

    // Sandboxed code execution
    if (name === "execute_code") {
      return await this.executeCode(input);
    }

    // Document parsing
    if (name === "parse_document") {
      return await this.parseDocument(input);
    }

    // Sub-Agent / Parallel Agent tools
    if (name === "acp_discover") {
      return await this.acpDiscover(input);
    }
    if (name === "spawn_agent") {
      return await this.spawnAgent(input);
    }
    if (name === "wait_for_agent") {
      return await this.waitForAgent(input);
    }
    if (name === "orchestrate_agents") {
      return await this.orchestrateAgents(input);
    }
    if (name === "get_agent_status") {
      return await this.getAgentStatus(input);
    }
    if (name === "list_agents") {
      return await this.listAgents(input);
    }
    if (name === "send_agent_message") {
      return await this.sendAgentMessage(input);
    }
    if (name === "capture_agent_events") {
      return await this.captureAgentEvents(input);
    }
    if (name === "cancel_agent") {
      return await this.cancelAgent(input);
    }
    if (name === "pause_agent") {
      return await this.pauseAgent(input);
    }
    if (name === "resume_agent") {
      return await this.resumeAgent(input);
    }

    // Knowledge graph tools
    if (KnowledgeGraphTools.isKnowledgeGraphTool(name)) {
      return await this.knowledgeGraphTools.executeTool(name, input);
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
  private async tryExecuteMCPTool(name: string, input: Any): Promise<Any | null> {
    const settings = MCPSettingsManager.loadSettings();
    const prefix = settings.toolNamePrefix || "mcp_";

    // Not an MCP tool if it doesn't have the prefix
    if (!name.startsWith(prefix)) {
      return null;
    }

    const mcpToolName = name.slice(prefix.length);

    // Try to get the MCP manager - if not initialized, this is not an MCP tool call
    let mcpManager: MCPClientManager;
    try {
      mcpManager = MCPClientManager.getInstance();
    } catch  {
      // MCP not initialized
      return null;
    }

    // Check if the tool is registered
    if (!mcpManager.hasTool(mcpToolName)) {
      return null;
    }
    const mcpToolDefinition = mcpManager.getAllTools().find((tool) => tool.name === mcpToolName);

    if (mcpToolName === MCP_PAYMENT_TOOL_NAME) {
      const amount = extractPaymentAmountFromX402Tool(input, mcpToolDefinition);
      const limitError = getMcpPaymentLimitError(input, mcpToolDefinition);
      if (limitError) {
        throw new Error(limitError);
      }

      const requester = (this.daemon as Any)?.requestApproval;
      if (typeof requester !== "function") {
        throw new Error(
          `Tool "${mcpToolName}" requires approval, but approval system is unavailable in this context`,
        );
      }
      const approved = await requester.call(
        this.daemon,
        this.taskId,
        "external_service",
        `Approve MCP payment request: ${mcpToolName}`,
        {
          tool: `mcp_${mcpToolName}`,
          params: input ?? null,
          serverName: this.getMcpServerName(`mcp_${mcpToolName}`) || undefined,
          reason:
            amount !== null ? `MCP payment operation (${amount} USDC)` : "MCP payment operation",
        },
        { allowAutoApprove: false },
      );
      if (approved !== true) {
        throw new Error('Tool "mcp_x402_fetch" approval denied');
      }
    }

    // Guard against using puppeteer_evaluate for Node/shell execution
    if (mcpToolName === "puppeteer_evaluate") {
      const script = typeof input?.script === "string" ? input.script : "";
      if (/(require\s*\(|child_process|execSync|exec\(|spawn\()/i.test(script)) {
        throw new Error(
          "MCP tool 'puppeteer_evaluate' cannot run Node shell APIs. " +
            "Use run_command for shell commands or browser_evaluate for DOM-only scripts.",
        );
      }
    }

    // At this point, we know it's a valid MCP tool - any errors should be propagated
    console.log(`[ToolRegistry] Executing MCP tool: ${mcpToolName}`);

    try {
      const result = await mcpManager.callTool(mcpToolName, input);
      // Format MCP result and process any generated files
      return await this.formatMCPResult(result, mcpToolName, input);
    } catch (error: Any) {
      const message = String(error?.message || "");
      if (/access denied\s*-\s*path outside allowed directories/i.test(message)) {
        return {
          success: false,
          error:
            `MCP tool '${mcpToolName}' cannot access that path from its configured roots. ` +
            "Use workspace file tools (list_directory/read_file/write_file) for this workspace, or run in an allowed directory.",
          source: "mcp",
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
  private async formatMCPResult(result: Any, toolName?: string, input?: Any): Promise<Any> {
    if (!result) return { success: true };

    // Check if it's an MCP CallResult format
    if (result.content && Array.isArray(result.content)) {
      if (result.isError) {
        throw new Error(
          result.content.map((c: Any) => c.text || "").join("\n") || "MCP tool execution failed",
        );
      }

      // Handle image/video content from MCP tools and persist them as workspace artifacts.
      const savedImageFilenames: string[] = [];
      const savedVideoFilenames: string[] = [];
      for (const content of result.content) {
        if ((content.type === "image" || content.type === "video") && content.data) {
          const mimeType: string | undefined = content.mimeType || undefined;
          const defaultExt = content.type === "video" ? ".mp4" : ".png";
          const ext = guessExtFromMime(mimeType) || defaultExt;
          const rawNameCandidate =
            typeof input?.filePath === "string" && input.filePath.trim()
              ? path.basename(input.filePath)
              : typeof input?.filename === "string" && input.filename.trim()
                ? path.basename(input.filename)
                : typeof input?.name === "string" && input.name.trim()
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
            const mediaBuffer = Buffer.from(content.data, "base64");
            await fsPromises.writeFile(outputPath, mediaBuffer);

            this.daemon.logEvent(this.taskId, "file_created", {
              path: filename,
              type: content.type === "video" ? "video" : "screenshot",
              source: "mcp",
              mimeType,
            });

            this.daemon.registerArtifact(
              this.taskId,
              outputPath,
              mimeType || (content.type === "video" ? "video/mp4" : "image/png"),
            );

            if (content.type === "video") {
              savedVideoFilenames.push(filename);
            } else {
              savedImageFilenames.push(filename);
            }

            console.log(`[ToolRegistry] Saved MCP ${content.type} artifact: ${filename}`);
          } catch (error) {
            console.error(`[ToolRegistry] Failed to save MCP ${content.type}:`, error);
          }
        }
      }

      // Combine text content
      const textParts = result.content
        .filter((c: Any) => c.type === "text")
        .map((c: Any) => c.text);

      if (textParts.length > 0) {
        const baseText = textParts.join("\n");
        if (savedImageFilenames.length > 0 || savedVideoFilenames.length > 0) {
          const suffix = [
            ...savedImageFilenames.map((f) => `Saved image: ${f}`),
            ...savedVideoFilenames.map((f) => `Saved video: ${f}`),
          ].join("\n");
          return `${baseText}\n${suffix}`;
        }
        return baseText;
      }

      if (savedImageFilenames.length > 0) {
        return savedImageFilenames.length === 1
          ? `Saved image: ${savedImageFilenames[0]}`
          : savedImageFilenames.map((f) => `Saved image: ${f}`).join("\n");
      }

      // Return raw result if no text content
      return result;
    }

    // Handle file paths in MCP results (when filePath parameter was provided)
    if (input?.filePath && typeof input.filePath === "string") {
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
              console.log(
                `[ToolRegistry] Copied MCP file to workspace: ${sourcePath} -> ${workspacePath}`,
              );
            }

            // Emit file_created event with workspace-relative path
            this.daemon.logEvent(this.taskId, "file_created", {
              path: filename,
              type: "screenshot",
              source: "mcp",
            });

            // Register as artifact if it's an image
            const ext = path.extname(filename).toLowerCase();
            const imageExtensions = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"];
            if (imageExtensions.includes(ext)) {
              const mimeTypes: Record<string, string> = {
                ".png": "image/png",
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
                ".gif": "image/gif",
                ".webp": "image/webp",
                ".bmp": "image/bmp",
              };
              this.daemon.registerArtifact(
                this.taskId,
                workspacePath,
                mimeTypes[ext] || "image/png",
              );
            }

            break;
          }
        } catch  {
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
    await this.qaTools.execute("qa_cleanup", {}).catch(() => {});
  }

  private storeResolvedSkillInvocation(application: SkillApplication): string {
    this.skillInvocationSequence += 1;
    const invocationId = `skill-${this.taskId}-${this.skillInvocationSequence}`;
    this.resolvedSkillInvocations.set(invocationId, application);
    return invocationId;
  }

  takeResolvedSkillInvocation(invocationId: string): SkillApplication | null {
    if (typeof invocationId !== "string" || invocationId.trim().length === 0) {
      return null;
    }
    const application = this.resolvedSkillInvocations.get(invocationId) || null;
    if (application) {
      this.resolvedSkillInvocations.delete(invocationId);
    }
    return application;
  }

  private buildSkillRuntimeDescriptor(skill: CustomSkill) {
    return getCustomSkillLoader().getRuntimeSkillDescriptor(skill);
  }

  private resolveSkillArgsToParameters(skill: CustomSkill, args: string): {
    success: boolean;
    parameters?: Record<string, Any>;
    error?: string;
  } {
    const trimmedArgs = String(args || "").trim();
    if (!trimmedArgs) {
      return { success: true, parameters: {} };
    }

    if (skill.id === "simplify" || skill.id === "batch" || skill.id === "llm-wiki") {
      const parsed = parseLeadingSkillSlashCommand(`/${skill.id}${trimmedArgs ? ` ${trimmedArgs}` : ""}`);
      if (!parsed.matched || parsed.error || !parsed.parsed) {
        const usageExample =
          skill.id === "batch"
            ? "/batch <objective> --parallel 4"
            : skill.id === "llm-wiki"
              ? "/llm-wiki <objective> --mode init --path research/wiki --obsidian auto"
              : "/simplify <objective> --scope current";
        return {
          success: false,
          error:
            parsed.error ||
            `Invalid arguments for skill '${skill.id}'. Use slash-style arguments such as "${usageExample}".`,
        };
      }

      const parameters: Record<string, Any> = {};
      if (skill.id === "llm-wiki" || parsed.parsed.objective) {
        parameters.objective = parsed.parsed.objective;
      }
      if (parsed.parsed.flags.domain) {
        parameters.domain = parsed.parsed.flags.domain;
      }
      if (parsed.parsed.flags.scope) {
        parameters.scope = parsed.parsed.flags.scope;
      }
      if (typeof parsed.parsed.flags.parallel === "number") {
        parameters.parallel = parsed.parsed.flags.parallel;
      }
      if (parsed.parsed.flags.external) {
        parameters.external = parsed.parsed.flags.external;
      }
      if (parsed.parsed.flags.mode) {
        parameters.mode = parsed.parsed.flags.mode;
      }
      if (parsed.parsed.flags.path) {
        parameters.path = parsed.parsed.flags.path;
      }
      if (parsed.parsed.flags.obsidian) {
        parameters.obsidian = parsed.parsed.flags.obsidian;
      }
      return { success: true, parameters };
    }

    try {
      const parsed = JSON.parse(trimmedArgs) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { success: true, parameters: parsed as Record<string, Any> };
      }
    } catch {
      // Fall through to heuristic raw-argument mapping.
    }

    if (!Array.isArray(skill.parameters) || skill.parameters.length === 0) {
      return { success: true, parameters: {} };
    }

    const parameters: Record<string, Any> = {};
    const exactPreferredName = ["objective", "input", "prompt", "query", "text"].find((name) =>
      skill.parameters?.some((parameter) => parameter.name === name),
    );
    if (exactPreferredName) {
      parameters[exactPreferredName] = trimmedArgs;
      return { success: true, parameters };
    }

    if (skill.parameters.length === 1) {
      parameters[skill.parameters[0].name] = trimmedArgs;
      return { success: true, parameters };
    }

    const requiredParameters = skill.parameters.filter((parameter) => parameter.required);
    if (requiredParameters.length === 1) {
      parameters[requiredParameters[0].name] = trimmedArgs;
      return { success: true, parameters };
    }

    parameters[skill.parameters[0].name] = trimmedArgs;
    return { success: true, parameters };
  }

  private applySkillParameterDefaults(
    skill: CustomSkill,
    parameters: Record<string, Any>,
  ): Record<string, Any> {
    const resolved = { ...(parameters || {}) };
    for (const param of skill.parameters || []) {
      if (!(param.name in resolved) && param.default !== undefined) {
        resolved[param.name] = param.default;
      }
    }
    return resolved;
  }

  /**
   * Execute the Skill tool - invokes a skill by ID and stores its expanded runtime context
   * for the executor to inject on the next turn.
   */
  private async executeSkillCommand(input: {
    skill: string;
    args?: string;
    trigger?: SkillApplicationTrigger;
  }): Promise<Any> {
    const skill_id = String(input.skill || "").trim();
    const rawArgs = String(input.args || "").trim();
    const trigger: SkillApplicationTrigger =
      input.trigger === "slash" ||
      input.trigger === "planner" ||
      input.trigger === "model" ||
      input.trigger === "explicit_hint"
        ? input.trigger
        : "model";
    const isManualInvocation = trigger === "slash";
    const isAutomaticInvocation = !isManualInvocation;

    const skillLoader = getCustomSkillLoader();
    const skill = skillLoader.getSkill(skill_id);
    const descriptor = skill ? this.buildSkillRuntimeDescriptor(skill) : null;

    if (!skill) {
      // List available skills to help the agent
      const availableSkills = skillLoader.listRuntimeSkillDescriptors().map((entry) => entry.name);
      return {
        success: false,
        error: `Skill '${skill_id}' not found`,
        available_skills: availableSkills.slice(0, 20), // Show up to 20 skills
        hint: "Use one of the listed skill IDs exposed through the Skill tool.",
      };
    }

    if (isManualInvocation && descriptor?.userInvocable === false) {
      return {
        success: false,
        error: `Skill '${skill_id}' cannot be invoked manually`,
        reason: "This skill is configured for programmatic invocation only",
      };
    }

    // Check if skill can be invoked by model
    if (isAutomaticInvocation && descriptor?.disableModelInvocation) {
      return {
        success: false,
        error: `Skill '${skill_id}' cannot be invoked automatically`,
        reason: "This skill is configured for manual invocation only",
      };
    }

    if (!(await this.passesSkillKeywordGate(skill, trigger))) {
      return {
        success: false,
        error: `Skill '${skill_id}' is not available for this task`,
        reason: isAutomaticInvocation
          ? "This skill is not auto-routable for the current canonical task intent."
          : "This skill is not available for the current task.",
      };
    }

    const status = await skillLoader.getSkillStatusEntry(skill_id);
    if (status && !status.eligible) {
      if (status.disabled) {
        return {
          success: false,
          error: `Skill '${skill_id}' is disabled`,
          reason: "The selected skill is disabled in configuration.",
          suggestion: "Enable it in skill settings or use an alternative skill.",
        };
      }

      if (status.blockedByAllowlist) {
        return {
          success: false,
          error: `Skill '${skill_id}' is blocked by skill allowlist/denylist policy`,
          reason: "Current workspace/instance policy does not allow this skill.",
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

      // Skills with install specs handle their own setup (detect → install → execute flow).
      // Allow expansion so the skill prompt can guide the user through installation.
      const hasInstallSpecs = Array.isArray(skill.install) && skill.install.length > 0;
      const onlyMissingBins =
        missing.env.length === 0 &&
        missing.config.length === 0 &&
        missing.os.length === 0 &&
        (missing.bins.length > 0 || missing.anyBins.length > 0);

      if (missingItems.length > 0 && !(hasInstallSpecs && onlyMissingBins)) {
        return {
          success: false,
          error: `Skill '${skill_id}' is not currently executable`,
          reason: "Missing or invalid skill prerequisites.",
          missing_requirements: missing,
          missing_items: missingItems,
          suggestion:
            "Install required binaries/tools, set required environment variables, or switch OS context, then retry.",
        };
      }
    }

    // Enforce tool-level requirements at invocation time.
    // This prevents selecting CLI-oriented skills when run_command/shell access is unavailable.
    const toolNames = new Set(this.getTools().map((tool) => tool.name));
    const requiredToolsFromSkill = Array.isArray((skill.requires as Any)?.tools)
      ? ((skill.requires as Any).tools as unknown[]).filter(
          (tool): tool is string => typeof tool === "string" && tool.trim().length > 0,
        )
      : [];
    const inferredRequiredTools: string[] = [];
    const hasBinaryRequirements =
      (Array.isArray(skill.requires?.bins) && skill.requires.bins.length > 0) ||
      (Array.isArray(skill.requires?.anyBins) && skill.requires.anyBins.length > 0);
    if (hasBinaryRequirements) {
      inferredRequiredTools.push("run_command");
    }

    const requiredTools = Array.from(
      new Set([...requiredToolsFromSkill, ...inferredRequiredTools]),
    );
    const missingTools = requiredTools.filter((tool) => !toolNames.has(tool));
    if (missingTools.length > 0) {
      return {
        success: false,
        error: `Skill '${skill_id}' is not currently executable`,
        reason: `Missing required tools: ${missingTools.join(", ")}`,
        missing_tools: missingTools,
        suggestion:
          "Enable the missing tools/integrations in this workspace context or use a different skill.",
      };
    }

    const parameterResolution = this.resolveSkillArgsToParameters(skill, rawArgs);
    if (!parameterResolution.success) {
      return {
        success: false,
        error: parameterResolution.error || `Invalid arguments for skill '${skill_id}'.`,
      };
    }

    const parameters = this.applySkillParameterDefaults(
      skill,
      parameterResolution.parameters || {},
    );

    // Check for required parameters
    const artifactDir = path.join(
      this.workspace.path,
      "artifacts",
      "skills",
      this.taskId,
      skill_id,
    );
    const workspaceArtifactDir = path.join(this.workspace.path, "artifacts");
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
      if (trigger === "slash") {
        const pendingCollection: PendingSkillParameterCollection = {
          skillId: skill_id,
          skillName: skill.name,
          trigger,
          parameters,
          requiredParameterNames: missingParams,
          currentParameterIndex: 0,
          startedAt: Date.now(),
        };
        return {
          success: true,
          skill: skill_id,
          skill_name: skill.name,
          message: `Collecting missing parameters for '${skill.name}'.`,
          pending_skill_parameter_collection: pendingCollection,
        };
      }
      return {
        success: false,
        error: `Missing required parameters: ${missingParams.join(", ")}`,
        skill_id,
        raw_args: rawArgs || undefined,
        parameters: skill.parameters?.map((p) => ({
          name: p.name,
          type: p.type,
          description: p.description,
          required: p.required,
          default: p.default,
          options: p.options,
        })),
      };
    }

    if (skill_id === "codex-cli") {
      const expandedPrompt = await this.buildCodexCliRuntimePrompt();
      const contextDirectives: SkillContextDirectives = {
        artifactDirectories: [artifactDir, workspaceArtifactDir],
        metadata: {
          source: skill.source || "unknown",
          category: skill.category || "General",
          runtimeMode: BuiltinToolsSettingsManager.getCodexRuntimeMode(),
        },
      };
      const skillApplication: SkillApplication = {
        skillId: skill_id,
        skillName: skill.name,
        trigger,
        args: rawArgs || undefined,
        parameters,
        content: expandedPrompt,
        reason:
          trigger === "slash"
            ? `Applied via /${skill_id}`
            : "Applied to add Codex runtime instructions without changing the original task.",
        appliedAt: Date.now(),
        contextDirectives,
      };
      this.daemon.logEvent(this.taskId, "log", {
        message: `Using skill: ${skill.name}`,
        skillId: skill_id,
        parameters,
        runtimeMode: BuiltinToolsSettingsManager.getCodexRuntimeMode(),
      });

      const invocationId = this.storeResolvedSkillInvocation(skillApplication);

      return {
        success: true,
        skill: skill_id,
        skill_name: skill.name,
        message: `Loaded skill '${skill.name}' for this task.`,
        application_summary:
          "Loaded Codex runtime guidance as hidden skill context for the current task.",
        skill_invocation_id: invocationId,
      };
    }

    // Expand the skill prompt with provided parameters
    const expandedPrompt = skillLoader.expandPrompt(skill, parameters, {
      artifactDir,
      workspaceArtifactDir,
    });
    const contextDirectives: SkillContextDirectives = {
      ...(Array.isArray((skill.requires as Any)?.tools) &&
      ((skill.requires as Any)?.tools as unknown[]).some((tool) => typeof tool === "string")
        ? {
            allowedTools: ((skill.requires as Any).tools as unknown[]).filter(
              (tool): tool is string => typeof tool === "string" && tool.trim().length > 0,
            ),
          }
        : {}),
      artifactDirectories: [artifactDir, workspaceArtifactDir],
      metadata: {
        source: skill.source || "unknown",
        category: skill.category || "General",
      },
    };
    const skillApplication: SkillApplication = {
      skillId: skill_id,
      skillName: skill.name,
      trigger,
      args: rawArgs || undefined,
      parameters,
      content: expandedPrompt,
      reason:
        trigger === "slash"
          ? `Applied via /${skill_id}`
          : "Applied as additive skill context while preserving the original task.",
      appliedAt: Date.now(),
      contextDirectives,
    };

    // Log the skill invocation
    this.daemon.logEvent(this.taskId, "log", {
      message: `Using skill: ${skill.name}`,
      skillId: skill_id,
      parameters,
      args: rawArgs || undefined,
    });

    const invocationId = this.storeResolvedSkillInvocation(skillApplication);

    return {
      success: true,
      skill: skill_id,
      skill_name: skill.name,
      message: `Loaded skill '${skill.name}' for this task.`,
      application_summary:
        `Loaded skill "${skill.name}" as hidden context for the current task.`,
      skill_invocation_id: invocationId,
    };
  }

  private async buildCodexCliRuntimePrompt(): Promise<string> {
    const runtimeMode = BuiltinToolsSettingsManager.getCodexRuntimeMode();
    const task = await this.daemon
      .getTaskById?.(this.taskId)
      .catch(() => null);

    const sourceTitle = this.extractCurrentTaskText(task?.title);
    const sourcePrompt =
      this.extractCurrentTaskText(task?.rawPrompt) ||
      this.extractCurrentTaskText(task?.userPrompt) ||
      this.extractCurrentTaskText(task?.prompt) ||
      sourceTitle ||
      "Handle the assigned coding task.";

    const childTitle = this.deriveCodexChildTaskTitle(sourceTitle, sourcePrompt);
    const childPrompt = this.deriveCodexChildTaskPrompt(sourcePrompt, sourceTitle);

    const runtimeSection =
      runtimeMode === "acpx"
        ? [
            '- `runtime`: `"acpx"`',
            '- `runtime_agent`: `"codex"`',
            "- This routes the child through the ACP/acpx runtime.",
          ].join("\n")
        : [
            "- Omit `runtime` so the child uses the native Codex CLI path.",
            "- Keep the work in the child task; do not probe the Codex CLI from the parent task.",
          ].join("\n");

    return [
      "# Codex Task Launcher",
      "",
      "Handle this request by delegating it to exactly one child task.",
      "Do not run `codex`, `acpx`, `which codex`, `codex --version`, or `codex --help` in the current task.",
      "",
      "1. Call `spawn_agent` once with:",
      `- \`title\`: ${JSON.stringify(childTitle)}`,
      "- `prompt`: the mission below",
      '- `capability_hint`: `"cli-agent"`',
      "- `wait`: `true`",
      runtimeSection,
      "",
      "2. Child task mission:",
      "```text",
      childPrompt,
      "```",
      "",
      "3. After the child finishes, summarize the result for the user.",
    ].join("\n");
  }

  private extractCurrentTaskText(value: unknown): string {
    if (typeof value !== "string") return "";
    return value.trim();
  }

  private deriveCodexChildTaskTitle(taskTitle: string, taskPrompt: string): string {
    const combined = `${taskTitle}\n${taskPrompt}`;
    if (/\breview|audit|inspect|critique\b/i.test(combined)) return "Codex review";
    if (/\bfix|debug|repair\b/i.test(combined)) return "Codex fix";
    if (/\bplan|analy[sz]e|investigate|research\b/i.test(combined)) return "Codex analysis";
    return "Codex task";
  }

  private deriveCodexChildTaskPrompt(taskPrompt: string, fallbackTitle: string): string {
    const source = this.extractCurrentTaskText(taskPrompt) || this.extractCurrentTaskText(fallbackTitle);
    if (!source) {
      return "Handle the assigned coding task. Focus on the user's requested outcome and report concrete results.";
    }

    let normalized = source;
    normalized = normalized.replace(
      /\b(?:use|run|call|invoke|activate|apply|launch|start|enable)\s+(?:the\s+)?codex(?:-|\s+)?cli(?:\s+agent)?\s+skill\s+(?:to\s+|for\s+)?/gi,
      "",
    );
    normalized = normalized.replace(
      /\bby\s+spawning\s+a\s+child\s+agent\s+titled\s+["'][^"']+["']\s+and\s+have\s+it\b/gi,
      "and",
    );
    normalized = normalized.replace(
      /\b(?:use|run|launch|start|spin up|spawn|have)\s+(?:a\s+|the\s+)?codex(?:\s+cli)?(?:\s+agent|\s+child\s+task|\s+child)?\s+(?:to\s+|for\s+)?/gi,
      "",
    );
    normalized = normalized.replace(/\b(?:with|via|using)\s+codex(?:\s+cli)?\b/gi, "");
    normalized = normalized.replace(/\bcodex(?:\s+cli)?\s+(review|fix|agent|task)\b/gi, "$1");
    normalized = normalized.replace(/\bspawn(?:ing)?\s+a\s+child\s+agent\b/gi, "");
    normalized = normalized.replace(/\bhave\s+it\b/gi, "");
    normalized = normalized.replace(/\s+/g, " ").trim();
    normalized = normalized.replace(/^[,.;:\-)\]]+\s*/g, "");

    if (!/[.!?]$/.test(normalized)) {
      normalized += ".";
    }

    return normalized;
  }

  /**
   * List all skills with metadata
   */
  /**
   * Check if a skill can be invoked for the current task.
   * Slash/manual invocation can always use user-invocable skills.
   * Model/planner invocation is limited to skills that are auto-routable for this task.
   */
  private async passesSkillKeywordGate(
    skill: CustomSkill,
    trigger: SkillApplicationTrigger = "model",
  ): Promise<boolean> {
    if (trigger === "slash") {
      return skill.invocation?.userInvocable !== false;
    }

    const skillLoader = getCustomSkillLoader();
    try {
      const task = await this.daemon.getTaskById(this.taskId);
      const prompt =
        String(task?.rawPrompt || "").trim() ||
        String(task?.userPrompt || "").trim() ||
        String(task?.prompt || "").trim();
      const query = [String(task?.title || "").trim(), prompt].filter(Boolean).join("\n");
      if (!query) return false;
      return skillLoader.matchesSkillRoutingQuery(skill, query);
    } catch {
      return false;
    }
  }

  private async executeSkillList(input: {
    source?: "all" | "bundled" | "managed" | "workspace";
    include_disabled?: boolean;
  }): Promise<Any> {
    const { source = "all", include_disabled = true } = input;
    const skillLoader = getCustomSkillLoader();

    let skills = skillLoader.listSkills();

    // Filter by source if specified
    if (source !== "all") {
      skills = skills.filter((s) => s.source === source);
    }

    // Filter out disabled if requested
    if (!include_disabled) {
      skills = skills.filter((s) => s.enabled !== false);
    }

    // Filter out keyword-gated skills that don't match the current task
    const gateResults = await Promise.all(skills.map((s) => this.passesSkillKeywordGate(s)));
    skills = skills.filter((_, i) => gateResults[i]);

    // Format for agent consumption
    const formattedSkills = skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      category: s.category || "General",
      icon: s.icon || "",
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
  private async executeSkillGet(input: { skill_id: string }): Promise<Any> {
    const { skill_id } = input;
    const skillLoader = getCustomSkillLoader();
    const skill = skillLoader.getSkill(skill_id);

    if (!skill) {
      const availableSkills = skillLoader.listSkills().map((s) => s.id);
      return {
        success: false,
        error: `Skill '${skill_id}' not found`,
        available_skills: availableSkills.slice(0, 30),
        hint: "Use one of the visible skill IDs from the Skill tool listing.",
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
      type: "string" | "number" | "boolean" | "select";
      description: string;
      required?: boolean;
      default?: string | number | boolean;
      options?: string[];
    }>;
    enabled?: boolean;
  }): Promise<Any> {
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
        hint: "Use a different ID or use skill_update to modify the existing skill",
      };
    }

    // Validate ID format
    if (!/^[a-z0-9-]+$/.test(input.id)) {
      return {
        success: false,
        error: "Invalid skill ID format",
        hint: 'Skill ID should be lowercase, using only letters, numbers, and hyphens (e.g., "my-custom-skill")',
      };
    }

    try {
      const newSkill = await skillLoader.createSkill({
        id: input.id,
        name: input.name,
        description: input.description,
        prompt: input.prompt,
        icon: input.icon || "",
        category: input.category || "Custom",
        parameters: input.parameters,
        enabled: input.enabled !== false,
      });

      this.daemon.logEvent(this.taskId, "log", {
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
    } catch (error: Any) {
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
      parameters?: Any[];
    };
  }): Promise<Any> {
    const { source_skill_id, new_id, modifications = {} } = input;
    const skillLoader = getCustomSkillLoader();

    // Get the source skill
    const sourceSkill = skillLoader.getSkill(source_skill_id);
    if (!sourceSkill) {
      return {
        success: false,
        error: `Source skill '${source_skill_id}' not found`,
        hint: "Use one of the visible skill IDs from the Skill tool listing.",
      };
    }

    // Check if new ID already exists
    const existing = skillLoader.getSkill(new_id);
    if (existing) {
      return {
        success: false,
        error: `Skill with ID '${new_id}' already exists`,
        hint: "Use a different ID for the duplicate",
      };
    }

    // Validate new ID format
    if (!/^[a-z0-9-]+$/.test(new_id)) {
      return {
        success: false,
        error: "Invalid skill ID format",
        hint: "Skill ID should be lowercase, using only letters, numbers, and hyphens",
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

      this.daemon.logEvent(this.taskId, "log", {
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
    } catch (error: Any) {
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
      parameters?: Any[];
      enabled?: boolean;
    };
  }): Promise<Any> {
    const { skill_id, updates } = input;
    const skillLoader = getCustomSkillLoader();

    const skill = skillLoader.getSkill(skill_id);
    if (!skill) {
      return {
        success: false,
        error: `Skill '${skill_id}' not found`,
        hint: "Use one of the visible skill IDs from the Skill tool listing.",
      };
    }

    // Check if skill can be updated
    if (skill.source === "bundled") {
      return {
        success: false,
        error: `Cannot update bundled skill '${skill_id}'`,
        hint: "Bundled skills are read-only. Use skill_duplicate to create an editable copy.",
        skill_source: skill.source,
      };
    }

    try {
      const updatedSkill = await skillLoader.updateSkill(skill_id, updates);
      if (!updatedSkill) {
        return {
          success: false,
          error: "Failed to update skill",
        };
      }

      this.daemon.logEvent(this.taskId, "log", {
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
    } catch (error: Any) {
      return {
        success: false,
        error: `Failed to update skill: ${error.message}`,
      };
    }
  }

  /**
   * Delete a skill
   */
  private async executeSkillDelete(input: { skill_id: string }): Promise<Any> {
    const { skill_id } = input;
    const skillLoader = getCustomSkillLoader();

    const skill = skillLoader.getSkill(skill_id);
    if (!skill) {
      return {
        success: false,
        error: `Skill '${skill_id}' not found`,
        hint: "Use one of the visible skill IDs from the Skill tool listing.",
      };
    }

    // Check if skill can be deleted
    if (skill.source === "bundled") {
      return {
        success: false,
        error: `Cannot delete bundled skill '${skill_id}'`,
        hint: "Bundled skills are read-only and cannot be deleted.",
        skill_source: skill.source,
      };
    }

    try {
      const deleted = await skillLoader.deleteSkill(skill_id);
      if (!deleted) {
        return {
          success: false,
          error: "Failed to delete skill",
        };
      }

      this.daemon.logEvent(this.taskId, "log", {
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
    } catch (error: Any) {
      return {
        success: false,
        error: `Failed to delete skill: ${error.message}`,
      };
    }
  }

  /**
   * Manage approval-gated skill proposals
   */
  private async executeSkillProposal(input: {
    action?: "create" | "list" | "approve" | "reject";
    proposal_id?: string;
    status?: "pending" | "approved" | "rejected" | "all";
    problem_statement?: string;
    evidence?: string[];
    required_tools?: string[];
    risk_note?: string;
    draft_skill?: {
      id?: string;
      name?: string;
      description?: string;
      prompt?: string;
      icon?: string;
      category?: string;
      parameters?: Any[];
      enabled?: boolean;
    };
    rejection_reason?: string;
  }): Promise<Any> {
    const action = input.action || "list";
    const proposalService = new SkillProposalService(this.workspace.path);

    if (action === "list") {
      const status = input.status || "pending";
      const proposals = await proposalService.list(status);
      return {
        success: true,
        action,
        status,
        total: proposals.length,
        proposals,
      };
    }

    if (action === "create") {
      const draftSkill = input.draft_skill || {};
      const createResult = await proposalService.create({
        problemStatement: input.problem_statement || "",
        evidence: input.evidence || [],
        requiredTools: input.required_tools || [],
        riskNote: input.risk_note || "",
        draftSkill: {
          id: draftSkill.id || "",
          name: draftSkill.name || "",
          description: draftSkill.description || "",
          prompt: draftSkill.prompt || "",
          icon: draftSkill.icon,
          category: draftSkill.category,
          parameters: draftSkill.parameters,
          enabled: draftSkill.enabled,
        },
      });

      if (createResult.blocked) {
        return {
          success: false,
          action,
          message: createResult.blocked,
        };
      }

      if (createResult.duplicateOf && createResult.cooldownUntil) {
        return {
          success: false,
          action,
          duplicate_of: createResult.duplicateOf,
          cooldown_until: createResult.cooldownUntil,
          message: "A similar proposal was recently rejected. Wait for cooldown before re-submitting.",
        };
      }

      if (createResult.duplicateOf) {
        return {
          success: false,
          action,
          duplicate_of: createResult.duplicateOf,
          message: "A matching proposal already exists.",
        };
      }

      if (createResult.proposal) {
        this.daemon.logEvent(this.taskId, "log", {
          message: `Created skill proposal '${createResult.proposal.id}'`,
          proposalId: createResult.proposal.id,
          requiredTools: createResult.proposal.requiredTools,
          draftSkillId: createResult.proposal.draftSkill.id,
        });
      }

      return {
        success: true,
        action,
        proposal: createResult.proposal,
        message: "Skill proposal created and awaiting approval.",
      };
    }

    if (action === "approve") {
      const proposalId = String(input.proposal_id || "").trim();
      if (!proposalId) {
        return {
          success: false,
          action,
          message: "proposal_id is required for approve",
        };
      }

      const proposal = await proposalService.get(proposalId);
      if (!proposal) {
        return {
          success: false,
          action,
          message: `Proposal '${proposalId}' not found`,
        };
      }
      if (proposal.status !== "pending") {
        return {
          success: false,
          action,
          message: `Proposal '${proposalId}' is not pending (current status: ${proposal.status})`,
          proposal,
        };
      }

      const availableToolNames = new Set(this.getTools().map((tool) => tool.name));
      const missingRequiredTools = proposal.requiredTools.filter(
        (toolName) => !availableToolNames.has(toolName),
      );
      if (missingRequiredTools.length > 0) {
        return {
          success: false,
          action,
          message:
            "Proposal requires tools that are not currently available in this runtime context.",
          missing_required_tools: missingRequiredTools,
        };
      }

      const placeholderIssues = this.validateSkillPlaceholderIntegrity(
        proposal.draftSkill.prompt,
        proposal.draftSkill.parameters,
      );
      if (placeholderIssues.length > 0) {
        return {
          success: false,
          action,
          message: "Draft skill has placeholder validation errors.",
          placeholder_issues: placeholderIssues,
        };
      }

      const skillLoader = getCustomSkillLoader();
      // Enforce workspace-scoped materialization for approved proposals.
      skillLoader.setWorkspaceSkillsDir(this.workspace.path);
      const existing = skillLoader.getSkill(proposal.draftSkill.id);

      let materializedSkill: Any;
      if (existing) {
        if (existing.source === "bundled") {
          return {
            success: false,
            action,
            message:
              `Cannot apply proposal to bundled skill '${existing.id}'. ` +
              "Duplicate the skill first or choose a different id.",
          };
        }
        materializedSkill = await skillLoader.updateSkill(existing.id, {
          name: proposal.draftSkill.name,
          description: proposal.draftSkill.description,
          prompt: proposal.draftSkill.prompt,
          icon: proposal.draftSkill.icon,
          category: proposal.draftSkill.category,
          parameters: proposal.draftSkill.parameters,
          enabled: proposal.draftSkill.enabled,
        });
      } else {
        materializedSkill = await skillLoader.createWorkspaceSkill({
          id: proposal.draftSkill.id,
          name: proposal.draftSkill.name,
          description: proposal.draftSkill.description,
          prompt: proposal.draftSkill.prompt,
          icon: proposal.draftSkill.icon || "",
          category: proposal.draftSkill.category || "Custom",
          parameters: proposal.draftSkill.parameters,
          enabled: proposal.draftSkill.enabled !== false,
        });
      }

      if (!materializedSkill) {
        return {
          success: false,
          action,
          message: "Failed to materialize skill from proposal",
        };
      }

      const approved = await proposalService.approve(proposal.id, materializedSkill.id);
      this.daemon.logEvent(this.taskId, "log", {
        message: `Approved skill proposal '${proposal.id}' and materialized skill '${materializedSkill.id}'`,
        proposalId: proposal.id,
        skillId: materializedSkill.id,
      });

      return {
        success: true,
        action,
        proposal: approved,
        skill: {
          id: materializedSkill.id,
          name: materializedSkill.name,
          source: materializedSkill.source,
          filePath: materializedSkill.filePath,
        },
        message: "Skill proposal approved and materialized.",
      };
    }

    if (action === "reject") {
      const proposalId = String(input.proposal_id || "").trim();
      if (!proposalId) {
        return {
          success: false,
          action,
          message: "proposal_id is required for reject",
        };
      }

      const rejected = await proposalService.reject(proposalId, input.rejection_reason);
      if (!rejected) {
        return {
          success: false,
          action,
          message: `Proposal '${proposalId}' not found or not pending`,
        };
      }

      this.daemon.logEvent(this.taskId, "log", {
        message: `Rejected skill proposal '${proposalId}'`,
        proposalId,
        reason: input.rejection_reason || null,
      });

      return {
        success: true,
        action,
        proposal: rejected,
        message: "Skill proposal rejected.",
      };
    }

    return {
      success: false,
      action,
      message: `Unsupported skill_proposal action: ${action}`,
    };
  }

  private validateSkillPlaceholderIntegrity(prompt: string, parameters?: Any[]): string[] {
    const text = String(prompt || "");
    const placeholders = new Set<string>();
    const placeholderPattern = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;
    for (const match of text.matchAll(placeholderPattern)) {
      if (match[1]) placeholders.add(match[1].trim());
    }

    const parameterNames = new Set(
      Array.isArray(parameters)
        ? parameters
            .map((param) => String(param?.name || "").trim())
            .filter((name) => Boolean(name))
        : [],
    );

    const issues: string[] = [];
    for (const placeholder of placeholders) {
      if (!parameterNames.has(placeholder)) {
        issues.push(`Missing parameter definition for placeholder {{${placeholder}}}`);
      }
    }
    return issues;
  }

  /**
   * Define file operation tools
   */
  private getFileToolDefinitions(): LLMTool[] {
    return [
      {
        name: "read_file",
        description:
          "Read the contents of a file in the workspace. Supports plain text files, DOCX (Word documents), PDF, and PPTX. For DOCX/PDF/PPTX, extracts and returns text. Supports chunked reads with startChar/maxChars for long documents.",
        input_schema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative path to the file within the workspace",
            },
            startChar: {
              type: "number",
              description:
                "Optional character offset for chunked reads. Use with maxChars to continue long files.",
            },
            maxChars: {
              type: "number",
              description:
                "Optional max characters to return for this read (default: 300000, max: 1000000).",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "read_files",
        description:
          "Read multiple files in one call using glob patterns. Useful for quickly attaching context without many read_file calls. " +
          'Supports exclusion patterns by prefixing with "!". Example: ["src/**/*.ts", "!src/**/__tests__/**"].',
        input_schema: {
          type: "object",
          properties: {
            patterns: {
              type: "array",
              items: { type: "string" },
              description:
                'Glob patterns to include/exclude. Prefix a pattern with "!" to exclude.',
            },
            path: {
              type: "string",
              description:
                "Base directory for globs (relative to workspace unless absolute path is allowed). Defaults to workspace root.",
            },
            maxFiles: {
              type: "number",
              description: "Maximum number of files to include (default: 12, max: 100)",
            },
            maxResults: {
              type: "number",
              description: "Maximum glob matches per pattern (default: 500, max: 5000)",
            },
            maxTotalChars: {
              type: "number",
              description:
                "Maximum total characters across returned file contents (default: 30000, max: 200000)",
            },
          },
          required: ["patterns"],
        },
      },
      {
        name: "write_file",
        description: "Write content to a file in the workspace (creates or overwrites)",
        input_schema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative path to the file within the workspace",
            },
            content: {
              type: "string",
              description: "Content to write to the file",
            },
          },
          required: ["path", "content"],
        },
      },
      {
        name: "copy_file",
        description:
          "Copy a file to a new location. Supports binary files (DOCX, PDF, images, etc.) and preserves exact file content.",
        input_schema: {
          type: "object",
          properties: {
            sourcePath: {
              type: "string",
              description: "Path to the source file to copy",
            },
            destPath: {
              type: "string",
              description: "Path for the destination file (the copy)",
            },
          },
          required: ["sourcePath", "destPath"],
        },
      },
      {
        name: "list_directory",
        description: "List files and folders in a directory",
        input_schema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: 'Relative path to the directory (or "." for workspace root)',
            },
          },
          required: ["path"],
        },
      },
      {
        name: "list_directory_with_sizes",
        description: "List files and folders in a directory with size summary (MCP-style output)",
        input_schema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative or absolute path to the directory",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "get_file_info",
        description: "Get file or directory metadata (size, timestamps, permissions)",
        input_schema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Path to the file or directory",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "rename_file",
        description: "Rename or move a file",
        input_schema: {
          type: "object",
          properties: {
            oldPath: {
              type: "string",
              description: "Current path of the file",
            },
            newPath: {
              type: "string",
              description: "New path for the file",
            },
          },
          required: ["oldPath", "newPath"],
        },
      },
      {
        name: "delete_file",
        description: "Delete a file (requires user approval)",
        input_schema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Path to the file to delete",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "create_directory",
        description: "Create a new directory",
        input_schema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Path for the new directory",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "search_files",
        description: "Search for files by name or content",
        input_schema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query (filename or content)",
            },
            path: {
              type: "string",
              description: "Directory to search in (optional, defaults to workspace root)",
            },
          },
          required: ["query"],
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
        name: "create_spreadsheet",
        description: "Create an Excel spreadsheet with data, formulas, and formatting",
        input_schema: {
          type: "object",
          properties: {
            filename: { type: "string", description: "Name of the Excel file (without extension)" },
            sheets: {
              type: "array",
              description: "Array of sheets to create",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", description: "Sheet name" },
                  data: {
                    type: "array",
                    description: "2D array of cell values (rows of columns)",
                    items: {
                      type: "array",
                      description: "Row of cell values",
                      items: { type: "string", description: "Cell value" },
                    },
                  },
                },
              },
            },
          },
          required: ["filename", "sheets"],
        },
      },
      {
        name: "create_document",
        description:
          "Create a Word document (.docx) or PDF. Only use when the user EXPLICITLY requests Word/DOCX/PDF format. For all other documents, prefer writing Markdown (.md) files with write_file.",
        input_schema: {
          type: "object",
          properties: {
            filename: { type: "string", description: "Name of the document" },
            format: { type: "string", enum: ["docx", "pdf"], description: "Output format" },
            content: {
              type: "array",
              description: "Document content blocks",
              items: {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["heading", "paragraph", "list"] },
                  text: { type: "string" },
                  level: { type: "number", description: "For headings: 1-6" },
                },
              },
            },
          },
          required: ["filename", "format", "content"],
        },
      },
      {
        name: "edit_document",
        description:
          "Edit an existing Word document (DOCX). Supports append, move_section, insert_after_section, replace_blocks, and list_sections. Use this to modify existing documents without recreating them from scratch.",
        input_schema: {
          type: "object",
          properties: {
            sourcePath: {
              type: "string",
              description: "Path to the existing DOCX file to edit",
            },
            destPath: {
              type: "string",
              description:
                "Optional: Path for the output file. If not specified, the source file will be overwritten.",
            },
            action: {
              type: "string",
              enum: ["append", "move_section", "insert_after_section", "replace_blocks", "list_sections"],
              description:
                "Action to perform: append adds content at end, move_section reorders a section, insert_after_section inserts content after a specific section, replace_blocks replaces contiguous parsed block IDs, list_sections lists sections",
            },
            newContent: {
              type: "array",
              description: "For append/insert_after_section/replace_blocks: Content blocks to add",
              items: {
                type: "object",
                properties: {
                  type: {
                    type: "string",
                    enum: ["heading", "paragraph", "list", "table"],
                    description: "Type of content block",
                  },
                  text: {
                    type: "string",
                    description: "Text content for the block",
                  },
                  level: {
                    type: "number",
                    description: "For headings: level 1-6",
                  },
                  items: {
                    type: "array",
                    items: { type: "string" },
                    description: "For lists: array of list items",
                  },
                  rows: {
                    type: "array",
                    items: {
                      type: "array",
                      items: { type: "string" },
                    },
                    description: "For tables: 2D array of cell values",
                  },
                },
                required: ["type", "text"],
              },
            },
            blockIds: {
              type: "array",
              description: "For replace_blocks: contiguous DOCX block IDs to replace",
              items: { type: "string" },
            },
            sectionToMove: {
              type: "string",
              description:
                'For move_section: Section number or heading text to move (e.g., "8" or "Ticket Indexing")',
            },
            afterSection: {
              type: "string",
              description:
                'For move_section: Section number or heading text after which to place the moved section (e.g., "7" or "Data Storage")',
            },
            insertAfterSection: {
              type: "string",
              description:
                "For insert_after_section: Section number or heading text after which to insert new content",
            },
          },
          required: ["sourcePath"],
        },
      },
      {
        name: "edit_pdf_region",
        description:
          "Edit a selected region in an existing PDF and write the result to a new PDF path while preserving the source file.",
        input_schema: {
          type: "object",
          properties: {
            sourcePath: {
              type: "string",
              description: "Workspace-relative path to the source PDF",
            },
            destPath: {
              type: "string",
              description: "Workspace-relative path for the edited PDF output",
            },
            pageIndex: {
              type: "number",
              description: "0-based page index containing the selected region",
            },
            bbox: {
              type: "object",
              description: "Normalized region bounds on the page",
              properties: {
                x: { type: "number" },
                y: { type: "number" },
                w: { type: "number" },
                h: { type: "number" },
              },
              required: ["x", "y", "w", "h"],
            },
            instruction: {
              type: "string",
              description: "Natural-language edit instruction for the selected PDF region",
            },
          },
          required: ["sourcePath", "destPath", "pageIndex", "bbox", "instruction"],
        },
      },
      {
        name: "create_presentation",
        description: "Create a PowerPoint presentation",
        input_schema: {
          type: "object",
          properties: {
            filename: { type: "string", description: "Name of the presentation" },
            slides: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  content: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
          required: ["filename", "slides"],
        },
      },
      {
        name: "organize_folder",
        description: "Organize files in a folder by type, date, or custom rules",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Folder path to organize" },
            strategy: {
              type: "string",
              enum: ["by_type", "by_date", "custom"],
              description: "Organization strategy",
            },
            rules: {
              type: "object",
              description: "Custom organization rules (if strategy is custom)",
            },
          },
          required: ["path", "strategy"],
        },
      },
      {
        name: "Skill",
        description:
          "Invoke a skill by ID when one clearly matches the task. If a matching skill exists, call Skill before using other tools or drafting the final answer. " +
          "The selected skill is expanded lazily into hidden task context instead of replacing the user's request.",
        input_schema: {
          type: "object",
          properties: {
            skill: {
              type: "string",
              description:
                'The canonical skill ID to invoke (for example "git-commit", "code-review", or "translate")',
            },
            args: {
              type: "string",
              description:
                "Raw argument string for the skill. For multi-parameter skills, pass a JSON object string when plain text is ambiguous.",
            },
          },
          required: ["skill"],
        },
        runtime: {
          concurrencyClass: "serial_only",
          readOnly: false,
          approvalKind: "none",
          sideEffectLevel: "low",
          interruptBehavior: "block",
          deferLoad: false,
          alwaysExpose: false,
          resultKind: "generic",
          supportsContextMutation: true,
          capabilityTags: ["core"],
          exposure: "conditional",
        },
      },
      // Skill Management Tools
      {
        name: "skill_create",
        description:
          "Create a new custom skill. The skill will be saved to the managed skills directory " +
          "(~/Library/Application Support/cowork-os/skills/). Provide the full skill definition.",
        input_schema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description:
                'Unique identifier for the skill (lowercase, hyphens allowed, e.g., "my-custom-skill")',
            },
            name: {
              type: "string",
              description: "Human-readable name for the skill",
            },
            description: {
              type: "string",
              description: "Brief description of what the skill does",
            },
            prompt: {
              type: "string",
              description: "The prompt template. Use {{paramName}} for parameter placeholders.",
            },
            icon: {
              type: "string",
              description: "Emoji icon for the skill (optional)",
            },
            category: {
              type: "string",
              description: 'Category for grouping (e.g., "Research", "Development", "Writing")',
            },
            parameters: {
              type: "array",
              description: "Array of parameter definitions",
              items: {
                type: "object",
                properties: {
                  name: {
                    type: "string",
                    description: "Parameter name (used in {{name}} placeholders)",
                  },
                  type: {
                    type: "string",
                    enum: ["string", "number", "boolean", "select"],
                    description: "Parameter type",
                  },
                  description: { type: "string", description: "Parameter description" },
                  required: { type: "boolean", description: "Whether the parameter is required" },
                  default: { type: "string", description: "Default value" },
                  options: {
                    type: "array",
                    items: { type: "string" },
                    description: "Options for select type",
                  },
                },
                required: ["name", "type", "description"],
              },
            },
            enabled: {
              type: "boolean",
              description: "Whether the skill is enabled. Default is true.",
            },
          },
          required: ["id", "name", "description", "prompt"],
        },
      },
      {
        name: "skill_duplicate",
        description:
          "Duplicate an existing skill with a new ID and optional modifications. " +
          "Great for creating variations of existing skills (e.g., changing time ranges, targets).",
        input_schema: {
          type: "object",
          properties: {
            source_skill_id: {
              type: "string",
              description: "The ID of the skill to duplicate",
            },
            new_id: {
              type: "string",
              description: "The ID for the new duplicated skill",
            },
            modifications: {
              type: "object",
              description:
                "Fields to modify in the duplicated skill (name, description, prompt, etc.)",
              properties: {
                name: { type: "string", description: "New name for the skill" },
                description: { type: "string", description: "New description" },
                prompt: { type: "string", description: "New prompt template" },
                icon: { type: "string", description: "New icon" },
                category: { type: "string", description: "New category" },
                parameters: {
                  type: "array",
                  description: "New parameters array",
                  items: {
                    type: "object",
                    properties: {
                      name: {
                        type: "string",
                        description: "Parameter name (used in {{name}} placeholders)",
                      },
                      type: {
                        type: "string",
                        enum: ["string", "number", "boolean", "select"],
                        description: "Parameter type",
                      },
                      description: { type: "string", description: "Parameter description" },
                      required: {
                        type: "boolean",
                        description: "Whether the parameter is required",
                      },
                      default: { type: "string", description: "Default value" },
                      options: {
                        type: "array",
                        items: { type: "string" },
                        description: "Options for select type",
                      },
                    },
                    required: ["name", "type", "description"],
                  },
                },
              },
            },
          },
          required: ["source_skill_id", "new_id"],
        },
      },
      {
        name: "skill_update",
        description:
          "Update an existing skill. Only managed and workspace skills can be updated (not bundled). " +
          "Provide only the fields you want to change.",
        input_schema: {
          type: "object",
          properties: {
            skill_id: {
              type: "string",
              description: "The ID of the skill to update",
            },
            updates: {
              type: "object",
              description: "Fields to update",
              properties: {
                name: { type: "string", description: "New name" },
                description: { type: "string", description: "New description" },
                prompt: { type: "string", description: "New prompt template" },
                icon: { type: "string", description: "New icon" },
                category: { type: "string", description: "New category" },
                parameters: {
                  type: "array",
                  description: "New parameters array",
                  items: {
                    type: "object",
                    properties: {
                      name: {
                        type: "string",
                        description: "Parameter name (used in {{name}} placeholders)",
                      },
                      type: {
                        type: "string",
                        enum: ["string", "number", "boolean", "select"],
                        description: "Parameter type",
                      },
                      description: { type: "string", description: "Parameter description" },
                      required: {
                        type: "boolean",
                        description: "Whether the parameter is required",
                      },
                      default: { type: "string", description: "Default value" },
                      options: {
                        type: "array",
                        items: { type: "string" },
                        description: "Options for select type",
                      },
                    },
                    required: ["name", "type", "description"],
                  },
                },
                enabled: { type: "boolean", description: "Enable/disable the skill" },
              },
            },
          },
          required: ["skill_id", "updates"],
        },
      },
      {
        name: "skill_delete",
        description:
          "Delete a skill. Only managed and workspace skills can be deleted (not bundled). " +
          "This permanently removes the skill file.",
        input_schema: {
          type: "object",
          properties: {
            skill_id: {
              type: "string",
              description: "The ID of the skill to delete",
            },
          },
          required: ["skill_id"],
        },
      },
      {
        name: "skill_proposal",
        description:
          "Manage approval-gated skill proposals. Create proposals for missing capabilities, list pending proposals, and approve/reject proposals. " +
          "Skill mutations happen only after explicit approve.",
        input_schema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["create", "list", "approve", "reject"],
              description: "Proposal action to execute",
            },
            proposal_id: {
              type: "string",
              description: "Proposal ID (required for approve/reject)",
            },
            status: {
              type: "string",
              enum: ["pending", "approved", "rejected", "all"],
              description: "Filter for list action (default: pending)",
            },
            problem_statement: {
              type: "string",
              description: "What capability gap this proposal addresses",
            },
            evidence: {
              type: "array",
              description: "Observed evidence snippets that justify the proposal",
              items: { type: "string" },
            },
            required_tools: {
              type: "array",
              description: "Tool names required by the proposed skill",
              items: { type: "string" },
            },
            risk_note: {
              type: "string",
              description: "Risk notes and safety considerations for approving this skill",
            },
            draft_skill: {
              type: "object",
              description:
                "Draft skill payload to materialize on approve (id, name, description, prompt, optional parameters/icon/category/enabled).",
              additionalProperties: true,
            },
            rejection_reason: {
              type: "string",
              description: "Optional reason for rejecting a proposal",
            },
          },
          required: ["action"],
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
    const paidProviders = configuredProviders.filter((p) => p.type !== "duckduckgo");
    const allSupportedTypes = [...new Set(configuredProviders.flatMap((p) => p.supportedTypes))];

    const providerDesc =
      paidProviders.length > 0
        ? `Configured providers: ${paidProviders.map((p) => p.name).join(", ")} (with DuckDuckGo as fallback)`
        : `Using DuckDuckGo (free built-in search)`;

    return [
      {
        name: "web_search",
        description:
          `Search the web for information. This is the PRIMARY tool for research tasks - finding news, trends, discussions, and information on any topic. ` +
          `Use this FIRST for research, then use web_fetch if you need to read specific URLs from the results. ` +
          `Do NOT use browser_navigate for research - web_search is faster and more efficient. ` +
          providerDesc,
        input_schema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The search query",
            },
            searchType: {
              type: "string",
              enum: allSupportedTypes,
              description: `Type of search. Available: ${allSupportedTypes.join(", ")}`,
            },
            maxResults: {
              type: "number",
              description: "Maximum number of results (default: 10, max: 20)",
            },
            maxUses: {
              type: "number",
              description:
                "Optional per-call web_search usage cap. Executor clamps this against task/step policy limits.",
            },
            provider: {
              type: "string",
              enum: configuredProviders.map((p) => p.type),
              description: `Override the search provider. Available: ${configuredProviders.map((p) => p.type).join(", ")}`,
            },
            dateRange: {
              type: "string",
              enum: ["day", "week", "month", "year"],
              description: "Filter results by date range",
            },
            region: {
              type: "string",
              description: 'Region code for localized results (e.g., "us", "uk", "de")',
            },
          },
          required: ["query"],
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
        name: "x_action",
        description:
          "Use the connected X/Twitter account to read, search, and post. " +
          "Posting actions (tweet/reply/follow/unfollow) require user approval. " +
          "If X blocks a request (rate limit/challenge/auth/access issue), this tool attempts browser-mode fallback for read/write actions.",
        input_schema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "whoami",
                "read",
                "thread",
                "replies",
                "search",
                "user_tweets",
                "mentions",
                "home",
                "tweet",
                "reply",
                "follow",
                "unfollow",
              ],
              description: "Action to perform",
            },
            id_or_url: {
              type: "string",
              description: "Tweet URL or ID (for read/thread/replies/reply)",
            },
            query: {
              type: "string",
              description: "Search query (for search)",
            },
            user: {
              type: "string",
              description:
                "User handle (with or without @) for user_tweets/mentions/follow/unfollow",
            },
            text: {
              type: "string",
              description: "Text for tweet/reply",
            },
            timeline: {
              type: "string",
              enum: ["for_you", "following"],
              description: "Timeline for home (default: for_you)",
            },
            count: {
              type: "number",
              description: "Max results (1-50) for search/mentions/home/user_tweets",
            },
            media: {
              type: "array",
              description: "Media file paths (workspace-relative). Up to 4 images or 1 video.",
              items: { type: "string" },
            },
            alt: {
              type: "string",
              description: "Alt text for media (single string)",
            },
          },
          required: ["action"],
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
        name: "notion_action",
        description:
          "Use the connected Notion account to search, read, and update pages/data sources. " +
          "Write actions (create/update/append) require user approval.",
        input_schema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "search",
                "list_users",
                "get_user",
                "get_page",
                "get_page_property",
                "get_database",
                "get_block",
                "get_block_children",
                "update_block",
                "delete_block",
                "create_page",
                "update_page",
                "append_blocks",
                "query_data_source",
                "get_data_source",
                "create_data_source",
                "update_data_source",
              ],
              description: "Action to perform",
            },
            query: {
              type: "string",
              description: "Search query (for search)",
            },
            user_id: {
              type: "string",
              description: "User ID (for get_user)",
            },
            page_id: {
              type: "string",
              description: "Page ID (for get_page/update_page)",
            },
            property_id: {
              type: "string",
              description: "Property ID (for get_page_property)",
            },
            block_id: {
              type: "string",
              description:
                "Block ID (for get_block/get_block_children/append_blocks/update_block/delete_block)",
            },
            block_type: {
              type: "string",
              description: 'Block type key for update_block (e.g., "paragraph")',
            },
            block: {
              type: "object",
              description: "Block payload for update_block (e.g., { rich_text: [...] })",
            },
            data_source_id: {
              type: "string",
              description: "Data source ID (for query_data_source/get_data_source)",
            },
            database_id: {
              type: "string",
              description: "Database ID (for create_page/get_database)",
            },
            parent_page_id: {
              type: "string",
              description: "Parent page ID (for create_page or create_data_source)",
            },
            properties: {
              type: "object",
              description: "Notion properties payload for create/update",
            },
            children: {
              type: "array",
              description: "Block children payload for append_blocks",
              items: { type: "object" },
            },
            filter: {
              type: "object",
              description: "Filter object for search/query",
            },
            sort: {
              type: "object",
              description: "Sort object for search",
            },
            sorts: {
              type: "array",
              description: "Sorts array for search/query",
              items: { type: "object" },
            },
            start_cursor: {
              type: "string",
              description: "Pagination cursor",
            },
            page_size: {
              type: "number",
              description: "Pagination page size",
            },
            archived: {
              type: "boolean",
              description: "Archive/unarchive page (for update_page)",
            },
            icon: {
              type: "object",
              description: "Icon payload (for create/update)",
            },
            cover: {
              type: "object",
              description: "Cover payload (for create/update)",
            },
            title: {
              type: "string",
              description: "Title for create_data_source/update_data_source",
            },
            is_inline: {
              type: "boolean",
              description: "Create inline data source (for create_data_source)",
            },
            payload: {
              type: "object",
              description: "Raw request body to send directly (advanced use)",
            },
          },
          required: ["action"],
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
        name: "box_action",
        description:
          "Use the connected Box account to search, read, and manage files/folders. " +
          "Write actions (create/upload/delete) require user approval.",
        input_schema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "get_current_user",
                "search",
                "get_file",
                "get_folder",
                "list_folder_items",
                "create_folder",
                "delete_file",
                "delete_folder",
                "upload_file",
              ],
              description: "Action to perform",
            },
            query: {
              type: "string",
              description: "Search query (for search)",
            },
            limit: {
              type: "number",
              description: "Max results (for search/list_folder_items)",
            },
            maxResults: {
              type: "number",
              description:
                "Alias for limit (kept for compatibility with older prompts/plans).",
            },
            offset: {
              type: "number",
              description: "Offset for pagination (for search/list_folder_items)",
            },
            use_marker: {
              type: "boolean",
              description:
                "Use marker-based pagination for list_folder_items (Box API usemarker=true).",
            },
            marker: {
              type: "string",
              description: "Marker token for marker-based pagination on list_folder_items.",
            },
            fields: {
              type: "string",
              description: "Comma-separated fields to return",
            },
            type: {
              type: "string",
              enum: ["file", "folder", "web_link"],
              description: "Filter search results by type",
            },
            ancestor_folder_ids: {
              type: "string",
              description: "Comma-separated ancestor folder IDs for search",
            },
            file_extensions: {
              type: "string",
              description: "Comma-separated file extensions for search",
            },
            content_types: {
              type: "string",
              description: "Comma-separated content types for search",
            },
            scope: {
              type: "string",
              description: "Search scope (e.g., user_content)",
            },
            folder_id: {
              type: "string",
              description: "Folder ID (for get_folder/list_folder_items/delete_folder)",
            },
            file_id: {
              type: "string",
              description: "File ID (for get_file/delete_file)",
            },
            parent_id: {
              type: "string",
              description: "Parent folder ID (for create_folder/upload_file). Defaults to root.",
            },
            name: {
              type: "string",
              description: "Name for create_folder/upload_file",
            },
            file_path: {
              type: "string",
              description: "Workspace-relative path to upload (for upload_file)",
            },
            include_raw: {
              type: "boolean",
              description:
                "Include raw response text in tool result (debug only; disabled by default to reduce token usage).",
            },
          },
          required: ["action"],
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
        name: "onedrive_action",
        description:
          "Use the connected OneDrive account to search, read, and manage files/folders. " +
          "Write actions (create/upload/delete) require user approval.",
        input_schema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "get_drive",
                "search",
                "list_children",
                "get_item",
                "create_folder",
                "upload_file",
                "delete_item",
              ],
              description: "Action to perform",
            },
            drive_id: {
              type: "string",
              description: "Drive ID override (optional)",
            },
            item_id: {
              type: "string",
              description: "Item ID (for get_item/list_children/delete_item)",
            },
            query: {
              type: "string",
              description: "Search query (for search)",
            },
            parent_id: {
              type: "string",
              description: "Parent folder ID (for create_folder/upload_file)",
            },
            name: {
              type: "string",
              description: "Name for create_folder or uploaded file",
            },
            conflict_behavior: {
              type: "string",
              enum: ["rename", "fail", "replace"],
              description: "Conflict behavior for create_folder",
            },
            file_path: {
              type: "string",
              description: "Workspace-relative path to upload (for upload_file)",
            },
            remote_path: {
              type: "string",
              description: "Remote path (for upload_file, relative to root)",
            },
          },
          required: ["action"],
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
        name: "google_drive_action",
        description:
          "Use the connected Google Drive account to search, read, and manage files/folders. " +
          "Write actions (create/upload/delete) require user approval.",
        input_schema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "get_current_user",
                "list_files",
                "get_file",
                "create_folder",
                "upload_file",
                "delete_file",
              ],
              description: "Action to perform",
            },
            query: {
              type: "string",
              description: "Search query (Drive query syntax) for list_files",
            },
            page_size: {
              type: "number",
              description: "Max results (for list_files)",
            },
            page_token: {
              type: "string",
              description: "Pagination token (for list_files)",
            },
            fields: {
              type: "string",
              description: "Fields selector (for list_files/get_file)",
            },
            file_id: {
              type: "string",
              description: "File ID (for get_file/delete_file)",
            },
            parent_id: {
              type: "string",
              description: "Parent folder ID (for create_folder/upload_file)",
            },
            name: {
              type: "string",
              description: "Name for create_folder/upload_file",
            },
            file_path: {
              type: "string",
              description: "Workspace-relative path to upload (for upload_file)",
            },
          },
          required: ["action"],
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
        name: "gmail_action",
        description:
          "Use the connected Gmail account to search, read, draft, label, archive, and send messages. " +
          "Write actions require user approval.",
        input_schema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "get_profile",
                "list_messages",
                "get_message",
                "get_thread",
                "list_labels",
                "create_draft",
                "send_message",
                "reply_to_thread",
                "archive_thread",
                "modify_thread_labels",
                "batch_modify_messages",
                "trash_message",
              ],
              description: "Action to perform",
            },
            query: {
              type: "string",
              description: "Gmail search query (for list_messages)",
            },
            page_size: {
              type: "number",
              description: "Max results (for list_messages)",
            },
            page_token: {
              type: "string",
              description: "Pagination token (for list_messages)",
            },
            label_ids: {
              type: "array",
              items: { type: "string" },
              description: "Label IDs filter (for list_messages)",
            },
            include_spam_trash: {
              type: "boolean",
              description: "Include spam/trash (for list_messages)",
            },
            message_id: {
              type: "string",
              description: "Message ID (for get_message/trash_message)",
            },
            thread_id: {
              type: "string",
              description:
                "Thread ID (for get_thread/send_message/create_draft/reply_to_thread/archive_thread/modify_thread_labels)",
            },
            format: {
              type: "string",
              enum: ["full", "metadata", "minimal", "raw"],
              description: "Message format (for get_message/get_thread)",
            },
            metadata_headers: {
              type: "array",
              items: { type: "string" },
              description: "Metadata headers to include (for metadata format)",
            },
            to: {
              type: "string",
              description: "Recipient email (for send_message)",
            },
            cc: {
              type: "string",
              description: "CC recipients (for send_message)",
            },
            bcc: {
              type: "string",
              description: "BCC recipients (for send_message)",
            },
            subject: {
              type: "string",
              description: "Email subject (for send_message)",
            },
            body: {
              type: "string",
              description: "Email body (for send_message)",
            },
            raw: {
              type: "string",
              description: "Base64url encoded RFC 2822 message (for send_message)",
            },
            label_ids_add: {
              type: "array",
              items: { type: "string" },
              description: "Label IDs to add (for modify_thread_labels/batch_modify_messages)",
            },
            label_ids_remove: {
              type: "array",
              items: { type: "string" },
              description: "Label IDs to remove (for modify_thread_labels/batch_modify_messages)",
            },
            message_ids: {
              type: "array",
              items: { type: "string" },
              description: "Message IDs for batch_modify_messages",
            },
          },
          required: ["action"],
        },
      },
    ];
  }

  private getMailboxToolDefinitions(): LLMTool[] {
    return [
      {
        name: "mailbox_action",
        description:
          "Unified Inbox Agent workflow over Gmail or IMAP mailboxes: sync, score threads, summarize, draft replies, extract commitments, review bulk cleanup/follow-ups, and apply approved actions.",
        input_schema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "sync",
                "list_threads",
                "get_thread",
                "summarize_thread",
                "generate_draft",
                "extract_commitments",
                "propose_cleanup",
                "propose_followups",
                "schedule_reply",
                "research_contact",
                "apply_action",
                "review_bulk_action",
              ],
              description: "Mailbox workflow action to perform",
            },
            thread_id: {
              type: "string",
              description: "Mailbox thread ID for thread-scoped actions",
            },
            query: {
              type: "string",
              description: "Text search against subject/snippet when listing threads",
            },
            category: {
              type: "string",
              description: "Optional category filter for list_threads",
            },
            needs_reply: {
              type: "boolean",
              description: "Filter list_threads to reply-needed threads",
            },
            cleanup_candidate: {
              type: "boolean",
              description: "Filter list_threads to cleanup candidates",
            },
            limit: {
              type: "number",
              description: "Max results to return",
            },
            tone: {
              type: "string",
              enum: ["concise", "warm", "direct", "executive"],
              description: "Draft tone for generate_draft",
            },
            include_availability: {
              type: "boolean",
              description: "Include availability suggestions in generated drafts",
            },
            proposal_id: {
              type: "string",
              description: "Proposal ID for apply_action",
            },
            draft_id: {
              type: "string",
              description: "Draft ID for send_draft mailbox actions",
            },
            type: {
              type: "string",
              enum: [
                "cleanup",
                "follow_up",
                "archive",
                "trash",
                "mark_read",
                "label",
                "send_draft",
                "discard_draft",
                "schedule_event",
                "dismiss_proposal",
              ],
              description: "Subtype for review_bulk_action or apply_action",
            },
            label: {
              type: "string",
              description: "Label to apply during mailbox label actions",
            },
          },
          required: ["action"],
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
        name: "calendar_action",
        description:
          "Use the connected Google Calendar account to list and manage events. " +
          "Write actions (create/update/delete) require user approval.",
        input_schema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "list_calendars",
                "list_events",
                "get_event",
                "create_event",
                "update_event",
                "delete_event",
              ],
              description: "Action to perform",
            },
            calendar_id: {
              type: "string",
              description: "Calendar ID (defaults to primary)",
            },
            event_id: {
              type: "string",
              description: "Event ID (for get/update/delete)",
            },
            query: {
              type: "string",
              description: "Search query (for list_events)",
            },
            time_min: {
              type: "string",
              description: "ISO start time (for list_events)",
            },
            time_max: {
              type: "string",
              description: "ISO end time (for list_events)",
            },
            max_results: {
              type: "number",
              description: "Max results (for list_events)",
            },
            page_token: {
              type: "string",
              description: "Pagination token (for list_events)",
            },
            single_events: {
              type: "boolean",
              description: "Expand recurring events (for list_events)",
            },
            order_by: {
              type: "string",
              enum: ["startTime", "updated"],
              description: "Order results (for list_events)",
            },
            summary: {
              type: "string",
              description: "Event summary (for create/update)",
            },
            description: {
              type: "string",
              description: "Event description (for create/update)",
            },
            location: {
              type: "string",
              description: "Event location (for create/update)",
            },
            start: {
              type: "string",
              description: "Event start ISO time (for create/update)",
            },
            end: {
              type: "string",
              description: "Event end ISO time (for create/update)",
            },
            attendees: {
              type: "array",
              items: { type: "string" },
              description: "Attendee emails (for create/update)",
            },
            time_zone: {
              type: "string",
              description: "IANA time zone (for create/update)",
            },
            payload: {
              type: "object",
              description: "Raw event payload override (for create/update)",
            },
          },
          required: ["action"],
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
        name: "apple_calendar_action",
        description:
          "Use the local Apple Calendar app on macOS to list and manage events. " +
          "Write actions (create/update/delete) require user approval.",
        input_schema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "list_calendars",
                "list_events",
                "get_event",
                "create_event",
                "update_event",
                "delete_event",
              ],
              description: "Action to perform",
            },
            calendar_id: {
              type: "string",
              description:
                "Calendar identifier (calendarIdentifier) or calendar name (optional; defaults to a writable calendar)",
            },
            event_id: {
              type: "string",
              description: "Event UID (for get/update/delete)",
            },
            query: {
              type: "string",
              description: "Search query (for list_events; matched against summary/notes/location)",
            },
            time_min: {
              type: "string",
              description: "ISO start time (for list_events; default: now)",
            },
            time_max: {
              type: "string",
              description: "ISO end time (for list_events; default: now + 7 days)",
            },
            max_results: {
              type: "number",
              description: "Max results (for list_events; default: 50, max: 500)",
            },
            summary: {
              type: "string",
              description: "Event summary (for create/update)",
            },
            description: {
              type: "string",
              description: "Event notes (for create/update)",
            },
            location: {
              type: "string",
              description: "Event location (for create/update)",
            },
            start: {
              type: "string",
              description: "Event start ISO time (for create/update)",
            },
            end: {
              type: "string",
              description: "Event end ISO time (for create/update)",
            },
          },
          required: ["action"],
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
        name: "apple_reminders_action",
        description:
          "Use the local Apple Reminders app on macOS to list and manage reminders. " +
          "Write actions (create/update/complete/delete) require user approval.",
        input_schema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "list_lists",
                "list_reminders",
                "get_reminder",
                "create_reminder",
                "update_reminder",
                "complete_reminder",
                "delete_reminder",
              ],
              description: "Action to perform",
            },
            list_id: {
              type: "string",
              description:
                "List identifier (id) or list name (optional; defaults to the first list)",
            },
            reminder_id: {
              type: "string",
              description: "Reminder identifier (for get/update/complete/delete)",
            },
            query: {
              type: "string",
              description:
                "Search query (for list_reminders; matched against title/notes/list name)",
            },
            include_completed: {
              type: "boolean",
              description: "Include completed reminders (for list_reminders; default: false)",
            },
            due_min: {
              type: "string",
              description: "ISO start time for due-date filtering (for list_reminders; optional)",
            },
            due_max: {
              type: "string",
              description: "ISO end time for due-date filtering (for list_reminders; optional)",
            },
            max_results: {
              type: "number",
              description: "Max results (for list_reminders; default: 100, max: 500)",
            },
            title: {
              type: "string",
              description: "Reminder title (for create/update)",
            },
            notes: {
              type: "string",
              description: "Reminder notes (for create/update)",
            },
            due: {
              type: "string",
              description: "ISO due datetime (for create/update)",
            },
          },
          required: ["action"],
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
        name: "dropbox_action",
        description:
          "Use the connected Dropbox account to search, read, and manage files/folders. " +
          "Write actions (create/upload/delete) require user approval.",
        input_schema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "get_current_user",
                "list_folder",
                "list_folder_continue",
                "search",
                "get_metadata",
                "create_folder",
                "delete_item",
                "upload_file",
              ],
              description: "Action to perform",
            },
            path: {
              type: "string",
              description:
                "Dropbox path (for list_folder/get_metadata/create_folder/delete_item/upload_file)",
            },
            query: {
              type: "string",
              description: "Search query (for search)",
            },
            limit: {
              type: "number",
              description: "Max results (for list/search)",
            },
            cursor: {
              type: "string",
              description: "Pagination cursor (for list_folder_continue)",
            },
            name: {
              type: "string",
              description: "Name for upload_file",
            },
            parent_path: {
              type: "string",
              description: "Parent folder path (for upload_file when path not provided)",
            },
            file_path: {
              type: "string",
              description: "Workspace-relative path to upload (for upload_file)",
            },
          },
          required: ["action"],
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
        name: "sharepoint_action",
        description:
          "Use the connected SharePoint account to search sites and manage drive items. " +
          "Write actions (create/upload/delete) require user approval.",
        input_schema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "get_current_user",
                "search_sites",
                "get_site",
                "list_site_drives",
                "list_drive_items",
                "get_item",
                "create_folder",
                "upload_file",
                "delete_item",
              ],
              description: "Action to perform",
            },
            site_id: {
              type: "string",
              description: "Site ID (for get_site/list_site_drives)",
            },
            drive_id: {
              type: "string",
              description: "Drive ID (for list/get/create/upload/delete)",
            },
            item_id: {
              type: "string",
              description: "Item ID (for list_drive_items/get_item/delete_item)",
            },
            query: {
              type: "string",
              description: "Search query (for search_sites)",
            },
            parent_id: {
              type: "string",
              description: "Parent folder ID (for create_folder/upload_file)",
            },
            name: {
              type: "string",
              description: "Name for create_folder/upload_file",
            },
            conflict_behavior: {
              type: "string",
              enum: ["rename", "fail", "replace"],
              description: "Conflict behavior for create_folder",
            },
            file_path: {
              type: "string",
              description: "Workspace-relative path to upload (for upload_file)",
            },
            remote_path: {
              type: "string",
              description: "Remote path (for upload_file, relative to root)",
            },
          },
          required: ["action"],
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
        name: "voice_call",
        description:
          "Initiate an outbound phone call via ElevenLabs Agents + Twilio integration. " +
          "Placing a call requires user approval. You can also list configured agents and phone numbers.",
        input_schema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["list_agents", "list_phone_numbers", "initiate_call"],
              description: "Action to perform",
            },
            to_number: {
              type: "string",
              description: 'Destination phone number in E.164 format (e.g., "+15555550123")',
            },
            agent_id: {
              type: "string",
              description:
                "ElevenLabs Agent ID. Optional if you set a default Agent ID in Settings > Voice > Phone Calls.",
            },
            agent_phone_number_id: {
              type: "string",
              description:
                "ElevenLabs agent phone number ID to use for outbound calls. Optional if configured in Settings > Voice > Phone Calls.",
            },
            dynamic_variables: {
              type: "object",
              description:
                "Dynamic variables to pass into the call. These can be referenced by the agent configuration.",
              additionalProperties: true,
            },
            conversation_config_override: {
              type: "object",
              description: "Optional per-call conversation config override object (advanced).",
              additionalProperties: true,
            },
            prompt: {
              type: "string",
              description:
                "Convenience: set conversation_config_override.agent.prompt.prompt for this call (advanced).",
            },
            first_message: {
              type: "string",
              description:
                "Convenience: set conversation_config_override.agent.first_message for this call (advanced).",
            },
            conversation_initiation_client_data: {
              type: "object",
              description:
                "Advanced: pass the full conversation initiation client data object. If provided, it overrides dynamic_variables/prompt/first_message/conversation_config_override.",
              additionalProperties: true,
            },
            cursor: {
              type: "string",
              description: "Pagination cursor (for list actions)",
            },
            page_size: {
              type: "number",
              description: "Page size (for list actions)",
            },
            include_archived: {
              type: "boolean",
              description: "Include archived entries (for list actions)",
            },
          },
          required: ["action"],
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
        name: "run_command",
        description:
          "Execute a shell command in the workspace directory. IMPORTANT: This tool requires user approval before execution. The user will see the command and can approve or deny it. Use this for installing packages (npm, pip, brew), running build commands, git operations, or any terminal commands.",
        input_schema: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description:
                'The shell command to execute (e.g., "npm install", "git status", "ls -la")',
            },
            cwd: {
              type: "string",
              description:
                "Working directory for the command (optional, defaults to workspace root)",
            },
            timeout: {
              type: "number",
              description:
                "Timeout in milliseconds (optional, default: 120000; build/test/install commands may infer longer timeouts automatically; max: 300000)",
            },
          },
          required: ["command"],
        },
      },
    ];
  }

  private async integrationSetup(input: {
    action?: string;
    provider?: string;
    auth_method?: "auto" | IntegrationAuthMethod;
    env?: Record<string, unknown>;
    oauth?: {
      client_id?: string;
      client_secret?: string;
      scopes?: string[];
      login_url?: string;
      subdomain?: string;
      team_domain?: string;
    };
    expected_plan_hash?: string;
    dry_run?: boolean;
    api_key?: string;
    webhook_secret?: string;
    base_url?: string;
    enable_inbound?: boolean;
    connect_now?: boolean;
    allow_unsafe_external_content?: boolean;
  }): Promise<Any> {
    const action: "list" | "inspect" | "configure" =
      input?.action === "list" || input?.action === "configure" ? input.action : "inspect";
    const requestedProvider = (input?.provider || "resend").trim().toLowerCase();

    MCPSettingsManager.initialize();
    const mcpClient = MCPClientManager.getInstance();

    if (action === "list") {
      const settings = MCPSettingsManager.loadSettings();
      const providers = listTier1ConnectorCapabilities().map((capability) => {
        const server = this.findConnectorServer(settings, capability);
        const readiness = evaluateConnectorReadiness({
          capability,
          env: server?.env,
          authMethod: "auto",
        });
        return {
          provider: capability.id,
          name: capability.name,
          installed: Boolean(server),
          configured: readiness.configured,
          connected: server ? this.isConnectorConnected(mcpClient, server.id) : false,
          ready:
            Boolean(server) &&
            readiness.configured &&
            (server ? this.isConnectorConnected(mcpClient, server.id) : false),
          auth_methods: capability.authMethods,
          links: capability.links,
        };
      });

      return {
        success: true,
        action,
        providers,
        message: "Tier-1 integration readiness summary generated.",
      };
    }

    const provider = this.resolveTier1Provider(requestedProvider);
    if (!provider) {
      throw new Error(
        `Unsupported provider: ${requestedProvider}. Supported providers: ${TIER1_CONNECTOR_IDS.join(", ")}`,
      );
    }

    const capability = getConnectorCapability(provider);
    if (!capability) {
      throw new Error(`Capability metadata missing for provider: ${provider}`);
    }

    const authMethod: "auto" | IntegrationAuthMethod =
      input?.auth_method === "oauth" || input?.auth_method === "api_key" ? input.auth_method : "auto";
    if (authMethod === "oauth" && !capability.authMethods.includes("oauth")) {
      return {
        success: false,
        action,
        provider,
        message: `${capability.name} does not support OAuth setup in chat.`,
        auth_methods: capability.authMethods,
      };
    }

    let settings = MCPSettingsManager.loadSettings();
    let server = this.findConnectorServer(settings, capability);
    const inboundBefore = this.getResendInboundState();

    const normalizedInputEnv = this.normalizeIntegrationEnvInput(input?.env);
    if (provider === "resend") {
      if (typeof input?.api_key === "string" && input.api_key.trim()) {
        normalizedInputEnv.RESEND_API_KEY = input.api_key.trim();
      }
      if (typeof input?.base_url === "string" && input.base_url.trim()) {
        normalizedInputEnv.RESEND_BASE_URL = input.base_url.trim();
      }
    }

    const envForInspect = this.buildMergedIntegrationEnv(server?.env, normalizedInputEnv, provider);
    const inspectReadiness = evaluateConnectorReadiness({
      capability,
      env: envForInspect,
      authMethod,
    });
    const missingInputs = this.buildIntegrationMissingInputs(capability, inspectReadiness.missingInputs);
    const connected = server ? this.isConnectorConnected(mcpClient, server.id) : false;
    const ready = Boolean(server) && inspectReadiness.configured && connected;
    const planHash = this.buildIntegrationPlanHash({
      provider,
      auth_method: authMethod,
      server_id: server?.id ?? null,
      installed: Boolean(server),
      connected,
      selected_auth_method: inspectReadiness.selectedAuthMethod,
      missing_inputs: missingInputs.map((entry) => entry.field),
      env_fingerprint: this.buildIntegrationEnvFingerprint(envForInspect, capability),
      inbound_state: provider === "resend" ? inboundBefore : undefined,
    });

    if (action === "inspect") {
      const response: Any = {
        success: true,
        action,
        provider,
        installed: Boolean(server),
        configured: inspectReadiness.configured,
        connected,
        ready,
        plan_hash: planHash,
        auth_method: inspectReadiness.selectedAuthMethod,
        auth_methods: capability.authMethods,
        missing_inputs: missingInputs,
        links: capability.links,
        server_id: server?.id,
        message: server
          ? inspectReadiness.configured
            ? `${capability.name} connector is installed and configured.`
            : `${capability.name} connector is installed but missing setup inputs.`
          : `${capability.name} connector is not installed yet.`,
      };

      if (provider === "resend") {
        response.email_sending_ready = ready;
        response.inbound = {
          requested: false,
          hooks_enabled: inboundBefore.hooks_enabled,
          preset_enabled: inboundBefore.preset_enabled,
          endpoint_path: inboundBefore.endpoint_path,
          token_configured: inboundBefore.token_configured,
          signing_secret_configured: inboundBefore.signing_secret_configured,
        };
        response.notes = [
          'Use action="configure" with api_key to enable email sending.',
          "Set enable_inbound=true to configure webhook ingestion.",
        ];
      }
      return response;
    }

    const expectedPlanHash = typeof input?.expected_plan_hash === "string" ? input.expected_plan_hash.trim() : "";
    if (expectedPlanHash && expectedPlanHash !== planHash) {
      return {
        success: false,
        action,
        provider,
        stale_plan: true,
        message:
          "Integration state changed since inspect. Re-run integration_setup with action=\"inspect\" and retry configure using the latest plan_hash.",
        expected_plan_hash: expectedPlanHash,
        current_plan_hash: planHash,
      };
    }

    const dryRun = input?.dry_run === true;
    const connectNow = input?.connect_now !== false;
    const enableInbound = provider === "resend" && input?.enable_inbound === true;
    const notes: string[] = [];
    let installedNow = false;
    let installError: string | undefined;

    if (!server && !dryRun) {
      try {
        await MCPRegistryManager.installServer(capability.registryEntryId);
        installedNow = true;
      } catch (error: Any) {
        const message = String(error?.message || error);
        if (!/already installed/i.test(message)) {
          installError = message;
        }
      }
      settings = MCPSettingsManager.loadSettings();
      server = this.findConnectorServer(settings, capability);
    }

    if (!server && !dryRun) {
      return {
        success: false,
        action,
        provider,
        installed: false,
        configured: false,
        connected: false,
        ready: false,
        missing_inputs: missingInputs,
        links: capability.links,
        message: `Could not install or locate the ${capability.name} connector.`,
        notes: installError ? [installError] : undefined,
      };
    }

    let envToApply = this.buildMergedIntegrationEnv(server?.env, normalizedInputEnv, provider);

    const oauthRequested = authMethod === "oauth" || Boolean(input?.oauth);
    if (oauthRequested) {
      if (!capability.oauthProvider) {
        return {
          success: false,
          action,
          provider,
          message: `${capability.name} does not expose OAuth setup in chat.`,
          auth_methods: capability.authMethods,
        };
      }

      if (dryRun) {
        notes.push("Dry run: OAuth flow skipped.");
      } else {
        const oauthOutcome = await this.applyConnectorOAuth({
          capability,
          provider,
          input,
          env: envToApply,
        });
        if (!oauthOutcome.success) {
          return {
            success: false,
            action,
            provider,
            installed: Boolean(server),
            configured: false,
            connected: false,
            ready: false,
            missing_inputs: missingInputs,
            links: capability.links,
            message: oauthOutcome.message,
            oauth_error: oauthOutcome.error,
          };
        }
        envToApply = oauthOutcome.env;
        notes.push(oauthOutcome.message);
      }
    }

    const readinessAfter = evaluateConnectorReadiness({
      capability,
      env: envToApply,
      authMethod,
    });
    const missingAfter = this.buildIntegrationMissingInputs(capability, readinessAfter.missingInputs);

    let updatedServer: MCPServerConfig | null = null;
    if (!dryRun && server) {
      updatedServer = MCPSettingsManager.updateServer(server.id, {
        env: envToApply,
        enabled: readinessAfter.configured,
      });
      if (!updatedServer) {
        throw new Error(`Failed to update connector settings for server ${server.id}`);
      }
    }

    let connectedAfter = server ? this.isConnectorConnected(mcpClient, server.id) : false;
    let connectionError: string | undefined;
    if (!dryRun && server && readinessAfter.configured && connectNow && !connectedAfter) {
      try {
        await mcpClient.connectServer(server.id);
        connectedAfter = true;
      } catch (error: Any) {
        connectionError = String(error?.message || error);
        connectedAfter = this.isConnectorConnected(mcpClient, server.id);
        if (connectedAfter) connectionError = undefined;
      }
    }

    let healthError: string | undefined;
    let healthText: string | undefined;
    if (!dryRun && server && connectedAfter && capability.healthTool) {
      try {
        const health = await mcpClient.callTool(capability.healthTool, {});
        healthText = this.extractMcpTextContent(health) || undefined;
        if (health?.isError) {
          healthError = healthText || "Connector health call returned an error";
        }
      } catch (error: Any) {
        healthError = String(error?.message || error);
      }
    }

    const inboundAfter = enableInbound
      ? this.configureResendInbound({
          webhookSecret:
            typeof input?.webhook_secret === "string" ? input.webhook_secret.trim() : undefined,
          allowUnsafeExternalContent:
            typeof input?.allow_unsafe_external_content === "boolean"
              ? input.allow_unsafe_external_content
              : undefined,
        })
      : this.getResendInboundState();

    if (installedNow) notes.push(`Installed ${capability.name} connector.`);
    if (dryRun) notes.push("Dry run: no settings were persisted.");

    const effectiveConnected = dryRun ? connected : connectedAfter;
    const effectiveConfigured = readinessAfter.configured;
    const effectiveReady = effectiveConfigured && effectiveConnected && !healthError;
    const response: Any = {
      success: dryRun ? true : effectiveReady,
      action,
      provider,
      installed: Boolean(server),
      configured: effectiveConfigured,
      connected: effectiveConnected,
      ready: effectiveReady,
      auth_method: readinessAfter.selectedAuthMethod,
      auth_methods: capability.authMethods,
      missing_inputs: missingAfter,
      links: capability.links,
      server_id: server?.id,
      connection_error: connectionError,
      health_error: healthError,
      health_text: healthText,
      plan_hash: this.buildIntegrationPlanHash({
        provider,
        auth_method: authMethod,
        server_id: server?.id ?? null,
        installed: Boolean(server),
        connected: effectiveConnected,
        selected_auth_method: readinessAfter.selectedAuthMethod,
        missing_inputs: missingAfter.map((entry) => entry.field),
        env_fingerprint: this.buildIntegrationEnvFingerprint(envToApply, capability),
        inbound_state: provider === "resend" ? inboundAfter : undefined,
      }),
      message: dryRun
        ? `${capability.name} configuration dry run completed.`
        : effectiveReady
          ? `${capability.name} integration is configured and healthy.`
          : effectiveConfigured
            ? `${capability.name} is configured, but connection or health still needs attention.`
            : `${capability.name} setup is incomplete. Missing required credentials.`,
      notes: notes.length > 0 ? notes : undefined,
    };

    if (provider === "resend") {
      response.email_sending_ready = effectiveReady;
      response.inbound = {
        requested: enableInbound,
        hooks_enabled: inboundAfter.hooks_enabled,
        preset_enabled: inboundAfter.preset_enabled,
        endpoint_path: inboundAfter.endpoint_path,
        token_configured: inboundAfter.token_configured,
        signing_secret_configured: inboundAfter.signing_secret_configured,
      };
    }

    void updatedServer;
    return response;
  }

  private resolveTier1Provider(rawProvider: string): Tier1IntegrationProvider | null {
    const normalized = String(rawProvider || "").trim().toLowerCase();
    return TIER1_CONNECTOR_IDS.includes(normalized as Tier1IntegrationProvider)
      ? (normalized as Tier1IntegrationProvider)
      : null;
  }

  private findConnectorServer(
    settings: { servers: MCPServerConfig[] },
    capability: ConnectorCapability,
  ): MCPServerConfig | undefined {
    return settings.servers.find((server) => {
      const detected = detectConnectorCapabilityId(server);
      if (detected === capability.id) return true;

      const lowerName = (server.name || "").toLowerCase();
      if (lowerName === capability.id || lowerName.includes(capability.id)) return true;

      const args = (server.args || []).map((arg) => String(arg).toLowerCase());
      return args.some((arg) => arg.includes(`${capability.id}-mcp`));
    });
  }

  private isConnectorConnected(mcpClient: MCPClientManager, serverId: string): boolean {
    try {
      return mcpClient.getServerStatus(serverId)?.status === "connected";
    } catch {
      return false;
    }
  }

  private normalizeIntegrationEnvInput(inputEnv: Record<string, unknown> | undefined): Record<string, string> {
    const normalized: Record<string, string> = {};
    if (!inputEnv || typeof inputEnv !== "object") return normalized;
    for (const [key, value] of Object.entries(inputEnv)) {
      const trimmedKey = key.trim();
      if (!trimmedKey) continue;
      if (typeof value === "string") {
        const trimmedValue = value.trim();
        if (trimmedValue) normalized[trimmedKey] = trimmedValue;
      } else if (value !== null && value !== undefined) {
        normalized[trimmedKey] = String(value);
      }
    }
    return normalized;
  }

  private buildMergedIntegrationEnv(
    currentEnv: Record<string, string> | undefined,
    inputEnv: Record<string, string>,
    provider: Tier1IntegrationProvider,
  ): Record<string, string> {
    const merged: Record<string, string> = {
      ...(currentEnv || {}),
      ...inputEnv,
    };
    if (provider === "resend" && !merged.RESEND_BASE_URL?.trim()) {
      merged.RESEND_BASE_URL = "https://api.resend.com";
    }
    return merged;
  }

  private buildIntegrationMissingInputs(
    capability: ConnectorCapability,
    missingKeys: string[],
  ): Array<{
    field: string;
    label: string;
    prompt: string;
    create_url?: string;
    docs_url?: string;
  }> {
    const deduped = [...new Set(missingKeys)];
    return deduped.map((key) => {
      const hint = capability.inputHints?.[key] || this.buildDefaultInputHint(capability, key);
      const field = capability.id === "resend" && key === "RESEND_API_KEY" ? "api_key" : key;
      return {
        field,
        label: hint.label,
        prompt: hint.prompt,
        create_url: hint.create_url,
        docs_url: hint.docs_url,
      };
    });
  }

  private buildDefaultInputHint(capability: ConnectorCapability, key: string): IntegrationInputHint {
    const label = key.replace(/_/g, " ").toLowerCase();
    const title = label.charAt(0).toUpperCase() + label.slice(1);
    return {
      field: key,
      label: title,
      prompt: `Provide ${title} to complete ${capability.name} setup.`,
      create_url: capability.links.create_api_key,
      docs_url: capability.links.api_keys_docs || capability.links.oauth_docs,
    };
  }

  private buildIntegrationPlanHash(payload: Any): string {
    const canonical = this.stableStringify(payload);
    return createHash("sha256").update(canonical).digest("hex").slice(0, 24);
  }

  private stableStringify(value: Any): string {
    const normalize = (input: Any): Any => {
      if (Array.isArray(input)) {
        return input.map((item) => normalize(item));
      }
      if (input && typeof input === "object") {
        const sortedKeys = Object.keys(input).sort();
        const output: Record<string, Any> = {};
        for (const key of sortedKeys) {
          output[key] = normalize(input[key]);
        }
        return output;
      }
      return input;
    };
    return JSON.stringify(normalize(value));
  }

  private buildIntegrationEnvFingerprint(
    env: Record<string, string>,
    capability: ConnectorCapability,
  ): Record<string, string> {
    const relevantKeys = new Set<string>();
    for (const group of capability.readinessAny) {
      for (const key of group) relevantKeys.add(key);
    }
    if (capability.id === "resend") relevantKeys.add("RESEND_BASE_URL");
    const fingerprint: Record<string, string> = {};
    for (const key of [...relevantKeys].sort()) {
      const value = env[key];
      if (!value) {
        fingerprint[key] = "missing";
      } else {
        fingerprint[key] = createHash("sha256").update(value).digest("hex").slice(0, 12);
      }
    }
    return fingerprint;
  }

  private getOAuthClientEnvKeys(provider: Tier1IntegrationProvider): {
    clientIdKey?: string;
    clientSecretKey?: string;
  } {
    switch (provider) {
      case "jira":
        return { clientIdKey: "JIRA_CLIENT_ID", clientSecretKey: "JIRA_CLIENT_SECRET" };
      case "hubspot":
        return { clientIdKey: "HUBSPOT_CLIENT_ID", clientSecretKey: "HUBSPOT_CLIENT_SECRET" };
      case "google-workspace":
        return { clientIdKey: "GOOGLE_CLIENT_ID", clientSecretKey: "GOOGLE_CLIENT_SECRET" };
      default:
        return {};
    }
  }

  private async applyConnectorOAuth(params: {
    capability: ConnectorCapability;
    provider: Tier1IntegrationProvider;
    input: {
      oauth?: {
        client_id?: string;
        client_secret?: string;
        scopes?: string[];
        login_url?: string;
        subdomain?: string;
        team_domain?: string;
      };
    };
    env: Record<string, string>;
  }): Promise<
    | { success: true; env: Record<string, string>; message: string }
    | { success: false; error: string; message: string }
  > {
    const oauthProvider = params.capability.oauthProvider;
    if (!oauthProvider) {
      return {
        success: false,
        error: "OAuth provider not configured",
        message: `${params.capability.name} does not support OAuth setup in chat.`,
      };
    }

    const oauthInput = params.input.oauth || {};
    const clientEnvKeys = this.getOAuthClientEnvKeys(params.provider);
    const clientId =
      (oauthInput.client_id || "").trim() ||
      (clientEnvKeys.clientIdKey ? params.env[clientEnvKeys.clientIdKey]?.trim() : "") ||
      "";
    const clientSecret =
      (oauthInput.client_secret || "").trim() ||
      (clientEnvKeys.clientSecretKey ? params.env[clientEnvKeys.clientSecretKey]?.trim() : "") ||
      "";

    if (!clientId) {
      return {
        success: false,
        error: "Missing OAuth client_id",
        message: `Missing OAuth client_id for ${params.capability.name}. Provide oauth.client_id.`,
      };
    }

    const oauthRequest: ConnectorOAuthRequest = {
      provider: oauthProvider,
      clientId,
      clientSecret: clientSecret || undefined,
      scopes: Array.isArray(oauthInput.scopes)
        ? oauthInput.scopes.map((scope) => String(scope || "").trim()).filter(Boolean)
        : undefined,
      loginUrl: typeof oauthInput.login_url === "string" ? oauthInput.login_url.trim() : undefined,
      subdomain: typeof oauthInput.subdomain === "string" ? oauthInput.subdomain.trim() : undefined,
      teamDomain:
        typeof oauthInput.team_domain === "string" ? oauthInput.team_domain.trim() : undefined,
    };

    try {
      const oauthResult = await startConnectorOAuth(oauthRequest);
      const nextEnv: Record<string, string> = { ...params.env };

      if (clientEnvKeys.clientIdKey) nextEnv[clientEnvKeys.clientIdKey] = clientId;
      if (clientEnvKeys.clientSecretKey && clientSecret) nextEnv[clientEnvKeys.clientSecretKey] = clientSecret;

      switch (params.provider) {
        case "jira": {
          nextEnv.JIRA_ACCESS_TOKEN = oauthResult.accessToken;
          if (oauthResult.refreshToken) nextEnv.JIRA_REFRESH_TOKEN = oauthResult.refreshToken;
          if (!nextEnv.JIRA_BASE_URL && oauthResult.resources?.[0]?.url) {
            nextEnv.JIRA_BASE_URL = oauthResult.resources[0].url;
          }
          break;
        }
        case "hubspot": {
          nextEnv.HUBSPOT_ACCESS_TOKEN = oauthResult.accessToken;
          if (oauthResult.refreshToken) nextEnv.HUBSPOT_REFRESH_TOKEN = oauthResult.refreshToken;
          break;
        }
        case "google-workspace": {
          nextEnv.GOOGLE_ACCESS_TOKEN = oauthResult.accessToken;
          if (oauthResult.refreshToken) nextEnv.GOOGLE_REFRESH_TOKEN = oauthResult.refreshToken;
          break;
        }
        default: {
          break;
        }
      }

      return {
        success: true,
        env: nextEnv,
        message: `${params.capability.name} OAuth authorization completed.`,
      };
    } catch (error: Any) {
      return {
        success: false,
        error: String(error?.message || error),
        message: `OAuth setup failed for ${params.capability.name}.`,
      };
    }
  }

  private getResendInboundState(): {
    hooks_enabled: boolean;
    preset_enabled: boolean;
    endpoint_path: string;
    token_configured: boolean;
    signing_secret_configured: boolean;
  } {
    HooksSettingsManager.initialize();
    const hooks = HooksSettingsManager.loadSettings();
    return {
      hooks_enabled: hooks.enabled,
      preset_enabled: hooks.presets.includes("resend"),
      endpoint_path: `${hooks.path || "/hooks"}/resend`,
      token_configured: Boolean(hooks.token),
      signing_secret_configured: Boolean(hooks.resend?.webhookSecret),
    };
  }

  private configureResendInbound(input: {
    webhookSecret?: string;
    allowUnsafeExternalContent?: boolean;
  }): {
    hooks_enabled: boolean;
    preset_enabled: boolean;
    endpoint_path: string;
    token_configured: boolean;
    signing_secret_configured: boolean;
  } {
    HooksSettingsManager.initialize();
    let hooks = HooksSettingsManager.loadSettings();
    if (!hooks.enabled) {
      hooks = HooksSettingsManager.enableHooks();
    }

    const nextPresets = new Set(hooks.presets || []);
    nextPresets.add("resend");

    let nextWebhookSecret = hooks.resend?.webhookSecret;
    if (input.webhookSecret !== undefined) {
      nextWebhookSecret = input.webhookSecret || undefined;
    }

    hooks = HooksSettingsManager.updateConfig({
      ...hooks,
      presets: Array.from(nextPresets),
      resend: {
        ...hooks.resend,
        webhookSecret: nextWebhookSecret,
        allowUnsafeExternalContent:
          typeof input.allowUnsafeExternalContent === "boolean"
            ? input.allowUnsafeExternalContent
            : hooks.resend?.allowUnsafeExternalContent,
      },
    });

    return {
      hooks_enabled: hooks.enabled,
      preset_enabled: hooks.presets.includes("resend"),
      endpoint_path: `${hooks.path || "/hooks"}/resend`,
      token_configured: Boolean(hooks.token),
      signing_secret_configured: Boolean(hooks.resend?.webhookSecret),
    };
  }

  private extractMcpTextContent(result: Any): string {
    const content = Array.isArray(result?.content) ? result.content : [];
    const texts = content
      .filter((item: Any) => item && item.type === "text" && typeof item.text === "string")
      .map((item: Any) => item.text);
    return texts.join("\n").trim();
  }

  /**
   * Set the agent's personality (preset, adjust traits, or legacy personality id)
   */
  private setPersonality(input: {
    personality?: string;
    preset?: string;
    adjust?: Record<string, number>;
  }): {
    success: boolean;
    personality?: string;
    description: string;
    message: string;
  } {
    if (input.adjust && typeof input.adjust === "object") {
      PersonalityManager.adjustTraits(input.adjust);
      const parts = Object.entries(input.adjust).map(([k, v]) => `${k}: ${v}`);
      return {
        success: true,
        description: "Trait adjustments applied",
        message: `Adjusted personality traits: ${parts.join(", ")}. This will take effect in future responses.`,
      };
    }

    const presetOrId = (input.preset ?? input.personality) as string | undefined;
    const validIds: PersonalityId[] = [
      "professional",
      "friendly",
      "concise",
      "creative",
      "technical",
      "casual",
    ];

    if (!presetOrId || !validIds.includes(presetOrId as PersonalityId)) {
      throw new Error(
        `Invalid personality/preset: ${presetOrId}. Valid options are: ${validIds.join(", ")}`,
      );
    }

    const personalityId = presetOrId as PersonalityId;
    PersonalityManager.setActivePersonality(personalityId);

    const personality = PERSONALITY_DEFINITIONS.find((p) => p.id === personalityId);
    const description = personality?.description || "";
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
   * Add a behavioral rule (always/never/prefer/avoid)
   */
  private addBehavioralRule(input: { type: string; rule: string }): {
    success: boolean;
    message: string;
  } {
    const validTypes = ["always", "never", "prefer", "avoid"];
    const type = (input.type ?? "always").toLowerCase();
    if (!validTypes.includes(type)) {
      throw new Error(`Invalid rule type: ${type}. Valid: ${validTypes.join(", ")}`);
    }
    const rule = String(input.rule ?? "").trim();
    if (!rule) {
      throw new Error("Rule text cannot be empty");
    }
    PersonalityManager.addBehavioralRule({
      type: type as "always" | "never" | "prefer" | "avoid",
      rule,
    });
    return {
      success: true,
      message: `Added ${type.toUpperCase()} rule: "${rule}". This will shape future responses.`,
    };
  }

  /**
   * Set expertise for a domain
   */
  private setExpertise(input: { domain: string; level: string }): {
    success: boolean;
    message: string;
  } {
    const domain = String(input.domain ?? "").trim();
    if (!domain) {
      throw new Error("Domain cannot be empty");
    }
    const validLevels = ["familiar", "proficient", "expert"];
    const level = (input.level ?? "proficient").toLowerCase();
    if (!validLevels.includes(level)) {
      throw new Error(`Invalid level: ${level}. Valid: ${validLevels.join(", ")}`);
    }
    PersonalityManager.setExpertise(
      domain,
      level as "familiar" | "proficient" | "expert",
      undefined,
    );
    return {
      success: true,
      message: `Set expertise: ${domain} (${level}). The assistant will emphasize this in relevant responses.`,
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
      throw new Error("Name cannot be empty");
    }

    if (newName.length > 50) {
      throw new Error("Name is too long (max 50 characters)");
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
    const validIds: PersonaId[] = [
      "none",
      "jarvis",
      "friday",
      "hal",
      "computer",
      "alfred",
      "intern",
      "sensei",
      "pirate",
      "noir",
      "companion",
    ];

    if (!validIds.includes(personaId)) {
      throw new Error(`Invalid persona: ${personaId}. Valid options are: ${validIds.join(", ")}`);
    }

    // Save the new persona
    PersonalityManager.setActivePersona(personaId);

    // Get the persona definition for the response
    const persona = PERSONA_DEFINITIONS.find((p) => p.id === personaId);
    const description = persona?.description || "";
    const name = persona?.name || personaId;

    console.log(`[ToolRegistry] Persona changed to: ${personaId}`);

    let message = "";
    if (personaId === "none") {
      message = "Persona cleared. I'll respond without any character overlay.";
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
    const rawUserName = input.name?.trim();

    if (!rawUserName || rawUserName.length === 0) {
      throw new Error("Name cannot be empty");
    }

    if (rawUserName.length > 100) {
      throw new Error("Name is too long (max 100 characters)");
    }

    const userName = sanitizeStoredPreferredName(rawUserName);
    if (!userName) {
      throw new Error('Name looks invalid. Please provide just your preferred name (for example: "Alice").');
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
    const style: Any = {};

    // Validate and apply emoji usage
    if (input.emoji_usage) {
      const validEmoji = ["none", "minimal", "moderate", "expressive"];
      if (!validEmoji.includes(input.emoji_usage)) {
        throw new Error(
          `Invalid emoji_usage: ${input.emoji_usage}. Valid options: ${validEmoji.join(", ")}`,
        );
      }
      style.emojiUsage = input.emoji_usage;
      changes.push(`emoji usage: ${input.emoji_usage}`);
    }

    // Validate and apply response length
    if (input.response_length) {
      const validLength = ["terse", "balanced", "detailed"];
      if (!validLength.includes(input.response_length)) {
        throw new Error(
          `Invalid response_length: ${input.response_length}. Valid options: ${validLength.join(", ")}`,
        );
      }
      style.responseLength = input.response_length;
      changes.push(`response length: ${input.response_length}`);
    }

    // Validate and apply code comment style
    if (input.code_comments) {
      const validComments = ["minimal", "moderate", "verbose"];
      if (!validComments.includes(input.code_comments)) {
        throw new Error(
          `Invalid code_comments: ${input.code_comments}. Valid options: ${validComments.join(", ")}`,
        );
      }
      style.codeCommentStyle = input.code_comments;
      changes.push(`code comments: ${input.code_comments}`);
    }

    // Validate and apply explanation depth
    if (input.explanation_depth) {
      const validDepth = ["expert", "balanced", "teaching"];
      if (!validDepth.includes(input.explanation_depth)) {
        throw new Error(
          `Invalid explanation_depth: ${input.explanation_depth}. Valid options: ${validDepth.join(", ")}`,
        );
      }
      style.explanationDepth = input.explanation_depth;
      changes.push(`explanation depth: ${input.explanation_depth}`);
    }

    if (changes.length === 0) {
      throw new Error(
        "No valid style options provided. Use emoji_usage, response_length, code_comments, or explanation_depth.",
      );
    }

    PersonalityManager.setResponseStyle(style);
    console.log(`[ToolRegistry] Response style updated:`, changes);

    return {
      success: true,
      changes,
      message: `Response style updated: ${changes.join(", ")}. Changes will apply to future responses.`,
    };
  }

  /**
   * Sanitize user input to prevent prompt injection
   * Removes control characters and limits potentially harmful patterns
   */
  private sanitizeQuirkInput(input: string): string {
    if (!input) return "";

    // Remove control characters and null bytes
    let sanitized = input.replace(/[\x00-\x1F\x7F]/g, "");

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
      sanitized = sanitized.replace(pattern, "[filtered]");
    }

    return sanitized.trim();
  }

  /**
   * Set personality quirks
   */
  private setQuirks(input: { catchphrase?: string; sign_off?: string; analogy_domain?: string }): {
    success: boolean;
    changes: string[];
    message: string;
  } {
    const changes: string[] = [];
    const quirks: Any = {};

    // Maximum lengths for quirk fields
    const MAX_CATCHPHRASE_LENGTH = 100;
    const MAX_SIGNOFF_LENGTH = 150;

    // Apply catchphrase with validation
    if (input.catchphrase !== undefined) {
      if (input.catchphrase && input.catchphrase.length > MAX_CATCHPHRASE_LENGTH) {
        throw new Error(
          `Catchphrase too long (max ${MAX_CATCHPHRASE_LENGTH} characters, got ${input.catchphrase.length})`,
        );
      }
      const sanitized = this.sanitizeQuirkInput(input.catchphrase || "");
      quirks.catchphrase = sanitized;
      if (sanitized) {
        changes.push(`catchphrase: "${sanitized}"`);
      } else {
        changes.push("catchphrase cleared");
      }
    }

    // Apply sign-off with validation
    if (input.sign_off !== undefined) {
      if (input.sign_off && input.sign_off.length > MAX_SIGNOFF_LENGTH) {
        throw new Error(
          `Sign-off too long (max ${MAX_SIGNOFF_LENGTH} characters, got ${input.sign_off.length})`,
        );
      }
      const sanitized = this.sanitizeQuirkInput(input.sign_off || "");
      quirks.signOff = sanitized;
      if (sanitized) {
        changes.push(`sign-off: "${sanitized}"`);
      } else {
        changes.push("sign-off cleared");
      }
    }

    // Validate and apply analogy domain
    if (input.analogy_domain !== undefined) {
      const validDomains = [
        "none",
        "cooking",
        "sports",
        "space",
        "music",
        "nature",
        "gaming",
        "movies",
        "construction",
      ];
      if (!validDomains.includes(input.analogy_domain)) {
        throw new Error(
          `Invalid analogy_domain: ${input.analogy_domain}. Valid options: ${validDomains.join(", ")}`,
        );
      }
      quirks.analogyDomain = input.analogy_domain;
      if (input.analogy_domain === "none") {
        changes.push("analogy domain cleared");
      } else {
        changes.push(`analogy domain: ${input.analogy_domain}`);
      }
    }

    if (changes.length === 0) {
      throw new Error("No quirk options provided. Use catchphrase, sign_off, or analogy_domain.");
    }

    PersonalityManager.setQuirks(quirks);
    console.log(`[ToolRegistry] Quirks updated:`, changes);

    return {
      success: true,
      changes,
      message: `Personality quirks updated: ${changes.join(", ")}. Changes will apply to future responses.`,
    };
  }

  // ============ Vibes & Lore Methods ============

  /**
   * Update workspace vibes/energy mode
   */
  private setVibes(input: { mode: string; energy?: string; notes?: string }): {
    success: boolean;
    message: string;
  } {
    const validModes = [
      "crunch",
      "explore",
      "deep-focus",
      "maintenance",
      "playful",
      "low-energy",
      "default",
    ];
    if (!validModes.includes(input.mode)) {
      throw new Error(`Invalid mode: ${input.mode}. Valid options: ${validModes.join(", ")}`);
    }

    const energy = input.energy || "balanced";
    const validEnergies = ["high", "balanced", "low"];
    if (!validEnergies.includes(energy)) {
      throw new Error(`Invalid energy: ${energy}. Valid options: ${validEnergies.join(", ")}`);
    }

    const notes = String(input.notes || "")
      .trim()
      .slice(0, 120);

    const workspacePath = this.workspace?.path;
    if (!workspacePath) {
      throw new Error("No workspace path available");
    }

    const kitDir = path.join(workspacePath, ".cowork");
    if (!fs.existsSync(kitDir) || !fs.statSync(kitDir).isDirectory()) {
      throw new Error("No .cowork/ directory found in workspace. Run the Memory Kit skill first.");
    }

    const vibesPath = path.join(kitDir, "VIBES.md");
    const AUTO_VIBES_START = "<!-- cowork:auto:vibes:start -->";
    const AUTO_VIBES_END = "<!-- cowork:auto:vibes:end -->";

    let current = "";
    if (fs.existsSync(vibesPath)) {
      try {
        current = fs.readFileSync(vibesPath, "utf8");
      } catch {
        current = "";
      }
    }

    if (!current) {
      current = [
        "# Vibes",
        "",
        "Current energy and mode for this workspace. Updated by the agent based on cues.",
        "",
        "## Current",
        AUTO_VIBES_START,
        "- Mode: default",
        "- Energy: balanced",
        "- Notes: Ready to work",
        AUTO_VIBES_END,
        "",
        "## User Preferences",
        "- ",
        "",
      ].join("\n");
    }

    const bodyLines = [
      `- Mode: ${input.mode}`,
      `- Energy: ${energy}`,
      `- Notes: ${notes || "(none)"}`,
    ];
    const body = bodyLines.join("\n").trimEnd();
    const replacement = `${AUTO_VIBES_START}\n${body}\n${AUTO_VIBES_END}`;

    const startIdx = current.indexOf(AUTO_VIBES_START);
    const endIdx = current.indexOf(AUTO_VIBES_END);

    let next: string;
    if (startIdx >= 0 && endIdx > startIdx) {
      const before = current.slice(0, startIdx).trimEnd();
      const after = current.slice(endIdx + AUTO_VIBES_END.length).trimStart();
      next = `${before}\n${replacement}\n\n${after}`.trimEnd() + "\n";
    } else {
      const heading = "## Current";
      const headingIdx = current.indexOf(heading);
      if (headingIdx >= 0) {
        const insertAt = headingIdx + heading.length;
        const before = current.slice(0, insertAt).trimEnd();
        const after = current.slice(insertAt).trimStart();
        next = `${before}\n\n${replacement}\n\n${after}`.trimEnd() + "\n";
      } else {
        next = `${current.trimEnd()}\n\n${heading}\n\n${replacement}\n`.trimEnd() + "\n";
      }
    }

    writeKitFileWithSnapshot(vibesPath, next, "agent", "tool:set_vibes");

    console.log(`[ToolRegistry] Vibes updated: mode=${input.mode} energy=${energy}`);

    return {
      success: true,
      message: `Vibes updated to ${input.mode} (energy: ${energy}). This will influence how I approach tasks in this workspace.`,
    };
  }

  /**
   * Record a notable moment in workspace lore
   */
  private updateLore(input: { entry: string; section?: string }): {
    success: boolean;
    message: string;
  } {
    const entry = String(input.entry || "").trim();
    if (!entry) {
      throw new Error("Entry text is required");
    }
    if (entry.length > 200) {
      throw new Error(`Entry too long (max 200 characters, got ${entry.length})`);
    }

    const section = input.section || "milestones";
    const validSections = ["milestones", "references", "notes"];
    if (!validSections.includes(section)) {
      throw new Error(`Invalid section: ${section}. Valid options: ${validSections.join(", ")}`);
    }

    const workspacePath = this.workspace?.path;
    if (!workspacePath) {
      throw new Error("No workspace path available");
    }

    const kitDir = path.join(workspacePath, ".cowork");
    if (!fs.existsSync(kitDir) || !fs.statSync(kitDir).isDirectory()) {
      throw new Error("No .cowork/ directory found in workspace. Run the Memory Kit skill first.");
    }

    const lorePath = path.join(kitDir, "LORE.md");
    const AUTO_LORE_START = "<!-- cowork:auto:lore:start -->";
    const AUTO_LORE_END = "<!-- cowork:auto:lore:end -->";

    let current = "";
    if (fs.existsSync(lorePath)) {
      try {
        current = fs.readFileSync(lorePath, "utf8");
      } catch {
        current = "";
      }
    }

    if (!current) {
      current = [
        "# Shared Lore",
        "",
        "This file is workspace-local and can be auto-updated by the system.",
        "It captures the shared history between you and the agent in this workspace.",
        "",
        "## Milestones",
        AUTO_LORE_START,
        "- (none)",
        AUTO_LORE_END,
        "",
        "## Inside References",
        "- ",
        "",
        "## Notes",
        "- ",
        "",
      ].join("\n");
    }

    // Sanitize the entry text
    const sanitized = entry
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const now = new Date();
    const dateStamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    if (section === "milestones") {
      // Append within auto markers
      const startIdx = current.indexOf(AUTO_LORE_START);
      const endIdx = current.indexOf(AUTO_LORE_END);

      if (startIdx >= 0 && endIdx > startIdx) {
        const inner = current.slice(startIdx + AUTO_LORE_START.length, endIdx);
        const existingLines = inner
          .split("\n")
          .map((l) => l.trimEnd())
          .filter((l) => /^\s*-\s+\S/.test(l) && l.trim() !== "- (none)");
        existingLines.push(`- [${dateStamp}] ${sanitized}`);
        const capped = existingLines.slice(-40);
        const body = capped.join("\n").trimEnd();
        const replacement = `${AUTO_LORE_START}\n${body}\n${AUTO_LORE_END}`;

        const before = current.slice(0, startIdx).trimEnd();
        const after = current.slice(endIdx + AUTO_LORE_END.length).trimStart();
        current = `${before}\n${replacement}\n\n${after}`.trimEnd() + "\n";
      } else {
        // No markers — append under Milestones heading
        const heading = "## Milestones";
        const headingIdx = current.indexOf(heading);
        if (headingIdx >= 0) {
          const afterHeading = headingIdx + heading.length;
          const before = current.slice(0, afterHeading);
          const after = current.slice(afterHeading);
          current = `${before}\n- [${dateStamp}] ${sanitized}${after}`;
        } else {
          current += `\n## Milestones\n- [${dateStamp}] ${sanitized}\n`;
        }
      }
    } else {
      // For "references" or "notes", append under the matching heading
      const headingMap: Record<string, string> = {
        references: "## Inside References",
        notes: "## Notes",
      };
      const heading = headingMap[section];
      const headingIdx = current.indexOf(heading);
      if (headingIdx >= 0) {
        const afterHeading = headingIdx + heading.length;
        const before = current.slice(0, afterHeading);
        const after = current.slice(afterHeading);
        current = `${before}\n- ${sanitized}${after}`;
      } else {
        current += `\n${heading}\n- ${sanitized}\n`;
      }
    }

    writeKitFileWithSnapshot(lorePath, current, "agent", "tool:update_lore");

    console.log(`[ToolRegistry] Lore updated (${section}): ${sanitized.slice(0, 60)}`);

    return {
      success: true,
      message: `Lore recorded in ${section}: "${sanitized}"`,
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
    | {
        ok: false;
        taskId?: string;
        error: "TASK_ID_REQUIRED" | "TASK_NOT_FOUND" | "FORBIDDEN";
        message: string;
      }
  > {
    const taskId = typeof taskIdInput === "string" ? taskIdInput.trim() : "";
    if (!taskId) {
      return { ok: false, error: "TASK_ID_REQUIRED", message: "task_id is required" };
    }
    if (taskId === this.taskId) {
      return {
        ok: false,
        taskId,
        error: "FORBIDDEN",
        message: "task_id must refer to a child task (not the current task)",
      };
    }

    const task = await this.daemon.getTaskById(taskId);
    if (!task) {
      return { ok: false, taskId, error: "TASK_NOT_FOUND", message: `Task ${taskId} not found` };
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

    return {
      ok: false,
      taskId,
      error: "FORBIDDEN",
      message: `Task ${taskId} is not a child of the current task`,
    };
  }

  /**
   * Parse a document file (PDF, DOCX, XLSX, PPTX, CSV, JSON, Markdown).
   */
  private async parseDocument(input: {
    path: string;
    format?: "text" | "structured";
    max_chars?: number;
  }) {
    const parser = new DocumentParserTools(this.workspace, this.daemon, this.taskId);
    try {
      return await parser.parseDocument(input);
    } catch (err) {
      return {
        content: "",
        format: input.format ?? "text",
        detected_type: "unknown",
        truncated: false,
        char_count: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Execute code in a sandboxed process.
   */
  private async executeCode(input: {
    language: "python" | "javascript" | "shell";
    code: string;
    timeout_seconds?: number;
    allow_network?: boolean;
  }) {
    if (!this._codeExecTools) {
      this._codeExecTools = new CodeExecTools(this.workspace);
    }
    try {
      return await this._codeExecTools.executeCode(input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        stdout: "",
        stderr: message,
        exit_code: 1,
        timed_out: false,
        output_truncated: false,
        language: input.language,
      };
    }
  }

  /**
   * Get the persisted status of a DAG orchestration run associated with the current task.
   */
  private async getOrchestrationStatus(input: { run_id?: string }): Promise<{
    success: boolean;
    run?: {
      run_id: string;
      root_task_id: string;
      workspace_id: string;
      status: string;
      created_at: number;
      completed_at?: number;
      summary: {
        total: number;
        pending: number;
        spawned: number;
        running: number;
        completed: number;
        failed: number;
      };
      tasks: Array<{
        id: string;
        title: string;
        status: string;
        depends_on: string[];
        task_id?: string;
        output?: string;
        error?: string;
        capability_hint?: string;
        started_at?: number;
        completed_at?: number;
      }>;
    };
    message: string;
  }> {
    const requestedRunId = typeof input?.run_id === "string" ? input.run_id.trim() : "";
    const snapshot = requestedRunId
      ? this.daemon.getOrchestrationGraphSnapshot(requestedRunId)
      : this.daemon.findLatestOrchestrationGraphByRootTask(this.taskId);

    if (!snapshot || snapshot.run.rootTaskId !== this.taskId) {
      return {
        success: false,
        message: requestedRunId
          ? `No orchestration run found for run_id ${requestedRunId} under the current task.`
          : "No orchestration run found for the current task.",
      };
    }

    const summary = snapshot.nodes.reduce(
      (acc, task) => {
        acc.total += 1;
        if (task.status === "pending") acc.pending += 1;
        else if (task.status === "running" || task.status === "ready") acc.running += 1;
        else if (task.status === "completed") acc.completed += 1;
        else acc.failed += 1;
        return acc;
      },
      { total: 0, pending: 0, spawned: 0, running: 0, completed: 0, failed: 0 },
    );

    return {
      success: true,
      run: {
        run_id: snapshot.run.id,
        root_task_id: snapshot.run.rootTaskId,
        workspace_id: snapshot.run.workspaceId,
        status: snapshot.run.status,
        created_at: snapshot.run.createdAt,
        completed_at: snapshot.run.completedAt,
        summary,
        tasks: snapshot.nodes.map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          depends_on: snapshot.edges
            .filter((edge) => edge.toNodeId === task.id)
            .map((edge) => edge.fromNodeId),
          task_id: task.taskId,
          output: task.output || task.summary,
          error: task.error,
          capability_hint: task.capabilityHint,
          started_at: task.startedAt,
          completed_at: task.completedAt,
        })),
      },
      message:
        `Loaded orchestration run ${snapshot.run.id} ` +
        `(${summary.completed}/${summary.total} completed).`,
    };
  }

  /**
   * Spawn a child agent to work on a subtask
   */
  private async acpDiscover(input: {
    capability?: string;
    query?: string;
    origin?: "local" | "remote";
    status?: "available" | "busy" | "offline";
  }): Promise<{
    success: boolean;
    agents: Array<{
      id: string;
      name: string;
      origin: "local" | "remote";
      status: string;
      endpoint?: string;
      capabilities: string[];
    }>;
    message: string;
  }> {
    const registry = getACPRegistry();
    const agents = registry.discover(
      {
        capability: input.capability,
        query: input.query,
        origin: input.origin,
        status: input.status,
      },
      this.daemon.getActiveAgentRoles(),
    );
    return {
      success: true,
      agents: agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        origin: agent.origin,
        status: agent.status,
        endpoint: agent.endpoint,
        capabilities: agent.capabilities.map((capability) => capability.id),
      })),
      message: `Found ${agents.length} ACP agent${agents.length === 1 ? "" : "s"}`,
    };
  }

  private async waitForRemoteAgent(
    invoker: RemoteAgentInvoker,
    acpAgentId: string,
    remoteTaskId: string,
    timeoutSeconds: number,
  ): Promise<{
    success: boolean;
    status: string;
    message: string;
    resultSummary?: string;
    error?: string;
  }> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      const agent = getACPRegistry().getAgent(acpAgentId, this.daemon.getActiveAgentRoles());
      if (!agent || agent.origin !== "remote" || !agent.endpoint) {
        return {
          success: false,
          status: "not_found",
          message: `ACP agent ${acpAgentId} is unavailable`,
          error: "ACP_AGENT_UNAVAILABLE",
        };
      }
      try {
        const result = await invoker.pollStatus(agent, remoteTaskId);
        if (result.status === "completed") {
          return {
            success: true,
            status: "completed",
            message: "Remote ACP agent completed successfully",
            resultSummary: result.result,
          };
        }
        if (result.status === "failed" || result.status === "cancelled") {
          return {
            success: false,
            status: result.status,
            message: `Remote ACP agent ${result.status}`,
            error: result.error,
          };
        }
      } catch (error: Any) {
        return {
          success: false,
          status: "failed",
          message: `Remote ACP agent failed: ${error.message}`,
          error: error.message,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return {
      success: false,
      status: "timeout",
      message: `Timeout waiting for remote ACP agent (${timeoutSeconds}s)`,
      error: "TIMEOUT",
    };
  }

  private async getDelegationParentTask(): Promise<Task | null> {
    if (typeof this.daemon.getTaskById !== "function") return null;
    const task = await Promise.resolve(this.daemon.getTaskById(this.taskId));
    return task || null;
  }

  private async getDelegationCurrentStepContext(): Promise<string | undefined> {
    if (typeof this.daemon.getTaskEvents !== "function") return undefined;
    const events = (await Promise.resolve(this.daemon.getTaskEvents(this.taskId))) as TaskEvent[] | undefined;
    if (!Array.isArray(events) || events.length === 0) return undefined;

    for (const event of [...events].reverse()) {
      if (event.type !== "step_started") continue;
      const step = event.payload?.step;
      const description =
        typeof step?.description === "string"
          ? step.description.trim()
          : typeof event.payload?.stepDescription === "string"
            ? String(event.payload.stepDescription).trim()
            : "";
      if (description) return description;
    }
    return undefined;
  }

  private async getDelegationKnownFindings(): Promise<string | undefined> {
    if (typeof this.daemon.getTaskEvents !== "function") return undefined;
    const events = (await Promise.resolve(this.daemon.getTaskEvents(this.taskId))) as TaskEvent[] | undefined;
    if (!Array.isArray(events) || events.length === 0) return undefined;

    const findings: string[] = [];
    for (const event of [...events].reverse()) {
      if (findings.length >= 3) break;
      if (event.type === "assistant_message") {
        const message =
          typeof event.payload?.message === "string"
            ? event.payload.message.trim()
            : typeof event.payload?.content === "string"
              ? event.payload.content.trim()
              : "";
        if (message) {
          findings.push(`Assistant context: ${message.slice(0, 240)}`);
        }
        continue;
      }
      if (event.type === "tool_result") {
        const tool = typeof event.payload?.tool === "string" ? event.payload.tool.trim() : "";
        const result = event.payload?.result;
        const summary =
          typeof result === "string"
            ? result.trim()
            : result && typeof result === "object" && typeof result.message === "string"
              ? result.message.trim()
              : "";
        if (tool && summary) {
          findings.push(`${tool}: ${summary.slice(0, 180)}`);
        }
      }
    }

    return findings.length > 0 ? findings.join("\n") : undefined;
  }

  private buildStructuredDelegationBrief(params: {
    originalPrompt: string;
    workerRole: WorkerRoleKind;
    taskTitle: string;
    parentTaskTitle?: string;
    parentTaskPrompt?: string;
    currentStepContext?: string;
    knownFindings?: string;
    extractionMode: boolean;
  }): string {
    const spec = getWorkerRoleSpec(params.workerRole);
    const scopeOutByRole: Record<WorkerRoleKind, string> = {
      researcher: "Do not modify project files or expand into implementation work.",
      implementer: "Do not modify unrelated files or broaden the task beyond the assigned scope.",
      verifier: "Do not change project files; verify independently and report only evidence-backed findings.",
      synthesizer: "Do not reopen broad new research or unrelated implementation unless the supplied evidence is insufficient.",
    };
    const expectedDeliverableByRole: Record<WorkerRoleKind, string> = {
      researcher: "A concise findings report with concrete file paths, commands, risks, and unresolved questions.",
      implementer: "A completed implementation summary with exact changed files plus the verification commands or checks run.",
      verifier: "A verification report that starts with VERDICT: PASS, FAIL, or PARTIAL and then cites the supporting evidence.",
      synthesizer: "A consolidated artifact or summary that resolves predecessor outputs into one clear recommendation or deliverable.",
    };
    const evidenceRequirementsByRole: Record<WorkerRoleKind, string> = {
      researcher: "Cite the files, commands, search results, or observations that support each material finding.",
      implementer: "Report the concrete edits made and the tests, commands, or runtime checks that validate the change.",
      verifier: "Include the command/output/file evidence behind the verdict and at least one adversarial probe.",
      synthesizer: "Attribute the final synthesis to the upstream evidence or predecessor outputs that justify it.",
    };

    const lines = [
      "STRUCTURED DELEGATION BRIEF",
      "",
      "Objective:",
      params.originalPrompt.trim(),
      "",
      `Resolved worker role: ${spec.displayName} (${params.workerRole})`,
      "",
      "Parent task and current-step context:",
      `- Parent task: ${params.parentTaskTitle || this.taskId}`,
      params.parentTaskPrompt
        ? `- Parent prompt: ${params.parentTaskPrompt.trim().slice(0, 320)}`
        : "- Parent prompt: unavailable",
      params.currentStepContext
        ? `- Current step: ${params.currentStepContext}`
        : "- Current step: unavailable",
      "",
      "Scope in:",
      `- ${params.originalPrompt.trim()}`,
      "",
      "Scope out:",
      `- ${scopeOutByRole[params.workerRole]}`,
      ...(params.extractionMode
        ? ["- Preserve the extraction-only contract; do not drift into unrelated edits or open-ended exploration."]
        : []),
      "",
      "Known findings or evidence:",
      params.knownFindings
        ? params.knownFindings
            .split("\n")
            .filter(Boolean)
            .map((line) => `- ${line}`)
            .join("\n")
        : "- None captured yet; gather evidence before concluding.",
      "",
      "Expected deliverable:",
      `- ${expectedDeliverableByRole[params.workerRole]}`,
      "",
      "Evidence requirements:",
      `- ${evidenceRequirementsByRole[params.workerRole]}`,
      "",
      "Completion contract:",
      `- ${spec.completionContract}`,
    ];

    return lines.join("\n");
  }

  private async prepareSpawnAgentNode(input: {
    prompt: string;
    title?: string;
    model_preference?: string;
    capability_hint?: string;
    acp_agent_id?: string;
    personality?: string;
    worker_role?: string;
    runtime?: SpawnAgentRuntimeMode;
    runtime_agent?: SpawnAgentRuntimeAgent;
    max_turns?: number;
  }): Promise<{
    taskTitle: string;
    contractedPrompt: string;
    agentConfig: AgentConfig;
    dispatchTarget: "native_child_task" | "local_role" | "remote_acp" | "external_runtime";
    assignedAgentRoleId?: string;
    acpAgentId?: string;
    workerRole: WorkerRoleKind;
    extractionMode: boolean;
    externalRuntime?: AgentConfig["externalRuntime"];
  }> {
    const {
      prompt,
      title,
      model_preference,
      capability_hint,
      acp_agent_id,
      personality,
      worker_role,
      runtime,
      runtime_agent,
      max_turns = 20,
    } = input;

    const normalizedMaxTurns =
      typeof max_turns === "number" && Number.isFinite(max_turns) ? Math.round(max_turns) : 20;

    const phaseCEnabled = parseBooleanEnv("COWORK_GUARDRAIL_PHASE_C", true);
    const modelPref =
      typeof model_preference === "string" ? model_preference.trim().toLowerCase() : "";
    const personalityPref = typeof personality === "string" ? personality.trim().toLowerCase() : "";
    const capabilityRouted =
      !model_preference && capability_hint
        ? ModelCapabilityRegistry.selectForTask(String(capability_hint))
        : undefined;
    const modelKey =
      modelPref === "same"
        ? undefined
        : (resolveModelPreferenceToModelKey(model_preference ?? capabilityRouted) ?? "haiku-4-5");
    const personalityId: PersonalityId | undefined =
      personalityPref === "same"
        ? undefined
        : (resolvePersonalityPreference(personality) ?? "concise");
    const extractionMode = phaseCEnabled && isExtractionLikePrompt(prompt);
    const workerRole = resolveDelegationWorkerRole({
      requestedRole: worker_role,
      prompt,
    });

    const agentConfig: AgentConfig = {
      maxTurns: normalizedMaxTurns,
      retainMemory: false,
    };
    const externalRuntime = resolveSpawnAgentExternalRuntime({
      runtime,
      runtime_agent,
      title,
      prompt,
      autonomousMode: agentConfig.autonomousMode === true,
      defaultCodexRuntimeMode: BuiltinToolsSettingsManager.getCodexRuntimeMode(),
    });
    if (externalRuntime) {
      agentConfig.externalRuntime = externalRuntime;
    }

    if (phaseCEnabled) {
      const scopedRestrictions = new Set<string>(SUB_AGENT_DEFAULT_DENIED_TOOLS);
      agentConfig.toolRestrictions = Array.from(scopedRestrictions);
    }

    if (extractionMode) {
      agentConfig.allowedTools = [...EXTRACTION_SUB_AGENT_ALLOWED_TOOLS];
    }

    if (modelKey) agentConfig.modelKey = modelKey;
    if (personalityId) agentConfig.personalityId = personalityId;

    const taskTitle =
      title || `Sub-task: ${prompt.substring(0, 50)}${prompt.length > 50 ? "..." : ""}`;
    const parentTask = await this.getDelegationParentTask();
    const currentStepContext = await this.getDelegationCurrentStepContext();
    const knownFindings = await this.getDelegationKnownFindings();
    const delegatedPromptBody = extractionMode ? applyExtractionOutputContract(prompt) : prompt;
    const structuredBrief = this.buildStructuredDelegationBrief({
      originalPrompt: prompt,
      workerRole,
      taskTitle,
      parentTaskTitle: parentTask?.title,
      parentTaskPrompt: parentTask?.prompt,
      currentStepContext,
      knownFindings,
      extractionMode,
    });
    const contractedPrompt = `${structuredBrief}\n\nDelegated request:\n${delegatedPromptBody}`;

    let dispatchTarget: "native_child_task" | "local_role" | "remote_acp" | "external_runtime" =
      externalRuntime ? "external_runtime" : "native_child_task";
    let assignedAgentRoleId: string | undefined;
    const acpAgentId =
      typeof acp_agent_id === "string" && acp_agent_id.trim().length > 0
        ? acp_agent_id.trim()
        : undefined;
    if (acpAgentId) {
      const agent = getACPRegistry().getAgent(acpAgentId, this.daemon.getActiveAgentRoles());
      if (!agent) {
        throw new Error(`ACP agent ${acpAgentId} not found`);
      }
      if (agent.origin === "remote" && agent.endpoint) {
        dispatchTarget = "remote_acp";
      } else if (agent.origin === "local" && agent.localRoleId) {
        dispatchTarget = "local_role";
        assignedAgentRoleId = agent.localRoleId;
      } else {
        throw new Error(`ACP agent ${acpAgentId} is not invokable`);
      }
    }

    return {
      taskTitle,
      contractedPrompt,
      agentConfig,
      dispatchTarget,
      assignedAgentRoleId,
      acpAgentId,
      workerRole,
      extractionMode,
      externalRuntime,
    };
  }

  private async spawnAgent(input: {
    prompt: string;
    title?: string;
    model_preference?: string;
    capability_hint?: string;
    acp_agent_id?: string;
    personality?: string;
    worker_role?: string;
    runtime?: SpawnAgentRuntimeMode;
    runtime_agent?: SpawnAgentRuntimeAgent;
    wait?: boolean;
    max_turns?: number;
  }): Promise<{
    success: boolean;
    task_id?: string;
    title?: string;
    message: string;
    result?: Any;
    error?: string;
  }> {
    const {
      prompt,
      model_preference,
      personality,
      runtime,
      runtime_agent,
      wait = false,
      max_turns = 20,
    } = input;

    // Validate prompt
    if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
      throw new Error("spawn_agent requires a non-empty prompt");
    }

    const normalizedMaxTurns =
      typeof max_turns === "number" && Number.isFinite(max_turns) ? Math.round(max_turns) : 20;
    const maxTurnsCap = this._deepWorkMode ? 250 : 100;
    if (normalizedMaxTurns < 1 || normalizedMaxTurns > maxTurnsCap) {
      throw new Error(`max_turns must be between 1 and ${maxTurnsCap}`);
    }

    const phaseCEnabled = parseBooleanEnv("COWORK_GUARDRAIL_PHASE_C", true);

    const activeSubAgentLimit = parseBoundedIntEnv(
      "COWORK_SUBAGENT_MAX_ACTIVE_PER_PARENT",
      DEFAULT_ACTIVE_SUB_AGENT_LIMIT,
      1,
      20,
    );
    const childTasks = await this.daemon.getChildTasks(this.taskId);
    const activeChildTasks = childTasks.filter((task) =>
      ACTIVE_CHILD_AGENT_STATUSES.has(task.status),
    );
    if (phaseCEnabled && activeChildTasks.length >= activeSubAgentLimit) {
      const activeIds = activeChildTasks.slice(0, 5).map((task) => task.id);
      this.daemon.logEvent(this.taskId, "agent_spawn_blocked", {
        reason: "fanout_limit_reached",
        activeChildCount: activeChildTasks.length,
        activeSubAgentLimit,
        activeChildIds: activeIds,
      });
      return {
        success: false,
        message:
          `Cannot spawn agent: active child-agent limit reached (${activeChildTasks.length}/${activeSubAgentLimit}). ` +
          `Wait for existing child agents to finish before spawning more.`,
        error: "FANOUT_LIMIT_REACHED",
      };
    }

    // Check depth limit to prevent runaway spawning
    const currentDepth = await this.getCurrentTaskDepth();
    const maxDepth = 3;
    if (currentDepth >= maxDepth) {
      return {
        success: false,
        message: `Cannot spawn agent: maximum nesting depth (${maxDepth}) reached. Consider breaking the task into smaller parts or completing this task first.`,
        error: "MAX_DEPTH_REACHED",
      };
    }

    let prepared: Awaited<ReturnType<ToolRegistry["prepareSpawnAgentNode"]>>;
    try {
      prepared = await this.prepareSpawnAgentNode({
        prompt,
        title: input.title,
        model_preference,
        capability_hint: input.capability_hint,
        acp_agent_id: input.acp_agent_id,
        personality,
        worker_role: input.worker_role,
        runtime,
        runtime_agent,
        max_turns,
      });
    } catch (error: Any) {
      const message = error?.message || String(error);
      return {
        success: false,
        message,
        error:
          /not found/i.test(message) && typeof input.acp_agent_id === "string"
            ? "ACP_AGENT_NOT_FOUND"
            : message,
      };
    }

    // Log spawn attempt
    this.daemon.logEvent(this.taskId, "agent_spawned", {
      childTaskTitle: prepared.taskTitle,
      modelPreference: model_preference,
      personality: personality,
      runtime: runtime || (prepared.externalRuntime ? "acpx" : "native"),
      runtimeAgent: prepared.externalRuntime?.agent,
      workerRole: prepared.workerRole,
      maxTurns: normalizedMaxTurns,
      parentDepth: currentDepth,
      extractionMode: prepared.extractionMode,
      fanout: {
        activeBeforeSpawn: activeChildTasks.length,
        activeLimit: activeSubAgentLimit,
        phaseCEnabled,
      },
      allowedToolsCount: Array.isArray(prepared.agentConfig.allowedTools)
        ? prepared.agentConfig.allowedTools.length
        : 0,
    });

    try {
      let handle: string;
      if (typeof this.daemon.createOrchestrationGraphRun === "function") {
        const snapshot = await this.daemon.createOrchestrationGraphRun({
          rootTaskId: this.taskId,
          workspaceId: this.workspace.id,
          kind: "delegation",
          maxParallel: 1,
          metadata: { createdBy: "spawn_agent" },
          nodes: [
            {
              key: "spawn-1",
              title: prepared.taskTitle,
              prompt: prepared.contractedPrompt,
              kind: "child_task",
              dispatchTarget: prepared.dispatchTarget,
              parentTaskId: this.taskId,
              assignedAgentRoleId: prepared.assignedAgentRoleId,
              acpAgentId: prepared.acpAgentId,
              workerRole: prepared.workerRole,
              agentConfig: prepared.agentConfig,
              metadata: { depth: currentDepth + 1 },
            },
          ],
        });
        const node = snapshot.nodes[0];
        if (!node.publicHandle && node.status !== "completed") {
          return {
            success: false,
            title: prepared.taskTitle,
            message: node.error || "Failed to dispatch delegated agent",
            error: node.error || "DISPATCH_FAILED",
          };
        }
        handle = node.publicHandle || node.taskId || node.remoteTaskId || node.id;
      } else {
        if (prepared.dispatchTarget === "remote_acp") {
          return {
            success: false,
            title: prepared.taskTitle,
            message: "Remote ACP delegation requires orchestration graph support",
            error: "GRAPH_ENGINE_REQUIRED",
          };
        }
        const childTask = await this.daemon.createChildTask({
          title: prepared.taskTitle,
          prompt: prepared.contractedPrompt,
          workspaceId: this.workspace.id,
          parentTaskId: this.taskId,
          agentType: "sub",
          agentConfig: prepared.agentConfig,
          depth: currentDepth + 1,
          assignedAgentRoleId: prepared.assignedAgentRoleId,
          workerRole: prepared.workerRole,
        });
        handle = childTask.id;
      }

      // If wait=true, wait for completion
      if (wait) {
        const result = await this.waitForAgentInternal(handle, 300);
        return {
          success: result.success,
          task_id: handle,
          title: prepared.taskTitle,
          message: result.message,
          result: result.resultSummary,
          error: result.error,
        };
      }

      return {
        success: true,
        task_id: handle,
        title: prepared.taskTitle,
        message: `Sub-agent spawned successfully. Task ID: ${handle}. Use wait_for_agent or get_agent_status to check progress.`,
      };
    } catch (error: Any) {
      console.error(`[ToolRegistry] Failed to spawn agent:`, error);
      this.daemon.logEvent(this.taskId, "error", {
        tool: "spawn_agent",
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
  private async waitForAgentInternal(
    taskId: string,
    timeoutSeconds: number,
  ): Promise<{
    success: boolean;
    status: string;
    message: string;
    resultSummary?: string;
    error?: string;
  }> {
    const delegatedNode =
      typeof this.daemon.findDelegatedNode === "function"
        ? this.daemon.findDelegatedNode(this.taskId, taskId)
        : undefined;
    if (delegatedNode) {
      const result = await this.daemon.waitForDelegatedNode(this.taskId, taskId, timeoutSeconds);
      if (result.node) {
        this.daemon.logEvent(
          this.taskId,
          result.success ? "agent_completed" : "agent_failed",
          {
            childTaskId: result.node.taskId || result.node.remoteTaskId || taskId,
            childStatus: result.status,
            resultSummary: result.resultSummary,
            error: result.error,
          },
        );
      }
      return result;
    }

    const resolved = await this.resolveDescendantTask(taskId);
    if (!resolved.ok) {
      return {
        success: false,
        status: resolved.error === "TASK_NOT_FOUND" ? "not_found" : "forbidden",
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
          status: "not_found",
          message: `Task ${resolvedTaskId} not found`,
          error: "TASK_NOT_FOUND",
        };
      }

      // Check if task is complete
      if (["completed", "failed", "cancelled"].includes(task.status)) {
        const isSuccess = task.status === "completed";

        // Log result event to parent
        this.daemon.logEvent(this.taskId, isSuccess ? "agent_completed" : "agent_failed", {
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
            : `Agent ${task.status}: ${task.error || "Unknown error"}`,
          resultSummary: task.resultSummary,
          error: typeof task.error === "string" ? task.error : undefined,
        };
      }

      // Wait before polling again
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    // Timeout reached
    return {
      success: false,
      status: "timeout",
      message: `Timeout waiting for agent ${resolvedTaskId} (${timeoutSeconds}s)`,
      error: "TIMEOUT",
    };
  }

  /**
   * Wait for a spawned agent to complete
   */
  private async waitForAgent(input: { task_id: string; timeout_seconds?: number }): Promise<{
    success: boolean;
    status: string;
    task_id: string;
    message: string;
    result_summary?: string;
    error?: string;
  }> {
    const { task_id, timeout_seconds = 300 } = input;

    if (!task_id) {
      throw new Error("wait_for_agent requires a task_id");
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
   * Orchestrate multiple agents in parallel: spawn all, wait for all, return combined results.
   */
  private async orchestrateAgents(input: {
    tasks: Array<{
      prompt: string;
      title?: string;
      model_preference?: string;
      capability_hint?: string;
      acp_agent_id?: string;
      worker_role?: string;
    }>;
    timeout_seconds?: number;
  }): Promise<{
    success: boolean;
    results: Array<{
      task_id: string;
      title: string;
      status: string;
      result_summary?: string;
      error?: string;
    }>;
    completed: number;
    failed: number;
    message: string;
  }> {
    const { tasks, timeout_seconds = 300 } = input;

    if (!Array.isArray(tasks) || tasks.length < 2) {
      throw new Error("orchestrate_agents requires at least 2 tasks");
    }
    if (tasks.length > 8) {
      throw new Error("orchestrate_agents supports at most 8 tasks");
    }

    const phaseCEnabled = parseBooleanEnv("COWORK_GUARDRAIL_PHASE_C", true);
    const activeSubAgentLimit = parseBoundedIntEnv(
      "COWORK_SUBAGENT_MAX_ACTIVE_PER_PARENT",
      DEFAULT_ACTIVE_SUB_AGENT_LIMIT,
      1,
      20,
    );
    const activeChildTasks = (await this.daemon.getChildTasks(this.taskId)).filter((task) =>
      ACTIVE_CHILD_AGENT_STATUSES.has(task.status),
    );
    if (phaseCEnabled && activeChildTasks.length + tasks.length > activeSubAgentLimit) {
      return {
        success: false,
        results: [],
        completed: 0,
        failed: 0,
        message:
          `Cannot orchestrate agents: active child-agent limit would be exceeded ` +
          `(${activeChildTasks.length + tasks.length}/${activeSubAgentLimit}).`,
      };
    }

    const currentDepth = await this.getCurrentTaskDepth();
    if (currentDepth >= 3) {
      return {
        success: false,
        results: [],
        completed: 0,
        failed: 0,
        message: "Cannot orchestrate agents: maximum nesting depth (3) reached.",
      };
    }

    const preparedNodes = await Promise.all(tasks.map(async (task, index) => {
      const prepared = await this.prepareSpawnAgentNode({
        prompt: task.prompt,
        title: task.title,
        model_preference: task.model_preference,
        capability_hint: task.capability_hint,
        acp_agent_id: task.acp_agent_id,
        worker_role: task.worker_role,
        max_turns: 20,
      });
      return {
        key: `batch-${index + 1}`,
        title: prepared.taskTitle,
        node: {
          key: `batch-${index + 1}`,
          title: prepared.taskTitle,
          prompt: prepared.contractedPrompt,
          kind: "child_task" as const,
          dispatchTarget: prepared.dispatchTarget,
          parentTaskId: this.taskId,
          assignedAgentRoleId: prepared.assignedAgentRoleId,
          acpAgentId: prepared.acpAgentId,
          workerRole: prepared.workerRole,
          agentConfig: prepared.agentConfig,
          metadata: { depth: currentDepth + 1 },
        },
      };
    }));

    const snapshot = await this.daemon.createOrchestrationGraphRun({
      rootTaskId: this.taskId,
      workspaceId: this.workspace.id,
      kind: "delegation",
      maxParallel: tasks.length,
      metadata: { createdBy: "orchestrate_agents" },
      nodes: preparedNodes.map((entry) => entry.node),
    });

    const deadline = Date.now() + timeout_seconds * 1000;
    const results: Array<{
      task_id: string;
      title: string;
      status: string;
      result_summary?: string;
      error?: string;
    }> = [];

    for (const node of snapshot.nodes) {
      const handle = node.publicHandle || node.taskId || node.remoteTaskId || node.id;
      const remainingSeconds = Math.max(1, Math.round((deadline - Date.now()) / 1000));
      const result = await this.daemon.waitForDelegatedNode(this.taskId, handle, remainingSeconds);
      results.push({
        task_id: handle,
        title: node.title,
        status: result.status,
        result_summary: result.resultSummary,
        error: result.error,
      });
    }

    const completed = results.filter((r) => r.status === "completed").length;
    const failed = results.filter((r) => r.status !== "completed").length;

    return {
      success: completed > 0,
      results,
      completed,
      failed,
      message: `Orchestration complete: ${completed}/${results.length} succeeded`,
    };
  }

  /**
   * Get status of spawned agents
   */
  private async getAgentStatus(input: { task_ids?: string[] }): Promise<{
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
    const delegatedNodes: Array<{
      task_id: string;
      title: string;
      status: string;
      agent_type: string;
      model_key?: string;
      result_summary?: string;
      error?: string;
      created_at: number;
      completed_at?: number;
    }> = [];
    const rejected: Array<{
      task_id: string;
      status: string;
      error?: string;
    }> = [];

    if (task_ids && task_ids.length > 0) {
      // Get specific tasks (restricted to descendants only)
      for (const id of task_ids) {
        const delegatedNode = this.daemon.findDelegatedNode(this.taskId, id);
        if (delegatedNode && !delegatedNode.taskId) {
          delegatedNodes.push({
            task_id: delegatedNode.publicHandle || delegatedNode.remoteTaskId || delegatedNode.id,
            title: delegatedNode.title,
            status: delegatedNode.status,
            agent_type: delegatedNode.dispatchTarget,
            model_key: delegatedNode.agentConfig?.modelKey,
            result_summary: delegatedNode.summary || delegatedNode.output,
            error: delegatedNode.error,
            created_at: delegatedNode.createdAt,
            completed_at: delegatedNode.completedAt,
          });
          continue;
        }
        const resolved = await this.resolveDescendantTask(id);
        if (!resolved.ok) {
          const taskId = resolved.taskId || (typeof id === "string" ? id : String(id));
          rejected.push({
            task_id: taskId,
            status: resolved.error === "TASK_NOT_FOUND" ? "not_found" : "forbidden",
            error: resolved.message,
          });
          continue;
        }
        tasks.push(resolved.task);
      }
    } else {
      // Get all child tasks of current task
      tasks = await this.daemon.getChildTasks(this.taskId);
      const graphRuns = this.daemon.listOrchestrationGraphsByRootTask(this.taskId);
      for (const run of graphRuns) {
        for (const node of run.nodes) {
          if (!node.publicHandle || node.taskId) continue;
          delegatedNodes.push({
            task_id: node.publicHandle,
            title: node.title,
            status: node.status,
            agent_type: node.dispatchTarget,
            model_key: node.agentConfig?.modelKey,
            result_summary: node.summary || node.output,
            error: node.error,
            created_at: node.createdAt,
            completed_at: node.completedAt,
          });
        }
      }
    }

    const agents = [
      ...tasks.map((task) => ({
        task_id: task.id,
        title: task.title,
        status: task.status,
        agent_type: task.agentType || "main",
        model_key: task.agentConfig?.modelKey,
        result_summary: task.resultSummary,
        error: typeof task.error === "string" ? task.error : undefined,
        created_at: task.createdAt,
        completed_at: task.completedAt,
      })),
      ...delegatedNodes,
      ...rejected.map((item) => ({
        task_id: item.task_id,
        title: "(unavailable)",
        status: item.status,
        agent_type: "unknown",
        error: item.error,
        created_at: 0,
      })),
    ];

    return {
      agents,
      message:
        `Found ${tasks.length + delegatedNodes.length} agent(s)` +
        `${rejected.length > 0 ? ` (${rejected.length} rejected)` : ""}`,
    };
  }

  /**
   * List all spawned child agents for the current task
   */
  private async listAgents(input: {
    status_filter?: "all" | "running" | "completed" | "failed";
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
    const { status_filter = "all" } = input;

    // Get all child tasks
    let tasks = await this.daemon.getChildTasks(this.taskId);
    const graphRuns = this.daemon.listOrchestrationGraphsByRootTask(this.taskId);
    let delegatedNodes = graphRuns.flatMap((run) =>
      run.nodes.filter((node) => node.publicHandle && !node.taskId),
    );

    // Apply filter
    if (status_filter !== "all") {
      const runningStatuses = ["pending", "queued", "planning", "executing", "paused"];
      const completedStatuses = ["completed"];
      const failedStatuses = ["failed", "cancelled"];

      tasks = tasks.filter((task) => {
        switch (status_filter) {
          case "running":
            return runningStatuses.includes(task.status);
          case "completed":
            return completedStatuses.includes(task.status);
          case "failed":
            return failedStatuses.includes(task.status);
          default:
            return true;
        }
      });
      delegatedNodes = delegatedNodes.filter((node) => {
        switch (status_filter) {
          case "running":
            return ["pending", "ready", "running"].includes(node.status);
          case "completed":
            return node.status === "completed";
          case "failed":
            return ["failed", "cancelled", "blocked"].includes(node.status);
          default:
            return true;
        }
      });
    }

    // Calculate summary from all child tasks (not filtered)
    const allTasks = await this.daemon.getChildTasks(this.taskId);
    const allDelegatedNodes = graphRuns.flatMap((run) =>
      run.nodes.filter((node) => node.publicHandle && !node.taskId),
    );
    const summary = {
      total: allTasks.length + allDelegatedNodes.length,
      running: allTasks.filter((t) =>
        ["pending", "queued", "planning", "executing", "paused"].includes(t.status),
      ).length + allDelegatedNodes.filter((node) => ["pending", "ready", "running"].includes(node.status)).length,
      completed:
        allTasks.filter((t) => t.status === "completed").length +
        allDelegatedNodes.filter((node) => node.status === "completed").length,
      failed:
        allTasks.filter((t) => ["failed", "cancelled"].includes(t.status)).length +
        allDelegatedNodes.filter((node) => ["failed", "cancelled", "blocked"].includes(node.status)).length,
    };

    const agents = [
      ...tasks.map((task) => ({
        task_id: task.id,
        title: task.title,
        status: task.status,
        agent_type: task.agentType || "main",
        model_key: task.agentConfig?.modelKey,
        depth: task.depth ?? 0,
        created_at: task.createdAt,
      })),
      ...delegatedNodes.map((node) => ({
        task_id: node.publicHandle || node.id,
        title: node.title,
        status: node.status,
        agent_type: node.dispatchTarget,
        model_key: node.agentConfig?.modelKey,
        depth:
          typeof node.metadata?.depth === "number" && Number.isFinite(node.metadata.depth)
            ? Math.max(0, Math.floor(node.metadata.depth))
            : 0,
        created_at: node.createdAt,
      })),
    ];

    return {
      agents,
      summary,
      message:
        status_filter === "all"
          ? `Found ${agents.length} child agent(s)`
          : `Found ${agents.length} ${status_filter} agent(s) (${summary.total} total)`,
    };
  }

  private truncateForSummary(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars) + "...";
  }

  private summarizeAgentEvent(event: TaskEvent): {
    timestamp: number;
    type: string;
    summary: string;
  } {
    const payload = event.payload ?? {};
    const maxChars = 900;

    const toolName =
      typeof payload?.tool === "string"
        ? payload.tool
        : typeof payload?.name === "string"
          ? payload.name
          : "";

    switch (event.type) {
      case "assistant_message": {
        const content =
          (typeof payload?.content === "string" && payload.content) ||
          (typeof payload?.message === "string" && payload.message) ||
          "";
        return {
          timestamp: event.timestamp,
          type: event.type,
          summary: this.truncateForSummary(content || "[assistant_message]", maxChars),
        };
      }
      case "tool_call": {
        return {
          timestamp: event.timestamp,
          type: event.type,
          summary: toolName ? `tool_call ${toolName}` : "tool_call",
        };
      }
      case "tool_result": {
        const raw =
          typeof payload?.result === "string"
            ? payload.result
            : payload?.result
              ? JSON.stringify(payload.result)
              : "";
        const summary = toolName ? `tool_result ${toolName}: ${raw}` : `tool_result: ${raw}`;
        return {
          timestamp: event.timestamp,
          type: event.type,
          summary: this.truncateForSummary(summary, maxChars),
        };
      }
      case "tool_error": {
        const error = typeof payload?.error === "string" ? payload.error : "";
        const summary = toolName ? `tool_error ${toolName}: ${error}` : `tool_error: ${error}`;
        return {
          timestamp: event.timestamp,
          type: event.type,
          summary: this.truncateForSummary(summary, maxChars),
        };
      }
      case "file_created":
      case "file_modified":
      case "file_deleted": {
        const pathValue = typeof payload?.path === "string" ? payload.path : "";
        return {
          timestamp: event.timestamp,
          type: event.type,
          summary: pathValue ? `${event.type}: ${pathValue}` : event.type,
        };
      }
      case "step_started":
      case "step_completed":
      case "step_failed": {
        const desc = typeof payload?.step?.description === "string" ? payload.step.description : "";
        const err = typeof payload?.error === "string" ? payload.error : "";
        const suffix = err ? ` (${err})` : "";
        return {
          timestamp: event.timestamp,
          type: event.type,
          summary: this.truncateForSummary(
            desc ? `${event.type}: ${desc}${suffix}` : `${event.type}${suffix}`,
            maxChars,
          ),
        };
      }
      case "error": {
        const error = typeof payload?.error === "string" ? payload.error : "";
        return {
          timestamp: event.timestamp,
          type: event.type,
          summary: this.truncateForSummary(error ? `error: ${error}` : "error", maxChars),
        };
      }
      default: {
        let raw = "";
        try {
          raw = JSON.stringify(payload);
        } catch {
          raw = String(payload);
        }
        return {
          timestamp: event.timestamp,
          type: event.type,
          summary: this.truncateForSummary(raw || event.type, maxChars),
        };
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
      return {
        success: false,
        task_id: resolved.taskId,
        message: resolved.message,
        error: resolved.error,
      };
    }

    const message = typeof input?.message === "string" ? input.message.trim() : "";
    if (!message) {
      return {
        success: false,
        task_id: resolved.taskId,
        message: "message is required",
        error: "MESSAGE_REQUIRED",
      };
    }

    await this.daemon.sendMessage(resolved.taskId, message);
    return { success: true, task_id: resolved.taskId, message: "Message sent" };
  }

  private async captureAgentEvents(input: {
    task_id: unknown;
    limit?: unknown;
    types?: unknown;
  }): Promise<{
    success: boolean;
    task_id?: string;
    events?: Array<{ timestamp: number; type: string; summary: string }>;
    message: string;
    error?: string;
  }> {
    const resolved = await this.resolveDescendantTask(input?.task_id);
    if (!resolved.ok) {
      return {
        success: false,
        task_id: resolved.taskId,
        message: resolved.message,
        error: resolved.error,
      };
    }

    const limit =
      typeof input?.limit === "number" && Number.isFinite(input.limit)
        ? Math.min(Math.max(input.limit, 1), 100)
        : 30;

    const requestedTypes = Array.isArray(input?.types)
      ? input.types
          .filter((t): t is string => typeof t === "string")
          .map((t) => t.trim())
          .filter(Boolean)
      : undefined;

    // Exclude tool_result by default — it echoes full tool output and can
    // be very large. Callers can explicitly request it via the types param.
    const defaultTypes: string[] = [
      "assistant_message",
      "tool_call",
      "tool_error",
      "error",
      "log",
      "file_created",
      "file_modified",
      "file_deleted",
      "sub_agent_result",
    ];

    const types = requestedTypes && requestedTypes.length > 0 ? requestedTypes : defaultTypes;
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
    const delegatedNode =
      typeof input?.task_id === "string"
        ? this.daemon.findDelegatedNode?.(this.taskId, input.task_id)
        : undefined;
    if (delegatedNode && !delegatedNode.taskId) {
      const handle = delegatedNode.publicHandle || delegatedNode.remoteTaskId || delegatedNode.id;
      if (["completed", "failed", "cancelled", "blocked"].includes(delegatedNode.status)) {
        return {
          success: false,
          task_id: handle,
          message: `Task is already ${delegatedNode.status}`,
          error: "TASK_ALREADY_FINISHED",
        };
      }
      await this.daemon.cancelDelegatedNode?.(this.taskId, handle);
      return { success: true, task_id: handle, message: "Task cancelled" };
    }

    const resolved = await this.resolveDescendantTask(input?.task_id);
    if (!resolved.ok) {
      return {
        success: false,
        task_id: resolved.taskId,
        message: resolved.message,
        error: resolved.error,
      };
    }

    if (["completed", "failed", "cancelled"].includes(resolved.task.status)) {
      return {
        success: false,
        task_id: resolved.taskId,
        message: `Task is already ${resolved.task.status}`,
        error: "TASK_ALREADY_FINISHED",
      };
    }

    await this.daemon.cancelTask(resolved.taskId);

    return { success: true, task_id: resolved.taskId, message: "Task cancelled" };
  }

  private async pauseAgent(input: { task_id: unknown }): Promise<{
    success: boolean;
    task_id?: string;
    message: string;
    error?: string;
  }> {
    const resolved = await this.resolveDescendantTask(input?.task_id);
    if (!resolved.ok) {
      return {
        success: false,
        task_id: resolved.taskId,
        message: resolved.message,
        error: resolved.error,
      };
    }

    if (!["planning", "executing"].includes(resolved.task.status)) {
      return {
        success: false,
        task_id: resolved.taskId,
        message: `Cannot pause task in status "${resolved.task.status}"`,
        error: "TASK_NOT_RUNNING",
      };
    }

    await this.daemon.pauseTask(resolved.taskId);
    this.daemon.updateTaskStatus(resolved.taskId, "paused");
    this.daemon.logEvent(resolved.taskId, "task_paused", {
      message: "Task paused by parent agent",
      parentTaskId: this.taskId,
    });

    return { success: true, task_id: resolved.taskId, message: "Task paused" };
  }

  private async resumeAgent(input: { task_id: unknown }): Promise<{
    success: boolean;
    task_id?: string;
    message: string;
    error?: string;
  }> {
    const resolved = await this.resolveDescendantTask(input?.task_id);
    if (!resolved.ok) {
      return {
        success: false,
        task_id: resolved.taskId,
        message: resolved.message,
        error: resolved.error,
      };
    }

    if (resolved.task.status !== "paused") {
      return {
        success: false,
        task_id: resolved.taskId,
        message: `Cannot resume task in status "${resolved.task.status}"`,
        error: "TASK_NOT_PAUSED",
      };
    }

    const resumed = await this.daemon.resumeTask(resolved.taskId);
    if (!resumed) {
      return {
        success: false,
        task_id: resolved.taskId,
        message: "Task has no active executor — it may need to be re-queued",
        error: "NO_EXECUTOR",
      };
    }

    const refreshed = await this.daemon.getTaskById(resolved.taskId);
    if (refreshed && refreshed.status !== "executing") {
      this.daemon.updateTaskStatus(resolved.taskId, "executing");
      this.daemon.logEvent(resolved.taskId, "task_resumed", {
        message: "Task resumed by parent agent",
        parentTaskId: this.taskId,
      });
    }

    return { success: true, task_id: resolved.taskId, message: "Task resumed" };
  }

  /**
   * Define the Mermaid diagram tool
   */
  private getMermaidDiagramToolDefinition(): LLMTool {
    return {
      name: "create_diagram",
      description:
        "Create and display a Mermaid diagram in the UI. Use this to visualize workflows, " +
        "architecture, data models, timelines, sequences, or any structured information as an " +
        "interactive diagram. Supports all Mermaid diagram types: flowchart, sequenceDiagram, " +
        "classDiagram, stateDiagram, erDiagram, gantt, pie, gitGraph, mindmap, timeline, etc.",
      input_schema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Short descriptive title for the diagram",
          },
          diagram: {
            type: "string",
            description:
              "The Mermaid diagram definition. Must be valid Mermaid syntax, e.g.:\n" +
              "  flowchart TD\n" +
              "    A[Start] --> B{Decision}\n" +
              "    B -->|Yes| C[Do it]\n" +
              "    B -->|No| D[Skip]",
          },
        },
        required: ["title", "diagram"],
      },
    };
  }

  private static initializeMermaidValidation(): void {
    if (ToolRegistry.mermaidValidationInitialized) return;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "default",
    });
    ToolRegistry.mermaidValidationInitialized = true;
  }

  private static async validateMermaidDiagram(diagram: string): Promise<{
    success: boolean;
    error?: string;
    warning?: string;
  }> {
    try {
      ToolRegistry.initializeMermaidValidation();
      await mermaid.parse(diagram, { suppressErrors: false });
      return { success: true };
    } catch (error) {
      const message =
        error instanceof Error && error.message ? error.message : "invalid Mermaid syntax";
      if (ToolRegistry.isRecoverableMermaidValidationRuntimeError(message)) {
        return {
          success: true,
          warning:
            "Mermaid pre-validation is unavailable in this runtime; accepted without parser validation.",
        };
      }
      return {
        success: false,
        error: `invalid Mermaid syntax: ${message}`,
      };
    }
  }

  private static isRecoverableMermaidValidationRuntimeError(message: string): boolean {
    const lower = String(message || "").toLowerCase();
    return (
      lower.includes("dompurify.addhook is not a function") ||
      lower.includes("window is not defined") ||
      lower.includes("document is not defined")
    );
  }

  /**
   * Define meta tools for execution control
   */
  private getMetaToolDefinitions(): LLMTool[] {
    return [
      {
        name: "tool_search",
        description:
          "Search deferred or specialized tools by intent. Use this when the exact tool name is unknown, " +
          "when a needed capability is not currently exposed, or when you suspect a long-tail integration/tool exists.",
        input_schema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Natural-language description of the capability or task you need.",
            },
            limit: {
              type: "number",
              description: "Maximum number of matches to return. Default: 8.",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "revise_plan",
        description:
          "Revise the execution plan. Use this when you encounter unexpected obstacles, " +
          "discover that the original plan is insufficient, need to stop execution, or find a better approach. " +
          "Can add new steps, clear remaining steps, or both.",
        input_schema: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description:
                'Brief explanation of why the plan needs to be revised (e.g., "discovered missing dependency", "required path not found - need user input")',
            },
            clearRemaining: {
              type: "boolean",
              description:
                "Set to true to CLEAR/REMOVE all remaining pending steps. Use when the task cannot proceed (e.g., required files not found). Default is false.",
            },
            newSteps: {
              type: "array",
              description:
                "Array of new steps to add to the plan. Can be empty [] when clearing remaining steps.",
              items: {
                type: "object",
                properties: {
                  description: {
                    type: "string",
                    description: "Description of what this step should accomplish",
                  },
                },
                required: ["description"],
              },
            },
          },
          required: ["reason"],
        },
      },
      {
        name: "switch_workspace",
        description:
          "Switch to a different workspace/working directory. Use this when you need to work in a different folder " +
          "than the current workspace. You can specify either a path to the folder or a workspace ID. " +
          "If the path doesn't have an existing workspace, a new one will be created.",
        input_schema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description:
                'Absolute path to the folder to switch to (e.g., "/Users/user/projects/myapp")',
            },
            workspace_id: {
              type: "string",
              description: "ID of an existing workspace to switch to",
            },
          },
        },
      },
      {
        name: "list_projects",
        description:
          "List all projects in the CoWork OS control plane. " +
          "Returns each project's id, name, status, and description. " +
          "Use this to discover the correct project_id before calling link_project_workspace.",
        input_schema: {
          type: "object",
          properties: {
            include_archived: {
              type: "boolean",
              description: "Set to true to include archived projects. Defaults to false.",
            },
          },
          required: [],
        },
      },
      {
        name: "list_workspaces",
        description:
          "List all workspaces registered in CoWork OS. " +
          "Returns each workspace's id, name, and path. " +
          "Use this to discover the correct workspace_id before calling link_project_workspace.",
        input_schema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "link_project_workspace",
        description:
          "Link a workspace to a project in the CoWork OS control plane database. " +
          "This is the definitive way to associate a workspace with a project so that " +
          "autonomous agents can operate with durable context. " +
          "Call list_projects and list_workspaces first if you need to discover the correct IDs. " +
          "The first link created for a project is automatically set as primary.",
        input_schema: {
          type: "object",
          properties: {
            project_id: {
              type: "string",
              description: "The UUID of the project to link (from list_projects).",
            },
            workspace_id: {
              type: "string",
              description: "The UUID of the workspace to link (from list_workspaces).",
            },
            is_primary: {
              type: "boolean",
              description:
                "Set to true to mark this as the primary workspace for the project. " +
                "Defaults to true when no workspace is currently linked.",
            },
          },
          required: ["project_id", "workspace_id"],
        },
      },
      {
        name: "list_goals",
        description:
          "List all goals in the CoWork OS control plane. " +
          "Returns each goal's id, title, status, and description. " +
          "Use this to audit the goal-to-work graph (e.g. during a heartbeat Goal-to-Work Audit).",
        input_schema: {
          type: "object",
          properties: {
            company_id: {
              type: "string",
              description: "Optional company UUID to filter goals. Omit to return all goals.",
            },
          },
          required: [],
        },
      },
      {
        name: "list_issues",
        description:
          "List issues in the CoWork OS control plane with optional filters. " +
          "Returns each issue's id, title, status, priority, projectId, and goalId. " +
          "Use this during backlog reviews or goal-to-work audits.",
        input_schema: {
          type: "object",
          properties: {
            project_id: {
              type: "string",
              description: "Filter to issues belonging to this project UUID.",
            },
            goal_id: {
              type: "string",
              description: "Filter to issues belonging to this goal UUID.",
            },
            status: {
              type: "array",
              description:
                "Filter by status values, e.g. [\"backlog\", \"todo\", \"in_progress\", \"blocked\"].",
              items: { type: "string" },
            },
            limit: {
              type: "number",
              description: "Maximum number of issues to return (default 200, max 1000).",
            },
          },
          required: [],
        },
      },
      {
        name: "create_issue",
        description:
          "Create a new issue in the CoWork OS control plane. " +
          "Use this during a Goal-to-Work Audit when a goal or project has no actionable issues yet.",
        input_schema: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Short, action-oriented title for the issue.",
            },
            description: {
              type: "string",
              description: "Detailed description of the work to be done.",
            },
            project_id: {
              type: "string",
              description: "UUID of the project this issue belongs to (from list_projects).",
            },
            goal_id: {
              type: "string",
              description: "UUID of the goal this issue belongs to (from list_goals).",
            },
            status: {
              type: "string",
              description: "Initial status: backlog (default), todo, in_progress, or blocked.",
            },
            priority: {
              type: "number",
              description: "Priority 1 (highest) to 5 (lowest). Defaults to 2.",
            },
          },
          required: ["title"],
        },
      },
      {
        name: "request_user_input",
        description:
          "Ask the user a structured multiple-choice question set and block until they respond. " +
          "Use in plan mode when a decision materially changes the implementation plan, or in debug mode for reproduce/confirm checkpoints.",
        input_schema: {
          type: "object",
          properties: {
            questions: {
              type: "array",
              description: "1 to 3 short multiple-choice questions.",
              items: {
                type: "object",
                properties: {
                  header: {
                    type: "string",
                    description: "Short header label, 12 characters or fewer.",
                  },
                  id: {
                    type: "string",
                    description: "Stable snake_case identifier used for the answer map.",
                  },
                  question: {
                    type: "string",
                    description: "Single-sentence prompt shown above options.",
                  },
                  options: {
                    type: "array",
                    description:
                      "2 to 3 mutually exclusive options. Put the recommended option first and suffix label with '(Recommended)'.",
                    items: {
                      type: "object",
                      properties: {
                        label: { type: "string" },
                        description: { type: "string" },
                      },
                      required: ["label", "description"],
                    },
                  },
                },
                required: ["header", "id", "question", "options"],
              },
            },
          },
          required: ["questions"],
        },
      },
      {
        name: "task_list_create",
        description:
          "Create the initial ordered session checklist for multi-step execution work. " +
          "Fails if a session checklist already exists. Use this to establish lightweight execution discipline for the current task.",
        input_schema: {
          type: "object",
          properties: {
            items: {
              type: "array",
              description:
                "Non-empty ordered checklist. kind defaults to implementation when omitted.",
              items: {
                type: "object",
                properties: {
                  title: {
                    type: "string",
                    description: "Short checklist item title.",
                  },
                  kind: {
                    type: "string",
                    enum: ["implementation", "verification", "other"],
                    description: "Checklist item kind. Defaults to implementation.",
                  },
                  status: {
                    type: "string",
                    enum: ["pending", "in_progress", "completed", "blocked"],
                    description: "Current item status.",
                  },
                },
                required: ["title", "status"],
              },
            },
          },
          required: ["items"],
        },
        runtime: {
          concurrencyClass: "serial_only",
          readOnly: false,
          approvalKind: "none",
          sideEffectLevel: "low",
          interruptBehavior: "block",
          deferLoad: false,
          alwaysExpose: false,
          resultKind: "generic",
          supportsContextMutation: true,
          capabilityTags: ["core"],
          exposure: "conditional",
        },
      },
      {
        name: "task_list_update",
        description:
          "Replace the full ordered session checklist state. Existing items keep their ids when supplied; new items may omit id and the runtime will generate one.",
        input_schema: {
          type: "object",
          properties: {
            items: {
              type: "array",
              description:
                "Non-empty ordered checklist replacement. Preserve item ids you want to keep stable.",
              items: {
                type: "object",
                properties: {
                  id: {
                    type: "string",
                    description: "Existing checklist item id to preserve when updating.",
                  },
                  title: {
                    type: "string",
                    description: "Short checklist item title.",
                  },
                  kind: {
                    type: "string",
                    enum: ["implementation", "verification", "other"],
                    description: "Checklist item kind. Defaults to implementation.",
                  },
                  status: {
                    type: "string",
                    enum: ["pending", "in_progress", "completed", "blocked"],
                    description: "Current item status.",
                  },
                },
                required: ["title", "status"],
              },
            },
          },
          required: ["items"],
        },
        runtime: {
          concurrencyClass: "serial_only",
          readOnly: false,
          approvalKind: "none",
          sideEffectLevel: "low",
          interruptBehavior: "block",
          deferLoad: false,
          alwaysExpose: false,
          resultKind: "generic",
          supportsContextMutation: true,
          capabilityTags: ["core"],
          exposure: "conditional",
        },
      },
      {
        name: "task_list_list",
        description:
          "Return the current session checklist state, including whether a verification nudge is active.",
        input_schema: {
          type: "object",
          properties: {},
          required: [],
        },
        runtime: {
          concurrencyClass: "read_parallel",
          readOnly: true,
          approvalKind: "none",
          sideEffectLevel: "none",
          interruptBehavior: "cancel",
          deferLoad: false,
          alwaysExpose: false,
          resultKind: "read",
          supportsContextMutation: false,
          capabilityTags: ["core"],
          exposure: "conditional",
        },
      },
      {
        name: "integration_setup",
        description:
          "Inspect, list, or configure integrations directly from chat. " +
          "Supports Tier-1 providers: resend, google-workspace, jira, linear, hubspot, salesforce, zendesk, servicenow. " +
          "Use inspect to get plan_hash + missing inputs, and configure with expected_plan_hash for safe apply.",
        input_schema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["list", "inspect", "configure"],
              description:
                "list = show all Tier-1 providers, inspect = show readiness and plan_hash, configure = apply settings",
            },
            provider: {
              type: "string",
              enum: [
                "resend",
                "google-workspace",
                "jira",
                "linear",
                "hubspot",
                "salesforce",
                "zendesk",
                "servicenow",
              ],
              description: "Integration provider to inspect/configure",
            },
            auth_method: {
              type: "string",
              enum: ["auto", "api_key", "oauth"],
              description:
                "Authentication method preference. auto picks the best available path for the provider.",
            },
            expected_plan_hash: {
              type: "string",
              description:
                "Optional stale-plan guard. Pass plan_hash from inspect; configure fails safely if state changed.",
            },
            dry_run: {
              type: "boolean",
              description: "When true, computes the outcome without writing settings or launching OAuth.",
            },
            env: {
              type: "object",
              description:
                "Environment variable overrides to apply to the connector (e.g., {\"LINEAR_API_KEY\":\"...\"}).",
              additionalProperties: true,
            },
            oauth: {
              type: "object",
              description:
                "OAuth bootstrap inputs. client_id is required for OAuth setup. Optional provider-specific fields are supported.",
              properties: {
                client_id: { type: "string" },
                client_secret: { type: "string" },
                scopes: {
                  type: "array",
                  items: { type: "string" },
                },
                login_url: { type: "string" },
                subdomain: { type: "string" },
                team_domain: { type: "string" },
              },
            },
            api_key: {
              type: "string",
              description: "Legacy shortcut for Resend API key (maps to RESEND_API_KEY).",
            },
            base_url: {
              type: "string",
              description: "Legacy shortcut for Resend base URL (maps to RESEND_BASE_URL).",
            },
            connect_now: {
              type: "boolean",
              description:
                "Whether to connect/test immediately after configuration (default: true)",
            },
            enable_inbound: {
              type: "boolean",
              description: "Enable inbound webhook preset configuration (/hooks/resend)",
            },
            webhook_secret: {
              type: "string",
              description:
                "Optional webhook signing secret for inbound verification (Resend Svix secret, usually starts with whsec_)",
            },
            allow_unsafe_external_content: {
              type: "boolean",
              description: "Set allowUnsafeExternalContent for inbound mapped tasks",
            },
          },
        },
      },
      {
        name: "task_history",
        description:
          "Query your recent task history and messages from the local database. " +
          'Use this to answer questions like "What did we talk about yesterday?", ' +
          '"Show me my last 10 tasks", or "What did I ask earlier today?".',
        input_schema: {
          type: "object",
          properties: {
            period: {
              type: "string",
              enum: ["today", "yesterday", "last_7_days", "last_30_days", "custom"],
              description: "Time period to query",
            },
            from: {
              type: "string",
              description:
                'For custom: start time as ISO string (e.g., "2026-02-06T00:00:00Z"). If omitted, defaults are used.',
            },
            to: {
              type: "string",
              description:
                'For custom: end time as ISO string (e.g., "2026-02-07T00:00:00Z"). If omitted, defaults are used.',
            },
            limit: {
              type: "number",
              description: "Maximum number of tasks to return (1-50). Default: 20",
            },
            workspace_id: {
              type: "string",
              description: "Optional workspace ID to restrict results to",
            },
            query: {
              type: "string",
              description: "Optional substring filter applied to task title and prompt",
            },
            include_messages: {
              type: "boolean",
              description: "Include last user/assistant message per task (default: true)",
            },
          },
          required: ["period"],
        },
      },
      {
        name: "task_events",
        description:
          "Query task event logs (tool calls, tool results, assistant/user messages, feedback, file ops) from the local database. " +
          "Use this to build accurate digests and stats without scraping filesystem logs.",
        input_schema: {
          type: "object",
          properties: {
            period: {
              type: "string",
              enum: ["today", "yesterday", "last_7_days", "last_30_days", "custom"],
              description: "Time period to query",
            },
            from: {
              type: "string",
              description:
                'For custom: start time as ISO string (e.g., "2026-02-06T00:00:00Z"). If omitted, defaults are used.',
            },
            to: {
              type: "string",
              description:
                'For custom: end time as ISO string (e.g., "2026-02-07T00:00:00Z"). If omitted, defaults are used.',
            },
            limit: {
              type: "number",
              description: "Maximum number of events to return (1-500). Default: 200",
            },
            workspace_id: {
              type: "string",
              description: "Optional workspace ID to restrict results to",
            },
            types: {
              type: "array",
              items: { type: "string" },
              description:
                'Optional list of event types to include (e.g., ["tool_call","user_feedback"])',
            },
            include_payload: {
              type: "boolean",
              description: "Include a compact payload preview for each event (default: true)",
            },
          },
          required: ["period"],
        },
      },
      {
        name: "set_personality",
        description:
          "Change the assistant's communication style. Use when the user asks to be more friendly, professional, concise, etc. " +
          "Accepts: preset (professional, friendly, concise, creative, technical, casual), or adjust (e.g. { warmth: 80 }) for fine-tuning.",
        input_schema: {
          type: "object",
          properties: {
            personality: {
              type: "string",
              enum: ["professional", "friendly", "concise", "creative", "technical", "casual"],
              description: "The personality preset to switch to (legacy)",
            },
            preset: {
              type: "string",
              enum: ["professional", "friendly", "concise", "creative", "technical", "casual"],
              description: "Quick preset to apply",
            },
            adjust: {
              type: "object",
              additionalProperties: { type: "number" },
              description: "Trait adjustments, e.g. { warmth: 80, directness: 70 }",
            },
          },
        },
      },
      {
        name: "add_behavioral_rule",
        description:
          "Add a behavioral rule that shapes how the assistant responds. Use when the user wants explicit do/don't instructions.",
        input_schema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["always", "never", "prefer", "avoid"],
              description: "Rule type",
            },
            rule: {
              type: "string",
              description: "The rule text, e.g. 'Explain your reasoning step by step'",
            },
          },
          required: ["rule"],
        },
      },
      {
        name: "set_expertise",
        description:
          "Set the assistant's expertise level for a domain. Use when the user wants the assistant to be stronger in a specific area.",
        input_schema: {
          type: "object",
          properties: {
            domain: {
              type: "string",
              description: "Domain, e.g. TypeScript, React, Marketing",
            },
            level: {
              type: "string",
              enum: ["familiar", "proficient", "expert"],
              description: "Proficiency level",
            },
          },
          required: ["domain"],
        },
      },
      {
        name: "set_persona",
        description:
          "Change the assistant's character persona. Personas are character overlays inspired by famous AI assistants. " +
          "Use this when the user asks to change persona, act like a character, or wants a specific AI personality. " +
          "Available personas: jarvis (sophisticated butler), friday (friendly colleague), hal (calm/formal), " +
          "computer (Star Trek efficient), alfred (refined gentleman), intern (eager learner), sensei (wise teacher), " +
          "pirate (swashbuckling adventurer), noir (1940s detective), companion (warm, thoughtful presence). " +
          'Use "none" to remove persona overlay.',
        input_schema: {
          type: "object",
          properties: {
            persona: {
              type: "string",
              enum: [
                "none",
                "jarvis",
                "friday",
                "hal",
                "computer",
                "alfred",
                "intern",
                "sensei",
                "pirate",
                "noir",
                "companion",
              ],
              description: 'The persona to adopt (or "none" to clear)',
            },
          },
          required: ["persona"],
        },
      },
      {
        name: "set_agent_name",
        description:
          "Set or change the assistant's name. Use this when the user wants to give you a name, rename you, or asks " +
          '"what should I call you?" The name will be remembered and used in all future interactions. ' +
          'Default name is "CoWork" if not customized.',
        input_schema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: 'The new name for the assistant (e.g., "Jarvis", "Friday", "Max")',
            },
          },
          required: ["name"],
        },
      },
      {
        name: "set_user_name",
        description:
          "Store the user's name when they introduce themselves. Use this PROACTIVELY when the user tells you their name " +
          '(e.g., "I\'m Alice", "My name is Bob", "Call me Charlie"). This helps personalize future interactions. ' +
          "The name will be remembered across sessions and used in greetings and context.",
        input_schema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The user's name as they introduced themselves",
            },
          },
          required: ["name"],
        },
      },
      {
        name: "set_response_style",
        description:
          'Adjust how the assistant responds. Use when the user asks for different response styles like "use more emojis", ' +
          '"be more brief", "explain things simply", or "add more code comments". All parameters are optional - only set what the user wants to change.',
        input_schema: {
          type: "object",
          properties: {
            emoji_usage: {
              type: "string",
              enum: ["none", "minimal", "moderate", "expressive"],
              description:
                "How much to use emojis: none (never), minimal (rarely), moderate (sometimes), expressive (frequently)",
            },
            response_length: {
              type: "string",
              enum: ["terse", "balanced", "detailed"],
              description:
                "Response verbosity: terse (very brief), balanced (normal), detailed (comprehensive)",
            },
            code_comments: {
              type: "string",
              enum: ["minimal", "moderate", "verbose"],
              description:
                "Code commenting style: minimal (essential only), moderate (helpful comments), verbose (detailed explanations)",
            },
            explanation_depth: {
              type: "string",
              enum: ["expert", "balanced", "teaching"],
              description:
                "How deeply to explain: expert (assume knowledge), balanced (normal), teaching (thorough explanations)",
            },
          },
        },
      },
      {
        name: "set_quirks",
        description:
          "Set personality quirks like catchphrases, sign-offs, or analogy themes. Use when the user wants the assistant " +
          "to have a signature phrase, end responses a certain way, or use analogies from a specific domain. " +
          "Pass empty string to clear a quirk.",
        input_schema: {
          type: "object",
          properties: {
            catchphrase: {
              type: "string",
              description:
                'A signature phrase to occasionally use (e.g., "At your service!", "Consider it done!")',
            },
            sign_off: {
              type: "string",
              description:
                'How to end longer responses (e.g., "Happy coding!", "May the force be with you!")',
            },
            analogy_domain: {
              type: "string",
              enum: [
                "none",
                "cooking",
                "sports",
                "space",
                "music",
                "nature",
                "gaming",
                "movies",
                "construction",
              ],
              description:
                "Theme for analogies and examples: none (no preference), or a specific domain",
            },
          },
        },
      },
      // Vibes & Lore tools
      {
        name: "set_vibes",
        description:
          "Update the current workspace vibes/energy mode. Call this when you detect a shift in the user's working " +
          "energy, pace, or intent. For example, if the user says 'let's ship this' switch to crunch mode, or if they " +
          "say 'just exploring' switch to explore mode. Only operates when a .cowork/ directory exists.",
        input_schema: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: [
                "crunch",
                "explore",
                "deep-focus",
                "maintenance",
                "playful",
                "low-energy",
                "default",
              ],
              description:
                "The current energy mode: crunch (fast, ship it), explore (open, speculative), " +
                "deep-focus (dense, no small talk), maintenance (steady, careful), playful (fun, creative), " +
                "low-energy (simple, small steps), default (balanced)",
            },
            energy: {
              type: "string",
              enum: ["high", "balanced", "low"],
              description: "Overall energy level (default: balanced)",
            },
            notes: {
              type: "string",
              description: "Brief context for the current vibe (max 120 chars)",
            },
          },
          required: ["mode"],
        },
      },
      {
        name: "update_lore",
        description:
          "Record a notable shared moment or reference in the workspace lore. Use after significant accomplishments, " +
          "breakthroughs, hard-won debugging sessions, or when the user shares something memorable about the project. " +
          "Only operates when a .cowork/ directory exists.",
        input_schema: {
          type: "object",
          properties: {
            entry: {
              type: "string",
              description: "The lore entry to record (1 sentence, max 200 chars)",
            },
            section: {
              type: "string",
              enum: ["milestones", "references", "notes"],
              description: 'Which section to add to (default: "milestones")',
            },
          },
          required: ["entry"],
        },
      },
      // Sandboxed code execution
      ...CodeExecTools.getToolDefinitions(),
      // Document parsing
      ...DocumentParserTools.getToolDefinitions(),
      // Sub-Agent / Parallel Agent tools
      {
        name: "acp_discover",
        description:
          "Discover ACP/A2A agents that CoWork can delegate work to. Use this before selecting acp_agent_id for spawn_agent or orchestrate_agents.",
        input_schema: {
          type: "object",
          properties: {
            capability: {
              type: "string",
              description: "Optional capability filter such as code, research, or design.",
            },
            query: {
              type: "string",
              description: "Optional text search over agent names, descriptions, and skills.",
            },
            origin: {
              type: "string",
              enum: ["local", "remote"],
              description: "Filter to local or remote ACP agents.",
            },
            status: {
              type: "string",
              enum: ["available", "busy", "offline"],
              description: "Optional agent availability filter.",
            },
          },
        },
      },
      {
        name: "spawn_agent",
        description:
          "Spawn a new agent (sub-task) to work on a specific task independently. Use this to delegate work, " +
          "perform parallel operations, or use a cheaper/faster model for batch work. Sub-agents do not retain " +
          "memory after completion. Returns immediately with the spawned task ID - use wait_for_agent or " +
          "get_agent_status to check progress. Maximum nesting depth is 3 levels. Active child fanout is capped.",
        input_schema: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description:
                "The task/instruction for the spawned agent. Be specific and include all context needed.",
            },
            title: {
              type: "string",
              description:
                "A short title for the subtask (optional, derived from prompt if not provided)",
            },
            model_preference: {
              type: "string",
              enum: ["same", "cheaper", "smarter"],
              description:
                'Model selection: "same" uses parent model, "cheaper" selects Haiku (fast/cheap), "smarter" selects Opus (most capable). Default: "cheaper" for cost optimization.',
            },
            capability_hint: {
              type: "string",
              enum: ["code", "math", "research", "vision", "fast", "long_context"],
              description:
                "Route to a model suited for this capability type. Used when model_preference is absent. " +
                '"code"/"fast" → Haiku, "research"/"math"/"vision"/"long_context" → Sonnet.',
            },
            acp_agent_id: {
              type: "string",
              description:
                "Optional ACP agent ID returned by acp_discover. When provided, CoWork routes the task to that ACP/A2A agent instead of picking a generic sub-agent.",
            },
            personality: {
              type: "string",
              enum: ["same", "professional", "technical", "concise", "creative", "friendly"],
              description:
                'Personality for the spawned agent. "same" inherits from parent. Default: "concise"',
            },
            worker_role: {
              type: "string",
              enum: ["auto", "researcher", "implementer", "verifier", "synthesizer"],
              description:
                'Optional worker role. "auto" infers from the prompt: research/read-only work -> researcher, checks/validation -> verifier, merge/summarize outputs -> synthesizer, everything else -> implementer.',
            },
            runtime: {
              type: "string",
              enum: ["native", "acpx"],
              description:
                'Execution runtime for the spawned agent. "native" uses CoWork\'s built-in executor, "acpx" routes the task through the external acpx runtime.',
            },
            runtime_agent: {
              type: "string",
              enum: ["codex", "claude"],
              description:
                'When runtime is "acpx", selects the target adapter, such as "codex" or "claude".',
            },
            wait: {
              type: "boolean",
              description:
                "If true, wait for the agent to complete before returning (blocking). Default: false (async)",
            },
            max_turns: {
              type: "number",
              description:
                "Maximum number of LLM turns for the sub-agent. Range: 1-100 (up to 250 in deep work mode). Default: 20",
            },
          },
          required: ["prompt"],
        },
      },
      {
        name: "orchestrate_agents",
        description:
          "Spawn multiple sub-agents in parallel and wait for all of them to complete. " +
          "Returns combined results from all agents. Use this for parallel research, batch processing, " +
          "or when multiple independent tasks can run simultaneously. More efficient than sequential spawn_agent + wait_for_agent calls.",
        input_schema: {
          type: "object",
          properties: {
            tasks: {
              type: "array",
              description: "Array of sub-tasks to execute in parallel (2-8 tasks)",
              items: {
                type: "object",
                properties: {
                  prompt: {
                    type: "string",
                    description: "Task instruction for this sub-agent",
                  },
                  title: {
                    type: "string",
                    description: "Short title for this sub-task",
                  },
                  model_preference: {
                    type: "string",
                    enum: ["same", "cheaper", "smarter"],
                    description: 'Model selection. Default: "cheaper"',
                  },
                  capability_hint: {
                    type: "string",
                    enum: ["code", "math", "research", "vision", "fast", "long_context"],
                    description: "Route to a capability-suited model when model_preference is absent.",
                  },
                  acp_agent_id: {
                    type: "string",
                    description:
                      "Optional ACP agent ID returned by acp_discover for this orchestration node.",
                  },
                  worker_role: {
                    type: "string",
                    enum: ["auto", "researcher", "implementer", "verifier", "synthesizer"],
                    description:
                      'Optional worker role override. "auto" infers the role from the task prompt.',
                  },
                },
                required: ["prompt"],
              },
              minItems: 2,
              maxItems: 8,
            },
            timeout_seconds: {
              type: "number",
              description: "Timeout in seconds for all agents to complete. Default: 300 (5 min)",
            },
          },
          required: ["tasks"],
        },
      },
      {
        name: "wait_for_agent",
        description:
          "Wait for a spawned agent to complete and retrieve its results. Returns the agent's final status, " +
          "result summary, and any error information. Use this to synchronize with sub-agents when you need " +
          "their results before proceeding.",
        input_schema: {
          type: "object",
          properties: {
            task_id: {
              type: "string",
              description: "The task ID of the spawned agent (returned by spawn_agent)",
            },
            timeout_seconds: {
              type: "number",
              description: "Maximum time to wait in seconds. Default: 300 (5 minutes)",
            },
          },
          required: ["task_id"],
        },
      },
      {
        name: "get_agent_status",
        description:
          "Check the status of spawned agents. Returns current status, progress, and any results. " +
          "Use this for non-blocking status checks.",
        input_schema: {
          type: "object",
          properties: {
            task_ids: {
              type: "array",
              items: { type: "string" },
              description:
                "Array of task IDs to check. If empty or omitted, returns status of all child agents.",
            },
          },
        },
      },
      {
        name: "get_orchestration_status",
        description:
          "Get the persisted status of a DAG orchestration run created for the current task. " +
          "Returns the run summary plus per-node dependency and completion state.",
        input_schema: {
          type: "object",
          properties: {
            run_id: {
              type: "string",
              description:
                "Optional orchestration run ID. If omitted, returns the latest run associated with the current task.",
            },
          },
        },
      },
      {
        name: "list_agents",
        description:
          "List all spawned child agents for the current task. Shows their status, model, title, and progress.",
        input_schema: {
          type: "object",
          properties: {
            status_filter: {
              type: "string",
              enum: ["all", "running", "completed", "failed"],
              description: 'Filter agents by status. Default: "all"',
            },
          },
        },
      },
      {
        name: "send_agent_message",
        description:
          "Send a follow-up message to a descendant child agent task. Use this to clarify instructions, provide missing " +
          "context, or steer a running sub-agent. This tool only works for tasks spawned by the current task (descendants).",
        input_schema: {
          type: "object",
          properties: {
            task_id: {
              type: "string",
              description: "The descendant child task ID",
            },
            message: {
              type: "string",
              description: "The message to send to the child task",
            },
          },
          required: ["task_id", "message"],
        },
      },
      {
        name: "capture_agent_events",
        description:
          "Capture recent events/output from a descendant child agent task. Returns a compact, summarized event list. " +
          "This tool only works for tasks spawned by the current task (descendants).",
        input_schema: {
          type: "object",
          properties: {
            task_id: {
              type: "string",
              description: "The descendant child task ID",
            },
            limit: {
              type: "number",
              description: "Maximum number of recent events to return (default: 30, max: 100)",
            },
            types: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional list of event types to include (defaults to a safe, high-signal subset)",
            },
          },
          required: ["task_id"],
        },
      },
      {
        name: "cancel_agent",
        description:
          "Cancel a descendant child agent task. This tool only works for tasks spawned by the current task (descendants).",
        input_schema: {
          type: "object",
          properties: {
            task_id: {
              type: "string",
              description: "The descendant child task ID",
            },
          },
          required: ["task_id"],
        },
      },
      {
        name: "pause_agent",
        description:
          "Pause a running descendant child agent task. This tool only works for tasks spawned by the current task (descendants).",
        input_schema: {
          type: "object",
          properties: {
            task_id: {
              type: "string",
              description: "The descendant child task ID",
            },
          },
          required: ["task_id"],
        },
      },
      {
        name: "resume_agent",
        description:
          "Resume a paused descendant child agent task. This tool only works for tasks spawned by the current task (descendants).",
        input_schema: {
          type: "object",
          properties: {
            task_id: {
              type: "string",
              description: "The descendant child task ID",
            },
          },
          required: ["task_id"],
        },
      },
      {
        name: "manage_heartbeat",
        description:
          "Enable or disable the heartbeat (periodic wake-up) for a digital twin / agent role. " +
          "Use this when the user asks to start or stop a twin. Disabling the heartbeat prevents " +
          "the agent from waking up on its own schedule.",
        input_schema: {
          type: "object",
          properties: {
            agent_name: {
              type: "string",
              description:
                "The display name of the agent role / digital twin (e.g. 'Engineering Manager Twin')",
            },
            enabled: {
              type: "boolean",
              description: "true to enable (start) the heartbeat, false to disable (stop) it",
            },
          },
          required: ["agent_name", "enabled"],
        },
      },
    ];
  }

  /**
   * Execute the manage_heartbeat tool
   */
  private manageHeartbeat(input: { agent_name?: string; enabled?: boolean }): {
    success: boolean;
    message: string;
  } {
    const { agent_name, enabled } = input;
    if (!agent_name || typeof agent_name !== "string" || agent_name.trim().length === 0) {
      return { success: false, message: "agent_name is required" };
    }
    if (typeof enabled !== "boolean") {
      return { success: false, message: "enabled must be a boolean (true or false)" };
    }

    // Look up the agent role by display name
    const db = this.daemon.getDatabase();
// oxlint-disable-next-line typescript-eslint(no-require-imports)
    const { AgentRoleRepository } = require("../../agents/AgentRoleRepository");
    const agentRoleRepo = new AgentRoleRepository(db);
    const allRoles = agentRoleRepo.findAll(true); // include inactive
    const role = allRoles.find(
      (r: Any) =>
        r.displayName.toLowerCase() === agent_name.trim().toLowerCase() ||
        r.name.toLowerCase() === agent_name.trim().toLowerCase(),
    );

    if (!role) {
      const available = allRoles.map((r: Any) => r.displayName).join(", ");
      return {
        success: false,
        message: `Agent role "${agent_name}" not found. Available: ${available}`,
      };
    }

    // Update heartbeat config in DB
    const config = { heartbeatEnabled: enabled };
    agentRoleRepo.updateHeartbeatConfig(role.id, config);

    // Notify the HeartbeatService singleton to cancel or reschedule
// oxlint-disable-next-line typescript-eslint(no-require-imports)
    const { getHeartbeatService } = require("../../agents/HeartbeatService");
    const heartbeatService = getHeartbeatService();
    if (heartbeatService) {
      heartbeatService.updateAgentConfig(role.id, config);
    }

    const action = enabled ? "enabled" : "disabled";
    console.log(`[ToolRegistry] manage_heartbeat: ${action} heartbeat for ${role.displayName}`);
    return {
      success: true,
      message: `Heartbeat ${action} for ${role.displayName}`,
    };
  }
}
