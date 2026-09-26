import { useCallback, useRef, useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  Folder,
  FolderPlus,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import type { Workspace } from "../../../shared/types";
import { useDismissable } from "./useDismissable";

export interface CalmAccessOption {
  id: string;
  label: string;
  description?: string;
  danger?: boolean;
}

export interface CalmTopBarProps {
  /** Optional leading content (e.g. the current task title). */
  leading?: ReactNode;
  /** Optional trailing content rendered before the access shield. */
  trailing?: ReactNode;
  scope: {
    label: string;
    workspaces: Workspace[];
    activeWorkspaceId?: string;
    onSelect: (workspace: Workspace) => void;
    onNewFolder: () => void;
    /** Called when the menu opens, to refresh the recent folders list. */
    onOpen?: () => void;
  };
  /** Omit where there is no task access profile to show (e.g. Build). */
  access?: {
    label: string;
    selectedId?: string;
    isFullAccess: boolean;
    options: CalmAccessOption[];
    onSelect: (id: string) => void;
    onConfigure: () => void;
  };
}

function ScopeMenu({ scope }: Pick<CalmTopBarProps, "scope">) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismissable(ref, open, close);

  return (
    <div className="calm-menu" ref={ref}>
      <button
        type="button"
        className={`calm-topbar-button calm-scope-button ${open ? "open" : ""}`}
        onClick={() => {
          if (!open) scope.onOpen?.();
          setOpen((value) => !value);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Where this work happens"
      >
        <Folder size={14} aria-hidden="true" />
        <span className="calm-topbar-button-label">{scope.label}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="calm-popover" role="menu">
          {scope.workspaces.length > 0 && (
            <>
              <div className="calm-popover-heading">Recent folders</div>
              <div className="calm-popover-scroll">
                {scope.workspaces.slice(0, 10).map((workspace) => {
                  const active = workspace.id === scope.activeWorkspaceId;
                  return (
                    <button
                      key={workspace.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      className={`calm-popover-item ${active ? "selected" : ""}`}
                      onClick={() => {
                        close();
                        scope.onSelect(workspace);
                      }}
                    >
                      <span className="calm-popover-item-copy">
                        <span className="calm-popover-item-title">{workspace.name}</span>
                        <span className="calm-popover-item-desc">{workspace.path}</span>
                      </span>
                      {active && <Check size={15} aria-hidden="true" />}
                    </button>
                  );
                })}
              </div>
              <div className="calm-popover-divider" />
            </>
          )}
          <button
            type="button"
            className="calm-popover-item calm-popover-footer-item"
            onClick={() => {
              close();
              scope.onNewFolder();
            }}
          >
            <FolderPlus size={15} aria-hidden="true" />
            <span className="calm-popover-item-title">Work in another folder…</span>
          </button>
        </div>
      )}
    </div>
  );
}

export type CalmAccessMenuProps = NonNullable<CalmTopBarProps["access"]>;

/**
 * Shield button + menu for the task access profile. Lives in the composer;
 * `placement="up"` opens the menu above the button.
 */
export function CalmAccessMenu({
  access,
  placement = "down",
}: {
  access: CalmAccessMenuProps;
  placement?: "down" | "up";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismissable(ref, open, close);
  const Icon = access.isFullAccess ? ShieldAlert : ShieldCheck;

  return (
    <div
      className={`calm-menu calm-access-menu ${placement === "up" ? "calm-menu-up" : ""}`}
      ref={ref}
    >
      <button
        type="button"
        className={`calm-icon-button calm-access-button ${access.isFullAccess ? "danger" : ""} ${
          open ? "open" : ""
        }`}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Access: ${access.label}`}
        title={`Access: ${access.label}`}
      >
        <Icon size={17} aria-hidden="true" />
      </button>
      {open && (
        <div
          className={`calm-popover ${placement === "up" ? "calm-popover-up" : "calm-popover-right"}`}
          role="menu"
        >
          <div className="calm-popover-heading">What CoWork can do</div>
          {access.options.map((option) => {
            const active = option.id === access.selectedId;
            const OptionIcon = option.danger ? ShieldAlert : ShieldCheck;
            return (
              <button
                key={option.id}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className={`calm-popover-item ${active ? "selected" : ""} ${
                  option.danger ? "danger" : ""
                }`}
                onClick={() => {
                  close();
                  access.onSelect(option.id);
                }}
                title={option.description}
              >
                <OptionIcon size={15} aria-hidden="true" />
                <span className="calm-popover-item-copy">
                  <span className="calm-popover-item-title">{option.label}</span>
                </span>
                {active && <Check size={15} aria-hidden="true" />}
              </button>
            );
          })}
          <div className="calm-popover-divider" />
          <button
            type="button"
            className="calm-popover-item calm-popover-footer-item"
            onClick={() => {
              close();
              access.onConfigure();
            }}
          >
            <SlidersHorizontal size={15} aria-hidden="true" />
            <span className="calm-popover-item-title">Configure access profiles</span>
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Slim header used by the calm theme: where the work happens and what the
 * agent is allowed to do. The model picker stays in the composer.
 */
export function CalmTopBar({ leading, trailing, scope, access }: CalmTopBarProps) {
  return (
    <div className="calm-topbar">
      <div className="calm-topbar-left">
        {leading}
        <ScopeMenu scope={scope} />
      </div>
      <div className="calm-topbar-right">
        {trailing}
        {access && <CalmAccessMenu access={access} />}
      </div>
    </div>
  );
}
