import { useState, type CSSProperties } from "react";

const CONNECTOR_ICON_DOMAINS: Record<string, string> = {
  agentmail: "agentmail.to",
  ahrefs: "ahrefs.com",
  aiera: "aiera.com",
  airtable: "airtable.com",
  amplitude: "amplitude.com",
  asana: "asana.com",
  attio: "attio.com",
  box: "box.com",
  calcom: "cal.com",
  chronograph: "chronograph.pe",
  clerk: "clerk.com",
  "clinical-trials": "clinicaltrials.gov",
  cloudflare: "cloudflare.com",
  cloudinary: "cloudinary.com",
  daloopa: "daloopa.com",
  discord: "discord.com",
  drafts: "getdrafts.com",
  dropbox: "dropbox.com",
  egnyte: "egnyte.com",
  excalidraw: "excalidraw.com",
  factset: "factset.com",
  fantastical: "flexibits.com",
  figma: "figma.com",
  gmail: "gmail.com",
  googleworkspace: "gmail.com",
  "google-workspace": "workspace.google.com",
  grafana: "grafana.com",
  "home-assistant": "home-assistant.io",
  growthbook: "growthbook.io",
  honeycomb: "honeycomb.io",
  hubspot: "hubspot.com",
  huggingface: "huggingface.co",
  jira: "atlassian.com",
  linear: "linear.app",
  lseg: "lseg.com",
  mailtrap: "mailtrap.io",
  make: "make.com",
  maps: "google.com",
  mem: "mem.ai",
  mermaid: "mermaidchart.com",
  "mermaid-chart": "mermaidchart.com",
  metabase: "metabase.com",
  miro: "miro.com",
  monday: "monday.com",
  moodys: "moodys.com",
  morningstar: "morningstar.com",
  mtnewswires: "mtnewswires.com",
  netlify: "netlify.com",
  notion: "notion.so",
  okta: "okta.com",
  onedrive: "onedrive.live.com",
  "teams-meetings": "teams.microsoft.com",
  paypal: "paypal.com",
  pitchbook: "pitchbook.com",
  resend: "resend.com",
  salesforce: "salesforce.com",
  servicenow: "servicenow.com",
  shadcn: "ui.shadcn.com",
  "shadcn-ui": "ui.shadcn.com",
  sharepoint: "sharepoint.com",
  smartsheet: "smartsheet.com",
  socket: "socket.dev",
  spglobal: "spglobal.com",
  square: "squareup.com",
  stripe: "stripe.com",
  supabase: "supabase.com",
  tavily: "tavily.com",
  tldraw: "tldraw.com",
  tomba: "tomba.io",
  vercel: "vercel.com",
  zendesk: "zendesk.com",
};

export function getConnectorColor(name: string): string {
  const colors = [
    "#4f46e5",
    "#0891b2",
    "#059669",
    "#d97706",
    "#dc2626",
    "#7c3aed",
    "#db2777",
    "#65a30d",
    "#ea580c",
    "#0284c7",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) & 0xffffffff;
  }
  return colors[Math.abs(hash) % colors.length];
}

export function getConnectorIconUrl(connectorKey: string): string | null {
  const domain = CONNECTOR_ICON_DOMAINS[connectorKey];
  if (!domain) return null;
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}

export function ConnectorBrandIcon({
  connectorKey,
  name,
  className,
}: {
  connectorKey: string;
  name: string;
  className?: string;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const iconUrl = imageFailed ? null : getConnectorIconUrl(connectorKey);
  const connectorColor = getConnectorColor(name);

  return (
    <div
      className={`${className ? `${className} ` : ""}cm-brand-icon${
        iconUrl ? " cm-brand-icon--image" : " cm-brand-icon--fallback"
      }`}
      style={{ "--connector-color": connectorColor } as CSSProperties}
    >
      {iconUrl ? (
        <img
          src={iconUrl}
          alt=""
          aria-hidden="true"
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setImageFailed(true)}
        />
      ) : (
        name.charAt(0).toUpperCase()
      )}
    </div>
  );
}
