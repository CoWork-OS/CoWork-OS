/**
 * Connector profile metadata for Claude-style detail views.
 * Merged with MCPRegistryEntry when rendering ConnectorProfileView.
 */

export interface ConnectorProfile {
  tagline: string;
  longDescription: string;
  keyFeatures: Array<{
    title: string;
    description: string;
  }>;
  examples?: Array<{
    prompt: string;
    resultImageUrl?: string;
    resultLabel?: string;
  }>;
  iconUrl?: string;
}

export const CONNECTOR_PROFILES: Record<string, ConnectorProfile> = {
  figma: {
    tagline: "Generate diagrams and better code from Figma context",
    longDescription:
      "The Figma MCP server helps you pull in Figma context to visualize designs, extract component structure, and generate diagrams. Connect your Figma files to get design tokens, layer hierarchies, and export assets directly in your workflow.",
    keyFeatures: [
      {
        title: "Extract design context from layers",
        description:
          "Pull out variables, components, and layouts from Figma files for documentation and code generation.",
      },
      {
        title: "Export images and assets",
        description:
          "Export frames and nodes as PNG, SVG, or PDF for use in presentations and documentation.",
      },
      {
        title: "Navigate file structure",
        description:
          "Browse pages, frames, and components to understand design organization and relationships.",
      },
    ],
    examples: [
      {
        prompt: "Can you visualize the proposed data flow in part 2?",
        resultLabel: "Architectural diagram from Figma context",
      },
      {
        prompt: "Extract the component structure from this Figma file",
        resultLabel: "Component hierarchy and props",
      },
    ],
  },
  vercel: {
    tagline: "Analyze, debug, and manage projects and deployments",
    longDescription:
      "The Vercel connector lets you inspect deployments, view build logs, manage environment variables, and troubleshoot production issues. Connect your Vercel account to manage projects directly from CoWork.",
    keyFeatures: [
      {
        title: "List and inspect deployments",
        description: "View deployment history, status, and logs for each project and branch.",
      },
      {
        title: "Manage projects",
        description: "Get project details, domains, and configuration without leaving the app.",
      },
      {
        title: "Debug build failures",
        description: "Fetch build logs and deployment metadata to diagnose failed deployments.",
      },
    ],
    examples: [
      {
        prompt: "What's the status of my latest Vercel deployment?",
        resultLabel: "Deployment status and build info",
      },
      {
        prompt: "Show me the build logs for the main branch",
        resultLabel: "Build log output",
      },
    ],
  },
  monday: {
    tagline: "Manage projects, boards, and workflows in monday.com",
    longDescription:
      "Connect monday.com to create and update items, manage boards, and sync project status. The agent can query boards, add items, and update columns based on your requests.",
    keyFeatures: [
      {
        title: "List and search boards",
        description: "Browse your monday.com workspace and find boards by name or type.",
      },
      {
        title: "Create and update items",
        description:
          "Add items to boards, update column values, and manage workflows programmatically.",
      },
      {
        title: "Query board structure",
        description: "Get board metadata, columns, and item details for automation and reporting.",
      },
    ],
    examples: [
      {
        prompt: "Add a new task to my Sprint board",
        resultLabel: "Created item with status",
      },
      {
        prompt: "What's on my Product Roadmap board this week?",
        resultLabel: "Board items and status",
      },
    ],
  },
  jira: {
    tagline: "Issue tracking and project management for teams",
    longDescription:
      "Connect Jira to search issues, create tickets, update status, and manage sprints. The agent can run JQL queries, fetch issue details, and keep your backlog in sync.",
    keyFeatures: [
      {
        title: "Search with JQL",
        description:
          "Run JQL queries to find issues by status, assignee, project, or custom fields.",
      },
      {
        title: "Create and update issues",
        description: "Create new issues, add comments, transition status, and update fields.",
      },
      {
        title: "List projects and sprints",
        description: "Browse projects, boards, and sprint backlogs for planning and reporting.",
      },
    ],
    examples: [
      {
        prompt: "Find all open bugs assigned to me",
        resultLabel: "JQL search results",
      },
      {
        prompt: "Create a story for the login redesign",
        resultLabel: "Created Jira issue",
      },
    ],
  },
  linear: {
    tagline: "Project and issue tracking with Linear's GraphQL API",
    longDescription:
      "Connect Linear to manage issues, cycles, and projects. Create issues, update status, and query your roadmap with natural language.",
    keyFeatures: [
      {
        title: "Search and list issues",
        description: "Find issues by title, status, assignee, or project with flexible queries.",
      },
      {
        title: "Create and update issues",
        description: "Add new issues, set labels, assignees, and update workflow state.",
      },
      {
        title: "Manage cycles and projects",
        description: "List cycles, projects, and teams for sprint planning and reporting.",
      },
    ],
    examples: [
      {
        prompt: "What issues are in the current cycle?",
        resultLabel: "Cycle issues list",
      },
      {
        prompt: "Create a bug for the mobile crash on startup",
        resultLabel: "Created Linear issue",
      },
    ],
  },
  miro: {
    tagline: "Access and create new content on Miro boards",
    longDescription:
      "Connect Miro to create and manage boards, add shapes and sticky notes, and collaborate on visual content. The agent can generate diagrams from code or text and pull content from boards for context.",
    keyFeatures: [
      {
        title: "Create and manage boards",
        description: "Create new boards, add elements, and organize content programmatically.",
      },
      {
        title: "Generate diagrams",
        description: "Turn code, text, or GitHub URLs into Miro diagrams.",
      },
      {
        title: "Extract board content",
        description: "Pull PRDs, diagrams, and images from boards for AI context.",
      },
    ],
    examples: [
      {
        prompt: "Create a flowchart for this process",
        resultLabel: "Miro board with diagram",
      },
      {
        prompt: "Add sticky notes from these action items",
        resultLabel: "Board updated with notes",
      },
    ],
  },
  supabase: {
    tagline: "Manage databases, authentication, and storage",
    longDescription:
      "Connect Supabase to run SQL queries, manage auth users, and work with storage buckets. The agent can query your database, create tables, and handle authentication flows.",
    keyFeatures: [
      {
        title: "SQL queries",
        description: "Execute read and write queries against your Supabase database.",
      },
      {
        title: "Auth management",
        description: "Manage users, sessions, and authentication settings.",
      },
      {
        title: "Storage",
        description: "List and manage storage buckets and files.",
      },
    ],
    examples: [
      {
        prompt: "List all users in the auth schema",
        resultLabel: "User list",
      },
      {
        prompt: "Run a query to find orders from last week",
        resultLabel: "Query results",
      },
    ],
  },
  excalidraw: {
    tagline: "Create interactive hand-drawn diagrams in Excalidraw",
    longDescription:
      "The Excalidraw MCP server lets you create and manipulate diagrams programmatically. Add shapes, text, and elements; organize with groups and alignment; and sync with an Excalidraw frontend.",
    keyFeatures: [
      {
        title: "Element control",
        description: "Create, update, delete, and query diagram elements.",
      },
      {
        title: "Organization",
        description: "Group, align, distribute, and lock elements.",
      },
      {
        title: "Real-time sync",
        description: "Optional WebSocket sync with an Excalidraw canvas.",
      },
    ],
    examples: [
      {
        prompt: "Create a simple architecture diagram",
        resultLabel: "Excalidraw scene",
      },
      {
        prompt: "Add a flowchart for this workflow",
        resultLabel: "Diagram with shapes",
      },
    ],
  },
  stripe: {
    tagline: "Payment processing and financial infrastructure tools",
    longDescription:
      "Connect Stripe to manage customers, create payments, list products, and work with subscriptions. The agent can query your Stripe data and perform common payment operations.",
    keyFeatures: [
      {
        title: "Customer management",
        description: "List and manage Stripe customers.",
      },
      {
        title: "Payments",
        description: "Create payments and handle checkout flows.",
      },
      {
        title: "Products and prices",
        description: "List products, prices, and subscriptions.",
      },
    ],
    examples: [
      {
        prompt: "List my Stripe customers from the last 30 days",
        resultLabel: "Customer list",
      },
      {
        prompt: "What products do I have in Stripe?",
        resultLabel: "Product catalog",
      },
    ],
  },
  ahrefs: {
    tagline: "SEO & AI search analytics",
    longDescription:
      "Connect Ahrefs to search SEO data, get site metrics, and analyze backlinks. The agent can query Ahrefs for keyword research, competitor analysis, and content optimization insights.",
    keyFeatures: [
      {
        title: "SEO search",
        description: "Search for keywords, backlinks, and site metrics.",
      },
      {
        title: "Site analysis",
        description: "Get domain authority, traffic estimates, and link profiles.",
      },
      {
        title: "Content insights",
        description: "Analyze top-performing content and opportunities.",
      },
    ],
    examples: [
      {
        prompt: "What are the top keywords for this domain?",
        resultLabel: "Keyword metrics",
      },
      {
        prompt: "Analyze backlinks for example.com",
        resultLabel: "Backlink report",
      },
    ],
  },
  "mermaid-chart": {
    tagline: "Validates Mermaid syntax, renders diagrams as high-quality SVG",
    longDescription:
      "The Mermaid Chart MCP server validates Mermaid diagram syntax and renders diagrams as high-quality SVG. Create flowcharts, sequence diagrams, and more from natural language.",
    keyFeatures: [
      {
        title: "Syntax validation",
        description: "Validate Mermaid diagram syntax before rendering.",
      },
      {
        title: "SVG export",
        description: "Render diagrams as high-quality SVG images.",
      },
      {
        title: "Theme support",
        description: "Configure themes and colors for diagrams.",
      },
    ],
    examples: [
      {
        prompt: "Create a flowchart for this process",
        resultLabel: "Rendered diagram",
      },
      {
        prompt: "Validate this Mermaid syntax",
        resultLabel: "Validation result",
      },
    ],
  },
  cloudflare: {
    tagline: "Build applications with compute, storage, and AI",
    longDescription:
      "Connect Cloudflare to manage Workers, KV, R2, D1, and more. Deploy Workers, query databases, manage storage, and run AI inference. Requires wrangler login.",
    keyFeatures: [
      {
        title: "Workers & Durable Objects",
        description: "Deploy and manage Workers and Durable Objects.",
      },
      {
        title: "KV, R2, D1",
        description: "Manage key-value storage, object storage, and SQLite databases.",
      },
      {
        title: "Workers AI",
        description: "Run inference with Cloudflare's AI models.",
      },
    ],
    examples: [
      {
        prompt: "List my KV namespaces",
        resultLabel: "KV namespace list",
      },
      {
        prompt: "Deploy a new Worker",
        resultLabel: "Deployment status",
      },
    ],
  },
  make: {
    tagline: "Run Make scenarios and manage your Make account",
    longDescription:
      "Connect Make.com to search 200+ automation modules, validate scenario blueprints, and deploy scenarios. Build integrations with Slack, Gmail, Notion, and 40+ apps.",
    keyFeatures: [
      {
        title: "Module search",
        description: "Search across 200+ Make.com modules.",
      },
      {
        title: "Blueprint validation",
        description: "Validate scenarios before deployment.",
      },
      {
        title: "One-click deploy",
        description: "Deploy validated scenarios to Make.com.",
      },
    ],
    examples: [
      {
        prompt: "Create a scenario that watches Slack and logs to Google Sheets",
        resultLabel: "Deployed scenario",
      },
      {
        prompt: "What modules does Make have for sending emails?",
        resultLabel: "Module list",
      },
    ],
  },
  "clinical-trials": {
    tagline: "Access ClinicalTrials.gov data",
    longDescription:
      "Search clinical trials, retrieve study details, compare studies, and match patients to eligible trials. Uses the ClinicalTrials.gov v2 API.",
    keyFeatures: [
      {
        title: "Search studies",
        description: "Search with filters, pagination, and geographic proximity.",
      },
      {
        title: "Study comparison",
        description: "Compare 2-5 studies side-by-side.",
      },
      {
        title: "Patient matching",
        description: "Match patient profiles to eligible trials.",
      },
    ],
    examples: [
      {
        prompt: "Search for diabetes trials in phase 3",
        resultLabel: "Study list",
      },
      {
        prompt: "Find trials matching this patient profile",
        resultLabel: "Eligible studies",
      },
    ],
  },
  netlify: {
    tagline: "Create, deploy, manage, and secure websites on Netlify",
    longDescription:
      "Connect Netlify to create projects, deploy sites, manage environment variables, and configure builds. The agent can use the Netlify API and CLI to manage your Jamstack deployments.",
    keyFeatures: [
      {
        title: "Site management",
        description: "Create, deploy, and manage Netlify sites and projects.",
      },
      {
        title: "Environment & secrets",
        description: "Manage environment variables and secrets for your deployments.",
      },
      {
        title: "Extensions & forms",
        description: "Install extensions and manage form submissions.",
      },
    ],
    examples: [
      {
        prompt: "Deploy my project to Netlify",
        resultLabel: "Deployment status",
      },
      {
        prompt: "List my Netlify sites",
        resultLabel: "Site list",
      },
    ],
  },
  airtable: {
    tagline: "Bring your structured data to Claude",
    longDescription:
      "Connect Airtable to list bases and tables, read and write records, search data, and manage your structured databases. The agent can inspect schemas and perform CRUD operations.",
    keyFeatures: [
      {
        title: "Base & table access",
        description: "List bases, tables, and inspect schemas.",
      },
      {
        title: "Record operations",
        description: "List, search, create, update, and delete records.",
      },
      {
        title: "Schema management",
        description: "Create tables and fields, manage structure.",
      },
    ],
    examples: [
      {
        prompt: "List records from my Projects table",
        resultLabel: "Record list",
      },
      {
        prompt: "Add a new task to my Airtable base",
        resultLabel: "Created record",
      },
    ],
  },
  square: {
    tagline: "Search and manage transaction, merchant, and payment data",
    longDescription:
      "Connect Square to access the full Connect API—manage payments, orders, customers, catalog, inventory, and more. The agent can discover API methods and execute operations.",
    keyFeatures: [
      {
        title: "Payments & orders",
        description: "Process payments, manage orders, and handle refunds.",
      },
      {
        title: "Catalog & inventory",
        description: "Manage products, categories, and inventory.",
      },
      {
        title: "Customer management",
        description: "Manage customers, segments, and loyalty programs.",
      },
    ],
    examples: [
      {
        prompt: "List my Square locations",
        resultLabel: "Location list",
      },
      {
        prompt: "Show recent transactions",
        resultLabel: "Transaction list",
      },
    ],
  },
  attio: {
    tagline: "Search, manage, and update your Attio CRM from Claude",
    longDescription:
      "Connect Attio to read company records, manage notes, and update your AI-native CRM. The agent can search and interact with your Attio data.",
    keyFeatures: [
      {
        title: "Company records",
        description: "List and retrieve company information.",
      },
      {
        title: "Notes",
        description: "Read and write company notes.",
      },
      {
        title: "CRM updates",
        description: "Keep your Attio CRM in sync from conversations.",
      },
    ],
    examples: [
      {
        prompt: "List companies in my Attio CRM",
        resultLabel: "Company list",
      },
      {
        prompt: "Add a note to Acme Corp",
        resultLabel: "Note created",
      },
    ],
  },
  calcom: {
    tagline: "Manage event types, availability, and bookings",
    longDescription:
      "Connect Cal.com to manage event types, create and reschedule bookings, and control availability. The agent can handle scheduling workflows through natural language.",
    keyFeatures: [
      {
        title: "Booking management",
        description: "Create, reschedule, and cancel bookings.",
      },
      {
        title: "Event types",
        description: "List, update, and manage event types.",
      },
      {
        title: "Availability",
        description: "View and manage scheduling availability.",
      },
    ],
    examples: [
      {
        prompt: "List my Cal.com event types",
        resultLabel: "Event types",
      },
      {
        prompt: "Create a 30-minute meeting for next Tuesday",
        resultLabel: "Booking created",
      },
    ],
  },
  cloudinary: {
    tagline: "Manage, transform and deliver your images & videos",
    longDescription:
      "Connect Cloudinary to upload assets, search your media library, and manage images and videos. The agent can upload, find, and transform assets in your Cloudinary cloud.",
    keyFeatures: [
      {
        title: "Upload & manage",
        description: "Upload assets and manage your media library.",
      },
      {
        title: "Search",
        description: "Find assets by tags, folder, or expression.",
      },
      {
        title: "Usage reports",
        description: "Get storage and bandwidth usage reports.",
      },
    ],
    examples: [
      {
        prompt: "Upload this image to Cloudinary",
        resultLabel: "Asset uploaded",
      },
      {
        prompt: "Find all images tagged 'product'",
        resultLabel: "Asset list",
      },
    ],
  },
  honeycomb: {
    tagline: "Query and explore observability data and SLOs",
    longDescription:
      "Connect Honeycomb to list datasets, create and run queries, manage boards, and explore observability data. The agent can help investigate incidents and analyze traces.",
    keyFeatures: [
      {
        title: "Dataset & query management",
        description: "List datasets, create queries, and run analyses.",
      },
      {
        title: "Boards & SLOs",
        description: "Manage boards and service level objectives.",
      },
      {
        title: "Incident investigation",
        description: "Query traces and explore observability data.",
      },
    ],
    examples: [
      {
        prompt: "List my Honeycomb datasets",
        resultLabel: "Dataset list",
      },
      {
        prompt: "Run a query for error rates in the last hour",
        resultLabel: "Query results",
      },
    ],
  },
  paypal: {
    tagline: "Access PayPal payments platform",
    longDescription:
      "Connect PayPal to manage invoices, create orders, process payments, handle disputes, and manage your catalog. The agent can interact with PayPal APIs for payments and subscriptions.",
    keyFeatures: [
      {
        title: "Invoices & orders",
        description: "Create and manage invoices, orders, and payments.",
      },
      {
        title: "Catalog management",
        description: "Create and list products in your PayPal catalog.",
      },
      {
        title: "Disputes & tracking",
        description: "Manage disputes and shipment tracking.",
      },
    ],
    examples: [
      {
        prompt: "List my PayPal invoices",
        resultLabel: "Invoice list",
      },
      {
        prompt: "Create an order for $50",
        resultLabel: "Order created",
      },
    ],
  },
  smartsheet: {
    tagline: "Analyze and manage Smartsheet data with Claude",
    longDescription:
      "Connect Smartsheet to get sheet details, create and update rows, and manage your spreadsheets. The agent can query and modify Smartsheet data programmatically.",
    keyFeatures: [
      {
        title: "Sheet operations",
        description: "Get sheet details, create sheets, and manage structure.",
      },
      {
        title: "Row management",
        description: "Create, update, and delete rows.",
      },
      {
        title: "Version backups",
        description: "Create version backups at specific timestamps.",
      },
    ],
    examples: [
      {
        prompt: "List rows from my project tracker",
        resultLabel: "Sheet data",
      },
      {
        prompt: "Add a new task to the sprint sheet",
        resultLabel: "Created row",
      },
    ],
  },
  huggingface: {
    tagline: "Access the Hugging Face Hub and thousands of Gradio Apps",
    longDescription:
      "Connect Hugging Face to list models, run inference, and interact with Gradio apps. The agent can search the Hub, run models, and use AI applications.",
    keyFeatures: [
      {
        title: "Model Hub",
        description: "List and search models on the Hugging Face Hub.",
      },
      {
        title: "Inference",
        description: "Run model inference for text, images, and more.",
      },
      {
        title: "Gradio apps",
        description: "Discover and use Gradio AI applications.",
      },
    ],
    examples: [
      {
        prompt: "List popular text generation models",
        resultLabel: "Model list",
      },
      {
        prompt: "Run sentiment analysis on this text",
        resultLabel: "Inference result",
      },
    ],
  },
  hubspot: {
    tagline: "CRM objects for contacts, companies, and deals",
    longDescription:
      "Connect HubSpot to search contacts, update CRM records, and manage deals. The agent can enrich contact data, create companies, and sync pipeline updates.",
    keyFeatures: [
      {
        title: "Search CRM objects",
        description: "Find contacts, companies, and deals by name, email, or custom properties.",
      },
      {
        title: "Create and update records",
        description: "Add contacts, create companies, update deal stages, and log activities.",
      },
      {
        title: "Object metadata",
        description: "Describe object schemas and properties for accurate data mapping.",
      },
    ],
    examples: [
      {
        prompt: "Find the contact for john@acme.com",
        resultLabel: "Contact record",
      },
      {
        prompt: "Create a new deal for Acme Corp",
        resultLabel: "Created deal",
      },
    ],
  },
  tavily: {
    tagline: "Connect your AI agents to the web",
    longDescription:
      "Tavily provides real-time web search, data extraction, website mapping, and crawling. The agent can search the web, extract structured data from pages, and explore site structure.",
    keyFeatures: [
      {
        title: "Real-time web search",
        description: "Search the web with AI-optimized results and relevance ranking.",
      },
      {
        title: "Data extraction",
        description: "Extract structured data from web pages for analysis and summarization.",
      },
      {
        title: "Website mapping",
        description: "Create structured maps of website content and hierarchy.",
      },
    ],
    examples: [
      {
        prompt: "Search for the latest news on AI regulations",
        resultLabel: "Search results",
      },
      {
        prompt: "Extract the main points from this article URL",
        resultLabel: "Extracted content",
      },
    ],
  },
  tldraw: {
    tagline: "Let Claude sketch, draw, and diagram with you",
    longDescription:
      "Manage local tldraw canvas files (.tldr) from CoWork. The agent can read, write, search, and create diagrams that sync with tldraw desktop or VS Code.",
    keyFeatures: [
      {
        title: "Read and write canvases",
        description: "Load, create, and update .tldr files with validation.",
      },
      {
        title: "Search across canvases",
        description: "Full-text search across all your tldraw files.",
      },
      {
        title: "Shape operations",
        description: "Add, update, and delete shapes programmatically.",
      },
    ],
    examples: [
      {
        prompt: "Create a flowchart for our deployment process",
        resultLabel: "New .tldr canvas",
      },
      {
        prompt: "Search my tldraw files for 'architecture'",
        resultLabel: "Matching canvases",
      },
    ],
  },
  amplitude: {
    tagline: "Search, access, and get insights on your Amplitude data",
    longDescription:
      "Track events, page views, signups, user properties, and revenue in Amplitude. The agent can send analytics events and manage user profiles.",
    keyFeatures: [
      {
        title: "Event tracking",
        description: "Track custom events, page views, and signups.",
      },
      {
        title: "User properties",
        description: "Create and update user profiles with properties.",
      },
      {
        title: "Revenue tracking",
        description: "Track purchases and revenue events.",
      },
    ],
    examples: [
      {
        prompt: "Track a signup event for user123",
        resultLabel: "Event tracked",
      },
      {
        prompt: "Update user profile with plan and company",
        resultLabel: "Profile updated",
      },
    ],
  },
  clerk: {
    tagline: "Add authentication, organizations, and billing",
    longDescription:
      "Manage users, sessions, invitations, and organizations with Clerk. The agent can create users, ban users, list users, and manage invitations.",
    keyFeatures: [
      {
        title: "User management",
        description: "Create, get, list, and ban users.",
      },
      {
        title: "Invitations",
        description: "Create and revoke invitations.",
      },
      {
        title: "Sessions",
        description: "Get session details and manage access.",
      },
    ],
    examples: [
      {
        prompt: "Create a new user with email john@example.com",
        resultLabel: "User created",
      },
      {
        prompt: "List all users in my Clerk project",
        resultLabel: "User list",
      },
    ],
  },
  mem: {
    tagline: "The AI notebook for everything on your mind",
    longDescription:
      "Save notes, create collections, and search your mem.ai knowledge base. The agent can remember content, create notes, and search across your mems.",
    keyFeatures: [
      {
        title: "Mem it",
        description: "Intelligently remember any content with context.",
      },
      {
        title: "Notes & collections",
        description: "Create notes, organize in collections, and search.",
      },
      {
        title: "Full API coverage",
        description: "All mem.ai API endpoints available as tools.",
      },
    ],
    examples: [
      {
        prompt: "Remember that we're meeting with Acme Corp next Tuesday",
        resultLabel: "Saved to mem",
      },
      {
        prompt: "Search my mems for project ideas",
        resultLabel: "Matching notes",
      },
    ],
  },
  grafana: {
    tagline: "Access Grafana dashboards, datasources, alerting, and more",
    longDescription:
      "Connect to your Grafana instance to list dashboards, query datasources, manage alerts, and explore metrics. The agent can fetch dashboard data and run queries.",
    keyFeatures: [
      {
        title: "Dashboards",
        description: "List and retrieve Grafana dashboards and panels.",
      },
      {
        title: "Datasources",
        description: "Query Prometheus, InfluxDB, and other datasources.",
      },
      {
        title: "Alerting",
        description: "Manage alerts and incident workflows.",
      },
    ],
    examples: [
      {
        prompt: "List my Grafana dashboards",
        resultLabel: "Dashboard list",
      },
      {
        prompt: "Query the CPU usage metric from Prometheus",
        resultLabel: "Query results",
      },
    ],
  },
  mailtrap: {
    tagline: "Send emails and manage templates using Mailtrap",
    longDescription:
      "Send transactional emails, manage templates, and test in the sandbox. The agent can send emails, create templates, and retrieve sandbox messages.",
    keyFeatures: [
      {
        title: "Email sending",
        description: "Send transactional emails through Mailtrap.",
      },
      {
        title: "Template management",
        description: "Create, list, update, and delete email templates.",
      },
      {
        title: "Sandbox testing",
        description: "Send test emails and retrieve messages from the sandbox inbox.",
      },
    ],
    examples: [
      {
        prompt: "Send a welcome email to user@example.com",
        resultLabel: "Email sent",
      },
      {
        prompt: "List my Mailtrap email templates",
        resultLabel: "Template list",
      },
    ],
  },
  socket: {
    tagline: "MCP server for scanning dependencies",
    longDescription:
      "Check dependency security scores for npm, PyPI, Cargo, and more. Get supply chain, quality, maintenance, vulnerability, and license scores for packages.",
    keyFeatures: [
      {
        title: "Dependency scoring",
        description: "Query comprehensive security scores for packages.",
      },
      {
        title: "Batch processing",
        description: "Check multiple dependencies in a single request.",
      },
      {
        title: "Multi-ecosystem",
        description: "Supports npm, PyPI, Cargo, and other package ecosystems.",
      },
    ],
    examples: [
      {
        prompt: "Check the security score for express 4.18.2",
        resultLabel: "Security scores",
      },
      {
        prompt: "Analyze my package.json dependencies",
        resultLabel: "Dependency analysis",
      },
    ],
  },
  metabase: {
    tagline: "High-performance MCP server for Metabase analytics",
    longDescription:
      "Access Metabase dashboards, run queries, and manage analytics data. The agent can list dashboards, execute questions, and export results.",
    keyFeatures: [
      {
        title: "Dashboard access",
        description: "List and retrieve Metabase dashboards and cards.",
      },
      {
        title: "Query execution",
        description: "Execute Metabase questions and run native queries.",
      },
      {
        title: "Data export",
        description: "Export results in CSV, JSON, and XLSX formats.",
      },
    ],
    examples: [
      {
        prompt: "List my Metabase dashboards",
        resultLabel: "Dashboard list",
      },
      {
        prompt: "Run the sales by region question",
        resultLabel: "Query results",
      },
    ],
  },
  "shadcn-ui": {
    tagline: "MCP server for shadcn/ui components",
    longDescription:
      "Browse, search, and install shadcn/ui components. The agent can list available components, get details and examples, and help add components to your project.",
    keyFeatures: [
      {
        title: "Component discovery",
        description: "List and search 200+ shadcn/ui components.",
      },
      {
        title: "Details and examples",
        description: "Get component documentation and usage examples.",
      },
      {
        title: "Installation guidance",
        description: "Get instructions for adding components to your project.",
      },
    ],
    examples: [
      {
        prompt: "Add the button, dialog and card components to my project",
        resultLabel: "Component installation",
      },
      {
        prompt: "Search for form components",
        resultLabel: "Matching components",
      },
    ],
  },
  growthbook: {
    tagline: "Feature flags and A/B testing",
    longDescription:
      "Create and manage feature flags, run experiments, and manage SDK connections. The agent can create features, list experiments, and generate types.",
    keyFeatures: [
      {
        title: "Feature flags",
        description: "Create and manage feature flags and targeting rules.",
      },
      {
        title: "Experiments",
        description: "Review and fetch experiment details.",
      },
      {
        title: "SDK connections",
        description: "Set up and manage SDK connections.",
      },
    ],
    examples: [
      {
        prompt: "Create a feature flag for the new checkout flow",
        resultLabel: "Feature created",
      },
      {
        prompt: "List my active experiments",
        resultLabel: "Experiment list",
      },
    ],
  },
  drafts: {
    tagline: "MCP server for the Drafts app on macOS",
    longDescription:
      "Create, search, and manage drafts in the Drafts app. The agent can create drafts, search by text, list workspaces, and run Drafts actions. Requires macOS.",
    keyFeatures: [
      {
        title: "Draft management",
        description: "Create, read, update, and search drafts.",
      },
      {
        title: "Workspaces",
        description: "List and query drafts from specific workspaces.",
      },
      {
        title: "Actions",
        description: "Run Drafts actions programmatically.",
      },
    ],
    examples: [
      {
        prompt: "Create a draft with my meeting notes",
        resultLabel: "Draft created",
      },
      {
        prompt: "Search my drafts for 'project roadmap'",
        resultLabel: "Matching drafts",
      },
    ],
  },
  fantastical: {
    tagline: "Read events and tasks, create new items from Fantastical",
    longDescription:
      "Create events using natural language, view your schedule, and manage your Fantastical calendar. The agent can create events, show today's schedule, and search events. Requires macOS.",
    keyFeatures: [
      {
        title: "Natural language events",
        description: "Create events using plain language like 'Meeting tomorrow at 2pm'.",
      },
      {
        title: "Schedule viewing",
        description: "View today's events and upcoming appointments.",
      },
      {
        title: "Calendar management",
        description: "List calendars, search events, and navigate to dates.",
      },
    ],
    examples: [
      {
        prompt: "Schedule a meeting with the team tomorrow at 2pm",
        resultLabel: "Event created",
      },
      {
        prompt: "What's on my calendar today?",
        resultLabel: "Today's events",
      },
    ],
  },
  tomba: {
    tagline: "MCP server for Tomba email finder and verification API",
    longDescription:
      "Find emails from names and domains, verify deliverability, enrich contacts, and search companies. The agent can run lead generation and email verification workflows.",
    keyFeatures: [
      {
        title: "Email finder",
        description: "Generate likely emails from names and domains.",
      },
      {
        title: "Email verification",
        description: "Verify email deliverability and check database presence.",
      },
      {
        title: "Domain search",
        description: "Find all emails associated with a domain.",
      },
    ],
    examples: [
      {
        prompt: "Find the email for John Smith at acme.com",
        resultLabel: "Email found",
      },
      {
        prompt: "Verify these email addresses",
        resultLabel: "Verification results",
      },
    ],
  },
};

export function getConnectorProfile(connectorId: string): ConnectorProfile | undefined {
  const key = String(connectorId || "")
    .trim()
    .toLowerCase();
  return CONNECTOR_PROFILES[key];
}
