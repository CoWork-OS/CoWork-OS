const ICON_META: Record<string, { glyph: string; bg: string; fg?: string }> = {
  gmail: { glyph: "M", bg: "#f2f4f7", fg: "#d93025" },
  "google-drive": { glyph: "D", bg: "#e8f0fe", fg: "#188038" },
  "google-calendar": { glyph: "31", bg: "#e8f0fe", fg: "#1a73e8" },
  "google-docs": { glyph: "D", bg: "#e8f0fe", fg: "#1a73e8" },
  "google-sheets": { glyph: "S", bg: "#e6f4ea", fg: "#188038" },
  "google-slides": { glyph: "P", bg: "#fef7e0", fg: "#f29900" },
  "google-chat": { glyph: "C", bg: "#e6f4ea", fg: "#188038" },
  slack: { glyph: "#", bg: "#f3e8ff", fg: "#611f69" },
  notion: { glyph: "N", bg: "#f4f4f5", fg: "#111827" },
  box: { glyph: "B", bg: "#e0f2fe", fg: "#0061d5" },
  onedrive: { glyph: "O", bg: "#e0f2fe", fg: "#0369a1" },
  sharepoint: { glyph: "S", bg: "#ccfbf1", fg: "#0078d4" },
  dropbox: { glyph: "D", bg: "#dbeafe", fg: "#0061ff" },
  agentmail: { glyph: "A", bg: "#ffedd5", fg: "#ea580c" },
  inbox: { glyph: "@", bg: "#ede9fe", fg: "#7c3aed" },
  discord: { glyph: "D", bg: "#eef2ff", fg: "#5865f2" },
  teams: { glyph: "T", bg: "#eef2ff", fg: "#6264a7" },
  telegram: { glyph: "T", bg: "#e0f2fe", fg: "#229ed9" },
  whatsapp: { glyph: "W", bg: "#dcfce7", fg: "#128c7e" },
  signal: { glyph: "S", bg: "#dbeafe", fg: "#3a76f0" },
  imessage: { glyph: "i", bg: "#dcfce7", fg: "#22c55e" },
  email: { glyph: "@", bg: "#f1f5f9", fg: "#475569" },
  mcp: { glyph: "M", bg: "#ede9fe", fg: "#6d28d9" },
};

function fallbackGlyph(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return "I";
  return trimmed.slice(0, 1).toUpperCase();
}

export function getIntegrationMentionIconMeta(iconKey: string | undefined, label: string) {
  const meta = (iconKey && ICON_META[iconKey]) || ICON_META.mcp;
  return {
    glyph: meta.glyph || fallbackGlyph(label),
    bg: meta.bg,
    fg: meta.fg || "#111827",
  };
}

export function IntegrationMentionIcon({
  iconKey,
  label,
  size = "sm",
}: {
  iconKey?: string;
  label: string;
  size?: "xs" | "sm";
}) {
  const meta = getIntegrationMentionIconMeta(iconKey, label);
  return (
    <span
      className={`integration-mention-icon integration-mention-icon-${size}`}
      style={{ backgroundColor: meta.bg, color: meta.fg }}
      aria-hidden="true"
    >
      {meta.glyph}
    </span>
  );
}
