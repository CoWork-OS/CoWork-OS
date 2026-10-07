import { useEffect, useRef, useState } from "react";
import {
  channelDecisionEnableError,
  saveChannelDecisionSetting,
  type DecisionSettingsChannel,
} from "./channel-decision-settings";

interface Props {
  channel: DecisionSettingsChannel;
  onSaved: (enabled: boolean) => void;
}

export function ChannelDecisionSettings({ channel, onSaved }: Props) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    pending.current = false;
    setSaving(false);
    setError(undefined);
    return () => {
      generation.current++;
    };
  }, [channel.id]);
  const enabled = channel.config?.decisionMessagesEnabled === true;
  const enableError = channelDecisionEnableError(channel);

  const save = async (next: boolean) => {
    if (pending.current) return;
    pending.current = true;
    const revision = generation.current;
    setSaving(true);
    setError(undefined);
    try {
      await saveChannelDecisionSetting(channel, next, (request) =>
        window.electronAPI.updateGatewayChannel(request),
      );
      if (generation.current === revision) onSaved(next);
    } catch (failure) {
      if (generation.current === revision)
        setError(failure instanceof Error ? failure.message : "Could not save decision cards.");
    } finally {
      if (generation.current === revision) {
        pending.current = false;
        setSaving(false);
      }
    }
  };

  if (channel.type !== "slack" && channel.type !== "teams") return null;
  return (
    <div className="settings-section">
      <h4>Decision Cards</h4>
      <p className="settings-description">
        Review requests from tasks you started in this channel. Your configured account can approve
        the displayed request once or deny it. Requests expire after five minutes; changed requests
        or files need a fresh review in CoWork.
      </p>
      <label className="settings-checkbox" htmlFor={`decision-cards-${channel.id}`}>
        <input
          id={`decision-cards-${channel.id}`}
          type="checkbox"
          checked={enabled}
          disabled={saving || (!enabled && !!enableError)}
          onChange={(event) => void save(event.target.checked)}
        />
        Send approval decision cards
      </label>
      <p className="settings-hint">
        {saving
          ? "Saving..."
          : enableError || "Off by default. Approval uses this channel's existing permissions."}
      </p>
      <p className="settings-hint">
        Requests that cannot be reviewed here direct you to CoWork. An interrupted delivery may have
        an unknown outcome; check CoWork before responding there.
      </p>
      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
