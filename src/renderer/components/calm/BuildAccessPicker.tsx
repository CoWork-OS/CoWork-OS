import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ShieldAlert, ShieldCheck, SlidersHorizontal } from "lucide-react";
import {
  BUILTIN_ACCESS_PROFILES,
  BUILTIN_ACCESS_PROFILE_IDS,
  getAccessProfileLabel,
  resolveAccessProfileDefinition,
  type AccessProfileDefinition,
  type AccessProfileId,
} from "../../../shared/access-profiles";
import { useFullAccessConfirmation } from "../FullAccessConfirmationDialog";
import { getAccessProfilePresentation } from "../MainContent/access-profile-presentation";
import {
  forgetRememberedAccessProfileId,
  readRememberedAccessProfileId,
  rememberAccessProfileId,
  resolveNewTaskAccessProfileId,
} from "../../utils/new-task-access-profile";

/**
 * Access profile for the next build, chosen the same way as on Home: the last pick is remembered
 * across both composers, otherwise the default from Settings applies.
 */
export function useBuildAccessProfile() {
  const [profileId, setProfileId] = useState<AccessProfileId>(
    () => readRememberedAccessProfileId() ?? BUILTIN_ACCESS_PROFILE_IDS.askForApproval,
  );
  const [customProfiles, setCustomProfiles] = useState<AccessProfileDefinition[]>([]);
  const [approvalPromptsEnabled, setApprovalPromptsEnabled] = useState<boolean | null>(null);
  const loadedDefaultRef = useRef<AccessProfileId | null>(null);

  useEffect(() => {
    let cancelled = false;
    const apply = (
      settings: {
        defaultPermissionAccess?: "default" | "full";
        defaultAccessProfileId?: AccessProfileId;
        accessProfiles?: AccessProfileDefinition[];
      },
      fromSettingsChange = false,
    ) => {
      const defaultId: AccessProfileId =
        settings.defaultAccessProfileId ||
        (settings.defaultPermissionAccess === "full"
          ? BUILTIN_ACCESS_PROFILE_IDS.fullAccess
          : BUILTIN_ACCESS_PROFILE_IDS.askForApproval);
      const profiles = Array.isArray(settings.accessProfiles) ? settings.accessProfiles : [];
      // Changing the default in Settings replaces the last pick, as it does on Home.
      const previousDefault = loadedDefaultRef.current;
      loadedDefaultRef.current = defaultId;
      if (fromSettingsChange && previousDefault !== null && previousDefault !== defaultId) {
        forgetRememberedAccessProfileId();
      }
      setCustomProfiles(profiles);
      setProfileId(
        resolveNewTaskAccessProfileId({
          remembered: readRememberedAccessProfileId(),
          defaultProfileId: defaultId,
          availableProfileIds: [...BUILTIN_ACCESS_PROFILES, ...profiles].map((p) => p.id),
        }),
      );
    };

    window.electronAPI
      ?.getPermissionSettings?.()
      .then((settings) => {
        if (!cancelled) apply(settings);
      })
      .catch((error: unknown) => console.error("Failed to load permission defaults:", error));
    window.electronAPI
      ?.getPermissionRuntimeInfo?.()
      .then((runtime) => {
        if (!cancelled) setApprovalPromptsEnabled(runtime.approvalPromptsEnabled);
      })
      .catch((error: unknown) => console.debug("Failed to load permission runtime info:", error));

    const onSettingsUpdated = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail && typeof detail === "object") apply(detail, true);
    };
    window.addEventListener("cowork:permission-settings-updated", onSettingsUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener("cowork:permission-settings-updated", onSettingsUpdated);
    };
  }, []);

  const select = useCallback((id: AccessProfileId) => {
    rememberAccessProfileId(id);
    setProfileId(id);
  }, []);

  return { profileId, customProfiles, approvalPromptsEnabled, select };
}

interface BuildAccessPickerProps {
  profileId: AccessProfileId;
  customProfiles: AccessProfileDefinition[];
  approvalPromptsEnabled: boolean | null;
  onSelect: (profileId: AccessProfileId) => void;
  onOpenSettings?: () => void;
  disabled?: boolean;
}

export function BuildAccessPicker({
  profileId,
  customProfiles,
  approvalPromptsEnabled,
  onSelect,
  onOpenSettings,
  disabled,
}: BuildAccessPickerProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const fullAccessConfirmation = useFullAccessConfirmation();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const selected = resolveAccessProfileDefinition(profileId, customProfiles);
  const isFull = profileId === BUILTIN_ACCESS_PROFILE_IDS.fullAccess;

  const choose = (id: AccessProfileId) => {
    const profile = resolveAccessProfileDefinition(id, customProfiles);
    setOpen(false);
    fullAccessConfirmation.request(
      profile.sandbox === "danger-full-access" && profile.approval === "never",
      () => onSelect(id),
    );
  };

  const renderOption = (profile: AccessProfileDefinition, custom: boolean) => {
    const presentation = getAccessProfilePresentation(profile, approvalPromptsEnabled);
    const danger = profile.id === BUILTIN_ACCESS_PROFILE_IDS.fullAccess;
    return (
      <button
        key={profile.id}
        type="button"
        role="menuitemradio"
        aria-checked={profileId === profile.id}
        className={`permission-access-option ${danger ? "danger" : ""} ${
          profileId === profile.id ? "active" : ""
        }`}
        title={presentation.description}
        onClick={() => choose(profile.id)}
      >
        {custom ? (
          <SlidersHorizontal size={16} aria-hidden="true" />
        ) : danger ? (
          <ShieldAlert size={16} aria-hidden="true" />
        ) : (
          <ShieldCheck size={16} aria-hidden="true" />
        )}
        <span className="permission-access-option-copy">
          <span className="permission-access-option-title">
            {profile.label || getAccessProfileLabel(profile.id)}
          </span>
        </span>
      </button>
    );
  };

  return (
    <div className="permission-dropdown-container calm-build-access" ref={containerRef}>
      <button
        type="button"
        className={`permission-access-btn ${isFull ? "full" : ""}`}
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Permission access mode: ${selected.label}`}
        title={selected.label}
      >
        {isFull ? (
          <ShieldAlert size={18} aria-hidden="true" />
        ) : (
          <ShieldCheck size={18} aria-hidden="true" />
        )}
        <span>{selected.label}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div className="permission-access-dropdown" role="menu" aria-label="Permission access profiles">
          {BUILTIN_ACCESS_PROFILES.map((profile) => renderOption(profile, false))}
          {customProfiles.length > 0 && (
            <div className="permission-access-custom-label">Custom profiles</div>
          )}
          {customProfiles.map((profile) => renderOption(profile, true))}
          {onOpenSettings && (
            <button
              type="button"
              role="menuitem"
              className="permission-access-option"
              onClick={() => {
                setOpen(false);
                onOpenSettings();
              }}
            >
              <SlidersHorizontal size={16} aria-hidden="true" />
              <span className="permission-access-option-copy">
                <span className="permission-access-option-title">Permission settings</span>
              </span>
            </button>
          )}
        </div>
      )}
      {fullAccessConfirmation.dialog}
    </div>
  );
}
