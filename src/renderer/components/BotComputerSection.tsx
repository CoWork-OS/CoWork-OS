import { Hand, Monitor } from "lucide-react";
import { BOT_WORKS_ON_OPTIONS, type BotWorksOn } from "../../shared/bot-computer";
import { describeComputerViewStatus } from "../../shared/computer-view";
import { useComputerView } from "../hooks/useComputerView";

export interface BotComputerSectionProps {
  taskId: string;
  botName: string;
  worksOn: BotWorksOn;
}

/** Where the bot works, a live view of what it is doing there, and take-over. */
export function BotComputerSection({ taskId, botName, worksOn }: BotComputerSectionProps) {
  const off = worksOn === "off";
  const ownDesktop = worksOn === "own_desktop";
  const { state, busy, error, takeOver, handBack, openDesktop, stopDesktop } = useComputerView(
    taskId,
    !off,
  );
  const worksOnLabel = BOT_WORKS_ON_OPTIONS.find((option) => option.value === worksOn)?.label;
  const held = state?.status === "held";
  const request = !held ? state?.takeoverRequest : undefined;
  const frame = state?.frame;
  // It may still be running after the bot's turn ends (it stops after an hour without use).
  const desktopRunning = state?.surface === "own_desktop";

  // On its own desktop, taking over opens the desktop for you to use; handing back makes the
  // open view read-only again.
  const takeOverNow = async () => {
    await takeOver();
    if (ownDesktop) await openDesktop();
  };
  const handBackNow = async () => {
    await handBack();
    if (ownDesktop) await openDesktop();
  };

  return (
    <section className="bot-details-section bot-computer" aria-label="Computer">
      <h3 className="bot-details-section-heading">
        <Monitor size={13} />
        <span>Computer</span>
      </h3>
      <div className="bot-computer-summary">
        <span>Works on {worksOnLabel ?? "Auto"}</span>
        {!off ? (
          <span className={`bot-details-status${held || request ? " busy" : ""}`}>
            {describeComputerViewStatus(state)}
          </span>
        ) : null}
      </div>

      {request ? (
        <div className="bot-computer-request" role="status">
          <strong>{botName} needs you</strong>
          <span>{request.reason}</span>
        </div>
      ) : null}

      {held ? (
        <p className="bot-computer-note">
          {botName} won't use the computer or browser until you hand it back.
        </p>
      ) : null}

      {frame && !held ? (
        <figure className="bot-computer-frame">
          <img src={frame.dataUrl} alt={frame.label || "What the bot sees"} />
          {frame.label ? <figcaption title={frame.label}>{frame.label}</figcaption> : null}
        </figure>
      ) : null}

      {!off ? (
        <div className="bot-computer-actions">
          {held ? (
            <button
              type="button"
              className="bot-computer-button"
              onClick={() => void handBackNow()}
              disabled={busy}
            >
              Hand back
            </button>
          ) : (
            <button
              type="button"
              className={`bot-computer-button${request ? " primary" : ""}`}
              onClick={() => void takeOverNow()}
              disabled={busy}
            >
              <Hand size={13} />
              Take over
            </button>
          )}
          {ownDesktop ? (
            <button
              type="button"
              className="bot-computer-button"
              onClick={() => void openDesktop()}
              disabled={busy}
            >
              Open desktop
            </button>
          ) : null}
          {ownDesktop && desktopRunning && !held ? (
            <button
              type="button"
              className="bot-computer-button"
              onClick={() => void stopDesktop()}
              disabled={busy}
            >
              Stop desktop
            </button>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="bot-computer-error">{error}</p> : null}
    </section>
  );
}
