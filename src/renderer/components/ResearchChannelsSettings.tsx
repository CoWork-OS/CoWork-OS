import { useState, useEffect } from "react";

type AgentRoleOption = {
  id: string;
  name: string;
  displayName?: string;
};

interface ResearchChannelsSettingsProps {
  channelId: string;
  channelConfig: Record<string, unknown>;
  onConfigChange: (config: Record<string, unknown>) => Promise<void>;
  channelType: "telegram" | "whatsapp";
}

export function ResearchChannelsSettings({
  channelId,
  channelConfig,
  onConfigChange,
  channelType,
}: ResearchChannelsSettingsProps) {
  const [expanded, setExpanded] = useState(false);
  const [researchChatIds, setResearchChatIds] = useState("");
  const [researchAgentRoleId, setResearchAgentRoleId] = useState("");
  const [agentRoles, setAgentRoles] = useState<AgentRoleOption[]>([]);
  const [saving, setSaving] = useState(false);

  const ids = (channelConfig.researchChatIds as string[] | undefined) ?? [];
  const roleId = (channelConfig.researchAgentRoleId as string | undefined) ?? "";

  useEffect(() => {
    setResearchChatIds(ids.join("\n"));
    setResearchAgentRoleId(roleId);
  }, [channelId, channelConfig.researchChatIds, channelConfig.researchAgentRoleId]);

  useEffect(() => {
    window.electronAPI
      .getAgentRoles?.(false)
      .then((roles) => setAgentRoles(roles ?? []))
      .catch(() => setAgentRoles([]));
  }, []);

  const handleSave = async () => {
    const parsed = researchChatIds
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      setSaving(true);
      await onConfigChange({
        ...channelConfig,
        researchChatIds: parsed,
        researchAgentRoleId: researchAgentRoleId.trim() || undefined,
      });
    } catch (error) {
      console.error("Failed to save research channels:", error);
    } finally {
      setSaving(false);
    }
  };

  const hasChanges = researchChatIds !== ids.join("\n") || researchAgentRoleId !== roleId;

  return (
    <div className="settings-section">
      <h4
        className="settings-collapsible-header"
        onClick={() => setExpanded(!expanded)}
        style={{ cursor: "pointer", userSelect: "none" }}
      >
        Research Channels
        <span className="collapsible-arrow">{expanded ? "▼" : "▶"}</span>
      </h4>
      {expanded && (
        <>
          <p className="settings-description">
            Chat IDs where messages are treated as link research. Post links to these chats and the
            agent will build a findings report with classification. Use{" "}
            <code>channel_list_chats</code> to discover chat IDs.
          </p>
          <div className="settings-field">
            <label>Research Chat IDs</label>
            <textarea
              className="settings-input"
              placeholder={
                channelType === "telegram"
                  ? "-1001234567890\n-1009876543210"
                  : "120363012345678@g.us"
              }
              value={researchChatIds}
              onChange={(e) => setResearchChatIds(e.target.value)}
              rows={4}
              style={{ fontFamily: "monospace", fontSize: "12px" }}
            />
            <p className="settings-hint">
              One chat ID per line or comma-separated. Telegram groups: negative numbers (e.g.{" "}
              <code>-1001234567890</code>). WhatsApp groups: JID format (e.g.{" "}
              <code>120363012345678@g.us</code>).
            </p>
          </div>
          <div className="settings-field">
            <label>Research Agent (optional)</label>
            <select
              className="settings-select"
              value={researchAgentRoleId}
              onChange={(e) => setResearchAgentRoleId(e.target.value)}
            >
              <option value="">Default agent</option>
              {agentRoles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.displayName || role.name}
                </option>
              ))}
            </select>
            <p className="settings-hint">
              Agent role for research tasks. Leave as default to use the channel default.
            </p>
          </div>
          {hasChanges && (
            <button className="button-primary" onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : "Save Research Settings"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
