/** Native integration setup entry points shown in Connectors. */
export const NATIVE_INTEGRATIONS = [
  { key: "notion", name: "Notion", description: "Search and create content on your Notion pages." },
  {
    key: "sharepoint",
    name: "SharePoint",
    description: "Get in-depth answers from your SharePoint content.",
  },
  {
    key: "onedrive",
    name: "OneDrive",
    description: "Get in-depth answers from your OneDrive content.",
  },
  {
    key: "googleworkspace",
    name: "Gmail",
    description: "Connect Gmail for inbox search, thread reading, drafts, sending, and labels.",
  },
  {
    key: "agentmail",
    name: "AgentMail",
    description: "Native agent inboxes, pods, domains, scoped keys, and realtime email.",
  },
  { key: "box", name: "Box", description: "Get in-depth answers from your Box content." },
  { key: "dropbox", name: "Dropbox", description: "Search and access your Dropbox content." },
  {
    key: "teams-meetings",
    name: "Teams meeting transcripts",
    description: "Save transcripts of Teams meetings you organize as local notes.",
  },
] as const;

export type NativeIntegrationKey = (typeof NATIVE_INTEGRATIONS)[number]["key"];
