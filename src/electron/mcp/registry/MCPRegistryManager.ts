/**
 * MCPRegistryManager - Manages discovery and installation of MCP servers from a registry
 *
 * Provides functionality to:
 * - Fetch the MCP server registry
 * - Search for servers by name, tags, or category
 * - Install servers from the registry
 * - Check for updates to installed servers
 */

import { v4 as uuidv4 } from "uuid";
import { execFile } from "child_process";
import * as path from "path";
import * as fs from "fs";
import {
  MCPRegistry,
  MCPRegistryEntry,
  MCPRegistrySearchOptions,
  MCPServerConfig,
  MCPUpdateInfo,
} from "../types";
import { MCPSettingsManager } from "../settings";

// Cache duration in milliseconds (15 minutes)
const REGISTRY_CACHE_DURATION = 15 * 60 * 1000;
const MAX_NPM_PACKAGE_NAME_LENGTH = 214;
const NPM_PACKAGE_PART_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

// Built-in registry of common MCP servers
// This is used as a fallback when the remote registry is unavailable.
// Keep this list curated toward non-overlapping MCP surfaces; native file,
// browser, memory, and direct GitHub paths are preferred elsewhere in the app.
const BASE_BUILTIN_SERVERS: MCPRegistryEntry[] = [
  {
    id: "postgres",
    name: "PostgreSQL",
    description: "PostgreSQL database read-only queries. Requires POSTGRES_CONNECTION_STRING.",
    version: "0.6.2",
    author: "Anthropic",
    homepage: "https://modelcontextprotocol.io",
    repository: "https://github.com/modelcontextprotocol/servers",
    license: "MIT",
    installMethod: "npm",
    installCommand: "npx",
    packageName: "@modelcontextprotocol/server-postgres",
    transport: "stdio",
    defaultCommand: "npx",
    defaultArgs: ["-y", "@modelcontextprotocol/server-postgres"],
    defaultEnv: {
      POSTGRES_CONNECTION_STRING: "",
    },
    tools: [{ name: "query", description: "Execute a read-only SQL query" }],
    tags: ["database", "postgres", "sql", "official"],
    category: "database",
    verified: true,
  },
  {
    id: "sequential-thinking",
    name: "Sequential Thinking",
    description: "MCP server for sequential thinking and problem solving",
    version: "2025.12.18",
    author: "Anthropic",
    homepage: "https://modelcontextprotocol.io",
    repository: "https://github.com/modelcontextprotocol/servers",
    license: "MIT",
    installMethod: "npm",
    installCommand: "npx",
    packageName: "@modelcontextprotocol/server-sequential-thinking",
    transport: "stdio",
    defaultCommand: "npx",
    defaultArgs: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    tools: [{ name: "sequentialthinking", description: "Sequential thinking and problem solving" }],
    tags: ["thinking", "reasoning", "official"],
    category: "reasoning",
    verified: true,
  },
  {
    id: "everything",
    name: "Everything (Demo)",
    description: "MCP server that exercises all features of the MCP protocol. Useful for testing.",
    version: "2026.1.26",
    author: "Anthropic",
    homepage: "https://modelcontextprotocol.io",
    repository: "https://github.com/modelcontextprotocol/servers",
    license: "MIT",
    installMethod: "npm",
    installCommand: "npx",
    packageName: "@modelcontextprotocol/server-everything",
    transport: "stdio",
    defaultCommand: "npx",
    defaultArgs: ["-y", "@modelcontextprotocol/server-everything"],
    tools: [
      { name: "echo", description: "Echo back the input" },
      { name: "add", description: "Add two numbers" },
      { name: "longRunningOperation", description: "Test long-running operations" },
      { name: "sampleLLM", description: "Sample from an LLM" },
      { name: "getTinyImage", description: "Get a tiny test image" },
    ],
    tags: ["demo", "testing", "official"],
    category: "testing",
    verified: true,
  },
];

const LOCAL_CONNECTOR_VERSION = "0.1.0";
const SHIPPED_LOCAL_CONNECTOR_IDS = new Set([
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
]);

function isPackagedElectronApp(): boolean {
  try {
    // Avoid hard import-time dependency on Electron binary in Node-only test environments.
    const electron = require("electron") as { app?: { isPackaged?: boolean } };
    return Boolean(electron.app?.isPackaged);
  } catch {
    return false;
  }
}

function getConnectorScriptPath(connectorName: string): string {
  const baseDir = isPackagedElectronApp()
    ? path.join(process.resourcesPath, "connectors")
    : path.join(process.cwd(), "connectors");
  return path.join(baseDir, connectorName, "dist", "index.js");
}

function getConnectorCommandArgs(connectorName: string): { command: string; args: string[] } {
  const scriptPath = getConnectorScriptPath(connectorName);
  return {
    // Use Electron's bundled Node runtime when possible
    command: process.execPath,
    args: ["--runAsNode", scriptPath],
  };
}

function getManualScriptPath(entry: MCPRegistryEntry): string | null {
  if (entry.installMethod !== "manual") return null;
  const args = entry.defaultArgs || [];
  const scriptPath = args.find((arg) => typeof arg === "string" && /\.(c|m)?js$/i.test(arg));
  return scriptPath || null;
}

function filterUnavailableConnectorEntries(entries: MCPRegistryEntry[]): MCPRegistryEntry[] {
  return entries.filter((entry) => {
    const scriptPath = getManualScriptPath(entry);
    if (!scriptPath) return true;
    if (fs.existsSync(scriptPath)) return true;
    console.warn(
      `[MCPRegistryManager] Skipping connector "${entry.id}" because script is missing: ${scriptPath}`,
    );
    return false;
  });
}

function getConnectorEntries(): MCPRegistryEntry[] {
  const salesforceCommand = getConnectorCommandArgs("salesforce-mcp");
  const jiraCommand = getConnectorCommandArgs("jira-mcp");
  const hubspotCommand = getConnectorCommandArgs("hubspot-mcp");
  const zendeskCommand = getConnectorCommandArgs("zendesk-mcp");
  const servicenowCommand = getConnectorCommandArgs("servicenow-mcp");
  const linearCommand = getConnectorCommandArgs("linear-mcp");
  const asanaCommand = getConnectorCommandArgs("asana-mcp");
  const oktaCommand = getConnectorCommandArgs("okta-mcp");
  const resendCommand = getConnectorCommandArgs("resend-mcp");
  // Google Workspace
  const googleCalendarCommand = getConnectorCommandArgs("google-calendar-mcp");
  const googleDriveCommand = getConnectorCommandArgs("google-drive-mcp");
  const gmailCommand = getConnectorCommandArgs("gmail-mcp");
  const googleWorkspaceCommand = getConnectorCommandArgs("google-workspace-mcp");
  // OAuth connectors
  const docusignCommand = getConnectorCommandArgs("docusign-mcp");
  const outreachCommand = getConnectorCommandArgs("outreach-mcp");
  const slackCommand = getConnectorCommandArgs("slack-mcp");
  const discordCommand = getConnectorCommandArgs("discord-mcp");
  const figmaCommand = getConnectorCommandArgs("figma-mcp");
  const vercelCommand = getConnectorCommandArgs("vercel-mcp");
  const mondayCommand = getConnectorCommandArgs("monday-mcp");
  // API-key connectors
  const apolloCommand = getConnectorCommandArgs("apollo-mcp");
  const clayCommand = getConnectorCommandArgs("clay-mcp");
  const similarwebCommand = getConnectorCommandArgs("similarweb-mcp");
  const msciCommand = getConnectorCommandArgs("msci-mcp");
  const legalzoomCommand = getConnectorCommandArgs("legalzoom-mcp");
  const factsetCommand = getConnectorCommandArgs("factset-mcp");
  const wordpressCommand = getConnectorCommandArgs("wordpress-mcp");
  const harveyCommand = getConnectorCommandArgs("harvey-mcp");
  const lsegCommand = getConnectorCommandArgs("lseg-mcp");
  const spglobalCommand = getConnectorCommandArgs("spglobal-mcp");
  const commonroomCommand = getConnectorCommandArgs("commonroom-mcp");
  const tribeaiCommand = getConnectorCommandArgs("tribeai-mcp");

  const entries: MCPRegistryEntry[] = [
    {
      id: "salesforce",
      name: "Salesforce",
      description:
        "Salesforce CRM connector for CoWork OS. Requires SALESFORCE_INSTANCE_URL and an access token.",
      version: LOCAL_CONNECTOR_VERSION,
      author: "CoWork OS",
      homepage: "https://github.com/CoWork-OS/CoWork-OS",
      repository: "https://github.com/CoWork-OS/CoWork-OS",
      license: "MIT",
      installMethod: "manual",
      transport: "stdio",
      defaultCommand: salesforceCommand.command,
      defaultArgs: salesforceCommand.args,
      defaultEnv: {
        SALESFORCE_INSTANCE_URL: "",
        SALESFORCE_ACCESS_TOKEN: "",
        SALESFORCE_CLIENT_ID: "",
        SALESFORCE_CLIENT_SECRET: "",
        SALESFORCE_REFRESH_TOKEN: "",
        SALESFORCE_LOGIN_URL: "https://login.salesforce.com",
        SALESFORCE_API_VERSION: "60.0",
      },
      tools: [
        { name: "salesforce.health", description: "Check connector health and auth status" },
        { name: "salesforce.list_objects", description: "List available Salesforce objects" },
        { name: "salesforce.describe_object", description: "Describe an object and its fields" },
        { name: "salesforce.get_record", description: "Fetch a record by id" },
        { name: "salesforce.search_records", description: "Run a SOQL query" },
        { name: "salesforce.create_record", description: "Create a record" },
        { name: "salesforce.update_record", description: "Update a record" },
      ],
      tags: ["salesforce", "crm", "enterprise", "connector"],
      category: "enterprise",
      verified: true,
      featured: true,
    },
    {
      id: "jira",
      name: "Jira",
      description:
        "Jira Cloud connector for CoWork OS. Requires JIRA_BASE_URL and auth (token or API token).",
      version: LOCAL_CONNECTOR_VERSION,
      author: "CoWork OS",
      homepage: "https://github.com/CoWork-OS/CoWork-OS",
      repository: "https://github.com/CoWork-OS/CoWork-OS",
      license: "MIT",
      installMethod: "manual",
      transport: "stdio",
      defaultCommand: jiraCommand.command,
      defaultArgs: jiraCommand.args,
      defaultEnv: {
        JIRA_BASE_URL: "",
        JIRA_ACCESS_TOKEN: "",
        JIRA_EMAIL: "",
        JIRA_API_TOKEN: "",
        JIRA_CLIENT_ID: "",
        JIRA_CLIENT_SECRET: "",
        JIRA_REFRESH_TOKEN: "",
        JIRA_API_VERSION: "3",
      },
      tools: [
        { name: "jira.health", description: "Check connector health and auth status" },
        { name: "jira.list_projects", description: "List Jira projects" },
        { name: "jira.get_issue", description: "Fetch an issue by id or key" },
        { name: "jira.search_issues", description: "Run a JQL query" },
        { name: "jira.create_issue", description: "Create an issue" },
        { name: "jira.update_issue", description: "Update an issue" },
      ],
      tags: ["jira", "issue-tracking", "enterprise", "connector"],
      category: "enterprise",
      verified: true,
      featured: true,
    },
    {
      id: "hubspot",
      name: "HubSpot",
      description: "HubSpot CRM connector for CoWork OS. Requires HUBSPOT_ACCESS_TOKEN.",
      version: LOCAL_CONNECTOR_VERSION,
      author: "CoWork OS",
      homepage: "https://github.com/CoWork-OS/CoWork-OS",
      repository: "https://github.com/CoWork-OS/CoWork-OS",
      license: "MIT",
      installMethod: "manual",
      transport: "stdio",
      defaultCommand: hubspotCommand.command,
      defaultArgs: hubspotCommand.args,
      defaultEnv: {
        HUBSPOT_ACCESS_TOKEN: "",
        HUBSPOT_CLIENT_ID: "",
        HUBSPOT_CLIENT_SECRET: "",
        HUBSPOT_REFRESH_TOKEN: "",
        HUBSPOT_BASE_URL: "https://api.hubapi.com",
      },
      tools: [
        { name: "hubspot.health", description: "Check connector health and auth status" },
        { name: "hubspot.search_objects", description: "Search CRM objects" },
        { name: "hubspot.get_object", description: "Fetch a CRM object by id" },
        { name: "hubspot.create_object", description: "Create a CRM object" },
        { name: "hubspot.update_object", description: "Update a CRM object" },
      ],
      tags: ["hubspot", "crm", "enterprise", "connector"],
      category: "enterprise",
      verified: true,
    },
    {
      id: "zendesk",
      name: "Zendesk",
      description: "Zendesk Support connector for CoWork OS. Requires ZENDESK credentials.",
      version: LOCAL_CONNECTOR_VERSION,
      author: "CoWork OS",
      homepage: "https://github.com/CoWork-OS/CoWork-OS",
      repository: "https://github.com/CoWork-OS/CoWork-OS",
      license: "MIT",
      installMethod: "manual",
      transport: "stdio",
      defaultCommand: zendeskCommand.command,
      defaultArgs: zendeskCommand.args,
      defaultEnv: {
        ZENDESK_SUBDOMAIN: "",
        ZENDESK_EMAIL: "",
        ZENDESK_API_TOKEN: "",
        ZENDESK_ACCESS_TOKEN: "",
        ZENDESK_CLIENT_ID: "",
        ZENDESK_CLIENT_SECRET: "",
        ZENDESK_REFRESH_TOKEN: "",
      },
      tools: [
        { name: "zendesk.health", description: "Check connector health and auth status" },
        { name: "zendesk.search_tickets", description: "Search Zendesk tickets" },
        { name: "zendesk.get_ticket", description: "Fetch a ticket by id" },
        { name: "zendesk.create_ticket", description: "Create a ticket" },
        { name: "zendesk.update_ticket", description: "Update a ticket" },
      ],
      tags: ["zendesk", "support", "enterprise", "connector"],
      category: "enterprise",
      verified: true,
    },
    {
      id: "servicenow",
      name: "ServiceNow",
      description: "ServiceNow connector for CoWork OS. Requires instance URL and credentials.",
      version: LOCAL_CONNECTOR_VERSION,
      author: "CoWork OS",
      homepage: "https://github.com/CoWork-OS/CoWork-OS",
      repository: "https://github.com/CoWork-OS/CoWork-OS",
      license: "MIT",
      installMethod: "manual",
      transport: "stdio",
      defaultCommand: servicenowCommand.command,
      defaultArgs: servicenowCommand.args,
      defaultEnv: {
        SERVICENOW_INSTANCE_URL: "",
        SERVICENOW_INSTANCE: "",
        SERVICENOW_USERNAME: "",
        SERVICENOW_PASSWORD: "",
        SERVICENOW_ACCESS_TOKEN: "",
      },
      tools: [
        { name: "servicenow.health", description: "Check connector health and auth status" },
        { name: "servicenow.list_records", description: "List records from a table" },
        { name: "servicenow.get_record", description: "Fetch a record by sys_id" },
        { name: "servicenow.create_record", description: "Create a record in a table" },
        { name: "servicenow.update_record", description: "Update a record in a table" },
      ],
      tags: ["servicenow", "itsm", "enterprise", "connector"],
      category: "enterprise",
      verified: true,
    },
    {
      id: "linear",
      name: "Linear",
      description: "Linear GraphQL connector for CoWork OS. Requires LINEAR_API_KEY.",
      version: LOCAL_CONNECTOR_VERSION,
      author: "CoWork OS",
      homepage: "https://github.com/CoWork-OS/CoWork-OS",
      repository: "https://github.com/CoWork-OS/CoWork-OS",
      license: "MIT",
      installMethod: "manual",
      transport: "stdio",
      defaultCommand: linearCommand.command,
      defaultArgs: linearCommand.args,
      defaultEnv: {
        LINEAR_API_KEY: "",
      },
      tools: [
        { name: "linear.health", description: "Check connector health and auth status" },
        { name: "linear.list_projects", description: "List Linear projects" },
        { name: "linear.search_issues", description: "Search issues by title" },
        { name: "linear.get_issue", description: "Fetch an issue by id" },
      ],
      tags: ["linear", "project", "enterprise", "connector"],
      category: "enterprise",
      verified: true,
    },
    {
      id: "asana",
      name: "Asana",
      description: "Asana connector for CoWork OS. Requires ASANA_ACCESS_TOKEN.",
      version: LOCAL_CONNECTOR_VERSION,
      author: "CoWork OS",
      homepage: "https://github.com/CoWork-OS/CoWork-OS",
      repository: "https://github.com/CoWork-OS/CoWork-OS",
      license: "MIT",
      installMethod: "manual",
      transport: "stdio",
      defaultCommand: asanaCommand.command,
      defaultArgs: asanaCommand.args,
      defaultEnv: {
        ASANA_ACCESS_TOKEN: "",
      },
      tools: [
        { name: "asana.health", description: "Check connector health and auth status" },
        { name: "asana.list_projects", description: "List projects in a workspace" },
        { name: "asana.get_task", description: "Fetch a task by id" },
        { name: "asana.search_tasks", description: "Search tasks in a workspace" },
        { name: "asana.create_task", description: "Create a task" },
        { name: "asana.update_task", description: "Update a task" },
      ],
      tags: ["asana", "project", "enterprise", "connector"],
      category: "enterprise",
      verified: true,
    },
    {
      id: "okta",
      name: "Okta",
      description: "Okta connector for CoWork OS. Requires OKTA_BASE_URL and OKTA_API_TOKEN.",
      version: LOCAL_CONNECTOR_VERSION,
      author: "CoWork OS",
      homepage: "https://github.com/CoWork-OS/CoWork-OS",
      repository: "https://github.com/CoWork-OS/CoWork-OS",
      license: "MIT",
      installMethod: "manual",
      transport: "stdio",
      defaultCommand: oktaCommand.command,
      defaultArgs: oktaCommand.args,
      defaultEnv: {
        OKTA_BASE_URL: "",
        OKTA_API_TOKEN: "",
      },
      tools: [
        { name: "okta.health", description: "Check connector health and auth status" },
        { name: "okta.list_users", description: "List users" },
        { name: "okta.get_user", description: "Fetch a user by id" },
        { name: "okta.create_user", description: "Create a user" },
        { name: "okta.update_user", description: "Update a user" },
      ],
      tags: ["okta", "identity", "enterprise", "connector"],
      category: "enterprise",
      verified: true,
    },
    {
      id: "resend",
      name: "Resend",
      description:
        "Resend email connector for CoWork OS. Supports sending emails and webhook management. Requires RESEND_API_KEY.",
      version: LOCAL_CONNECTOR_VERSION,
      author: "CoWork OS",
      homepage: "https://github.com/CoWork-OS/CoWork-OS",
      repository: "https://github.com/CoWork-OS/CoWork-OS",
      license: "MIT",
      installMethod: "manual",
      transport: "stdio",
      defaultCommand: resendCommand.command,
      defaultArgs: resendCommand.args,
      defaultEnv: {
        RESEND_API_KEY: "",
        RESEND_BASE_URL: "https://api.resend.com",
      },
      tools: [
        { name: "resend.health", description: "Check connector health and auth status" },
        { name: "resend.send_email", description: "Send an email via Resend API" },
        { name: "resend.list_webhooks", description: "List webhook endpoints" },
        { name: "resend.create_webhook", description: "Create a webhook endpoint" },
        { name: "resend.delete_webhook", description: "Delete a webhook endpoint" },
        { name: "resend.get_received_email", description: "Retrieve a received email by email_id" },
      ],
      tags: ["resend", "email", "automation", "connector"],
      category: "communication",
      verified: true,
      featured: true,
    },
    // --- Google Workspace connectors ---
    {
      id: "google-calendar",
      name: "Google Calendar",
      description:
        "Google Calendar connector for CoWork OS. Manage events, scheduling, and availability. Requires Google OAuth credentials.",
      version: LOCAL_CONNECTOR_VERSION,
      author: "CoWork OS",
      homepage: "https://github.com/CoWork-OS/CoWork-OS",
      repository: "https://github.com/CoWork-OS/CoWork-OS",
      license: "MIT",
      installMethod: "manual",
      transport: "stdio",
      defaultCommand: googleCalendarCommand.command,
      defaultArgs: googleCalendarCommand.args,
      defaultEnv: {
        GOOGLE_CLIENT_ID: "",
        GOOGLE_CLIENT_SECRET: "",
        GOOGLE_ACCESS_TOKEN: "",
        GOOGLE_REFRESH_TOKEN: "",
      },
      tools: [
        { name: "google-calendar.health", description: "Check connector health and auth status" },
        { name: "google-calendar.list_calendars", description: "List available calendars" },
        { name: "google-calendar.list_events", description: "List calendar events" },
        { name: "google-calendar.get_event", description: "Get a calendar event by ID" },
        { name: "google-calendar.create_event", description: "Create a calendar event" },
        { name: "google-calendar.update_event", description: "Update a calendar event" },
        { name: "google-calendar.delete_event", description: "Delete a calendar event" },
        { name: "google-calendar.check_availability", description: "Check free/busy availability" },
      ],
      tags: ["google", "calendar", "scheduling", "enterprise", "connector"],
      category: "enterprise",
      verified: true,
      featured: true,
    },
    {
      id: "google-drive",
      name: "Google Drive",
      description:
        "Google Drive connector for CoWork OS. File storage, search, and document management. Requires Google OAuth credentials.",
      version: LOCAL_CONNECTOR_VERSION,
      author: "CoWork OS",
      homepage: "https://github.com/CoWork-OS/CoWork-OS",
      repository: "https://github.com/CoWork-OS/CoWork-OS",
      license: "MIT",
      installMethod: "manual",
      transport: "stdio",
      defaultCommand: googleDriveCommand.command,
      defaultArgs: googleDriveCommand.args,
      defaultEnv: {
        GOOGLE_CLIENT_ID: "",
        GOOGLE_CLIENT_SECRET: "",
        GOOGLE_ACCESS_TOKEN: "",
        GOOGLE_REFRESH_TOKEN: "",
      },
      tools: [
        { name: "google-drive.health", description: "Check connector health and auth status" },
        { name: "google-drive.list_files", description: "List files and folders" },
        { name: "google-drive.search_files", description: "Search files by name or content" },
        { name: "google-drive.get_file", description: "Get file metadata and content" },
        { name: "google-drive.upload_file", description: "Upload a file to Drive" },
        { name: "google-drive.create_folder", description: "Create a new folder" },
        { name: "google-drive.share_file", description: "Share a file with users" },
      ],
      tags: ["google", "drive", "storage", "enterprise", "connector"],
      category: "enterprise",
      verified: true,
      featured: true,
    },
    {
      id: "gmail",
      name: "Gmail",
      description:
        "Gmail connector for CoWork OS. Read, send, and manage email. Requires Google OAuth credentials.",
      version: LOCAL_CONNECTOR_VERSION,
      author: "CoWork OS",
      homepage: "https://github.com/CoWork-OS/CoWork-OS",
      repository: "https://github.com/CoWork-OS/CoWork-OS",
      license: "MIT",
      installMethod: "manual",
      transport: "stdio",
      defaultCommand: gmailCommand.command,
      defaultArgs: gmailCommand.args,
      defaultEnv: {
        GOOGLE_CLIENT_ID: "",
        GOOGLE_CLIENT_SECRET: "",
        GOOGLE_ACCESS_TOKEN: "",
        GOOGLE_REFRESH_TOKEN: "",
      },
      tools: [
        { name: "gmail.health", description: "Check connector health and auth status" },
        { name: "gmail.list_messages", description: "List email messages" },
        { name: "gmail.get_message", description: "Get an email message by ID" },
        { name: "gmail.send_message", description: "Send an email" },
        { name: "gmail.search_messages", description: "Search emails with Gmail query syntax" },
        { name: "gmail.list_labels", description: "List email labels" },
        { name: "gmail.modify_labels", description: "Add or remove labels from a message" },
      ],
      tags: ["google", "gmail", "email", "enterprise", "connector"],
      category: "communication",
      verified: true,
      featured: true,
    },
    {
      id: "google-workspace",
      name: "Google Workspace",
      description:
        "Unified Google Workspace connector for CoWork OS. Access Sheets, Docs, Chat, Drive, Gmail, and Calendar through one OAuth connection. Requires Google OAuth credentials with full Workspace scopes.",
      version: LOCAL_CONNECTOR_VERSION,
      author: "CoWork OS",
      homepage: "https://github.com/CoWork-OS/CoWork-OS",
      repository: "https://github.com/CoWork-OS/CoWork-OS",
      license: "MIT",
      installMethod: "manual",
      transport: "stdio",
      defaultCommand: googleWorkspaceCommand.command,
      defaultArgs: googleWorkspaceCommand.args,
      defaultEnv: {
        GOOGLE_CLIENT_ID: "",
        GOOGLE_CLIENT_SECRET: "",
        GOOGLE_ACCESS_TOKEN: "",
        GOOGLE_REFRESH_TOKEN: "",
      },
      tools: [
        { name: "google-workspace.health", description: "Check connector health and auth status" },
        { name: "google-workspace.sheets_create", description: "Create a new Google Spreadsheet" },
        { name: "google-workspace.sheets_get", description: "Get spreadsheet metadata and sheet list" },
        { name: "google-workspace.sheets_values_get", description: "Read cell values from a range" },
        { name: "google-workspace.sheets_values_update", description: "Write values to a range" },
        { name: "google-workspace.sheets_values_append", description: "Append rows to a spreadsheet" },
        { name: "google-workspace.docs_create", description: "Create a new Google Document" },
        { name: "google-workspace.docs_get", description: "Get document content and structure" },
        { name: "google-workspace.docs_append_text", description: "Append text to a document" },
        { name: "google-workspace.chat_spaces_list", description: "List Google Chat spaces" },
        { name: "google-workspace.chat_messages_list", description: "List messages in a Chat space" },
        { name: "google-workspace.chat_messages_create", description: "Send a message to a Chat space" },
        { name: "google-workspace.drive_files_list", description: "List or search Drive files" },
        { name: "google-workspace.drive_files_get", description: "Get Drive file metadata" },
      ],
      tags: ["google", "workspace", "sheets", "docs", "chat", "drive", "enterprise", "connector"],
      category: "enterprise",
      verified: true,
      featured: true,
    },
    // --- OAuth connectors ---
    {
      id: "docusign",
      name: "DocuSign",
      description:
        "DocuSign connector for CoWork OS. Manage envelopes and e-signatures. Requires DocuSign OAuth credentials.",
      version: LOCAL_CONNECTOR_VERSION,
      author: "CoWork OS",
      homepage: "https://github.com/CoWork-OS/CoWork-OS",
      repository: "https://github.com/CoWork-OS/CoWork-OS",
      license: "MIT",
      installMethod: "manual",
      transport: "stdio",
      defaultCommand: docusignCommand.command,
      defaultArgs: docusignCommand.args,
      defaultEnv: {
        DOCUSIGN_CLIENT_ID: "",
        DOCUSIGN_CLIENT_SECRET: "",
        DOCUSIGN_ACCESS_TOKEN: "",
        DOCUSIGN_REFRESH_TOKEN: "",
        DOCUSIGN_ACCOUNT_ID: "",
        DOCUSIGN_BASE_URL: "https://demo.docusign.net/restapi",
      },
      tools: [
        { name: "docusign.health", description: "Check connector health and auth status" },
        { name: "docusign.list_envelopes", description: "List envelopes" },
        { name: "docusign.get_envelope", description: "Get envelope details by ID" },
        { name: "docusign.create_envelope", description: "Create and send an envelope" },
        { name: "docusign.get_document", description: "Download a document from an envelope" },
        { name: "docusign.list_templates", description: "List available signing templates" },
      ],
      tags: ["docusign", "esign", "legal", "enterprise", "connector"],
      category: "enterprise",
      verified: true,
    },
    {
      id: "outreach",
      name: "Outreach",
      description:
        "Outreach connector for CoWork OS. Sales engagement sequences and analytics. Requires Outreach OAuth credentials.",
      version: LOCAL_CONNECTOR_VERSION,
      author: "CoWork OS",
      homepage: "https://github.com/CoWork-OS/CoWork-OS",
      repository: "https://github.com/CoWork-OS/CoWork-OS",
      license: "MIT",
      installMethod: "manual",
      transport: "stdio",
      defaultCommand: outreachCommand.command,
      defaultArgs: outreachCommand.args,
      defaultEnv: {
        OUTREACH_CLIENT_ID: "",
        OUTREACH_CLIENT_SECRET: "",
        OUTREACH_ACCESS_TOKEN: "",
        OUTREACH_REFRESH_TOKEN: "",
      },
      tools: [
        { name: "outreach.health", description: "Check connector health and auth status" },
        { name: "outreach.list_prospects", description: "List prospects" },
        { name: "outreach.get_prospect", description: "Get prospect details" },
        { name: "outreach.create_prospect", description: "Create a prospect" },
        { name: "outreach.list_sequences", description: "List engagement sequences" },
        { name: "outreach.add_to_sequence", description: "Add a prospect to a sequence" },
        { name: "outreach.list_tasks", description: "List tasks" },
      ],
      tags: ["outreach", "sales-engagement", "enterprise", "connector"],
      category: "enterprise",
      verified: true,
    },
    {
      id: "slack",
      name: "Slack",
      description:
        "Slack connector for CoWork OS. Team messaging, channels, and notifications. Requires Slack OAuth credentials.",
      version: LOCAL_CONNECTOR_VERSION,
      author: "CoWork OS",
      homepage: "https://github.com/CoWork-OS/CoWork-OS",
      repository: "https://github.com/CoWork-OS/CoWork-OS",
      license: "MIT",
      installMethod: "manual",
      transport: "stdio",
      defaultCommand: slackCommand.command,
      defaultArgs: slackCommand.args,
      defaultEnv: {
        SLACK_BOT_TOKEN: "",
        SLACK_CLIENT_ID: "",
        SLACK_CLIENT_SECRET: "",
        SLACK_ACCESS_TOKEN: "",
        SLACK_REFRESH_TOKEN: "",
      },
      tools: [
        { name: "slack.health", description: "Check connector health and auth status" },
        { name: "slack.list_channels", description: "List Slack channels" },
        { name: "slack.get_channel_history", description: "Get channel message history" },
        { name: "slack.post_message", description: "Post a message to a channel" },
        { name: "slack.search_messages", description: "Search messages across channels" },
        { name: "slack.list_users", description: "List workspace users" },
        { name: "slack.get_user", description: "Get user profile info" },
      ],
      tags: ["slack", "messaging", "enterprise", "connector"],
      category: "communication",
      verified: true,
      featured: true,
    },
    {
      id: "discord",
      name: "Discord",
      description:
        "Discord bot connector for CoWork OS. Guild management, channels, roles, messages, threads, webhooks, and reactions. Requires DISCORD_BOT_TOKEN.",
      version: LOCAL_CONNECTOR_VERSION,
      author: "CoWork OS",
      homepage: "https://github.com/CoWork-OS/CoWork-OS",
      repository: "https://github.com/CoWork-OS/CoWork-OS",
      license: "MIT",
      installMethod: "manual",
      transport: "stdio",
      defaultCommand: discordCommand.command,
      defaultArgs: discordCommand.args,
      defaultEnv: {
        DISCORD_BOT_TOKEN: "",
        DISCORD_APPLICATION_ID: "",
        DISCORD_GUILD_ID: "",
      },
      tools: [
        { name: "discord.health", description: "Check connector health and auth status" },
        { name: "discord.list_guilds", description: "List bot's guilds" },
        { name: "discord.get_guild", description: "Get guild details" },
        { name: "discord.list_channels", description: "List channels in a guild" },
        { name: "discord.create_channel", description: "Create a channel" },
        { name: "discord.edit_channel", description: "Edit a channel" },
        { name: "discord.delete_channel", description: "Delete a channel" },
        { name: "discord.send_message", description: "Send a message to a channel" },
        { name: "discord.get_messages", description: "Get recent messages from a channel" },
        { name: "discord.create_thread", description: "Create a thread" },
        { name: "discord.list_roles", description: "List roles in a guild" },
        { name: "discord.create_role", description: "Create a role" },
        { name: "discord.add_reaction", description: "Add a reaction to a message" },
        { name: "discord.create_webhook", description: "Create a webhook" },
        { name: "discord.list_webhooks", description: "List webhooks for a channel" },
        { name: "discord.list_members", description: "List guild members" },
        { name: "discord.get_channel", description: "Get channel details" },
        { name: "discord.edit_role", description: "Edit an existing role" },
        { name: "discord.delete_role", description: "Delete a role" },
      ],
      tags: ["discord", "messaging", "community", "connector"],
      category: "communication",
      verified: true,
      featured: true,
    },
    {
      id: "figma",
      name: "Figma",
      description:
        "Figma connector for CoWork OS. Extract design context, components, and styles from Figma files. Requires FIGMA_ACCESS_TOKEN.",
      version: LOCAL_CONNECTOR_VERSION,
      author: "CoWork OS",
      homepage: "https://github.com/CoWork-OS/CoWork-OS",
      repository: "https://github.com/CoWork-OS/CoWork-OS",
      license: "MIT",
      installMethod: "manual",
      transport: "stdio",
      defaultCommand: figmaCommand.command,
      defaultArgs: figmaCommand.args,
      defaultEnv: {
        FIGMA_ACCESS_TOKEN: "",
      },
      tools: [
        { name: "figma.health", description: "Check connector health and auth status" },
        { name: "figma.get_file", description: "Get a Figma file by key" },
        { name: "figma.get_file_nodes", description: "Get specific nodes from a Figma file" },
        { name: "figma.get_file_components", description: "Get components from a Figma file" },
        { name: "figma.get_file_styles", description: "Get styles from a Figma file" },
      ],
      tags: ["figma", "design", "connector"],
      category: "devtools",
      verified: true,
      featured: true,
    },
    {
      id: "vercel",
      name: "Vercel",
      description:
        "Vercel connector for CoWork OS. Analyze, debug, and manage projects and deployments. Requires VERCEL_TOKEN.",
      version: LOCAL_CONNECTOR_VERSION,
      author: "CoWork OS",
      homepage: "https://github.com/CoWork-OS/CoWork-OS",
      repository: "https://github.com/CoWork-OS/CoWork-OS",
      license: "MIT",
      installMethod: "manual",
      transport: "stdio",
      defaultCommand: vercelCommand.command,
      defaultArgs: vercelCommand.args,
      defaultEnv: {
        VERCEL_TOKEN: "",
      },
      tools: [
        { name: "vercel.health", description: "Check connector health and auth status" },
        { name: "vercel.list_projects", description: "List Vercel projects" },
        { name: "vercel.get_project", description: "Get a project by ID" },
        { name: "vercel.list_deployments", description: "List deployments" },
        { name: "vercel.get_deployment", description: "Get a deployment by ID" },
      ],
      tags: ["vercel", "deployments", "devtools", "connector"],
      category: "devtools",
      verified: true,
      featured: true,
    },
    {
      id: "monday",
      name: "monday.com",
      description:
        "monday.com connector for CoWork OS. Manage projects, boards, and workflows. Requires MONDAY_API_TOKEN.",
      version: LOCAL_CONNECTOR_VERSION,
      author: "CoWork OS",
      homepage: "https://github.com/CoWork-OS/CoWork-OS",
      repository: "https://github.com/CoWork-OS/CoWork-OS",
      license: "MIT",
      installMethod: "manual",
      transport: "stdio",
      defaultCommand: mondayCommand.command,
      defaultArgs: mondayCommand.args,
      defaultEnv: {
        MONDAY_API_TOKEN: "",
      },
      tools: [
        { name: "monday.health", description: "Check connector health and auth status" },
        { name: "monday.list_boards", description: "List monday.com boards" },
        { name: "monday.get_board", description: "Get a board by ID" },
      ],
      tags: ["monday", "project-management", "connector"],
      category: "devtools",
      verified: true,
    },
    // --- npm-based connectors ---
    {
      id: "miro",
      name: "Miro",
      description: "Access and create new content on Miro boards. Requires MIRO_OAUTH_TOKEN.",
      version: "0.1.3",
      author: "Miro",
      homepage: "https://developers.miro.com/docs/miro-mcp",
      repository: "https://github.com/miroapp/miro-mcp",
      license: "MIT",
      installMethod: "npm",
      installCommand: "npx",
      packageName: "@aditya.mishra/miro-mcp",
      transport: "stdio",
      defaultCommand: "npx",
      defaultArgs: ["-y", "@aditya.mishra/miro-mcp"],
      defaultEnv: {
        MIRO_OAUTH_TOKEN: "",
      },
      tools: [
        { name: "list_boards", description: "List Miro boards" },
        { name: "get_board", description: "Get board content" },
        { name: "create_board", description: "Create a new board" },
      ],
      tags: ["miro", "whiteboard", "collaboration", "diagrams"],
      category: "productivity",
      verified: true,
    },
    {
      id: "supabase",
      name: "Supabase",
      description: "Manage databases, authentication, and storage. Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
      version: "0.7.0",
      author: "Supabase",
      homepage: "https://supabase.com",
      repository: "https://github.com/supabase/mcp-server-supabase",
      license: "MIT",
      installMethod: "npm",
      installCommand: "npx",
      packageName: "@supabase/mcp-server-supabase",
      transport: "stdio",
      defaultCommand: "npx",
      defaultArgs: ["-y", "@supabase/mcp-server-supabase"],
      defaultEnv: {
        SUPABASE_URL: "",
        SUPABASE_SERVICE_ROLE_KEY: "",
      },
      tools: [
        { name: "query", description: "Execute SQL queries" },
        { name: "list_tables", description: "List database tables" },
        { name: "manage_auth", description: "Manage authentication" },
      ],
      tags: ["supabase", "database", "auth", "storage"],
      category: "devtools",
      verified: true,
    },
    {
      id: "excalidraw",
      name: "Excalidraw",
      description: "MCP for creating interactive hand-drawn diagrams in Excalidraw.",
      version: "1.0.0",
      author: "Excalidraw",
      homepage: "https://excalidraw.com",
      repository: "https://github.com/excalidraw/excalidraw",
      license: "MIT",
      installMethod: "npm",
      installCommand: "npx",
      packageName: "excalidraw-mcp",
      transport: "stdio",
      defaultCommand: "npx",
      defaultArgs: ["-y", "excalidraw-mcp"],
      defaultEnv: {},
      tools: [
        { name: "create_element", description: "Create diagram elements" },
        { name: "update_element", description: "Update elements" },
        { name: "get_scene", description: "Get scene info" },
      ],
      tags: ["excalidraw", "diagrams", "interactive"],
      category: "devtools",
      verified: true,
    },
    {
      id: "stripe",
      name: "Stripe",
      description: "Payment processing and financial infrastructure tools. Requires STRIPE_SECRET_KEY.",
      version: "0.3.1",
      author: "Stripe",
      homepage: "https://stripe.com",
      repository: "https://github.com/stripe/mcp",
      license: "MIT",
      installMethod: "npm",
      installCommand: "npx",
      packageName: "@stripe/mcp",
      transport: "stdio",
      defaultCommand: "npx",
      defaultArgs: ["-y", "@stripe/mcp"],
      defaultEnv: {
        STRIPE_SECRET_KEY: "",
      },
      tools: [
        { name: "list_customers", description: "List Stripe customers" },
        { name: "create_payment", description: "Create payment" },
        { name: "list_products", description: "List products" },
      ],
      tags: ["stripe", "payments", "finance"],
      category: "crm",
      verified: true,
    },
    {
      id: "huggingface",
      name: "Hugging Face",
      description: "Access the Hugging Face Hub and thousands of Gradio Apps. Requires HUGGINGFACE_API_KEY.",
      version: "0.3.5",
      author: "Hugging Face",
      homepage: "https://huggingface.co",
      repository: "https://github.com/huggingface/hf-mcp-server",
      license: "Apache-2.0",
      installMethod: "npm",
      installCommand: "npx",
      packageName: "@llmindset/hf-mcp-server",
      transport: "stdio",
      defaultCommand: "npx",
      defaultArgs: ["-y", "@llmindset/hf-mcp-server"],
      defaultEnv: {
        HUGGINGFACE_API_KEY: "",
      },
      tools: [
        { name: "list_models", description: "List models on Hub" },
        { name: "run_inference", description: "Run model inference" },
        { name: "list_gradio_apps", description: "List Gradio apps" },
      ],
      tags: ["huggingface", "ml", "models", "gradio"],
      category: "productivity",
      verified: true,
    },
    {
      id: "ahrefs",
      name: "Ahrefs",
      description: "SEO & AI search analytics. Requires API_KEY.",
      version: "0.0.11",
      author: "Ahrefs",
      homepage: "https://ahrefs.com",
      repository: "https://github.com/ahrefs/ahrefs-mcp-server",
      license: "MIT",
      installMethod: "npm",
      installCommand: "npx",
      packageName: "@ahrefs/mcp",
      transport: "stdio",
      defaultCommand: "npx",
      defaultArgs: ["-y", "@ahrefs/mcp"],
      defaultEnv: {
        API_KEY: "",
      },
      tools: [
        { name: "ahrefs_search", description: "Search SEO data" },
        { name: "ahrefs_metrics", description: "Get site metrics" },
      ],
      tags: ["ahrefs", "seo", "analytics"],
      category: "devtools",
      verified: true,
    },
    {
      id: "mermaid-chart",
      name: "Mermaid Chart",
      description: "Validates Mermaid syntax, renders diagrams as high-quality SVG.",
      version: "0.1.3",
      author: "iFlow",
      homepage: "https://mermaid.chart",
      repository: "https://github.com/iflow-mcp/mcp-mermaid",
      license: "MIT",
      installMethod: "npm",
      installCommand: "npx",
      packageName: "@iflow-mcp/mcp-mermaid",
      transport: "stdio",
      defaultCommand: "npx",
      defaultArgs: ["-y", "@iflow-mcp/mcp-mermaid"],
      defaultEnv: {},
      tools: [
        { name: "validate_mermaid", description: "Validate Mermaid syntax" },
        { name: "render_diagram", description: "Render diagram as SVG" },
      ],
      tags: ["mermaid", "diagrams", "svg"],
      category: "productivity",
      verified: true,
    },
    {
      id: "cloudflare",
      name: "Cloudflare Developer Platform",
      description: "Build applications with compute, storage, and AI. Requires wrangler login.",
      version: "0.2.0",
      author: "Cloudflare",
      homepage: "https://cloudflare.com",
      repository: "https://github.com/cloudflare/mcp-server-cloudflare",
      license: "Apache-2.0",
      installMethod: "npm",
      installCommand: "npx",
      packageName: "@cloudflare/mcp-server-cloudflare",
      transport: "stdio",
      defaultCommand: "npx",
      defaultArgs: ["-y", "@cloudflare/mcp-server-cloudflare"],
      defaultEnv: {},
      tools: [
        { name: "worker_list", description: "List Workers" },
        { name: "kv_get", description: "Get KV value" },
        { name: "d1_query", description: "Query D1 database" },
        { name: "r2_list_buckets", description: "List R2 buckets" },
      ],
      tags: ["cloudflare", "workers", "kv", "r2", "d1"],
      category: "devtools",
      verified: true,
    },
    {
      id: "make",
      name: "Make",
      description: "Run Make scenarios and manage your Make account. Optional MAKE_API_KEY for deployment.",
      version: "1.4.0",
      author: "Daniel Shashko",
      homepage: "https://make.com",
      repository: "https://github.com/danishashko/make-mcp",
      license: "MIT",
      installMethod: "npm",
      installCommand: "npx",
      packageName: "make-mcp-server",
      transport: "stdio",
      defaultCommand: "npx",
      defaultArgs: ["-y", "make-mcp-server"],
      defaultEnv: {
        MAKE_API_KEY: "",
        MAKE_TEAM_ID: "",
      },
      tools: [
        { name: "search_modules", description: "Search Make.com modules" },
        { name: "validate_scenario", description: "Validate scenario blueprint" },
        { name: "create_scenario", description: "Deploy scenario to Make.com" },
      ],
      tags: ["make", "automation", "integromat"],
      category: "productivity",
      verified: true,
    },
    {
      id: "clinical-trials",
      name: "Clinical Trials",
      description: "Access ClinicalTrials.gov data. Search trials, compare studies, match patients.",
      version: "1.9.2",
      author: "Cyanheads",
      homepage: "https://clinicaltrials.gov",
      repository: "https://github.com/cyanheads/clinicaltrialsgov-mcp-server",
      license: "Apache-2.0",
      installMethod: "npm",
      installCommand: "npx",
      packageName: "clinicaltrialsgov-mcp-server",
      transport: "stdio",
      defaultCommand: "npx",
      defaultArgs: ["-y", "clinicaltrialsgov-mcp-server"],
      defaultEnv: {},
      tools: [
        { name: "clinicaltrials_search_studies", description: "Search clinical studies" },
        { name: "clinicaltrials_get_study", description: "Get study details" },
        { name: "clinicaltrials_find_eligible_studies", description: "Match patients to trials" },
      ],
      tags: ["clinical-trials", "health", "research"],
      category: "legal",
      verified: true,
    },
    {
      id: "smartsheet",
      name: "Smartsheet",
      description: "Analyze and manage Smartsheet data with Claude. Requires SMARTSHEET_API_KEY.",
      version: "1.6.0",
      author: "Smartsheet",
      homepage: "https://smartsheet.com",
      repository: "https://github.com/smartsheet-platform/smar-mcp",
      license: "MIT",
      installMethod: "npm",
      installCommand: "npx",
      packageName: "@smartsheet/smar-mcp",
      transport: "stdio",
      defaultCommand: "npx",
      defaultArgs: ["-y", "@smartsheet/smar-mcp"],
      defaultEnv: {
        SMARTSHEET_API_KEY: "",
      },
      tools: [
        { name: "get_sheet", description: "Get sheet details" },
        { name: "create_sheet", description: "Create a sheet" },
        { name: "update_row", description: "Update rows" },
      ],
      tags: ["smartsheet", "spreadsheet", "productivity"],
      category: "productivity",
      verified: true,
    },
    {
      id: "netlify",
      name: "Netlify",
      description:
        "Create, deploy, manage, and secure websites on Netlify. Optional NETLIFY_PERSONAL_ACCESS_TOKEN for auth.",
      version: "1.15.1",
      author: "Netlify",
      homepage: "https://netlify.com",
      repository: "https://github.com/netlify/netlify-mcp",
      license: "ISC",
      installMethod: "npm",
      installCommand: "npx",
      packageName: "@netlify/mcp",
      transport: "stdio",
      defaultCommand: "npx",
      defaultArgs: ["-y", "@netlify/mcp"],
      defaultEnv: {
        NETLIFY_PERSONAL_ACCESS_TOKEN: "",
      },
      tools: [
        { name: "create_site", description: "Create a new Netlify site" },
        { name: "deploy", description: "Deploy to Netlify" },
        { name: "list_sites", description: "List Netlify sites" },
      ],
      tags: ["netlify", "deploy", "hosting", "jamstack"],
      category: "devtools",
      verified: true,
    },
    {
      id: "airtable",
      name: "Airtable",
      description: "Bring your structured data to Claude. Requires AIRTABLE_API_KEY.",
      version: "1.13.0",
      author: "Adam Jones",
      homepage: "https://airtable.com",
      repository: "https://github.com/domdomegg/airtable-mcp-server",
      license: "MIT",
      installMethod: "npm",
      installCommand: "npx",
      packageName: "airtable-mcp-server",
      transport: "stdio",
      defaultCommand: "npx",
      defaultArgs: ["-y", "airtable-mcp-server"],
      defaultEnv: {
        AIRTABLE_API_KEY: "",
      },
      tools: [
        { name: "list_bases", description: "List Airtable bases" },
        { name: "list_records", description: "List records from a table" },
        { name: "create_record", description: "Create a record" },
        { name: "search_records", description: "Search records" },
      ],
      tags: ["airtable", "database", "spreadsheet", "productivity"],
      category: "productivity",
      verified: true,
    },
    {
      id: "paypal",
      name: "PayPal",
      description: "Access PayPal payments platform. Requires PAYPAL_ACCESS_TOKEN.",
      version: "1.8.1",
      author: "PayPal",
      homepage: "https://paypal.com",
      repository: "https://github.com/paypal/paypal-mcp-server",
      license: "MIT",
      installMethod: "npm",
      installCommand: "npx",
      packageName: "@paypal/mcp",
      transport: "stdio",
      defaultCommand: "npx",
      defaultArgs: ["-y", "@paypal/mcp", "--tools=all"],
      defaultEnv: {
        PAYPAL_ACCESS_TOKEN: "",
        PAYPAL_ENVIRONMENT: "SANDBOX",
      },
      tools: [
        { name: "list_invoices", description: "List PayPal invoices" },
        { name: "create_order", description: "Create an order" },
        { name: "list_products", description: "List products" },
      ],
      tags: ["paypal", "payments", "finance"],
      category: "crm",
      verified: true,
    },
    {
      id: "square",
      name: "Square",
      description:
        "Search and manage transaction, merchant, and payment data. Requires ACCESS_TOKEN.",
      version: "0.1.2",
      author: "Block, Inc",
      homepage: "https://developer.squareup.com",
      repository: "https://github.com/square/square-mcp-server",
      license: "Apache-2.0",
      installMethod: "npm",
      installCommand: "npx",
      packageName: "square-mcp-server",
      transport: "stdio",
      defaultCommand: "npx",
      defaultArgs: ["-y", "square-mcp-server", "start"],
      defaultEnv: {
        ACCESS_TOKEN: "",
        SANDBOX: "true",
      },
      tools: [
        { name: "get_service_info", description: "Discover Square API methods" },
        { name: "make_api_request", description: "Execute Square API calls" },
      ],
      tags: ["square", "payments", "pos", "commerce"],
      category: "crm",
      verified: true,
    },
    {
      id: "attio",
      name: "Attio",
      description: "Search, manage, and update your Attio CRM from Claude. Requires ATTIO_API_KEY.",
      version: "0.0.2",
      author: "Attio",
      homepage: "https://attio.com",
      repository: "https://github.com/hmk/attio-mcp-server",
      license: "BSD-3-Clause",
      installMethod: "npm",
      installCommand: "npx",
      packageName: "attio-mcp-server",
      transport: "stdio",
      defaultCommand: "npx",
      defaultArgs: ["-y", "attio-mcp-server"],
      defaultEnv: {
        ATTIO_API_KEY: "",
      },
      tools: [
        { name: "list_companies", description: "List company records" },
        { name: "get_company", description: "Get company details" },
        { name: "create_note", description: "Create company note" },
      ],
      tags: ["attio", "crm", "sales"],
      category: "crm",
      verified: true,
    },
    {
      id: "honeycomb",
      name: "Honeycomb",
      description: "Query and explore observability data and SLOs. Requires HONEYCOMB_API_KEY.",
      version: "1.0.7",
      author: "kajirita2002",
      homepage: "https://honeycomb.io",
      repository: "https://github.com/kajirita2002/honeycomb-mcp-server",
      license: "MIT",
      installMethod: "npm",
      installCommand: "npx",
      packageName: "@kajirita2002/honeycomb-mcp-server",
      transport: "stdio",
      defaultCommand: "npx",
      defaultArgs: ["-y", "@kajirita2002/honeycomb-mcp-server"],
      defaultEnv: {
        HONEYCOMB_API_KEY: "",
      },
      tools: [
        { name: "honeycomb_datasets_list", description: "List datasets" },
        { name: "honeycomb_query_result_create", description: "Run queries" },
        { name: "honeycomb_boards_list", description: "List boards" },
      ],
      tags: ["honeycomb", "observability", "monitoring", "slo"],
      category: "devtools",
      verified: true,
    },
    {
      id: "calcom",
      name: "Cal.com",
      description: "Manage event types, availability, and bookings. Requires CAL_API_KEY.",
      version: "0.0.6",
      author: "Cal.com",
      homepage: "https://cal.com",
      repository: "https://github.com/calcom/cal-mcp",
      license: "MIT",
      installMethod: "npm",
      installCommand: "npx",
      packageName: "@calcom/cal-mcp",
      transport: "stdio",
      defaultCommand: "npx",
      defaultArgs: ["-y", "@calcom/cal-mcp"],
      defaultEnv: {
        CAL_API_KEY: "",
      },
      tools: [
        { name: "getBooking", description: "Get booking details" },
        { name: "createBooking", description: "Create a booking" },
        { name: "getEventTypes", description: "List event types" },
      ],
      tags: ["cal.com", "calendar", "scheduling", "bookings"],
      category: "productivity",
      verified: true,
    },
    {
      id: "cloudinary",
      name: "Cloudinary",
      description:
        "Manage, transform and deliver your images & videos. Requires CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET.",
      version: "0.4.0",
      author: "Yoav Niran",
      homepage: "https://cloudinary.com",
      repository: "https://github.com/yoavniran/cloudinary-mcp-server",
      license: "MIT",
      installMethod: "npm",
      installCommand: "npx",
      packageName: "cloudinary-mcp-server",
      transport: "stdio",
      defaultCommand: "npx",
      defaultArgs: ["-y", "cloudinary-mcp-server"],
      defaultEnv: {
        CLOUDINARY_CLOUD_NAME: "",
        CLOUDINARY_API_KEY: "",
        CLOUDINARY_API_SECRET: "",
      },
      tools: [
        { name: "upload", description: "Upload asset to Cloudinary" },
        { name: "find_assets", description: "Search assets" },
        { name: "get_asset", description: "Get asset details" },
      ],
      tags: ["cloudinary", "media", "images", "video", "dam"],
      category: "productivity",
      verified: true,
    },
    {
      id: "tavily",
      name: "Tavily",
      description: "Connect your AI agents to the web. Real-time search, extract, map, and crawl. Requires TAVILY_API_KEY.",
      version: "0.2.18",
      author: "Tavily",
      homepage: "https://tavily.com",
      repository: "https://github.com/tavily-ai/tavily-mcp",
      license: "MIT",
      installMethod: "npm",
      installCommand: "npx",
      packageName: "tavily-mcp",
      transport: "stdio",
      defaultCommand: "npx",
      defaultArgs: ["-y", "tavily-mcp@latest"],
      defaultEnv: {
        TAVILY_API_KEY: "",
      },
      tools: [
        { name: "tavily-search", description: "Real-time web search" },
        { name: "tavily-extract", description: "Extract data from web pages" },
        { name: "tavily-map", description: "Map website structure" },
        { name: "tavily-crawl", description: "Crawl websites" },
      ],
      tags: ["tavily", "web-search", "search", "ai"],
      category: "devtools",
      verified: true,
    },
    {
      id: "tldraw",
      name: "tldraw",
      description: "Manage local tldraw canvas files (.tldr). Read, write, search, and create diagrams. Optional TLDRAW_DIR.",
      version: "0.1.1",
      author: "Talha Orak",
      homepage: "https://tldraw.com",
      repository: "https://github.com/talhaorak/tldraw-mcp",
      license: "MIT",
      installMethod: "npm",
      installCommand: "npx",
      packageName: "@talhaorak/tldraw-mcp",
      transport: "stdio",
      defaultCommand: "npx",
      defaultArgs: ["-y", "@talhaorak/tldraw-mcp"],
      defaultEnv: {
        TLDRAW_DIR: "",
      },
      tools: [
        { name: "tldraw_read", description: "Read a .tldr file" },
        { name: "tldraw_write", description: "Write or update a .tldr file" },
        { name: "tldraw_list", description: "List .tldr files" },
        { name: "tldraw_search", description: "Search across canvases" },
      ],
      tags: ["tldraw", "diagrams", "whiteboard", "canvas"],
      category: "productivity",
      verified: true,
    },
    {
      id: "amplitude",
      name: "Amplitude",
      description: "Search, access, and get insights on your Amplitude analytics data. Requires AMPLITUDE_API_KEY.",
      version: "1.0.2",
      author: "Ciara Adkins",
      homepage: "https://amplitude.com",
      repository: "https://github.com/ciaraadkins/amplitude-mcp-server",
      license: "MIT",
      installMethod: "npm",
      installCommand: "npx",
      packageName: "amplitude-mcp-server",
      transport: "stdio",
      defaultCommand: "npx",
      defaultArgs: ["-y", "amplitude-mcp-server", "--api-key", "${AMPLITUDE_API_KEY}"],
      defaultEnv: {
        AMPLITUDE_API_KEY: "",
      },
      tools: [
        { name: "amplitude_track_event", description: "Track custom events" },
        { name: "amplitude_track_pageview", description: "Track page views" },
        { name: "amplitude_track_signup", description: "Track signups" },
        { name: "amplitude_set_user_properties", description: "Set user properties" },
        { name: "amplitude_track_revenue", description: "Track revenue" },
      ],
      tags: ["amplitude", "analytics", "tracking"],
      category: "devtools",
      verified: true,
    },
    {
      id: "clerk",
      name: "Clerk",
      description: "Add authentication, organizations, and billing. Manage users and sessions. Requires CLERK_API_KEY.",
      version: "0.0.13",
      author: "Clerk",
      homepage: "https://clerk.com",
      repository: "https://github.com/clerk/clerk-mcp",
      license: "MIT",
      installMethod: "npm",
      installCommand: "npx",
      packageName: "@clerk/clerk-mcp",
      transport: "stdio",
      defaultCommand: "npx",
      defaultArgs: ["-y", "@clerk/clerk-mcp@latest"],
      defaultEnv: {
        CLERK_API_KEY: "",
      },
      tools: [
        { name: "BanUser", description: "Ban a user" },
        { name: "CreateUser", description: "Create a user" },
        { name: "GetUser", description: "Get user details" },
        { name: "GetUserList", description: "List users" },
      ],
      tags: ["clerk", "auth", "authentication", "users"],
      category: "devtools",
      verified: true,
    },
    {
      id: "mem",
      name: "Mem",
      description: "The AI notebook for everything on your mind. Notes, collections, and search. Requires MEM_API_KEY.",
      version: "0.2.0",
      author: "hskksk",
      homepage: "https://mem.ai",
      repository: "https://github.com/hskksk/mem-ai-mcp-server",
      license: "MIT",
      installMethod: "npm",
      installCommand: "npx",
      packageName: "@hskksk/mem-ai-mcp-server",
      transport: "stdio",
      defaultCommand: "npx",
      defaultArgs: ["-y", "@hskksk/mem-ai-mcp-server"],
      defaultEnv: {
        MEM_API_KEY: "",
      },
      tools: [
        { name: "mem_it", description: "Remember content to mem.ai" },
        { name: "create_note", description: "Create a note" },
        { name: "search_notes", description: "Search notes" },
        { name: "list_collections", description: "List collections" },
      ],
      tags: ["mem", "notes", "memory", "productivity"],
      category: "productivity",
      verified: true,
    },
    {
      id: "grafana",
      name: "Grafana",
      description: "Access Grafana dashboards, datasources, alerting, and incidents. Requires GRAFANA_URL and token.",
      version: "1.0.3",
      author: "Leval AI",
      homepage: "https://grafana.com",
      repository: "https://github.com/leval/mcp-grafana",
      license: "MIT",
      installMethod: "npm",
      installCommand: "npx",
      packageName: "@leval/mcp-grafana",
      transport: "stdio",
      defaultCommand: "npx",
      defaultArgs: ["-y", "@leval/mcp-grafana"],
      defaultEnv: {
        GRAFANA_URL: "",
        GRAFANA_SERVICE_ACCOUNT_TOKEN: "",
      },
      tools: [
        { name: "list_dashboards", description: "List Grafana dashboards" },
        { name: "get_dashboard", description: "Get dashboard details" },
        { name: "list_datasources", description: "List datasources" },
      ],
      tags: ["grafana", "monitoring", "dashboards", "observability"],
      category: "devtools",
      verified: true,
    },
    {
      id: "mailtrap",
      name: "Mailtrap",
      description: "Send emails and manage templates using Mailtrap. Requires MAILTRAP_API_TOKEN.",
      version: "0.1.0",
      author: "Railsware",
      homepage: "https://mailtrap.io",
      repository: "https://github.com/railsware/mailtrap-mcp",
      license: "MIT",
      installMethod: "npm",
      installCommand: "npx",
      packageName: "mcp-mailtrap",
      transport: "stdio",
      defaultCommand: "npx",
      defaultArgs: ["-y", "mcp-mailtrap"],
      defaultEnv: {
        MAILTRAP_API_TOKEN: "",
        DEFAULT_FROM_EMAIL: "",
        MAILTRAP_ACCOUNT_ID: "",
      },
      tools: [
        { name: "send-email", description: "Send transactional email" },
        { name: "list-templates", description: "List email templates" },
        { name: "create-template", description: "Create email template" },
      ],
      tags: ["mailtrap", "email", "transactional"],
      category: "communication",
      verified: true,
    },
    {
      id: "socket",
      name: "Socket",
      description: "MCP server for scanning dependencies. Check security scores for npm, PyPI, and more. Optional SOCKET_API_KEY.",
      version: "0.0.17",
      author: "Socket",
      homepage: "https://socket.dev",
      repository: "https://github.com/SocketDev/socket-mcp",
      license: "MIT",
      installMethod: "npm",
      installCommand: "npx",
      packageName: "@socketsecurity/mcp",
      transport: "stdio",
      defaultCommand: "npx",
      defaultArgs: ["-y", "@socketsecurity/mcp@latest"],
      defaultEnv: {
        SOCKET_API_KEY: "",
      },
      tools: [
        { name: "depscore", description: "Query dependency security scores" },
      ],
      tags: ["socket", "security", "dependencies", "npm"],
      category: "devtools",
      verified: true,
    },
    {
      id: "metabase",
      name: "Metabase",
      description: "High-performance MCP server for Metabase analytics. Requires METABASE_URL and METABASE_API_KEY.",
      version: "1.0.14",
      author: "CognitionAI",
      homepage: "https://metabase.com",
      repository: "https://github.com/CognitionAI/metabase-mcp-server",
      license: "MIT",
      installMethod: "npm",
      installCommand: "npx",
      packageName: "@cognitionai/metabase-mcp-server",
      transport: "stdio",
      defaultCommand: "npx",
      defaultArgs: ["-y", "@cognitionai/metabase-mcp-server"],
      defaultEnv: {
        METABASE_URL: "",
        METABASE_API_KEY: "",
      },
      tools: [
        { name: "list_dashboards", description: "List Metabase dashboards" },
        { name: "execute_query", description: "Execute Metabase query" },
      ],
      tags: ["metabase", "analytics", "bi", "dashboards"],
      category: "devtools",
      verified: true,
    },
    {
      id: "shadcn-ui",
      name: "Shadcn UI",
      description: "MCP server for shadcn/ui components. Browse, search, and install components.",
      version: "0.1.2",
      author: "ymadd",
      homepage: "https://ui.shadcn.com",
      repository: "https://github.com/ymadd/shadcn-ui-mcp-server",
      license: "MIT",
      installMethod: "npm",
      installCommand: "npx",
      packageName: "shadcn-ui-mcp-server",
      transport: "stdio",
      defaultCommand: "npx",
      defaultArgs: ["-y", "shadcn-ui-mcp-server"],
      defaultEnv: {},
      tools: [
        { name: "list_shadcn_components", description: "List available components" },
        { name: "search_components", description: "Search components" },
        { name: "get_component_details", description: "Get component info" },
      ],
      tags: ["shadcn", "ui", "components", "react"],
      category: "devtools",
      verified: true,
    },
    {
      id: "growthbook",
      name: "GrowthBook",
      description: "Feature flags and A/B testing. Create experiments, manage SDK connections. Requires GB_API_KEY and GB_EMAIL.",
      version: "1.8.1",
      author: "GrowthBook",
      homepage: "https://growthbook.io",
      repository: "https://github.com/growthbook/growthbook-mcp",
      license: "MIT",
      installMethod: "npm",
      installCommand: "npx",
      packageName: "@growthbook/mcp",
      transport: "stdio",
      defaultCommand: "npx",
      defaultArgs: ["-y", "@growthbook/mcp@latest"],
      defaultEnv: {
        GB_API_KEY: "",
        GB_EMAIL: "",
      },
      tools: [
        { name: "create_feature", description: "Create feature flag" },
        { name: "list_experiments", description: "List experiments" },
      ],
      tags: ["growthbook", "feature-flags", "ab-testing"],
      category: "devtools",
      verified: true,
    },
    {
      id: "drafts",
      name: "Drafts",
      description: "MCP server for the Drafts app on macOS. Create, search, and manage drafts via AppleScript.",
      version: "1.0.5",
      author: "Agile Tortoise",
      homepage: "https://getdrafts.com",
      repository: "https://github.com/agiletortoise/drafts-mcp-server",
      license: "MIT",
      installMethod: "npm",
      installCommand: "npx",
      packageName: "@agiletortoise/drafts-mcp-server",
      transport: "stdio",
      defaultCommand: "npx",
      defaultArgs: ["-y", "@agiletortoise/drafts-mcp-server"],
      defaultEnv: {},
      tools: [
        { name: "create_draft", description: "Create a draft" },
        { name: "search_drafts", description: "Search drafts" },
        { name: "list_drafts", description: "List drafts" },
      ],
      tags: ["drafts", "notes", "macos", "productivity"],
      category: "productivity",
      verified: true,
    },
    {
      id: "fantastical",
      name: "Fantastical",
      description: "Read events and tasks, create new items from Fantastical calendar. macOS only.",
      version: "1.1.0",
      author: "Jim Christian",
      homepage: "https://flexibits.com/fantastical",
      repository: "https://github.com/aplaceforallmystuff/mcp-fantastical",
      license: "MIT",
      installMethod: "npm",
      installCommand: "npx",
      packageName: "mcp-fantastical",
      transport: "stdio",
      defaultCommand: "npx",
      defaultArgs: ["-y", "mcp-fantastical"],
      defaultEnv: {},
      tools: [
        { name: "fantastical_create_event", description: "Create event with natural language" },
        { name: "fantastical_get_today", description: "Get today's events" },
        { name: "fantastical_get_upcoming", description: "Get upcoming events" },
      ],
      tags: ["fantastical", "calendar", "macos", "productivity"],
      category: "productivity",
      verified: true,
    },
    {
      id: "tomba",
      name: "Tomba",
      description: "MCP server for Tomba email finder and verification API. Requires TOMBA_API_KEY and TOMBA_SECRET_KEY.",
      version: "1.6.0",
      author: "Tomba.io",
      homepage: "https://tomba.io",
      repository: "https://github.com/tomba-io/tomba-mcp-server",
      license: "MIT",
      installMethod: "npm",
      installCommand: "npx",
      packageName: "tomba-mcp-server",
      transport: "stdio",
      defaultCommand: "npx",
      defaultArgs: ["-y", "tomba-mcp-server"],
      defaultEnv: {
        TOMBA_API_KEY: "",
        TOMBA_SECRET_KEY: "",
      },
      tools: [
        { name: "email_finder", description: "Find email from name and domain" },
        { name: "email_verifier", description: "Verify email deliverability" },
        { name: "domain_search", description: "Find emails for a domain" },
      ],
      tags: ["tomba", "email", "verification", "lead-generation"],
      category: "devtools",
      verified: true,
    },
    // --- API-key connectors ---
    {
      id: "apollo",
      name: "Apollo",
      description:
        "Apollo.io connector for CoWork OS. Prospecting and data enrichment. Requires APOLLO_API_KEY.",
      version: LOCAL_CONNECTOR_VERSION,
      author: "CoWork OS",
      homepage: "https://github.com/CoWork-OS/CoWork-OS",
      repository: "https://github.com/CoWork-OS/CoWork-OS",
      license: "MIT",
      installMethod: "manual",
      transport: "stdio",
      defaultCommand: apolloCommand.command,
      defaultArgs: apolloCommand.args,
      defaultEnv: {
        APOLLO_API_KEY: "",
      },
      tools: [
        { name: "apollo.health", description: "Check connector health and auth status" },
        { name: "apollo.search_people", description: "Search for contacts by criteria" },
        { name: "apollo.get_person", description: "Get enriched person data by ID or email" },
        { name: "apollo.search_organizations", description: "Search for companies" },
        { name: "apollo.get_organization", description: "Get enriched company data" },
        { name: "apollo.enrich_contact", description: "Enrich a contact with additional data" },
      ],
      tags: ["apollo", "prospecting", "enrichment", "enterprise", "connector"],
      category: "enterprise",
      verified: true,
    },
    {
      id: "clay",
      name: "Clay",
      description:
        "Clay connector for CoWork OS. Data enrichment and waterfall workflows. Requires CLAY_API_KEY.",
      version: LOCAL_CONNECTOR_VERSION,
      author: "CoWork OS",
      homepage: "https://github.com/CoWork-OS/CoWork-OS",
      repository: "https://github.com/CoWork-OS/CoWork-OS",
      license: "MIT",
      installMethod: "manual",
      transport: "stdio",
      defaultCommand: clayCommand.command,
      defaultArgs: clayCommand.args,
      defaultEnv: {
        CLAY_API_KEY: "",
      },
      tools: [
        { name: "clay.health", description: "Check connector health and auth status" },
        { name: "clay.list_tables", description: "List Clay tables" },
        { name: "clay.get_table", description: "Get a table by ID" },
        { name: "clay.search_rows", description: "Search rows in a table" },
        { name: "clay.enrich_person", description: "Enrich a person record" },
        { name: "clay.enrich_company", description: "Enrich a company record" },
      ],
      tags: ["clay", "enrichment", "data", "enterprise", "connector"],
      category: "enterprise",
      verified: true,
    },
    {
      id: "similarweb",
      name: "Similarweb",
      description:
        "Similarweb connector for CoWork OS. Web traffic analytics and competitive intelligence. Requires SIMILARWEB_API_KEY.",
      version: LOCAL_CONNECTOR_VERSION,
      author: "CoWork OS",
      homepage: "https://github.com/CoWork-OS/CoWork-OS",
      repository: "https://github.com/CoWork-OS/CoWork-OS",
      license: "MIT",
      installMethod: "manual",
      transport: "stdio",
      defaultCommand: similarwebCommand.command,
      defaultArgs: similarwebCommand.args,
      defaultEnv: {
        SIMILARWEB_API_KEY: "",
      },
      tools: [
        { name: "similarweb.health", description: "Check connector health and auth status" },
        { name: "similarweb.get_website_traffic", description: "Get website traffic overview" },
        { name: "similarweb.get_top_pages", description: "Get top pages for a domain" },
        { name: "similarweb.get_traffic_sources", description: "Get traffic source breakdown" },
        { name: "similarweb.get_competitors", description: "Get similar sites and competitors" },
        { name: "similarweb.get_keyword_analysis", description: "Get organic/paid keyword data" },
      ],
      tags: ["similarweb", "analytics", "competitive-intelligence", "enterprise", "connector"],
      category: "enterprise",
      verified: true,
    },
    {
      id: "msci",
      name: "MSCI",
      description:
        "MSCI connector for CoWork OS. ESG ratings, risk analytics, and index data. Requires MSCI_API_KEY.",
      version: LOCAL_CONNECTOR_VERSION,
      author: "CoWork OS",
      homepage: "https://github.com/CoWork-OS/CoWork-OS",
      repository: "https://github.com/CoWork-OS/CoWork-OS",
      license: "MIT",
      installMethod: "manual",
      transport: "stdio",
      defaultCommand: msciCommand.command,
      defaultArgs: msciCommand.args,
      defaultEnv: {
        MSCI_API_KEY: "",
        MSCI_BASE_URL: "https://api.msci.com",
      },
      tools: [
        { name: "msci.health", description: "Check connector health and auth status" },
        { name: "msci.get_esg_rating", description: "Get ESG rating for a company" },
        { name: "msci.get_esg_history", description: "Get historical ESG rating changes" },
        { name: "msci.get_index_constituents", description: "List index constituents" },
        { name: "msci.get_risk_metrics", description: "Get factor risk metrics" },
        { name: "msci.search_companies", description: "Search companies in MSCI universe" },
      ],
      tags: ["msci", "esg", "risk", "index", "finance", "connector"],
      category: "enterprise",
      verified: true,
    },
    {
      id: "legalzoom",
      name: "LegalZoom",
      description:
        "LegalZoom connector for CoWork OS. Legal document management and business filings. Requires LEGALZOOM_API_KEY.",
      version: LOCAL_CONNECTOR_VERSION,
      author: "CoWork OS",
      homepage: "https://github.com/CoWork-OS/CoWork-OS",
      repository: "https://github.com/CoWork-OS/CoWork-OS",
      license: "MIT",
      installMethod: "manual",
      transport: "stdio",
      defaultCommand: legalzoomCommand.command,
      defaultArgs: legalzoomCommand.args,
      defaultEnv: {
        LEGALZOOM_API_KEY: "",
      },
      tools: [
        { name: "legalzoom.health", description: "Check connector health and auth status" },
        { name: "legalzoom.list_orders", description: "List document orders" },
        { name: "legalzoom.get_order", description: "Get order details" },
        { name: "legalzoom.list_documents", description: "List legal documents" },
        { name: "legalzoom.get_document", description: "Get a document by ID" },
        { name: "legalzoom.list_filings", description: "List business filings" },
      ],
      tags: ["legalzoom", "legal", "documents", "enterprise", "connector"],
      category: "enterprise",
      verified: true,
    },
    {
      id: "factset",
      name: "FactSet",
      description:
        "FactSet connector for CoWork OS. Financial data, analytics, and research. Requires FACTSET_API_KEY.",
      version: LOCAL_CONNECTOR_VERSION,
      author: "CoWork OS",
      homepage: "https://github.com/CoWork-OS/CoWork-OS",
      repository: "https://github.com/CoWork-OS/CoWork-OS",
      license: "MIT",
      installMethod: "manual",
      transport: "stdio",
      defaultCommand: factsetCommand.command,
      defaultArgs: factsetCommand.args,
      defaultEnv: {
        FACTSET_USERNAME: "",
        FACTSET_API_KEY: "",
      },
      tools: [
        { name: "factset.health", description: "Check connector health and auth status" },
        { name: "factset.get_prices", description: "Get historical price data" },
        { name: "factset.get_fundamentals", description: "Get company fundamentals" },
        { name: "factset.get_estimates", description: "Get consensus estimates" },
        { name: "factset.search_companies", description: "Search for companies" },
        { name: "factset.get_financials", description: "Get financial statements" },
        { name: "factset.get_ratios", description: "Get financial ratios" },
      ],
      tags: ["factset", "financial-data", "research", "finance", "connector"],
      category: "enterprise",
      verified: true,
      featured: true,
    },
    {
      id: "wordpress",
      name: "WordPress",
      description:
        "WordPress connector for CoWork OS. Manage posts, pages, and media. Requires WordPress application password.",
      version: LOCAL_CONNECTOR_VERSION,
      author: "CoWork OS",
      homepage: "https://github.com/CoWork-OS/CoWork-OS",
      repository: "https://github.com/CoWork-OS/CoWork-OS",
      license: "MIT",
      installMethod: "manual",
      transport: "stdio",
      defaultCommand: wordpressCommand.command,
      defaultArgs: wordpressCommand.args,
      defaultEnv: {
        WORDPRESS_SITE_URL: "",
        WORDPRESS_USERNAME: "",
        WORDPRESS_APPLICATION_PASSWORD: "",
      },
      tools: [
        { name: "wordpress.health", description: "Check connector health and auth status" },
        { name: "wordpress.list_posts", description: "List blog posts" },
        { name: "wordpress.get_post", description: "Get a post by ID" },
        { name: "wordpress.create_post", description: "Create a new post" },
        { name: "wordpress.update_post", description: "Update an existing post" },
        { name: "wordpress.list_pages", description: "List pages" },
        { name: "wordpress.upload_media", description: "Upload media file" },
      ],
      tags: ["wordpress", "cms", "content", "connector"],
      category: "enterprise",
      verified: true,
    },
    {
      id: "harvey",
      name: "Harvey",
      description:
        "Harvey AI connector for CoWork OS. AI-powered legal research and document analysis. Requires HARVEY_API_KEY.",
      version: LOCAL_CONNECTOR_VERSION,
      author: "CoWork OS",
      homepage: "https://github.com/CoWork-OS/CoWork-OS",
      repository: "https://github.com/CoWork-OS/CoWork-OS",
      license: "MIT",
      installMethod: "manual",
      transport: "stdio",
      defaultCommand: harveyCommand.command,
      defaultArgs: harveyCommand.args,
      defaultEnv: {
        HARVEY_API_KEY: "",
      },
      tools: [
        { name: "harvey.health", description: "Check connector health and auth status" },
        { name: "harvey.analyze_document", description: "Analyze a legal document" },
        { name: "harvey.search_case_law", description: "Search case law and precedents" },
        { name: "harvey.draft_document", description: "Draft a legal document" },
        { name: "harvey.review_contract", description: "Review and redline a contract" },
        { name: "harvey.research_question", description: "Research a legal question" },
      ],
      tags: ["harvey", "legal", "ai", "enterprise", "connector"],
      category: "enterprise",
      verified: true,
    },
    {
      id: "lseg",
      name: "LSEG (Refinitiv)",
      description:
        "LSEG/Refinitiv connector for CoWork OS. Market data, news, and financial analytics. Requires LSEG_API_KEY.",
      version: LOCAL_CONNECTOR_VERSION,
      author: "CoWork OS",
      homepage: "https://github.com/CoWork-OS/CoWork-OS",
      repository: "https://github.com/CoWork-OS/CoWork-OS",
      license: "MIT",
      installMethod: "manual",
      transport: "stdio",
      defaultCommand: lsegCommand.command,
      defaultArgs: lsegCommand.args,
      defaultEnv: {
        LSEG_API_KEY: "",
        LSEG_API_SECRET: "",
      },
      tools: [
        { name: "lseg.health", description: "Check connector health and auth status" },
        { name: "lseg.get_quote", description: "Get real-time quote for an instrument" },
        { name: "lseg.get_historical_prices", description: "Get historical price data" },
        { name: "lseg.search_instruments", description: "Search for instruments" },
        { name: "lseg.get_news", description: "Get news headlines and stories" },
        { name: "lseg.get_fundamentals", description: "Get company fundamental data" },
        { name: "lseg.get_estimates", description: "Get analyst estimates and consensus" },
      ],
      tags: ["lseg", "refinitiv", "market-data", "finance", "connector"],
      category: "enterprise",
      verified: true,
      featured: true,
    },
    {
      id: "spglobal",
      name: "S&P Global",
      description:
        "S&P Global connector for CoWork OS. Financial intelligence, credit ratings, and market data. Requires SPGLOBAL_API_KEY.",
      version: LOCAL_CONNECTOR_VERSION,
      author: "CoWork OS",
      homepage: "https://github.com/CoWork-OS/CoWork-OS",
      repository: "https://github.com/CoWork-OS/CoWork-OS",
      license: "MIT",
      installMethod: "manual",
      transport: "stdio",
      defaultCommand: spglobalCommand.command,
      defaultArgs: spglobalCommand.args,
      defaultEnv: {
        SPGLOBAL_USERNAME: "",
        SPGLOBAL_API_KEY: "",
      },
      tools: [
        { name: "spglobal.health", description: "Check connector health and auth status" },
        { name: "spglobal.get_credit_rating", description: "Get credit rating for an entity" },
        { name: "spglobal.search_entities", description: "Search entities in S&P universe" },
        { name: "spglobal.get_financials", description: "Get company financial data" },
        { name: "spglobal.get_industry_data", description: "Get industry analysis data" },
        { name: "spglobal.get_market_data", description: "Get market and index data" },
      ],
      tags: ["spglobal", "credit-ratings", "financial-data", "finance", "connector"],
      category: "enterprise",
      verified: true,
      featured: true,
    },
    {
      id: "commonroom",
      name: "Common Room",
      description:
        "Common Room connector for CoWork OS. Community intelligence and signal tracking. Requires COMMONROOM_API_KEY.",
      version: LOCAL_CONNECTOR_VERSION,
      author: "CoWork OS",
      homepage: "https://github.com/CoWork-OS/CoWork-OS",
      repository: "https://github.com/CoWork-OS/CoWork-OS",
      license: "MIT",
      installMethod: "manual",
      transport: "stdio",
      defaultCommand: commonroomCommand.command,
      defaultArgs: commonroomCommand.args,
      defaultEnv: {
        COMMONROOM_API_KEY: "",
      },
      tools: [
        { name: "commonroom.health", description: "Check connector health and auth status" },
        { name: "commonroom.list_members", description: "List community members" },
        { name: "commonroom.get_member", description: "Get member details" },
        { name: "commonroom.list_activities", description: "List community activities" },
        { name: "commonroom.search_signals", description: "Search buying signals" },
        { name: "commonroom.list_segments", description: "List member segments" },
      ],
      tags: ["commonroom", "community", "signals", "enterprise", "connector"],
      category: "enterprise",
      verified: true,
    },
    {
      id: "tribeai",
      name: "Tribe AI",
      description:
        "Tribe AI connector for CoWork OS. AI workforce management and expert matching. Requires TRIBEAI_API_KEY.",
      version: LOCAL_CONNECTOR_VERSION,
      author: "CoWork OS",
      homepage: "https://github.com/CoWork-OS/CoWork-OS",
      repository: "https://github.com/CoWork-OS/CoWork-OS",
      license: "MIT",
      installMethod: "manual",
      transport: "stdio",
      defaultCommand: tribeaiCommand.command,
      defaultArgs: tribeaiCommand.args,
      defaultEnv: {
        TRIBEAI_API_KEY: "",
      },
      tools: [
        { name: "tribeai.health", description: "Check connector health and auth status" },
        { name: "tribeai.list_experts", description: "List available AI experts" },
        { name: "tribeai.get_expert", description: "Get expert profile details" },
        { name: "tribeai.search_experts", description: "Search experts by skill or domain" },
        { name: "tribeai.create_project", description: "Create a new project" },
        { name: "tribeai.list_projects", description: "List projects" },
      ],
      tags: ["tribeai", "ai", "workforce", "enterprise", "connector"],
      category: "enterprise",
      verified: true,
    },
  ];

  return filterUnavailableConnectorEntries(
    entries.filter((entry) => SHIPPED_LOCAL_CONNECTOR_IDS.has(entry.id)),
  );
}

function getBuiltinRegistry(): MCPRegistry {
  return {
    version: "1.1.0",
    lastUpdated: new Date().toISOString(),
    servers: [...BASE_BUILTIN_SERVERS, ...getConnectorEntries()],
  };
}

function mergeLocalConnectors(registry: MCPRegistry): MCPRegistry {
  const localConnectors = getConnectorEntries();
  const existingIds = new Set(registry.servers.map((s) => s.id));
  const existingNames = new Set(registry.servers.map((s) => s.name.toLowerCase()));
  const mergedServers = [...registry.servers];

  for (const connector of localConnectors) {
    if (existingIds.has(connector.id) || existingNames.has(connector.name.toLowerCase())) {
      continue;
    }
    mergedServers.push(connector);
  }

  return {
    ...registry,
    servers: mergedServers,
  };
}

function validateManualEntry(entry: MCPRegistryEntry): void {
  if (entry.installMethod !== "manual") return;

  const command = entry.defaultCommand || entry.installCommand;
  if (!command) {
    throw new Error(`Manual server ${entry.name} is missing a command`);
  }

  const args = entry.defaultArgs || [];
  const scriptPath = args.find((arg) => /\.(c|m)?js$/i.test(arg));
  if (scriptPath && !fs.existsSync(scriptPath)) {
    throw new Error(
      `Connector script not found at ${scriptPath}. ` +
        `Build connectors first (npm run build:connectors) or reinstall.`,
    );
  }
}

function isValidNpmPackagePart(part: string): boolean {
  return (
    part.length > 0 &&
    !part.startsWith(".") &&
    !part.startsWith("_") &&
    !part.startsWith("-") &&
    NPM_PACKAGE_PART_PATTERN.test(part)
  );
}

function isValidNpmPackageName(packageName: string): boolean {
  if (
    packageName.length === 0 ||
    packageName.length > MAX_NPM_PACKAGE_NAME_LENGTH ||
    packageName.trim() !== packageName
  ) {
    return false;
  }

  if (packageName.startsWith("@")) {
    const parts = packageName.split("/");
    return (
      parts.length === 2 &&
      parts[0].length > 1 &&
      isValidNpmPackagePart(parts[0].slice(1)) &&
      isValidNpmPackagePart(parts[1])
    );
  }

  return !packageName.includes("/") && isValidNpmPackagePart(packageName);
}

function npmViewVersion(packageName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "npm",
      ["view", packageName, "version"],
      { timeout: 15000 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export class MCPRegistryManager {
  private static registryCache: MCPRegistry | null = null;
  private static cacheTimestamp: number = 0;

  /**
   * Fetch the MCP server registry
   */
  static async fetchRegistry(forceRefresh: boolean = false): Promise<MCPRegistry> {
    // Check cache
    if (
      !forceRefresh &&
      this.registryCache &&
      Date.now() - this.cacheTimestamp < REGISTRY_CACHE_DURATION
    ) {
      return this.registryCache;
    }

    const settings = MCPSettingsManager.loadSettings();

    if (!settings.registryEnabled) {
      console.log("[MCPRegistryManager] Registry disabled, using built-in registry");
      return getBuiltinRegistry();
    }

    try {
      console.log(`[MCPRegistryManager] Fetching registry from ${settings.registryUrl}`);

      const response = await fetch(settings.registryUrl, {
        headers: {
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10000), // 10 second timeout
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const registry = (await response.json()) as MCPRegistry;

      // Validate registry structure
      if (!registry.version || !Array.isArray(registry.servers)) {
        throw new Error("Invalid registry format");
      }

      // Merge local connectors into remote registry
      const mergedRegistry = mergeLocalConnectors(registry);

      // Update cache
      this.registryCache = mergedRegistry;
      this.cacheTimestamp = Date.now();

      console.log(
        `[MCPRegistryManager] Fetched ${mergedRegistry.servers.length} servers from registry (with local connectors)`,
      );
      return mergedRegistry;
    } catch (error: Any) {
      // Only log on first failure or after cache expires
      if (!this.registryCache) {
        console.warn(
          "[MCPRegistryManager] Failed to fetch registry, using built-in:",
          error.message,
        );
      }
      // Cache the built-in registry to prevent repeated fetch attempts
      this.registryCache = getBuiltinRegistry();
      this.cacheTimestamp = Date.now();
      return this.registryCache;
    }
  }

  /**
   * Search for servers in the registry
   */
  static async searchServers(options: MCPRegistrySearchOptions = {}): Promise<MCPRegistryEntry[]> {
    const registry = await this.fetchRegistry();
    let results = [...registry.servers];

    // Filter by query (search name and description)
    if (options.query) {
      const query = options.query.toLowerCase();
      results = results.filter(
        (server) =>
          server.name.toLowerCase().includes(query) ||
          server.description.toLowerCase().includes(query) ||
          server.tags.some((tag) => tag.toLowerCase().includes(query)),
      );
    }

    // Filter by tags
    if (options.tags && options.tags.length > 0) {
      const tags = options.tags.map((t) => t.toLowerCase());
      results = results.filter((server) =>
        tags.some((tag) => server.tags.some((t) => t.toLowerCase() === tag)),
      );
    }

    // Filter by category
    if (options.category) {
      const category = options.category.toLowerCase();
      results = results.filter((server) => server.category?.toLowerCase() === category);
    }

    // Filter by verified status
    if (options.verified !== undefined) {
      results = results.filter((server) => server.verified === options.verified);
    }

    // Apply pagination
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 50;
    results = results.slice(offset, offset + limit);

    return results;
  }

  /**
   * Get a specific server from the registry by ID
   */
  static async getServer(serverId: string): Promise<MCPRegistryEntry | null> {
    const registry = await this.fetchRegistry();
    return registry.servers.find((s) => s.id === serverId) || null;
  }

  /**
   * Verify that an npm package exists on the registry
   */
  static async verifyNpmPackage(
    packageName: string,
  ): Promise<{ exists: boolean; version?: string; error?: string }> {
    if (!isValidNpmPackageName(packageName)) {
      return { exists: false, error: `Invalid npm package name: "${packageName}"` };
    }

    try {
      console.log(`[MCPRegistryManager] Verifying npm package: ${packageName}`);
      const stdout = await npmViewVersion(packageName);
      const version = stdout.trim();
      console.log(`[MCPRegistryManager] Package ${packageName} exists, version: ${version}`);
      return { exists: true, version };
    } catch (error: Any) {
      // Check if it's a 404 (package not found)
      if (
        error.message?.includes("404") ||
        error.message?.includes("not found") ||
        error.stderr?.includes("404")
      ) {
        console.warn(`[MCPRegistryManager] Package ${packageName} not found on npm`);
        return { exists: false, error: `Package "${packageName}" not found on npm registry` };
      }
      // Other errors (network, timeout, etc.)
      console.warn(`[MCPRegistryManager] Error verifying package ${packageName}:`, error.message);
      return { exists: false, error: `Failed to verify package: ${error.message}` };
    }
  }

  /**
   * Install a server from the registry
   */
  static async installServer(entryId: string, extraArgs?: string[]): Promise<MCPServerConfig> {
    const entry = await this.getServer(entryId);
    if (!entry) {
      throw new Error(`Server ${entryId} not found in registry`);
    }

    console.log(`[MCPRegistryManager] Installing server: ${entry.name}`);

    // Check if already installed
    const settings = MCPSettingsManager.loadSettings();
    const existingIndex = settings.servers.findIndex(
      (s) => s.name === entry.name || (entry.packageName && s.command?.includes(entry.packageName)),
    );

    if (existingIndex !== -1) {
      throw new Error(`Server ${entry.name} is already installed`);
    }

    // Validate manual entries (local connectors)
    validateManualEntry(entry);

    // Verify the npm package exists before installing
    if (entry.packageName && entry.installMethod === "npm") {
      const verification = await this.verifyNpmPackage(entry.packageName);
      if (!verification.exists) {
        throw new Error(verification.error || `Package "${entry.packageName}" is not available`);
      }
      // Update version to the actual npm version if available
      if (verification.version) {
        entry.version = verification.version;
      }
    }

    // Create server config from registry entry
    const enabledByDefault = entry.installMethod !== "manual";
    const config: MCPServerConfig = {
      id: uuidv4(),
      name: entry.name,
      description: entry.description,
      // Manual/local connectors usually require credentials first.
      enabled: enabledByDefault,
      transport: entry.transport,
      command: entry.defaultCommand || entry.installCommand,
      args: [...(entry.defaultArgs || []), ...(extraArgs || [])],
      env: entry.defaultEnv,
      version: entry.version,
      author: entry.author,
      homepage: entry.homepage,
      repository: entry.repository,
      license: entry.license,
      installedAt: Date.now(),
    };

    // Add to settings
    MCPSettingsManager.addServer(config);

    console.log(`[MCPRegistryManager] Installed server: ${entry.name}`);
    return config;
  }

  /**
   * Uninstall a server (remove from settings)
   */
  static async uninstallServer(serverId: string): Promise<void> {
    console.log(`[MCPRegistryManager] Uninstalling server: ${serverId}`);
    MCPSettingsManager.removeServer(serverId);
    console.log(`[MCPRegistryManager] Uninstalled server: ${serverId}`);
  }

  /**
   * Check for updates to installed servers.
   * For npm-based connectors, queries the npm registry directly for the latest version
   * so updates are detected when providers publish new releases, not just when CoWork ships.
   */
  static async checkForUpdates(): Promise<MCPUpdateInfo[]> {
    const registry = await this.fetchRegistry(true);
    const settings = MCPSettingsManager.loadSettings();
    const updates: MCPUpdateInfo[] = [];

    const checkPromises = settings.servers.map(async (installed) => {
      const entry = registry.servers.find(
        (e) =>
          e.name === installed.name ||
          (e.packageName && installed.command?.includes(e.packageName)),
      );

      if (!entry) return null;

      let latestVersion: string | undefined;

      // For npm packages, query npm registry for real-time latest version
      if (entry.packageName && entry.installMethod === "npm") {
        const verification = await this.verifyNpmPackage(entry.packageName);
        if (verification.exists && verification.version) {
          latestVersion = verification.version;
        }
      }

      // Fallback to registry entry version (for manual connectors or when npm fails)
      if (!latestVersion) {
        latestVersion = entry.version;
      }

      if (
        latestVersion &&
        installed.version &&
        latestVersion !== installed.version &&
        this.isNewerVersion(latestVersion, installed.version)
      ) {
        return {
          serverId: installed.id,
          currentVersion: installed.version,
          latestVersion,
          registryEntry: { ...entry, version: latestVersion },
        } as MCPUpdateInfo;
      }

      return null;
    });

    const results = await Promise.all(checkPromises);
    for (const r of results) {
      if (r) updates.push(r);
    }

    return updates;
  }

  /**
   * Update an installed server to the latest version.
   * For npm packages, fetches the current version from the npm registry.
   */
  static async updateServer(serverId: string): Promise<MCPServerConfig> {
    const settings = MCPSettingsManager.loadSettings();
    const installed = settings.servers.find((s) => s.id === serverId);

    if (!installed) {
      throw new Error(`Server ${serverId} not found`);
    }

    const registry = await this.fetchRegistry(true);
    const entry = registry.servers.find(
      (e) =>
        e.name === installed.name || (e.packageName && installed.command?.includes(e.packageName)),
    );

    if (!entry) {
      throw new Error(`Server ${installed.name} not found in registry`);
    }

    let version = entry.version;

    // For npm packages, fetch latest version from npm registry
    if (entry.packageName && entry.installMethod === "npm") {
      const verification = await this.verifyNpmPackage(entry.packageName);
      if (verification.exists && verification.version) {
        version = verification.version;
      }
    }

    const updatedConfig: Partial<MCPServerConfig> = {
      version,
      command: entry.defaultCommand || entry.installCommand,
      args: entry.defaultArgs,
    };

    const result = MCPSettingsManager.updateServer(serverId, updatedConfig);
    if (!result) {
      throw new Error(`Failed to update server ${serverId}`);
    }
    return result;
  }

  /**
   * Get available categories from the registry
   */
  static async getCategories(): Promise<string[]> {
    const registry = await this.fetchRegistry();
    const categories = new Set<string>();

    for (const server of registry.servers) {
      if (server.category) {
        categories.add(server.category);
      }
    }

    return Array.from(categories).sort();
  }

  /**
   * Get all unique tags from the registry
   */
  static async getTags(): Promise<string[]> {
    const registry = await this.fetchRegistry();
    const tags = new Set<string>();

    for (const server of registry.servers) {
      for (const tag of server.tags) {
        tags.add(tag);
      }
    }

    return Array.from(tags).sort();
  }

  /**
   * Clear the registry cache
   */
  static clearCache(): void {
    this.registryCache = null;
    this.cacheTimestamp = 0;
  }

  /**
   * Check if version A is newer than version B
   */
  private static isNewerVersion(versionA: string, versionB: string): boolean {
    const partsA = versionA.replace(/^v/, "").split(".").map(Number);
    const partsB = versionB.replace(/^v/, "").split(".").map(Number);

    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
      const a = partsA[i] || 0;
      const b = partsB[i] || 0;

      if (a > b) return true;
      if (a < b) return false;
    }

    return false;
  }
}
