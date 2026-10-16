import { useState } from "react";
import { Circle, Hand, Monitor } from "lucide-react";
import { BOT_WORKS_ON_OPTIONS, type BotWorksOn } from "../../shared/bot-computer";
import { describeComputerViewStatus } from "../../shared/computer-view";
import { useComputerView } from "../hooks/useComputerView";
import { formatFileSize, useBotDesktopFiles } from "../hooks/useBotDesktopFiles";
import { formatTaughtTaskLength, useTaughtTasks } from "../hooks/useTaughtTasks";
import { TAUGHT_TASK_NAME_MAX_LENGTH } from "../../shared/bot-computer";

export interface BotComputerSectionProps {
  taskId: string;
  botName: string;
  worksOn: BotWorksOn;
  /** The SSH host its own desktop runs on, if not this computer. */
  desktopHost?: string;
  /** The shared desktop it uses with other bots, if any. */
  desktopGroup?: string;
}

/** Where the bot works, a live view of what it is doing there, and take-over. */
export function BotComputerSection({
  taskId,
  botName,
  worksOn,
  desktopHost,
  desktopGroup,
}: BotComputerSectionProps) {
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
  // Its work folder: refreshed with each new still, since that is when it may have changed.
  const { files, reveal } = useBotDesktopFiles(taskId, ownDesktop, frame?.capturedAt);
  // Teach a task: you record doing it once on its desktop; the bot can replay it later.
  const teaching = useTaughtTasks(taskId, ownDesktop);
  const [taskName, setTaskName] = useState("");
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
        <span>
          Works on {worksOnLabel ?? "Auto"}
          {worksOn === "own_desktop" && desktopGroup ? ` (shared: ${desktopGroup})` : ""}
          {worksOn === "own_desktop" && desktopHost ? ` on ${desktopHost}` : ""}
        </span>
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
              disabled={busy || teaching.recording}
              title={teaching.recording ? "Save or discard the recording first" : undefined}
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
          {ownDesktop && held && !teaching.recording ? (
            <button
              type="button"
              className="bot-computer-button"
              onClick={() => void teaching.startRecording()}
              disabled={busy || teaching.busy}
            >
              <Circle size={11} />
              Record a task
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
      {teaching.recording ? (
        <form
          className="bot-computer-recording"
          onSubmit={(event) => {
            event.preventDefault();
            if (taskName.trim()) {
              void teaching.finishRecording(taskName.trim()).then(() => setTaskName(""));
            }
          }}
        >
          <strong>Recording</strong>
          <span>
            Do the task once on {botName}'s desktop. Everything you type is recorded, so don't type
            passwords.
          </span>
          <input
            type="text"
            value={taskName}
            maxLength={TAUGHT_TASK_NAME_MAX_LENGTH}
            placeholder="Name this task, like Download the invoice"
            aria-label="Task name"
            onChange={(event) => setTaskName(event.target.value)}
          />
          <div className="bot-computer-actions">
            <button
              type="submit"
              className="bot-computer-button primary"
              disabled={teaching.busy || !taskName.trim()}
            >
              Stop and save
            </button>
            <button
              type="button"
              className="bot-computer-button"
              disabled={teaching.busy}
              onClick={() => void teaching.finishRecording(null).then(() => setTaskName(""))}
            >
              Discard
            </button>
          </div>
        </form>
      ) : null}
      {ownDesktop && teaching.tasks.length > 0 ? (
        <div className="bot-computer-files">
          <span className="bot-computer-files-heading">Taught tasks</span>
          <ul>
            {teaching.tasks.map((task) => (
              <li key={task.id}>
                <span className="bot-computer-file-name" title={task.name}>
                  {task.name}
                </span>
                <span className="bot-computer-file-size">
                  {formatTaughtTaskLength(task.durationMs)}
                </span>
                <button
                  type="button"
                  className="bot-details-link"
                  disabled={teaching.busy}
                  onClick={() => void teaching.deleteTask(task.id)}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {ownDesktop && files.length > 0 ? (
        <div className="bot-computer-files">
          <span className="bot-computer-files-heading">Files on its desktop</span>
          <ul>
            {files.slice(0, 6).map((file) => (
              <li key={file.path}>
                <span className="bot-computer-file-name" title={`~/work/${file.path}`}>
                  {file.path}
                </span>
                <span className="bot-computer-file-size">{formatFileSize(file.size)}</span>
                {!desktopHost ? (
                  <button
                    type="button"
                    className="bot-details-link"
                    onClick={() => reveal(file.path)}
                  >
                    Show
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {error || teaching.error ? (
        <p className="bot-computer-error">{error ?? teaching.error}</p>
      ) : null}
    </section>
  );
}
