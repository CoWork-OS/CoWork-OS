import { useState } from "react";
import { hasHostMethod } from "../../host/browser-capabilities";
import { ChatGPTImportWizard } from "../ChatGPTImportWizard";
import { PromptMemoryImportWizard } from "../PromptMemoryImportWizard";
import type { MemoryRepoController } from "./MemoryRepoCard";
import { SettingsFeedback } from "./SettingsRow";

export interface MemoryImportButtonsProps {
  /** Memory is in use in this workspace (imports go into it). */
  memoryInUse: boolean;
  canImportChatGPT: boolean;
  /** "Folder of notes" exists (desktop: a native folder picker in main). */
  canImportFolder: boolean;
  /** The memory folder can take notes now. */
  folderReady: boolean;
  /** A memory folder action runs (this import or another). */
  folderBusy: boolean;
  importingFolder: boolean;
  chatGPTOpen: boolean;
  onFromAssistant: () => void;
  onChatGPT: () => void;
  onFolder: () => void;
}

const MEMORY_OFF = "Turn on Use memory for this workspace to import.";

/** The row of import buttons (secondary, one per source). */
export function MemoryImportButtons(props: MemoryImportButtonsProps) {
  return (
    <div className="memory-settings-button-row" role="group" aria-label="Import memory">
      <button
        type="button"
        className="settings-button"
        disabled={!props.memoryInUse}
        title={!props.memoryInUse ? MEMORY_OFF : "Paste what another assistant remembers about you"}
        onClick={props.onFromAssistant}
      >
        From another assistant
      </button>
      <button
        type="button"
        className="settings-button"
        aria-expanded={props.chatGPTOpen}
        aria-controls="memory-import-chatgpt"
        disabled={!props.memoryInUse || !props.canImportChatGPT}
        title={
          !props.canImportChatGPT
            ? "File-based conversation import is not connected to this browser host yet. Use From another assistant."
            : !props.memoryInUse
              ? MEMORY_OFF
              : "Import the conversations of a ChatGPT data export"
        }
        onClick={props.onChatGPT}
      >
        ChatGPT export
      </button>
      {props.canImportFolder && (
        <button
          type="button"
          className="settings-button"
          disabled={!props.folderReady || props.folderBusy}
          title={
            props.folderReady
              ? "Bring markdown notes (another agent's memory folder, any notes folder) into the memory folder inbox"
              : "Turn on the memory folder to import notes into it."
          }
          onClick={props.onFolder}
        >
          {props.importingFolder ? "Importing..." : "Folder of notes"}
        </button>
      )}
    </div>
  );
}

/**
 * Import: text from another assistant (a prompt the user runs there, then pastes back),
 * a ChatGPT export (opened right under the buttons) and a folder of notes (into the
 * memory folder inbox). Results show here; the imported memories are listed in Sources.
 */
export function MemoryImportSection({
  workspaceId,
  memoryInUse,
  repo,
}: {
  workspaceId: string;
  memoryInUse: boolean;
  /** The memory folder, where the host has it. */
  repo: MemoryRepoController | null;
}) {
  const [panel, setPanel] = useState<"assistant" | "chatgpt" | null>(null);
  const [notice, setNotice] = useState<{ tone: "success"; text: string } | null>(null);
  const imported = () =>
    setNotice({
      tone: "success",
      text: "Import finished. Imported memories are listed in the Sources tab.",
    });
  const canImportFolder = Boolean(repo?.canImport) && hasHostMethod("importMemoryRepoFolder");

  return (
    <>
      <p className="settings-form-hint">
        Bring in what other assistants know about you, a ChatGPT export, or a folder of notes.
      </p>
      <MemoryImportButtons
        memoryInUse={memoryInUse}
        canImportChatGPT={hasHostMethod("importChatGPT")}
        canImportFolder={canImportFolder}
        folderReady={Boolean(repo?.ready) && repo?.status?.writable !== false}
        folderBusy={Boolean(repo?.busy)}
        importingFolder={repo?.busy === "import"}
        chatGPTOpen={panel === "chatgpt"}
        onFromAssistant={() => {
          setNotice(null);
          setPanel("assistant");
        }}
        onChatGPT={() => {
          setNotice(null);
          setPanel((current) => (current === "chatgpt" ? null : "chatgpt"));
        }}
        onFolder={() => {
          setNotice(null);
          repo?.importFolder();
        }}
      />
      {panel === "chatgpt" && (
        <div id="memory-import-chatgpt" className="memory-settings-panel">
          <ChatGPTImportWizard
            workspaceId={workspaceId}
            onClose={() => setPanel(null)}
            onImportComplete={imported}
          />
        </div>
      )}
      {panel === "assistant" && (
        <PromptMemoryImportWizard
          workspaceId={workspaceId}
          onClose={() => setPanel(null)}
          onImportComplete={imported}
        />
      )}
      <SettingsFeedback message={notice} />
      {canImportFolder && <SettingsFeedback message={repo?.importMessage ?? null} />}
    </>
  );
}
