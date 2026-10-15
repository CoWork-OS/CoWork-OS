import { useCallback, useEffect, useState } from "react";
import type { AndroidPhoneStatus } from "../../shared/android-phone";
import { hasHostMethods } from "../host/browser-capabilities";

export function AndroidPhoneSettings() {
  const [status, setStatus] = useState<AndroidPhoneStatus>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setStatus(await window.electronAPI.getAndroidPhoneStatus());
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }, []);
  useEffect(() => {
    if (hasHostMethods("getAndroidPhoneStatus")) void refresh();
  }, [refresh]);
  if (!hasHostMethods("getAndroidPhoneStatus")) return null;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-section" aria-label="Android phone control">
      <h3>Android phone</h3>
      <p className="settings-description">
        Control a selected Android phone or emulator through phone-harness. Screen access and each
        input ask for approval; input approval also covers its readback. Screenshots and visible
        text are shared with the task’s model. Passwords, PINs and verification codes require your
        input.
      </p>
      <p className="settings-description">
        Connect by USB, enable USB debugging and approve this computer on the phone. An offline or
        unauthorized device cannot be controlled. Select a device below; CoWork never substitutes
        another phone.
      </p>
      {(error || status?.error) && (
        <div className="settings-error" role="alert">
          {error || status?.error}
        </div>
      )}
      <div className="settings-field">
        <label htmlFor="android-phone-device">Selected device</label>
        <select
          id="android-phone-device"
          disabled={busy || !status}
          value={status?.settings.deviceId ?? ""}
          onChange={(e) =>
            void run(() =>
              window.electronAPI.saveAndroidPhoneSettings({
                enabled: false,
                ...(e.target.value ? { deviceId: e.target.value } : {}),
              }),
            )
          }
        >
          <option value="">Choose an Android device</option>
          {status?.settings.deviceId &&
            !status.devices.some((d) => d.id === status.settings.deviceId) && (
              <option value={status.settings.deviceId}>
                {status.settings.deviceId} — disconnected
              </option>
            )}
          {status?.devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.model} · {d.id} — {d.state}
            </option>
          ))}
        </select>
      </div>
      <label className="settings-description">
        <input
          type="checkbox"
          checked={status?.settings.enabled ?? false}
          disabled={busy || !status?.settings.deviceId || !status.runtimeInstalled}
          onChange={(e) =>
            void run(() =>
              window.electronAPI.saveAndroidPhoneSettings({
                ...status!.settings,
                enabled: e.target.checked,
              }),
            )
          }
        />{" "}
        Enable control of this device
      </label>
      <p className="settings-description">
        Runtime: {status?.runtimeInstalled ? "phone-harness 0.3.2 installed" : "Not installed"}.
        Installation uses uv and Python 3.12. Telemetry is disabled. No phone app is installed.
      </p>
      <div className="computer-use-active-actions">
        <button
          type="button"
          className="button-secondary"
          disabled={busy}
          onClick={() => void run(() => window.electronAPI.installAndroidPhoneRuntime())}
        >
          {busy ? "Working…" : "Install / repair runtime"}
        </button>
        <button
          type="button"
          className="button-secondary"
          disabled={busy}
          onClick={() => void refresh()}
        >
          Refresh devices
        </button>
        <button
          type="button"
          className="button-secondary"
          onClick={() => void run(() => window.electronAPI.stopAndroidPhone())}
        >
          Stop phone activity
        </button>
      </div>
      <p className="settings-description">
        Stop disables phone control and interrupts local work; an action may already have reached
        the phone. CoWork keeps uncertain actions for reconciliation and does not repeat them.
        Enable control again to continue.
      </p>
    </section>
  );
}
