import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import {
  CALM_AGENT_AVATARS,
  CalmAgentAvatar,
  saveCalmAgentAvatar,
  useCalmAgentAvatar,
  type CalmAgentAvatarId,
} from "./CalmAgentAvatar";

const OPEN_EVENT = "cowork:open-calm-agent-setup";

const NAME_SUGGESTIONS = [
  "Nova",
  "Juniper",
  "Pixel",
  "Echo",
  "Atlas",
  "Sage",
  "Orbit",
  "Wren",
  "Ember",
  "Mosaic",
];

/** Opens the agent setup dialog from anywhere in the renderer. */
export function openCalmAgentSetup(): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

interface SetupDialogProps {
  onClose: () => void;
}

function SetupDialog({ onClose }: SetupDialogProps) {
  const storedAvatar = useCalmAgentAvatar();
  const [avatarId, setAvatarId] = useState<CalmAgentAvatarId>(storedAvatar);
  const [agentName, setAgentName] = useState("");
  const [userName, setUserName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await window.electronAPI.getPersonalitySettings();
        if (cancelled) return;
        setAgentName(
          settings.agentName && settings.agentName !== "CoWork" ? settings.agentName : "",
        );
        setUserName(settings.relationship?.userName || "");
      } catch {
        // Leave the fields empty; saving will still work.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const suggestName = () => {
    const options = NAME_SUGGESTIONS.filter((name) => name !== agentName);
    setAgentName(options[Math.floor(Math.random() * options.length)] ?? "Nova");
  };

  const save = async () => {
    const trimmedName = agentName.trim();
    if (!trimmedName) {
      setError("Give your agent a name.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const current = await window.electronAPI.getPersonalitySettings();
      await window.electronAPI.savePersonalitySettings({
        ...current,
        agentName: trimmedName,
        relationship: {
          ...current.relationship,
          userName: userName.trim() || current.relationship?.userName,
        },
      });
      saveCalmAgentAvatar(avatarId);
      onClose();
    } catch {
      setError("Couldn't save. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="calm-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="calm-dialog calm-agent-setup"
        role="dialog"
        aria-labelledby="calm-agent-setup-title"
      >
        <button
          type="button"
          className="calm-icon-button calm-dialog-close"
          onClick={onClose}
          aria-label="Close"
        >
          <X size={16} />
        </button>
        <h2 id="calm-agent-setup-title" className="calm-dialog-title">
          Your agent
        </h2>
        <p className="calm-dialog-subtitle">
          Give it a face and a name. It works across your tasks, automations and inbox.
        </p>

        <div className="calm-field-label">Appearance</div>
        <div className="calm-agent-setup-preview">
          <CalmAgentAvatar size={112} avatarId={avatarId} animated />
        </div>
        <div className="calm-agent-swatches" role="radiogroup" aria-label="Avatar color">
          {CALM_AGENT_AVATARS.map((avatar) => (
            <button
              key={avatar.id}
              type="button"
              role="radio"
              aria-checked={avatar.id === avatarId}
              aria-label={avatar.id}
              className={`calm-agent-swatch ${avatar.id === avatarId ? "active" : ""}`}
              onClick={() => setAvatarId(avatar.id)}
            >
              <CalmAgentAvatar size={34} avatarId={avatar.id} />
            </button>
          ))}
        </div>

        <div className="calm-field-row">
          <label className="calm-field-label" htmlFor="calm-agent-name">
            Name
          </label>
          <button type="button" className="calm-link-button" onClick={suggestName}>
            Suggest a name
          </button>
        </div>
        <input
          id="calm-agent-name"
          className="calm-input"
          value={agentName}
          onChange={(event) => setAgentName(event.target.value)}
          placeholder="Nova"
          maxLength={40}
          autoFocus
        />

        <label className="calm-field-label" htmlFor="calm-user-name">
          What should it call you?
        </label>
        <input
          id="calm-user-name"
          className="calm-input"
          value={userName}
          onChange={(event) => setUserName(event.target.value)}
          placeholder="Your first name"
          maxLength={60}
        />

        {error && <div className="calm-dialog-error">{error}</div>}

        <div className="calm-dialog-actions">
          <button
            type="button"
            className="calm-primary-button"
            onClick={() => void save()}
            disabled={saving}
          >
            {saving ? "Saving…" : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Mount once; renders the setup dialog when `openCalmAgentSetup()` fires. */
export function CalmAgentSetupHost() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    const handleOpen = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, handleOpen);
    return () => window.removeEventListener(OPEN_EVENT, handleOpen);
  }, []);
  return open ? <SetupDialog onClose={close} /> : null;
}
