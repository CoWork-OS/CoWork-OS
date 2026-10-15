import { useEffect, useState } from "react";
import type { AgentRoleData } from "../../electron/preload";
import { normalizeBotDisplayName, normalizeBotProfileText } from "../utils/bot-profile";
import { botMascotIcon, resolveBotMascot } from "../../shared/bot-mascots";
import { normalizeBotWorksOn } from "../../shared/bot-computer";
import { BotFormDialog, type BotFormValues } from "./BotFormDialog";
import { AgentRoleEditorDialog } from "./AgentRoleEditorDialog";

export const BOT_PROFILE_UPDATED_EVENT = "cowork:bot-profile-updated";
export const BOT_PROFILE_DELETED_EVENT = "cowork:bot-profile-deleted";

export interface BotProfileDialogProps {
  botId: string;
  onClose: () => void;
  onSaved?: (role: AgentRoleData) => void | Promise<void>;
  onDeleted?: (botId: string) => void | Promise<void>;
}

export function BotProfileDialog({ botId, onClose, onSaved, onDeleted }: BotProfileDialogProps) {
  const [role, setRole] = useState<AgentRoleData | null>(null);
  const [values, setValues] = useState<BotFormValues>({
    displayName: "",
    description: "",
    systemPrompt: "",
    icon: "",
    worksOn: "auto",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  /** The agent's full settings replace this form until they are saved or closed. */
  const [moreSettings, setMoreSettings] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await window.electronAPI.getAgentRole(botId);
        if (cancelled) return;
        if (!loaded) throw new Error("Bot could not be found.");
        setRole(loaded);
        setValues({
          displayName: loaded.displayName || "",
          description: loaded.description || "",
          systemPrompt: loaded.systemPrompt || "",
          // Edit the character the bot is drawn as, so saving keeps what it shows.
          icon: botMascotIcon(resolveBotMascot(loaded.icon)),
          worksOn: normalizeBotWorksOn(loaded.worksOn),
        });
      } catch (cause) {
        if (!cancelled) {
          setLoadFailed(true);
          setError(cause instanceof Error ? cause.message : "Could not load this bot.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [botId]);

  const save = async () => {
    if (!role) return;
    const displayName = normalizeBotDisplayName(values.displayName);
    if (!displayName) {
      setError("Enter a name for this bot.");
      return;
    }
    if (!window.electronAPI?.updateAgentRole) {
      setError("Bot editing is unavailable in this session.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await window.electronAPI.updateAgentRole({
        id: role.id,
        displayName,
        description: normalizeBotProfileText(values.description),
        systemPrompt: normalizeBotProfileText(values.systemPrompt),
        icon: values.icon,
        worksOn: values.worksOn,
      });
      if (!updated) throw new Error("Could not save this bot.");
      await onSaved?.(updated);
      window.dispatchEvent(new CustomEvent(BOT_PROFILE_UPDATED_EVENT, { detail: updated }));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this bot.");
    } finally {
      setSaving(false);
    }
  };

  const deleteBot = async () => {
    if (!role || role.isSystem || saving) return;
    if (!window.electronAPI?.deleteAgentRole) {
      setError("Bot deletion is unavailable in this session.");
      return;
    }
    if (
      !window.confirm(
        `Delete ${values.displayName.trim() || "this bot"}? Existing conversations and history will be kept.`,
      )
    ) {
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const deleted = await window.electronAPI.deleteAgentRole(role.id);
      if (!deleted) throw new Error("Could not delete this bot.");
      await onDeleted?.(role.id);
      window.dispatchEvent(new CustomEvent(BOT_PROFILE_DELETED_EVENT, { detail: role.id }));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete this bot.");
    } finally {
      setSaving(false);
    }
  };

  if (moreSettings) {
    return (
      <AgentRoleEditorDialog
        roleId={botId}
        onClose={onClose}
        onSaved={async (updated) => {
          await onSaved?.(updated);
          window.dispatchEvent(new CustomEvent(BOT_PROFILE_UPDATED_EVENT, { detail: updated }));
        }}
      />
    );
  }

  return (
    <BotFormDialog
      title="Edit bot"
      subtitle="Changes apply from its next run."
      values={values}
      onChange={setValues}
      onSubmit={() => void save()}
      onClose={onClose}
      submitLabel="Save"
      busyLabel="Saving…"
      loading={loading}
      unavailable={loadFailed}
      busy={saving}
      error={error}
      onDelete={role && !role.isSystem ? () => void deleteBot() : undefined}
      onMoreSettings={() => setMoreSettings(true)}
    />
  );
}
