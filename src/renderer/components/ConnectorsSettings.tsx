import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import { ConnectorSetupModal, ConnectorProvider } from "./ConnectorSetupModal";
import { ConnectorEnvModal, ConnectorEnvField } from "./ConnectorEnvModal";
import { ConnectorProfileView } from "./ConnectorProfileView";
import { NotionSettings } from "./NotionSettings";
import { BoxSettings } from "./BoxSettings";
import { OneDriveSettings } from "./OneDriveSettings";
import { GoogleWorkspaceSettings } from "./GoogleWorkspaceSettings";
import { AgentMailSettings } from "./AgentMailSettings";
import { DropboxSettings } from "./DropboxSettings";
import { SharePointSettings } from "./SharePointSettings";
import { ConnectorBrandIcon } from "./ConnectorBrandIcon";

// Types (matching preload types)
type MCPConnectionStatus = "disconnected" | "connecting" | "connected" | "reconnecting" | "error";

type MCPServerConfig = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
};

type MCPServerStatus = {
  id: string;
  name: string;
  status: MCPConnectionStatus;
  error?: string;
  tools: Array<{ name: string }>;
};

type MCPSettingsData = {
  servers: MCPServerConfig[];
};

type ConnectorCategory =
  | ""
  | "crm"
  | "productivity"
  | "communication"
  | "finance"
  | "legal"
  | "devtools";

interface ConnectorDefinition {
  key: string;
  name: string;
  registryId: string;
  description: string;
  supportsOAuth: boolean;
  provider?: ConnectorProvider;
  envFields?: ConnectorEnvField[];
}

const SHIPPED_CONNECTOR_IDS = new Set([
  "salesforce",
  "jira",
  "hubspot",
  "zendesk",
  "servicenow",
  "linear",
  "asana",
  "okta",
  "resend",
  "google-workspace",
  "discord",
  "figma",
  "vercel",
  "monday",
  "maps",
  "miro",
  "supabase",
  "excalidraw",
  "stripe",
  "huggingface",
  "ahrefs",
  "mermaid-chart",
  "cloudflare",
  "make",
  "clinical-trials",
  "smartsheet",
  "netlify",
  "airtable",
  "paypal",
  "square",
  "attio",
  "honeycomb",
  "calcom",
  "cloudinary",
  "tavily",
  "tldraw",
  "amplitude",
  "clerk",
  "mem",
  "grafana",
  "mailtrap",
  "socket",
  "metabase",
  "shadcn-ui",
  "growthbook",
  "drafts",
  "fantastical",
  "tomba",
  "daloopa",
  "morningstar",
  "spglobal",
  "factset",
  "moodys",
  "mtnewswires",
  "aiera",
  "lseg",
  "pitchbook",
  "chronograph",
  "egnyte",
]);

const CONNECTORS: ConnectorDefinition[] = [
  {
    key: "salesforce",
    name: "Salesforce",
    registryId: "salesforce",
    description: "CRM (accounts, cases, opportunities).",
    supportsOAuth: true,
    provider: "salesforce",
  },
  {
    key: "jira",
    name: "Jira",
    registryId: "jira",
    description: "Issue tracking for teams.",
    supportsOAuth: true,
    provider: "jira",
  },
  {
    key: "hubspot",
    name: "HubSpot",
    registryId: "hubspot",
    description: "CRM objects for contacts, companies, deals.",
    supportsOAuth: true,
    provider: "hubspot",
  },
  {
    key: "zendesk",
    name: "Zendesk",
    registryId: "zendesk",
    description: "Support tickets and customer operations.",
    supportsOAuth: true,
    provider: "zendesk",
  },
  {
    key: "servicenow",
    name: "ServiceNow",
    registryId: "servicenow",
    description: "ITSM records and table APIs.",
    supportsOAuth: false,
    envFields: [
      {
        key: "SERVICENOW_INSTANCE_URL",
        label: "Instance URL",
        placeholder: "https://instance.service-now.com",
      },
      { key: "SERVICENOW_INSTANCE", label: "Instance Subdomain", placeholder: "dev12345" },
      { key: "SERVICENOW_USERNAME", label: "Username" },
      { key: "SERVICENOW_PASSWORD", label: "Password", type: "password" },
      { key: "SERVICENOW_ACCESS_TOKEN", label: "Access Token", type: "password" },
    ],
  },
  {
    key: "linear",
    name: "Linear",
    registryId: "linear",
    description: "Project and issue tracking (GraphQL).",
    supportsOAuth: false,
    envFields: [{ key: "LINEAR_API_KEY", label: "API Key", type: "password" }],
  },
  {
    key: "asana",
    name: "Asana",
    registryId: "asana",
    description: "Work management tasks and projects.",
    supportsOAuth: false,
    envFields: [{ key: "ASANA_ACCESS_TOKEN", label: "Access Token", type: "password" }],
  },
  {
    key: "okta",
    name: "Okta",
    registryId: "okta",
    description: "User and directory management.",
    supportsOAuth: false,
    envFields: [
      { key: "OKTA_BASE_URL", label: "Okta Base URL", placeholder: "https://your-org.okta.com" },
      { key: "OKTA_API_TOKEN", label: "API Token", type: "password" },
    ],
  },
  {
    key: "resend",
    name: "Resend",
    registryId: "resend",
    description: "Transactional email send + inbound webhook management.",
    supportsOAuth: false,
    envFields: [
      { key: "RESEND_API_KEY", label: "API Key", type: "password" },
      { key: "RESEND_BASE_URL", label: "Base URL", placeholder: "https://api.resend.com" },
    ],
  },
  {
    key: "google-workspace",
    name: "Google Workspace",
    registryId: "google-workspace",
    description:
      "Single Google MCP connector for Gmail, Calendar, Drive, Docs, Sheets, Slides, Tasks, and Chat.",
    supportsOAuth: true,
    provider: "google-workspace",
  },
  {
    key: "discord",
    name: "Discord",
    registryId: "discord",
    description: "Guild management, channels, roles, messages, and webhooks.",
    supportsOAuth: false,
    envFields: [
      { key: "DISCORD_BOT_TOKEN", label: "Bot Token", type: "password" },
      { key: "DISCORD_APPLICATION_ID", label: "Application ID" },
      { key: "DISCORD_GUILD_ID", label: "Default Guild ID (optional)" },
    ],
  },
  {
    key: "figma",
    name: "Figma",
    registryId: "figma",
    description: "Generate diagrams and better code from Figma context.",
    supportsOAuth: false,
    envFields: [{ key: "FIGMA_ACCESS_TOKEN", label: "Access Token", type: "password" }],
  },
  {
    key: "vercel",
    name: "Vercel",
    registryId: "vercel",
    description: "Analyze, debug, and manage projects and deployments.",
    supportsOAuth: false,
    envFields: [{ key: "VERCEL_TOKEN", label: "Token", type: "password" }],
  },
  {
    key: "monday",
    name: "monday.com",
    registryId: "monday",
    description: "Manage projects, boards, and workflows in monday.com.",
    supportsOAuth: false,
    envFields: [{ key: "MONDAY_API_TOKEN", label: "API Token", type: "password" }],
  },
  {
    key: "maps",
    name: "Maps",
    registryId: "maps",
    description:
      "Nearby place search and walking routes with OSM defaults and optional Google Maps.",
    supportsOAuth: false,
    envFields: [
      {
        key: "MAPS_PROVIDER",
        label: "Provider",
        placeholder: "auto",
      },
      {
        key: "GOOGLE_MAPS_API_KEY",
        label: "Google Maps API Key (optional)",
        type: "password",
      },
      {
        key: "NOMINATIM_BASE_URL",
        label: "Nominatim Base URL (optional)",
        placeholder: "https://nominatim.openstreetmap.org",
      },
      {
        key: "OSRM_BASE_URL",
        label: "OSRM Base URL (optional)",
        placeholder: "https://router.project-osrm.org",
      },
    ],
  },
  {
    key: "miro",
    name: "Miro",
    registryId: "miro",
    description: "Access and create new content on Miro boards.",
    supportsOAuth: false,
    envFields: [{ key: "MIRO_OAUTH_TOKEN", label: "OAuth Token", type: "password" }],
  },
  {
    key: "supabase",
    name: "Supabase",
    registryId: "supabase",
    description: "Manage databases, authentication, and storage.",
    supportsOAuth: false,
    envFields: [
      { key: "SUPABASE_URL", label: "Project URL", placeholder: "https://xxx.supabase.co" },
      { key: "SUPABASE_SERVICE_ROLE_KEY", label: "Service Role Key", type: "password" },
    ],
  },
  {
    key: "excalidraw",
    name: "Excalidraw",
    registryId: "excalidraw",
    description: "MCP for creating interactive hand-drawn diagrams in Excalidraw.",
    supportsOAuth: false,
  },
  {
    key: "stripe",
    name: "Stripe",
    registryId: "stripe",
    description: "Payment processing and financial infrastructure tools.",
    supportsOAuth: false,
    envFields: [{ key: "STRIPE_SECRET_KEY", label: "Secret Key", type: "password" }],
  },
  {
    key: "huggingface",
    name: "Hugging Face",
    registryId: "huggingface",
    description: "Access the Hugging Face Hub and thousands of Gradio Apps.",
    supportsOAuth: false,
    envFields: [{ key: "HUGGINGFACE_API_KEY", label: "API Key", type: "password" }],
  },
  {
    key: "ahrefs",
    name: "Ahrefs",
    registryId: "ahrefs",
    description: "SEO & AI search analytics.",
    supportsOAuth: false,
    envFields: [{ key: "API_KEY", label: "API Key", type: "password" }],
  },
  {
    key: "mermaid-chart",
    name: "Mermaid Chart",
    registryId: "mermaid-chart",
    description: "Validates Mermaid syntax, renders diagrams as high-quality SVG.",
    supportsOAuth: false,
  },
  {
    key: "cloudflare",
    name: "Cloudflare Developer Platform",
    registryId: "cloudflare",
    description: "Build applications with compute, storage, and AI.",
    supportsOAuth: false,
  },
  {
    key: "make",
    name: "Make",
    registryId: "make",
    description: "Run Make scenarios and manage your Make account.",
    supportsOAuth: false,
    envFields: [
      { key: "MAKE_API_KEY", label: "API Key", type: "password" },
      { key: "MAKE_TEAM_ID", label: "Team ID (optional)", placeholder: "For deployment" },
    ],
  },
  {
    key: "clinical-trials",
    name: "Clinical Trials",
    registryId: "clinical-trials",
    description: "Access ClinicalTrials.gov data.",
    supportsOAuth: false,
  },
  {
    key: "smartsheet",
    name: "Smartsheet",
    registryId: "smartsheet",
    description: "Analyze and manage Smartsheet data with Claude.",
    supportsOAuth: false,
    envFields: [{ key: "SMARTSHEET_API_KEY", label: "API Token", type: "password" }],
  },
  {
    key: "netlify",
    name: "Netlify",
    registryId: "netlify",
    description: "Create, deploy, manage, and secure websites on Netlify.",
    supportsOAuth: false,
    envFields: [
      {
        key: "NETLIFY_PERSONAL_ACCESS_TOKEN",
        label: "Personal Access Token (optional)",
        type: "password",
      },
    ],
  },
  {
    key: "airtable",
    name: "Airtable",
    registryId: "airtable",
    description: "Bring your structured data to Claude.",
    supportsOAuth: false,
    envFields: [{ key: "AIRTABLE_API_KEY", label: "Personal Access Token", type: "password" }],
  },
  {
    key: "paypal",
    name: "PayPal",
    registryId: "paypal",
    description: "Access PayPal payments platform.",
    supportsOAuth: false,
    envFields: [
      { key: "PAYPAL_ACCESS_TOKEN", label: "Access Token", type: "password" },
      {
        key: "PAYPAL_ENVIRONMENT",
        label: "Environment",
        placeholder: "SANDBOX or PRODUCTION",
      },
    ],
  },
  {
    key: "square",
    name: "Square",
    registryId: "square",
    description: "Search and manage transaction, merchant, and payment data.",
    supportsOAuth: false,
    envFields: [
      { key: "ACCESS_TOKEN", label: "Square Access Token", type: "password" },
      { key: "SANDBOX", label: "Sandbox mode", placeholder: "true for testing" },
    ],
  },
  {
    key: "attio",
    name: "Attio",
    registryId: "attio",
    description: "Search, manage, and update your Attio CRM from Claude.",
    supportsOAuth: false,
    envFields: [{ key: "ATTIO_API_KEY", label: "API Key", type: "password" }],
  },
  {
    key: "honeycomb",
    name: "Honeycomb",
    registryId: "honeycomb",
    description: "Query and explore observability data and SLOs.",
    supportsOAuth: false,
    envFields: [{ key: "HONEYCOMB_API_KEY", label: "API Key", type: "password" }],
  },
  {
    key: "calcom",
    name: "Cal.com",
    registryId: "calcom",
    description: "Manage event types, availability, and bookings.",
    supportsOAuth: false,
    envFields: [{ key: "CAL_API_KEY", label: "API Key", type: "password" }],
  },
  {
    key: "cloudinary",
    name: "Cloudinary",
    registryId: "cloudinary",
    description: "Manage, transform and deliver your images & videos.",
    supportsOAuth: false,
    envFields: [
      { key: "CLOUDINARY_CLOUD_NAME", label: "Cloud Name" },
      { key: "CLOUDINARY_API_KEY", label: "API Key", type: "password" },
      { key: "CLOUDINARY_API_SECRET", label: "API Secret", type: "password" },
    ],
  },
  {
    key: "tavily",
    name: "Tavily",
    registryId: "tavily",
    description: "Connect your AI agents to the web. Real-time search, extract, map, and crawl.",
    supportsOAuth: false,
    envFields: [{ key: "TAVILY_API_KEY", label: "API Key", type: "password" }],
  },
  {
    key: "tldraw",
    name: "tldraw",
    registryId: "tldraw",
    description: "Let Claude sketch, draw, and diagram. Manage local .tldr canvas files.",
    supportsOAuth: false,
    envFields: [
      {
        key: "TLDRAW_DIR",
        label: "tldraw directory",
        placeholder: "~/.tldraw (default)",
      },
    ],
  },
  {
    key: "amplitude",
    name: "Amplitude",
    registryId: "amplitude",
    description: "Search, access, and get insights on your Amplitude analytics data.",
    supportsOAuth: false,
    envFields: [{ key: "AMPLITUDE_API_KEY", label: "API Key", type: "password" }],
  },
  {
    key: "clerk",
    name: "Clerk",
    registryId: "clerk",
    description: "Add authentication, organizations, and billing. Manage users and sessions.",
    supportsOAuth: false,
    envFields: [{ key: "CLERK_API_KEY", label: "Secret Key", type: "password" }],
  },
  {
    key: "mem",
    name: "Mem",
    registryId: "mem",
    description: "The AI notebook for everything on your mind. Notes, collections, and search.",
    supportsOAuth: false,
    envFields: [{ key: "MEM_API_KEY", label: "API Key", type: "password" }],
  },
  {
    key: "grafana",
    name: "Grafana",
    registryId: "grafana",
    description: "Access Grafana dashboards, datasources, alerting, and more.",
    supportsOAuth: false,
    envFields: [
      { key: "GRAFANA_URL", label: "Grafana URL", placeholder: "https://your-grafana.com" },
      {
        key: "GRAFANA_SERVICE_ACCOUNT_TOKEN",
        label: "Service Account Token",
        type: "password",
      },
    ],
  },
  {
    key: "mailtrap",
    name: "Mailtrap",
    registryId: "mailtrap",
    description: "Send emails and manage templates using Mailtrap.",
    supportsOAuth: false,
    envFields: [
      { key: "MAILTRAP_API_TOKEN", label: "API Token", type: "password" },
      { key: "DEFAULT_FROM_EMAIL", label: "Default From Email" },
      { key: "MAILTRAP_ACCOUNT_ID", label: "Account ID" },
    ],
  },
  {
    key: "socket",
    name: "Socket",
    registryId: "socket",
    description:
      "MCP server for scanning dependencies. Check security scores for npm, PyPI, and more.",
    supportsOAuth: false,
    envFields: [
      { key: "SOCKET_API_KEY", label: "API Key (optional for public)", type: "password" },
    ],
  },
  {
    key: "metabase",
    name: "Metabase",
    registryId: "metabase",
    description: "High-performance MCP server for Metabase analytics data access.",
    supportsOAuth: false,
    envFields: [
      { key: "METABASE_URL", label: "Metabase URL", placeholder: "https://your-metabase.com" },
      { key: "METABASE_API_KEY", label: "API Key", type: "password" },
    ],
  },
  {
    key: "shadcn-ui",
    name: "Shadcn UI",
    registryId: "shadcn-ui",
    description: "MCP server for shadcn/ui components. Browse, search, and install components.",
    supportsOAuth: false,
  },
  {
    key: "growthbook",
    name: "GrowthBook",
    registryId: "growthbook",
    description: "Feature flags and A/B testing. Create experiments, manage SDK connections.",
    supportsOAuth: false,
    envFields: [
      { key: "GB_API_KEY", label: "API Key", type: "password" },
      { key: "GB_EMAIL", label: "Email" },
    ],
  },
  {
    key: "drafts",
    name: "Drafts",
    registryId: "drafts",
    description: "MCP server for the Drafts app on macOS. Create, search, and manage drafts.",
    supportsOAuth: false,
  },
  {
    key: "fantastical",
    name: "Fantastical",
    registryId: "fantastical",
    description: "Read events and tasks, create new items from Fantastical calendar (macOS).",
    supportsOAuth: false,
  },
  {
    key: "tomba",
    name: "Tomba",
    registryId: "tomba",
    description: "MCP server for Tomba email finder and verification API.",
    supportsOAuth: false,
    envFields: [
      { key: "TOMBA_API_KEY", label: "API Key", type: "password" },
      { key: "TOMBA_SECRET_KEY", label: "Secret Key", type: "password" },
    ],
  },
  {
    key: "daloopa",
    name: "Daloopa",
    registryId: "daloopa",
    description: "Read-only normalized financial data and filings.",
    supportsOAuth: false,
    envFields: [
      { key: "DALOOPA_API_KEY", label: "API Key", type: "password" },
      { key: "DALOOPA_BASE_URL", label: "Base URL" },
    ],
  },
  {
    key: "morningstar",
    name: "Morningstar",
    registryId: "morningstar",
    description: "Read-only company, fund, and market data.",
    supportsOAuth: false,
    envFields: [
      { key: "MORNINGSTAR_API_KEY", label: "API Key", type: "password" },
      { key: "MORNINGSTAR_BASE_URL", label: "Base URL" },
    ],
  },
  {
    key: "spglobal",
    name: "S&P Global",
    registryId: "spglobal",
    description: "Read-only financial intelligence, ratings, and market data.",
    supportsOAuth: false,
    envFields: [
      { key: "SPGLOBAL_API_KEY", label: "API Key", type: "password" },
      { key: "SPGLOBAL_BASE_URL", label: "Base URL" },
    ],
  },
  {
    key: "factset",
    name: "FactSet",
    registryId: "factset",
    description: "Read-only financials, market data, and research context.",
    supportsOAuth: false,
    envFields: [
      { key: "FACTSET_API_KEY", label: "API Key", type: "password" },
      { key: "FACTSET_BASE_URL", label: "Base URL" },
    ],
  },
  {
    key: "moodys",
    name: "Moody's",
    registryId: "moodys",
    description: "Read-only ratings, entity, and risk documents.",
    supportsOAuth: false,
    envFields: [
      { key: "MOODYS_API_KEY", label: "API Key", type: "password" },
      { key: "MOODYS_BASE_URL", label: "Base URL" },
    ],
  },
  {
    key: "mtnewswires",
    name: "MT Newswires",
    registryId: "mtnewswires",
    description: "Read-only market news.",
    supportsOAuth: false,
    envFields: [
      { key: "MTNEWSWIRES_API_KEY", label: "API Key", type: "password" },
      { key: "MTNEWSWIRES_BASE_URL", label: "Base URL" },
    ],
  },
  {
    key: "aiera",
    name: "Aiera",
    registryId: "aiera",
    description: "Read-only events, transcripts, and filings.",
    supportsOAuth: false,
    envFields: [
      { key: "AIERA_API_KEY", label: "API Key", type: "password" },
      { key: "AIERA_BASE_URL", label: "Base URL" },
    ],
  },
  {
    key: "lseg",
    name: "LSEG",
    registryId: "lseg",
    description: "Read-only market data, news, and financial analytics.",
    supportsOAuth: false,
    envFields: [
      { key: "LSEG_API_KEY", label: "API Key", type: "password" },
      { key: "LSEG_BASE_URL", label: "Base URL" },
    ],
  },
  {
    key: "pitchbook",
    name: "PitchBook",
    registryId: "pitchbook",
    description: "Read-only private market company and deal data.",
    supportsOAuth: false,
    envFields: [
      { key: "PITCHBOOK_API_KEY", label: "API Key", type: "password" },
      { key: "PITCHBOOK_BASE_URL", label: "Base URL" },
    ],
  },
  {
    key: "chronograph",
    name: "Chronograph",
    registryId: "chronograph",
    description: "Read-only portfolio monitoring and fund data.",
    supportsOAuth: false,
    envFields: [
      { key: "CHRONOGRAPH_API_KEY", label: "API Key", type: "password" },
      { key: "CHRONOGRAPH_BASE_URL", label: "Base URL" },
    ],
  },
  {
    key: "egnyte",
    name: "Egnyte",
    registryId: "egnyte",
    description: "Read-only finance document search and retrieval.",
    supportsOAuth: false,
    envFields: [
      { key: "EGNYTE_API_KEY", label: "API Key", type: "password" },
      { key: "EGNYTE_BASE_URL", label: "Base URL" },
    ],
  },
];

interface IntegrationDefinition {
  key: string;
  name: string;
  description: string;
  component: ReactNode;
}

const INTEGRATIONS: IntegrationDefinition[] = [
  {
    key: "notion",
    name: "Notion",
    description: "Search and create content on your Notion pages.",
    component: <NotionSettings />,
  },
  {
    key: "sharepoint",
    name: "SharePoint",
    description: "Get in-depth answers from your SharePoint content.",
    component: <SharePointSettings />,
  },
  {
    key: "onedrive",
    name: "OneDrive",
    description: "Get in-depth answers from your OneDrive content.",
    component: <OneDriveSettings />,
  },
  {
    key: "googleworkspace",
    name: "Gmail",
    description: "Connect Gmail for inbox search, thread reading, drafts, sending, and labels.",
    component: <GoogleWorkspaceSettings />,
  },
  {
    key: "agentmail",
    name: "AgentMail",
    description: "Native agent inboxes, pods, domains, scoped keys, and realtime email.",
    component: <AgentMailSettings />,
  },
  {
    key: "box",
    name: "Box",
    description: "Get in-depth answers from your Box content.",
    component: <BoxSettings />,
  },
  {
    key: "dropbox",
    name: "Dropbox",
    description: "Search and access your Dropbox content.",
    component: <DropboxSettings />,
  },
];

const getStatusColor = (status: MCPConnectionStatus): string => {
  switch (status) {
    case "connected":
      return "var(--color-success)";
    case "connecting":
    case "reconnecting":
      return "var(--color-warning)";
    case "error":
      return "var(--color-error)";
    default:
      return "var(--color-text-tertiary)";
  }
};

const getStatusText = (status: MCPConnectionStatus): string => {
  switch (status) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    case "error":
      return "Error";
    default:
      return "Disconnected";
  }
};

function matchConnector(config: MCPServerConfig, connector: ConnectorDefinition): boolean {
  const nameMatch = config.name.toLowerCase().includes(connector.key);
  const argsMatch = (config.args || []).some((arg) => arg.toLowerCase().includes(connector.key));
  const commandMatch = (config.command || "").toLowerCase().includes(connector.key);
  return nameMatch || argsMatch || commandMatch;
}

function getConnectorCategory(connector: ConnectorDefinition): Exclude<ConnectorCategory, ""> {
  if (["salesforce", "hubspot", "zendesk"].includes(connector.key)) {
    return "crm";
  }
  if (["discord", "resend", "mailtrap"].includes(connector.key)) {
    return "communication";
  }
  if (
    [
      "jira",
      "linear",
      "asana",
      "servicenow",
      "okta",
      "figma",
      "vercel",
      "monday",
      "excalidraw",
      "supabase",
      "netlify",
      "honeycomb",
      "tavily",
      "amplitude",
      "clerk",
      "grafana",
      "socket",
      "metabase",
      "shadcn-ui",
      "growthbook",
      "tomba",
    ].includes(connector.key)
  ) {
    return "devtools";
  }
  if (
    [
      "miro",
      "huggingface",
      "mermaid-chart",
      "maps",
      "make",
      "smartsheet",
      "airtable",
      "calcom",
      "cloudinary",
      "tldraw",
      "mem",
      "drafts",
      "fantastical",
    ].includes(connector.key)
  ) {
    return "productivity";
  }
  if (["paypal", "stripe", "square", "attio"].includes(connector.key)) {
    return "crm";
  }
  if (
    [
      "daloopa",
      "morningstar",
      "spglobal",
      "factset",
      "moodys",
      "mtnewswires",
      "aiera",
      "lseg",
      "pitchbook",
      "chronograph",
      "egnyte",
    ].includes(connector.key)
  ) {
    return "finance";
  }
  if (["ahrefs", "cloudflare"].includes(connector.key)) {
    return "devtools";
  }
  if (["clinical-trials"].includes(connector.key)) {
    return "legal";
  }
  return "productivity";
}

function getIntegrationCategory(): Exclude<ConnectorCategory, ""> {
  return "productivity";
}

function normalizeConnectorSearch(value: string): string {
  return value.trim().toLowerCase();
}

export function ConnectorsSettings() {
  const [settings, setSettings] = useState<MCPSettingsData | null>(null);
  const [serverStatuses, setServerStatuses] = useState<MCPServerStatus[]>([]);
  const [registryConnectorIds, setRegistryConnectorIds] = useState<Set<string> | null>(null);
  const [loading, setLoading] = useState(true);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [connectingServer, setConnectingServer] = useState<string | null>(null);
  const [connectionErrors, setConnectionErrors] = useState<Record<string, string>>({});

  const [connectorSetup, setConnectorSetup] = useState<{
    provider: ConnectorProvider;
    serverId: string;
    serverName: string;
    env?: Record<string, string>;
  } | null>(null);

  const [envModal, setEnvModal] = useState<{
    serverId: string;
    serverName: string;
    env?: Record<string, string>;
    fields: ConnectorEnvField[];
  } | null>(null);

  const [activeFilter, setActiveFilter] = useState<"all" | "connected" | "available">("all");
  const [activeCategory, setActiveCategory] = useState<ConnectorCategory>("");
  const [searchQuery, setSearchQuery] = useState("");
  const [detailConnector, setDetailConnector] = useState<{
    connector: ConnectorDefinition;
    config: MCPServerConfig | undefined;
    status: MCPServerStatus | undefined;
  } | null>(null);
  const [integrationModal, setIntegrationModal] = useState<IntegrationDefinition | null>(null);
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customCommand, setCustomCommand] = useState("");
  const [customArgs, setCustomArgs] = useState("");
  const [customSaving, setCustomSaving] = useState(false);

  useEffect(() => {
    loadData();

    const unsubscribe = window.electronAPI.onMCPStatusChange((statuses) => {
      setServerStatuses(statuses);
    });

    return () => unsubscribe();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const [loadedSettings, statuses, registry] = await Promise.all([
        window.electronAPI.getMCPSettings(),
        window.electronAPI.getMCPStatus(),
        window.electronAPI.fetchMCPRegistry().catch(() => null),
      ]);
      setSettings(loadedSettings);
      setServerStatuses(statuses);
      if (registry?.servers) {
        setRegistryConnectorIds(new Set(registry.servers.map((server: Any) => String(server.id))));
      } else {
        setRegistryConnectorIds(null);
      }
    } catch (error) {
      console.error("Failed to load connector settings:", error);
    } finally {
      setLoading(false);
    }
  };

  const connectorRows = useMemo(() => {
    if (!settings) return [];
    return CONNECTORS.filter((connector) => SHIPPED_CONNECTOR_IDS.has(connector.registryId))
      .map((connector) => {
        const config = settings.servers.find((server) => matchConnector(server, connector));
        const status = config ? serverStatuses.find((s) => s.id === config.id) : undefined;
        return { connector, config, status };
      })
      .filter(({ connector, config }) => {
        // Always show already-installed connectors.
        if (config) return true;
        // If registry info is unavailable, keep previous behavior.
        if (!registryConnectorIds) return true;
        // Only advertise connectors currently available from the registry.
        return registryConnectorIds.has(connector.registryId);
      });
  }, [settings, serverStatuses, registryConnectorIds]);

  // Sync detail view when underlying data changes (e.g. after MCP update)
  useEffect(() => {
    if (!detailConnector || !connectorRows.length) return;
    const row = connectorRows.find((r) => r.connector.key === detailConnector.connector.key);
    if (row && (row.config !== detailConnector.config || row.status !== detailConnector.status)) {
      setDetailConnector({ connector: row.connector, config: row.config, status: row.status });
    }
  }, [connectorRows, detailConnector]);

  const handleInstall = async (connector: ConnectorDefinition) => {
    try {
      setInstallingId(connector.registryId);
      await window.electronAPI.installMCPServer(connector.registryId);
      await loadData();
    } catch (error: Any) {
      alert(`Failed to install ${connector.name}: ${error.message}`);
    } finally {
      setInstallingId(null);
    }
  };

  const handleConnectServer = async (serverId: string) => {
    try {
      setConnectingServer(serverId);
      setConnectionErrors((prev) => {
        const { [serverId]: _, ...rest } = prev;
        return rest;
      });
      await window.electronAPI.connectMCPServer(serverId);
    } catch (error: Any) {
      setConnectionErrors((prev) => ({
        ...prev,
        [serverId]: error.message || "Connection failed",
      }));
    } finally {
      setConnectingServer(null);
    }
  };

  const handleDisconnectServer = async (serverId: string) => {
    try {
      setConnectingServer(serverId);
      setConnectionErrors((prev) => {
        const { [serverId]: _, ...rest } = prev;
        return rest;
      });
      await window.electronAPI.disconnectMCPServer(serverId);
    } catch (error: Any) {
      setConnectionErrors((prev) => ({
        ...prev,
        [serverId]: error.message || "Disconnect failed",
      }));
    } finally {
      setConnectingServer(null);
    }
  };

  const handleSaveCustom = async () => {
    if (!customName.trim() || !customCommand.trim()) return;
    try {
      setCustomSaving(true);
      const args = customArgs
        .split(" ")
        .map((a) => a.trim())
        .filter(Boolean);
      await window.electronAPI.addMCPServer({
        name: customName.trim(),
        command: customCommand.trim(),
        args,
        env: {},
        enabled: true,
        transport: "stdio" as const,
      });
      await loadData();
      setShowCustomForm(false);
      setCustomName("");
      setCustomCommand("");
      setCustomArgs("");
    } catch (error: Any) {
      alert(`Failed to add connector: ${error.message}`);
    } finally {
      setCustomSaving(false);
    }
  };

  if (loading) {
    return <div className="settings-loading">Loading connector settings...</div>;
  }

  const connectedCount = connectorRows.filter((r) => r.status?.status === "connected").length;
  const availableCount = connectorRows.filter((r) => r.status?.status !== "connected").length;
  const normalizedSearchQuery = normalizeConnectorSearch(searchQuery);

  const filteredRows = connectorRows
    .filter(({ status }) => {
      if (activeFilter === "connected") return status?.status === "connected";
      if (activeFilter === "available") return status?.status !== "connected";
      return true;
    })
    .filter(
      ({ connector }) =>
        activeCategory === "" || getConnectorCategory(connector) === activeCategory,
    )
    .filter(({ connector }) => {
      if (!normalizedSearchQuery) return true;
      return [connector.name, connector.description, connector.key, connector.registryId].some(
        (value) => (value || "").toLowerCase().includes(normalizedSearchQuery),
      );
    });

  const filteredIntegrations = INTEGRATIONS.filter(
    (_integration) => activeCategory === "" || getIntegrationCategory() === activeCategory,
  ).filter((integration) => {
    if (!normalizedSearchQuery) return true;
    return [integration.name, integration.description, integration.key].some((value) =>
      value.toLowerCase().includes(normalizedSearchQuery),
    );
  });
  const showIntegrationResults = activeFilter !== "connected" && filteredIntegrations.length > 0;
  const showConnectorEmpty = filteredRows.length === 0 && !showIntegrationResults;
  const showMcpDivider = showIntegrationResults && filteredRows.length > 0;

  return (
    <div className="settings-section connector-marketplace">
      <div className="settings-section-header">
        <h3>Connectors</h3>
      </div>

      <div className="cm-toolbar">
        <div className="cm-filter-tabs" role="tablist">
          {(
            [
              { key: "all", label: "All", count: connectorRows.length },
              { key: "connected", label: "Connected", count: connectedCount },
              { key: "available", label: "Available", count: availableCount },
            ] as const
          ).map(({ key, label, count }) => (
            <button
              key={key}
              role="tab"
              aria-selected={activeFilter === key}
              className={`cm-filter-tab${activeFilter === key ? " cm-filter-tab--active" : ""}`}
              onClick={() => setActiveFilter(key)}
            >
              {label}
              <span className="cm-filter-count">{count}</span>
            </button>
          ))}
        </div>

        <div className="cm-toolbar-right">
          <div className="cm-search" role="search">
            <Search size={14} strokeWidth={2} aria-hidden="true" />
            <input
              type="search"
              aria-label="Search connectors"
              placeholder="Search connectors"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                className="cm-search-clear"
                aria-label="Clear connector search"
                onClick={() => setSearchQuery("")}
              >
                <X size={13} strokeWidth={2} aria-hidden="true" />
              </button>
            )}
          </div>
          <select
            className="cm-category-select"
            value={activeCategory}
            onChange={(e) => setActiveCategory(e.target.value as ConnectorCategory)}
          >
            <option value="">All categories</option>
            <option value="crm">CRM</option>
            <option value="productivity">Productivity</option>
            <option value="communication">Communication</option>
            <option value="finance">Finance</option>
            <option value="legal">Legal</option>
            <option value="devtools">Dev Tools</option>
          </select>
          <button className="button-primary button-small" onClick={() => setShowCustomForm(true)}>
            + Custom connector
          </button>
        </div>
      </div>

      {showIntegrationResults && (
        <>
          <div className="cm-section-divider">
            <span className="cm-section-label">Storage &amp; Productivity</span>
          </div>
          <div className="cm-grid">
            {filteredIntegrations.map((integration) => (
              <button
                key={integration.key}
                className="cm-card"
                onClick={() => setIntegrationModal(integration)}
              >
                <ConnectorBrandIcon
                  connectorKey={integration.key}
                  name={integration.name}
                  className="cm-card-icon"
                />
                <div className="cm-card-body">
                  <span className="cm-card-name">{integration.name}</span>
                  <span className="cm-card-desc">{integration.description}</span>
                </div>
              </button>
            ))}
          </div>
          {showMcpDivider && (
            <div className="cm-section-divider">
              <span className="cm-section-label">MCP connectors</span>
            </div>
          )}
        </>
      )}

      {(filteredRows.length > 0 || showConnectorEmpty) && (
        <div className="cm-grid">
          {filteredRows.map(({ connector, config, status }) => {
            const isConnected = status?.status === "connected";
            const serverStatus = status?.status || "disconnected";
            return (
              <button
                key={connector.key}
                className={`cm-card${isConnected ? " cm-card--connected" : ""}`}
                onClick={() => setDetailConnector({ connector, config, status })}
              >
                {isConnected && (
                  <span className="cm-card-connected-badge" aria-label="Connected">
                    ✓
                  </span>
                )}
                <ConnectorBrandIcon
                  connectorKey={connector.key}
                  name={connector.name}
                  className="cm-card-icon"
                />
                <div className="cm-card-body">
                  <span className="cm-card-name">{connector.name}</span>
                  <span className="cm-card-desc">{connector.description}</span>
                </div>
                {config && !isConnected && (
                  <span
                    className="cm-card-status-dot"
                    style={{ backgroundColor: getStatusColor(serverStatus) }}
                    title={getStatusText(serverStatus)}
                  />
                )}
              </button>
            );
          })}

          {showConnectorEmpty && (
            <div className="cm-empty">
              {normalizedSearchQuery
                ? "No connectors match this search."
                : "No connectors match this filter."}
            </div>
          )}
        </div>
      )}

      {integrationModal && (
        <div className="mcp-modal-overlay" onClick={() => setIntegrationModal(null)}>
          <div className="cm-integration-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cm-detail-header">
              <ConnectorBrandIcon
                connectorKey={integrationModal.key}
                name={integrationModal.name}
                className="cm-detail-icon"
              />
              <div className="cm-detail-title">
                <h2>{integrationModal.name}</h2>
                <p className="cm-detail-subtitle">{integrationModal.description}</p>
              </div>
              <button className="mcp-modal-close" onClick={() => setIntegrationModal(null)}>
                ×
              </button>
            </div>
            <div className="cm-integration-modal-body">{integrationModal.component}</div>
          </div>
        </div>
      )}

      {detailConnector && (
        <ConnectorProfileView
          connector={detailConnector.connector}
          config={detailConnector.config}
          status={detailConnector.status}
          installingId={installingId}
          connectingServer={connectingServer}
          connectionErrors={connectionErrors}
          onClose={() => setDetailConnector(null)}
          onInstall={handleInstall}
          onConnect={handleConnectServer}
          onDisconnect={handleDisconnectServer}
          onOpenSetup={(p, id, name, env) =>
            setConnectorSetup({ provider: p, serverId: id, serverName: name, env })
          }
          onOpenEnvModal={(id, name, env, fields) =>
            setEnvModal({ serverId: id, serverName: name, env, fields })
          }
          onUpdate={loadData}
        />
      )}

      {showCustomForm && (
        <div className="mcp-modal-overlay" onClick={() => setShowCustomForm(false)}>
          <div className="cm-custom-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cm-custom-modal-header">
              <h3>Custom connector</h3>
              <button className="mcp-modal-close" onClick={() => setShowCustomForm(false)}>
                ×
              </button>
            </div>
            <div className="cm-custom-modal-body">
              <div className="settings-field">
                <label className="settings-label">Name</label>
                <input
                  className="settings-input"
                  type="text"
                  placeholder="My Connector"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                />
              </div>
              <div className="settings-field">
                <label className="settings-label">Command</label>
                <input
                  className="settings-input"
                  type="text"
                  placeholder="npx"
                  value={customCommand}
                  onChange={(e) => setCustomCommand(e.target.value)}
                />
              </div>
              <div className="settings-field">
                <label className="settings-label">Arguments (space-separated)</label>
                <input
                  className="settings-input"
                  type="text"
                  placeholder="-y @my-org/my-mcp-server"
                  value={customArgs}
                  onChange={(e) => setCustomArgs(e.target.value)}
                />
              </div>
            </div>
            <div className="cm-custom-modal-footer">
              <button
                className="button-secondary button-small"
                onClick={() => setShowCustomForm(false)}
              >
                Cancel
              </button>
              <button
                className="button-primary button-small"
                onClick={handleSaveCustom}
                disabled={customSaving || !customName.trim() || !customCommand.trim()}
              >
                {customSaving ? "Adding..." : "Add connector"}
              </button>
            </div>
          </div>
        </div>
      )}

      {connectorSetup && (
        <ConnectorSetupModal
          provider={connectorSetup.provider}
          serverId={connectorSetup.serverId}
          serverName={connectorSetup.serverName}
          initialEnv={connectorSetup.env}
          onClose={() => setConnectorSetup(null)}
          onSaved={loadData}
        />
      )}

      {envModal && (
        <ConnectorEnvModal
          serverId={envModal.serverId}
          serverName={envModal.serverName}
          initialEnv={envModal.env}
          fields={envModal.fields}
          onClose={() => setEnvModal(null)}
          onSaved={loadData}
        />
      )}
    </div>
  );
}
