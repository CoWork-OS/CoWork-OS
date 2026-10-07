import { useEffect, useState } from "react";
import type { AgentRoleData } from "../../electron/preload";
import { normalizeBotProfileText } from "../utils/bot-profile";
import { botMascotIcon, resolveBotMascot } from "../../shared/bot-mascots";
import { BotFormDialog, type BotFormValues } from "./BotFormDialog";

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
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        });
      } catch (cause) {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : "Could not load this bot.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [botId]);

  const save = async () => {
    if (!role || !values.displayName.trim()) {
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
        displayName: normalizeBotProfileText(values.displayName),
        description: normalizeBotProfileText(values.description),
        systemPrompt: normalizeBotProfileText(values.systemPrompt),
        icon: values.icon,
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
      busy={saving}
      error={error}
      onDelete={role && !role.isSystem ? () => void deleteBot() : undefined}
    />
  );
}
