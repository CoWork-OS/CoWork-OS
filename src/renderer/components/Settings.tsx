import { useState, useEffect, useRef, type ReactNode } from "react";
import {
  Sparkles,
  Sun,
  User,
  Users,
  PanelTop,
  Mic,
  Layers,
  Search,
  MessageCircle,
  Send,
  Hash,
  UsersRound,
  AtSign,
  MoreHorizontal,
  Settings2,
  Shield,
  Brain,
  ListOrdered,
  GitBranch,
  Wrench,
  Store,
  Clock,
  LayoutGrid,
  Zap,
  Monitor,
  Smartphone,
  Puzzle,
  BarChart3,
  Lightbulb,
  ShieldCheck,
  RefreshCw,
  MessageSquare,
  Smile,
  ShieldCheck as ShieldCheckIcon,
  MessagesSquare,
  Mail,
  Square,
  Tv,
  CircleDot,
  FileText,
  Cloud,
  Star,
  Globe,
  Box,
  Droplets,
  Link,
  Hexagon,
  Crosshair,
  Pi,
  ChevronDown,
  Plus,
} from "lucide-react";
import {
  LLMSettingsData,
  ThemeMode,
  VisualTheme,
  AccentColor,
  UiDensity,
  type LLMProviderType,
  type CustomProviderConfig,
} from "../../shared/types";
import { CUSTOM_PROVIDER_MAP } from "../../shared/llm-provider-catalog";
import { TelegramSettings } from "./TelegramSettings";
import { DiscordSettings } from "./DiscordSettings";
import { SlackSettings } from "./SlackSettings";
import { WhatsAppSettings } from "./WhatsAppSettings";
import { ImessageSettings } from "./ImessageSettings";
import { SignalSettings } from "./SignalSettings";
import { MattermostSettings } from "./MattermostSettings";
import { MatrixSettings } from "./MatrixSettings";
import { TwitchSettings } from "./TwitchSettings";
import { LineSettings } from "./LineSettings";
import { BlueBubblesSettings } from "./BlueBubblesSettings";
import { EmailSettings } from "./EmailSettings";
import { TeamsSettings } from "./TeamsSettings";
import { GoogleChatSettings } from "./GoogleChatSettings";
import { XSettings } from "./XSettings";
import { NotionSettings } from "./NotionSettings";
import { BoxSettings } from "./BoxSettings";
import { OneDriveSettings } from "./OneDriveSettings";
import { GoogleWorkspaceSettings } from "./GoogleWorkspaceSettings";
import { DropboxSettings } from "./DropboxSettings";
import { SharePointSettings } from "./SharePointSettings";
import { SearchSettings } from "./SearchSettings";
import { UpdateSettings } from "./UpdateSettings";
import { GuardrailSettings } from "./GuardrailSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { QueueSettings } from "./QueueSettings";
import { SkillsSettings } from "./SkillsSettings";
import { SkillHubBrowser } from "./SkillHubBrowser";
import { MCPSettings } from "./MCPSettings";
import { ConnectorsSettings } from "./ConnectorsSettings";
import { BuiltinToolsSettings } from "./BuiltinToolsSettings";
import { TraySettings } from "./TraySettings";
import { ScheduledTasksSettings } from "./ScheduledTasksSettings";
import { HooksSettings } from "./HooksSettings";
import { ControlPlaneSettings } from "./ControlPlaneSettings";
import { PersonalitySettings } from "./PersonalitySettings";
import { NodesSettings } from "./NodesSettings";
import { ExtensionsSettings } from "./ExtensionsSettings";
import { VoiceSettings } from "./VoiceSettings";
import { MissionControlPanel } from "./MissionControlPanel";
import { MemoryHubSettings } from "./MemoryHubSettings";
import { WorktreeSettings } from "./WorktreeSettings";
import { UsageInsightsPanel } from "./UsageInsightsPanel";
import { SuggestionsPanel } from "./SuggestionsPanel";
import { CustomizePanel } from "./CustomizePanel";
import { AdminPoliciesPanel } from "./AdminPoliciesPanel";
import { EventTriggersPanel } from "./EventTriggersPanel";
import { BriefingPanel } from "./BriefingPanel";
import { WebAccessSettingsPanel } from "./WebAccessSettingsPanel";
import { InfraSettings } from "./InfraSettings";
import { DigitalTwinsPanel } from "./DigitalTwinsPanel";

type SettingsTab =
  | "appearance"
  | "personality"
  | "missioncontrol"
  | "tray"
  | "voice"
  | "llm"
  | "search"
  | "telegram"
  | "slack"
  | "whatsapp"
  | "teams"
  | "x"
  | "morechannels"
  | "integrations"
  | "updates"
  | "guardrails"
  | "queue"
  | "skills"
  | "skillhub"
  | "connectors"
  | "infrastructure"
  | "mcp"
  | "tools"
  | "scheduled"
  | "hooks"
  | "controlplane"
  | "nodes"
  | "extensions"
  | "memory"
  | "git"
  | "insights"
  | "suggestions"
  | "customize"
  | "digitaltwins"
  | "policies"
  | "triggers"
  | "briefing"
  | "webaccess";

// Secondary channels shown inside "More Channels" tab
type SecondaryChannel =
  | "discord"
  | "imessage"
  | "signal"
  | "mattermost"
  | "matrix"
  | "twitch"
  | "line"
  | "bluebubbles"
  | "email"
  | "googlechat";

// App integrations shown inside "Integrations" tab
type IntegrationChannel =
  | "notion"
  | "box"
  | "onedrive"
  | "googleworkspace"
  | "dropbox"
  | "sharepoint";

interface SettingsProps {
  onBack: () => void;
  onSettingsChanged?: () => void;
  themeMode: ThemeMode;
  visualTheme: VisualTheme;
  accentColor: AccentColor;
  onThemeChange: (theme: ThemeMode) => void;
  onVisualThemeChange: (theme: VisualTheme) => void;
  onAccentChange: (accent: AccentColor) => void;
  uiDensity: UiDensity;
  onUiDensityChange: (density: UiDensity) => void;
  initialTab?: SettingsTab;
  onShowOnboarding?: () => void;
  onboardingCompletedAt?: string;
  workspaceId?: string;
  onCreateTask?: (title: string, prompt: string) => void;
}

interface ModelOption {
  key: string;
  displayName: string;
}

interface ProviderInfo {
  type: string;
  name: string;
  configured: boolean;
}

// Helper to format bytes to human-readable size
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

// Searchable Select Component
interface SearchableSelectOption {
  value: string;
  label: string;
  description?: string;
}

interface SearchableSelectProps {
  options: SearchableSelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** Allow entering a custom value that isn't in the options list */
  allowCustomValue?: boolean;
}

function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = "Select...",
  className = "",
  allowCustomValue = false,
}: SearchableSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((opt) => opt.value === value);

  const filteredOptions = options.filter(
    (opt) =>
      opt.label.toLowerCase().includes(search.toLowerCase()) ||
      opt.value.toLowerCase().includes(search.toLowerCase()) ||
      (opt.description && opt.description.toLowerCase().includes(search.toLowerCase())),
  );

  const customValue = search.trim();
  const showCustomOption =
    allowCustomValue && filteredOptions.length === 0 && customValue.length > 0;
  const optionCount =
    filteredOptions.length > 0 ? filteredOptions.length : showCustomOption ? 1 : 0;

  // Reset highlighted index when search changes
  useEffect(() => {
    setHighlightedIndex(0);
  }, [search]);

  // Scroll highlighted option into view
  useEffect(() => {
    if (isOpen && listRef.current) {
      const highlightedEl = listRef.current.querySelector(`[data-index="${highlightedIndex}"]`);
      if (highlightedEl) {
        highlightedEl.scrollIntoView({ block: "nearest" });
      }
    }
  }, [highlightedIndex, isOpen]);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        setIsOpen(true);
      }
      return;
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (optionCount > 0) {
          setHighlightedIndex((i) => Math.min(i + 1, optionCount - 1));
        }
        break;
      case "ArrowUp":
        e.preventDefault();
        if (optionCount > 0) {
          setHighlightedIndex((i) => Math.max(i - 1, 0));
        }
        break;
      case "Enter":
        e.preventDefault();
        if (filteredOptions[highlightedIndex]) {
          onChange(filteredOptions[highlightedIndex].value);
          setIsOpen(false);
          setSearch("");
        } else if (showCustomOption) {
          onChange(customValue);
          setIsOpen(false);
          setSearch("");
        }
        break;
      case "Escape":
        e.preventDefault();
        setIsOpen(false);
        setSearch("");
        break;
    }
  };

  const handleSelect = (optionValue: string) => {
    onChange(optionValue);
    setIsOpen(false);
    setSearch("");
  };

  return (
    <div ref={containerRef} className={`searchable-select ${className}`}>
      <div
        className={`searchable-select-trigger ${isOpen ? "open" : ""}`}
        onClick={() => {
          setIsOpen(!isOpen);
          if (!isOpen) {
            setTimeout(() => inputRef.current?.focus(), 0);
          }
        }}
        onKeyDown={handleKeyDown}
        tabIndex={0}
      >
        <span className="searchable-select-value">
          {selectedOption ? selectedOption.label : value ? value : placeholder}
        </span>
        <ChevronDown className="searchable-select-arrow" size={12} strokeWidth={2} />
      </div>

      {isOpen && (
        <div className="searchable-select-dropdown">
          <div className="searchable-select-search">
            <Search size={14} strokeWidth={2} />
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search models..."
              autoFocus
            />
          </div>
          <div ref={listRef} className="searchable-select-options">
            {filteredOptions.length === 0 ? (
              showCustomOption ? (
                <div
                  key={`__custom__:${customValue}`}
                  data-index={0}
                  className={`searchable-select-option ${customValue === value ? "selected" : ""} ${highlightedIndex === 0 ? "highlighted" : ""}`}
                  onClick={() => handleSelect(customValue)}
                  onMouseEnter={() => setHighlightedIndex(0)}
                >
                  <span className="searchable-select-option-label">{customValue}</span>
                  <span className="searchable-select-option-desc">Use custom model ID</span>
                </div>
              ) : (
                <div className="searchable-select-no-results">No models found</div>
              )
            ) : (
              filteredOptions.map((opt, index) => (
                <div
                  key={opt.value}
                  data-index={index}
                  className={`searchable-select-option ${opt.value === value ? "selected" : ""} ${index === highlightedIndex ? "highlighted" : ""}`}
                  onClick={() => handleSelect(opt.value)}
                  onMouseEnter={() => setHighlightedIndex(index)}
                >
                  <span className="searchable-select-option-label">{opt.label}</span>
                  {opt.description && (
                    <span className="searchable-select-option-desc">{opt.description}</span>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Sidebar navigation items configuration
const I = { size: 18, strokeWidth: 1.5 } as const;
const sidebarItems: Array<{
  tab: SettingsTab;
  label: string;
  icon: ReactNode;
  macOnly?: boolean;
  group: string;
}> = [
  { tab: "customize", label: "Customize", group: "Customize", icon: <Sparkles {...I} /> },
  { tab: "appearance", label: "Appearance", group: "General", icon: <Sun {...I} /> },
  { tab: "personality", label: "Personality", group: "General", icon: <User {...I} /> },
  { tab: "missioncontrol", label: "Mission Control", group: "General", icon: <Users {...I} /> },
  { tab: "digitaltwins", label: "Digital Twins", group: "General", icon: <User {...I} /> },
  { tab: "tray", label: "Menu Bar", group: "General", icon: <PanelTop {...I} />, macOnly: true },
  { tab: "voice", label: "Voice Mode", group: "General", icon: <Mic {...I} /> },
  { tab: "llm", label: "AI Model", group: "AI & Models", icon: <Layers {...I} /> },
  { tab: "search", label: "Web Search", group: "AI & Models", icon: <Search {...I} /> },
  { tab: "whatsapp", label: "WhatsApp", group: "Communication", icon: <MessageCircle {...I} /> },
  { tab: "telegram", label: "Telegram", group: "Communication", icon: <Send {...I} /> },
  { tab: "slack", label: "Slack", group: "Communication", icon: <Hash {...I} /> },
  { tab: "teams", label: "Teams", group: "Communication", icon: <UsersRound {...I} /> },
  { tab: "x", label: "X (Twitter)", group: "Communication", icon: <AtSign {...I} /> },
  {
    tab: "morechannels",
    label: "More Channels",
    group: "Communication",
    icon: <MoreHorizontal {...I} />,
  },
  { tab: "integrations", label: "Integrations", group: "Integrations", icon: <Settings2 {...I} /> },
  { tab: "guardrails", label: "Safety Limits", group: "AI & Models", icon: <Shield {...I} /> },
  { tab: "memory", label: "Memory", group: "AI & Models", icon: <Brain {...I} /> },
  { tab: "queue", label: "Task Queue", group: "Automation", icon: <ListOrdered {...I} /> },
  { tab: "git", label: "Git", group: "Integrations", icon: <GitBranch {...I} /> },
  { tab: "skills", label: "Custom Skills", group: "Skills & Tools", icon: <Wrench {...I} /> },
  { tab: "skillhub", label: "Skill Store", group: "Skills & Tools", icon: <Store {...I} /> },
  { tab: "scheduled", label: "Scheduled Tasks", group: "Automation", icon: <Clock {...I} /> },
  { tab: "connectors", label: "Connectors", group: "Integrations", icon: <LayoutGrid {...I} /> },
  { tab: "infrastructure", label: "Infrastructure", group: "Integrations", icon: <Zap {...I} /> },
  { tab: "mcp", label: "Connected Tools", group: "Skills & Tools", icon: <Monitor {...I} /> },
  {
    tab: "tools",
    label: "Built-in Tools",
    group: "Skills & Tools",
    icon: <MessageSquare {...I} />,
  },
  { tab: "hooks", label: "Webhooks", group: "Automation", icon: <Link {...I} /> },
  { tab: "triggers", label: "Event Triggers", group: "Automation", icon: <Zap {...I} /> },
  { tab: "briefing", label: "Daily Briefing", group: "Automation", icon: <Sun {...I} /> },
  { tab: "controlplane", label: "Remote Access", group: "Advanced", icon: <Monitor {...I} /> },
  { tab: "webaccess", label: "Web Access", group: "Advanced", icon: <Monitor {...I} /> },
  { tab: "nodes", label: "Mobile Companions", group: "Advanced", icon: <Smartphone {...I} /> },
  { tab: "extensions", label: "Extensions", group: "Advanced", icon: <Puzzle {...I} /> },
  { tab: "insights", label: "Usage Insights", group: "Advanced", icon: <BarChart3 {...I} /> },
  { tab: "suggestions", label: "Suggestions", group: "Advanced", icon: <Lightbulb {...I} /> },
  { tab: "policies", label: "Admin Policies", group: "Advanced", icon: <ShieldCheck {...I} /> },
  { tab: "updates", label: "Updates", group: "Advanced", icon: <RefreshCw {...I} /> },
];

// Secondary channel configuration for "More Channels" tab
const S = { size: 16, strokeWidth: 1.5 } as const;
const secondaryChannelItems: Array<{ key: SecondaryChannel; label: string; icon: ReactNode }> = [
  { key: "discord", label: "Discord", icon: <MessageSquare {...S} /> },
  { key: "imessage", label: "iMessage", icon: <MessageCircle {...S} /> },
  { key: "signal", label: "Signal", icon: <ShieldCheckIcon {...S} /> },
  { key: "line", label: "LINE", icon: <MessagesSquare {...S} /> },
  { key: "email", label: "Email", icon: <Mail {...S} /> },
  { key: "googlechat", label: "Google Chat", icon: <MessagesSquare {...S} /> },
  { key: "mattermost", label: "Mattermost", icon: <Square {...S} /> },
  { key: "matrix", label: "Matrix", icon: <LayoutGrid {...S} /> },
  { key: "twitch", label: "Twitch", icon: <Tv {...S} /> },
  { key: "bluebubbles", label: "BlueBubbles", icon: <Smile {...S} /> },
];

// App integrations configuration for "Integrations" tab
const integrationItems: Array<{ key: IntegrationChannel; label: string; icon: ReactNode }> = [
  { key: "notion", label: "Notion", icon: <FileText {...S} /> },
  { key: "sharepoint", label: "SharePoint", icon: <FileText {...S} /> },
  { key: "onedrive", label: "OneDrive", icon: <Cloud {...S} /> },
  { key: "googleworkspace", label: "Google Workspace", icon: <Star {...S} /> },
  { key: "box", label: "Box", icon: <Box {...S} /> },
  { key: "dropbox", label: "Dropbox", icon: <Droplets {...S} /> },
];

const LLM_PROVIDER_ICONS: Record<string, ReactNode> = {
  anthropic: <Layers {...S} />,
  openai: <CircleDot {...S} />,
  azure: <Cloud {...S} />,
  gemini: <Star {...S} />,
  openrouter: <Globe {...S} />,
  ollama: <Box {...S} />,
  groq: <Crosshair {...S} />,
  xai: <AtSign {...S} />,
  kimi: <Sparkles {...S} />,
  bedrock: <Hexagon {...S} />,
  pi: <Pi {...S} />,
};

const getLLMProviderIcon = (providerType: string, customEntry?: { compatibility?: string }) => {
  if (LLM_PROVIDER_ICONS[providerType]) {
    return LLM_PROVIDER_ICONS[providerType];
  }
  if (customEntry?.compatibility === "anthropic") {
    return LLM_PROVIDER_ICONS.anthropic;
  }
  if (customEntry?.compatibility === "openai") {
    return LLM_PROVIDER_ICONS.openai;
  }
  return <Plus {...S} />;
};

export function Settings({
  onBack,
  onSettingsChanged,
  themeMode,
  visualTheme,
  accentColor,
  onThemeChange,
  onVisualThemeChange,
  onAccentChange,
  uiDensity,
  onUiDensityChange,
  initialTab = "appearance",
  onShowOnboarding,
  onboardingCompletedAt,
  workspaceId,
  onCreateTask,
}: SettingsProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [activeSecondaryChannel, setActiveSecondaryChannel] = useState<SecondaryChannel>("discord");
  const [activeIntegration, setActiveIntegration] = useState<IntegrationChannel>("notion");
  const [sidebarSearch, setSidebarSearch] = useState("");
  const [settings, setSettings] = useState<LLMSettingsData>({
    providerType: "anthropic",
    modelKey: "sonnet-3-5",
  });
  const [models, setModels] = useState<ModelOption[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);

  // Form state for credentials (not persisted directly)
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [awsRegion, setAwsRegion] = useState("us-east-1");
  const [awsAccessKeyId, setAwsAccessKeyId] = useState("");
  const [awsSecretAccessKey, setAwsSecretAccessKey] = useState("");
  const [awsProfile, setAwsProfile] = useState("");
  const [useDefaultCredentials, setUseDefaultCredentials] = useState(true);

  // Ollama state
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState("http://localhost:11434");
  const [ollamaModel, setOllamaModel] = useState("llama3.2");
  const [ollamaApiKey, setOllamaApiKey] = useState("");
  const [ollamaModels, setOllamaModels] = useState<Array<{ name: string; size: number }>>([]);
  const [loadingOllamaModels, setLoadingOllamaModels] = useState(false);

  // Gemini state
  const [geminiApiKey, setGeminiApiKey] = useState("");
  const [geminiModel, setGeminiModel] = useState("gemini-2.0-flash");
  const [geminiModels, setGeminiModels] = useState<
    Array<{ name: string; displayName: string; description: string }>
  >([]);
  const [loadingGeminiModels, setLoadingGeminiModels] = useState(false);

  // OpenRouter state
  const [openrouterApiKey, setOpenrouterApiKey] = useState("");
  const [openrouterBaseUrl, setOpenrouterBaseUrl] = useState("");
  const [openrouterModel, setOpenrouterModel] = useState("anthropic/claude-3.5-sonnet");
  const [openrouterModels, setOpenrouterModels] = useState<
    Array<{ id: string; name: string; context_length: number }>
  >([]);
  const [loadingOpenRouterModels, setLoadingOpenRouterModels] = useState(false);

  // OpenAI state
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [openaiModel, setOpenaiModel] = useState("gpt-4o-mini");
  const [openaiModels, setOpenaiModels] = useState<
    Array<{ id: string; name: string; description: string }>
  >([]);
  const [loadingOpenAIModels, setLoadingOpenAIModels] = useState(false);
  const [openaiAuthMethod, setOpenaiAuthMethod] = useState<"api_key" | "oauth">("api_key");
  const [openaiOAuthConnected, setOpenaiOAuthConnected] = useState(false);
  const [openaiOAuthLoading, setOpenaiOAuthLoading] = useState(false);

  // Azure OpenAI state
  const [azureApiKey, setAzureApiKey] = useState("");
  const [azureEndpoint, setAzureEndpoint] = useState("");
  const [azureDeployment, setAzureDeployment] = useState("");
  const [azureDeploymentsText, setAzureDeploymentsText] = useState("");
  const [azureApiVersion, setAzureApiVersion] = useState("2024-02-15-preview");

  // Groq state
  const [groqApiKey, setGroqApiKey] = useState("");
  const [groqBaseUrl, setGroqBaseUrl] = useState("");
  const [groqModel, setGroqModel] = useState("llama-3.1-8b-instant");
  const [groqModels, setGroqModels] = useState<Array<{ id: string; name: string }>>([]);
  const [loadingGroqModels, setLoadingGroqModels] = useState(false);

  // xAI state
  const [xaiApiKey, setXaiApiKey] = useState("");
  const [xaiBaseUrl, setXaiBaseUrl] = useState("");
  const [xaiModel, setXaiModel] = useState("grok-4-fast-non-reasoning");
  const [xaiModels, setXaiModels] = useState<Array<{ id: string; name: string }>>([]);
  const [loadingXaiModels, setLoadingXaiModels] = useState(false);

  // Kimi state
  const [kimiApiKey, setKimiApiKey] = useState("");
  const [kimiBaseUrl, setKimiBaseUrl] = useState("");
  const [kimiModel, setKimiModel] = useState("kimi-k2.5");
  const [kimiModels, setKimiModels] = useState<Array<{ id: string; name: string }>>([]);
  const [loadingKimiModels, setLoadingKimiModels] = useState(false);

  // Pi state
  const [piProvider, setPiProvider] = useState("anthropic");
  const [piApiKey, setPiApiKey] = useState("");
  const [piModel, setPiModel] = useState("");
  const [piModels, setPiModels] = useState<
    Array<{ id: string; name: string; description: string }>
  >([]);
  const [piProviders, setPiProviders] = useState<Array<{ id: string; name: string }>>([]);
  const [loadingPiModels, setLoadingPiModels] = useState(false);

  // OpenAI-compatible state
  const [openaiCompatBaseUrl, setOpenaiCompatBaseUrl] = useState("");
  const [openaiCompatApiKey, setOpenaiCompatApiKey] = useState("");
  const [openaiCompatModel, setOpenaiCompatModel] = useState("");
  const [openaiCompatModels, setOpenaiCompatModels] = useState<
    Array<{ key: string; displayName: string; description: string }>
  >([]);
  const [loadingOpenAICompatModels, setLoadingOpenAICompatModels] = useState(false);

  // Custom provider state
  const [customProviders, setCustomProviders] = useState<Record<string, CustomProviderConfig>>({});

  // Bedrock state
  const [bedrockModel, setBedrockModel] = useState("");
  const [bedrockModels, setBedrockModels] = useState<
    Array<{ id: string; name: string; description: string }>
  >([]);
  const [loadingBedrockModels, setLoadingBedrockModels] = useState(false);

  useEffect(() => {
    loadConfigStatus();
  }, []);

  const resolveCustomProviderId = (providerType: LLMProviderType) =>
    providerType === "kimi-coding" ? "kimi-code" : providerType;

  const updateCustomProvider = (
    providerType: LLMProviderType,
    updates: Partial<CustomProviderConfig>,
  ) => {
    const resolvedType = resolveCustomProviderId(providerType);
    setCustomProviders((prev) => ({
      ...prev,
      [resolvedType]: {
        ...(prev[resolvedType] || {}),
        ...updates,
      },
    }));
  };

  const sanitizeCustomProviders = (providers: Record<string, CustomProviderConfig>) => {
    const sanitized: Record<string, CustomProviderConfig> = {};
    Object.entries(providers).forEach(([key, value]) => {
      const apiKey = value.apiKey?.trim();
      const model = value.model?.trim();
      const baseUrl = value.baseUrl?.trim();
      if (apiKey || model || baseUrl) {
        sanitized[key] = {
          ...(apiKey ? { apiKey } : {}),
          ...(model ? { model } : {}),
          ...(baseUrl ? { baseUrl } : {}),
        };
      }
    });
    return Object.keys(sanitized).length > 0 ? sanitized : undefined;
  };

  const parseAzureDeployments = (value: string): string[] => {
    const seen = new Set<string>();
    return value
      .split(/[\n,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .filter((entry) => {
        if (seen.has(entry)) {
          return false;
        }
        seen.add(entry);
        return true;
      });
  };

  const buildAzureSettings = () => {
    const deployments = parseAzureDeployments(azureDeploymentsText);
    let deployment = azureDeployment.trim();
    if (deployment) {
      if (!deployments.includes(deployment)) {
        deployments.unshift(deployment);
      }
    } else if (deployments.length > 0) {
      deployment = deployments[0];
    }

    return {
      deployment: deployment || undefined,
      deployments: deployments.length > 0 ? deployments : undefined,
    };
  };

  useEffect(() => {
    if (!azureDeployment) {
      const deployments = parseAzureDeployments(azureDeploymentsText);
      if (deployments[0]) {
        setAzureDeployment(deployments[0]);
      }
    }
  }, [azureDeploymentsText, azureDeployment]);

  const loadConfigStatus = async () => {
    try {
      setLoading(true);
      // Load config status which includes settings, providers, and models
      const configStatus = await window.electronAPI.getLLMConfigStatus();

      // Set providers
      setProviders(configStatus.providers || []);
      setModels(configStatus.models || []);

      // Load full settings separately for bedrock config
      const loadedSettings = await window.electronAPI.getLLMSettings();
      setSettings(loadedSettings);
      if (loadedSettings.customProviders) {
        const normalized = { ...loadedSettings.customProviders };
        if (normalized["kimi-coding"] && !normalized["kimi-code"]) {
          normalized["kimi-code"] = normalized["kimi-coding"];
        }
        if (normalized["kimi-coding"]) {
          delete normalized["kimi-coding"];
        }
        setCustomProviders(normalized);
      } else {
        setCustomProviders({});
      }

      // Set form state from loaded settings
      if (loadedSettings.bedrock?.region) {
        setAwsRegion(loadedSettings.bedrock.region);
      }
      if (loadedSettings.bedrock?.profile) {
        setAwsProfile(loadedSettings.bedrock.profile);
      }
      setUseDefaultCredentials(loadedSettings.bedrock?.useDefaultCredentials ?? true);

      // Set Anthropic form state
      if (loadedSettings.anthropic?.apiKey) {
        setAnthropicApiKey(loadedSettings.anthropic.apiKey);
      }

      // Set Ollama form state
      if (loadedSettings.ollama?.baseUrl) {
        setOllamaBaseUrl(loadedSettings.ollama.baseUrl);
      }
      if (loadedSettings.ollama?.model) {
        setOllamaModel(loadedSettings.ollama.model);
      }
      if (loadedSettings.ollama?.apiKey) {
        setOllamaApiKey(loadedSettings.ollama.apiKey);
      }

      // Set Gemini form state
      if (loadedSettings.gemini?.apiKey) {
        setGeminiApiKey(loadedSettings.gemini.apiKey);
      }
      if (loadedSettings.gemini?.model) {
        setGeminiModel(loadedSettings.gemini.model);
      }

      // Set OpenRouter form state
      if (loadedSettings.openrouter?.apiKey) {
        setOpenrouterApiKey(loadedSettings.openrouter.apiKey);
      }
      if (loadedSettings.openrouter?.baseUrl) {
        setOpenrouterBaseUrl(loadedSettings.openrouter.baseUrl);
      }
      if (loadedSettings.openrouter?.model) {
        setOpenrouterModel(loadedSettings.openrouter.model);
      }

      // Set OpenAI form state
      if (loadedSettings.openai?.apiKey) {
        setOpenaiApiKey(loadedSettings.openai.apiKey);
      }
      if (loadedSettings.openai?.model) {
        setOpenaiModel(loadedSettings.openai.model);
      }
      // Set OpenAI auth method and OAuth status
      if (loadedSettings.openai?.authMethod) {
        setOpenaiAuthMethod(loadedSettings.openai.authMethod);
        // If authMethod is 'oauth', check if tokens are available
        if (loadedSettings.openai.authMethod === "oauth") {
          if (loadedSettings.openai.accessToken || loadedSettings.openai.refreshToken) {
            // Tokens available - fully connected
            setOpenaiOAuthConnected(true);
          } else {
            // Auth method is OAuth but tokens missing (decryption failed or expired)
            // Keep authMethod as oauth so user knows they configured it, but not connected
            setOpenaiOAuthConnected(false);
            console.log(
              "[Settings] OpenAI OAuth configured but tokens unavailable - re-authentication required",
            );
          }
        }
      } else if (loadedSettings.openai?.accessToken) {
        // Legacy: accessToken present but no authMethod set
        setOpenaiOAuthConnected(true);
        setOpenaiAuthMethod("oauth");
      }

      // Set Azure OpenAI form state
      if (loadedSettings.azure?.apiKey) {
        setAzureApiKey(loadedSettings.azure.apiKey);
      }
      if (loadedSettings.azure?.endpoint) {
        setAzureEndpoint(loadedSettings.azure.endpoint);
      }
      {
        const loadedDeployments =
          loadedSettings.azure?.deployments && loadedSettings.azure.deployments.length > 0
            ? loadedSettings.azure.deployments
            : loadedSettings.azure?.deployment
              ? [loadedSettings.azure.deployment]
              : [];
        if (loadedDeployments.length > 0) {
          setAzureDeploymentsText(loadedDeployments.join("\n"));
        }
        const selectedDeployment = loadedSettings.azure?.deployment || loadedDeployments[0];
        if (selectedDeployment) {
          setAzureDeployment(selectedDeployment);
        }
      }
      if (loadedSettings.azure?.apiVersion) {
        setAzureApiVersion(loadedSettings.azure.apiVersion);
      }

      // Set Groq form state
      if (loadedSettings.groq?.apiKey) {
        setGroqApiKey(loadedSettings.groq.apiKey);
      }
      if (loadedSettings.groq?.baseUrl) {
        setGroqBaseUrl(loadedSettings.groq.baseUrl);
      }
      if (loadedSettings.groq?.model) {
        setGroqModel(loadedSettings.groq.model);
      }

      // Set xAI form state
      if (loadedSettings.xai?.apiKey) {
        setXaiApiKey(loadedSettings.xai.apiKey);
      }
      if (loadedSettings.xai?.baseUrl) {
        setXaiBaseUrl(loadedSettings.xai.baseUrl);
      }
      if (loadedSettings.xai?.model) {
        setXaiModel(loadedSettings.xai.model);
      }

      // Set Kimi form state
      if (loadedSettings.kimi?.apiKey) {
        setKimiApiKey(loadedSettings.kimi.apiKey);
      }
      if (loadedSettings.kimi?.baseUrl) {
        setKimiBaseUrl(loadedSettings.kimi.baseUrl);
      }
      if (loadedSettings.kimi?.model) {
        setKimiModel(loadedSettings.kimi.model);
      }

      // Set Pi form state
      if (loadedSettings.pi?.provider) {
        setPiProvider(loadedSettings.pi.provider);
      }
      if (loadedSettings.pi?.apiKey) {
        setPiApiKey(loadedSettings.pi.apiKey);
      }
      if (loadedSettings.pi?.model) {
        setPiModel(loadedSettings.pi.model);
      }

      // Set OpenAI-compatible form state
      if (loadedSettings.openaiCompatible?.baseUrl) {
        setOpenaiCompatBaseUrl(loadedSettings.openaiCompatible.baseUrl);
      }
      if (loadedSettings.openaiCompatible?.apiKey) {
        setOpenaiCompatApiKey(loadedSettings.openaiCompatible.apiKey);
      }
      if (loadedSettings.openaiCompatible?.model) {
        setOpenaiCompatModel(loadedSettings.openaiCompatible.model);
      }
      if (loadedSettings.cachedOpenAICompatibleModels) {
        setOpenaiCompatModels(loadedSettings.cachedOpenAICompatibleModels);
      }

      // Set Bedrock form state (access key and secret key are set earlier)
      if (loadedSettings.bedrock?.accessKeyId) {
        setAwsAccessKeyId(loadedSettings.bedrock.accessKeyId);
      }
      if (loadedSettings.bedrock?.secretAccessKey) {
        setAwsSecretAccessKey(loadedSettings.bedrock.secretAccessKey);
      }
      if (loadedSettings.bedrock?.model) {
        setBedrockModel(loadedSettings.bedrock.model);
      }

      // Populate dropdown arrays from cached models
      if (loadedSettings.cachedGeminiModels && loadedSettings.cachedGeminiModels.length > 0) {
        setGeminiModels(
          loadedSettings.cachedGeminiModels.map((m: any) => ({
            name: m.key,
            displayName: m.displayName,
            description: m.description,
          })),
        );
      }
      if (
        loadedSettings.cachedOpenRouterModels &&
        loadedSettings.cachedOpenRouterModels.length > 0
      ) {
        setOpenrouterModels(
          loadedSettings.cachedOpenRouterModels.map((m: any) => ({
            id: m.key,
            name: m.displayName,
            context_length: m.contextLength || 0,
          })),
        );
      }
      if (loadedSettings.cachedOpenAIModels && loadedSettings.cachedOpenAIModels.length > 0) {
        setOpenaiModels(
          loadedSettings.cachedOpenAIModels.map((m: any) => ({
            id: m.key,
            name: m.displayName,
            description: m.description || "",
          })),
        );
      }
      if (loadedSettings.cachedOllamaModels && loadedSettings.cachedOllamaModels.length > 0) {
        setOllamaModels(
          loadedSettings.cachedOllamaModels.map((m: any) => ({
            name: m.key,
            size: m.size || 0,
          })),
        );
      }
      if (loadedSettings.cachedBedrockModels && loadedSettings.cachedBedrockModels.length > 0) {
        setBedrockModels(
          loadedSettings.cachedBedrockModels.map((m: any) => ({
            id: m.key,
            name: m.displayName,
            description: m.description || "",
          })),
        );
      }
      if (loadedSettings.cachedPiModels && loadedSettings.cachedPiModels.length > 0) {
        setPiModels(
          loadedSettings.cachedPiModels.map((m: any) => ({
            id: m.key,
            name: m.displayName,
            description: m.description || "",
          })),
        );
      }
    } catch (error) {
      console.error("Failed to load settings:", error);
    } finally {
      setLoading(false);
    }
  };

  const loadOllamaModels = async (baseUrl?: string) => {
    try {
      setLoadingOllamaModels(true);
      const models = await window.electronAPI.getOllamaModels(baseUrl || ollamaBaseUrl);
      console.log(`[Settings] Loaded ${models?.length || 0} Ollama models`, models);
      setOllamaModels(models || []);
      // If we got models and current model isn't in the list, select the first one
      if (models && models.length > 0 && !models.some((m) => m.name === ollamaModel)) {
        setOllamaModel(models[0].name);
      }
      // Notify main page that models were refreshed (they're now cached)
      onSettingsChanged?.();
    } catch (error) {
      console.error("Failed to load Ollama models:", error);
      setOllamaModels([]);
    } finally {
      setLoadingOllamaModels(false);
    }
  };

  const loadGeminiModels = async (apiKey?: string) => {
    try {
      setLoadingGeminiModels(true);
      const models = await window.electronAPI.getGeminiModels(apiKey || geminiApiKey);
      setGeminiModels(models || []);
      // If we got models and current model isn't in the list, select the first one
      if (models && models.length > 0 && !models.some((m) => m.name === geminiModel)) {
        setGeminiModel(models[0].name);
      }
      // Notify main page that models were refreshed (they're now cached)
      onSettingsChanged?.();
    } catch (error) {
      console.error("Failed to load Gemini models:", error);
      setGeminiModels([]);
    } finally {
      setLoadingGeminiModels(false);
    }
  };

  const loadOpenRouterModels = async (apiKey?: string) => {
    try {
      setLoadingOpenRouterModels(true);
      const models = await window.electronAPI.getOpenRouterModels(
        apiKey || openrouterApiKey,
        openrouterBaseUrl || undefined,
      );
      setOpenrouterModels(models || []);
      // If we got models and current model isn't in the list, select the first one
      if (models && models.length > 0 && !models.some((m) => m.id === openrouterModel)) {
        setOpenrouterModel(models[0].id);
      }
      // Notify main page that models were refreshed (they're now cached)
      onSettingsChanged?.();
    } catch (error) {
      console.error("Failed to load OpenRouter models:", error);
      setOpenrouterModels([]);
    } finally {
      setLoadingOpenRouterModels(false);
    }
  };

  const loadOpenAIModels = async (apiKey?: string) => {
    try {
      setLoadingOpenAIModels(true);
      const models = await window.electronAPI.getOpenAIModels(apiKey || openaiApiKey);
      setOpenaiModels(models || []);
      // If we got models and no model is selected yet, select the first one
      // (Don't override custom model IDs that may not be in the list.)
      if (models && models.length > 0 && !openaiModel) {
        setOpenaiModel(models[0].id);
      }
      // Notify main page that models were refreshed (they're now cached)
      onSettingsChanged?.();
    } catch (error) {
      console.error("Failed to load OpenAI models:", error);
      setOpenaiModels([]);
    } finally {
      setLoadingOpenAIModels(false);
    }
  };

  const loadGroqModels = async (apiKey?: string) => {
    try {
      setLoadingGroqModels(true);
      const models = await window.electronAPI.getGroqModels(
        apiKey || groqApiKey,
        groqBaseUrl || undefined,
      );
      setGroqModels(models || []);
      if (models && models.length > 0 && !models.some((m) => m.id === groqModel)) {
        setGroqModel(models[0].id);
      }
      onSettingsChanged?.();
    } catch (error) {
      console.error("Failed to load Groq models:", error);
      setGroqModels([]);
    } finally {
      setLoadingGroqModels(false);
    }
  };

  const loadXAIModels = async (apiKey?: string) => {
    try {
      setLoadingXaiModels(true);
      const models = await window.electronAPI.getXAIModels(
        apiKey || xaiApiKey,
        xaiBaseUrl || undefined,
      );
      setXaiModels(models || []);
      if (models && models.length > 0 && !models.some((m) => m.id === xaiModel)) {
        setXaiModel(models[0].id);
      }
      onSettingsChanged?.();
    } catch (error) {
      console.error("Failed to load xAI models:", error);
      setXaiModels([]);
    } finally {
      setLoadingXaiModels(false);
    }
  };

  const loadKimiModels = async (apiKey?: string) => {
    try {
      setLoadingKimiModels(true);
      const models = await window.electronAPI.getKimiModels(
        apiKey || kimiApiKey,
        kimiBaseUrl || undefined,
      );
      setKimiModels(models || []);
      if (models && models.length > 0 && !models.some((m) => m.id === kimiModel)) {
        setKimiModel(models[0].id);
      }
      onSettingsChanged?.();
    } catch (error) {
      console.error("Failed to load Kimi models:", error);
      setKimiModels([]);
    } finally {
      setLoadingKimiModels(false);
    }
  };

  const loadPiModels = async (provider?: string) => {
    try {
      setLoadingPiModels(true);
      const resolvedProvider = provider || piProvider;
      const models = await window.electronAPI.getPiModels(resolvedProvider);
      setPiModels(models || []);
      if (models && models.length > 0 && !models.some((m) => m.id === piModel)) {
        setPiModel(models[0].id);
      }
      onSettingsChanged?.();
    } catch (error) {
      console.error("Failed to load Pi models:", error);
      setPiModels([]);
    } finally {
      setLoadingPiModels(false);
    }
  };

  const loadPiProviders = async () => {
    try {
      const providers = await window.electronAPI.getPiProviders();
      setPiProviders(providers || []);
    } catch (error) {
      console.error("Failed to load Pi providers:", error);
    }
  };

  const loadOpenAICompatibleModels = async (baseUrl?: string, apiKey?: string) => {
    try {
      setLoadingOpenAICompatModels(true);
      const resolvedBaseUrl = baseUrl || openaiCompatBaseUrl;
      if (!resolvedBaseUrl) return;
      const models = await window.electronAPI.getOpenAICompatibleModels(
        resolvedBaseUrl,
        apiKey || openaiCompatApiKey || undefined,
      );
      setOpenaiCompatModels(models || []);
      if (models && models.length > 0 && !models.some((m) => m.key === openaiCompatModel)) {
        setOpenaiCompatModel(models[0].key);
      }
      onSettingsChanged?.();
    } catch (error) {
      console.error("Failed to load OpenAI-compatible models:", error);
      setOpenaiCompatModels([]);
    } finally {
      setLoadingOpenAICompatModels(false);
    }
  };

  const handleProviderSelect = (providerType: LLMProviderType) => {
    setSettings((prev) => ({ ...prev, providerType }));

    const resolvedCustomType = resolveCustomProviderId(providerType);
    const customEntry = CUSTOM_PROVIDER_MAP.get(resolvedCustomType);
    if (customEntry) {
      setCustomProviders((prev) => {
        const existing = prev[resolvedCustomType] || {};
        const updated: CustomProviderConfig = { ...existing };
        if (!updated.model && customEntry.defaultModel) {
          updated.model = customEntry.defaultModel;
        }
        if (!updated.baseUrl && customEntry.baseUrl) {
          updated.baseUrl = customEntry.baseUrl;
        }
        return { ...prev, [resolvedCustomType]: updated };
      });
    }

    if (providerType === "ollama") {
      loadOllamaModels();
    } else if (providerType === "gemini") {
      loadGeminiModels();
    } else if (providerType === "openrouter") {
      loadOpenRouterModels();
    } else if (providerType === "openai") {
      loadOpenAIModels();
    } else if (providerType === "groq") {
      loadGroqModels();
    } else if (providerType === "xai") {
      loadXAIModels();
    } else if (providerType === "kimi") {
      loadKimiModels();
    } else if (providerType === "pi") {
      loadPiProviders();
      loadPiModels();
    } else if (providerType === "openai-compatible") {
      if (openaiCompatBaseUrl) {
        loadOpenAICompatibleModels();
      }
    }
  };

  const handleOpenAIOAuthLogin = async () => {
    try {
      setOpenaiOAuthLoading(true);
      setTestResult(null);
      const result = await window.electronAPI.openaiOAuthStart();
      if (result.success) {
        setOpenaiOAuthConnected(true);
        setOpenaiAuthMethod("oauth");
        setOpenaiApiKey(""); // Clear API key when using OAuth
        onSettingsChanged?.();
        // Load models after OAuth success
        loadOpenAIModels();
      } else {
        setTestResult({ success: false, error: result.error || "OAuth failed" });
      }
    } catch (error: any) {
      console.error("OpenAI OAuth error:", error);
      setTestResult({ success: false, error: error.message || "OAuth failed" });
    } finally {
      setOpenaiOAuthLoading(false);
    }
  };

  const handleOpenAIOAuthLogout = async () => {
    try {
      setOpenaiOAuthLoading(true);
      await window.electronAPI.openaiOAuthLogout();
      setOpenaiOAuthConnected(false);
      setOpenaiAuthMethod("api_key");
      onSettingsChanged?.();
    } catch (error: any) {
      console.error("OpenAI OAuth logout error:", error);
    } finally {
      setOpenaiOAuthLoading(false);
    }
  };

  const loadBedrockModels = async () => {
    try {
      setLoadingBedrockModels(true);
      const config = useDefaultCredentials
        ? { region: awsRegion, profile: awsProfile || undefined }
        : {
            region: awsRegion,
            accessKeyId: awsAccessKeyId || undefined,
            secretAccessKey: awsSecretAccessKey || undefined,
          };
      const models = await window.electronAPI.getBedrockModels(config);
      const normalizedModels = models || [];

      // Keep the user's currently selected model even if it isn't in the refreshed list
      // (for example, custom inference profile ARN/ID). Only auto-select when empty.
      const currentModel = bedrockModel?.trim();
      let nextModels = normalizedModels;
      if (currentModel && !normalizedModels.some((m: any) => m.id === currentModel)) {
        nextModels = [
          {
            id: currentModel,
            name: currentModel,
            provider: "Custom",
            description: "Currently selected (custom)",
          },
          ...normalizedModels,
        ];
      }

      setBedrockModels(nextModels);
      if (!currentModel && nextModels.length > 0) {
        setBedrockModel(nextModels[0].id);
      }
      // Notify main page that models were refreshed (they're now cached)
      onSettingsChanged?.();
    } catch (error) {
      console.error("Failed to load Bedrock models:", error);
      setBedrockModels([]);
    } finally {
      setLoadingBedrockModels(false);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setTestResult(null);

      const sanitizedCustomProviders = sanitizeCustomProviders(customProviders) || {};
      const resolvedProviderTypeForSave = resolveCustomProviderId(
        settings.providerType as LLMProviderType,
      );
      const selectedCustomEntry = CUSTOM_PROVIDER_MAP.get(resolvedProviderTypeForSave);
      if (selectedCustomEntry) {
        const existing = sanitizedCustomProviders[resolvedProviderTypeForSave] || {};
        const withDefaults: CustomProviderConfig = { ...existing };
        if (!withDefaults.model && selectedCustomEntry.defaultModel) {
          withDefaults.model = selectedCustomEntry.defaultModel;
        }
        if (!withDefaults.baseUrl && selectedCustomEntry.baseUrl) {
          withDefaults.baseUrl = selectedCustomEntry.baseUrl;
        }
        sanitizedCustomProviders[resolvedProviderTypeForSave] = withDefaults;
      }
      const azureSettings = buildAzureSettings();

      // Always save settings for ALL providers to preserve API keys and model selections
      // when switching between providers
      const settingsToSave: LLMSettingsData = {
        ...settings,
        // Always include anthropic settings
        anthropic: {
          apiKey: anthropicApiKey || undefined,
        },
        // Always include bedrock settings
        bedrock: {
          region: awsRegion,
          useDefaultCredentials,
          model: bedrockModel || undefined,
          ...(useDefaultCredentials
            ? {
                profile: awsProfile || undefined,
              }
            : {
                accessKeyId: awsAccessKeyId || undefined,
                secretAccessKey: awsSecretAccessKey || undefined,
              }),
        },
        // Always include ollama settings
        ollama: {
          baseUrl: ollamaBaseUrl || undefined,
          model: ollamaModel || undefined,
          apiKey: ollamaApiKey || undefined,
        },
        // Always include gemini settings
        gemini: {
          apiKey: geminiApiKey || undefined,
          model: geminiModel || undefined,
        },
        // Always include openrouter settings
        openrouter: {
          apiKey: openrouterApiKey || undefined,
          model: openrouterModel || undefined,
          baseUrl: openrouterBaseUrl || undefined,
        },
        // Always include openai settings
        openai: {
          apiKey: openaiAuthMethod === "api_key" ? openaiApiKey || undefined : undefined,
          model: openaiModel || undefined,
          authMethod: openaiAuthMethod,
        },
        // Always include Azure OpenAI settings
        azure: {
          apiKey: azureApiKey || undefined,
          endpoint: azureEndpoint || undefined,
          deployment: azureSettings.deployment,
          deployments: azureSettings.deployments,
          apiVersion: azureApiVersion || undefined,
        },
        // Always include Groq settings
        groq: {
          apiKey: groqApiKey || undefined,
          model: groqModel || undefined,
          baseUrl: groqBaseUrl || undefined,
        },
        // Always include xAI settings
        xai: {
          apiKey: xaiApiKey || undefined,
          model: xaiModel || undefined,
          baseUrl: xaiBaseUrl || undefined,
        },
        // Always include Kimi settings
        kimi: {
          apiKey: kimiApiKey || undefined,
          model: kimiModel || undefined,
          baseUrl: kimiBaseUrl || undefined,
        },
        // Always include Pi settings
        pi: {
          provider: piProvider || undefined,
          apiKey: piApiKey || undefined,
          model: piModel || undefined,
        },
        // Always include OpenAI-compatible settings
        openaiCompatible: {
          baseUrl: openaiCompatBaseUrl || undefined,
          apiKey: openaiCompatApiKey || undefined,
          model: openaiCompatModel || undefined,
        },
        customProviders:
          Object.keys(sanitizedCustomProviders).length > 0 ? sanitizedCustomProviders : undefined,
      };

      await window.electronAPI.saveLLMSettings(settingsToSave);
      onSettingsChanged?.();
      onBack();
    } catch (error) {
      console.error("Failed to save settings:", error);
    } finally {
      setSaving(false);
    }
  };

  const handleTestConnection = async () => {
    try {
      setTesting(true);
      setTestResult(null);

      const sanitizedCustomProviders = sanitizeCustomProviders(customProviders) || {};
      const azureSettings = buildAzureSettings();

      const testConfig = {
        providerType: settings.providerType,
        modelKey: settings.modelKey,
        anthropic:
          settings.providerType === "anthropic"
            ? {
                apiKey: anthropicApiKey || undefined,
              }
            : undefined,
        bedrock:
          settings.providerType === "bedrock"
            ? {
                region: awsRegion,
                ...(useDefaultCredentials
                  ? {
                      profile: awsProfile || undefined,
                    }
                  : {
                      accessKeyId: awsAccessKeyId || undefined,
                      secretAccessKey: awsSecretAccessKey || undefined,
                    }),
              }
            : undefined,
        ollama:
          settings.providerType === "ollama"
            ? {
                baseUrl: ollamaBaseUrl || undefined,
                model: ollamaModel || undefined,
                apiKey: ollamaApiKey || undefined,
              }
            : undefined,
        gemini:
          settings.providerType === "gemini"
            ? {
                apiKey: geminiApiKey || undefined,
                model: geminiModel || undefined,
              }
            : undefined,
        openrouter:
          settings.providerType === "openrouter"
            ? {
                apiKey: openrouterApiKey || undefined,
                model: openrouterModel || undefined,
                baseUrl: openrouterBaseUrl || undefined,
              }
            : undefined,
        openai:
          settings.providerType === "openai"
            ? {
                apiKey: openaiAuthMethod === "api_key" ? openaiApiKey || undefined : undefined,
                model: openaiModel || undefined,
                authMethod: openaiAuthMethod,
                // OAuth tokens are handled by the backend from stored settings
              }
            : undefined,
        azure:
          settings.providerType === "azure"
            ? {
                apiKey: azureApiKey || undefined,
                endpoint: azureEndpoint || undefined,
                deployment: azureSettings.deployment,
                deployments: azureSettings.deployments,
                apiVersion: azureApiVersion || undefined,
              }
            : undefined,
        groq:
          settings.providerType === "groq"
            ? {
                apiKey: groqApiKey || undefined,
                model: groqModel || undefined,
                baseUrl: groqBaseUrl || undefined,
              }
            : undefined,
        xai:
          settings.providerType === "xai"
            ? {
                apiKey: xaiApiKey || undefined,
                model: xaiModel || undefined,
                baseUrl: xaiBaseUrl || undefined,
              }
            : undefined,
        kimi:
          settings.providerType === "kimi"
            ? {
                apiKey: kimiApiKey || undefined,
                model: kimiModel || undefined,
                baseUrl: kimiBaseUrl || undefined,
              }
            : undefined,
        pi:
          settings.providerType === "pi"
            ? {
                provider: piProvider || undefined,
                apiKey: piApiKey || undefined,
                model: piModel || undefined,
              }
            : undefined,
        openaiCompatible:
          settings.providerType === "openai-compatible"
            ? {
                baseUrl: openaiCompatBaseUrl || undefined,
                apiKey: openaiCompatApiKey || undefined,
                model: openaiCompatModel || undefined,
              }
            : undefined,
        customProviders:
          Object.keys(sanitizedCustomProviders).length > 0 ? sanitizedCustomProviders : undefined,
      };

      const result = await window.electronAPI.testLLMProvider(testConfig);
      setTestResult(result);
    } catch (error: any) {
      setTestResult({ success: false, error: error.message });
    } finally {
      setTesting(false);
    }
  };

  const resolvedProviderType = resolveCustomProviderId(settings.providerType as LLMProviderType);
  const selectedCustomProvider = CUSTOM_PROVIDER_MAP.get(resolvedProviderType);
  const selectedCustomConfig = selectedCustomProvider
    ? customProviders[resolvedProviderType] || {}
    : {};

  return (
    <div className="settings-page">
      <div className="settings-page-layout">
        <div className="settings-sidebar">
          <h1 className="settings-sidebar-title">Settings</h1>
          <button className="settings-back-btn" onClick={onBack}>
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            Back
          </button>
          <div className="settings-sidebar-search">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              type="text"
              placeholder="Search settings..."
              value={sidebarSearch}
              onChange={(e) => setSidebarSearch(e.target.value)}
            />
            {sidebarSearch && (
              <button
                className="settings-sidebar-search-clear"
                onClick={() => setSidebarSearch("")}
                aria-label="Clear search"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
          <div className="settings-nav-items">
            {
              sidebarItems
                .filter((item) => {
                  // Filter by macOnly if applicable
                  if (item.macOnly && !navigator.platform.toLowerCase().includes("mac")) {
                    return false;
                  }
                  // Adaptive complexity: three-tier visibility
                  // - focused: core settings only
                  // - full (default): standard settings, hides advanced developer tabs
                  // - power: everything visible
                  if (uiDensity === "focused") {
                    const focusedTabs: SettingsTab[] = [
                      "appearance",
                      "personality",
                      "missioncontrol",
                      "digitaltwins",
                      "voice",
                      "llm",
                      "search",
                      "skills",
                      "memory",
                      "guardrails",
                      "scheduled",
                      "telegram",
                      "slack",
                      "whatsapp",
                      "teams",
                      "x",
                      "morechannels",
                    ];
                    if (!focusedTabs.includes(item.tab)) return false;
                  } else if (uiDensity !== "power") {
                    // "full" mode: hide power-only tabs (developer/infra)
                    const powerOnlyTabs: SettingsTab[] = [
                      "nodes",
                      "extensions",
                      "controlplane",
                      "policies",
                    ];
                    if (powerOnlyTabs.includes(item.tab)) return false;
                  }
                  // Filter by search query
                  if (sidebarSearch) {
                    return item.label.toLowerCase().includes(sidebarSearch.toLowerCase());
                  }
                  return true;
                })
                .reduce<{ seenGroups: Set<string>; elements: ReactNode[] }>(
                  (acc, item) => {
                    if (!sidebarSearch && !acc.seenGroups.has(item.group)) {
                      acc.elements.push(
                        <div key={`group-${item.group}`} className="settings-nav-group-header">
                          {item.group}
                        </div>,
                      );
                      acc.seenGroups.add(item.group);
                    }
                    acc.elements.push(
                      <button
                        key={item.tab}
                        className={`settings-nav-item ${activeTab === item.tab ? "active" : ""}`}
                        data-tab={item.tab}
                        onClick={() => setActiveTab(item.tab)}
                      >
                        {item.icon}
                        {item.label}
                      </button>,
                    );
                    return acc;
                  },
                  { seenGroups: new Set<string>(), elements: [] },
                ).elements
            }
            {sidebarSearch &&
              sidebarItems.filter((item) => {
                if (item.macOnly && !navigator.platform.toLowerCase().includes("mac")) return false;
                return item.label.toLowerCase().includes(sidebarSearch.toLowerCase());
              }).length === 0 && (
                <div className="settings-nav-no-results">No matching settings</div>
              )}
          </div>
        </div>

        <div className="settings-content-card">
          <div className="settings-content">
            {activeTab === "appearance" ? (
              <AppearanceSettings
                themeMode={themeMode}
                visualTheme={visualTheme}
                accentColor={accentColor}
                onThemeChange={onThemeChange}
                onVisualThemeChange={onVisualThemeChange}
                onAccentChange={onAccentChange}
                uiDensity={uiDensity}
                onUiDensityChange={onUiDensityChange}
                onShowOnboarding={onShowOnboarding}
                onboardingCompletedAt={onboardingCompletedAt}
              />
            ) : activeTab === "personality" ? (
              <PersonalitySettings onSettingsChanged={onSettingsChanged} />
            ) : activeTab === "missioncontrol" ? (
              <MissionControlPanel />
            ) : activeTab === "digitaltwins" ? (
              <DigitalTwinsPanel />
            ) : activeTab === "tray" ? (
              <TraySettings />
            ) : activeTab === "voice" ? (
              <VoiceSettings />
            ) : activeTab === "telegram" ? (
              <TelegramSettings />
            ) : activeTab === "slack" ? (
              <SlackSettings />
            ) : activeTab === "whatsapp" ? (
              <WhatsAppSettings />
            ) : activeTab === "teams" ? (
              <TeamsSettings />
            ) : activeTab === "x" ? (
              <XSettings />
            ) : activeTab === "morechannels" ? (
              <div className="more-channels-panel">
                <div className="more-channels-header">
                  <h2>More Channels</h2>
                  <p className="settings-description">Configure additional messaging platforms</p>
                </div>
                <div className="more-channels-tabs">
                  {secondaryChannelItems.map((item) => (
                    <button
                      key={item.key}
                      className={`more-channels-tab ${activeSecondaryChannel === item.key ? "active" : ""}`}
                      onClick={() => setActiveSecondaryChannel(item.key)}
                    >
                      {item.icon}
                      <span>{item.label}</span>
                    </button>
                  ))}
                </div>
                <div className="more-channels-content">
                  {activeSecondaryChannel === "discord" && <DiscordSettings />}
                  {activeSecondaryChannel === "imessage" && <ImessageSettings />}
                  {activeSecondaryChannel === "signal" && <SignalSettings />}
                  {activeSecondaryChannel === "mattermost" && <MattermostSettings />}
                  {activeSecondaryChannel === "matrix" && <MatrixSettings />}
                  {activeSecondaryChannel === "twitch" && <TwitchSettings />}
                  {activeSecondaryChannel === "line" && <LineSettings />}
                  {activeSecondaryChannel === "bluebubbles" && <BlueBubblesSettings />}
                  {activeSecondaryChannel === "email" && <EmailSettings />}
                  {activeSecondaryChannel === "googlechat" && <GoogleChatSettings />}
                </div>
              </div>
            ) : activeTab === "integrations" ? (
              <div className="integrations-panel">
                <div className="integrations-header">
                  <h2>Integrations</h2>
                  <p className="settings-description">
                    Connect productivity and storage tools for the agent
                  </p>
                </div>
                <div className="integrations-tabs">
                  {integrationItems.map((item) => (
                    <button
                      key={item.key}
                      className={`integrations-tab ${activeIntegration === item.key ? "active" : ""}`}
                      onClick={() => setActiveIntegration(item.key)}
                    >
                      {item.icon}
                      <span>{item.label}</span>
                    </button>
                  ))}
                </div>
                <div className="integrations-content">
                  {activeIntegration === "notion" && <NotionSettings />}
                  {activeIntegration === "box" && <BoxSettings />}
                  {activeIntegration === "onedrive" && <OneDriveSettings />}
                  {activeIntegration === "googleworkspace" && <GoogleWorkspaceSettings />}
                  {activeIntegration === "dropbox" && <DropboxSettings />}
                  {activeIntegration === "sharepoint" && <SharePointSettings />}
                </div>
              </div>
            ) : activeTab === "search" ? (
              <SearchSettings />
            ) : activeTab === "updates" ? (
              <UpdateSettings />
            ) : activeTab === "guardrails" ? (
              <GuardrailSettings />
            ) : activeTab === "queue" ? (
              <QueueSettings />
            ) : activeTab === "skills" ? (
              <SkillsSettings />
            ) : activeTab === "skillhub" ? (
              <SkillHubBrowser />
            ) : activeTab === "scheduled" ? (
              <ScheduledTasksSettings />
            ) : activeTab === "connectors" ? (
              <ConnectorsSettings />
            ) : activeTab === "infrastructure" ? (
              <InfraSettings />
            ) : activeTab === "mcp" ? (
              <MCPSettings />
            ) : activeTab === "tools" ? (
              <BuiltinToolsSettings />
            ) : activeTab === "hooks" ? (
              <HooksSettings />
            ) : activeTab === "controlplane" ? (
              <ControlPlaneSettings />
            ) : activeTab === "nodes" ? (
              <NodesSettings />
            ) : activeTab === "extensions" ? (
              <ExtensionsSettings />
            ) : activeTab === "memory" ? (
              <MemoryHubSettings
                initialWorkspaceId={workspaceId}
                onSettingsChanged={onSettingsChanged}
              />
            ) : activeTab === "git" ? (
              <WorktreeSettings />
            ) : activeTab === "insights" ? (
              <UsageInsightsPanel workspaceId={workspaceId} />
            ) : activeTab === "suggestions" ? (
              <SuggestionsPanel workspaceId={workspaceId} onCreateTask={onCreateTask} />
            ) : activeTab === "customize" ? (
              <CustomizePanel
                onNavigateToConnectors={() => setActiveTab("connectors")}
                onNavigateToSkills={() => setActiveTab("skills")}
                onCreateTask={onCreateTask}
              />
            ) : activeTab === "policies" ? (
              <AdminPoliciesPanel />
            ) : activeTab === "triggers" ? (
              <EventTriggersPanel workspaceId={workspaceId} />
            ) : activeTab === "briefing" ? (
              <BriefingPanel workspaceId={workspaceId} />
            ) : activeTab === "webaccess" ? (
              <WebAccessSettingsPanel />
            ) : loading ? (
              <div className="settings-loading">Loading settings...</div>
            ) : (
              <div className="llm-provider-panel">
                <div className="llm-provider-header">
                  <h2>LLM Provider</h2>
                  <p className="settings-description">
                    Choose which service to use for AI model calls
                  </p>
                </div>
                <div className="llm-provider-tabs">
                  {providers.map((provider) => {
                    const providerType = provider.type as LLMProviderType;
                    const resolvedCustomType = resolveCustomProviderId(providerType);
                    const customEntry = CUSTOM_PROVIDER_MAP.get(resolvedCustomType);
                    const icon = getLLMProviderIcon(providerType, customEntry);

                    return (
                      <button
                        key={provider.type}
                        type="button"
                        className={`llm-provider-tab ${settings.providerType === provider.type ? "active" : ""} ${provider.configured ? "configured" : ""}`}
                        onClick={() => handleProviderSelect(providerType)}
                      >
                        {icon}
                        <span className="llm-provider-tab-label">{provider.name}</span>
                        {provider.configured && (
                          <span className="llm-provider-tab-status" title="Configured" />
                        )}
                      </button>
                    );
                  })}
                </div>
                <div className="llm-provider-content">
                  {settings.providerType === "anthropic" && (
                    <div className="settings-section">
                      <h3>Model</h3>
                      <select
                        className="settings-select"
                        value={settings.modelKey}
                        onChange={(e) => setSettings({ ...settings, modelKey: e.target.value })}
                      >
                        {models.map((model) => (
                          <option key={model.key} value={model.key}>
                            {model.displayName}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {settings.providerType === "anthropic" && (
                    <div className="settings-section">
                      <h3>Anthropic API Key</h3>
                      <p className="settings-description">
                        Enter your API key from{" "}
                        <a
                          href="https://console.anthropic.com/"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          console.anthropic.com
                        </a>
                      </p>
                      <input
                        type="password"
                        className="settings-input"
                        placeholder="sk-ant-..."
                        value={anthropicApiKey}
                        onChange={(e) => setAnthropicApiKey(e.target.value)}
                      />
                    </div>
                  )}

                  {settings.providerType === "gemini" && (
                    <>
                      <div className="settings-section">
                        <h3>Gemini API Key</h3>
                        <p className="settings-description">
                          Enter your API key from{" "}
                          <a
                            href="https://aistudio.google.com/apikey"
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Google AI Studio
                          </a>
                        </p>
                        <div className="settings-input-group">
                          <input
                            type="password"
                            className="settings-input"
                            placeholder="AIza..."
                            value={geminiApiKey}
                            onChange={(e) => setGeminiApiKey(e.target.value)}
                          />
                          <button
                            className="button-small button-secondary"
                            onClick={() => loadGeminiModels(geminiApiKey)}
                            disabled={loadingGeminiModels}
                          >
                            {loadingGeminiModels ? "Loading..." : "Refresh Models"}
                          </button>
                        </div>
                      </div>

                      <div className="settings-section">
                        <h3>Model</h3>
                        <p className="settings-description">
                          Select a Gemini model. Enter your API key and click "Refresh Models" to
                          load available models.
                        </p>
                        {geminiModels.length > 0 ? (
                          <SearchableSelect
                            options={geminiModels.map((model) => ({
                              value: model.name,
                              label: model.displayName,
                              description: model.description,
                            }))}
                            value={geminiModel}
                            onChange={setGeminiModel}
                            placeholder="Select a model..."
                          />
                        ) : (
                          <input
                            type="text"
                            className="settings-input"
                            placeholder="gemini-2.0-flash"
                            value={geminiModel}
                            onChange={(e) => setGeminiModel(e.target.value)}
                          />
                        )}
                      </div>
                    </>
                  )}

                  {settings.providerType === "openrouter" && (
                    <>
                      <div className="settings-section">
                        <h3>OpenRouter API Key</h3>
                        <p className="settings-description">
                          Enter your API key from{" "}
                          <a
                            href="https://openrouter.ai/keys"
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            OpenRouter
                          </a>
                        </p>
                        <div className="settings-input-group">
                          <input
                            type="password"
                            className="settings-input"
                            placeholder="sk-or-..."
                            value={openrouterApiKey}
                            onChange={(e) => setOpenrouterApiKey(e.target.value)}
                          />
                          <button
                            className="button-small button-secondary"
                            onClick={() => loadOpenRouterModels(openrouterApiKey)}
                            disabled={loadingOpenRouterModels}
                          >
                            {loadingOpenRouterModels ? "Loading..." : "Refresh Models"}
                          </button>
                        </div>
                      </div>

                      <div className="settings-section">
                        <h3>Base URL</h3>
                        <p className="settings-description">
                          Optional override for the OpenRouter API endpoint.
                        </p>
                        <input
                          type="text"
                          className="settings-input"
                          placeholder="https://openrouter.ai/api/v1"
                          value={openrouterBaseUrl}
                          onChange={(e) => setOpenrouterBaseUrl(e.target.value)}
                        />
                      </div>

                      <div className="settings-section">
                        <h3>Model</h3>
                        <p className="settings-description">
                          Select a model from OpenRouter's catalog. Enter your API key and click
                          "Refresh Models" to load available models.
                        </p>
                        {openrouterModels.length > 0 ? (
                          <SearchableSelect
                            options={openrouterModels.map((model) => ({
                              value: model.id,
                              label: model.name,
                              description: `${Math.round(model.context_length / 1000)}k context`,
                            }))}
                            value={openrouterModel}
                            onChange={setOpenrouterModel}
                            placeholder="Select a model..."
                          />
                        ) : (
                          <input
                            type="text"
                            className="settings-input"
                            placeholder="anthropic/claude-3.5-sonnet"
                            value={openrouterModel}
                            onChange={(e) => setOpenrouterModel(e.target.value)}
                          />
                        )}
                        <p className="settings-hint">
                          OpenRouter provides access to many models from different providers
                          (Claude, GPT-4, Llama, etc.) through a unified API.
                        </p>
                      </div>
                    </>
                  )}

                  {settings.providerType === "openai" && (
                    <>
                      <div className="settings-section">
                        <h3>Authentication Method</h3>
                        <p className="settings-description">
                          Choose how to authenticate with OpenAI
                        </p>
                        <div className="auth-method-tabs">
                          <button
                            className={`auth-method-tab ${openaiAuthMethod === "oauth" ? "active" : ""}`}
                            onClick={() => setOpenaiAuthMethod("oauth")}
                          >
                            <svg
                              width="16"
                              height="16"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                              <circle cx="12" cy="7" r="4" />
                            </svg>
                            Sign in with ChatGPT
                          </button>
                          <button
                            className={`auth-method-tab ${openaiAuthMethod === "api_key" ? "active" : ""}`}
                            onClick={() => setOpenaiAuthMethod("api_key")}
                          >
                            <svg
                              width="16"
                              height="16"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
                            </svg>
                            API Key
                          </button>
                        </div>
                      </div>

                      {openaiAuthMethod === "oauth" && (
                        <div className="settings-section">
                          <h3>ChatGPT Account</h3>
                          {openaiOAuthConnected ? (
                            <div className="oauth-connected">
                              <div className="oauth-status">
                                <svg
                                  width="20"
                                  height="20"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                >
                                  <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
                                  <path d="M22 4L12 14.01l-3-3" />
                                </svg>
                                <span>Connected to ChatGPT</span>
                              </div>
                              <p className="settings-description">
                                Your ChatGPT account is connected. You can use GPT-4o and other
                                models with your subscription.
                              </p>
                              <button
                                className="button-small button-secondary"
                                onClick={handleOpenAIOAuthLogout}
                                disabled={openaiOAuthLoading}
                              >
                                {openaiOAuthLoading ? "Disconnecting..." : "Disconnect Account"}
                              </button>
                            </div>
                          ) : (
                            <div className="oauth-login">
                              <p className="settings-description">
                                Sign in with your ChatGPT account to use GPT-4o, o1, and other
                                models with your subscription.
                              </p>
                              <button
                                className="button-primary oauth-login-btn"
                                onClick={handleOpenAIOAuthLogin}
                                disabled={openaiOAuthLoading}
                              >
                                {openaiOAuthLoading ? (
                                  <>
                                    <svg
                                      className="spinner"
                                      width="16"
                                      height="16"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2"
                                    >
                                      <path d="M21 12a9 9 0 11-6.219-8.56" />
                                    </svg>
                                    Connecting...
                                  </>
                                ) : (
                                  <>
                                    <svg
                                      width="16"
                                      height="16"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2"
                                    >
                                      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                                      <polyline points="10 17 15 12 10 7" />
                                      <line x1="15" y1="12" x2="3" y2="12" />
                                    </svg>
                                    Sign in with ChatGPT
                                  </>
                                )}
                              </button>
                            </div>
                          )}
                        </div>
                      )}

                      {openaiAuthMethod === "api_key" && (
                        <div className="settings-section">
                          <h3>OpenAI API Key</h3>
                          <p className="settings-description">
                            Enter your API key from{" "}
                            <a
                              href="https://platform.openai.com/api-keys"
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              OpenAI Platform
                            </a>
                          </p>
                          <div className="settings-input-group">
                            <input
                              type="password"
                              className="settings-input"
                              placeholder="sk-..."
                              value={openaiApiKey}
                              onChange={(e) => setOpenaiApiKey(e.target.value)}
                            />
                            <button
                              className="button-small button-secondary"
                              onClick={() => loadOpenAIModels(openaiApiKey)}
                              disabled={loadingOpenAIModels}
                            >
                              {loadingOpenAIModels ? "Loading..." : "Refresh Models"}
                            </button>
                          </div>
                        </div>
                      )}

                      <div className="settings-section">
                        <h3>Model</h3>
                        <p className="settings-description">
                          {openaiAuthMethod === "oauth" && openaiOAuthConnected
                            ? "Select a GPT model to use with your ChatGPT subscription."
                            : 'Select a GPT model. Enter your API key and click "Refresh Models" to load available models.'}
                        </p>
                        {openaiModels.length > 0 ? (
                          <SearchableSelect
                            options={openaiModels.map((model) => ({
                              value: model.id,
                              label: model.name,
                              description: model.description,
                            }))}
                            value={openaiModel}
                            onChange={setOpenaiModel}
                            placeholder="Select a model..."
                            allowCustomValue
                          />
                        ) : (
                          <input
                            type="text"
                            className="settings-input"
                            placeholder="gpt-4o-mini"
                            value={openaiModel}
                            onChange={(e) => setOpenaiModel(e.target.value)}
                          />
                        )}
                        {openaiAuthMethod === "oauth" && openaiOAuthConnected && (
                          <button
                            className="button-small button-secondary"
                            onClick={() => loadOpenAIModels()}
                            disabled={loadingOpenAIModels}
                            style={{ marginTop: "8px" }}
                          >
                            {loadingOpenAIModels ? "Loading..." : "Refresh Models"}
                          </button>
                        )}
                      </div>
                    </>
                  )}

                  {settings.providerType === "azure" && (
                    <>
                      <div className="settings-section">
                        <h3>Azure OpenAI Endpoint</h3>
                        <p className="settings-description">
                          Enter your Azure OpenAI resource endpoint (for example,{" "}
                          <code>https://your-resource.openai.azure.com</code>).
                        </p>
                        <input
                          type="text"
                          className="settings-input"
                          placeholder="https://your-resource.openai.azure.com"
                          value={azureEndpoint}
                          onChange={(e) => setAzureEndpoint(e.target.value)}
                        />
                      </div>

                      <div className="settings-section">
                        <h3>Azure OpenAI API Key</h3>
                        <p className="settings-description">
                          Enter the API key for your Azure OpenAI resource.
                        </p>
                        <input
                          type="password"
                          className="settings-input"
                          placeholder="Azure API key"
                          value={azureApiKey}
                          onChange={(e) => setAzureApiKey(e.target.value)}
                        />
                      </div>

                      <div className="settings-section">
                        <h3>Deployment Names</h3>
                        <p className="settings-description">
                          Enter one or more deployment names (one per line). These appear in the
                          model selector.
                        </p>
                        <textarea
                          className="settings-input"
                          placeholder="gpt-4o-mini\nmy-other-deployment"
                          rows={3}
                          value={azureDeploymentsText}
                          onChange={(e) => setAzureDeploymentsText(e.target.value)}
                        />
                      </div>

                      <div className="settings-section">
                        <h3>Default Deployment</h3>
                        <p className="settings-description">
                          Optional. Used for connection tests and initial selection. You can switch
                          models in the main view.
                        </p>
                        <input
                          type="text"
                          className="settings-input"
                          placeholder="gpt-4o-mini"
                          value={azureDeployment}
                          onChange={(e) => setAzureDeployment(e.target.value)}
                        />
                      </div>

                      <div className="settings-section">
                        <h3>API Version</h3>
                        <p className="settings-description">
                          Optional override for the Azure OpenAI API version.
                        </p>
                        <input
                          type="text"
                          className="settings-input"
                          placeholder="2024-02-15-preview"
                          value={azureApiVersion}
                          onChange={(e) => setAzureApiVersion(e.target.value)}
                        />
                      </div>
                    </>
                  )}

                  {settings.providerType === "groq" && (
                    <>
                      <div className="settings-section">
                        <h3>Groq API Key</h3>
                        <p className="settings-description">
                          Enter your API key from{" "}
                          <a
                            href="https://console.groq.com/keys"
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Groq Console
                          </a>
                        </p>
                        <div className="settings-input-group">
                          <input
                            type="password"
                            className="settings-input"
                            placeholder="gsk_..."
                            value={groqApiKey}
                            onChange={(e) => setGroqApiKey(e.target.value)}
                          />
                          <button
                            className="button-small button-secondary"
                            onClick={() => loadGroqModels(groqApiKey)}
                            disabled={loadingGroqModels}
                          >
                            {loadingGroqModels ? "Loading..." : "Refresh Models"}
                          </button>
                        </div>
                      </div>

                      <div className="settings-section">
                        <h3>Base URL</h3>
                        <p className="settings-description">
                          Optional override for the Groq API endpoint.
                        </p>
                        <input
                          type="text"
                          className="settings-input"
                          placeholder="https://api.groq.com/openai/v1"
                          value={groqBaseUrl}
                          onChange={(e) => setGroqBaseUrl(e.target.value)}
                        />
                      </div>

                      <div className="settings-section">
                        <h3>Model</h3>
                        <p className="settings-description">
                          Select a Groq model. Enter your API key and click "Refresh Models" to load
                          available models.
                        </p>
                        {groqModels.length > 0 ? (
                          <SearchableSelect
                            options={groqModels.map((model) => ({
                              value: model.id,
                              label: model.name,
                            }))}
                            value={groqModel}
                            onChange={setGroqModel}
                            placeholder="Select a model..."
                          />
                        ) : (
                          <input
                            type="text"
                            className="settings-input"
                            placeholder="llama-3.1-8b-instant"
                            value={groqModel}
                            onChange={(e) => setGroqModel(e.target.value)}
                          />
                        )}
                      </div>
                    </>
                  )}

                  {settings.providerType === "xai" && (
                    <>
                      <div className="settings-section">
                        <h3>xAI API Key</h3>
                        <p className="settings-description">
                          Enter your API key from{" "}
                          <a href="https://console.x.ai/" target="_blank" rel="noopener noreferrer">
                            xAI Console
                          </a>
                        </p>
                        <div className="settings-input-group">
                          <input
                            type="password"
                            className="settings-input"
                            placeholder="xai-..."
                            value={xaiApiKey}
                            onChange={(e) => setXaiApiKey(e.target.value)}
                          />
                          <button
                            className="button-small button-secondary"
                            onClick={() => loadXAIModels(xaiApiKey)}
                            disabled={loadingXaiModels}
                          >
                            {loadingXaiModels ? "Loading..." : "Refresh Models"}
                          </button>
                        </div>
                      </div>

                      <div className="settings-section">
                        <h3>Base URL</h3>
                        <p className="settings-description">
                          Optional override for the xAI API endpoint.
                        </p>
                        <input
                          type="text"
                          className="settings-input"
                          placeholder="https://api.x.ai/v1"
                          value={xaiBaseUrl}
                          onChange={(e) => setXaiBaseUrl(e.target.value)}
                        />
                      </div>

                      <div className="settings-section">
                        <h3>Model</h3>
                        <p className="settings-description">
                          Select a Grok model. Enter your API key and click "Refresh Models" to load
                          available models.
                        </p>
                        {xaiModels.length > 0 ? (
                          <SearchableSelect
                            options={xaiModels.map((model) => ({
                              value: model.id,
                              label: model.name,
                            }))}
                            value={xaiModel}
                            onChange={setXaiModel}
                            placeholder="Select a model..."
                          />
                        ) : (
                          <input
                            type="text"
                            className="settings-input"
                            placeholder="grok-4-fast-non-reasoning"
                            value={xaiModel}
                            onChange={(e) => setXaiModel(e.target.value)}
                          />
                        )}
                      </div>
                    </>
                  )}

                  {settings.providerType === "kimi" && (
                    <>
                      <div className="settings-section">
                        <h3>Kimi API Key</h3>
                        <p className="settings-description">
                          Enter your API key from{" "}
                          <a
                            href="https://platform.moonshot.ai/"
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Moonshot Platform
                          </a>
                        </p>
                        <div className="settings-input-group">
                          <input
                            type="password"
                            className="settings-input"
                            placeholder="sk-..."
                            value={kimiApiKey}
                            onChange={(e) => setKimiApiKey(e.target.value)}
                          />
                          <button
                            className="button-small button-secondary"
                            onClick={() => loadKimiModels(kimiApiKey)}
                            disabled={loadingKimiModels}
                          >
                            {loadingKimiModels ? "Loading..." : "Refresh Models"}
                          </button>
                        </div>
                      </div>

                      <div className="settings-section">
                        <h3>Base URL</h3>
                        <p className="settings-description">
                          Optional override for the Kimi API endpoint.
                        </p>
                        <input
                          type="text"
                          className="settings-input"
                          placeholder="https://api.moonshot.ai/v1"
                          value={kimiBaseUrl}
                          onChange={(e) => setKimiBaseUrl(e.target.value)}
                        />
                      </div>

                      <div className="settings-section">
                        <h3>Model</h3>
                        <p className="settings-description">
                          Select a Kimi model. Enter your API key and click "Refresh Models" to load
                          available models.
                        </p>
                        {kimiModels.length > 0 ? (
                          <SearchableSelect
                            options={kimiModels.map((model) => ({
                              value: model.id,
                              label: model.name,
                            }))}
                            value={kimiModel}
                            onChange={setKimiModel}
                            placeholder="Select a model..."
                          />
                        ) : (
                          <input
                            type="text"
                            className="settings-input"
                            placeholder="kimi-k2.5"
                            value={kimiModel}
                            onChange={(e) => setKimiModel(e.target.value)}
                          />
                        )}
                      </div>
                    </>
                  )}

                  {settings.providerType === "pi" && (
                    <>
                      <div className="settings-section">
                        <h3>Pi Backend Provider</h3>
                        <p className="settings-description">
                          Select which LLM provider to route through{" "}
                          <a
                            href="https://github.com/badlogic/pi-mono"
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Pi
                          </a>
                          's unified API.
                        </p>
                        <select
                          className="settings-select"
                          value={piProvider}
                          onChange={(e) => {
                            setPiProvider(e.target.value);
                            setPiModels([]);
                            setPiModel("");
                            loadPiModels(e.target.value);
                          }}
                        >
                          {piProviders.length > 0 ? (
                            piProviders.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))
                          ) : (
                            <>
                              <option value="anthropic">Anthropic</option>
                              <option value="openai">OpenAI</option>
                              <option value="google">Google</option>
                              <option value="xai">xAI</option>
                              <option value="groq">Groq</option>
                              <option value="cerebras">Cerebras</option>
                              <option value="openrouter">OpenRouter</option>
                              <option value="mistral">Mistral</option>
                              <option value="amazon-bedrock">Amazon Bedrock</option>
                              <option value="minimax">MiniMax</option>
                              <option value="huggingface">HuggingFace</option>
                            </>
                          )}
                        </select>
                      </div>

                      <div className="settings-section">
                        <h3>API Key</h3>
                        <p className="settings-description">
                          Enter the API key for the selected backend provider.
                        </p>
                        <div className="settings-input-group">
                          <input
                            type="password"
                            className="settings-input"
                            placeholder="Enter API key..."
                            value={piApiKey}
                            onChange={(e) => setPiApiKey(e.target.value)}
                          />
                          <button
                            className="button-small button-secondary"
                            onClick={() => loadPiModels(piProvider)}
                            disabled={loadingPiModels}
                          >
                            {loadingPiModels ? "Loading..." : "Refresh Models"}
                          </button>
                        </div>
                      </div>

                      <div className="settings-section">
                        <h3>Model</h3>
                        <p className="settings-description">
                          Select a model from Pi's model registry.
                        </p>
                        {piModels.length > 0 ? (
                          <SearchableSelect
                            options={piModels.map((model) => ({
                              value: model.id,
                              label: model.name,
                              description: model.description,
                            }))}
                            value={piModel}
                            onChange={setPiModel}
                            placeholder="Select a model..."
                          />
                        ) : (
                          <input
                            type="text"
                            className="settings-input"
                            placeholder="claude-sonnet-4-5-20250514"
                            value={piModel}
                            onChange={(e) => setPiModel(e.target.value)}
                          />
                        )}
                      </div>
                    </>
                  )}

                  {settings.providerType === "openai-compatible" && (
                    <>
                      <div className="settings-section">
                        <h3>Base URL</h3>
                        <p className="settings-description">
                          Enter the base URL of your OpenAI-compatible API endpoint (e.g. vLLM, LM
                          Studio, LocalAI, text-generation-webui).
                        </p>
                        <div className="settings-input-group">
                          <input
                            type="text"
                            className="settings-input"
                            placeholder="http://localhost:1234/v1"
                            value={openaiCompatBaseUrl}
                            onChange={(e) => setOpenaiCompatBaseUrl(e.target.value)}
                          />
                          <button
                            className="button-small button-secondary"
                            onClick={() => loadOpenAICompatibleModels()}
                            disabled={loadingOpenAICompatModels || !openaiCompatBaseUrl}
                          >
                            {loadingOpenAICompatModels ? "Loading..." : "Fetch Models"}
                          </button>
                        </div>
                      </div>

                      <div className="settings-section">
                        <h3>API Key (Optional)</h3>
                        <p className="settings-description">
                          API key is optional for local servers. Required for remote endpoints that
                          need authentication.
                        </p>
                        <input
                          type="password"
                          className="settings-input"
                          placeholder="sk-..."
                          value={openaiCompatApiKey}
                          onChange={(e) => setOpenaiCompatApiKey(e.target.value)}
                        />
                      </div>

                      <div className="settings-section">
                        <h3>Model</h3>
                        <p className="settings-description">
                          Select a model or enter a model ID. Click "Fetch Models" to load available
                          models from the endpoint.
                        </p>
                        {openaiCompatModels.length > 0 ? (
                          <SearchableSelect
                            options={openaiCompatModels.map((model) => ({
                              value: model.key,
                              label: model.displayName,
                              description: model.description,
                            }))}
                            value={openaiCompatModel}
                            onChange={setOpenaiCompatModel}
                            placeholder="Select a model..."
                          />
                        ) : (
                          <input
                            type="text"
                            className="settings-input"
                            placeholder="model-name"
                            value={openaiCompatModel}
                            onChange={(e) => setOpenaiCompatModel(e.target.value)}
                          />
                        )}
                      </div>
                    </>
                  )}

                  {selectedCustomProvider && (
                    <>
                      <div className="settings-section">
                        <h3>{selectedCustomProvider.apiKeyLabel}</h3>
                        {selectedCustomProvider.apiKeyUrl ? (
                          <p className="settings-description">
                            Enter your API key from{" "}
                            <a
                              href={selectedCustomProvider.apiKeyUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {selectedCustomProvider.name}
                            </a>
                          </p>
                        ) : selectedCustomProvider.description ? (
                          <p className="settings-description">
                            {selectedCustomProvider.description}
                          </p>
                        ) : null}
                        <input
                          type="password"
                          className="settings-input"
                          placeholder={selectedCustomProvider.apiKeyPlaceholder || "sk-..."}
                          value={selectedCustomConfig.apiKey || ""}
                          onChange={(e) =>
                            updateCustomProvider(resolvedProviderType, { apiKey: e.target.value })
                          }
                        />
                        {selectedCustomProvider.apiKeyOptional && (
                          <p className="settings-hint">API key is optional for this provider.</p>
                        )}
                      </div>

                      {(selectedCustomProvider.requiresBaseUrl ||
                        selectedCustomProvider.baseUrl) && (
                        <div className="settings-section">
                          <h3>Base URL</h3>
                          <p className="settings-description">
                            {selectedCustomProvider.requiresBaseUrl
                              ? "Base URL is required for this provider."
                              : "Override the default base URL if needed."}
                          </p>
                          <input
                            type="text"
                            className="settings-input"
                            placeholder={selectedCustomProvider.baseUrl || "https://..."}
                            value={selectedCustomConfig.baseUrl || ""}
                            onChange={(e) =>
                              updateCustomProvider(resolvedProviderType, {
                                baseUrl: e.target.value,
                              })
                            }
                          />
                        </div>
                      )}

                      <div className="settings-section">
                        <h3>Model</h3>
                        <p className="settings-description">
                          Enter the model ID to use for {selectedCustomProvider.name}.
                        </p>
                        <input
                          type="text"
                          className="settings-input"
                          placeholder={selectedCustomProvider.defaultModel || "model-id"}
                          value={selectedCustomConfig.model || ""}
                          onChange={(e) =>
                            updateCustomProvider(resolvedProviderType, { model: e.target.value })
                          }
                        />
                      </div>
                    </>
                  )}

                  {settings.providerType === "bedrock" && (
                    <>
                      <div className="settings-section">
                        <h3>AWS Region</h3>
                        <select
                          className="settings-select"
                          value={awsRegion}
                          onChange={(e) => setAwsRegion(e.target.value)}
                        >
                          <option value="us-east-1">US East (N. Virginia)</option>
                          <option value="us-west-2">US West (Oregon)</option>
                          <option value="eu-west-1">Europe (Ireland)</option>
                          <option value="eu-central-1">Europe (Frankfurt)</option>
                          <option value="ap-northeast-1">Asia Pacific (Tokyo)</option>
                          <option value="ap-southeast-1">Asia Pacific (Singapore)</option>
                          <option value="ap-southeast-2">Asia Pacific (Sydney)</option>
                        </select>
                      </div>

                      <div className="settings-section">
                        <h3>AWS Credentials</h3>

                        <label className="settings-checkbox">
                          <input
                            type="checkbox"
                            checked={useDefaultCredentials}
                            onChange={(e) => setUseDefaultCredentials(e.target.checked)}
                          />
                          <span>Use default credential chain (recommended)</span>
                        </label>

                        {useDefaultCredentials ? (
                          <div className="settings-subsection">
                            <p className="settings-description">
                              Uses AWS credentials from environment variables, shared credentials
                              file (~/.aws/credentials), or IAM role.
                            </p>
                            <input
                              type="text"
                              className="settings-input"
                              placeholder="AWS Profile (optional, e.g., 'default')"
                              value={awsProfile}
                              onChange={(e) => setAwsProfile(e.target.value)}
                            />
                          </div>
                        ) : (
                          <div className="settings-subsection">
                            <input
                              type="text"
                              className="settings-input"
                              placeholder="AWS Access Key ID"
                              value={awsAccessKeyId}
                              onChange={(e) => setAwsAccessKeyId(e.target.value)}
                            />
                            <input
                              type="password"
                              className="settings-input"
                              placeholder="AWS Secret Access Key"
                              value={awsSecretAccessKey}
                              onChange={(e) => setAwsSecretAccessKey(e.target.value)}
                            />
                          </div>
                        )}
                      </div>

                      <div className="settings-section">
                        <h3>Model</h3>
                        <p className="settings-description">
                          Select a Claude model from AWS Bedrock.{" "}
                          <button
                            className="button-small button-secondary"
                            onClick={loadBedrockModels}
                            disabled={loadingBedrockModels}
                            style={{ marginLeft: "8px" }}
                          >
                            {loadingBedrockModels ? "Loading..." : "Refresh Models"}
                          </button>
                        </p>
                        {bedrockModels.length > 0 ? (
                          <SearchableSelect
                            options={bedrockModels.map((model) => ({
                              value: model.id,
                              label: model.name,
                              description: model.description,
                            }))}
                            value={bedrockModel}
                            onChange={setBedrockModel}
                            placeholder="Select a model..."
                          />
                        ) : (
                          <select
                            className="settings-select"
                            value={settings.modelKey}
                            onChange={(e) => setSettings({ ...settings, modelKey: e.target.value })}
                          >
                            {models.map((model) => (
                              <option key={model.key} value={model.key}>
                                {model.displayName}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    </>
                  )}

                  {settings.providerType === "ollama" && (
                    <>
                      <div className="settings-section">
                        <h3>Ollama Server URL</h3>
                        <p className="settings-description">
                          URL of your Ollama server. Default is http://localhost:11434 for local
                          installations.
                        </p>
                        <div className="settings-input-group">
                          <input
                            type="text"
                            className="settings-input"
                            placeholder="http://localhost:11434"
                            value={ollamaBaseUrl}
                            onChange={(e) => setOllamaBaseUrl(e.target.value)}
                          />
                          <button
                            className="button-small button-secondary"
                            onClick={() => loadOllamaModels(ollamaBaseUrl)}
                            disabled={loadingOllamaModels}
                          >
                            {loadingOllamaModels ? "Loading..." : "Refresh Models"}
                          </button>
                        </div>
                      </div>

                      <div className="settings-section">
                        <h3>Model</h3>
                        <p className="settings-description">
                          Select from models available on your Ollama server, or enter a custom
                          model name.
                        </p>
                        {ollamaModels.length > 0 ? (
                          <SearchableSelect
                            options={ollamaModels.map((model) => ({
                              value: model.name,
                              label: model.name,
                              description: formatBytes(model.size),
                            }))}
                            value={ollamaModel}
                            onChange={setOllamaModel}
                            placeholder="Select a model..."
                          />
                        ) : (
                          <input
                            type="text"
                            className="settings-input"
                            placeholder="llama3.2"
                            value={ollamaModel}
                            onChange={(e) => setOllamaModel(e.target.value)}
                          />
                        )}
                        <p className="settings-hint">
                          Don't have models? Run <code>ollama pull llama3.2</code> to download a
                          model.
                        </p>
                      </div>

                      <div className="settings-section">
                        <h3>API Key (Optional)</h3>
                        <p className="settings-description">
                          Only needed if connecting to a remote Ollama server that requires
                          authentication.
                        </p>
                        <input
                          type="password"
                          className="settings-input"
                          placeholder="Optional API key for remote servers"
                          value={ollamaApiKey}
                          onChange={(e) => setOllamaApiKey(e.target.value)}
                        />
                      </div>
                    </>
                  )}

                  {testResult && (
                    <div className={`test-result ${testResult.success ? "success" : "error"}`}>
                      {testResult.success ? (
                        <>
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
                            <path d="M22 4L12 14.01l-3-3" />
                          </svg>
                          Connection successful!
                        </>
                      ) : (
                        <>
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <circle cx="12" cy="12" r="10" />
                            <line x1="15" y1="9" x2="9" y2="15" />
                            <line x1="9" y1="9" x2="15" y2="15" />
                          </svg>
                          <span title={testResult.error}>
                            {(() => {
                              const error = testResult.error || "Connection failed";
                              // Extract meaningful part before JSON details
                              const jsonStart = error.indexOf(" [{");
                              const truncated = jsonStart > 0 ? error.slice(0, jsonStart) : error;
                              return truncated.length > 200
                                ? truncated.slice(0, 200) + "..."
                                : truncated;
                            })()}
                          </span>
                        </>
                      )}
                    </div>
                  )}

                  <div className="settings-actions">
                    <button
                      className="button-secondary"
                      onClick={handleTestConnection}
                      disabled={loading || testing}
                    >
                      {testing ? "Testing..." : "Test Connection"}
                    </button>
                    <button
                      className="button-primary"
                      onClick={handleSave}
                      disabled={loading || saving}
                    >
                      {saving ? "Saving..." : "Save Settings"}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
