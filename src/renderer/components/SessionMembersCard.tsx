import { useEffect, useState } from "react";
import { Check, Copy, UserPlus, Users } from "lucide-react";
import type { SessionHumanRole, SessionShareSnapshot, Task } from "../../shared/types";

interface SessionMembersCardProps {
  task?: Task;
  refreshKey?: string | number;
}

const INVITE_ROLES: Array<Exclude<SessionHumanRole, "owner">> = [
  "contributor",
  "reviewer",
  "viewer",
];

function roleLabel(role: SessionHumanRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function presenceLabel(lastSeenAt?: number): string {
  if (!lastSeenAt) return "Not seen yet";
  return Date.now() - lastSeenAt < 2 * 60 * 1000 ? "Active now" : "Away";
}

export function SessionMembersCard({ task, refreshKey }: SessionMembersCardProps) {
  const [snapshot, setSnapshot] = useState<SessionShareSnapshot>();
  const [inviteRole, setInviteRole] = useState<Exclude<SessionHumanRole, "owner">>("reviewer");
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [inviteTokenInput, setInviteTokenInput] = useState("");
  const [displayName, setDisplayName] = useState("Session participant");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!task?.id || !window.electronAPI?.getSessionMembers) {
      setSnapshot(undefined);
      return;
    }
    setError(null);
    void window.electronAPI
      .getSessionMembers({ taskId: task.id })
      .then((next) => {
        if (!cancelled) setSnapshot(next);
      })
      .catch((cause) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : "Unable to load members.");
      });
    return () => {
      cancelled = true;
    };
  }, [task?.id, refreshKey]);

  if (!task) return null;

  const acceptInvite = async () => {
    if (!inviteTokenInput.trim() || !displayName.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.acceptSessionInvite({
        token: inviteTokenInput.trim(),
        displayName: displayName.trim(),
      });
      setInviteTokenInput("");
      setSnapshot(
        await window.electronAPI.getSessionMembers({ contextId: result.member.contextId }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to accept invite.");
    } finally {
      setBusy(false);
    }
  };

  if (!snapshot) {
    return (
      <section className="session-members-card" aria-label="Join shared session">
        <div className="session-members-card-header">
          <span className="session-members-card-label">
            <Users size={13} aria-hidden="true" />
            Join shared session
          </span>
        </div>
        <p className="session-members-card-help">
          Paste a local invite token to join this session. Your access is limited by the invited
          role.
        </p>
        <div className="session-members-card-join">
          <input
            aria-label="Invite token"
            placeholder="Paste invite token"
            value={inviteTokenInput}
            onChange={(event) => setInviteTokenInput(event.target.value)}
            disabled={busy}
          />
          <input
            aria-label="Display name"
            placeholder="Your display name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            disabled={busy}
          />
          <button
            type="button"
            onClick={() => void acceptInvite()}
            disabled={busy || !inviteTokenInput.trim() || !displayName.trim()}
          >
            {busy ? "Joining…" : "Join session"}
          </button>
        </div>
        {error ? (
          <div className="session-members-card-error" role="alert">
            {error}
          </div>
        ) : null}
      </section>
    );
  }

  const createInvite = async () => {
    if (snapshot.actor.role !== "owner" || busy) return;
    setBusy(true);
    setError(null);
    setInviteToken(null);
    setCopied(false);
    try {
      const result = await window.electronAPI.createSessionInvite({
        contextId: snapshot.contextId,
        role: inviteRole,
      });
      setInviteToken(result.token);
      setSnapshot(await window.electronAPI.getSessionMembers({ contextId: snapshot.contextId }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create invite.");
    } finally {
      setBusy(false);
    }
  };

  const copyInvite = async () => {
    if (!inviteToken) return;
    try {
      await navigator.clipboard.writeText(inviteToken);
      setCopied(true);
    } catch {
      setError("Copy failed. Select the token and copy it manually.");
    }
  };

  const revokeMember = async (memberId: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await window.electronAPI.updateSessionMember({
        contextId: snapshot.contextId,
        memberId,
        revoke: true,
      });
      setSnapshot(await window.electronAPI.getSessionMembers({ contextId: snapshot.contextId }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to revoke member.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="session-members-card" aria-label="Session members">
      <div className="session-members-card-header">
        <span className="session-members-card-label">
          <Users size={13} aria-hidden="true" />
          Shared session
        </span>
        <span className="session-members-card-count">
          {snapshot.members.filter((member) => member.status === "active").length} members
        </span>
      </div>
      <div className="session-members-card-list">
        {snapshot.members.map((member) => (
          <div className="session-member-row" key={member.id}>
            <span className={`session-member-dot ${member.status}`} aria-hidden="true" />
            <span className="session-member-name">{member.displayName}</span>
            <span className="session-member-role">{roleLabel(member.role)}</span>
            <span className="session-member-presence">{presenceLabel(member.lastSeenAt)}</span>
            {snapshot.actor.role === "owner" &&
            member.id !== snapshot.actor.id &&
            member.status === "active" ? (
              <button
                type="button"
                className="session-member-revoke"
                onClick={() => void revokeMember(member.id)}
                disabled={busy}
              >
                Revoke
              </button>
            ) : null}
          </div>
        ))}
      </div>
      {snapshot.actor.role === "owner" ? (
        <div className="session-members-card-actions">
          <select
            aria-label="Invite role"
            value={inviteRole}
            onChange={(event) => setInviteRole(event.target.value as typeof inviteRole)}
            disabled={busy}
          >
            {INVITE_ROLES.map((role) => (
              <option key={role} value={role}>
                {roleLabel(role)}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => void createInvite()} disabled={busy}>
            <UserPlus size={12} aria-hidden="true" />
            {busy ? "Creating…" : "Create local invite"}
          </button>
        </div>
      ) : null}
      {inviteToken ? (
        <div className="session-invite-token">
          <div>
            <strong>Local-only invite token</strong>
            <span>Usable only in this CoWork installation. It expires in 24 hours.</span>
          </div>
          <code>{inviteToken}</code>
          <button type="button" onClick={() => void copyInvite()} aria-label="Copy invite token">
            {copied ? (
              <Check size={12} aria-hidden="true" />
            ) : (
              <Copy size={12} aria-hidden="true" />
            )}
          </button>
        </div>
      ) : null}
      {error ? (
        <div className="session-members-card-error" role="alert">
          {error}
        </div>
      ) : null}
    </section>
  );
}
