import type { MCPServerConfig } from "../types";
import type { ConnectorOAuthProvider } from "../oauth/connector-oauth";

export type IntegrationAuthMethod = "api_key" | "oauth";

export type ConnectorCapabilityId =
  | "salesforce"
  | "jira"
  | "hubspot"
  | "zendesk"
  | "servicenow"
  | "linear"
  | "asana"
  | "okta"
  | "resend"
  | "google-workspace"
  | "figma"
  | "vercel"
  | "monday"
  | "rhino"
  | "blender"
  | "comfyui";

export type Tier1IntegrationProvider =
  | "resend"
  | "google-workspace"
  | "jira"
  | "linear"
  | "hubspot"
  | "salesforce"
  | "zendesk"
  | "servicenow";

export interface IntegrationLinkSet {
  dashboard?: string;
  create_api_key?: string;
  api_keys_docs?: string;
  oauth_docs?: string;
  webhooks_docs?: string;
}

export interface IntegrationInputHint {
  field: string;
  label: string;
  prompt: string;
  create_url?: string;
  docs_url?: string;
  sensitive?: boolean;
}

export interface ConnectorCapability {
  id: ConnectorCapabilityId;
  name: string;
  registryEntryId: string;
  authMethods: IntegrationAuthMethod[];
  oauthProvider?: ConnectorOAuthProvider;
  readinessAny: string[][];
  readinessByAuth?: Partial<Record<IntegrationAuthMethod, string[][]>>;
  healthTool?: string;
  links: IntegrationLinkSet;
  inputHints?: Record<string, IntegrationInputHint>;
  supportsInbound?: boolean;
  tier1?: boolean;
}

const CONNECTOR_SCRIPT_PATH_REGEX =
  /(?:^|[\\/])connectors[\\/]([^\\/]+)-mcp[\\/]dist[\\/]index\.js$/i;

const CAPABILITIES: Record<ConnectorCapabilityId, ConnectorCapability> = {
  salesforce: {
    id: "salesforce",
    name: "Salesforce",
    registryEntryId: "salesforce",
    authMethods: ["api_key", "oauth"],
    oauthProvider: "salesforce",
    readinessAny: [
      ["SALESFORCE_INSTANCE_URL", "SALESFORCE_ACCESS_TOKEN"],
      [
        "SALESFORCE_INSTANCE_URL",
        "SALESFORCE_CLIENT_ID",
        "SALESFORCE_CLIENT_SECRET",
        "SALESFORCE_REFRESH_TOKEN",
      ],
    ],
    readinessByAuth: {
      api_key: [["SALESFORCE_INSTANCE_URL", "SALESFORCE_ACCESS_TOKEN"]],
      oauth: [["SALESFORCE_INSTANCE_URL", "SALESFORCE_ACCESS_TOKEN", "SALESFORCE_REFRESH_TOKEN"]],
    },
    healthTool: "salesforce.health",
    links: {
      dashboard: "https://login.salesforce.com",
      oauth_docs: "https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_web_server_flow.htm",
    },
    tier1: true,
  },
  jira: {
    id: "jira",
    name: "Jira",
    registryEntryId: "jira",
    authMethods: ["api_key", "oauth"],
    oauthProvider: "jira",
    readinessAny: [
      ["JIRA_BASE_URL", "JIRA_ACCESS_TOKEN"],
      ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"],
    ],
    readinessByAuth: {
      api_key: [["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"]],
      oauth: [["JIRA_BASE_URL", "JIRA_ACCESS_TOKEN"]],
    },
    healthTool: "jira.health",
    links: {
      dashboard: "https://admin.atlassian.com",
      create_api_key: "https://id.atlassian.com/manage-profile/security/api-tokens",
      api_keys_docs: "https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/",
      oauth_docs: "https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/",
    },
    inputHints: {
      JIRA_BASE_URL: {
        field: "JIRA_BASE_URL",
        label: "Jira base URL",
        prompt: "Provide your Jira site URL (for example https://your-company.atlassian.net).",
        docs_url: "https://support.atlassian.com/jira-software-cloud/docs/find-your-jira-site-url/",
      },
    },
    tier1: true,
  },
  hubspot: {
    id: "hubspot",
    name: "HubSpot",
    registryEntryId: "hubspot",
    authMethods: ["api_key", "oauth"],
    oauthProvider: "hubspot",
    readinessAny: [["HUBSPOT_ACCESS_TOKEN"]],
    readinessByAuth: {
      api_key: [["HUBSPOT_ACCESS_TOKEN"]],
      oauth: [["HUBSPOT_ACCESS_TOKEN", "HUBSPOT_REFRESH_TOKEN"]],
    },
    healthTool: "hubspot.health",
    links: {
      dashboard: "https://app.hubspot.com",
      create_api_key: "https://developers.hubspot.com/docs/guides/apps/private-apps/overview",
      api_keys_docs: "https://developers.hubspot.com/docs/guides/apps/private-apps/overview",
      oauth_docs: "https://developers.hubspot.com/docs/guides/apps/authentication/oauth-quickstart-guide",
    },
    tier1: true,
  },
  zendesk: {
    id: "zendesk",
    name: "Zendesk",
    registryEntryId: "zendesk",
    authMethods: ["api_key", "oauth"],
    oauthProvider: "zendesk",
    readinessAny: [
      ["ZENDESK_BASE_URL", "ZENDESK_ACCESS_TOKEN"],
      ["ZENDESK_SUBDOMAIN", "ZENDESK_ACCESS_TOKEN"],
      ["ZENDESK_BASE_URL", "ZENDESK_EMAIL", "ZENDESK_API_TOKEN"],
      ["ZENDESK_SUBDOMAIN", "ZENDESK_EMAIL", "ZENDESK_API_TOKEN"],
    ],
    healthTool: "zendesk.health",
    links: {
      dashboard: "https://admin.zendesk.com",
      api_keys_docs: "https://support.zendesk.com/hc/en-us/articles/4408831452954",
      oauth_docs: "https://developer.zendesk.com/documentation/integration-services/apps/oauth/",
    },
    tier1: true,
  },
  servicenow: {
    id: "servicenow",
    name: "ServiceNow",
    registryEntryId: "servicenow",
    authMethods: ["api_key"],
    readinessAny: [
      ["SERVICENOW_INSTANCE_URL", "SERVICENOW_ACCESS_TOKEN"],
      ["SERVICENOW_INSTANCE", "SERVICENOW_ACCESS_TOKEN"],
      ["SERVICENOW_INSTANCE_URL", "SERVICENOW_USERNAME", "SERVICENOW_PASSWORD"],
      ["SERVICENOW_INSTANCE", "SERVICENOW_USERNAME", "SERVICENOW_PASSWORD"],
    ],
    healthTool: "servicenow.health",
    links: {
      dashboard: "https://www.servicenow.com",
      api_keys_docs: "https://www.servicenow.com/docs/bundle/washingtondc-platform-security/page/integrate/authentication/task/t_CreateAnOAuthApiEndpointForExternalClients.html",
    },
    tier1: true,
  },
  linear: {
    id: "linear",
    name: "Linear",
    registryEntryId: "linear",
    authMethods: ["api_key"],
    readinessAny: [["LINEAR_API_KEY"]],
    readinessByAuth: {
      api_key: [["LINEAR_API_KEY"]],
    },
    healthTool: "linear.health",
    links: {
      dashboard: "https://linear.app/settings/api",
      create_api_key: "https://linear.app/settings/api",
      api_keys_docs: "https://developers.linear.app/docs/graphql/working-with-the-graphql-api",
    },
    tier1: true,
  },
  asana: {
    id: "asana",
    name: "Asana",
    registryEntryId: "asana",
    authMethods: ["api_key"],
    readinessAny: [["ASANA_ACCESS_TOKEN"]],
    healthTool: "asana.health",
    links: {
      dashboard: "https://app.asana.com/0/my-apps",
      api_keys_docs: "https://developers.asana.com/docs/personal-access-token",
    },
  },
  okta: {
    id: "okta",
    name: "Okta",
    registryEntryId: "okta",
    authMethods: ["api_key"],
    readinessAny: [["OKTA_BASE_URL", "OKTA_API_TOKEN"]],
    healthTool: "okta.health",
    links: {
      dashboard: "https://admin.okta.com",
      api_keys_docs: "https://developer.okta.com/docs/guides/create-an-api-token/main/",
    },
  },
  resend: {
    id: "resend",
    name: "Resend",
    registryEntryId: "resend",
    authMethods: ["api_key"],
    readinessAny: [["RESEND_API_KEY"]],
    readinessByAuth: {
      api_key: [["RESEND_API_KEY"]],
    },
    healthTool: "resend.health",
    links: {
      dashboard: "https://resend.com/dashboard",
      create_api_key: "https://resend.com/api-keys",
      api_keys_docs: "https://resend.com/docs/dashboard/api-keys/introduction",
      webhooks_docs: "https://resend.com/docs/dashboard/webhooks/introduction",
    },
    supportsInbound: true,
    tier1: true,
  },
  "google-workspace": {
    id: "google-workspace",
    name: "Google Workspace",
    registryEntryId: "google-workspace",
    authMethods: ["oauth"],
    oauthProvider: "google-workspace",
    // One token covers all Google Workspace services
    readinessAny: [["GOOGLE_ACCESS_TOKEN"]],
    readinessByAuth: {
      oauth: [["GOOGLE_ACCESS_TOKEN", "GOOGLE_REFRESH_TOKEN"]],
    },
    healthTool: "google-workspace.health",
    links: {
      dashboard: "https://console.cloud.google.com/apis/credentials",
      oauth_docs: "https://developers.google.com/workspace/guides/auth-overview",
    },
    tier1: true,
  },
  figma: {
    id: "figma",
    name: "Figma",
    registryEntryId: "figma",
    authMethods: ["api_key"],
    readinessAny: [["FIGMA_ACCESS_TOKEN"]],
    readinessByAuth: {
      api_key: [["FIGMA_ACCESS_TOKEN"]],
    },
    healthTool: "figma.health",
    links: {
      dashboard: "https://www.figma.com/developers/api",
      create_api_key: "https://www.figma.com/developers/api#access-tokens",
      api_keys_docs: "https://www.figma.com/developers/api#access-tokens",
    },
  },
  vercel: {
    id: "vercel",
    name: "Vercel",
    registryEntryId: "vercel",
    authMethods: ["api_key"],
    readinessAny: [["VERCEL_TOKEN"]],
    readinessByAuth: {
      api_key: [["VERCEL_TOKEN"]],
    },
    healthTool: "vercel.health",
    links: {
      dashboard: "https://vercel.com/account/tokens",
      create_api_key: "https://vercel.com/account/tokens",
      api_keys_docs: "https://vercel.com/docs/rest-api",
    },
  },
  monday: {
    id: "monday",
    name: "monday.com",
    registryEntryId: "monday",
    authMethods: ["api_key"],
    readinessAny: [["MONDAY_API_TOKEN"]],
    readinessByAuth: {
      api_key: [["MONDAY_API_TOKEN"]],
    },
    healthTool: "monday.health",
    links: {
      dashboard: "https://monday.com/developers/apps",
      create_api_key: "https://monday.com/developers/apps",
      api_keys_docs: "https://developer.monday.com/api-reference/docs/getting-started",
    },
  },
  rhino: {
    id: "rhino",
    name: "Rhino",
    registryEntryId: "rhino",
    authMethods: ["api_key"],
    readinessAny: [["COWORK_ARCH_PROJECT_ROOT"]],
    healthTool: "rhino.health",
    links: {
      dashboard: "https://www.rhino3d.com/",
      api_keys_docs: "https://developer.rhino3d.com/",
    },
    inputHints: {
      COWORK_ARCH_PROJECT_ROOT: {
        field: "COWORK_ARCH_PROJECT_ROOT",
        label: "Architecture project root",
        prompt: "Provide the workspace folder where Rhino project files may be read and written.",
        docs_url: "https://developer.rhino3d.com/",
      },
      RHINO_MCP_BRIDGE_URL: {
        field: "RHINO_MCP_BRIDGE_URL",
        label: "Rhino bridge URL",
        prompt: "Provide the localhost Rhino bridge URL.",
        docs_url: "https://developer.rhino3d.com/",
      },
    },
  },
  blender: {
    id: "blender",
    name: "Blender",
    registryEntryId: "blender",
    authMethods: ["api_key"],
    readinessAny: [["COWORK_ARCH_PROJECT_ROOT"]],
    healthTool: "blender.health",
    links: {
      dashboard: "https://www.blender.org/",
      api_keys_docs: "https://docs.blender.org/api/current/",
    },
    inputHints: {
      COWORK_ARCH_PROJECT_ROOT: {
        field: "COWORK_ARCH_PROJECT_ROOT",
        label: "Architecture project root",
        prompt: "Provide the workspace folder where Blender project files may be read and written.",
        docs_url: "https://docs.blender.org/api/current/",
      },
      BLENDER_MCP_BRIDGE_URL: {
        field: "BLENDER_MCP_BRIDGE_URL",
        label: "Blender bridge URL",
        prompt: "Provide the localhost Blender bridge URL.",
        docs_url: "https://docs.blender.org/api/current/",
      },
    },
  },
  comfyui: {
    id: "comfyui",
    name: "ComfyUI",
    registryEntryId: "comfyui",
    authMethods: ["api_key"],
    readinessAny: [["COWORK_ARCH_PROJECT_ROOT"]],
    healthTool: "comfyui.health",
    links: {
      dashboard: "https://github.com/comfyanonymous/ComfyUI",
      api_keys_docs: "https://github.com/comfyanonymous/ComfyUI",
    },
    inputHints: {
      COWORK_ARCH_PROJECT_ROOT: {
        field: "COWORK_ARCH_PROJECT_ROOT",
        label: "Architecture project root",
        prompt: "Provide the workspace folder where ComfyUI workflow files and outputs may be read and written.",
        docs_url: "https://github.com/comfyanonymous/ComfyUI",
      },
      COMFYUI_BASE_URL: {
        field: "COMFYUI_BASE_URL",
        label: "ComfyUI base URL",
        prompt: "Provide the localhost ComfyUI API URL.",
        docs_url: "https://github.com/comfyanonymous/ComfyUI",
      },
    },
  },
};

export const TIER1_CONNECTOR_IDS: Tier1IntegrationProvider[] = [
  "resend",
  "google-workspace",
  "jira",
  "linear",
  "hubspot",
  "salesforce",
  "zendesk",
  "servicenow",
];

export function getConnectorCapability(id: string): ConnectorCapability | undefined {
  const key = String(id || "").trim().toLowerCase() as ConnectorCapabilityId;
  return CAPABILITIES[key];
}

export function listConnectorCapabilities(): ConnectorCapability[] {
  return Object.values(CAPABILITIES);
}

export function listTier1ConnectorCapabilities(): ConnectorCapability[] {
  return TIER1_CONNECTOR_IDS.map((id) => CAPABILITIES[id]);
}

export function getKnownConnectorIds(): string[] {
  return Object.keys(CAPABILITIES);
}

export function detectConnectorCapabilityId(server: Pick<MCPServerConfig, "name" | "args">):
  | ConnectorCapabilityId
  | null {
  const args = server.args || [];
  for (const arg of args) {
    const match = String(arg).match(CONNECTOR_SCRIPT_PATH_REGEX);
    if (!match) continue;
    const connector = match[1].toLowerCase() as ConnectorCapabilityId;
    if (CAPABILITIES[connector]) return connector;
  }

  const lowerName = String(server.name || "").toLowerCase();
  for (const connector of Object.keys(CAPABILITIES) as ConnectorCapabilityId[]) {
    if (lowerName.includes(connector)) {
      return connector;
    }
  }

  return null;
}

function hasEnvValue(env: Record<string, string> | undefined, key: string): boolean {
  return Boolean(env?.[key]?.trim());
}

function evaluateRequirements(
  env: Record<string, string> | undefined,
  requirements: string[][],
): { configured: boolean; missing: string[]; missingFromBestGroup: string[] } {
  if (requirements.length === 0) {
    return { configured: true, missing: [], missingFromBestGroup: [] };
  }

  let bestMissing: string[] = requirements[0].filter((key) => !hasEnvValue(env, key));

  for (const group of requirements) {
    const missing = group.filter((key) => !hasEnvValue(env, key));
    if (missing.length === 0) {
      return { configured: true, missing: [], missingFromBestGroup: [] };
    }
    if (missing.length < bestMissing.length) {
      bestMissing = missing;
    }
  }

  return { configured: false, missing: bestMissing, missingFromBestGroup: bestMissing };
}

export function evaluateConnectorReadiness(params: {
  capability: ConnectorCapability;
  env?: Record<string, string>;
  authMethod?: IntegrationAuthMethod | "auto";
}): {
  configured: boolean;
  selectedAuthMethod: IntegrationAuthMethod;
  missingInputs: string[];
} {
  const { capability, env, authMethod = "auto" } = params;

  const resolveRequirements = (method: IntegrationAuthMethod): string[][] => {
    return capability.readinessByAuth?.[method] || capability.readinessAny;
  };

  if (authMethod !== "auto") {
    const check = evaluateRequirements(env, resolveRequirements(authMethod));
    return {
      configured: check.configured,
      selectedAuthMethod: authMethod,
      missingInputs: check.missing,
    };
  }

  // Auto mode picks the first satisfied method; otherwise method with fewest missing inputs.
  let bestMethod = capability.authMethods[0] || "api_key";
  let bestMissing = Number.POSITIVE_INFINITY;
  let bestMissingInputs: string[] = [];

  for (const method of capability.authMethods) {
    const check = evaluateRequirements(env, resolveRequirements(method));
    if (check.configured) {
      return {
        configured: true,
        selectedAuthMethod: method,
        missingInputs: [],
      };
    }

    if (check.missing.length < bestMissing) {
      bestMissing = check.missing.length;
      bestMethod = method;
      bestMissingInputs = check.missing;
    }
  }

  return {
    configured: false,
    selectedAuthMethod: bestMethod,
    missingInputs: bestMissingInputs,
  };
}

export function isConnectorConfiguredByCapability(
  connectorId: string,
  env: Record<string, string> | undefined,
): boolean {
  const capability = getConnectorCapability(connectorId);
  if (!capability) return true;
  return evaluateConnectorReadiness({ capability, env, authMethod: "auto" }).configured;
}
