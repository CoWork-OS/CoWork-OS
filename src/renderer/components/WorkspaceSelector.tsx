import { useState, useEffect } from "react";
import { FolderIcon } from "./LineIcons";
import { Workspace } from "../../shared/types";

interface WorkspaceSelectorProps {
  onWorkspaceSelected: (workspace: Workspace) => void;
}

export function WorkspaceSelector({ onWorkspaceSelected }: WorkspaceSelectorProps) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [appVersion, setAppVersion] = useState<string>("");

  useEffect(() => {
    loadWorkspaces();
    loadVersion();
  }, []);

  const loadVersion = async () => {
    try {
      const versionInfo = await window.electronAPI.getAppVersion();
      setAppVersion(versionInfo.version);
    } catch (error) {
      console.error("Failed to load version:", error);
    }
  };

  const loadWorkspaces = async () => {
    try {
      const loaded = await window.electronAPI.listWorkspaces();
      setWorkspaces(loaded);
    } catch (error) {
      console.error("Failed to load workspaces:", error);
    }
  };

  const handleSelectFolder = async () => {
    try {
      const folderPath = await window.electronAPI.selectFolder();
      if (!folderPath) return;

      const folderName = folderPath.split("/").pop() || "Workspace";

      const workspace = await window.electronAPI.createWorkspace({
        name: folderName,
        path: folderPath,
        permissions: {
          read: true,
          write: true,
          delete: true,
          network: false,
          shell: false,
        },
      });

      onWorkspaceSelected(workspace);
    } catch (error) {
      console.error("Failed to create workspace:", error);
    }
  };

  return (
    <div className="workspace-selector cli-workspace-selector">
      <div className="workspace-selector-content cli-workspace-content">
        {/* Terminal Header */}
        <div className="cli-terminal-header terminal-only">
          <div className="cli-terminal-dots">
            <span className="cli-dot"></span>
            <span className="cli-dot"></span>
            <span className="cli-dot active"></span>
          </div>
          <span className="cli-terminal-title">CoWork OS — init</span>
        </div>

        {/* Logo Section */}
        <div className="cli-logo-section">
          <img
            src="./cowork-os-logo.png"
            alt="CoWork OS"
            className="cli-mascot-logo terminal-only"
          />
          <img
            src="./cowork-os-logo-text-dark.png"
            alt="CoWork OS"
            className="modern-logo-text modern-only logo-for-dark"
          />
          <img
            src="./cowork-os-logo-text.png"
            alt="CoWork OS"
            className="modern-logo-text modern-only logo-for-light"
          />
          <pre className="cli-ascii-logo terminal-only">{`
  ██████╗ ██████╗ ██╗    ██╗ ██████╗ ██████╗ ██╗  ██╗       ██████╗ ███████╗
 ██╔════╝██╔═══██╗██║    ██║██╔═══██╗██╔══██╗██║ ██╔╝      ██╔═══██╗██╔════╝
 ██║     ██║   ██║██║ █╗ ██║██║   ██║██████╔╝█████╔╝ █████╗██║   ██║███████╗
 ██║     ██║   ██║██║███╗██║██║   ██║██╔══██╗██╔═██╗ ╚════╝██║   ██║╚════██║
 ╚██████╗╚██████╔╝╚███╔███╔╝╚██████╔╝██║  ██║██║  ██╗      ╚██████╔╝███████║
  ╚═════╝ ╚═════╝  ╚══╝╚══╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝       ╚═════╝ ╚══════╝`}</pre>
          <div className="cli-version">{appVersion ? `v${appVersion}` : ""}</div>
          <div className="workspace-modern-title modern-only">Choose a workspace</div>
          <div className="workspace-modern-subtitle modern-only">Pick a folder to get started.</div>
        </div>

        {/* Terminal Info */}
        <div className="cli-init-info">
          <div className="cli-line">
            <span className="cli-prompt">$</span>
            <span className="cli-text">
              <span className="terminal-only">Welcome to CoWork OS</span>
              <span className="modern-only">Welcome to CoWork OS</span>
            </span>
          </div>
          <div className="cli-line">
            <span className="cli-prompt">$</span>
            <span className="cli-text">
              <span className="terminal-only">
                Select a workspace folder to initialize your environment
              </span>
              <span className="modern-only">
                Select a workspace folder to initialize your environment
              </span>
            </span>
          </div>
          <div className="cli-line cli-blink">
            <span className="cli-prompt">$</span>
            <span className="cli-text">
              <span className="terminal-only">Waiting for workspace selection...</span>
              <span className="modern-only">Waiting for your workspace selection...</span>
            </span>
            <span className="cli-cursor-block">_</span>
          </div>
        </div>

        {/* Recent Workspaces */}
        {workspaces.length > 0 && (
          <div className="cli-workspace-list">
            <div className="cli-section-header">
              <span className="cli-section-prompt">&gt;</span>
              <span className="cli-section-title">
                <span className="terminal-only">RECENT_WORKSPACES</span>
                <span className="modern-only">Recent workspaces</span>
              </span>
            </div>
            {workspaces.map((workspace, index) => (
              <div
                key={workspace.id}
                className="cli-workspace-item"
                onClick={() => onWorkspaceSelected(workspace)}
              >
                <span className="cli-item-num">{String(index + 1).padStart(2, "0")}</span>
                <span className="cli-item-icon">
                  <span className="terminal-only">[dir]</span>
                  <span className="modern-only">
                    <FolderIcon size={16} />
                  </span>
                </span>
                <div className="cli-item-info">
                  <span className="cli-item-name">{workspace.name}/</span>
                  <span className="cli-item-path">{workspace.path}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Select Folder Action */}
        <div className="cli-workspace-actions">
          <button className="cli-action-btn" onClick={handleSelectFolder}>
            <span className="terminal-only">
              <span className="cli-btn-bracket">[</span>
              <span className="cli-btn-icon">+</span>
              <span className="cli-btn-bracket">]</span>
            </span>
            <span className="cli-btn-text">
              <span className="terminal-only">select_folder</span>
              <span className="modern-only">Select folder</span>
            </span>
          </button>
          <p className="cli-hint">
            <span className="terminal-only"># choose a directory for CoWork OS to operate in</span>
            <span className="modern-only">Choose a directory for CoWork OS to operate in.</span>
          </p>
        </div>

        {/* Footer */}
        <div className="cli-init-footer">
          <span className="cli-footer-prompt">$</span>
          <span className="cli-footer-text">
            <span className="terminal-only">ready</span>
            <span className="modern-only">Ready to continue</span>
          </span>
        </div>
      </div>
    </div>
  );
}
