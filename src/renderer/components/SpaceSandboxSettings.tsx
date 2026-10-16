import { useEffect, useRef, useState } from "react";
import type { SpaceSandboxConfig, Workspace } from "../../shared/types";
import { isSpaceRelativePath, isSpaceTemplate } from "../../shared/space-sandbox";
import "./space-sandbox-settings.css";

export function SpaceSandboxSettings({ workspaceId }: { workspaceId?: string }) {
  const selection = useRef(0);
  const [workspace, setWorkspace] = useState<Workspace>();
  const [enabled, setEnabled] = useState(false);
  const [template, setTemplate] = useState("");
  const [inputs, setInputs] = useState("");
  const [outputs, setOutputs] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const generation = ++selection.current;
    let active = true;
    setWorkspace(undefined);
    setSaving(false);
    setMessage("");
    if (workspaceId && window.coworkBrowserHost !== true)
      void window.electronAPI
        .listWorkspaces()
        .then((workspaces: Workspace[]) => {
          if (!active || generation !== selection.current) return;
          const current = workspaces.find((item) => item.id === workspaceId);
          setWorkspace(current);
          setEnabled(current?.permissions.sandboxType === "space");
          setTemplate(current?.permissions.spaceConfig?.template || "");
          setInputs((current?.permissions.spaceConfig?.inputPaths || []).join("\n"));
          setOutputs((current?.permissions.spaceConfig?.outputPaths || []).join("\n"));
        })
        .catch(() => {
          if (active) setMessage("Could not load this workspace.");
        });
    return () => {
      active = false;
    };
  }, [workspaceId]);

  const save = async () => {
    if (
      !workspace ||
      workspace.id !== workspaceId ||
      (!enabled && workspace.permissions.sandboxType !== "space")
    )
      return;
    const generation = selection.current;
    setSaving(true);
    setMessage("");
    try {
      const lines = (text: string) =>
        text
          .split("\n")
          .map((item) => item.trim())
          .filter(Boolean);
      const spaceConfig: SpaceSandboxConfig = {
        template: template.trim(),
        inputPaths: lines(inputs),
        outputPaths: lines(outputs),
      };
      if (enabled && !isSpaceTemplate(spaceConfig.template))
        throw new Error("Choose a valid published template first.");
      if (
        enabled &&
        [...spaceConfig.inputPaths!, ...spaceConfig.outputPaths!].some(
          (file) => !isSpaceRelativePath(file),
        )
      ) {
        throw new Error("Use workspace-relative file paths outside private configuration.");
      }
      const updated = await window.electronAPI.updateWorkspacePermissions(
        workspace.id,
        enabled ? { sandboxType: "space", spaceConfig } : { sandboxType: "auto" },
      );
      if (selection.current !== generation) return;
      if (!updated || updated.id !== workspace.id)
        throw new Error("This workspace is no longer available.");
      setWorkspace(updated);
      setMessage(
        "Saved. New commands use this selection; work already sent may still be cleaning up.",
      );
    } catch (error) {
      if (selection.current === generation)
        setMessage(error instanceof Error ? error.message : "Could not save sandbox settings.");
    } finally {
      if (selection.current === generation) setSaving(false);
    }
  };

  if (window.coworkBrowserHost === true)
    return (
      <p className="settings-description">
        Configure SPACE in the desktop app on the host that runs commands.
      </p>
    );
  if (!workspace || workspace.id !== workspaceId)
    return (
      <p className="settings-description">
        Select a saved workspace to configure its sandbox. {message}
      </p>
    );
  return (
    <div className="settings-section space-sandbox-settings">
      <p className="settings-description">
        Run this workspace’s code in an isolated Linux environment on your configured SPACE server.
        Requires administrator setup. Selected input files leave this computer. Other files stay
        local.
      </p>
      <div className="space-sandbox-enable">
        <span>Use SPACE for {workspace.name}</span>
        <label className="settings-toggle">
          <input
            type="checkbox"
            aria-label={`Use SPACE for ${workspace.name}`}
            checked={enabled}
            disabled={saving}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <span className="toggle-slider" />
        </label>
      </div>
      {enabled && (
        <>
          <label>
            Published template
            <input
              className="settings-input"
              aria-label="SPACE published template"
              value={template}
              disabled={saving}
              onChange={(event) => setTemplate(event.target.value)}
              placeholder="cowork-offline:latest"
            />
          </label>
          <label>
            Input files
            <textarea
              className="settings-input"
              rows={3}
              aria-label="SPACE input files"
              value={inputs}
              disabled={saving}
              onChange={(event) => setInputs(event.target.value)}
              placeholder="data/input.csv"
            />
          </label>
          <label>
            Output files
            <textarea
              className="settings-input"
              rows={3}
              aria-label="SPACE output files"
              value={outputs}
              disabled={saving}
              onChange={(event) => setOutputs(event.target.value)}
              placeholder="result.csv"
            />
          </label>
          <p className="settings-description">
            Enter one workspace-relative file per line. Outputs must be new files in existing
            folders. Each command starts fresh. Network access, background processes, and changes to
            existing local files are unavailable.
          </p>
        </>
      )}
      <div className="settings-actions">
        <button
          className="button-primary"
          disabled={saving || (!enabled && workspace.permissions.sandboxType !== "space")}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save sandbox selection"}
        </button>
      </div>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
