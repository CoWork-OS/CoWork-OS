import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  Sparkles,
  Sun,
  User,
  Users,
  Mic,
  Layers,
  Search,
  MessageCircle,
  Send,
  Hash,
  UsersRound,
  AtSign,
  MoreHorizontal,
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
  RefreshCw,
  MessageSquare,
  Image as ImageIcon,
  Smile,
  ShieldCheck as ShieldCheckIcon,
  MessagesSquare,
  Mail,
  Square,
  Tv,
  CircleDot,
  Cloud,
  Star,
  Globe,
  Box,
  Link,
  Hexagon,
  Crosshair,
  Pi,
  ChevronDown,
  Plus,
  Building2,
  HeartPulse,
  Film,
} from "lucide-react";
import {
  LLMSettingsData,
  ThemeMode,
  VisualTheme,
  AccentColor,
  UiDensity,
  type LLMProviderType,
  type LLMRoutingRuntimeState,
  type CustomProviderConfig,
  type AzureReasoningEffort,
  type LLMProviderFallbackConfig,
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
import { FeishuSettings } from "./FeishuSettings";
import { WeComSettings } from "./WeComSettings";
import { XSettings } from "./XSettings";
import { SearchSettings } from "./SearchSettings";
import { UpdateSettings } from "./UpdateSettings";
import { GuardrailSettings } from "./GuardrailSettings";
import { PermissionSettingsPanel } from "./PermissionSettingsPanel";
import { AppearanceSettings } from "./AppearanceSettings";
import { QueueSettings } from "./QueueSettings";
import { SkillsSettings } from "./SkillsSettings";
import { SkillHubBrowser } from "./SkillHubBrowser";
import { MCPSettings } from "./MCPSettings";
import { ConnectorsSettings } from "./ConnectorsSettings";
import { BuiltinToolsSettings } from "./BuiltinToolsSettings";
import { ChronicleSettingsCard } from "./ChronicleSettings";
import { ComputerUseSettings } from "./ComputerUseSettings";
import { TraySettings } from "./TraySettings";
import { ScheduledTasksSettings } from "./ScheduledTasksSettings";
import { HooksSettings } from "./HooksSettings";
import { ControlPlaneSettings } from "./ControlPlaneSettings";
import { PersonalitySettings } from "./PersonalitySettings";
import { NodesSettings } from "./NodesSettings";
import { ExtensionsSettings } from "./ExtensionsSettings";
import { VoiceSettings } from "./VoiceSettings";
import { MemoryHubSettings } from "./MemoryHubSettings";
import { WorktreeSettings } from "./WorktreeSettings";
import { UsageInsightsPanel } from "./UsageInsightsPanel";
import { SuggestionsPanel } from "./SuggestionsPanel";
import { CustomizePanel } from "./CustomizePanel";
import { ProfileSettings } from "./ProfileSettings";
import { AdminPoliciesPanel } from "./AdminPoliciesPanel";
import { EventTriggersPanel } from "./EventTriggersPanel";
import { BriefingPanel } from "./BriefingPanel";
import { WebAccessSettingsPanel } from "./WebAccessSettingsPanel";
import { InfraSettings } from "./InfraSettings";
import { DigitalTwinsPanel } from "./DigitalTwinsPanel";
import { SubconsciousSettingsPanel } from "./SubconsciousSettingsPanel";
import { CompaniesPanel } from "./CompaniesPanel";
import { HealthPanel } from "./HealthPanel";
import { CouncilSettings } from "./CouncilSettings";
import { RoutineSettingsPanel } from "./RoutineSettingsPanel";
import { ContactIdentitySettings } from "./ContactIdentitySettings";
import { TaskTraceDebuggerPanel } from "./TaskTraceDebuggerPanel";
import {
  buildClaudeCredentialInput,
  resolveClaudeAuthMethod,
  selectClaudeModelKey,
} from "./settings-llm-helpers";

type SettingsTab =
  | "appearance"
  | "personality"
  | "companies"
  | "system"
  | "tray"
  | "guardrails"
  | "policies"
  | "voice"
  | "aimodels"
  | "llm"
  | "image"
  | "search"
  | "telegram"
  | "slack"
  | "whatsapp"
  | "teams"
  | "x"
  | "morechannels"
  | "integrations"
  | "updates"
  | "automations"
  | "queue"
  | "skills"
  | "skillhub"
  | "connectors"
  | "identity"
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
  | "traces"
  | "customize"
  | "digitaltwins"
  | "triggers"
  | "briefing"
  | "subconscious"
  | "health"
  | "access"
  | "webaccess";

// Secondary channels shown inside "More Channels" tab
type SecondaryChannel =
  | "teams"
  | "x"
  | "discord"
  | "imessage"
  | "signal"
  | "mattermost"
  | "matrix"
  | "twitch"
  | "line"
  | "bluebubbles"
  | "email"
  | "googlechat"
  | "feishu"
  | "wecom";

interface SettingsProps {
  onBack: () => void;
  onSettingsChanged?: () => void;
  themeMode: ThemeMode;
  visualTheme: VisualTheme;
  accentColor: AccentColor;
  transparencyEffectsEnabled: boolean;
  onThemeChange: (theme: ThemeMode) => void;
  onVisualThemeChange: (theme: VisualTheme) => void;
  onAccentChange: (accent: AccentColor) => void;
  onTransparencyEffectsEnabledChange: (enabled: boolean) => void;
  uiDensity: UiDensity;
  onUiDensityChange: (density: UiDensity) => void;
  devRunLoggingEnabled: boolean;
  onDevRunLoggingEnabledChange: (enabled: boolean) => void;
  initialTab?: SettingsTab;
  onShowOnboarding?: () => void;
  onboardingCompletedAt?: string;
  workspaceId?: string;
  onCreateTask?: (title: string, prompt: string) => void;
  onOpenTask?: (taskId: string) => void;
  onNavigateToMissionControl?: (companyId: string) => void;
  onNavigateToAgents?: () => void;
}

interface ModelOption {
  key: string;
  displayName: string;
}

interface ProviderInfo {
  type: LLMProviderType;
  name: string;
  configured: boolean;
}

interface ProviderRoutingConfig {
  fallbackProviders?: LLMProviderFallbackConfig[];
  failoverPrimaryRetryCooldownSeconds?: number;
  profileRoutingEnabled?: boolean;
  strongModelKey?: string;
  cheapModelKey?: string;
  automatedTaskModelKey?: string;
  preferStrongForVerification?: boolean;
}

const AZURE_REASONING_EFFORT_OPTIONS: Array<{
  value: AzureReasoningEffort;
  label: string;
  description: string;
}> = [
  {
    value: "low",
    label: "Low",
    description: "Faster responses with less reasoning.",
  },
  {
    value: "medium",
    label: "Medium",
    description: "Balanced quality and latency.",
  },
  { value: "high", label: "High", description: "More thorough reasoning." },
  {
    value: "extra_high",
    label: "Extra High",
    description: "Maximum effort. Azure maps this to High on the request.",
  },
];

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
      (opt.description &&
        opt.description.toLowerCase().includes(search.toLowerCase())),
  );

  const customValue = search.trim();
  const showCustomOption =
    allowCustomValue && filteredOptions.length === 0 && customValue.length > 0;
  const optionCount =
    filteredOptions.length > 0
      ? filteredOptions.length
      : showCustomOption
        ? 1
        : 0;

  // Reset highlighted index when search changes
  useEffect(() => {
    setHighlightedIndex(0);
  }, [search]);

  // Scroll highlighted option into view
  useEffect(() => {
    if (isOpen && listRef.current) {
      const highlightedEl = listRef.current.querySelector(
        `[data-index="${highlightedIndex}"]`,
      );
      if (highlightedEl) {
        highlightedEl.scrollIntoView({ block: "nearest" });
      }
    }
  }, [highlightedIndex, isOpen]);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
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
        <ChevronDown
          className="searchable-select-arrow"
          size={12}
          strokeWidth={2}
        />
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
                  <span className="searchable-select-option-label">
                    {customValue}
                  </span>
                  <span className="searchable-select-option-desc">
                    Use custom model ID
                  </span>
                </div>
              ) : (
                <div className="searchable-select-no-results">
                  No models found
                </div>
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
                  <span className="searchable-select-option-label">
                    {opt.label}
                  </span>
                  {opt.description && (
                    <span className="searchable-select-option-desc">
                      {opt.description}
                    </span>
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
type SidebarItem = {
  tab: SettingsTab;
  label: string;
  icon: ReactNode;
  macOnly?: boolean;
  group: string;
};

type SidebarSearchTarget = {
  tab?: SettingsTab;
  secondaryChannel?: SecondaryChannel;
  aiModelsSubTab?: "llm" | "image" | "video" | "search";
  automationsSubTab?:
    | "routines"
    | "queue"
    | "subconscious"
    | "scheduled"
    | "hooks"
    | "triggers"
    | "council";
  skillsSubTab?: "custom" | "store";
  integrationsSubTab?: "git" | "connectors" | "identity" | "infrastructure";
  accessSubTab?: "controlplane" | "webaccess";
};

type SidebarSearchEntry = {
  terms: string[];
  target?: SidebarSearchTarget;
};

const sidebarItems: SidebarItem[] = [
  {
    tab: "appearance",
    label: "Appearance",
    group: "General",
    icon: <Sun {...I} />,
  },
  {
    tab: "personality",
    label: "Personality",
    group: "General",
    icon: <User {...I} />,
  },
  {
    tab: "companies",
    label: "Companies",
    group: "General",
    icon: <Building2 {...I} />,
  },
  {
    tab: "system",
    label: "System & Security",
    group: "General",
    icon: <Shield {...I} />,
  },
  { tab: "voice", label: "Voice Mode", group: "General", icon: <Mic {...I} /> },
  {
    tab: "digitaltwins",
    label: "Agent Personas",
    group: "General",
    icon: <User {...I} />,
  },
  {
    tab: "aimodels",
    label: "AI & Models",
    group: "AI & Models",
    icon: <Layers {...I} />,
  },
  {
    tab: "whatsapp",
    label: "WhatsApp",
    group: "Communication",
    icon: <MessageCircle {...I} />,
  },
  {
    tab: "telegram",
    label: "Telegram",
    group: "Communication",
    icon: <Send {...I} />,
  },
  {
    tab: "slack",
    label: "Slack",
    group: "Communication",
    icon: <Hash {...I} />,
  },
  {
    tab: "morechannels",
    label: "More Channels",
    group: "Communication",
    icon: <MoreHorizontal {...I} />,
  },
  {
    tab: "memory",
    label: "Memory",
    group: "AI & Models",
    icon: <Brain {...I} />,
  },
  {
    tab: "automations",
    label: "Automations",
    group: "Automations",
    icon: <Zap {...I} />,
  },
  {
    tab: "integrations",
    label: "Integrations",
    group: "Integrations",
    icon: <LayoutGrid {...I} />,
  },
  {
    tab: "health",
    label: "Health",
    group: "Integrations",
    icon: <HeartPulse {...I} />,
  },
  {
    tab: "customize",
    label: "Plugin Packs",
    group: "Skills & Tools",
    icon: <Sparkles {...I} />,
  },
  {
    tab: "skills",
    label: "Skills",
    group: "Skills & Tools",
    icon: <Wrench {...I} />,
  },
  {
    tab: "mcp",
    label: "MCP Servers",
    group: "Skills & Tools",
    icon: <Monitor {...I} />,
  },
  {
    tab: "tools",
    label: "Built-in Tools",
    group: "Skills & Tools",
    icon: <MessageSquare {...I} />,
  },
  {
    tab: "briefing",
    label: "Daily Briefing",
    group: "Automations",
    icon: <Sun {...I} />,
  },
  {
    tab: "access",
    label: "Access",
    group: "Advanced",
    icon: <Monitor {...I} />,
  },
  {
    tab: "nodes",
    label: "Mobile Companions",
    group: "Advanced",
    icon: <Smartphone {...I} />,
  },
  {
    tab: "extensions",
    label: "Extensions",
    group: "Advanced",
    icon: <Puzzle {...I} />,
  },
  {
    tab: "insights",
    label: "Usage Insights",
    group: "Advanced",
    icon: <BarChart3 {...I} />,
  },
  {
    tab: "suggestions",
    label: "Suggestions",
    group: "Advanced",
    icon: <Lightbulb {...I} />,
  },
  {
    tab: "traces",
    label: "Trace Debugger",
    group: "Advanced",
    icon: <MessagesSquare {...I} />,
  },
  {
    tab: "updates",
    label: "Updates",
    group: "Advanced",
    icon: <RefreshCw {...I} />,
  },
];

// Secondary channel configuration for "More Channels" tab
const S = { size: 16, strokeWidth: 1.5 } as const;
const secondaryChannelItems: Array<{
  key: SecondaryChannel;
  label: string;
  icon: ReactNode;
}> = [
  { key: "teams", label: "Teams", icon: <UsersRound {...S} /> },
  { key: "x", label: "X (Twitter)", icon: <AtSign {...S} /> },
  { key: "discord", label: "Discord", icon: <MessageSquare {...S} /> },
  { key: "imessage", label: "iMessage", icon: <MessageCircle {...S} /> },
  { key: "signal", label: "Signal", icon: <ShieldCheckIcon {...S} /> },
  { key: "line", label: "LINE", icon: <MessagesSquare {...S} /> },
  { key: "email", label: "Email", icon: <Mail {...S} /> },
  { key: "googlechat", label: "Google Chat", icon: <MessagesSquare {...S} /> },
  { key: "feishu", label: "Feishu / Lark", icon: <MessageCircle {...S} /> },
  { key: "wecom", label: "WeCom", icon: <Building2 {...S} /> },
  { key: "mattermost", label: "Mattermost", icon: <Square {...S} /> },
  { key: "matrix", label: "Matrix", icon: <LayoutGrid {...S} /> },
  { key: "twitch", label: "Twitch", icon: <Tv {...S} /> },
  { key: "bluebubbles", label: "BlueBubbles", icon: <Smile {...S} /> },
];

const secondaryChannelSearchTerms: Partial<Record<SecondaryChannel, string[]>> =
  {
    teams: ["microsoft teams", "teams"],
    x: ["twitter", "x twitter", "tweets", "social"],
    discord: ["discord"],
    imessage: ["imessage", "ios messages", "apple messages"],
    signal: ["signal", "secure messaging"],
    line: ["line", "line messenger"],
    email: ["email", "mail"],
    googlechat: ["google chat", "gchat"],
    feishu: ["feishu", "lark"],
    wecom: ["wecom", "wechat work", "enterprise wechat"],
    mattermost: ["mattermost"],
    matrix: ["matrix"],
    twitch: ["twitch", "stream chat"],
    bluebubbles: ["bluebubbles", "blue bubbles"],
  };

const sidebarSearchEntries: Partial<Record<SettingsTab, SidebarSearchEntry[]>> =
  {
    appearance: [
      {
        terms: [
          "theme",
          "light mode",
          "dark mode",
          "accent color",
          "transparency effects",
          "ui density",
          "developer logging",
          "onboarding",
        ],
      },
    ],
    personality: [
      { terms: ["personality", "assistant behavior", "system prompt"] },
    ],
    companies: [
      { terms: ["companies", "company", "mission control", "organization"] },
    ],
    system: [
      {
        terms: [
          "profiles",
          "security",
          "permissions",
          "guardrails",
          "admin policies",
          "tray",
          "menu bar",
          "system settings",
        ],
      },
    ],
    voice: [{ terms: ["voice", "voice mode", "speech", "microphone", "audio"] }],
    digitaltwins: [
      { terms: ["agent personas", "personas", "digital twins", "agents"] },
    ],
    aimodels: [
      {
        terms: [
          "ai model",
          "llm",
          "language model",
          "model provider",
          "provider routing",
          "fallback provider",
          "anthropic",
          "claude",
          "openai",
          "gpt",
          "azure",
          "gemini",
          "openrouter",
          "ollama",
          "groq",
          "xai",
          "grok",
          "kimi",
          "bedrock",
          "pi",
        ],
        target: { tab: "aimodels", aiModelsSubTab: "llm" },
      },
      {
        terms: [
          "image model",
          "image generation",
          "text to image",
          "text-to-image",
          "gpt-image",
          "gpt image",
          "nano-banana",
          "nano banana",
          "draw image",
          "create image",
        ],
        target: { tab: "aimodels", aiModelsSubTab: "image" },
      },
      {
        terms: [
          "video",
          "video model",
          "sora",
          "kling",
          "vertex video",
          "video generation",
        ],
        target: { tab: "aimodels", aiModelsSubTab: "video" },
      },
      {
        terms: [
          "web search",
          "search provider",
          "search engine",
          "tavily",
          "exa",
          "duckduckgo",
          "google search",
        ],
        target: { tab: "aimodels", aiModelsSubTab: "search" },
      },
    ],
    morechannels: secondaryChannelItems.map((item) => ({
      terms: [item.label, ...(secondaryChannelSearchTerms[item.key] ?? [])],
      target: { tab: "morechannels", secondaryChannel: item.key },
    })),
    memory: [{ terms: ["memory", "memories", "memory hub", "knowledge"] }],
    automations: [
      {
        terms: ["routines", "routine", "automation routines"],
        target: { tab: "automations", automationsSubTab: "routines" },
      },
      {
        terms: ["queue", "task queue", "queued tasks"],
        target: { tab: "automations", automationsSubTab: "queue" },
      },
      {
        terms: ["council", "r&d council", "research council"],
        target: { tab: "automations", automationsSubTab: "council" },
      },
      {
        terms: [
          "workflow intelligence",
          "continuity",
          "reflection",
          "workflow insights",
          "background reflection",
          "subconscious",
        ],
        target: { tab: "automations", automationsSubTab: "subconscious" },
      },
      {
        terms: ["scheduled", "scheduled tasks", "cron", "recurring tasks"],
        target: { tab: "automations", automationsSubTab: "scheduled" },
      },
      {
        terms: ["hooks", "webhooks", "hook"],
        target: { tab: "automations", automationsSubTab: "hooks" },
      },
      {
        terms: ["triggers", "event triggers", "events"],
        target: { tab: "automations", automationsSubTab: "triggers" },
      },
    ],
    integrations: [
      {
        terms: ["git", "worktree", "repository"],
        target: { tab: "integrations", integrationsSubTab: "git" },
      },
      {
        terms: ["connectors", "integrations", "apps"],
        target: { tab: "integrations", integrationsSubTab: "connectors" },
      },
      {
        terms: ["identity", "contacts", "crm", "contact identity"],
        target: { tab: "integrations", integrationsSubTab: "identity" },
      },
      {
        terms: ["infrastructure", "infra", "servers", "deployment"],
        target: { tab: "integrations", integrationsSubTab: "infrastructure" },
      },
    ],
    health: [{ terms: ["health", "healthkit", "fitness", "wellness"] }],
    customize: [
      { terms: ["plugin packs", "plugins", "packs", "registry", "customize"] },
    ],
    skills: [
      {
        terms: ["custom skills", "skills", "local skills"],
        target: { tab: "skills", skillsSubTab: "custom" },
      },
      {
        terms: ["skill store", "skill hub", "marketplace", "skillhub"],
        target: { tab: "skills", skillsSubTab: "store" },
      },
    ],
    mcp: [
      {
        terms: [
          "mcp",
          "mcp servers",
          "model context protocol",
          "server registry",
        ],
      },
    ],
    tools: [
      { terms: ["built-in tools", "tools", "computer use", "builtin tools"] },
    ],
    briefing: [
      { terms: ["daily briefing", "briefing", "morning summary", "digest"] },
    ],
    access: [
      {
        terms: ["remote access", "control plane", "controlplane"],
        target: { tab: "access", accessSubTab: "controlplane" },
      },
      {
        terms: ["web access", "browser access", "webaccess"],
        target: { tab: "access", accessSubTab: "webaccess" },
      },
    ],
    nodes: [{ terms: ["mobile companions", "nodes", "mobile"] }],
    extensions: [{ terms: ["extensions", "browser extension", "extension"] }],
    insights: [{ terms: ["usage insights", "analytics", "metrics"] }],
    suggestions: [{ terms: ["suggestions", "recommendations"] }],
    traces: [{ terms: ["trace debugger", "traces", "sessions", "debugger"] }],
    updates: [{ terms: ["updates", "update", "release notes"] }],
  };

const LLM_PROVIDER_ICONS: Record<string, ReactNode> = {
  anthropic: <Layers {...S} />,
  openai: <CircleDot {...S} />,
  azure: <Cloud {...S} />,
  "azure-anthropic": <Cloud {...S} />,
  gemini: <Star {...S} />,
  openrouter: <Globe {...S} />,
  ollama: <Box {...S} />,
  groq: <Crosshair {...S} />,
  xai: <AtSign {...S} />,
  kimi: <Sparkles {...S} />,
  bedrock: <Hexagon {...S} />,
  pi: <Pi {...S} />,
  "hf-agents": <Zap {...S} />,
};

const getLLMProviderIcon = (
  providerType: string,
  customEntry?: { compatibility?: string },
) => {
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
  transparencyEffectsEnabled,
  onThemeChange,
  onVisualThemeChange,
  onAccentChange,
  onTransparencyEffectsEnabledChange,
  uiDensity,
  onUiDensityChange,
  devRunLoggingEnabled,
  onDevRunLoggingEnabledChange,
  initialTab = "appearance",
  onShowOnboarding,
  onboardingCompletedAt,
  workspaceId,
  onCreateTask,
  onOpenTask,
  onNavigateToMissionControl,
  onNavigateToAgents,
}: SettingsProps) {
  const normalizedInitialTab: SettingsTab =
    initialTab === "tray" ||
    initialTab === "guardrails" ||
    initialTab === "policies"
      ? "system"
      : initialTab === "skillhub"
        ? "skills"
        : initialTab === "llm" ||
            initialTab === "image" ||
            initialTab === "search"
          ? "aimodels"
          : [
                "queue",
                "subconscious",
                "scheduled",
                "hooks",
                "triggers",
                "council",
              ].includes(initialTab as string)
            ? "automations"
            : ["git", "connectors", "infrastructure"].includes(
                  initialTab as string,
                )
              ? "integrations"
              : initialTab === "controlplane" || initialTab === "webaccess"
                ? "access"
                : (initialTab ?? "appearance");
  const [activeTab, setActiveTab] = useState<SettingsTab>(normalizedInitialTab);
  const [digitalTwinsCompanyId, setDigitalTwinsCompanyId] = useState<
    string | null
  >(null);
  const [activeSecondaryChannel, setActiveSecondaryChannel] =
    useState<SecondaryChannel>("teams");
  const [activeSkillsSubTab, setActiveSkillsSubTab] = useState<
    "custom" | "store"
  >(initialTab === "skillhub" ? "store" : "custom");
  const [activeAIModelsSubTab, setActiveAIModelsSubTab] = useState<
    "llm" | "image" | "video" | "search"
  >(
    initialTab === "search"
      ? "search"
      : initialTab === "image"
        ? "image"
        : "llm",
  );
  const [activeAutomationsSubTab, setActiveAutomationsSubTab] = useState<
    "routines" | "queue" | "subconscious" | "scheduled" | "hooks" | "triggers" | "council"
  >(
    [
      "routines",
      "queue",
      "subconscious",
      "scheduled",
      "hooks",
      "triggers",
      "council",
    ].includes(initialTab as string)
      ? (initialTab as
          | "routines"
          | "queue"
          | "subconscious"
          | "scheduled"
          | "hooks"
          | "triggers"
          | "council")
      : "routines",
  );
  const [activeIntegrationsSubTab, setActiveIntegrationsSubTab] = useState<
    "git" | "connectors" | "identity" | "infrastructure"
  >(
    ["git", "connectors", "identity", "infrastructure"].includes(
      initialTab as string,
    )
      ? (initialTab as "git" | "connectors" | "identity" | "infrastructure")
      : "connectors",
  );
  const [activeAccessSubTab, setActiveAccessSubTab] = useState<
    "controlplane" | "webaccess"
  >(initialTab === "webaccess" ? "webaccess" : "controlplane");
  const [sidebarSearch, setSidebarSearch] = useState("");
  const settingsRef = useRef<LLMSettingsData>({
    providerType: "anthropic",
    modelKey: "sonnet-3-5",
  });
  const [settings, setSettingsState] = useState<LLMSettingsData>(
    settingsRef.current,
  );
  const setSettings = (value: SetStateAction<LLMSettingsData>) => {
    setSettingsState((prev) => {
      const next = typeof value === "function" ? value(prev) : value;
      settingsRef.current = next;
      return next;
    });
  };
  const [models, setModels] = useState<ModelOption[]>([]);
  const [providerRoutingModels, setProviderRoutingModels] = useState<
    ModelOption[]
  >([]);
  const [providerModelOptionsByType, setProviderModelOptionsByType] = useState<
    Record<string, ModelOption[]>
  >({});
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [routingRuntime, setRoutingRuntime] =
    useState<LLMRoutingRuntimeState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [resettingCredentials, setResettingCredentials] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    error?: string;
  } | null>(null);

  const platform =
    window.electronAPI?.getPlatform?.() ??
    (() => {
      if (typeof navigator === "undefined") return "unknown";
      const navPlatform = navigator.platform.toLowerCase();
      if (navPlatform.includes("win")) return "win32";
      if (navPlatform.includes("mac")) return "darwin";
      return "linux";
    })();
  const isMacPlatform = platform === "darwin";
  const getSidebarItemLabel = (item: SidebarItem): string => item.label;
  const normalizeSearchQuery = (value: string): string =>
    value.trim().toLowerCase();
  const matchesSearchQuery = (haystack: string, query: string): boolean => {
    const normalizedQuery = normalizeSearchQuery(query);
    if (!normalizedQuery) return true;
    const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
    return tokens.every((token) => haystack.includes(token));
  };

  const filteredSidebarItems = useMemo(() => {
    return sidebarItems
      .filter((item) => !item.macOnly || isMacPlatform)
      .map((item) => {
        const entries: SidebarSearchEntry[] = [
          {
            terms: [getSidebarItemLabel(item), item.group],
            target: { tab: item.tab },
          },
          ...(sidebarSearchEntries[item.tab] ?? []),
        ];
        const searchBlob = entries
          .flatMap((entry) => entry.terms)
          .join(" ")
          .toLowerCase();
        const matchedEntry = entries.find((entry) =>
          entry.terms.some((term) =>
            matchesSearchQuery(term.toLowerCase(), sidebarSearch),
          ),
        );
        return {
          item,
          matchedTarget: matchedEntry?.target,
          matches: matchesSearchQuery(searchBlob, sidebarSearch),
        };
      })
      .filter((entry) => entry.matches);
  }, [isMacPlatform, sidebarSearch]);

  const handleSidebarItemSelect = useCallback(
    (item: SidebarItem, target?: SidebarSearchTarget) => {
      setActiveTab(target?.tab ?? item.tab);
      if (target?.secondaryChannel) {
        setActiveSecondaryChannel(target.secondaryChannel);
      }
      if (target?.aiModelsSubTab) {
        setActiveAIModelsSubTab(target.aiModelsSubTab);
      }
      if (target?.automationsSubTab) {
        setActiveAutomationsSubTab(target.automationsSubTab);
      }
      if (target?.skillsSubTab) {
        setActiveSkillsSubTab(target.skillsSubTab);
      }
      if (target?.integrationsSubTab) {
        setActiveIntegrationsSubTab(target.integrationsSubTab);
      }
      if (target?.accessSubTab) {
        setActiveAccessSubTab(target.accessSubTab);
      }
    },
    [],
  );
  // Form state for credentials (not persisted directly)
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [anthropicSubscriptionToken, setAnthropicSubscriptionToken] =
    useState("");
  const [anthropicAuthMethod, setAnthropicAuthMethod] = useState<
    "api_key" | "subscription"
  >("api_key");
  const [loadingClaudeModels, setLoadingClaudeModels] = useState(false);
  const [awsRegion, setAwsRegion] = useState("us-east-1");
  const [awsAccessKeyId, setAwsAccessKeyId] = useState("");
  const [awsSecretAccessKey, setAwsSecretAccessKey] = useState("");
  const [awsProfile, setAwsProfile] = useState("");
  const [useDefaultCredentials, setUseDefaultCredentials] = useState(true);

  // Ollama state
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState("http://localhost:11434");
  const [ollamaModel, setOllamaModel] = useState("llama3.2");
  const [ollamaApiKey, setOllamaApiKey] = useState("");
  const [ollamaModels, setOllamaModels] = useState<
    Array<{ name: string; size: number }>
  >([]);
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
  const [openrouterModel, setOpenrouterModel] = useState(
    "anthropic/claude-3.5-sonnet",
  );
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
  const [openaiAuthMethod, setOpenaiAuthMethod] = useState<"api_key" | "oauth">(
    "api_key",
  );
  const [openaiOAuthConnected, setOpenaiOAuthConnected] = useState(false);
  const [openaiOAuthLoading, setOpenaiOAuthLoading] = useState(false);

  type ImageGenProvider = "openai" | "openai-codex" | "azure" | "openrouter" | "gemini";
  type ImageGenModel = "gpt-image-2" | "gpt-image-1.5" | "nano-banana-2";

  // Image generation (text-to-image) state
  const [imageGenDefaultProvider, setImageGenDefaultProvider] = useState<ImageGenProvider | "">(
    "",
  );
  const [imageGenDefaultModel, setImageGenDefaultModel] = useState<ImageGenModel | "">("");
  const [imageGenBackupProvider, setImageGenBackupProvider] = useState<ImageGenProvider | "">("");
  const [imageGenBackupModel, setImageGenBackupModel] = useState<ImageGenModel | "">("");
  const [imageOpenAIApiKey, setImageOpenAIApiKey] = useState("");
  const [imageOpenAIModel, setImageOpenAIModel] = useState("gpt-image-2");
  const [imageAzureApiKey, setImageAzureApiKey] = useState("");
  const [imageAzureEndpoint, setImageAzureEndpoint] = useState("");
  const [imageAzureDeployment, setImageAzureDeployment] = useState("");
  const [imageAzureApiVersion, setImageAzureApiVersion] = useState(
    "2024-02-15-preview",
  );
  const [imageGeminiApiKey, setImageGeminiApiKey] = useState("");
  const [imageGeminiModel, setImageGeminiModel] =
    useState<"nano-banana-2">("nano-banana-2");
  const [imageOpenRouterApiKey, setImageOpenRouterApiKey] = useState("");
  const [imageOpenRouterBaseUrl, setImageOpenRouterBaseUrl] = useState(
    "https://openrouter.ai/api/v1",
  );
  const [imageOpenRouterModel, setImageOpenRouterModel] = useState(
    "openai/gpt-image-2",
  );
  const [imageOpenAICodexModel, setImageOpenAICodexModel] =
    useState("gpt-image-2");
  const [imageOpenAITimeoutSeconds, setImageOpenAITimeoutSeconds] = useState("300");
  const [imageOpenAICodexTimeoutSeconds, setImageOpenAICodexTimeoutSeconds] = useState("300");
  const [imageAzureTimeoutSeconds, setImageAzureTimeoutSeconds] = useState("300");
  const [imageOpenRouterTimeoutSeconds, setImageOpenRouterTimeoutSeconds] = useState("300");
  const [imageGeminiTimeoutSeconds, setImageGeminiTimeoutSeconds] = useState("300");

  // Video generation state
  const [videoDefaultProvider, setVideoDefaultProvider] = useState<
    "openai" | "azure" | "gemini" | "vertex" | "kling" | ""
  >("");
  const [videoFallbackProvider, setVideoFallbackProvider] = useState<
    "openai" | "azure" | "gemini" | "vertex" | "kling" | ""
  >("");
  // OpenAI Sora video config
  const [videoOpenAIModel, setVideoOpenAIModel] = useState("sora-2");
  const [videoOpenAIDuration, setVideoOpenAIDuration] = useState("5");
  const [videoOpenAIAspectRatio, setVideoOpenAIAspectRatio] = useState("16:9");
  const [videoOpenAIResolution, setVideoOpenAIResolution] = useState("720p");
  // Azure Sora video config
  const [videoAzureApiKey, setVideoAzureApiKey] = useState("");
  const [videoAzureEndpoint, setVideoAzureEndpoint] = useState("");
  const [videoAzureDeployment, setVideoAzureDeployment] = useState("");
  const [videoAzureApiVersion, setVideoAzureApiVersion] = useState("preview");
  const [videoAzureDuration, setVideoAzureDuration] = useState("5");
  const [videoAzureAspectRatio, setVideoAzureAspectRatio] = useState("16:9");
  // Gemini Veo config
  const [videoGeminiModel, setVideoGeminiModel] = useState<
    "veo-3.1" | "veo-3.1-fast-preview" | "veo-3.0"
  >("veo-3.1");
  const [videoGeminiDuration, setVideoGeminiDuration] = useState("5");
  const [videoGeminiAspectRatio, setVideoGeminiAspectRatio] = useState("16:9");
  // Vertex AI Veo config
  const [videoVertexModel, setVideoVertexModel] = useState<"veo-3" | "veo-3.1">(
    "veo-3",
  );
  const [videoVertexProjectId, setVideoVertexProjectId] = useState("");
  const [videoVertexLocation, setVideoVertexLocation] = useState("us-central1");
  const [videoVertexOutputGcsUri, setVideoVertexOutputGcsUri] = useState("");
  const [videoVertexAccessToken, setVideoVertexAccessToken] = useState("");
  const [videoVertexDuration, setVideoVertexDuration] = useState("5");
  const [videoVertexAspectRatio, setVideoVertexAspectRatio] = useState("16:9");
  // Kling config
  const [videoKlingApiKey, setVideoKlingApiKey] = useState("");
  const [videoKlingBaseUrl, setVideoKlingBaseUrl] = useState(
    "https://api.klingai.com",
  );
  const [videoKlingModel, setVideoKlingModel] = useState("kling-v2");
  const [videoKlingDuration, setVideoKlingDuration] = useState("5");
  const [videoKlingAspectRatio, setVideoKlingAspectRatio] = useState("16:9");

  // Azure OpenAI state
  const [azureApiKey, setAzureApiKey] = useState("");
  const [azureEndpoint, setAzureEndpoint] = useState("");
  const [azureDeployment, setAzureDeployment] = useState("");
  const [azureDeploymentsText, setAzureDeploymentsText] = useState("");
  const [azureApiVersion, setAzureApiVersion] = useState("2024-02-15-preview");
  const [azureReasoningEffort, setAzureReasoningEffort] =
    useState<AzureReasoningEffort>("medium");

  // Azure Anthropic state
  const [azureAnthropicApiKey, setAzureAnthropicApiKey] = useState("");
  const [azureAnthropicEndpoint, setAzureAnthropicEndpoint] = useState("");
  const [azureAnthropicDeployment, setAzureAnthropicDeployment] = useState("");
  const [azureAnthropicDeploymentsText, setAzureAnthropicDeploymentsText] =
    useState("");
  const [azureAnthropicApiVersion, setAzureAnthropicApiVersion] =
    useState("2023-06-01");

  // Groq state
  const [groqApiKey, setGroqApiKey] = useState("");
  const [groqBaseUrl, setGroqBaseUrl] = useState("");
  const [groqModel, setGroqModel] = useState("llama-3.1-8b-instant");
  const [groqModels, setGroqModels] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [loadingGroqModels, setLoadingGroqModels] = useState(false);

  // xAI state
  const [xaiApiKey, setXaiApiKey] = useState("");
  const [xaiBaseUrl, setXaiBaseUrl] = useState("");
  const [xaiModel, setXaiModel] = useState("grok-4-fast-non-reasoning");
  const [xaiModels, setXaiModels] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [loadingXaiModels, setLoadingXaiModels] = useState(false);

  // Kimi state
  const [kimiApiKey, setKimiApiKey] = useState("");
  const [kimiBaseUrl, setKimiBaseUrl] = useState("");
  const [kimiModel, setKimiModel] = useState("kimi-k2.5");
  const [kimiModels, setKimiModels] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [loadingKimiModels, setLoadingKimiModels] = useState(false);

  // Pi state
  const [piProvider, setPiProvider] = useState("anthropic");
  const [piApiKey, setPiApiKey] = useState("");
  const [piModel, setPiModel] = useState("");
  const [piModels, setPiModels] = useState<
    Array<{ id: string; name: string; description: string }>
  >([]);
  const [piProviders, setPiProviders] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [loadingPiModels, setLoadingPiModels] = useState(false);

  // OpenAI-compatible state
  const [openaiCompatBaseUrl, setOpenaiCompatBaseUrl] = useState("");
  const [openaiCompatApiKey, setOpenaiCompatApiKey] = useState("");
  const [openaiCompatModel, setOpenaiCompatModel] = useState("");
  const [openaiCompatModels, setOpenaiCompatModels] = useState<
    Array<{ key: string; displayName: string; description: string }>
  >([]);
  const [loadingOpenAICompatModels, setLoadingOpenAICompatModels] =
    useState(false);

  // HuggingFace Local AI (hf-agents) state
  const [hfStatus, setHfStatus] = useState<{
    installed: boolean;
    hfInstalled?: boolean;
    version?: string;
    message?: string;
    mlxInstalled?: "ok" | "broken" | false;
    mlxMessage?: string;
    isMac?: boolean;
  } | null>(null);
  const [hfServerStatus, setHfServerStatus] = useState<{
    serverRunning: boolean;
    processAlive: boolean;
    models?: string[];
    lastError?: string | null;
  } | null>(null);
  const [hfHardwareOutput, setHfHardwareOutput] = useState<{
    models: string[];
    modelDetails?: Array<{
      spec: string;
      name: string;
      hasGguf: boolean;
      runtime: string;
      params: string;
      tps: number;
      memoryGb: number;
      quant: string;
      fitLevel: string;
    }>;
    output: string;
  } | null>(null);
  const [detectingHardware, setDetectingHardware] = useState(false);
  const [startingServer, setStartingServer] = useState(false);
  const [stoppingServer, setStoppingServer] = useState(false);
  const [serverLog, setServerLog] = useState<{
    lines: string[];
    state: "idle" | "downloading" | "loading" | "ready" | "error";
    downloadingFile?: string;
  } | null>(null);

  // Custom provider state
  const [customProviders, setCustomProviders] = useState<
    Record<string, CustomProviderConfig>
  >({});
  const [loadingCustomProviderModels, setLoadingCustomProviderModels] =
    useState(false);

  // Bedrock state
  const [bedrockModel, setBedrockModel] = useState("");
  const [bedrockModels, setBedrockModels] = useState<
    Array<{ id: string; name: string; description: string }>
  >([]);
  const [loadingBedrockModels, setLoadingBedrockModels] = useState(false);

  useEffect(() => {
    loadConfigStatus();
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.onLLMRoutingEvent) return;
    const unsubscribe = window.electronAPI.onLLMRoutingEvent((event) => {
      setRoutingRuntime(event);
    });
    return unsubscribe;
  }, []);

  // Poll hf-agents server status when that provider is active
  useEffect(() => {
    if (settings.providerType !== "hf-agents") return;
    const poll = () => {
      window.electronAPI.getLocalAIServerStatus?.().then((result: Any) => {
        if (result) setHfServerStatus(result);
      });
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [settings.providerType]);

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
        ...prev[resolvedType],
        ...updates,
      },
    }));
  };

  const sanitizeFailoverProviders = (
    providers?: LLMProviderFallbackConfig[],
  ): LLMProviderFallbackConfig[] => {
    const normalized: LLMProviderFallbackConfig[] = [];
    const seen = new Set<string>();
    for (const entry of providers || []) {
      const providerType = resolveCustomProviderId(entry.providerType);
      const modelKey = entry.modelKey?.trim();
      if (!providerType) continue;
      const dedupeKey = `${providerType}:${modelKey || ""}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      normalized.push({
        providerType,
        ...(modelKey ? { modelKey } : {}),
      });
    }
    return normalized.slice(0, 5);
  };

  const sanitizeCustomProviders = (
    providers: Record<string, CustomProviderConfig>,
  ) => {
    const sanitized: Record<string, CustomProviderConfig> = {};
    Object.entries(providers).forEach(([key, value]) => {
      const apiKey = value.apiKey?.trim();
      const model = value.model?.trim();
      const baseUrl = value.baseUrl?.trim();
      const cachedModels = Array.isArray(value.cachedModels)
        ? value.cachedModels
            .map((entry) => ({
              key: entry.key?.trim(),
              displayName: entry.displayName?.trim(),
              description: entry.description?.trim(),
            }))
            .filter(
              (entry) =>
                typeof entry.key === "string" &&
                entry.key.length > 0 &&
                typeof entry.displayName === "string" &&
                entry.displayName.length > 0 &&
                typeof entry.description === "string" &&
                entry.description.length > 0,
            )
        : undefined;
      const strongModelKey = value.strongModelKey?.trim();
      const cheapModelKey = value.cheapModelKey?.trim();
      const automatedTaskModelKey = value.automatedTaskModelKey?.trim();
      const hasFallbackProviders = Object.prototype.hasOwnProperty.call(
        value,
        "fallbackProviders",
      );
      const fallbackProviders = sanitizeFailoverProviders(
        value.fallbackProviders,
      );
      const failoverPrimaryRetryCooldownSeconds =
        typeof value.failoverPrimaryRetryCooldownSeconds === "number" &&
        Number.isFinite(value.failoverPrimaryRetryCooldownSeconds)
          ? Math.max(
              0,
              Math.min(
                3600,
                Math.floor(value.failoverPrimaryRetryCooldownSeconds),
              ),
            )
          : undefined;
      const profileRoutingEnabled = value.profileRoutingEnabled === true;
      const preferStrongForVerification =
        typeof value.preferStrongForVerification === "boolean"
          ? value.preferStrongForVerification
          : undefined;
      if (
        apiKey ||
        model ||
        baseUrl ||
        (cachedModels && cachedModels.length > 0) ||
        strongModelKey ||
        cheapModelKey ||
        automatedTaskModelKey ||
        hasFallbackProviders ||
        typeof failoverPrimaryRetryCooldownSeconds === "number" ||
        profileRoutingEnabled ||
        typeof preferStrongForVerification === "boolean"
      ) {
        sanitized[key] = {
          ...(apiKey ? { apiKey } : {}),
          ...(model ? { model } : {}),
          ...(baseUrl ? { baseUrl } : {}),
          ...(cachedModels && cachedModels.length > 0 ? { cachedModels } : {}),
          ...(strongModelKey ? { strongModelKey } : {}),
          ...(cheapModelKey ? { cheapModelKey } : {}),
          ...(automatedTaskModelKey ? { automatedTaskModelKey } : {}),
          ...(hasFallbackProviders ? { fallbackProviders } : {}),
          ...(typeof failoverPrimaryRetryCooldownSeconds === "number"
            ? { failoverPrimaryRetryCooldownSeconds }
            : {}),
          ...(profileRoutingEnabled ? { profileRoutingEnabled: true } : {}),
          ...(typeof preferStrongForVerification === "boolean"
            ? { preferStrongForVerification }
            : {}),
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

  const buildAzureAnthropicSettings = () => {
    const deployments = parseAzureDeployments(azureAnthropicDeploymentsText);
    let deployment = azureAnthropicDeployment.trim();
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

  const getProviderRoutingConfig = (
    providerType: LLMProviderType,
  ): ProviderRoutingConfig => {
    const resolvedType = resolveCustomProviderId(providerType);
    const customEntry = CUSTOM_PROVIDER_MAP.get(resolvedType);
    if (customEntry) {
      return customProviders[resolvedType] || {};
    }

    switch (providerType) {
      case "anthropic":
        return settings.anthropic || {};
      case "bedrock":
        return settings.bedrock || {};
      case "ollama":
        return settings.ollama || {};
      case "gemini":
        return settings.gemini || {};
      case "openrouter":
        return settings.openrouter || {};
      case "openai":
        return settings.openai || {};
      case "azure":
        return settings.azure || {};
      case "azure-anthropic":
        return settings.azureAnthropic || {};
      case "groq":
        return settings.groq || {};
      case "xai":
        return settings.xai || {};
      case "kimi":
        return settings.kimi || {};
      case "pi":
        return settings.pi || {};
      case "openai-compatible":
        return settings.openaiCompatible || {};
      default:
        return {};
    }
  };

  const getProviderFailoverConfig = (
    providerType: LLMProviderType,
  ): Pick<
    ProviderRoutingConfig,
    "fallbackProviders" | "failoverPrimaryRetryCooldownSeconds"
  > => {
    const resolvedType = resolveCustomProviderId(providerType);
    const customEntry = CUSTOM_PROVIDER_MAP.get(resolvedType);
    if (customEntry) {
      const config = customProviders[resolvedType] || {};
      return {
        fallbackProviders:
          Object.prototype.hasOwnProperty.call(config, "fallbackProviders")
            ? config.fallbackProviders
            : settings.fallbackProviders,
        failoverPrimaryRetryCooldownSeconds:
          Object.prototype.hasOwnProperty.call(
            config,
            "failoverPrimaryRetryCooldownSeconds",
          )
            ? config.failoverPrimaryRetryCooldownSeconds
            : settings.failoverPrimaryRetryCooldownSeconds,
      };
    }

    const routing =
      (() => {
        switch (providerType) {
          case "anthropic":
            return settings.anthropic;
          case "bedrock":
            return settings.bedrock;
          case "ollama":
            return settings.ollama;
          case "gemini":
            return settings.gemini;
          case "openrouter":
            return settings.openrouter;
          case "openai":
            return settings.openai;
          case "azure":
            return settings.azure;
          case "azure-anthropic":
            return settings.azureAnthropic;
          case "groq":
            return settings.groq;
          case "xai":
            return settings.xai;
          case "kimi":
            return settings.kimi;
          case "pi":
            return settings.pi;
          case "openai-compatible":
            return settings.openaiCompatible;
          default:
            return undefined;
        }
      })() || {};

    return {
      fallbackProviders:
        Object.prototype.hasOwnProperty.call(routing, "fallbackProviders")
          ? routing.fallbackProviders
          : settings.fallbackProviders,
      failoverPrimaryRetryCooldownSeconds:
        Object.prototype.hasOwnProperty.call(
          routing,
          "failoverPrimaryRetryCooldownSeconds",
        )
          ? routing.failoverPrimaryRetryCooldownSeconds
          : settings.failoverPrimaryRetryCooldownSeconds,
    };
  };

  const setProviderRoutingConfig = (
    providerType: LLMProviderType,
    updates: Partial<ProviderRoutingConfig>,
  ) => {
    const resolvedType = resolveCustomProviderId(providerType);
    const customEntry = CUSTOM_PROVIDER_MAP.get(resolvedType);
    if (customEntry) {
      setCustomProviders((prev) => ({
        ...prev,
        [resolvedType]: {
          ...prev[resolvedType],
          ...updates,
        },
      }));
      return;
    }

    const patchSettings = <T extends keyof LLMSettingsData>(key: T) =>
      setSettings((prev) => ({
        ...prev,
        [key]: {
          ...(prev[key] as Record<string, unknown> | undefined),
          ...updates,
        },
      }));

    switch (providerType) {
      case "anthropic":
        patchSettings("anthropic");
        return;
      case "bedrock":
        patchSettings("bedrock");
        return;
      case "ollama":
        patchSettings("ollama");
        return;
      case "gemini":
        patchSettings("gemini");
        return;
      case "openrouter":
        patchSettings("openrouter");
        return;
      case "openai":
        patchSettings("openai");
        return;
      case "azure":
        patchSettings("azure");
        return;
      case "azure-anthropic":
        patchSettings("azureAnthropic");
        return;
      case "groq":
        patchSettings("groq");
        return;
      case "xai":
        patchSettings("xai");
        return;
      case "kimi":
        patchSettings("kimi");
        return;
      case "pi":
        patchSettings("pi");
        return;
      case "openai-compatible":
        patchSettings("openaiCompatible");
        return;
      default:
        return;
    }
  };

  const getProviderPrimaryModel = (providerType: LLMProviderType): string => {
    const resolvedType = resolveCustomProviderId(providerType);
    const customEntry = CUSTOM_PROVIDER_MAP.get(resolvedType);
    if (customEntry) {
      return (
        customProviders[resolvedType]?.model || customEntry.defaultModel || ""
      );
    }

    switch (providerType) {
      case "anthropic":
        return settings.modelKey || "sonnet-3-5";
      case "bedrock":
        return (
          bedrockModel || settings.bedrock?.model || settings.modelKey || ""
        );
      case "ollama":
        return ollamaModel || settings.ollama?.model || "";
      case "gemini":
        return geminiModel || settings.gemini?.model || "";
      case "openrouter":
        return openrouterModel || settings.openrouter?.model || "";
      case "openai":
        return openaiModel || settings.openai?.model || "";
      case "azure": {
        const azureBuilt = buildAzureSettings();
        return azureBuilt.deployment || settings.azure?.deployment || "";
      }
      case "azure-anthropic": {
        const azureAnthropicBuilt = buildAzureAnthropicSettings();
        return (
          azureAnthropicBuilt.deployment ||
          settings.azureAnthropic?.deployment ||
          ""
        );
      }
      case "groq":
        return groqModel || settings.groq?.model || "";
      case "xai":
        return xaiModel || settings.xai?.model || "";
      case "kimi":
        return kimiModel || settings.kimi?.model || "";
      case "pi":
        return piModel || settings.pi?.model || "";
      case "openai-compatible":
        return openaiCompatModel || settings.openaiCompatible?.model || "";
      default:
        return settings.modelKey || "";
    }
  };

  const getRoutingModelOptions = (
    providerType: LLMProviderType,
  ): ModelOption[] => {
    const routing = getProviderRoutingConfig(providerType);
    const deduped = new Map<string, ModelOption>();
    const addOption = (value?: string, label?: string) => {
      const normalized = value?.trim();
      if (!normalized || deduped.has(normalized)) return;
      deduped.set(normalized, {
        key: normalized,
        displayName: label || normalized,
      });
    };

    providerRoutingModels.forEach((model) =>
      addOption(model.key, model.displayName),
    );
    models.forEach((model) => addOption(model.key, model.displayName));
    addOption(getProviderPrimaryModel(providerType));
    addOption(routing.strongModelKey);
    addOption(routing.cheapModelKey);
    addOption(routing.automatedTaskModelKey);

    return Array.from(deduped.values());
  };

  const loadProviderModelsForType = useCallback(async (
    providerType: LLMProviderType,
    claudeCredentials?: ReturnType<typeof buildClaudeCredentialInput>,
  ): Promise<ModelOption[]> => {
    try {
      const providerModels =
        providerType === "anthropic"
          ? (
              await window.electronAPI.getAnthropicModels(
                claudeCredentials ||
                  buildClaudeCredentialInput({
                    apiKey: anthropicApiKey,
                    subscriptionToken: anthropicSubscriptionToken,
                    authMethod: anthropicAuthMethod,
                  }),
              )
            ).map((model) => ({
              key: model.id,
              displayName: model.displayName,
              description: model.description,
            }))
          : await window.electronAPI.getProviderModels(providerType);
      const normalized = providerModels || [];
      setProviderModelOptionsByType((prev) => ({
        ...prev,
        [providerType]: normalized,
      }));
      return normalized;
    } catch (error) {
      console.error("Failed to load provider models:", error);
      setProviderModelOptionsByType((prev) => ({
        ...prev,
        [providerType]: [],
      }));
      return [];
    }
  }, [anthropicApiKey, anthropicAuthMethod, anthropicSubscriptionToken]);

  const loadProviderRoutingModels = async (
    providerType: LLMProviderType,
    claudeCredentials?: ReturnType<typeof buildClaudeCredentialInput>,
  ) => {
    const providerModels = await loadProviderModelsForType(
      providerType,
      claudeCredentials,
    );
    setProviderRoutingModels(providerModels);
  };

  const loadClaudeModels = async (
    currentModelKeyOverride?: string,
    claudeCredentials?: ReturnType<typeof buildClaudeCredentialInput>,
  ): Promise<ModelOption[]> => {
    try {
      setLoadingClaudeModels(true);
      const models = await window.electronAPI.getAnthropicModels(
        claudeCredentials ||
          buildClaudeCredentialInput({
            apiKey: anthropicApiKey,
            subscriptionToken: anthropicSubscriptionToken,
            authMethod: anthropicAuthMethod,
          }),
      );
      const providerModels = (models || []).map((model) => ({
        key: model.id,
        displayName: model.displayName,
        description: model.description,
      }));
      setProviderModelOptionsByType((prev) => ({
        ...prev,
        anthropic: providerModels,
      }));
      setModels(providerModels);
      const nextModelKey = selectClaudeModelKey(
        providerModels,
        currentModelKeyOverride,
      );
      setSettings((prev) => {
        if (prev.providerType !== "anthropic") return prev;
        if (prev.modelKey === nextModelKey) {
          return prev;
        }
        return {
          ...prev,
          modelKey: nextModelKey,
        };
      });
      onSettingsChanged?.();
      return providerModels;
    } catch (error) {
      console.error("Failed to load Claude models:", error);
      setModels([]);
      return [];
    } finally {
      setLoadingClaudeModels(false);
    }
  };

  const getFailoverModelOptions = (
    providerType: LLMProviderType,
    currentModelKey?: string,
  ): SearchableSelectOption[] => {
    const deduped = new Map<string, SearchableSelectOption>();
    const addOption = (value?: string, label?: string) => {
      const normalized = value?.trim();
      if (!normalized || deduped.has(normalized)) return;
      deduped.set(normalized, {
        value: normalized,
        label: label || normalized,
      });
    };

    for (const model of providerModelOptionsByType[providerType] || []) {
      addOption(model.key, model.displayName);
    }
    addOption(getProviderPrimaryModel(providerType));
    addOption(currentModelKey);

    return Array.from(deduped.values());
  };

  const configuredFallbackProviderOptions = providers.filter(
    (provider) => provider.configured,
  );

  useEffect(() => {
    if (!azureDeployment) {
      const deployments = parseAzureDeployments(azureDeploymentsText);
      if (deployments[0]) {
        setAzureDeployment(deployments[0]);
      }
    }
  }, [azureDeploymentsText, azureDeployment]);

  useEffect(() => {
    if (!azureAnthropicDeployment) {
      const deployments = parseAzureDeployments(azureAnthropicDeploymentsText);
      if (deployments[0]) {
        setAzureAnthropicDeployment(deployments[0]);
      }
    }
  }, [azureAnthropicDeploymentsText, azureAnthropicDeployment]);

  const loadConfigStatus = async () => {
    try {
      setLoading(true);
      // Load config status which includes settings, providers, and models
      const configStatus = await window.electronAPI.getLLMConfigStatus();

      // Set providers
      setProviders(configStatus.providers || []);
      setModels(configStatus.models || []);
      setProviderModelOptionsByType((prev) => ({
        ...prev,
        [configStatus.currentProvider]: configStatus.models || [],
      }));

      // Load full settings separately for bedrock config
      const loadedSettings = await window.electronAPI.getLLMSettings();
      setSettings(loadedSettings);
      if (window.electronAPI?.getLLMRoutingStatus) {
        try {
          setRoutingRuntime(await window.electronAPI.getLLMRoutingStatus());
        } catch (error) {
          console.error("Failed to load LLM routing status:", error);
          setRoutingRuntime(null);
        }
      }
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
      const loadedClaudeAuthMethod = resolveClaudeAuthMethod(
        loadedSettings.anthropic,
      );
      const loadedClaudeCredentials = buildClaudeCredentialInput({
        ...loadedSettings.anthropic,
        authMethod: loadedClaudeAuthMethod,
      });

      if (loadedSettings.anthropic?.apiKey) {
        setAnthropicApiKey(loadedSettings.anthropic.apiKey);
      }
      if (loadedSettings.anthropic?.subscriptionToken) {
        setAnthropicSubscriptionToken(
          loadedSettings.anthropic.subscriptionToken,
        );
      }
      setAnthropicAuthMethod(loadedClaudeAuthMethod);

      await loadProviderRoutingModels(
        loadedSettings.providerType as LLMProviderType,
        loadedClaudeCredentials,
      );
      if (loadedSettings.providerType === "anthropic") {
        const providerModels = await loadClaudeModels(
          loadedSettings.modelKey,
          loadedClaudeCredentials,
        );
        const nextModelKey = selectClaudeModelKey(
          providerModels,
          loadedSettings.modelKey,
        );
        if (nextModelKey && nextModelKey !== loadedSettings.modelKey) {
          setSettings((prev) => ({ ...prev, modelKey: nextModelKey }));
        }
      }

      // Set form state from loaded settings
      if (loadedSettings.bedrock?.region) {
        setAwsRegion(loadedSettings.bedrock.region);
      }
      if (loadedSettings.bedrock?.profile) {
        setAwsProfile(loadedSettings.bedrock.profile);
      }
      setUseDefaultCredentials(
        loadedSettings.bedrock?.useDefaultCredentials ?? true,
      );

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
          if (
            loadedSettings.openai.accessToken ||
            loadedSettings.openai.refreshToken
          ) {
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
          loadedSettings.azure?.deployments &&
          loadedSettings.azure.deployments.length > 0
            ? loadedSettings.azure.deployments
            : loadedSettings.azure?.deployment
              ? [loadedSettings.azure.deployment]
              : [];
        if (loadedDeployments.length > 0) {
          setAzureDeploymentsText(loadedDeployments.join("\n"));
        }
        const selectedDeployment =
          loadedSettings.azure?.deployment || loadedDeployments[0];
        if (selectedDeployment) {
          setAzureDeployment(selectedDeployment);
        }
      }
      if (loadedSettings.azure?.apiVersion) {
        setAzureApiVersion(loadedSettings.azure.apiVersion);
      }
      setAzureReasoningEffort(
        loadedSettings.azure?.reasoningEffort || "medium",
      );

      // Set Azure Anthropic form state
      if (loadedSettings.azureAnthropic?.apiKey) {
        setAzureAnthropicApiKey(loadedSettings.azureAnthropic.apiKey);
      }
      if (loadedSettings.azureAnthropic?.endpoint) {
        setAzureAnthropicEndpoint(loadedSettings.azureAnthropic.endpoint);
      }
      {
        const loadedDeployments =
          loadedSettings.azureAnthropic?.deployments &&
          loadedSettings.azureAnthropic.deployments.length > 0
            ? loadedSettings.azureAnthropic.deployments
            : loadedSettings.azureAnthropic?.deployment
              ? [loadedSettings.azureAnthropic.deployment]
              : [];
        if (loadedDeployments.length > 0) {
          setAzureAnthropicDeploymentsText(loadedDeployments.join("\n"));
        }
        const selectedDeployment =
          loadedSettings.azureAnthropic?.deployment || loadedDeployments[0];
        if (selectedDeployment) {
          setAzureAnthropicDeployment(selectedDeployment);
        }
      }
      if (loadedSettings.azureAnthropic?.apiVersion) {
        setAzureAnthropicApiVersion(loadedSettings.azureAnthropic.apiVersion);
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

      // Image generation (text-to-image) settings
      if (loadedSettings.imageGeneration?.defaultProvider) {
        setImageGenDefaultProvider(loadedSettings.imageGeneration.defaultProvider);
      } else {
        setImageGenDefaultProvider("");
      }
      if (loadedSettings.imageGeneration?.defaultModel) {
        setImageGenDefaultModel(loadedSettings.imageGeneration.defaultModel);
      } else {
        setImageGenDefaultModel("");
      }
      if (loadedSettings.imageGeneration?.backupProvider) {
        setImageGenBackupProvider(loadedSettings.imageGeneration.backupProvider);
      } else {
        setImageGenBackupProvider("");
      }
      if (loadedSettings.imageGeneration?.backupModel) {
        setImageGenBackupModel(loadedSettings.imageGeneration.backupModel);
      } else {
        setImageGenBackupModel("");
      }
      const ig = loadedSettings.imageGeneration;
      setImageOpenAIApiKey(ig?.openai?.apiKey ?? "");
      setImageOpenAIModel(ig?.openai?.model ?? "gpt-image-2");
      setImageAzureApiKey(ig?.azure?.imageApiKey ?? "");
      setImageAzureEndpoint(ig?.azure?.imageEndpoint ?? "");
      setImageAzureDeployment(ig?.azure?.imageDeployment ?? "");
      setImageAzureApiVersion(
        ig?.azure?.imageApiVersion ?? "2024-02-15-preview",
      );
      setImageGeminiApiKey(ig?.gemini?.apiKey ?? "");
      setImageGeminiModel(ig?.gemini?.model ?? "nano-banana-2");
      setImageOpenRouterApiKey(ig?.openrouter?.apiKey ?? "");
      setImageOpenRouterBaseUrl(
        ig?.openrouter?.baseUrl ?? "https://openrouter.ai/api/v1",
      );
      setImageOpenRouterModel(
        ig?.openrouter?.model ?? "openai/gpt-image-2",
      );
      setImageOpenAICodexModel(ig?.openaiCodex?.model ?? "gpt-image-2");
      setImageOpenAITimeoutSeconds(String(ig?.timeouts?.openai ?? 300));
      setImageOpenAICodexTimeoutSeconds(String(ig?.timeouts?.openaiCodex ?? 300));
      setImageAzureTimeoutSeconds(String(ig?.timeouts?.azure ?? 300));
      setImageOpenRouterTimeoutSeconds(String(ig?.timeouts?.openrouter ?? 300));
      setImageGeminiTimeoutSeconds(String(ig?.timeouts?.gemini ?? 300));

      // Video generation settings
      const vg = loadedSettings.videoGeneration;
      if (vg?.defaultProvider) setVideoDefaultProvider(vg.defaultProvider);
      if (vg?.fallbackProvider) setVideoFallbackProvider(vg.fallbackProvider);
      if (vg?.openai?.defaultModel) setVideoOpenAIModel(vg.openai.defaultModel);
      if (vg?.openai?.defaultDuration)
        setVideoOpenAIDuration(String(vg.openai.defaultDuration));
      if (vg?.openai?.defaultAspectRatio)
        setVideoOpenAIAspectRatio(vg.openai.defaultAspectRatio);
      if (vg?.openai?.defaultResolution)
        setVideoOpenAIResolution(vg.openai.defaultResolution);
      if (vg?.azure?.videoApiKey) setVideoAzureApiKey(vg.azure.videoApiKey);
      if (vg?.azure?.videoEndpoint)
        setVideoAzureEndpoint(vg.azure.videoEndpoint);
      if (vg?.azure?.videoDeployment)
        setVideoAzureDeployment(vg.azure.videoDeployment);
      if (vg?.azure?.videoApiVersion)
        setVideoAzureApiVersion(vg.azure.videoApiVersion);
      if (vg?.azure?.defaultDuration)
        setVideoAzureDuration(String(vg.azure.defaultDuration));
      if (vg?.azure?.defaultAspectRatio)
        setVideoAzureAspectRatio(vg.azure.defaultAspectRatio);
      if (vg?.gemini?.defaultModel) setVideoGeminiModel(vg.gemini.defaultModel);
      if (vg?.gemini?.defaultDuration)
        setVideoGeminiDuration(String(vg.gemini.defaultDuration));
      if (vg?.gemini?.defaultAspectRatio)
        setVideoGeminiAspectRatio(vg.gemini.defaultAspectRatio);
      if (vg?.vertex?.model) setVideoVertexModel(vg.vertex.model);
      if (vg?.vertex?.projectId) setVideoVertexProjectId(vg.vertex.projectId);
      if (vg?.vertex?.location) setVideoVertexLocation(vg.vertex.location);
      if (vg?.vertex?.outputGcsUri)
        setVideoVertexOutputGcsUri(vg.vertex.outputGcsUri);
      if (vg?.vertex?.accessToken)
        setVideoVertexAccessToken(vg.vertex.accessToken);
      if (vg?.vertex?.defaultDuration)
        setVideoVertexDuration(String(vg.vertex.defaultDuration));
      if (vg?.vertex?.defaultAspectRatio)
        setVideoVertexAspectRatio(vg.vertex.defaultAspectRatio);
      if (vg?.kling?.apiKey) setVideoKlingApiKey(vg.kling.apiKey);
      if (vg?.kling?.baseUrl) setVideoKlingBaseUrl(vg.kling.baseUrl);
      if (vg?.kling?.model) setVideoKlingModel(vg.kling.model);
      if (vg?.kling?.defaultDuration)
        setVideoKlingDuration(String(vg.kling.defaultDuration));
      if (vg?.kling?.defaultAspectRatio)
        setVideoKlingAspectRatio(vg.kling.defaultAspectRatio);

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
      if (
        loadedSettings.cachedGeminiModels &&
        loadedSettings.cachedGeminiModels.length > 0
      ) {
        setGeminiModels(
          loadedSettings.cachedGeminiModels.map((m: Any) => ({
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
          loadedSettings.cachedOpenRouterModels.map((m: Any) => ({
            id: m.key,
            name: m.displayName,
            context_length: m.contextLength || 0,
          })),
        );
      }
      if (
        loadedSettings.cachedOpenAIModels &&
        loadedSettings.cachedOpenAIModels.length > 0
      ) {
        setOpenaiModels(
          loadedSettings.cachedOpenAIModels.map((m: Any) => ({
            id: m.key,
            name: m.displayName,
            description: m.description || "",
          })),
        );
      }
      if (
        loadedSettings.cachedOllamaModels &&
        loadedSettings.cachedOllamaModels.length > 0
      ) {
        setOllamaModels(
          loadedSettings.cachedOllamaModels.map((m: Any) => ({
            name: m.key,
            size: m.size || 0,
          })),
        );
      }
      if (
        loadedSettings.cachedBedrockModels &&
        loadedSettings.cachedBedrockModels.length > 0
      ) {
        setBedrockModels(
          loadedSettings.cachedBedrockModels.map((m: Any) => ({
            id: m.key,
            name: m.displayName,
            description: m.description || "",
          })),
        );
      }
      if (
        loadedSettings.cachedPiModels &&
        loadedSettings.cachedPiModels.length > 0
      ) {
        setPiModels(
          loadedSettings.cachedPiModels.map((m: Any) => ({
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
      const models = await window.electronAPI.getOllamaModels(
        baseUrl || ollamaBaseUrl,
      );
      console.log(
        `[Settings] Loaded ${models?.length || 0} Ollama models`,
        models,
      );
      setOllamaModels(models || []);
      // If we got models and current model isn't in the list, select the first one
      if (
        models &&
        models.length > 0 &&
        !models.some((m) => m.name === ollamaModel)
      ) {
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
      const models = await window.electronAPI.getGeminiModels(
        apiKey || geminiApiKey,
      );
      setGeminiModels(models || []);
      // If we got models and current model isn't in the list, select the first one
      if (
        models &&
        models.length > 0 &&
        !models.some((m) => m.name === geminiModel)
      ) {
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
      if (
        models &&
        models.length > 0 &&
        !models.some((m) => m.id === openrouterModel)
      ) {
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
      const models = await window.electronAPI.getOpenAIModels(
        apiKey || openaiApiKey,
      );
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
      if (
        models &&
        models.length > 0 &&
        !models.some((m) => m.id === groqModel)
      ) {
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
      if (
        models &&
        models.length > 0 &&
        !models.some((m) => m.id === xaiModel)
      ) {
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
      if (
        models &&
        models.length > 0 &&
        !models.some((m) => m.id === kimiModel)
      ) {
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
      if (
        models &&
        models.length > 0 &&
        !models.some((m) => m.id === piModel)
      ) {
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

  const loadOpenAICompatibleModels = async (
    baseUrl?: string,
    apiKey?: string,
  ) => {
    try {
      setLoadingOpenAICompatModels(true);
      const resolvedBaseUrl = baseUrl || openaiCompatBaseUrl;
      if (!resolvedBaseUrl) return;
      const models = await window.electronAPI.getOpenAICompatibleModels(
        resolvedBaseUrl,
        apiKey || openaiCompatApiKey || undefined,
      );
      setOpenaiCompatModels(models || []);
      if (
        models &&
        models.length > 0 &&
        !models.some((m) => m.key === openaiCompatModel)
      ) {
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

  const loadCustomProviderModels = async (providerType: LLMProviderType) => {
    const resolvedType = resolveCustomProviderId(providerType);
    const customEntry = CUSTOM_PROVIDER_MAP.get(resolvedType);
    if (!customEntry) return;

    try {
      setLoadingCustomProviderModels(true);
      setTestResult(null);
      const currentConfig = customProviders[resolvedType] || {};
      const models = await window.electronAPI.refreshCustomProviderModels(
        resolvedType,
        {
          apiKey: currentConfig.apiKey,
          baseUrl: currentConfig.baseUrl || customEntry.baseUrl,
        },
      );

      setCustomProviders((prev) => {
        const existing = prev[resolvedType] || {};
        const nextModel =
          existing.model && models.some((entry) => entry.key === existing.model)
            ? existing.model
            : models[0]?.key || existing.model;

        return {
          ...prev,
          [resolvedType]: {
            ...existing,
            ...(nextModel ? { model: nextModel } : {}),
            cachedModels: models,
          },
        };
      });
      setTestResult({
        success: true,
        error:
          models.length > 0
            ? undefined
            : `No models returned for ${customEntry.name}. Keeping the current/default model list.`,
      });
      onSettingsChanged?.();
    } catch (error) {
      console.error(`Failed to load models for ${customEntry.name}:`, error);
      setTestResult({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : `Failed to load models for ${customEntry.name}`,
      });
    } finally {
      setLoadingCustomProviderModels(false);
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

    const currentRouting = getProviderRoutingConfig(providerType);
    const providerPrimaryModel = getProviderPrimaryModel(providerType);
    if (
      providerPrimaryModel &&
      (!currentRouting.strongModelKey || !currentRouting.cheapModelKey)
    ) {
      setProviderRoutingConfig(providerType, {
        strongModelKey: currentRouting.strongModelKey || providerPrimaryModel,
        cheapModelKey: currentRouting.cheapModelKey || providerPrimaryModel,
        preferStrongForVerification:
          typeof currentRouting.preferStrongForVerification === "boolean"
            ? currentRouting.preferStrongForVerification
            : true,
      });
    }
    void loadProviderRoutingModels(providerType);

    if (providerType === "ollama") {
      loadOllamaModels();
    } else if (providerType === "anthropic") {
      loadClaudeModels(settingsRef.current.modelKey);
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
    } else if (providerType === "hf-agents") {
      window.electronAPI.checkHf?.().then((result: Any) => {
        if (result) setHfStatus(result);
      });
      window.electronAPI.getLocalAIServerStatus?.().then((result: Any) => {
        if (result) setHfServerStatus(result);
      });
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
        setTestResult({
          success: false,
          error: result.error || "OAuth failed",
        });
      }
    } catch (error: Any) {
      console.error("OpenAI OAuth error:", error);
      setTestResult({ success: false, error: error.message || "OAuth failed" });
    } finally {
      setOpenaiOAuthLoading(false);
    }
  };

  const handleHfDetectHardware = async () => {
    setDetectingHardware(true);
    try {
      const result = await window.electronAPI.detectHardware?.();
      setHfHardwareOutput(result || { models: [], output: "" });
    } catch (err: Any) {
      setHfHardwareOutput({
        models: [],
        output: err.message || "Detection failed",
      });
    } finally {
      setDetectingHardware(false);
    }
  };

  const handleHfStartServer = async () => {
    setStartingServer(true);
    try {
      const model = customProviders["hf-agents"]?.model;
      const result = await window.electronAPI.startLocalAIServer?.(model);
      if (result && !result.ok && result.error) {
        // Show error in the server log panel — NOT in hfHardwareOutput
        setServerLog({ lines: result.error.split("\n"), state: "error" });
        setStartingServer(false);
        return;
      }
      // Poll status + log every 2s while the process is alive
      // (model may be downloading — could take many minutes)
      let pollCount = 0;
      const maxPolls = 450; // 15 min max at 2s intervals
      const poll = async () => {
        const [status, log] = await Promise.all([
          window.electronAPI.getLocalAIServerStatus?.(),
          window.electronAPI.getLocalAIServerLog?.(),
        ]);
        if (status) setHfServerStatus(status);
        if (log) setServerLog(log);
        if (
          status?.serverRunning ||
          !status?.processAlive ||
          pollCount >= maxPolls
        ) {
          if (status?.serverRunning) setServerLog(null); // clear log panel on success
          setStartingServer(false);
          return;
        }
        pollCount++;
        setTimeout(poll, 2000);
      };
      setTimeout(poll, 2000);
    } catch (err: Any) {
      setHfHardwareOutput((prev) => ({
        ...(prev ?? { models: [], modelDetails: [] }),
        output: `Error: ${(err as Any)?.message || "Unknown error"}`,
      }));
      setStartingServer(false);
    }
  };

  const handleHfStopServer = async () => {
    setStoppingServer(true);
    setServerLog(null);
    try {
      await window.electronAPI.stopLocalAIServer?.();
      const status = await window.electronAPI.getLocalAIServerStatus?.();
      if (status) setHfServerStatus(status);
    } finally {
      setStoppingServer(false);
    }
  };

  const handleOpenAIOAuthLogout = async () => {
    try {
      setOpenaiOAuthLoading(true);
      await window.electronAPI.openaiOAuthLogout();
      setOpenaiOAuthConnected(false);
      setOpenaiAuthMethod("api_key");
      onSettingsChanged?.();
    } catch (error: Any) {
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
      if (
        currentModel &&
        !normalizedModels.some((m: Any) => m.id === currentModel)
      ) {
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
      const rawMessage =
        error instanceof Error ? error.message : String(error || "");
      if (
        rawMessage.includes("Could not load credentials from any providers")
      ) {
        setTestResult({
          success: false,
          error:
            "Bedrock credentials were cleared. Configure AWS credentials via default chain (~/.aws/credentials, env vars, or IAM role) or enter access key + secret key, then refresh models.",
        });
      } else {
        setTestResult({
          success: false,
          error: rawMessage || "Failed to load Bedrock models.",
        });
      }
    } finally {
      setLoadingBedrockModels(false);
    }
  };

  const clearProviderFormState = (providerType: LLMProviderType) => {
    switch (providerType) {
      case "anthropic":
        setAnthropicApiKey("");
        setAnthropicSubscriptionToken("");
        setAnthropicAuthMethod("api_key");
        break;
      case "bedrock":
        setAwsRegion("us-east-1");
        setAwsAccessKeyId("");
        setAwsSecretAccessKey("");
        setAwsProfile("");
        setUseDefaultCredentials(true);
        setBedrockModel("");
        setBedrockModels([]);
        break;
      case "ollama":
        setOllamaBaseUrl("http://localhost:11434");
        setOllamaModel("llama3.2");
        setOllamaApiKey("");
        setOllamaModels([]);
        break;
      case "gemini":
        setGeminiApiKey("");
        setGeminiModel("gemini-2.0-flash");
        setGeminiModels([]);
        break;
      case "openrouter":
        setOpenrouterApiKey("");
        setOpenrouterBaseUrl("");
        setOpenrouterModel("anthropic/claude-3.5-sonnet");
        setOpenrouterModels([]);
        break;
      case "openai":
        setOpenaiApiKey("");
        setOpenaiModel("gpt-4o-mini");
        setOpenaiModels([]);
        setOpenaiAuthMethod("api_key");
        setOpenaiOAuthConnected(false);
        break;
      case "azure":
        setAzureApiKey("");
        setAzureEndpoint("");
        setAzureDeployment("");
        setAzureDeploymentsText("");
        setAzureApiVersion("2024-02-15-preview");
        setAzureReasoningEffort("medium");
        break;
      case "azure-anthropic":
        setAzureAnthropicApiKey("");
        setAzureAnthropicEndpoint("");
        setAzureAnthropicDeployment("");
        setAzureAnthropicDeploymentsText("");
        setAzureAnthropicApiVersion("2023-06-01");
        break;
      case "groq":
        setGroqApiKey("");
        setGroqBaseUrl("");
        setGroqModel("llama-3.1-8b-instant");
        setGroqModels([]);
        break;
      case "xai":
        setXaiApiKey("");
        setXaiBaseUrl("");
        setXaiModel("grok-4-fast-non-reasoning");
        setXaiModels([]);
        break;
      case "kimi":
        setKimiApiKey("");
        setKimiBaseUrl("");
        setKimiModel("kimi-k2.5");
        setKimiModels([]);
        break;
      case "pi":
        setPiProvider("anthropic");
        setPiApiKey("");
        setPiModel("");
        setPiModels([]);
        break;
      case "openai-compatible":
        setOpenaiCompatBaseUrl("");
        setOpenaiCompatApiKey("");
        setOpenaiCompatModel("");
        setOpenaiCompatModels([]);
        break;
      default:
        setCustomProviders((prev) => {
          const next = { ...prev };
          delete next[providerType];
          if (providerType === "kimi-code") {
            delete next["kimi-coding"];
          }
          return next;
        });
        break;
    }
  };

  const handleResetProviderCredentials = async () => {
    try {
      setResettingCredentials(true);
      setTestResult(null);

      const providerType = resolveCustomProviderId(
        settings.providerType as LLMProviderType,
      );
      await window.electronAPI.resetLLMProviderCredentials(providerType);

      clearProviderFormState(providerType);
      await loadConfigStatus();
      onSettingsChanged?.();
    } catch (error: Any) {
      console.error("Failed to reset provider credentials:", error);
      setTestResult({
        success: false,
        error: error?.message || "Failed to reset provider credentials",
      });
    } finally {
      setResettingCredentials(false);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setTestResult(null);

      const currentSettings = settingsRef.current;
      const sanitizedCustomProviders =
        sanitizeCustomProviders(customProviders) || {};
      const resolvedProviderTypeForSave = resolveCustomProviderId(
        currentSettings.providerType as LLMProviderType,
      );
      const selectedCustomEntry = CUSTOM_PROVIDER_MAP.get(
        resolvedProviderTypeForSave,
      );
      if (selectedCustomEntry) {
        const existing =
          sanitizedCustomProviders[resolvedProviderTypeForSave] || {};
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
      const azureAnthropicSettings = buildAzureAnthropicSettings();
      const routingFor = (
        providerType: LLMProviderType,
      ): ProviderRoutingConfig => {
        const routing = getProviderRoutingConfig(providerType);
        const strongModelKey = routing.strongModelKey?.trim();
        const cheapModelKey = routing.cheapModelKey?.trim();
        const automatedTaskModelKey = routing.automatedTaskModelKey?.trim();
        return {
          profileRoutingEnabled: routing.profileRoutingEnabled === true,
          strongModelKey: strongModelKey || undefined,
          cheapModelKey: cheapModelKey || undefined,
          automatedTaskModelKey: automatedTaskModelKey || undefined,
          preferStrongForVerification:
            typeof routing.preferStrongForVerification === "boolean"
            ? routing.preferStrongForVerification
            : true,
        };
      };
      const failoverFor = (
        providerType: LLMProviderType,
      ): Pick<
        ProviderRoutingConfig,
        "fallbackProviders" | "failoverPrimaryRetryCooldownSeconds"
      > => {
        const failover = getProviderFailoverConfig(providerType);
        const fallbackProviders =
          failover.fallbackProviders !== undefined
            ? sanitizeFailoverProviders(failover.fallbackProviders)
            : undefined;
        const cooldown =
          typeof failover.failoverPrimaryRetryCooldownSeconds === "number" &&
          Number.isFinite(failover.failoverPrimaryRetryCooldownSeconds)
            ? Math.max(
                0,
                Math.min(
                  3600,
                  Math.floor(failover.failoverPrimaryRetryCooldownSeconds),
                ),
              )
            : undefined;
        return {
          ...(fallbackProviders !== undefined
            ? { fallbackProviders }
            : {}),
          ...(typeof cooldown === "number"
            ? { failoverPrimaryRetryCooldownSeconds: cooldown }
            : {}),
        };
      };
      const anthropicCredentialSettings = {
        apiKey: anthropicApiKey || undefined,
        subscriptionToken: anthropicSubscriptionToken || undefined,
        authMethod: anthropicAuthMethod,
      };
      const imageTimeoutSeconds = (value: string): number | undefined => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
        return Math.min(1800, Math.max(30, Math.round(parsed)));
      };

      // Always save settings for ALL providers to preserve API keys and model selections
      // when switching between providers
      const settingsToSave: LLMSettingsData = {
        ...currentSettings,
        // Always include anthropic settings
        anthropic: {
          ...anthropicCredentialSettings,
          ...routingFor("anthropic"),
          ...failoverFor("anthropic"),
        },
        // Always include bedrock settings
        bedrock: {
          region: awsRegion,
          useDefaultCredentials,
          model: bedrockModel || undefined,
          ...routingFor("bedrock"),
          ...failoverFor("bedrock"),
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
          ...routingFor("ollama"),
          ...failoverFor("ollama"),
        },
        // Always include gemini settings
        gemini: {
          apiKey: geminiApiKey || undefined,
          model: geminiModel || undefined,
          ...routingFor("gemini"),
          ...failoverFor("gemini"),
        },
        // Always include openrouter settings
        openrouter: {
          apiKey: openrouterApiKey || undefined,
          model: openrouterModel || undefined,
          baseUrl: openrouterBaseUrl || undefined,
          ...routingFor("openrouter"),
          ...failoverFor("openrouter"),
        },
        // Always include openai settings
        openai: {
          apiKey:
            openaiAuthMethod === "api_key"
              ? openaiApiKey || undefined
              : undefined,
          model: openaiModel || undefined,
          authMethod: openaiAuthMethod,
          ...routingFor("openai"),
          ...failoverFor("openai"),
        },
        // Always include Azure OpenAI settings
        azure: {
          apiKey: azureApiKey || undefined,
          endpoint: azureEndpoint || undefined,
          deployment: azureSettings.deployment,
          deployments: azureSettings.deployments,
          apiVersion: azureApiVersion || undefined,
          reasoningEffort: azureReasoningEffort,
          ...routingFor("azure"),
          ...failoverFor("azure"),
        },
        // Always include Azure Anthropic settings
        azureAnthropic: {
          apiKey: azureAnthropicApiKey || undefined,
          endpoint: azureAnthropicEndpoint || undefined,
          deployment: azureAnthropicSettings.deployment,
          deployments: azureAnthropicSettings.deployments,
          apiVersion: azureAnthropicApiVersion || undefined,
          ...routingFor("azure-anthropic"),
          ...failoverFor("azure-anthropic"),
        },
        // Always include Groq settings
        groq: {
          apiKey: groqApiKey || undefined,
          model: groqModel || undefined,
          baseUrl: groqBaseUrl || undefined,
          ...routingFor("groq"),
          ...failoverFor("groq"),
        },
        // Always include xAI settings
        xai: {
          apiKey: xaiApiKey || undefined,
          model: xaiModel || undefined,
          baseUrl: xaiBaseUrl || undefined,
          ...routingFor("xai"),
          ...failoverFor("xai"),
        },
        // Always include Kimi settings
        kimi: {
          apiKey: kimiApiKey || undefined,
          model: kimiModel || undefined,
          baseUrl: kimiBaseUrl || undefined,
          ...routingFor("kimi"),
          ...failoverFor("kimi"),
        },
        // Always include Pi settings
        pi: {
          provider: piProvider || undefined,
          apiKey: piApiKey || undefined,
          model: piModel || undefined,
          ...routingFor("pi"),
          ...failoverFor("pi"),
        },
        // Always include OpenAI-compatible settings
        openaiCompatible: {
          baseUrl: openaiCompatBaseUrl || undefined,
          apiKey: openaiCompatApiKey || undefined,
          model: openaiCompatModel || undefined,
          ...routingFor("openai-compatible"),
          ...failoverFor("openai-compatible"),
        },
        imageGeneration:
          imageGenDefaultProvider ||
          imageGenDefaultModel ||
          imageGenBackupProvider ||
          imageGenBackupModel ||
          imageOpenAIApiKey ||
          imageOpenAIModel ||
          imageAzureApiKey ||
          imageAzureEndpoint ||
          imageAzureDeployment ||
          imageAzureApiVersion ||
          imageGeminiApiKey ||
          imageGeminiModel ||
          imageOpenRouterApiKey ||
          imageOpenRouterBaseUrl ||
          imageOpenRouterModel ||
          imageOpenAICodexModel ||
          imageOpenAITimeoutSeconds ||
          imageOpenAICodexTimeoutSeconds ||
          imageAzureTimeoutSeconds ||
          imageOpenRouterTimeoutSeconds ||
          imageGeminiTimeoutSeconds
            ? {
                defaultProvider: imageGenDefaultProvider || undefined,
                defaultModel: imageGenDefaultModel || undefined,
                backupProvider: imageGenBackupProvider || undefined,
                backupModel: imageGenBackupModel || undefined,
                timeouts: {
                  openai: imageTimeoutSeconds(imageOpenAITimeoutSeconds),
                  openaiCodex: imageTimeoutSeconds(imageOpenAICodexTimeoutSeconds),
                  azure: imageTimeoutSeconds(imageAzureTimeoutSeconds),
                  openrouter: imageTimeoutSeconds(imageOpenRouterTimeoutSeconds),
                  gemini: imageTimeoutSeconds(imageGeminiTimeoutSeconds),
                },
                openai: {
                  apiKey: imageOpenAIApiKey || undefined,
                  model: imageOpenAIModel || undefined,
                },
                azure: {
                  imageApiKey: imageAzureApiKey || undefined,
                  imageEndpoint: imageAzureEndpoint || undefined,
                  imageDeployment: imageAzureDeployment || undefined,
                  imageApiVersion: imageAzureApiVersion || undefined,
                },
                gemini: {
                  apiKey: imageGeminiApiKey || undefined,
                  model: imageGeminiModel || undefined,
                },
                openrouter: {
                  apiKey: imageOpenRouterApiKey || undefined,
                  baseUrl: imageOpenRouterBaseUrl || undefined,
                  model: imageOpenRouterModel || undefined,
                },
                openaiCodex: {
                  model: imageOpenAICodexModel || undefined,
                },
              }
            : undefined,
        videoGeneration: {
          defaultProvider: videoDefaultProvider || undefined,
          fallbackProvider: videoFallbackProvider || undefined,
          openai: {
            defaultModel: videoOpenAIModel || undefined,
            defaultDuration: videoOpenAIDuration
              ? Number(videoOpenAIDuration)
              : undefined,
            defaultAspectRatio:
              (videoOpenAIAspectRatio as "16:9" | "9:16" | "1:1") || undefined,
            defaultResolution:
              (videoOpenAIResolution as "480p" | "720p" | "1080p") || undefined,
          },
          azure: {
            videoApiKey: videoAzureApiKey || undefined,
            videoEndpoint: videoAzureEndpoint || undefined,
            videoDeployment: videoAzureDeployment || undefined,
            videoApiVersion: videoAzureApiVersion || undefined,
            defaultDuration: videoAzureDuration
              ? Number(videoAzureDuration)
              : undefined,
            defaultAspectRatio:
              (videoAzureAspectRatio as "16:9" | "9:16" | "1:1") || undefined,
          },
          gemini: {
            defaultModel: videoGeminiModel || undefined,
            defaultDuration: videoGeminiDuration
              ? Number(videoGeminiDuration)
              : undefined,
            defaultAspectRatio:
              (videoGeminiAspectRatio as "16:9" | "9:16" | "1:1") || undefined,
          },
          vertex: {
            model: videoVertexModel || undefined,
            projectId: videoVertexProjectId || undefined,
            location: videoVertexLocation || undefined,
            outputGcsUri: videoVertexOutputGcsUri || undefined,
            accessToken: videoVertexAccessToken || undefined,
            defaultDuration: videoVertexDuration
              ? Number(videoVertexDuration)
              : undefined,
            defaultAspectRatio:
              (videoVertexAspectRatio as "16:9" | "9:16" | "1:1") || undefined,
          },
          kling: {
            apiKey: videoKlingApiKey || undefined,
            baseUrl: videoKlingBaseUrl || undefined,
            model: videoKlingModel || undefined,
            defaultDuration: videoKlingDuration
              ? Number(videoKlingDuration)
              : undefined,
            defaultAspectRatio:
              (videoKlingAspectRatio as "16:9" | "9:16" | "1:1") || undefined,
          },
        },
        customProviders:
          Object.keys(sanitizedCustomProviders).length > 0
            ? sanitizedCustomProviders
            : undefined,
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

      const sanitizedCustomProviders =
        sanitizeCustomProviders(customProviders) || {};
      const azureSettings = buildAzureSettings();
      const azureAnthropicSettings = buildAzureAnthropicSettings();
      const anthropicCredentialSettings = {
        apiKey: anthropicApiKey || undefined,
        subscriptionToken: anthropicSubscriptionToken || undefined,
        authMethod: anthropicAuthMethod,
      };

      const testConfig = {
        providerType: settings.providerType,
        modelKey: settings.modelKey,
        anthropic:
          settings.providerType === "anthropic"
            ? anthropicCredentialSettings
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
                apiKey:
                  openaiAuthMethod === "api_key"
                    ? openaiApiKey || undefined
                    : undefined,
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
                reasoningEffort: azureReasoningEffort,
              }
            : undefined,
        azureAnthropic:
          settings.providerType === "azure-anthropic"
            ? {
                apiKey: azureAnthropicApiKey || undefined,
                endpoint: azureAnthropicEndpoint || undefined,
                deployment: azureAnthropicSettings.deployment,
                deployments: azureAnthropicSettings.deployments,
                apiVersion: azureAnthropicApiVersion || undefined,
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
          Object.keys(sanitizedCustomProviders).length > 0
            ? sanitizedCustomProviders
            : undefined,
      };

      const result = await window.electronAPI.testLLMProvider(testConfig);
      setTestResult(result);
    } catch (error: Any) {
      setTestResult({ success: false, error: error.message });
    } finally {
      setTesting(false);
    }
  };

  const renderModelSettingsActions = (options?: {
    includeProviderActions?: boolean;
  }) => (
    <div className="settings-actions">
      {options?.includeProviderActions && (
        <>
          <button
            className="button-secondary"
            onClick={handleTestConnection}
            disabled={loading || testing || resettingCredentials}
          >
            {testing ? "Testing..." : "Test Connection"}
          </button>
          <button
            className="button-secondary"
            onClick={handleResetProviderCredentials}
            disabled={loading || saving || testing || resettingCredentials}
          >
            {resettingCredentials
              ? "Resetting..."
              : "Reset Provider Credentials"}
          </button>
        </>
      )}
      <button
        className="button-primary"
        onClick={handleSave}
        disabled={loading || saving || resettingCredentials}
      >
        {saving ? "Saving..." : "Save Settings"}
      </button>
    </div>
  );

  const currentProviderType = settings.providerType as LLMProviderType;
  const resolvedProviderType = resolveCustomProviderId(currentProviderType);
  const selectedCustomProvider = CUSTOM_PROVIDER_MAP.get(resolvedProviderType);
  const selectedCustomConfig = selectedCustomProvider
    ? customProviders[resolvedProviderType] || {}
    : {};
  const selectedCustomModels = selectedCustomConfig.cachedModels || [];
  const currentProviderLabel =
    providers.find((provider) => provider.type === currentProviderType)?.name ||
    currentProviderType;
  const providerRouting = getProviderRoutingConfig(currentProviderType);
  const providerFailover = getProviderFailoverConfig(currentProviderType);
  const currentFailoverProviders = providerFailover.fallbackProviders || [];
  const updateCurrentFailoverProviders = (
    updater: (prev: LLMProviderFallbackConfig[]) => LLMProviderFallbackConfig[],
  ) => {
    setProviderRoutingConfig(currentProviderType, {
      fallbackProviders: updater(currentFailoverProviders),
    });
  };
  const routingEnabled = providerRouting.profileRoutingEnabled === true;
  const providerPrimaryModel = getProviderPrimaryModel(currentProviderType);
  const strongRoutingModel =
    providerRouting.strongModelKey || providerPrimaryModel;
  const cheapRoutingModel =
    providerRouting.cheapModelKey || providerPrimaryModel;
  const automatedTaskRoutingModel = providerRouting.automatedTaskModelKey || "";
  const routingModelOptions = getRoutingModelOptions(currentProviderType);
  const routingModelsIdentical =
    routingEnabled &&
    !!strongRoutingModel &&
    !!cheapRoutingModel &&
    strongRoutingModel === cheapRoutingModel;

  useEffect(() => {
    for (const entry of providerFailover.fallbackProviders || []) {
      if (!providerModelOptionsByType[entry.providerType]) {
        void loadProviderModelsForType(entry.providerType);
      }
    }
  }, [
    currentProviderType,
    providerFailover.fallbackProviders,
    loadProviderModelsForType,
    providerModelOptionsByType,
  ]);

  const activeImageTab = imageGenDefaultProvider || "openai";

  const imageProviders = [
    {
      type: "openai" as const,
      name: "OpenAI Image",
      icon: <CircleDot {...S} />,
    },
    { type: "azure" as const, name: "Azure Image", icon: <Cloud {...S} /> },
    { type: "gemini" as const, name: "Gemini Image", icon: <Star {...S} /> },
    {
      type: "openrouter" as const,
      name: "OpenRouter",
      icon: <Globe {...S} />,
    },
    {
      type: "openai-codex" as const,
      name: "OpenAI OAuth",
      icon: <Sparkles {...S} />,
    },
  ];

  const getImageProviderModel = (provider: ImageGenProvider): ImageGenModel =>
    provider === "gemini" ? "nano-banana-2" : "gpt-image-2";

  const getImageModelLabel = (model: ImageGenModel): string =>
    model === "nano-banana-2"
      ? "nano-banana-2 (Gemini 3.1 Flash Image)"
      : model;

  const renderImageTimeoutField = (
    value: string,
    onChange: (value: string) => void,
  ) => (
    <>
      <label className="settings-label" style={{ marginTop: "8px" }}>
        Timeout before fallback (seconds)
      </label>
      <input
        className="settings-input"
        type="number"
        min="30"
        max="1800"
        step="1"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <p className="settings-hint">
        The next image provider or deployment is tried only after this timeout.
      </p>
    </>
  );

  const selectImageDefaultProvider = (provider: ImageGenProvider) => {
    setImageGenDefaultProvider(provider);
    const compatibleModel = getImageProviderModel(provider);
    if (
      imageGenDefaultModel &&
      imageGenDefaultModel !== compatibleModel
    ) {
      setImageGenDefaultModel(compatibleModel);
    }
  };

  const selectImageBackupProvider = (provider: ImageGenProvider | "") => {
    setImageGenBackupProvider(provider);
    if (!provider) return;
    const compatibleModel = getImageProviderModel(provider);
    if (imageGenBackupModel && imageGenBackupModel !== compatibleModel) {
      setImageGenBackupModel(compatibleModel);
    }
  };

  const activeVideoTab = videoDefaultProvider || "openai";

  const videoProviders = [
    {
      type: "openai" as const,
      name: "OpenAI Sora",
      icon: <CircleDot {...S} />,
    },
    { type: "azure" as const, name: "Azure Sora", icon: <Cloud {...S} /> },
    { type: "gemini" as const, name: "Gemini Veo", icon: <Star {...S} /> },
    {
      type: "vertex" as const,
      name: "Vertex AI Veo",
      icon: <Hexagon {...S} />,
    },
    { type: "kling" as const, name: "Kling", icon: <Zap {...S} /> },
  ];

  const renderImagePanel = () => (
    <div className="llm-provider-panel">
      <div className="llm-provider-header">
        <h2>Image Provider</h2>
        <p className="settings-description">
          Choose which service to use for image generation. The selected
          provider will be used by the image creation tool.
        </p>
      </div>
      <div className="llm-provider-tabs">
        {imageProviders.map((provider) => (
          <button
            key={provider.type}
            type="button"
            className={`llm-provider-tab ${activeImageTab === provider.type ? "active" : ""}`}
            onClick={() => selectImageDefaultProvider(provider.type)}
          >
            {provider.icon}
            <span className="llm-provider-tab-label">{provider.name}</span>
          </button>
        ))}
      </div>
      <div className="llm-provider-content">
        {activeImageTab === "openai" && (
          <div className="settings-section">
            <h3>OpenAI GPT Image</h3>
            <p className="settings-hint">
              Optionally use a dedicated API key for image generation. Leave
              blank to reuse the OpenAI API key from AI Model.
            </p>
            <label className="settings-label">
              API Key (image-specific, optional)
            </label>
            <input
              className="settings-input"
              type="password"
              placeholder="Leave blank to use the OpenAI API key"
              value={imageOpenAIApiKey}
              onChange={(e) => setImageOpenAIApiKey(e.target.value)}
            />
            <label className="settings-label">Default model</label>
            <select
              className="settings-select"
              value={imageOpenAIModel}
              onChange={(e) => {
                setImageOpenAIModel(e.target.value);
                setImageGenDefaultModel(
                  e.target.value === "gpt-image-2" ? "gpt-image-2" : "gpt-image-1.5",
                );
              }}
            >
              <option value="gpt-image-2">gpt-image-2</option>
              <option value="gpt-image-1.5">gpt-image-1.5</option>
              <option value="gpt-image-1">gpt-image-1</option>
              <option value="dall-e-3">dall-e-3</option>
              <option value="dall-e-2">dall-e-2</option>
            </select>
            {renderImageTimeoutField(imageOpenAITimeoutSeconds, setImageOpenAITimeoutSeconds)}
          </div>
        )}

        {activeImageTab === "azure" && (
          <div className="settings-section">
            <h3>Azure OpenAI Image</h3>
            <p className="settings-hint">
              Optionally use a dedicated Azure resource for image generation.
              Leave credentials blank to reuse the Azure chat credentials from
              AI Model.
            </p>
            <label className="settings-label">
              API Key (image-specific, optional)
            </label>
            <input
              className="settings-input"
              type="password"
              placeholder="Leave blank to use the Azure chat API key"
              value={imageAzureApiKey}
              onChange={(e) => setImageAzureApiKey(e.target.value)}
            />
            <label className="settings-label" style={{ marginTop: "8px" }}>
              Endpoint (image-specific, optional)
            </label>
            <input
              className="settings-input"
              type="text"
              placeholder="Leave blank to use the Azure chat endpoint"
              value={imageAzureEndpoint}
              onChange={(e) => setImageAzureEndpoint(e.target.value)}
            />
            <label className="settings-label" style={{ marginTop: "8px" }}>
              Image deployment name
            </label>
            <input
              className="settings-input"
              type="text"
              placeholder="e.g. gpt-image-2"
              value={imageAzureDeployment}
              onChange={(e) => {
                setImageAzureDeployment(e.target.value);
                setImageGenDefaultModel(
                  e.target.value.trim().toLowerCase() === "gpt-image-2"
                    ? "gpt-image-2"
                    : "gpt-image-1.5",
                );
              }}
            />
            <label className="settings-label" style={{ marginTop: "8px" }}>
              API version
            </label>
            <input
              className="settings-input"
              type="text"
              placeholder="2024-02-15-preview"
              value={imageAzureApiVersion}
              onChange={(e) => setImageAzureApiVersion(e.target.value)}
            />
            {renderImageTimeoutField(imageAzureTimeoutSeconds, setImageAzureTimeoutSeconds)}
          </div>
        )}

        {activeImageTab === "gemini" && (
          <div className="settings-section">
            <h3>Gemini Image</h3>
            <p className="settings-hint">
              Optionally use a dedicated Gemini API key for image generation.
              Leave blank to reuse the Gemini API key from AI Model.
            </p>
            <label className="settings-label">
              API Key (image-specific, optional)
            </label>
            <input
              className="settings-input"
              type="password"
              placeholder="Leave blank to use the Gemini API key"
              value={imageGeminiApiKey}
              onChange={(e) => setImageGeminiApiKey(e.target.value)}
            />
            <label className="settings-label">Default model</label>
            <select
              className="settings-select"
              value={imageGeminiModel}
              onChange={(e) => {
                setImageGeminiModel(e.target.value as "nano-banana-2");
                setImageGenDefaultModel("nano-banana-2");
              }}
            >
              <option value="nano-banana-2">
                nano-banana-2 (Gemini 3.1 Flash Image)
              </option>
            </select>
            {renderImageTimeoutField(imageGeminiTimeoutSeconds, setImageGeminiTimeoutSeconds)}
          </div>
        )}

        {activeImageTab === "openrouter" && (
          <div className="settings-section">
            <h3>OpenRouter Image</h3>
            <p className="settings-hint">
              Optionally use dedicated OpenRouter credentials for image
              generation. Leave blank to reuse OpenRouter settings from AI
              Model.
            </p>
            <label className="settings-label">
              API Key (image-specific, optional)
            </label>
            <input
              className="settings-input"
              type="password"
              placeholder="Leave blank to use the OpenRouter API key"
              value={imageOpenRouterApiKey}
              onChange={(e) => setImageOpenRouterApiKey(e.target.value)}
            />
            <label className="settings-label" style={{ marginTop: "8px" }}>
              Base URL
            </label>
            <input
              className="settings-input"
              type="text"
              placeholder="https://openrouter.ai/api/v1"
              value={imageOpenRouterBaseUrl}
              onChange={(e) => setImageOpenRouterBaseUrl(e.target.value)}
            />
            <label className="settings-label">Default model</label>
            <input
              className="settings-input"
              type="text"
              placeholder="openai/gpt-image-2"
              value={imageOpenRouterModel}
              onChange={(e) => {
                setImageOpenRouterModel(e.target.value);
                setImageGenDefaultModel(
                  e.target.value.toLowerCase().includes("gpt-image-2")
                    ? "gpt-image-2"
                    : "gpt-image-1.5",
                );
              }}
            />
            {renderImageTimeoutField(imageOpenRouterTimeoutSeconds, setImageOpenRouterTimeoutSeconds)}
          </div>
        )}

        {activeImageTab === "openai-codex" && (
          <div className="settings-section">
            <h3>OpenAI OAuth Image</h3>
            <p className="settings-hint">
              Uses the OpenAI OAuth connection configured in AI Model.
            </p>
            <label className="settings-label">Default model</label>
            <select
              className="settings-select"
              value={imageOpenAICodexModel}
              onChange={(e) => {
                setImageOpenAICodexModel(e.target.value);
                setImageGenDefaultModel(
                  e.target.value === "gpt-image-2" ? "gpt-image-2" : "gpt-image-1.5",
                );
              }}
            >
              <option value="gpt-image-2">gpt-image-2</option>
              <option value="gpt-image-1.5">gpt-image-1.5</option>
              <option value="gpt-image-1">gpt-image-1</option>
            </select>
            {renderImageTimeoutField(
              imageOpenAICodexTimeoutSeconds,
              setImageOpenAICodexTimeoutSeconds,
            )}
          </div>
        )}

        <div className="settings-section" style={{ marginTop: "16px" }}>
          <label className="settings-label">Fallback provider</label>
          <p className="settings-hint">
            If the selected provider fails, fall back to this one.
          </p>
          <select
            className="settings-select"
            value={imageGenBackupProvider}
            onChange={(e) =>
              selectImageBackupProvider(
                (e.target.value || "") as ImageGenProvider | "",
              )
            }
          >
            <option value="">None</option>
            {imageProviders.map((provider) => (
              <option key={provider.type} value={provider.type}>
                {provider.name}
              </option>
            ))}
          </select>
          {imageGenBackupProvider && (
            <>
              <label className="settings-label" style={{ marginTop: "8px" }}>
                Fallback model
              </label>
              <select
                className="settings-select"
                value={
                  imageGenBackupModel ===
                  getImageProviderModel(imageGenBackupProvider)
                    ? imageGenBackupModel
                    : ""
                }
                onChange={(e) =>
                  setImageGenBackupModel(
                    (e.target.value || "") as ImageGenModel | "",
                  )
                }
              >
                <option value="">Auto (recommended)</option>
                <option value={getImageProviderModel(imageGenBackupProvider)}>
                  {getImageModelLabel(
                    getImageProviderModel(imageGenBackupProvider),
                  )}
                </option>
              </select>
            </>
          )}
        </div>

        {renderModelSettingsActions()}
      </div>
    </div>
  );

  const renderVideoPanel = () => (
    <div className="llm-provider-panel">
      <div className="llm-provider-header">
        <h2>Video Provider</h2>
        <p className="settings-description">
          Choose which service to use for video generation. The selected
          provider will be used by the video creation tool.
        </p>
      </div>
      <div className="llm-provider-tabs">
        {videoProviders.map((vp) => (
          <button
            key={vp.type}
            type="button"
            className={`llm-provider-tab ${activeVideoTab === vp.type ? "active" : ""}`}
            onClick={() => setVideoDefaultProvider(vp.type)}
          >
            {vp.icon}
            <span className="llm-provider-tab-label">{vp.name}</span>
          </button>
        ))}
      </div>
      <div className="llm-provider-content">
        {activeVideoTab === "openai" && (
          <div className="settings-section">
            <h3>OpenAI Sora 2</h3>
            <p className="settings-hint">
              Uses the OpenAI API key configured in AI Model. Supports
              text-to-video and image-to-video.
            </p>
            <label className="settings-label">Default model</label>
            <select
              className="settings-select"
              value={videoOpenAIModel}
              onChange={(e) => setVideoOpenAIModel(e.target.value)}
            >
              <option value="sora-2">sora-2</option>
              <option value="sora-2-pro">sora-2-pro</option>
            </select>
            <label className="settings-label" style={{ marginTop: "8px" }}>
              Default duration (seconds)
            </label>
            <input
              className="settings-input"
              type="number"
              min={1}
              max={20}
              value={videoOpenAIDuration}
              onChange={(e) => setVideoOpenAIDuration(e.target.value)}
            />
            <label className="settings-label" style={{ marginTop: "8px" }}>
              Default aspect ratio
            </label>
            <select
              className="settings-select"
              value={videoOpenAIAspectRatio}
              onChange={(e) => setVideoOpenAIAspectRatio(e.target.value)}
            >
              <option value="16:9">16:9 (landscape)</option>
              <option value="9:16">9:16 (portrait)</option>
              <option value="1:1">1:1 (square)</option>
            </select>
            <label className="settings-label" style={{ marginTop: "8px" }}>
              Default resolution
            </label>
            <select
              className="settings-select"
              value={videoOpenAIResolution}
              onChange={(e) => setVideoOpenAIResolution(e.target.value)}
            >
              <option value="480p">480p</option>
              <option value="720p">720p</option>
              <option value="1080p">1080p</option>
            </select>
          </div>
        )}

        {activeVideoTab === "azure" && (
          <div className="settings-section">
            <h3>Azure OpenAI Sora 2</h3>
            <p className="settings-hint">
              Optionally use a dedicated API key and endpoint for video (e.g. a
              different Azure resource). Leave blank to reuse the Azure chat
              credentials from AI Model.
            </p>
            <label className="settings-label">
              API Key (video-specific, optional)
            </label>
            <input
              className="settings-input"
              type="password"
              placeholder="Leave blank to use the Azure chat API key"
              value={videoAzureApiKey}
              onChange={(e) => setVideoAzureApiKey(e.target.value)}
            />
            <label className="settings-label" style={{ marginTop: "8px" }}>
              Endpoint (video-specific, optional)
            </label>
            <input
              className="settings-input"
              type="text"
              placeholder="Leave blank to use the Azure chat endpoint"
              value={videoAzureEndpoint}
              onChange={(e) => setVideoAzureEndpoint(e.target.value)}
            />
            <label className="settings-label" style={{ marginTop: "8px" }}>
              Sora deployment name
            </label>
            <input
              className="settings-input"
              type="text"
              placeholder="e.g. sora"
              value={videoAzureDeployment}
              onChange={(e) => setVideoAzureDeployment(e.target.value)}
            />
            <label className="settings-label" style={{ marginTop: "8px" }}>
              API version
            </label>
            <input
              className="settings-input"
              type="text"
              placeholder="preview"
              value={videoAzureApiVersion}
              onChange={(e) => setVideoAzureApiVersion(e.target.value)}
            />
            <label className="settings-label" style={{ marginTop: "8px" }}>
              Default duration (seconds)
            </label>
            <input
              className="settings-input"
              type="number"
              min={1}
              max={20}
              value={videoAzureDuration}
              onChange={(e) => setVideoAzureDuration(e.target.value)}
            />
            <label className="settings-label" style={{ marginTop: "8px" }}>
              Default aspect ratio
            </label>
            <select
              className="settings-select"
              value={videoAzureAspectRatio}
              onChange={(e) => setVideoAzureAspectRatio(e.target.value)}
            >
              <option value="16:9">16:9 (landscape)</option>
              <option value="9:16">9:16 (portrait)</option>
              <option value="1:1">1:1 (square)</option>
            </select>
          </div>
        )}

        {activeVideoTab === "gemini" && (
          <div className="settings-section">
            <h3>Gemini Veo 3.1</h3>
            <p className="settings-hint">
              Uses the Gemini API key configured in AI Model. Supports
              text-to-video and image-to-video via long-running operations.
            </p>
            <label className="settings-label">Default model</label>
            <select
              className="settings-select"
              value={videoGeminiModel}
              onChange={(e) =>
                setVideoGeminiModel(
                  e.target.value as
                    | "veo-3.1"
                    | "veo-3.1-fast-preview"
                    | "veo-3.0",
                )
              }
            >
              <option value="veo-3.1">Veo 3.1 (standard)</option>
              <option value="veo-3.1-fast-preview">Veo 3.1 Fast Preview</option>
              <option value="veo-3.0">Veo 3.0</option>
            </select>
            <label className="settings-label" style={{ marginTop: "8px" }}>
              Default duration (seconds)
            </label>
            <input
              className="settings-input"
              type="number"
              min={1}
              max={30}
              value={videoGeminiDuration}
              onChange={(e) => setVideoGeminiDuration(e.target.value)}
            />
            <label className="settings-label" style={{ marginTop: "8px" }}>
              Default aspect ratio
            </label>
            <select
              className="settings-select"
              value={videoGeminiAspectRatio}
              onChange={(e) => setVideoGeminiAspectRatio(e.target.value)}
            >
              <option value="16:9">16:9 (landscape)</option>
              <option value="9:16">9:16 (portrait)</option>
              <option value="1:1">1:1 (square)</option>
            </select>
          </div>
        )}

        {activeVideoTab === "vertex" && (
          <div className="settings-section">
            <h3>Vertex AI Veo 3 / 3.1</h3>
            <p className="settings-hint">
              Requires a Google Cloud project, location, and an access token.
              Output can be saved to a GCS bucket.
            </p>
            <label className="settings-label">Model</label>
            <select
              className="settings-select"
              value={videoVertexModel}
              onChange={(e) =>
                setVideoVertexModel(e.target.value as "veo-3" | "veo-3.1")
              }
            >
              <option value="veo-3">Veo 3</option>
              <option value="veo-3.1">Veo 3.1</option>
            </select>
            <label className="settings-label" style={{ marginTop: "8px" }}>
              GCP Project ID
            </label>
            <input
              className="settings-input"
              type="text"
              placeholder="my-project-id"
              value={videoVertexProjectId}
              onChange={(e) => setVideoVertexProjectId(e.target.value)}
            />
            <label className="settings-label" style={{ marginTop: "8px" }}>
              Location
            </label>
            <input
              className="settings-input"
              type="text"
              placeholder="us-central1"
              value={videoVertexLocation}
              onChange={(e) => setVideoVertexLocation(e.target.value)}
            />
            <label className="settings-label" style={{ marginTop: "8px" }}>
              Output GCS URI (optional)
            </label>
            <input
              className="settings-input"
              type="text"
              placeholder="gs://my-bucket/videos/"
              value={videoVertexOutputGcsUri}
              onChange={(e) => setVideoVertexOutputGcsUri(e.target.value)}
            />
            <label className="settings-label" style={{ marginTop: "8px" }}>
              Access Token
            </label>
            <p
              className="settings-hint"
              style={{
                marginBottom: "4px",
                color: "var(--color-warning, #b45309)",
              }}
            >
              OAuth access tokens expire in ~1 hour. Re-paste a fresh token when
              generation fails. For long-running use, consider a service account
              key instead.
            </p>
            <input
              className="settings-input"
              type="password"
              placeholder="ya29...."
              value={videoVertexAccessToken}
              onChange={(e) => setVideoVertexAccessToken(e.target.value)}
            />
            <label className="settings-label" style={{ marginTop: "8px" }}>
              Default duration (seconds)
            </label>
            <input
              className="settings-input"
              type="number"
              min={1}
              max={30}
              value={videoVertexDuration}
              onChange={(e) => setVideoVertexDuration(e.target.value)}
            />
            <label className="settings-label" style={{ marginTop: "8px" }}>
              Default aspect ratio
            </label>
            <select
              className="settings-select"
              value={videoVertexAspectRatio}
              onChange={(e) => setVideoVertexAspectRatio(e.target.value)}
            >
              <option value="16:9">16:9 (landscape)</option>
              <option value="9:16">9:16 (portrait)</option>
              <option value="1:1">1:1 (square)</option>
            </select>
          </div>
        )}

        {activeVideoTab === "kling" && (
          <div className="settings-section">
            <h3>Kling</h3>
            <p className="settings-hint">
              Dedicated Kling API key. Supports text-to-video and
              image-to-video.
            </p>
            <label className="settings-label">API Key</label>
            <input
              className="settings-input"
              type="password"
              placeholder="Enter Kling API key"
              value={videoKlingApiKey}
              onChange={(e) => setVideoKlingApiKey(e.target.value)}
            />
            <label className="settings-label" style={{ marginTop: "8px" }}>
              Base URL
            </label>
            <input
              className="settings-input"
              type="text"
              placeholder="https://api.klingai.com"
              value={videoKlingBaseUrl}
              onChange={(e) => setVideoKlingBaseUrl(e.target.value)}
            />
            <label className="settings-label" style={{ marginTop: "8px" }}>
              Model
            </label>
            <input
              className="settings-input"
              type="text"
              placeholder="kling-v2"
              value={videoKlingModel}
              onChange={(e) => setVideoKlingModel(e.target.value)}
            />
            <label className="settings-label" style={{ marginTop: "8px" }}>
              Default duration (seconds)
            </label>
            <input
              className="settings-input"
              type="number"
              min={1}
              max={60}
              value={videoKlingDuration}
              onChange={(e) => setVideoKlingDuration(e.target.value)}
            />
            <label className="settings-label" style={{ marginTop: "8px" }}>
              Default aspect ratio
            </label>
            <select
              className="settings-select"
              value={videoKlingAspectRatio}
              onChange={(e) => setVideoKlingAspectRatio(e.target.value)}
            >
              <option value="16:9">16:9 (landscape)</option>
              <option value="9:16">9:16 (portrait)</option>
              <option value="1:1">1:1 (square)</option>
            </select>
          </div>
        )}

        {/* Fallback provider */}
        <div className="settings-section" style={{ marginTop: "16px" }}>
          <label className="settings-label">Fallback provider</label>
          <p className="settings-hint">
            If the selected provider fails, fall back to this one.
          </p>
          <select
            className="settings-select"
            value={videoFallbackProvider}
            onChange={(e) =>
              setVideoFallbackProvider(
                (e.target.value || "") as
                  | "openai"
                  | "azure"
                  | "gemini"
                  | "vertex"
                  | "kling"
                  | "",
              )
            }
          >
            <option value="">None</option>
            <option value="openai">OpenAI Sora 2</option>
            <option value="azure">Azure OpenAI Sora 2</option>
            <option value="gemini">Gemini Veo 3.1</option>
            <option value="vertex">Vertex AI Veo</option>
            <option value="kling">Kling</option>
          </select>
        </div>

        {renderModelSettingsActions()}
      </div>
    </div>
  );

  const renderLLMPanel = () => (
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
          <>
            <div className="settings-section">
              <h3>Claude</h3>
              <p className="settings-description">
                Choose between direct Claude API access and a Claude
                subscription token.
              </p>
              <div
                className="auth-method-tabs"
                style={{ marginBottom: "1rem" }}
              >
                <button
                  type="button"
                  className={`auth-method-tab ${anthropicAuthMethod === "api_key" ? "active" : ""}`}
                  onClick={() => setAnthropicAuthMethod("api_key")}
                >
                  Claude API
                </button>
                <button
                  type="button"
                  className={`auth-method-tab ${anthropicAuthMethod === "subscription" ? "active" : ""}`}
                  onClick={() => setAnthropicAuthMethod("subscription")}
                >
                  Claude Subscription
                </button>
              </div>
            </div>

            {anthropicAuthMethod === "api_key" ? (
              <div className="settings-section">
                <h3>Claude API Key</h3>
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
            ) : (
              <div className="settings-section">
                <h3>Claude Subscription Token</h3>
                <p className="settings-description">
                  Paste your Claude subscription token (for example,{" "}
                  <code>sk-ant-oat...</code>).
                </p>
                <p className="settings-description">
                  To get one, install Claude Code, sign in by running{" "}
                  <code>claude</code>, then run <code>claude setup-token</code>{" "}
                  locally and paste the generated token here.
                </p>
                <p className="settings-description">
                  Note: as of April 4, 2026, third-party harnesses connected to
                  your Claude account draw from extra usage instead of from your
                  subscription. If you do not use them, nothing changes. If you
                  do, the credit and bundles above have you covered.
                </p>
                <input
                  type="password"
                  className="settings-input"
                  placeholder="sk-ant-oat..."
                  value={anthropicSubscriptionToken}
                  onChange={(e) =>
                    setAnthropicSubscriptionToken(e.target.value)
                  }
                />
              </div>
            )}

            <div className="settings-section">
              <h3>Model</h3>
              <p className="settings-description">
                Refresh the Claude model list if this selector is showing a
                stale model from another provider.
              </p>
              <div className="settings-input-group">
                <select
                  className="settings-select"
                  value={settings.modelKey}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      modelKey: e.target.value,
                    })
                  }
                >
                  {models.map((model) => (
                    <option key={model.key} value={model.key}>
                      {model.displayName}
                    </option>
                  ))}
                </select>
                <button
                  className="button-small button-secondary"
                  onClick={() => loadClaudeModels()}
                  disabled={loadingClaudeModels}
                >
                  {loadingClaudeModels ? "Loading..." : "Refresh Models"}
                </button>
              </div>
            </div>
          </>
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
                Select a Gemini model. Enter your API key and click "Refresh
                Models" to load available models.
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
                Select a model from OpenRouter's catalog. Enter your API key and
                click "Refresh Models" to load available models.
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
                OpenRouter provides access to many models from different
                providers (Claude, GPT-4, Llama, etc.) through a unified API.
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
                      Your ChatGPT account is connected. You can use GPT-4o and
                      other models with your subscription.
                    </p>
                    <button
                      className="button-small button-secondary"
                      onClick={handleOpenAIOAuthLogout}
                      disabled={openaiOAuthLoading}
                    >
                      {openaiOAuthLoading
                        ? "Disconnecting..."
                        : "Disconnect Account"}
                    </button>
                  </div>
                ) : (
                  <div className="oauth-login">
                    <p className="settings-description">
                      Sign in with your ChatGPT account to use GPT-4o, o1, and
                      other models with your subscription.
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

        {(settings.providerType === "azure" ||
          settings.providerType === "azure-anthropic") && (
          <>
            <div className="settings-section">
              <h3>Azure</h3>
              <p className="settings-description">
                Configure Azure OpenAI (GPT models) or Azure Anthropic (Claude
                models).
              </p>
              <div
                className="auth-method-tabs"
                style={{ marginBottom: "1rem" }}
              >
                <button
                  type="button"
                  className={`auth-method-tab ${settings.providerType === "azure" ? "active" : ""}`}
                  onClick={() => handleProviderSelect("azure")}
                >
                  Azure OpenAI
                </button>
                <button
                  type="button"
                  className={`auth-method-tab ${settings.providerType === "azure-anthropic" ? "active" : ""}`}
                  onClick={() => handleProviderSelect("azure-anthropic")}
                >
                  Azure Anthropic
                </button>
              </div>
            </div>

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
                    Enter one or more deployment names (one per line). These
                    appear in the model selector.
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
                    Optional. Used for connection tests and initial selection.
                    You can switch models in the main view.
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

                <div className="settings-section">
                  <h3>Reasoning Effort</h3>
                  <p className="settings-description">
                    Controls how much reasoning Azure should spend on supported
                    models. Azure currently accepts low, medium, and high. Extra
                    High is stored in settings but sent as High to Azure
                    requests.
                  </p>
                  <select
                    className="settings-input"
                    value={azureReasoningEffort}
                    onChange={(e) =>
                      setAzureReasoningEffort(
                        e.target.value as AzureReasoningEffort,
                      )
                    }
                  >
                    {AZURE_REASONING_EFFORT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}

            {settings.providerType === "azure-anthropic" && (
              <>
                <div className="settings-section">
                  <h3>Azure Anthropic Endpoint</h3>
                  <p className="settings-description">
                    Enter your Azure resource endpoint with the Anthropic path
                    (for example,{" "}
                    <code>
                      https://your-resource.openai.azure.com/anthropic
                    </code>
                    ). The API uses the Anthropic Messages format with x-api-key
                    and anthropic-version headers.
                  </p>
                  <input
                    type="text"
                    className="settings-input"
                    placeholder="https://your-resource.openai.azure.com/anthropic"
                    value={azureAnthropicEndpoint}
                    onChange={(e) => setAzureAnthropicEndpoint(e.target.value)}
                  />
                </div>

                <div className="settings-section">
                  <h3>Azure Anthropic API Key</h3>
                  <p className="settings-description">
                    Enter the API key for your Azure OpenAI resource (same key
                    as Azure OpenAI).
                  </p>
                  <input
                    type="password"
                    className="settings-input"
                    placeholder="Azure API key"
                    value={azureAnthropicApiKey}
                    onChange={(e) => setAzureAnthropicApiKey(e.target.value)}
                  />
                </div>

                <div className="settings-section">
                  <h3>Deployment Names</h3>
                  <p className="settings-description">
                    Enter one or more deployment names (one per line), e.g.
                    claude-opus-4-6, claude-sonnet-4-6.
                  </p>
                  <textarea
                    className="settings-input"
                    placeholder="claude-opus-4-6\nclaude-sonnet-4-6"
                    rows={3}
                    value={azureAnthropicDeploymentsText}
                    onChange={(e) =>
                      setAzureAnthropicDeploymentsText(e.target.value)
                    }
                  />
                </div>

                <div className="settings-section">
                  <h3>Default Deployment</h3>
                  <p className="settings-description">
                    The deployment name to use (e.g. claude-opus-4-6).
                  </p>
                  <input
                    type="text"
                    className="settings-input"
                    placeholder="claude-opus-4-6"
                    value={azureAnthropicDeployment}
                    onChange={(e) =>
                      setAzureAnthropicDeployment(e.target.value)
                    }
                  />
                </div>

                <div className="settings-section">
                  <h3>API Version</h3>
                  <p className="settings-description">
                    Anthropic API version (default 2023-06-01).
                  </p>
                  <input
                    type="text"
                    className="settings-input"
                    placeholder="2023-06-01"
                    value={azureAnthropicApiVersion}
                    onChange={(e) =>
                      setAzureAnthropicApiVersion(e.target.value)
                    }
                  />
                </div>
              </>
            )}
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
                Select a Groq model. Enter your API key and click "Refresh
                Models" to load available models.
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
                <a
                  href="https://console.x.ai/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
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
                Select a Grok model. Enter your API key and click "Refresh
                Models" to load available models.
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
                Select a Kimi model. Enter your API key and click "Refresh
                Models" to load available models.
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
                Enter the base URL of your OpenAI-compatible API endpoint (e.g.
                vLLM, LM Studio, LocalAI, text-generation-webui).
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
                API key is optional for local servers. Required for remote
                endpoints that need authentication.
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
                Select a model or enter a model ID. Click "Fetch Models" to load
                available models from the endpoint.
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
                placeholder={
                  selectedCustomProvider.apiKeyPlaceholder || "sk-..."
                }
                value={selectedCustomConfig.apiKey || ""}
                onChange={(e) =>
                  updateCustomProvider(resolvedProviderType, {
                    apiKey: e.target.value,
                  })
                }
              />
              {selectedCustomProvider.apiKeyOptional && (
                <p className="settings-hint">
                  API key is optional for this provider.
                </p>
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
                Select a model for {selectedCustomProvider.name}.{" "}
                <button
                  className="button-small button-secondary"
                  onClick={() => loadCustomProviderModels(resolvedProviderType)}
                  disabled={
                    loadingCustomProviderModels ||
                    (selectedCustomProvider.requiresBaseUrl &&
                      !(
                        selectedCustomConfig.baseUrl ||
                        selectedCustomProvider.baseUrl
                      ))
                  }
                  style={{ marginLeft: "8px" }}
                >
                  {loadingCustomProviderModels
                    ? "Loading..."
                    : "Refresh Models"}
                </button>
              </p>
              {selectedCustomModels.length > 0 ? (
                <SearchableSelect
                  options={selectedCustomModels.map((model) => ({
                    value: model.key,
                    label: model.displayName,
                    description: model.description,
                  }))}
                  value={selectedCustomConfig.model || ""}
                  onChange={(value) =>
                    updateCustomProvider(resolvedProviderType, { model: value })
                  }
                  placeholder="Select a model..."
                />
              ) : (
                <input
                  type="text"
                  className="settings-input"
                  placeholder={
                    selectedCustomProvider.defaultModel || "model-id"
                  }
                  value={selectedCustomConfig.model || ""}
                  onChange={(e) =>
                    updateCustomProvider(resolvedProviderType, {
                      model: e.target.value,
                    })
                  }
                />
              )}
            </div>
          </>
        )}

        {resolvedProviderType === "hf-agents" && (
          <>
            {/* Installation status */}
            <div className="settings-section">
              <h3>Local AI Status</h3>
              {hfStatus === null ? (
                <p className="settings-description">
                  Checking hf-agents installation...
                </p>
              ) : hfStatus.installed ? (
                <p
                  className="settings-description"
                  style={{ color: "var(--color-success, #16a34a)" }}
                >
                  hf-agents {hfStatus.version} installed
                </p>
              ) : (
                <div>
                  <p
                    className="settings-description"
                    style={{ color: "var(--color-warning, #d97706)" }}
                  >
                    {hfStatus.message}
                  </p>
                  <div
                    style={{
                      background: "var(--color-bg-secondary, rgba(0,0,0,0.1))",
                      borderRadius: "6px",
                      padding: "10px 12px",
                      marginTop: "8px",
                      fontFamily: "monospace",
                      fontSize: "12px",
                      display: "flex",
                      flexDirection: "column",
                      gap: "4px",
                    }}
                  >
                    {!hfStatus.hfInstalled && (
                      <span># Step 1 — install hf CLI</span>
                    )}
                    {!hfStatus.hfInstalled && (
                      <span>pip install huggingface_hub</span>
                    )}
                    <span
                      style={{ marginTop: !hfStatus.hfInstalled ? "6px" : 0 }}
                    >
                      {!hfStatus.hfInstalled
                        ? "# Step 2 — install agents extension"
                        : "# Install agents extension"}
                    </span>
                    <span>hf extensions install hf-agents</span>
                  </div>
                </div>
              )}
              {/* Server running indicator */}
              <div
                style={{
                  marginTop: "10px",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                }}
              >
                <span
                  style={{
                    width: "10px",
                    height: "10px",
                    borderRadius: "50%",
                    background: hfServerStatus?.serverRunning
                      ? "var(--color-success, #16a34a)"
                      : hfServerStatus?.processAlive
                        ? "var(--color-warning, #d97706)"
                        : "var(--color-text-muted, #888)",
                    flexShrink: 0,
                  }}
                />
                <span className="settings-description" style={{ margin: 0 }}>
                  {hfServerStatus?.serverRunning
                    ? `Server running on :8080${hfServerStatus.models?.length ? ` · ${hfServerStatus.models[0]}` : ""}`
                    : hfServerStatus?.processAlive
                      ? "Starting… (model may be downloading)"
                      : "Server not running"}
                </span>
              </div>
              {/* Live server log panel — shown while starting or after error */}
              {serverLog && !hfServerStatus?.serverRunning && (
                <div
                  style={{
                    marginTop: "10px",
                    borderRadius: "8px",
                    overflow: "hidden",
                    border: "1px solid var(--color-border, rgba(0,0,0,0.1))",
                  }}
                >
                  {/* Status bar */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      padding: "6px 10px",
                      background:
                        serverLog.state === "error"
                          ? "rgba(220,38,38,0.08)"
                          : serverLog.state === "downloading"
                            ? "rgba(59,130,246,0.08)"
                            : "rgba(0,0,0,0.04)",
                      borderBottom:
                        "1px solid var(--color-border, rgba(0,0,0,0.08))",
                    }}
                  >
                    {serverLog.state !== "error" && (
                      <span
                        style={{
                          display: "inline-block",
                          width: "8px",
                          height: "8px",
                          borderRadius: "50%",
                          background:
                            serverLog.state === "downloading"
                              ? "#3b82f6"
                              : "#f59e0b",
                          animation: "pulse 1.5s ease-in-out infinite",
                        }}
                      />
                    )}
                    {serverLog.state === "error" && (
                      <span style={{ color: "var(--color-error, #dc2626)" }}>
                        ⚠
                      </span>
                    )}
                    <span style={{ fontSize: "12px", fontWeight: 500 }}>
                      {serverLog.state === "downloading"
                        ? `Downloading${serverLog.downloadingFile ? ` ${serverLog.downloadingFile}` : " model"}…`
                        : serverLog.state === "loading"
                          ? "Loading model into memory…"
                          : serverLog.state === "error"
                            ? "Server failed to start"
                            : "Starting server…"}
                    </span>
                  </div>
                  {/* Log lines */}
                  <pre
                    style={{
                      margin: 0,
                      padding: "8px 10px",
                      fontSize: "10px",
                      lineHeight: "1.5",
                      fontFamily: "monospace",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                      maxHeight: "160px",
                      overflowY: "auto",
                      background: "var(--color-bg-secondary, rgba(0,0,0,0.04))",
                      color: "var(--color-text-secondary, #666)",
                    }}
                  >
                    {serverLog.lines.join("\n")}
                  </pre>
                </div>
              )}
            </div>

            {/* Hardware detection */}
            <div className="settings-section">
              <h3>Detect Hardware</h3>
              <p className="settings-description">
                Run <code>hf agents fit</code> to detect your hardware and get
                model recommendations. The best model will be selected
                automatically.
              </p>
              <button
                className="button-small button-secondary"
                onClick={handleHfDetectHardware}
                disabled={detectingHardware || !hfStatus?.installed}
              >
                {detectingHardware ? "Detecting..." : "Detect Hardware"}
              </button>
              {hfHardwareOutput &&
                (hfHardwareOutput.modelDetails?.length ??
                  hfHardwareOutput.models?.length ??
                  0) > 0 && (
                  <div style={{ marginTop: "12px" }}>
                    {/* Model list — show all, mark MLX-only as not usable with llama-server */}
                    {(hfHardwareOutput.modelDetails ?? []).length > 0 ? (
                      <>
                        <p
                          className="settings-description"
                          style={{ marginBottom: "8px" }}
                        >
                          Recommended models for your hardware. Click a model to
                          select it.{" "}
                          <span
                            style={{ color: "var(--color-success, #16a34a)" }}
                          >
                            GGUF
                          </span>{" "}
                          runs via llama-server.{" "}
                          {hfStatus?.mlxInstalled === "ok" ? (
                            <>
                              <span style={{ color: "#8b5cf6" }}>MLX</span> runs
                              natively on Apple Silicon via mlx_lm — fastest on
                              your M-series Mac.
                            </>
                          ) : hfStatus?.isMac ? (
                            <>
                              <span
                                style={{
                                  color: "var(--color-text-muted, #888)",
                                }}
                              >
                                MLX
                              </span>{" "}
                              models require mlx_lm (see below).
                            </>
                          ) : (
                            <>
                              <span
                                style={{
                                  color: "var(--color-text-muted, #888)",
                                }}
                              >
                                MLX
                              </span>{" "}
                              requires Apple Silicon.
                            </>
                          )}
                        </p>
                        {hfStatus?.isMac && hfStatus.mlxInstalled !== "ok" && (
                          <div
                            style={{
                              marginBottom: "8px",
                              padding: "7px 10px",
                              borderRadius: "6px",
                              background: "rgba(139,92,246,0.08)",
                              border: "1px solid rgba(139,92,246,0.25)",
                            }}
                          >
                            <span style={{ fontSize: "12px" }}>
                              {hfStatus.mlxInstalled === "broken" ? (
                                <>
                                  {hfStatus.mlxMessage ||
                                    "MLX installed but broken."}{" "}
                                  <code style={{ fontSize: "11px" }}>
                                    pip install mlx mlx-metal --force-reinstall
                                    --no-cache-dir
                                  </code>
                                </>
                              ) : (
                                <>
                                  MLX not installed. To use MLX models:{" "}
                                  <code style={{ fontSize: "11px" }}>
                                    pip install mlx-lm
                                  </code>
                                </>
                              )}
                            </span>
                          </div>
                        )}
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: "4px",
                            marginBottom: "10px",
                            maxHeight: "280px",
                            overflowY: "auto",
                            paddingRight: "2px",
                          }}
                        >
                          {hfHardwareOutput.modelDetails!.map((m, i) => (
                            <div
                              key={m.spec}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                                padding: "6px 10px",
                                borderRadius: "6px",
                                background:
                                  "var(--color-bg-secondary, rgba(0,0,0,0.06))",
                                opacity:
                                  m.hasGguf ||
                                  (m.runtime === "MLX" &&
                                    hfStatus?.mlxInstalled === "ok")
                                    ? 1
                                    : 0.4,
                                cursor:
                                  m.hasGguf ||
                                  (m.runtime === "MLX" &&
                                    hfStatus?.mlxInstalled === "ok")
                                    ? "pointer"
                                    : "not-allowed",
                              }}
                              onClick={() => {
                                const input = document.getElementById(
                                  "hf-model-input",
                                ) as HTMLInputElement;
                                if (!input) return;
                                if (m.hasGguf) {
                                  input.value = m.spec;
                                } else if (
                                  m.runtime === "MLX" &&
                                  hfStatus?.mlxInstalled === "ok"
                                ) {
                                  input.value = `mlx://${m.name}`;
                                }
                              }}
                            >
                              <span
                                style={{
                                  fontSize: "10px",
                                  fontWeight: 600,
                                  padding: "1px 5px",
                                  borderRadius: "3px",
                                  background: m.hasGguf
                                    ? "var(--color-success, #16a34a)"
                                    : m.runtime === "MLX" &&
                                        hfStatus?.mlxInstalled === "ok"
                                      ? "#8b5cf6"
                                      : "var(--color-text-muted, #888)",
                                  color: "#fff",
                                  flexShrink: 0,
                                }}
                              >
                                {m.runtime}
                              </span>
                              <span
                                style={{
                                  flex: 1,
                                  fontSize: "12px",
                                  fontFamily: "monospace",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {m.name}
                                {i === 0 && (
                                  <span
                                    style={{
                                      marginLeft: "6px",
                                      fontSize: "10px",
                                      color: "var(--color-text-muted, #888)",
                                    }}
                                  >
                                    ★ best
                                  </span>
                                )}
                              </span>
                              <span
                                style={{
                                  fontSize: "11px",
                                  color: "var(--color-text-muted, #888)",
                                  flexShrink: 0,
                                }}
                              >
                                {m.params}
                                {m.memoryGb ? ` · ${m.memoryGb}GB` : ""}
                                {m.tps ? ` · ~${m.tps}tok/s` : ""}
                              </span>
                            </div>
                          ))}
                        </div>
                        {/* Smaller model quick-picks — always shown since hf agents fit only recommends top-scoring (large) models */}
                        <div
                          style={{
                            marginBottom: "8px",
                            padding: "8px 10px",
                            borderRadius: "6px",
                            background:
                              "var(--color-bg-secondary, rgba(0,0,0,0.04))",
                            border:
                              "1px solid var(--color-border, rgba(0,0,0,0.08))",
                          }}
                        >
                          <p
                            className="settings-description"
                            style={{ margin: "0 0 8px 0", fontSize: "11px" }}
                          >
                            Smaller models (faster download, great for most
                            tasks):
                          </p>
                          {hfStatus?.mlxInstalled === "ok" && (
                            <div style={{ marginBottom: "6px" }}>
                              <span
                                style={{
                                  fontSize: "10px",
                                  fontWeight: 600,
                                  color: "#8b5cf6",
                                  marginRight: "6px",
                                }}
                              >
                                MLX
                              </span>
                              {[
                                {
                                  label: "Qwen3-8B · ~5GB · fast",
                                  spec: "mlx://mlx-community/Qwen3-8B-4bit",
                                },
                                {
                                  label: "Qwen3-14B · ~9GB",
                                  spec: "mlx://mlx-community/Qwen3-14B-4bit",
                                },
                                {
                                  label: "Qwen3-30B-A3B · ~19GB",
                                  spec: "mlx://mlx-community/Qwen3-30B-A3B-4bit",
                                },
                              ].map(({ label, spec }) => (
                                <button
                                  key={spec}
                                  className="button-small button-secondary"
                                  style={{
                                    fontSize: "11px",
                                    marginRight: "4px",
                                    borderColor: "#8b5cf6",
                                    color: "#8b5cf6",
                                  }}
                                  onClick={() => {
                                    const input = document.getElementById(
                                      "hf-model-input",
                                    ) as HTMLInputElement;
                                    if (input) input.value = spec;
                                  }}
                                >
                                  {label}
                                </button>
                              ))}
                            </div>
                          )}
                          <div>
                            <span
                              style={{
                                fontSize: "10px",
                                fontWeight: 600,
                                color: "var(--color-success, #16a34a)",
                                marginRight: "6px",
                              }}
                            >
                              GGUF
                            </span>
                            {[
                              {
                                label: "Qwen3-8B · ~5GB · fast",
                                spec: "unsloth/Qwen3-8B-GGUF:Q4_K_M",
                              },
                              {
                                label: "Qwen3-14B · ~9GB",
                                spec: "unsloth/Qwen3-14B-GGUF:Q4_K_M",
                              },
                              {
                                label: "Qwen3-32B · ~20GB",
                                spec: "unsloth/Qwen3-32B-GGUF:Q4_K_M",
                              },
                            ].map(({ label, spec }) => (
                              <button
                                key={spec}
                                className="button-small button-secondary"
                                style={{ fontSize: "11px", marginRight: "4px" }}
                                onClick={() => {
                                  const input = document.getElementById(
                                    "hf-model-input",
                                  ) as HTMLInputElement;
                                  if (input) input.value = spec;
                                }}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                        </div>
                      </>
                    ) : null}
                    <div
                      style={{
                        display: "flex",
                        gap: "8px",
                        alignItems: "center",
                      }}
                    >
                      <input
                        id="hf-model-input"
                        className="settings-input"
                        style={{ flex: 1, fontSize: "12px" }}
                        defaultValue={hfHardwareOutput.models[0] ?? ""}
                        placeholder="e.g. unsloth/Qwen3-4B-GGUF:Q4_K_M"
                      />
                      <button
                        className="button-small button-primary"
                        onClick={() => {
                          const input = document.getElementById(
                            "hf-model-input",
                          ) as HTMLInputElement;
                          if (input?.value)
                            updateCustomProvider("hf-agents", {
                              model: input.value,
                            });
                        }}
                      >
                        Use
                      </button>
                    </div>
                  </div>
                )}
              {hfHardwareOutput && hfHardwareOutput.output && (
                <details style={{ marginTop: "8px" }}>
                  <summary
                    style={{
                      fontSize: "11px",
                      cursor: "pointer",
                      color: "var(--color-text-secondary, #888)",
                    }}
                  >
                    Raw output
                  </summary>
                  <pre
                    style={{
                      marginTop: "4px",
                      fontSize: "11px",
                      maxHeight: "160px",
                      overflow: "auto",
                      background: "var(--color-bg-secondary, rgba(0,0,0,0.1))",
                      padding: "8px",
                      borderRadius: "4px",
                    }}
                  >
                    {hfHardwareOutput.output}
                  </pre>
                </details>
              )}
            </div>

            {/* Start / Stop server */}
            <div className="settings-section">
              <h3>Server Control</h3>
              <p className="settings-description">
                Start the llama.cpp server with your selected model. The server
                exposes an OpenAI-compatible API at{" "}
                <code>http://localhost:8080</code>.
              </p>
              <div style={{ display: "flex", gap: "8px" }}>
                <button
                  className="button-small button-primary"
                  onClick={handleHfStartServer}
                  disabled={
                    startingServer ||
                    !hfStatus?.installed ||
                    hfServerStatus?.serverRunning
                  }
                >
                  {startingServer ? "Starting..." : "Start Server"}
                </button>
                <button
                  className="button-small button-secondary"
                  onClick={handleHfStopServer}
                  disabled={stoppingServer || !hfServerStatus?.processAlive}
                >
                  {stoppingServer ? "Stopping..." : "Stop Server"}
                </button>
              </div>
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
                    Uses AWS credentials from environment variables, shared
                    credentials file (~/.aws/credentials), or IAM role.
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
                  onChange={(e) =>
                    setSettings({ ...settings, modelKey: e.target.value })
                  }
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
                URL of your Ollama server. Default is http://localhost:11434 for
                local installations.
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
                Select from models available on your Ollama server, or enter a
                custom model name.
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
                Don't have models? Run <code>ollama pull llama3.2</code> to
                download a model.
              </p>
            </div>

            <div className="settings-section">
              <h3>API Key (Optional)</h3>
              <p className="settings-description">
                Only needed if connecting to a remote Ollama server that
                requires authentication.
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

        <div className="settings-section profile-routing-section">
          <h3>Profile-Based Routing</h3>
          <p className="settings-description">
            Route strong tasks (planning/verification) and cheap execution tasks
            to different models for this provider.
          </p>
          <label className="settings-checkbox profile-routing-enable">
            <input
              type="checkbox"
              checked={routingEnabled}
              onChange={(e) => {
                const enabled = e.target.checked;
                const fallbackModel =
                  providerPrimaryModel || strongRoutingModel || "";
                setProviderRoutingConfig(currentProviderType, {
                  profileRoutingEnabled: enabled,
                  ...(enabled
                    ? {
                        strongModelKey:
                          strongRoutingModel || fallbackModel || undefined,
                        cheapModelKey:
                          cheapRoutingModel || fallbackModel || undefined,
                      }
                    : {}),
                  preferStrongForVerification:
                    typeof providerRouting.preferStrongForVerification ===
                    "boolean"
                      ? providerRouting.preferStrongForVerification
                      : true,
                });
              }}
            />
            <span>Enable profile-based routing</span>
          </label>

          {routingEnabled && (
            <div className="profile-routing-content">
              <div className="profile-routing-models">
                <div className="settings-subsection">
                  <h4>Strong / Planning Model</h4>
                  <select
                    className="settings-select"
                    value={strongRoutingModel || ""}
                    onChange={(e) =>
                      setProviderRoutingConfig(currentProviderType, {
                        strongModelKey: e.target.value || undefined,
                      })
                    }
                  >
                    {routingModelOptions.map((model) => (
                      <option key={model.key} value={model.key}>
                        {model.displayName}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="settings-subsection">
                  <h4>Cheap / Execution Model</h4>
                  <select
                    className="settings-select"
                    value={cheapRoutingModel || ""}
                    onChange={(e) =>
                      setProviderRoutingConfig(currentProviderType, {
                        cheapModelKey: e.target.value || undefined,
                      })
                    }
                  >
                    {routingModelOptions.map((model) => (
                      <option key={model.key} value={model.key}>
                        {model.displayName}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="settings-subsection">
                  <h4>Automated Tasks Model</h4>
                  <p className="settings-hint">
                    Optional. Dedicated model for cron, scheduled, and
                    improvement tasks. When set, uses faster/cheaper models
                    (e.g. gpt-4o-mini, nano). Leave empty to use the execution
                    model above.
                  </p>
                  <select
                    className="settings-select"
                    value={automatedTaskRoutingModel}
                    onChange={(e) =>
                      setProviderRoutingConfig(currentProviderType, {
                        automatedTaskModelKey: e.target.value || undefined,
                      })
                    }
                  >
                    <option value="">Use execution model</option>
                    {routingModelOptions.map((model) => (
                      <option key={model.key} value={model.key}>
                        {model.displayName}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="settings-subsection profile-routing-sync">
                <button
                  className="button-small button-secondary"
                  type="button"
                  onClick={() =>
                    setProviderRoutingConfig(currentProviderType, {
                      strongModelKey:
                        strongRoutingModel || providerPrimaryModel || undefined,
                      cheapModelKey:
                        strongRoutingModel || providerPrimaryModel || undefined,
                    })
                  }
                >
                  Use same model for both
                </button>
              </div>

              <label className="settings-checkbox profile-routing-prefer">
                <input
                  type="checkbox"
                  checked={
                    providerRouting.preferStrongForVerification !== false
                  }
                  onChange={(e) =>
                    setProviderRoutingConfig(currentProviderType, {
                      preferStrongForVerification: e.target.checked,
                    })
                  }
                />
                <span>Prefer strong model for verification tasks</span>
              </label>

              {routingModelsIdentical && (
                <p className="settings-hint">
                  Strong and cheap models are identical, so routing will not
                  change model cost/quality.
                </p>
              )}

              <div className="settings-subsection routing-runtime-panel">
                <div className="routing-runtime-header">
                  <h4>Live routing</h4>
                  <button
                    className="button-small button-secondary"
                    type="button"
                    onClick={() =>
                      void window.electronAPI
                        ?.getLLMRoutingStatus?.()
                        .then((state) => setRoutingRuntime(state))
                        .catch((error) => {
                          console.error(
                            "Failed to refresh routing status:",
                            error,
                          );
                        })
                    }
                  >
                    Refresh
                  </button>
                </div>
                {routingRuntime ? (
                  <>
                    <div className="routing-runtime-grid">
                      <div className="routing-runtime-item">
                        <span>Active provider</span>
                        <strong>{routingRuntime.activeProvider}</strong>
                      </div>
                      <div className="routing-runtime-item">
                        <span>Active model</span>
                        <strong>{routingRuntime.activeModel}</strong>
                      </div>
                      <div className="routing-runtime-item">
                        <span>Route reason</span>
                        <strong>
                          {routingRuntime.routeReason.replace("_", " ")}
                        </strong>
                      </div>
                      <div className="routing-runtime-item">
                        <span>Fallback</span>
                        <strong>
                          {routingRuntime.fallbackOccurred
                            ? "Used"
                            : "Not used"}
                        </strong>
                      </div>
                    </div>
                    <p className="settings-hint">
                      Current provider/model: {routingRuntime.currentProvider} /{" "}
                      {routingRuntime.currentModel}
                      {routingRuntime.manualOverride
                        ? " Manual override is active."
                        : " Automatic routing is active."}
                    </p>
                    {routingRuntime.fallbackChain.length > 0 && (
                      <ul className="routing-runtime-fallbacks">
                        {routingRuntime.fallbackChain.map((step, index) => (
                          <li
                            key={`${step.providerType}:${step.modelKey}:${index}`}
                          >
                            <strong>{step.providerType}</strong> /{" "}
                            {step.modelKey} - {step.reason}
                            {step.success ? " (success)" : " (failed)"}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                ) : (
                  <p className="settings-hint">
                    No live routing snapshot yet. Open a task or refresh after a
                    route change.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="settings-section">
          <h3>Provider Failover</h3>
          <p className="settings-description">
            Configure ordered fallback providers/models for {currentProviderLabel}.
            Each LLM provider keeps its own failover chain and retry cooldown.
            Task-level provider or model overrides skip automatic failover.
          </p>

          <div className="settings-subsection" style={{ marginBottom: "12px" }}>
            <label className="settings-label">
              Retry primary after (seconds)
            </label>
            <input
              className="settings-input"
              type="number"
              min={0}
              max={3600}
              step={1}
              value={providerFailover.failoverPrimaryRetryCooldownSeconds ?? ""}
              placeholder="60"
              onChange={(e) =>
                setProviderRoutingConfig(currentProviderType, {
                  failoverPrimaryRetryCooldownSeconds:
                    e.target.value.trim().length === 0
                      ? undefined
                      : Math.max(
                          0,
                          Math.min(
                            3600,
                            Math.floor(Number(e.target.value) || 0),
                          ),
                        ),
                })
              }
            />
            <p className="settings-hint">
              How long to stay on a fallback route before trying this provider&apos;s
              primary route again. Leave blank for the default of 60 seconds.
              Set to 0 to retry the primary on the next route refresh.
            </p>
          </div>

          {currentFailoverProviders.length > 0 ? (
            <div className="settings-subsection">
              {currentFailoverProviders.map((entry, index) => (
                <div
                  key={`${entry.providerType}:${index}`}
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "minmax(180px, 220px) minmax(240px, 1fr) auto",
                    gap: "12px",
                    alignItems: "end",
                    marginBottom: "12px",
                  }}
                >
                  <div>
                    <label className="settings-label">
                      Backup provider #{index + 1}
                    </label>
                    <select
                      className="settings-select"
                      value={entry.providerType}
                      onChange={(e) => {
                        const nextProvider = e.target.value as LLMProviderType;
                        void loadProviderModelsForType(nextProvider);
                        updateCurrentFailoverProviders((prev) =>
                          prev.map((candidate, candidateIndex) =>
                            candidateIndex === index
                              ? {
                                  providerType: nextProvider,
                                  modelKey:
                                    getProviderPrimaryModel(nextProvider) ||
                                    undefined,
                                }
                              : candidate,
                          ),
                        );
                      }}
                    >
                      {configuredFallbackProviderOptions.map((provider) => (
                        <option key={provider.type} value={provider.type}>
                          {provider.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="settings-label">Fallback model</label>
                    <SearchableSelect
                      options={[
                        { value: "", label: "Use provider default" },
                        ...getFailoverModelOptions(
                          entry.providerType,
                          entry.modelKey,
                        ),
                      ]}
                      value={entry.modelKey || ""}
                      onChange={(value) =>
                        updateCurrentFailoverProviders((prev) =>
                          prev.map((candidate, candidateIndex) =>
                            candidateIndex === index
                              ? {
                                  ...candidate,
                                  modelKey: value.trim() || undefined,
                                }
                              : candidate,
                          ),
                        )
                      }
                      placeholder="Use provider default"
                      allowCustomValue
                    />
                  </div>

                  <div
                    style={{
                      display: "flex",
                      gap: "8px",
                      justifyContent: "flex-end",
                      flexWrap: "wrap",
                    }}
                  >
                    <button
                      className="button-small button-secondary"
                      type="button"
                      onClick={() =>
                        updateCurrentFailoverProviders((prev) => {
                          if (index === 0) return prev;
                          const next = [...prev];
                          [next[index - 1], next[index]] = [
                            next[index],
                            next[index - 1],
                          ];
                          return next;
                        })
                      }
                      disabled={index === 0}
                    >
                      Up
                    </button>
                    <button
                      className="button-small button-secondary"
                      type="button"
                      onClick={() =>
                        updateCurrentFailoverProviders((prev) => {
                          if (index >= prev.length - 1) return prev;
                          const next = [...prev];
                          [next[index], next[index + 1]] = [
                            next[index + 1],
                            next[index],
                          ];
                          return next;
                        })
                      }
                      disabled={index >= currentFailoverProviders.length - 1}
                    >
                      Down
                    </button>
                    <button
                      className="button-small button-secondary"
                      type="button"
                      onClick={() =>
                        updateCurrentFailoverProviders((prev) =>
                          prev.filter(
                            (_, candidateIndex) => candidateIndex !== index,
                          ),
                        )
                      }
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="settings-hint">
              No backup providers configured yet for {currentProviderLabel}. Add
              at least one to enable ordered failover for this provider.
            </p>
          )}

          <div className="settings-subsection">
            <button
              className="button-small button-secondary"
              type="button"
              onClick={() => {
                const usedProviders = new Set(
                  currentFailoverProviders.map((entry) => entry.providerType),
                );
                const nextProvider =
                  configuredFallbackProviderOptions.find(
                    (provider) =>
                      provider.type !== currentProviderType &&
                      !usedProviders.has(provider.type),
                  ) ||
                  configuredFallbackProviderOptions.find(
                    (provider) => provider.type !== currentProviderType,
                  );
                if (!nextProvider) {
                  return;
                }
                void loadProviderModelsForType(nextProvider.type);
                updateCurrentFailoverProviders((prev) => [
                  ...prev,
                  {
                    providerType: nextProvider.type,
                    modelKey:
                      getProviderPrimaryModel(nextProvider.type) || undefined,
                  },
                ]);
              }}
              disabled={
                configuredFallbackProviderOptions.filter(
                  (provider) => provider.type !== currentProviderType,
                ).length === 0 || currentFailoverProviders.length >= 5
              }
            >
              Add backup provider
            </button>
            <p className="settings-hint">
              Backups run in order from top to bottom. Leave the model blank to
              use that provider&apos;s default model.
            </p>
          </div>
        </div>

        {testResult && (
          <div
            className={`test-result ${testResult.success ? "success" : "error"}`}
          >
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
                    const truncated =
                      jsonStart > 0 ? error.slice(0, jsonStart) : error;
                    return truncated.length > 200
                      ? truncated.slice(0, 200) + "..."
                      : truncated;
                  })()}
                </span>
              </>
            )}
          </div>
        )}

        {renderModelSettingsActions({ includeProviderActions: true })}
      </div>
    </div>
  );
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
              filteredSidebarItems
                .reduce<{ seenGroups: Set<string>; elements: ReactNode[] }>(
                  (acc, { item, matchedTarget }) => {
                    if (!sidebarSearch && !acc.seenGroups.has(item.group)) {
                      acc.elements.push(
                        <div
                          key={`group-${item.group}`}
                          className="settings-nav-group-header"
                        >
                          {item.group}
                        </div>,
                      );
                      acc.seenGroups.add(item.group);
                    }
                    acc.elements.push(
                      <button
                        key={item.tab}
                        className={`settings-nav-item ${activeTab === item.tab || (item.tab === "morechannels" && (activeTab === "teams" || activeTab === "x")) ? "active" : ""}`}
                        data-tab={item.tab}
                        onClick={() =>
                          handleSidebarItemSelect(item, matchedTarget)
                        }
                      >
                        {item.icon}
                        {getSidebarItemLabel(item)}
                      </button>,
                    );
                    return acc;
                  },
                  { seenGroups: new Set<string>(), elements: [] },
                ).elements
            }
            {sidebarSearch && filteredSidebarItems.length === 0 && (
                <div className="settings-nav-no-results">
                  No matching settings
                </div>
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
                transparencyEffectsEnabled={transparencyEffectsEnabled}
                onThemeChange={onThemeChange}
                onVisualThemeChange={onVisualThemeChange}
                onAccentChange={onAccentChange}
                onTransparencyEffectsEnabledChange={
                  onTransparencyEffectsEnabledChange
                }
                uiDensity={uiDensity}
                onUiDensityChange={onUiDensityChange}
                devRunLoggingEnabled={devRunLoggingEnabled}
                onDevRunLoggingEnabledChange={onDevRunLoggingEnabledChange}
                onShowOnboarding={onShowOnboarding}
                onboardingCompletedAt={onboardingCompletedAt}
              />
            ) : activeTab === "personality" ? (
              <PersonalitySettings onSettingsChanged={onSettingsChanged} />
            ) : activeTab === "companies" ? (
              <CompaniesPanel
                onOpenMissionControl={(companyId) =>
                  onNavigateToMissionControl?.(companyId)
                }
                onOpenDigitalTwins={(companyId) => {
                  setDigitalTwinsCompanyId(companyId);
                  setActiveTab("digitaltwins");
                }}
              />
            ) : activeTab === "digitaltwins" ? (
              <DigitalTwinsPanel
                initialCompanyId={digitalTwinsCompanyId}
                onOpenAgents={onNavigateToAgents}
              />
            ) : activeTab === "health" ? (
              <HealthPanel compact onCreateTask={onCreateTask} />
            ) : activeTab === "system" ? (
              <div className="settings-combined-panel">
                <section className="settings-combined-section">
                  <h2 className="settings-combined-heading">Profiles</h2>
                  <ProfileSettings />
                </section>
                <section className="settings-combined-section">
                  <h2 className="settings-combined-heading">
                    {platform === "win32"
                      ? "System Tray"
                      : platform === "darwin"
                        ? "Menu Bar"
                        : "Tray"}
                  </h2>
                  <TraySettings />
                </section>
                <section className="settings-combined-section">
                  <h2 className="settings-combined-heading">Safety Limits</h2>
                  <GuardrailSettings />
                </section>
                <section className="settings-combined-section">
                  <h2 className="settings-combined-heading">Permissions</h2>
                  <PermissionSettingsPanel workspaceId={workspaceId} />
                </section>
                <section className="settings-combined-section">
                  <h2 className="settings-combined-heading">Admin Policies</h2>
                  <AdminPoliciesPanel />
                </section>
              </div>
            ) : activeTab === "voice" ? (
              <VoiceSettings />
            ) : activeTab === "telegram" ? (
              <TelegramSettings />
            ) : activeTab === "slack" ? (
              <SlackSettings />
            ) : activeTab === "whatsapp" ? (
              <WhatsAppSettings />
            ) : activeTab === "morechannels" ||
              activeTab === "teams" ||
              activeTab === "x" ? (
              (() => {
                const effectiveSecondary =
                  activeTab === "teams" || activeTab === "x"
                    ? activeTab
                    : activeSecondaryChannel;
                return (
                  <div className="more-channels-panel">
                    <div className="more-channels-header">
                      <h2>More Channels</h2>
                      <p className="settings-description">
                        Configure additional messaging platforms
                      </p>
                    </div>
                    <div className="more-channels-tabs">
                      {secondaryChannelItems.map((item) => (
                        <button
                          key={item.key}
                          className={`more-channels-tab ${effectiveSecondary === item.key ? "active" : ""}`}
                          onClick={() => {
                            setActiveTab("morechannels");
                            setActiveSecondaryChannel(item.key);
                          }}
                        >
                          {item.icon}
                          <span>{item.label}</span>
                        </button>
                      ))}
                    </div>
                    <div className="more-channels-content">
                      {effectiveSecondary === "teams" && <TeamsSettings />}
                      {effectiveSecondary === "x" && <XSettings />}
                      {effectiveSecondary === "discord" && <DiscordSettings />}
                      {effectiveSecondary === "imessage" && (
                        <ImessageSettings />
                      )}
                      {effectiveSecondary === "signal" && <SignalSettings />}
                      {effectiveSecondary === "mattermost" && (
                        <MattermostSettings />
                      )}
                      {effectiveSecondary === "matrix" && <MatrixSettings />}
                      {effectiveSecondary === "twitch" && <TwitchSettings />}
                      {effectiveSecondary === "line" && <LineSettings />}
                      {effectiveSecondary === "bluebubbles" && (
                        <BlueBubblesSettings />
                      )}
                      {effectiveSecondary === "email" && <EmailSettings />}
                      {effectiveSecondary === "googlechat" && (
                        <GoogleChatSettings />
                      )}
                      {effectiveSecondary === "feishu" && <FeishuSettings />}
                      {effectiveSecondary === "wecom" && <WeComSettings />}
                    </div>
                  </div>
                );
              })()
            ) : activeTab === "aimodels" ? (
              <div className="more-channels-panel">
                <div className="more-channels-header">
                  <h2>AI & Models</h2>
                  <p className="settings-description">
                    Configure AI model, image model, video model, and web
                    search
                  </p>
                </div>
                <div className="more-channels-tabs">
                  <button
                    className={`more-channels-tab ${activeAIModelsSubTab === "llm" ? "active" : ""}`}
                    onClick={() => setActiveAIModelsSubTab("llm")}
                  >
                    <Layers {...S} />
                    <span>AI Model</span>
                  </button>
                  <button
                    className={`more-channels-tab ${activeAIModelsSubTab === "image" ? "active" : ""}`}
                    onClick={() => setActiveAIModelsSubTab("image")}
                  >
                    <ImageIcon {...S} />
                    <span>Image Model</span>
                  </button>
                  <button
                    className={`more-channels-tab ${activeAIModelsSubTab === "video" ? "active" : ""}`}
                    onClick={() => setActiveAIModelsSubTab("video")}
                  >
                    <Film {...S} />
                    <span>Video Model</span>
                  </button>
                  <button
                    className={`more-channels-tab ${activeAIModelsSubTab === "search" ? "active" : ""}`}
                    onClick={() => setActiveAIModelsSubTab("search")}
                  >
                    <Search {...S} />
                    <span>Web Search</span>
                  </button>
                </div>
                <div className="more-channels-content">
                  {activeAIModelsSubTab === "llm" && renderLLMPanel()}
                  {activeAIModelsSubTab === "image" && renderImagePanel()}
                  {activeAIModelsSubTab === "video" && renderVideoPanel()}
                  {activeAIModelsSubTab === "search" && <SearchSettings />}
                </div>
              </div>
            ) : activeTab === "updates" ? (
              <UpdateSettings />
            ) : activeTab === "automations" ? (
              <div className="more-channels-panel">
                <div className="more-channels-header">
                  <h2>Automations</h2>
                  <p className="settings-description">
                    Routines first, then queueing, workflow intelligence, and the lower-level automation engines
                    that routines compile into
                  </p>
                </div>
                <div className="more-channels-tabs">
                  {(
                    [
                      "routines",
                      "queue",
                      "council",
                      "subconscious",
                      "scheduled",
                      "hooks",
                      "triggers",
                    ] as const
                  ).map((key) => (
                    <button
                      key={key}
                      className={`more-channels-tab ${activeAutomationsSubTab === key ? "active" : ""}`}
                      onClick={() => setActiveAutomationsSubTab(key)}
                    >
                      {key === "routines" && <Box {...S} />}
                      {key === "queue" && <ListOrdered {...S} />}
                      {key === "council" && <Users {...S} />}
                      {key === "subconscious" && <Sparkles {...S} />}
                      {key === "scheduled" && <Clock {...S} />}
                      {key === "hooks" && <Link {...S} />}
                      {key === "triggers" && <Zap {...S} />}
                      <span>
                        {key === "routines" && "Routines"}
                        {key === "queue" && "Task Queue"}
                        {key === "council" && "R&D Council"}
                        {key === "subconscious" && "Workflow Intelligence"}
                        {key === "scheduled" && "Scheduled Tasks"}
                        {key === "hooks" && "Webhooks"}
                        {key === "triggers" && "Event Triggers"}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="more-channels-content">
                  {activeAutomationsSubTab === "routines" && <RoutineSettingsPanel />}
                  {activeAutomationsSubTab === "queue" && <QueueSettings />}
                  {activeAutomationsSubTab === "council" && (
                    <CouncilSettings
                      workspaceId={workspaceId}
                      onOpenTask={onOpenTask}
                    />
                  )}
                  {activeAutomationsSubTab === "subconscious" && (
                    <SubconsciousSettingsPanel
                      initialWorkspaceId={workspaceId}
                      onOpenTask={onOpenTask}
                    />
                  )}
                  {activeAutomationsSubTab === "scheduled" && (
                    <ScheduledTasksSettings />
                  )}
                  {activeAutomationsSubTab === "hooks" && <HooksSettings />}
                  {activeAutomationsSubTab === "triggers" && (
                    <EventTriggersPanel workspaceId={workspaceId} />
                  )}
                </div>
              </div>
            ) : activeTab === "skills" ? (
              <div className="more-channels-panel">
                <div className="more-channels-header">
                  <h2>Skills</h2>
                  <p className="settings-description">
                    Manage custom skills and browse the Skill Store
                  </p>
                </div>
                <div className="more-channels-tabs">
                  <button
                    className={`more-channels-tab ${activeSkillsSubTab === "custom" ? "active" : ""}`}
                    onClick={() => setActiveSkillsSubTab("custom")}
                  >
                    <Wrench {...S} />
                    <span>Custom Skills</span>
                  </button>
                  <button
                    className={`more-channels-tab ${activeSkillsSubTab === "store" ? "active" : ""}`}
                    onClick={() => setActiveSkillsSubTab("store")}
                  >
                    <Store {...S} />
                    <span>Skill Store</span>
                  </button>
                </div>
                <div className="more-channels-content">
                  {activeSkillsSubTab === "custom" && <SkillsSettings />}
                  {activeSkillsSubTab === "store" && <SkillHubBrowser />}
                </div>
              </div>
            ) : activeTab === "integrations" ? (
              <div className="more-channels-panel">
                <div className="more-channels-header">
                  <h2>Integrations</h2>
                  <p className="settings-description">
                    Git, connectors, and infrastructure
                  </p>
                </div>
                <div className="more-channels-tabs">
                  <button
                    className={`more-channels-tab ${activeIntegrationsSubTab === "git" ? "active" : ""}`}
                    onClick={() => setActiveIntegrationsSubTab("git")}
                  >
                    <GitBranch {...S} />
                    <span>Git</span>
                  </button>
                  <button
                    className={`more-channels-tab ${activeIntegrationsSubTab === "connectors" ? "active" : ""}`}
                    onClick={() => setActiveIntegrationsSubTab("connectors")}
                  >
                    <LayoutGrid {...S} />
                    <span>Connectors</span>
                  </button>
                  <button
                    className={`more-channels-tab ${activeIntegrationsSubTab === "identity" ? "active" : ""}`}
                    onClick={() => setActiveIntegrationsSubTab("identity")}
                  >
                    <UsersRound {...S} />
                    <span>Identity</span>
                  </button>
                  <button
                    className={`more-channels-tab ${activeIntegrationsSubTab === "infrastructure" ? "active" : ""}`}
                    onClick={() =>
                      setActiveIntegrationsSubTab("infrastructure")
                    }
                  >
                    <Zap {...S} />
                    <span>Infrastructure</span>
                  </button>
                </div>
                <div className="more-channels-content">
                  {activeIntegrationsSubTab === "git" && <WorktreeSettings />}
                  {activeIntegrationsSubTab === "connectors" && (
                    <ConnectorsSettings />
                  )}
                  {activeIntegrationsSubTab === "identity" && (
                    <ContactIdentitySettings workspaceId={workspaceId} />
                  )}
                  {activeIntegrationsSubTab === "infrastructure" && (
                    <InfraSettings />
                  )}
                </div>
              </div>
            ) : activeTab === "mcp" ? (
              <MCPSettings />
            ) : activeTab === "tools" ? (
              <div className="settings-tools-stack">
                <BuiltinToolsSettings />
                <ChronicleSettingsCard />
                <ComputerUseSettings />
              </div>
            ) : activeTab === "access" ? (
              <div className="more-channels-panel">
                <div className="more-channels-header">
                  <h2>Access</h2>
                  <p className="settings-description">
                    Remote access and web access
                  </p>
                </div>
                <div className="more-channels-tabs">
                  <button
                    className={`more-channels-tab ${activeAccessSubTab === "controlplane" ? "active" : ""}`}
                    onClick={() => setActiveAccessSubTab("controlplane")}
                  >
                    <Monitor {...S} />
                    <span>Remote Access</span>
                  </button>
                  <button
                    className={`more-channels-tab ${activeAccessSubTab === "webaccess" ? "active" : ""}`}
                    onClick={() => setActiveAccessSubTab("webaccess")}
                  >
                    <Monitor {...S} />
                    <span>Web Access</span>
                  </button>
                </div>
                <div className="more-channels-content">
                  {activeAccessSubTab === "controlplane" && (
                    <ControlPlaneSettings />
                  )}
                  {activeAccessSubTab === "webaccess" && (
                    <WebAccessSettingsPanel />
                  )}
                </div>
              </div>
            ) : activeTab === "nodes" ? (
              <NodesSettings />
            ) : activeTab === "extensions" ? (
              <ExtensionsSettings />
            ) : activeTab === "memory" ? (
              <MemoryHubSettings
                initialWorkspaceId={workspaceId}
                onSettingsChanged={onSettingsChanged}
              />
            ) : activeTab === "insights" ? (
              <UsageInsightsPanel workspaceId={workspaceId} />
            ) : activeTab === "suggestions" ? (
              <SuggestionsPanel
                workspaceId={workspaceId}
                onCreateTask={onCreateTask}
              />
            ) : activeTab === "traces" ? (
              <TaskTraceDebuggerPanel
                workspaceId={workspaceId}
                onOpenTask={onOpenTask}
              />
            ) : activeTab === "customize" ? (
              <CustomizePanel
                onNavigateToConnectors={() => {
                  setActiveTab("integrations");
                  setActiveIntegrationsSubTab("connectors");
                }}
                onNavigateToSkills={() => setActiveTab("skills")}
                onCreateTask={onCreateTask}
              />
            ) : activeTab === "briefing" ? (
              <BriefingPanel workspaceId={workspaceId} />
            ) : loading ? (
              <div className="settings-loading">Loading settings...</div>
            ) : (
              renderLLMPanel()
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
