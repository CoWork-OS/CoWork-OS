import { useEffect, useState, type CSSProperties } from "react";
import type {
  ContactIdentity,
  ContactIdentityCandidate,
  ContactIdentityCoverageStats,
  ContactIdentityHandleType,
  ContactIdentitySearchResult,
} from "../../shared/mailbox";

interface ContactIdentitySettingsProps {
  workspaceId?: string;
}

function statCard(label: string, value: number) {
  return (
    <div
      key={label}
      style={{
        padding: "14px",
        borderRadius: "12px",
        border: "1px solid var(--color-border-subtle)",
        background: "var(--color-bg-secondary)",
      }}
    >
      <div style={{ fontSize: "1.3rem", fontWeight: 700, color: "var(--color-text-primary)" }}>
        {value}
      </div>
      <div style={{ marginTop: "4px", fontSize: "0.76rem", color: "var(--color-text-muted)" }}>
        {label}
      </div>
    </div>
  );
}

function actionButtonStyle(kind: "default" | "danger" = "default"): CSSProperties {
  return {
    padding: "6px 10px",
    borderRadius: "8px",
    border: `1px solid ${kind === "danger" ? "rgba(204, 73, 73, 0.25)" : "var(--color-border-subtle)"}`,
    background: kind === "danger" ? "rgba(204, 73, 73, 0.08)" : "var(--color-bg-elevated)",
    color: kind === "danger" ? "var(--color-danger, #c44949)" : "var(--color-text-secondary)",
    fontSize: "0.75rem",
    cursor: "pointer",
  };
}

const MANUAL_HANDLE_TYPES: Array<{ value: ContactIdentityHandleType; label: string }> = [
  { value: "email", label: "Email" },
  { value: "slack_user_id", label: "Slack user" },
  { value: "teams_user_id", label: "Teams user" },
  { value: "whatsapp_e164", label: "WhatsApp phone" },
  { value: "signal_e164", label: "Signal phone" },
  { value: "imessage_handle", label: "iMessage handle" },
  { value: "crm_contact_id", label: "CRM contact ID" },
];

export function ContactIdentitySettings({ workspaceId }: ContactIdentitySettingsProps) {
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<ContactIdentityCoverageStats | null>(null);
  const [candidates, setCandidates] = useState<ContactIdentityCandidate[]>([]);
  const [identities, setIdentities] = useState<ContactIdentity[]>([]);
  const [manualSearchQuery, setManualSearchQuery] = useState("");
  const [manualSearchResults, setManualSearchResults] = useState<ContactIdentitySearchResult[]>([]);
  const [manualSearchLoading, setManualSearchLoading] = useState(false);
  const [manualTargetIdentityId, setManualTargetIdentityId] = useState("");
  const [manualHandleType, setManualHandleType] = useState<ContactIdentityHandleType>("email");
  const [manualHandleValue, setManualHandleValue] = useState("");
  const [manualHandleDisplayValue, setManualHandleDisplayValue] = useState("");
  const [manualBusyKey, setManualBusyKey] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [nextStats, nextCandidates] = await Promise.all([
        window.electronAPI.getContactIdentityCoverageStats(workspaceId),
        window.electronAPI.listIdentityCandidates(workspaceId),
      ]);
      setStats(nextStats);
      setCandidates(nextCandidates);
      setIdentities(await window.electronAPI.listContactIdentities(workspaceId));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [workspaceId]);

  const runAction = async (id: string, action: () => Promise<unknown>) => {
    try {
      setBusyId(id);
      await action();
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const runManualAction = async (id: string, action: () => Promise<unknown>) => {
    try {
      setManualBusyKey(id);
      await action();
      await load();
      if (manualSearchQuery.trim()) {
        await runManualSearch(manualSearchQuery.trim());
      }
    } finally {
      setManualBusyKey(null);
    }
  };

  const runManualSearch = async (query: string) => {
    if (!workspaceId || !query.trim()) {
      setManualSearchResults([]);
      return;
    }
    setManualSearchLoading(true);
    try {
      const results = await window.electronAPI.searchIdentityLinkTargets(
        workspaceId,
        query.trim(),
        24,
      );
      setManualSearchResults(results);
    } finally {
      setManualSearchLoading(false);
    }
  };

  const handleManualLink = async (result: ContactIdentitySearchResult) => {
    if (!workspaceId || !manualTargetIdentityId) return;
    await runManualAction(result.id, () =>
      window.electronAPI.linkIdentityHandle({
        workspaceId,
        contactIdentityId: manualTargetIdentityId,
        handleType: result.handleType,
        normalizedValue: result.normalizedValue,
        displayValue: manualHandleDisplayValue.trim() || result.displayValue,
        source: result.source,
        channelId: result.channelId,
        channelType: result.channelType,
        channelUserId: result.channelUserId,
      }),
    );
  };

  const sections: Array<{
    key: ContactIdentityCandidate["status"];
    title: string;
    empty: string;
  }> = [
    { key: "suggested", title: "Suggested links", empty: "No ambiguous matches need review." },
    { key: "confirmed", title: "Manually confirmed", empty: "No manually confirmed links yet." },
    { key: "rejected", title: "Rejected", empty: "No rejected links." },
    { key: "auto_linked", title: "Auto-linked", empty: "No exact high-confidence links yet." },
  ];

  return (
    <div className="more-channels-panel">
      <div className="more-channels-header">
        <h2>Identity Resolution</h2>
        <p className="settings-description">
          Review mailbox-to-channel matches, search explicit handles, and see coverage across Slack,
          Teams, WhatsApp, Signal, iMessage, and CRM-linked records.
        </p>
      </div>

      {loading ? (
        <div className="settings-card">Loading identity coverage…</div>
      ) : (
        <div style={{ display: "grid", gap: "16px" }}>
          <div
            style={{
              padding: "16px",
              borderRadius: "14px",
              border: "1px solid var(--color-border-subtle)",
              background:
                "linear-gradient(180deg, rgba(124,92,191,0.08) 0%, var(--color-bg-secondary) 100%)",
            }}
          >
            <div
              style={{ fontSize: "0.92rem", fontWeight: 700, color: "var(--color-text-primary)" }}
            >
              Manual search and link
            </div>
            <div
              style={{
                marginTop: "4px",
                fontSize: "0.78rem",
                color: "var(--color-text-muted)",
                lineHeight: 1.5,
              }}
            >
              Search for a channel user, Signal number, iMessage handle, or CRM record, then
              explicitly attach it to the chosen identity.
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 0.8fr) auto",
                gap: "8px",
                marginTop: "12px",
              }}
            >
              <input
                value={manualSearchQuery}
                onChange={(event) => setManualSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void runManualSearch(manualSearchQuery);
                  }
                }}
                placeholder="Search by name, email, handle, phone, or CRM ID"
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "10px 12px",
                  borderRadius: "10px",
                  border: "1px solid var(--color-border)",
                  background: "var(--color-bg-input)",
                  color: "var(--color-text-primary)",
                  fontSize: "0.8rem",
                }}
              />
              <select
                value={manualTargetIdentityId}
                onChange={(event) => setManualTargetIdentityId(event.target.value)}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "10px 12px",
                  borderRadius: "10px",
                  border: "1px solid var(--color-border)",
                  background: "var(--color-bg-input)",
                  color: "var(--color-text-primary)",
                  fontSize: "0.8rem",
                }}
              >
                <option value="">Choose target identity</option>
                {identities.map((identity) => (
                  <option key={identity.id} value={identity.id}>
                    {identity.displayName}
                    {identity.primaryEmail ? ` · ${identity.primaryEmail}` : ""}
                  </option>
                ))}
              </select>
              <button
                type="button"
                style={actionButtonStyle()}
                onClick={() => void runManualSearch(manualSearchQuery)}
                disabled={manualSearchLoading || !workspaceId || !manualSearchQuery.trim()}
              >
                {manualSearchLoading ? "Searching..." : "Search"}
              </button>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                gap: "8px",
                marginTop: "10px",
              }}
            >
              <select
                value={manualHandleType}
                onChange={(event) =>
                  setManualHandleType(event.target.value as ContactIdentityHandleType)
                }
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "9px 11px",
                  borderRadius: "10px",
                  border: "1px solid var(--color-border)",
                  background: "var(--color-bg-input)",
                  color: "var(--color-text-primary)",
                  fontSize: "0.78rem",
                }}
              >
                {MANUAL_HANDLE_TYPES.map((handleType) => (
                  <option key={handleType.value} value={handleType.value}>
                    {handleType.label}
                  </option>
                ))}
              </select>
              <input
                value={manualHandleValue}
                onChange={(event) => setManualHandleValue(event.target.value)}
                placeholder="Handle or record value"
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "9px 11px",
                  borderRadius: "10px",
                  border: "1px solid var(--color-border)",
                  background: "var(--color-bg-input)",
                  color: "var(--color-text-primary)",
                  fontSize: "0.78rem",
                }}
              />
              <input
                value={manualHandleDisplayValue}
                onChange={(event) => setManualHandleDisplayValue(event.target.value)}
                placeholder="Display label"
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "9px 11px",
                  borderRadius: "10px",
                  border: "1px solid var(--color-border)",
                  background: "var(--color-bg-input)",
                  color: "var(--color-text-primary)",
                  fontSize: "0.78rem",
                }}
              />
            </div>

            <div style={{ marginTop: "10px", display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <button
                type="button"
                style={actionButtonStyle()}
                onClick={() => {
                  setManualHandleValue(manualSearchQuery.trim());
                  setManualHandleDisplayValue(manualSearchQuery.trim());
                }}
                disabled={!manualSearchQuery.trim()}
              >
                Copy search into manual link
              </button>
              <button
                type="button"
                style={actionButtonStyle()}
                onClick={() => {
                  setManualSearchQuery("");
                  setManualSearchResults([]);
                }}
              >
                Clear search
              </button>
              <button
                type="button"
                style={actionButtonStyle()}
                onClick={() => {
                  if (!workspaceId || !manualTargetIdentityId || !manualHandleValue.trim()) return;
                  void runManualAction(`manual:${manualTargetIdentityId}:${manualHandleType}`, () =>
                    window.electronAPI.linkIdentityHandle({
                      workspaceId,
                      contactIdentityId: manualTargetIdentityId,
                      handleType: manualHandleType,
                      normalizedValue: manualHandleValue.trim(),
                      displayValue: manualHandleDisplayValue.trim() || manualHandleValue.trim(),
                      source: "manual",
                    }),
                  );
                }}
                disabled={!workspaceId || !manualTargetIdentityId || !manualHandleValue.trim()}
              >
                Link manual handle
              </button>
            </div>

            {!!manualSearchResults.length && (
              <div style={{ marginTop: "14px", display: "grid", gap: "8px" }}>
                {manualSearchResults.map((result) => (
                  <div
                    key={result.id}
                    style={{
                      padding: "12px",
                      borderRadius: "12px",
                      border: "1px solid var(--color-border-subtle)",
                      background: "var(--color-bg-elevated)",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: "10px" }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div
                          style={{
                            fontSize: "0.84rem",
                            fontWeight: 600,
                            color: "var(--color-text-primary)",
                          }}
                        >
                          {result.displayValue}
                        </div>
                        <div
                          style={{
                            marginTop: "4px",
                            fontSize: "0.74rem",
                            color: "var(--color-text-muted)",
                          }}
                        >
                          {result.sourceLabel} · {result.handleType} ·{" "}
                          {Math.round(result.confidence * 100)}% match
                        </div>
                        <div
                          style={{
                            marginTop: "4px",
                            fontSize: "0.72rem",
                            color: "var(--color-text-secondary)",
                          }}
                        >
                          {result.normalizedValue}
                          {result.linkedIdentityName
                            ? ` · linked to ${result.linkedIdentityName}`
                            : ""}
                        </div>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          gap: "6px",
                          flexWrap: "wrap",
                          justifyContent: "flex-end",
                        }}
                      >
                        <button
                          type="button"
                          style={actionButtonStyle()}
                          onClick={() => {
                            setManualHandleType(result.handleType);
                            setManualHandleValue(result.normalizedValue);
                            setManualHandleDisplayValue(result.displayValue);
                          }}
                        >
                          Fill form
                        </button>
                        <button
                          type="button"
                          style={actionButtonStyle()}
                          onClick={() => void handleManualLink(result)}
                          disabled={
                            manualBusyKey === result.id || !manualTargetIdentityId || !workspaceId
                          }
                        >
                          {manualBusyKey === result.id ? "Linking..." : "Link"}
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
              gap: "10px",
            }}
          >
            {statCard("Resolved mailbox contacts", stats?.resolvedMailboxContacts || 0)}
            {statCard("Suggested links", stats?.suggestedLinks || 0)}
            {statCard("Confirmed links", stats?.confirmedLinks || 0)}
            {statCard("Rejected links", stats?.rejectedLinks || 0)}
            {statCard("Unresolved Slack users", stats?.unresolvedSlackUsers || 0)}
            {statCard("Unresolved Teams users", stats?.unresolvedTeamsUsers || 0)}
            {statCard("Unresolved WhatsApp users", stats?.unresolvedWhatsAppUsers || 0)}
            {statCard("Unresolved Signal users", stats?.unresolvedSignalUsers || 0)}
            {statCard("Unresolved iMessage users", stats?.unresolvedImessageUsers || 0)}
            {statCard("Resolved CRM contacts", stats?.resolvedCrmContacts || 0)}
          </div>

          {sections.map((section) => {
            const items = candidates.filter((candidate) => candidate.status === section.key);
            return (
              <div
                key={section.key}
                style={{
                  padding: "14px",
                  borderRadius: "12px",
                  border: "1px solid var(--color-border-subtle)",
                  background: "var(--color-bg-secondary)",
                }}
              >
                <div
                  style={{
                    fontSize: "0.92rem",
                    fontWeight: 700,
                    color: "var(--color-text-primary)",
                  }}
                >
                  {section.title}
                </div>
                {items.length === 0 ? (
                  <div
                    style={{
                      marginTop: "10px",
                      fontSize: "0.78rem",
                      color: "var(--color-text-muted)",
                    }}
                  >
                    {section.empty}
                  </div>
                ) : (
                  <div style={{ display: "grid", gap: "10px", marginTop: "12px" }}>
                    {items.map((candidate) => {
                      const identity = identities.find(
                        (item) => item.id === candidate.contactIdentityId,
                      );
                      const linkedHandle = identity?.handles.find(
                        (handle) =>
                          handle.handleType === candidate.handleType &&
                          handle.normalizedValue === candidate.normalizedValue,
                      );
                      return (
                        <div
                          key={candidate.id}
                          style={{
                            padding: "12px",
                            borderRadius: "10px",
                            border: "1px solid var(--color-border-subtle)",
                            background: "var(--color-bg-elevated)",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              gap: "12px",
                              alignItems: "flex-start",
                            }}
                          >
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div
                                style={{
                                  fontSize: "0.84rem",
                                  fontWeight: 600,
                                  color: "var(--color-text-primary)",
                                }}
                              >
                                {identity?.displayName || "Unknown identity"} →{" "}
                                {candidate.sourceLabel}
                              </div>
                              <div
                                style={{
                                  marginTop: "4px",
                                  fontSize: "0.76rem",
                                  color: "var(--color-text-secondary)",
                                }}
                              >
                                {candidate.displayValue}
                              </div>
                              <div
                                style={{
                                  marginTop: "4px",
                                  fontSize: "0.72rem",
                                  color: "var(--color-text-muted)",
                                }}
                              >
                                {Math.round(candidate.confidence * 100)}% confidence ·{" "}
                                {candidate.reasonCodes.join(" · ")}
                              </div>
                              {identity?.handles?.length ? (
                                <div
                                  style={{
                                    marginTop: "6px",
                                    fontSize: "0.72rem",
                                    color: "var(--color-text-muted)",
                                  }}
                                >
                                  Linked:{" "}
                                  {identity.handles
                                    .map((handle) => handle.channelType || handle.handleType)
                                    .join(" · ")}
                                </div>
                              ) : null}
                            </div>
                            <div
                              style={{
                                display: "flex",
                                gap: "6px",
                                flexWrap: "wrap",
                                justifyContent: "flex-end",
                              }}
                            >
                              {section.key === "suggested" && (
                                <>
                                  <button
                                    style={actionButtonStyle()}
                                    onClick={() =>
                                      void runAction(candidate.id, () =>
                                        window.electronAPI.confirmIdentityLink(candidate.id),
                                      )
                                    }
                                    disabled={busyId === candidate.id}
                                  >
                                    Confirm
                                  </button>
                                  <button
                                    style={actionButtonStyle("danger")}
                                    onClick={() =>
                                      void runAction(candidate.id, () =>
                                        window.electronAPI.rejectIdentityLink(candidate.id),
                                      )
                                    }
                                    disabled={busyId === candidate.id}
                                  >
                                    Reject
                                  </button>
                                </>
                              )}
                              {(section.key === "confirmed" || section.key === "auto_linked") &&
                                linkedHandle && (
                                  <button
                                    style={actionButtonStyle("danger")}
                                    onClick={() =>
                                      void runAction(candidate.id, () =>
                                        window.electronAPI.unlinkIdentityHandle(linkedHandle.id),
                                      )
                                    }
                                    disabled={busyId === candidate.id}
                                  >
                                    Unlink
                                  </button>
                                )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
