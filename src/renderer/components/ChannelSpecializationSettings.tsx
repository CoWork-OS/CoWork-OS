import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentRoleData } from "../../electron/preload";
import type { ChannelSpecialization, Workspace } from "../../shared/types";

const DEFAULT_TOOL_RESTRICTIONS = [
  "group:memory",
  "group:system",
  "group:network",
  "group:destructive",
];

interface ChannelSpecializationSettingsProps {
  channelId: string;
}

type ChatOption = { chatId: string; lastTimestamp: number };
type AgentRole = AgentRoleData;

function formatChatLabel(chat: ChatOption): string {
  const date = chat.lastTimestamp ? new Date(chat.lastTimestamp).toLocaleString() : "";
  return date ? `${chat.chatId} - ${date}` : chat.chatId;
}

function scopeKey(chatId?: string, threadId?: string): string {
  return `${chatId || ""}::${threadId || ""}`;
}

export function ChannelSpecializationSettings({ channelId }: ChannelSpecializationSettingsProps) {
  const [specializations, setSpecializations] = useState<ChannelSpecialization[]>([]);
  const [chats, setChats] = useState<ChatOption[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [agentRoles, setAgentRoles] = useState<AgentRole[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [chatId, setChatId] = useState("");
  const [threadId, setThreadId] = useState("");
  const [name, setName] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [agentRoleId, setAgentRoleId] = useState("");
  const [systemGuidance, setSystemGuidance] = useState("");
  const [toolRestrictions, setToolRestrictions] = useState<string[]>([]);
  const [allowSharedContextMemory, setAllowSharedContextMemory] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The editor stays collapsed until the user creates or picks a specialization.
  const [formOpen, setFormOpen] = useState(false);

  const selected = useMemo(
    () => specializations.find((item) => item.id === selectedId) || null,
    [selectedId, specializations],
  );

  const load = useCallback(async () => {
    const [nextSpecializations, nextChats, nextWorkspaces, nextRoles] = await Promise.all([
      window.electronAPI.listChannelSpecializations(channelId),
      window.electronAPI.getGatewayChats(channelId),
      window.electronAPI.listWorkspaces(),
      window.electronAPI.getAgentRoles(true),
    ]);
    setSpecializations(nextSpecializations);
    setChats(nextChats);
    setWorkspaces(nextWorkspaces);
    setAgentRoles(nextRoles.filter((role: AgentRole) => role.isActive !== false));
  }, [channelId]);

  useEffect(() => {
    void load().catch((err) => {
      console.error("Failed to load channel specializations:", err);
      setError(err instanceof Error ? err.message : "Failed to load specializations");
    });
  }, [load]);

  useEffect(() => {
    if (!selected) return;
    setChatId(selected.chatId || "");
    setThreadId(selected.threadId || "");
    setName(selected.name || "");
    setWorkspaceId(selected.workspaceId || "");
    setAgentRoleId(selected.agentRoleId || "");
    setSystemGuidance(selected.systemGuidance || "");
    setToolRestrictions(selected.toolRestrictions || []);
    setAllowSharedContextMemory(selected.allowSharedContextMemory);
    setEnabled(selected.enabled);
  }, [selected]);

  const resetForm = () => {
    setSelectedId("");
    setChatId("");
    setThreadId("");
    setName("");
    setWorkspaceId("");
    setAgentRoleId("");
    setSystemGuidance("");
    setToolRestrictions([]);
    setAllowSharedContextMemory(false);
    setEnabled(true);
    setError(null);
    setFormOpen(false);
  };

  const toggleRestriction = (restriction: string) => {
    setToolRestrictions((current) =>
      current.includes(restriction)
        ? current.filter((item) => item !== restriction)
        : [...current, restriction],
    );
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);
      const payload = {
        chatId: chatId.trim() || undefined,
        threadId: threadId.trim() || undefined,
        name: name.trim() || undefined,
        workspaceId: workspaceId || undefined,
        agentRoleId: agentRoleId || undefined,
        systemGuidance: systemGuidance.trim() || undefined,
        toolRestrictions,
        allowSharedContextMemory,
        enabled,
      };
      if (selectedId) {
        await window.electronAPI.updateChannelSpecialization({
          id: selectedId,
          ...payload,
          chatId: payload.chatId ?? null,
          threadId: payload.threadId ?? null,
          name: payload.name ?? null,
          workspaceId: payload.workspaceId ?? null,
          agentRoleId: payload.agentRoleId ?? null,
          systemGuidance: payload.systemGuidance ?? null,
        });
      } else {
        await window.electronAPI.createChannelSpecialization({
          channelId,
          ...payload,
        });
      }
      await load();
      resetForm();
    } catch (err) {
      console.error("Failed to save channel specialization:", err);
      setError(err instanceof Error ? err.message : "Failed to save specialization");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedId) return;
    try {
      setSaving(true);
      setError(null);
      await window.electronAPI.deleteChannelSpecialization(selectedId);
      await load();
      resetForm();
    } catch (err) {
      console.error("Failed to delete channel specialization:", err);
      setError(err instanceof Error ? err.message : "Failed to delete specialization");
    } finally {
      setSaving(false);
    }
  };

  const targetScope = scopeKey(chatId.trim(), threadId.trim());
  const duplicateScope = specializations.some(
    (item) => item.id !== selectedId && scopeKey(item.chatId, item.threadId) === targetScope,
  );

  return (
    <div className="settings-section">
      <h4>Channel Specialization</h4>
      <p className="settings-description">
        Route a channel, group, or topic to a workspace and agent role with optional guidance.
      </p>

      {specializations.length > 0 && (
        <div className="settings-field">
          <label>Existing specialization</label>
          <select
            className="settings-select"
            value={selectedId}
            onChange={(event) => {
              setSelectedId(event.target.value);
              setFormOpen(Boolean(event.target.value));
            }}
          >
            <option value="">Choose a specialization to edit</option>
            {specializations.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name || item.threadId || item.chatId || "Channel default"}
                {!item.enabled ? " (disabled)" : ""}
              </option>
            ))}
          </select>
        </div>
      )}

      {formOpen ? (
        <>
          <div className="settings-field">
            <label>Chat or group</label>
            <select
              className="settings-select"
              value={chatId}
              onChange={(event) => setChatId(event.target.value)}
            >
              <option value="">Whole channel default</option>
              {chats.map((chat) => (
                <option key={chat.chatId} value={chat.chatId}>
                  {formatChatLabel(chat)}
                </option>
              ))}
            </select>
            <input
              className="settings-input"
              value={chatId}
              onChange={(event) => setChatId(event.target.value)}
              placeholder="Or paste chat/group ID"
            />
          </div>

          <div className="settings-field">
            <label>Topic/thread ID</label>
            <input
              className="settings-input"
              value={threadId}
              onChange={(event) => setThreadId(event.target.value)}
              placeholder="Optional topic/thread ID"
            />
          </div>

          <div className="settings-field">
            <label>Display name</label>
            <input
              className="settings-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Support group, research topic, etc."
            />
          </div>

          <div className="settings-field">
            <label>Workspace</label>
            <select
              className="settings-select"
              value={workspaceId}
              onChange={(event) => setWorkspaceId(event.target.value)}
            >
              <option value="">Channel default</option>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </div>

          <div className="settings-field">
            <label>Agent role</label>
            <select
              className="settings-select"
              value={agentRoleId}
              onChange={(event) => setAgentRoleId(event.target.value)}
            >
              <option value="">Channel default</option>
              {agentRoles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.displayName || role.name}
                </option>
              ))}
            </select>
          </div>

          <div className="settings-field">
            <label>Guidance</label>
            <textarea
              className="settings-textarea"
              value={systemGuidance}
              onChange={(event) => setSystemGuidance(event.target.value)}
              placeholder="Instructions added to new tasks from this scope"
              rows={4}
            />
          </div>

          <div className="settings-field">
            <label>Tool restrictions</label>
            <div className="checkbox-group">
              {DEFAULT_TOOL_RESTRICTIONS.map((restriction) => (
                <label key={restriction} className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={toolRestrictions.includes(restriction)}
                    onChange={() => toggleRestriction(restriction)}
                  />
                  {restriction}
                </label>
              ))}
            </div>
          </div>

          <label className="settings-checkbox">
            <input
              type="checkbox"
              checked={allowSharedContextMemory}
              onChange={(event) => setAllowSharedContextMemory(event.target.checked)}
            />
            Allow shared memory context for this group/topic
          </label>

          <label className="settings-checkbox">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            Enabled
          </label>

          {duplicateScope && (
            <p className="settings-hint warning">
              Saving will replace the existing specialization for this scope.
            </p>
          )}
          {error && <p className="settings-hint warning">{error}</p>}

          <div className="settings-actions">
            <button className="button-primary" onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : selectedId ? "Update Specialization" : "Save Specialization"}
            </button>
            {selectedId && (
              <button className="button-danger" onClick={handleDelete} disabled={saving}>
                Delete
              </button>
            )}
            <button className="button-secondary" onClick={resetForm} disabled={saving}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <button
          className="button-secondary button-small settings-collapsed-trigger"
          onClick={() => {
            resetForm();
            setFormOpen(true);
          }}
          aria-expanded={false}
        >
          New specialization
        </button>
      )}
    </div>
  );
}

export default ChannelSpecializationSettings;
