import { useEffect, useState } from "react";
import type { ChannelUserData, ContextType } from "../../shared/types";
import { PairingCodeDisplay } from "./PairingCodeDisplay";

/** Context grants are independent of the channel's open/configured-allowlist policy. */
export function GatewayContextAccessSettings({ channelId }: { channelId: string }) {
  const [context, setContext] = useState<ContextType>("dm");
  const [users, setUsers] = useState<ChannelUserData[]>([]);
  const [code, setCode] = useState<{ value: string; expiresAt: number; context: ContextType }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    setCode(undefined);
    setUsers([]);
    setError(undefined);
    window.electronAPI
      .getGatewayUsers(channelId)
      .then((value) => {
        if (active) setUsers(value);
      })
      .catch(() => {
        if (active) setError("Could not load users.");
      });
    return () => {
      active = false;
    };
  }, [channelId]);
  const generate = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const value = await window.electronAPI.generateGatewayPairing(
        channelId,
        "",
        undefined,
        context,
      );
      setCode({ value, expiresAt: Date.now() + 300_000, context });
    } catch {
      setError("Could not generate pairing code.");
    } finally {
      setBusy(false);
    }
  };
  const changeGrant = async (user: ChannelUserData, grant: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      if (grant)
        await window.electronAPI.grantGatewayAccess(
          channelId,
          user.channelUserId,
          user.displayName,
          context,
        );
      else await window.electronAPI.revokeGatewayAccess(channelId, user.channelUserId, context);
      setUsers(await window.electronAPI.getGatewayUsers(channelId));
    } catch {
      setError("Could not update access.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="settings-section">
      <h4>Access by Context</h4>
      <p className="settings-description">
        Approve users separately for direct messages and groups. Existing unscoped approvals require
        re-pairing. Open mode and configured allowlists still apply.
      </p>
      <select
        aria-label="Access context"
        className="settings-select"
        value={context}
        disabled={busy}
        onChange={(event) => setContext(event.target.value as ContextType)}
      >
        <option value="dm">Direct messages</option>
        <option value="group">Group chats</option>
      </select>
      {/* DM codes come from the channel's own pairing section; generating one here
          would void that code because only the newest code per context is kept. */}
      {context === "group" ? (
        <button className="button-secondary" disabled={busy} onClick={generate}>
          Generate Group Pairing Code
        </button>
      ) : (
        <p className="settings-hint">
          Generate DM pairing codes in this channel's pairing section.
        </p>
      )}
      {context === "group" && code?.context === context && (
        <PairingCodeDisplay
          code={code.value}
          expiresAt={code.expiresAt}
          onRegenerate={generate}
          isRegenerating={busy}
        />
      )}
      {users
        .filter((user) => !user.channelUserId.startsWith("pending_"))
        .map((user) => {
          const granted = context === "dm" ? user.allowedDm : user.allowedGroup;
          return (
            <div className="user-item" key={user.id}>
              <span>
                {user.displayName} — {granted ? "Approved" : "No approval"} for{" "}
                {context === "dm" ? "DMs" : "groups"}
              </span>
              <button
                className="button-small button-secondary"
                disabled={busy}
                onClick={() => changeGrant(user, !granted)}
              >
                {granted ? "Revoke" : "Approve"} {context === "dm" ? "DMs" : "Groups"}
              </button>
            </div>
          );
        })}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
