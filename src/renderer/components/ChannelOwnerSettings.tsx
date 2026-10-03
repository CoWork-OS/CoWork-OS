import { useEffect, useState } from "react";
import type { ChannelData, ChannelUserData } from "../../shared/types";
import { gatewayOwnerIdHint, validateGatewayOwnerIds } from "../../shared/gateway-owner-ids";

interface ChannelOwnerSettingsProps {
  channel: Pick<ChannelData, "id" | "type" | "config">;
  /** Known channel users; each allowed one gets a "This is me" shortcut. */
  users?: ChannelUserData[];
  /** Called with the channel config after a successful save. */
  onSaved?: (config: NonNullable<ChannelData["config"]>) => void;
}

function storedOwnerIds(config: ChannelData["config"]): string[] {
  const value = config?.ownerUserIds;
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * "Your account IDs on this channel" (`ownerUserIds`, audit SEC-16). Only a direct message
 * from one of these accounts counts as you: it can teach CoWork facts about you and your
 * preferences. Messages from anyone else, and every group message, are kept as third-party
 * information.
 */
export function ChannelOwnerSettings({ channel, users = [], onSaved }: ChannelOwnerSettingsProps) {
  const saved = storedOwnerIds(channel.config);
  const savedText = saved.join("\n");
  const [text, setText] = useState(savedText);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(savedText);
    setError(null);
  }, [channel.id, savedText]);

  const save = async (ids: string[]) => {
    setSaving(true);
    setError(null);
    try {
      await window.electronAPI.updateGatewayChannel({
        id: channel.id,
        config: { ownerUserIds: ids },
      });
      setText(ids.join("\n"));
      onSaved?.({ ...channel.config, ownerUserIds: ids });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save account IDs.");
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    const result = validateGatewayOwnerIds(text);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await save(result.ids);
  };

  const markAsMe = async (channelUserId: string) => {
    if (saved.includes(channelUserId)) return;
    const result = validateGatewayOwnerIds([...saved, channelUserId]);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await save(result.ids);
  };

  const removeOwner = async (channelUserId: string) => {
    await save(saved.filter((id) => id !== channelUserId));
  };

  const knownUsers = users.filter(
    (user) => user.allowed && !user.channelUserId.startsWith("pending_"),
  );
  const hasChanges = text.trim() !== savedText.trim();

  return (
    <div className="settings-section">
      <h4>Your Account on This Channel</h4>
      <p className="settings-description">
        CoWork learns about you only from your own direct messages. Messages from other people, and
        all group messages, are kept as information about them, not about you. List your own account
        IDs here so your direct messages count as yours.
      </p>
      <div className="settings-field">
        <label htmlFor={`owner-ids-${channel.id}`}>Your account IDs on this channel</label>
        <textarea
          id={`owner-ids-${channel.id}`}
          className="settings-input"
          rows={2}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setError(null);
          }}
          placeholder="One ID per line"
        />
        <p className="settings-hint">{gatewayOwnerIdHint(channel.type)}</p>
        {error ? (
          <p className="settings-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      {hasChanges ? (
        <button className="button-primary" onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save Account IDs"}
        </button>
      ) : null}

      {knownUsers.length > 0 ? (
        <div className="users-list">
          {knownUsers.map((user) => {
            const isOwner = saved.includes(user.channelUserId);
            return (
              <div key={user.id} className="user-item">
                <div className="user-info">
                  <span className="user-name">{user.displayName}</span>
                  <span className="user-username">
                    <code>{user.channelUserId}</code>
                  </span>
                  {isOwner ? <span className="user-status allowed">You</span> : null}
                </div>
                <button
                  className="button-small button-secondary"
                  disabled={saving}
                  onClick={() =>
                    isOwner ? removeOwner(user.channelUserId) : markAsMe(user.channelUserId)
                  }
                >
                  {isOwner ? "Not me" : "This is me"}
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
