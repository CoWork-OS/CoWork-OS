import { useEffect, useState } from "react";
import type { AgentRoleData } from "../../electron/preload";
import { normalizeBotDisplayName, normalizeBotProfileText } from "../utils/bot-profile";
import { botMascotIcon, resolveBotMascot } from "../../shared/bot-mascots";
import { normalizeBotWorksOn } from "../../shared/bot-computer";
import { describeDesktopHostError } from "./BotFormDialog";
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

/** How many facts the bot saved in its own memory (0 when unknown or the folder is off). */
async function botMemoryEntryCount(botId: string): Promise<number> {
  try {
    const report = await window.electronAPI?.getBotMemory?.({ botId });
    if (!report?.available || !report.path) return 0;
    return report.entries.length + report.expired.length;
  } catch {
    return 0;
  }
}

export function BotProfileDialog({ botId, onClose, onSaved, onDeleted }: BotProfileDialogProps) {
  const [role, setRole] = useState<AgentRoleData | null>(null);
  const [values, setValues] = useState<BotFormValues>({
    displayName: "",
    description: "",
    systemPrompt: "",
    icon: "",
    providerType: "",
    modelKey: "",
    worksOn: "auto",
    desktopHost: "",
    desktopGroup: "",
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
          providerType: loaded.modelKey ? loaded.providerType || "" : "",
          modelKey: loaded.modelKey || "",
          worksOn: normalizeBotWorksOn(loaded.worksOn),
          desktopHost: loaded.desktopHost || "",
          desktopGroup: loaded.desktopGroup || "",
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
    const desktopHostError = describeDesktopHostError(values);
    if (desktopHostError) {
      setError(desktopHostError);
      return;
    }
    if (values.providerType && !values.modelKey) {
      setError("Choose a model, or switch back to the default model.");
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
        // "" clears both: the bot follows the default model again.
        providerType: values.modelKey ? values.providerType : "",
        modelKey: values.modelKey,
        worksOn: values.worksOn,
        desktopHost: values.worksOn === "own_desktop" ? values.desktopHost.trim() || null : null,
        desktopGroup:
          values.worksOn === "own_desktop"
            ? values.desktopGroup.trim().toLowerCase() || null
            : null,
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
    const name = values.displayName.trim() || "this bot";
    if (!window.confirm(`Delete ${name}? Existing conversations and history will be kept.`)) {
      return;
    }
    // Its own memory (a file in the memory folder) is kept unless the user drops it too.
    const savedFacts = await botMemoryEntryCount(role.id);
    const dropMemory =
      savedFacts > 0 &&
      window.confirm(
        `Also delete what ${name} remembers (${savedFacts} saved ${savedFacts === 1 ? "fact" : "facts"})? Cancel keeps it in your memory folder.`,
      );

    setSaving(true);
    setError(null);
    try {
      const deleted = await window.electronAPI.deleteAgentRole(role.id);
      if (!deleted) throw new Error("Could not delete this bot.");
      if (dropMemory) {
        const removed = await window.electronAPI.deleteBotMemory?.({ botId: role.id });
        if (removed && !removed.ok) {
          throw new Error(`The bot was deleted, but its memory was not: ${removed.error ?? ""}`);
        }
      }
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
