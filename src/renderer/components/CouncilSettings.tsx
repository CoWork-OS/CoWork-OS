import { useEffect, useMemo, useState } from "react";
import type {
  CouncilConfig,
  CouncilMemo,
  CouncilParticipant,
  CouncilRun,
  CreateCouncilConfigRequest,
  LLMProviderType,
  UpdateCouncilConfigRequest,
  Workspace,
} from "../../shared/types";
import { BUILTIN_LLM_PROVIDER_TYPES, MULTI_LLM_PROVIDER_DISPLAY } from "../../shared/types";

type GatewayChannel = {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  status: string;
};

type CouncilDraft = {
  workspaceId: string;
  name: string;
  enabled: boolean;
  scheduleExpr: string;
  participants: CouncilParticipant[];
  judgeSeatIndex: number;
  rotatingIdeaSeatIndex: number;
  sourceBundle: CouncilConfig["sourceBundle"];
  deliveryConfig: CouncilConfig["deliveryConfig"];
  executionPolicy: CouncilConfig["executionPolicy"];
};

const DEFAULT_SCHEDULE = "0 9,17 * * *";

function createDefaultParticipant(index: number): CouncilParticipant {
  return {
    providerType: "ollama",
    modelKey: "",
    seatLabel: `Seat ${index + 1}`,
    roleInstruction: "",
  };
}

function createDraft(workspaceId: string): CouncilDraft {
  return {
    workspaceId,
    name: "R&D Council",
    enabled: true,
    scheduleExpr: DEFAULT_SCHEDULE,
    participants: [createDefaultParticipant(0), createDefaultParticipant(1)],
    judgeSeatIndex: 0,
    rotatingIdeaSeatIndex: 0,
    sourceBundle: {
      files: [],
      urls: [],
      connectors: [],
    },
    deliveryConfig: {
      enabled: false,
      channelDbId: "",
      channelId: "",
    },
    executionPolicy: {
      mode: "auto",
    },
  };
}

function draftFromConfig(config: CouncilConfig): CouncilDraft {
  return {
    workspaceId: config.workspaceId,
    name: config.name,
    enabled: config.enabled,
    scheduleExpr: config.schedule.kind === "cron" ? config.schedule.expr : DEFAULT_SCHEDULE,
    participants: config.participants.map((participant) => ({
      ...participant,
      roleInstruction: participant.roleInstruction || "",
    })),
    judgeSeatIndex: config.judgeSeatIndex,
    rotatingIdeaSeatIndex: config.rotatingIdeaSeatIndex,
    sourceBundle: {
      files: [...config.sourceBundle.files],
      urls: [...config.sourceBundle.urls],
      connectors: [...config.sourceBundle.connectors],
    },
    deliveryConfig: {
      enabled: config.deliveryConfig.enabled,
      channelType: config.deliveryConfig.channelType,
      channelDbId: config.deliveryConfig.channelDbId || "",
      channelId: config.deliveryConfig.channelId || "",
    },
    executionPolicy: {
      mode: config.executionPolicy.mode,
      maxParallelParticipants: config.executionPolicy.maxParallelParticipants,
    },
  };
}

function formatDateTime(value?: number): string {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

function buildPayload(draft: CouncilDraft): CreateCouncilConfigRequest {
  return {
    workspaceId: draft.workspaceId,
    name: draft.name.trim(),
    enabled: draft.enabled,
    schedule: {
      kind: "cron",
      expr: draft.scheduleExpr.trim() || DEFAULT_SCHEDULE,
    },
    participants: draft.participants.map((participant, index) => ({
      providerType: participant.providerType,
      modelKey: participant.modelKey.trim(),
      seatLabel: participant.seatLabel.trim() || `Seat ${index + 1}`,
      roleInstruction: participant.roleInstruction?.trim() || undefined,
    })),
    judgeSeatIndex: draft.judgeSeatIndex,
    rotatingIdeaSeatIndex: draft.rotatingIdeaSeatIndex,
    sourceBundle: draft.sourceBundle,
    deliveryConfig: {
      enabled: draft.deliveryConfig.enabled,
      channelType: draft.deliveryConfig.channelType,
      channelDbId: draft.deliveryConfig.channelDbId || undefined,
      channelId: draft.deliveryConfig.channelId?.trim() || undefined,
    },
    executionPolicy: {
      mode: draft.executionPolicy.mode,
      maxParallelParticipants: draft.executionPolicy.maxParallelParticipants || undefined,
    },
  };
}

export function CouncilSettings({
  workspaceId,
  onOpenTask,
}: {
  workspaceId?: string;
  onOpenTask?: (taskId: string) => void;
}) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [channels, setChannels] = useState<GatewayChannel[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(workspaceId || "");
  const [councils, setCouncils] = useState<CouncilConfig[]>([]);
  const [selectedCouncilId, setSelectedCouncilId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CouncilDraft>(() => createDraft(workspaceId || ""));
  const [runs, setRuns] = useState<CouncilRun[]>([]);
  const [memo, setMemo] = useState<CouncilMemo | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [urlDraft, setUrlDraft] = useState({ label: "", url: "" });
  const [connectorDraft, setConnectorDraft] = useState({
    provider: "",
    label: "",
    resourceId: "",
    notes: "",
  });

  const selectedChannel = useMemo(
    () => channels.find((channel) => channel.id === draft.deliveryConfig.channelDbId),
    [channels, draft.deliveryConfig.channelDbId],
  );
  const isAllLocal =
    draft.participants.length > 0 &&
    draft.participants.every((participant) => participant.providerType === "ollama");

  const loadRunsAndMemo = async (councilId: string) => {
    const [runList, latestMemo] = await Promise.all([
      window.electronAPI.listCouncilRuns({ councilConfigId: councilId, limit: 20 }),
      window.electronAPI.getCouncilMemo({ councilConfigId: councilId }),
    ]);
    setRuns(runList);
    setMemo(latestMemo);
  };

  const loadCouncils = async (targetWorkspaceId: string, preferredCouncilId?: string | null) => {
    if (!targetWorkspaceId) {
      setCouncils([]);
      setSelectedCouncilId(null);
      setRuns([]);
      setMemo(null);
      setDraft(createDraft(""));
      return;
    }
    const list = await window.electronAPI.listCouncils(targetWorkspaceId);
    setCouncils(list);

    const nextSelectedId =
      preferredCouncilId && list.some((item) => item.id === preferredCouncilId)
        ? preferredCouncilId
        : list[0]?.id || null;
    setSelectedCouncilId(nextSelectedId);

    if (!nextSelectedId) {
      setDraft(createDraft(targetWorkspaceId));
      setRuns([]);
      setMemo(null);
      return;
    }

    const selected = list.find((item) => item.id === nextSelectedId);
    if (selected) {
      setDraft(draftFromConfig(selected));
      await loadRunsAndMemo(selected.id);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const loadInitial = async () => {
      try {
        setLoading(true);
        const [workspaceList, gatewayChannels] = await Promise.all([
          window.electronAPI.listWorkspaces(),
          window.electronAPI.getGatewayChannels(),
        ]);
        if (cancelled) return;
        setWorkspaces(workspaceList);
        setChannels(gatewayChannels.filter((channel: GatewayChannel) => channel.enabled));

        const nextWorkspaceId = workspaceId || workspaceList[0]?.id || "";
        setSelectedWorkspaceId(nextWorkspaceId);
        setDraft(createDraft(nextWorkspaceId));
        await loadCouncils(nextWorkspaceId);
      } catch (loadError: Any) {
        if (!cancelled) {
          setError(loadError?.message || "Failed to load council settings.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    void loadInitial();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const selectCouncil = async (councilId: string | null) => {
    setError(null);
    setSelectedCouncilId(councilId);
    if (!councilId) {
      setDraft(createDraft(selectedWorkspaceId));
      setRuns([]);
      setMemo(null);
      return;
    }
    const config =
      councils.find((item) => item.id === councilId) ||
      (await window.electronAPI.getCouncil(councilId));
    if (!config) return;
    setDraft(draftFromConfig(config));
    await loadRunsAndMemo(config.id);
  };

  const updateParticipant = (
    index: number,
    key: keyof CouncilParticipant,
    value: string | LLMProviderType,
  ) => {
    setDraft((current) => ({
      ...current,
      participants: current.participants.map((participant, participantIndex) =>
        participantIndex === index ? { ...participant, [key]: value } : participant,
      ),
    }));
  };

  const validateDraft = (): string | null => {
    if (!draft.workspaceId) return "Workspace is required.";
    if (!draft.name.trim()) return "Council name is required.";
    if (!draft.scheduleExpr.trim()) return "Cron schedule is required.";
    if (draft.participants.length < 2 || draft.participants.length > 8) {
      return "Councils must have between 2 and 8 participants.";
    }
    for (let i = 0; i < draft.participants.length; i += 1) {
      const participant = draft.participants[i];
      if (!participant.modelKey.trim()) {
        return `Participant ${i + 1} is missing a model key.`;
      }
      if (!participant.seatLabel.trim()) {
        return `Participant ${i + 1} is missing a seat label.`;
      }
    }
    if (draft.deliveryConfig.enabled) {
      if (!draft.deliveryConfig.channelDbId) {
        return "Select a gateway channel account for memo delivery.";
      }
      if (!draft.deliveryConfig.channelId?.trim()) {
        return "Enter the destination chat/channel ID for memo delivery.";
      }
    }
    return null;
  };

  const handleSave = async () => {
    const validationError = validateDraft();
    if (validationError) {
      setError(validationError);
      return;
    }

    try {
      setSaving(true);
      setError(null);
      const payload = buildPayload(draft);
      let saved: CouncilConfig | null;
      if (selectedCouncilId) {
        const updatePayload: UpdateCouncilConfigRequest = {
          id: selectedCouncilId,
          name: payload.name,
          enabled: payload.enabled,
          schedule: payload.schedule,
          participants: payload.participants,
          judgeSeatIndex: payload.judgeSeatIndex,
          rotatingIdeaSeatIndex: payload.rotatingIdeaSeatIndex,
          sourceBundle: payload.sourceBundle as CouncilConfig["sourceBundle"],
          deliveryConfig: payload.deliveryConfig as CouncilConfig["deliveryConfig"],
          executionPolicy: payload.executionPolicy as CouncilConfig["executionPolicy"],
        };
        saved = await window.electronAPI.updateCouncil(updatePayload);
      } else {
        saved = await window.electronAPI.createCouncil(payload);
      }
      if (!saved) {
        throw new Error("Council save failed.");
      }
      await loadCouncils(saved.workspaceId, saved.id);
    } catch (saveError: Any) {
      setError(saveError?.message || "Failed to save council.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedCouncilId) return;
    try {
      setSaving(true);
      setError(null);
      await window.electronAPI.deleteCouncil(selectedCouncilId);
      await loadCouncils(selectedWorkspaceId, null);
    } catch (deleteError: Any) {
      setError(deleteError?.message || "Failed to delete council.");
    } finally {
      setSaving(false);
    }
  };

  const handleRunNow = async () => {
    if (!selectedCouncilId) return;
    try {
      setRunning(true);
      setError(null);
      await window.electronAPI.runCouncilNow(selectedCouncilId);
      await loadRunsAndMemo(selectedCouncilId);
    } catch (runError: Any) {
      setError(runError?.message || "Failed to start council run.");
    } finally {
      setRunning(false);
    }
  };

  const handleWorkspaceChange = async (nextWorkspaceId: string) => {
    setSelectedWorkspaceId(nextWorkspaceId);
    setDraft(createDraft(nextWorkspaceId));
    setSelectedCouncilId(null);
    setRuns([]);
    setMemo(null);
    await loadCouncils(nextWorkspaceId, null);
  };

  if (loading) {
    return <div className="settings-description">Loading council settings…</div>;
  }

  return (
    <div className="council-settings">
      <div className="council-settings-sidebar">
        <div className="settings-section">
          <div className="settings-section-header">
            <div>
              <h3>Workspace Councils</h3>
              <p className="settings-description">
                Each council owns one managed cron job and keeps its own memo history.
              </p>
            </div>
          </div>
          <div className="form-group">
            <label>Workspace</label>
            <select
              value={selectedWorkspaceId}
              onChange={(event) => {
                void handleWorkspaceChange(event.target.value);
              }}
            >
              {workspaces.map((workspaceOption) => (
                <option key={workspaceOption.id} value={workspaceOption.id}>
                  {workspaceOption.name}
                </option>
              ))}
            </select>
          </div>
          <button
            className="btn btn-secondary"
            type="button"
            onClick={() => {
              void selectCouncil(null);
            }}
          >
            New Council
          </button>
          <div className="council-list">
            {councils.map((council) => (
              <button
                key={council.id}
                type="button"
                className={`council-list-item ${selectedCouncilId === council.id ? "active" : ""}`}
                onClick={() => {
                  void selectCouncil(council.id);
                }}
              >
                <div className="council-list-item-header">
                  <strong>{council.name}</strong>
                  <span
                    className={`council-status-pill ${council.enabled ? "enabled" : "disabled"}`}
                  >
                    {council.enabled ? "Enabled" : "Disabled"}
                  </span>
                </div>
                <span className="council-list-item-meta">
                  {council.participants.length} seats •{" "}
                  {council.schedule.kind === "cron" ? council.schedule.expr : council.schedule.kind}
                </span>
              </button>
            ))}
            {councils.length === 0 && (
              <div className="settings-description">
                No councils configured for this workspace yet.
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="council-settings-main">
        <div className="settings-section">
          <div className="settings-section-header">
            <div>
              <h3>{selectedCouncilId ? "Edit Council" : "Create Council"}</h3>
              <p className="settings-description">
                Configure the participant seats, curated sources, memo delivery, and execution
                policy.
              </p>
            </div>
            <div className="settings-section-actions">
              {selectedCouncilId && (
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() => {
                    void window.electronAPI
                      .setCouncilEnabled(selectedCouncilId, !draft.enabled)
                      .then((updated) => {
                        if (!updated) return;
                        setDraft(draftFromConfig(updated));
                        void loadCouncils(updated.workspaceId, updated.id);
                      })
                      .catch((toggleError: Any) => {
                        setError(toggleError?.message || "Failed to update council state.");
                      });
                  }}
                >
                  {draft.enabled ? "Disable" : "Enable"}
                </button>
              )}
              {selectedCouncilId && (
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() => void handleRunNow()}
                  disabled={running}
                >
                  {running ? "Running…" : "Run Now"}
                </button>
              )}
              {selectedCouncilId && (
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() => void handleDelete()}
                  disabled={saving}
                >
                  Delete
                </button>
              )}
              <button
                className="btn btn-primary"
                type="button"
                onClick={() => void handleSave()}
                disabled={saving}
              >
                {saving ? "Saving…" : selectedCouncilId ? "Save Changes" : "Create Council"}
              </button>
            </div>
          </div>

          {error && <div className="council-error">{error}</div>}

          <div className="form-row">
            <div className="form-group form-group-flex">
              <label>Name</label>
              <input
                type="text"
                value={draft.name}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, name: event.target.value }))
                }
              />
            </div>
            <div className="form-group form-group-flex">
              <label>Schedule (cron)</label>
              <input
                type="text"
                value={draft.scheduleExpr}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, scheduleExpr: event.target.value }))
                }
                placeholder={DEFAULT_SCHEDULE}
              />
            </div>
          </div>

          <div className="form-row">
            <div className="form-group form-group-flex">
              <label>Judge Seat</label>
              <select
                value={draft.judgeSeatIndex}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    judgeSeatIndex: Number(event.target.value),
                  }))
                }
              >
                {draft.participants.map((participant, index) => (
                  <option key={`${participant.seatLabel}-${index}`} value={index}>
                    {participant.seatLabel || `Seat ${index + 1}`}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group form-group-flex">
              <label>Rotating Idea Seat</label>
              <select
                value={draft.rotatingIdeaSeatIndex}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    rotatingIdeaSeatIndex: Number(event.target.value),
                  }))
                }
              >
                {draft.participants.map((participant, index) => (
                  <option key={`${participant.seatLabel}-idea-${index}`} value={index}>
                    {participant.seatLabel || `Seat ${index + 1}`}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group form-group-flex">
              <label>Execution Policy</label>
              <select
                value={draft.executionPolicy.mode}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    executionPolicy: {
                      ...current.executionPolicy,
                      mode: event.target.value as CouncilConfig["executionPolicy"]["mode"],
                    },
                  }))
                }
              >
                <option value="auto">Auto</option>
                <option value="full_parallel">Full Parallel</option>
                <option value="capped_local">Capped Local</option>
              </select>
            </div>
            <div className="form-group form-group-sm">
              <label>Max Parallel</label>
              <input
                type="number"
                min={1}
                max={8}
                value={draft.executionPolicy.maxParallelParticipants || ""}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    executionPolicy: {
                      ...current.executionPolicy,
                      maxParallelParticipants: event.target.value
                        ? Number(event.target.value)
                        : undefined,
                    },
                  }))
                }
                placeholder={isAllLocal ? "2" : `${draft.participants.length}`}
              />
            </div>
          </div>

          <div className="settings-description">
            {isAllLocal
              ? "All seats are Ollama. Auto mode will cap parallel launches to 2 unless you override it."
              : "Mixed-provider councils default to full participant parallelism in auto mode."}
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-header">
            <div>
              <h3>Participants</h3>
              <p className="settings-description">
                Duplicate provider rows are supported. Use multiple Ollama seats if you want an
                all-local council.
              </p>
            </div>
            <div className="settings-section-actions">
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    participants: [
                      ...current.participants,
                      createDefaultParticipant(current.participants.length),
                    ],
                  }))
                }
                disabled={draft.participants.length >= 8}
              >
                Add Seat
              </button>
            </div>
          </div>
          <div className="council-seat-grid">
            {draft.participants.map((participant, index) => {
              const providerMeta = MULTI_LLM_PROVIDER_DISPLAY[participant.providerType] || {
                name: participant.providerType,
                icon: "•",
              };
              return (
                <div key={`${participant.seatLabel}-${index}`} className="council-seat-card">
                  <div className="council-seat-card-header">
                    <strong>
                      {providerMeta.icon} Seat {index + 1}
                    </strong>
                    <button
                      className="btn btn-secondary"
                      type="button"
                      onClick={() =>
                        setDraft((current) => {
                          const participants = current.participants.filter(
                            (_, itemIndex) => itemIndex !== index,
                          );
                          const nextLength = participants.length;
                          return {
                            ...current,
                            participants,
                            judgeSeatIndex: Math.min(
                              current.judgeSeatIndex,
                              Math.max(0, nextLength - 1),
                            ),
                            rotatingIdeaSeatIndex: Math.min(
                              current.rotatingIdeaSeatIndex,
                              Math.max(0, nextLength - 1),
                            ),
                          };
                        })
                      }
                      disabled={draft.participants.length <= 2}
                    >
                      Remove
                    </button>
                  </div>
                  <div className="form-group">
                    <label>Seat Label</label>
                    <input
                      type="text"
                      value={participant.seatLabel}
                      onChange={(event) =>
                        updateParticipant(index, "seatLabel", event.target.value)
                      }
                    />
                  </div>
                  <div className="form-row">
                    <div className="form-group form-group-flex">
                      <label>Provider</label>
                      <select
                        value={participant.providerType}
                        onChange={(event) =>
                          updateParticipant(
                            index,
                            "providerType",
                            event.target.value as LLMProviderType,
                          )
                        }
                      >
                        {BUILTIN_LLM_PROVIDER_TYPES.map((provider) => (
                          <option key={provider} value={provider}>
                            {MULTI_LLM_PROVIDER_DISPLAY[provider]?.name || provider}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="form-group form-group-flex">
                      <label>Model Key</label>
                      <input
                        type="text"
                        value={participant.modelKey}
                        onChange={(event) =>
                          updateParticipant(index, "modelKey", event.target.value)
                        }
                        placeholder="llama3.2, gpt-4o, gemini-2.0-flash..."
                      />
                    </div>
                  </div>
                  <div className="form-group">
                    <label>Role Instruction</label>
                    <textarea
                      value={participant.roleInstruction || ""}
                      onChange={(event) =>
                        updateParticipant(index, "roleInstruction", event.target.value)
                      }
                      placeholder="Revenue critic, product strategist, growth PM, pricing skeptic..."
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-header">
            <div>
              <h3>Curated Sources</h3>
              <p className="settings-description">
                The council only sees what you explicitly add here. No workspace-wide
                auto-discovery.
              </p>
            </div>
            <div className="settings-section-actions">
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => {
                  void window.electronAPI.selectFiles().then((files) => {
                    setDraft((current) => ({
                      ...current,
                      sourceBundle: {
                        ...current.sourceBundle,
                        files: [
                          ...current.sourceBundle.files,
                          ...files.map((file) => ({
                            path: file.path,
                            label: file.name,
                          })),
                        ],
                      },
                    }));
                  });
                }}
              >
                Add Files
              </button>
            </div>
          </div>

          <div className="council-source-grid">
            <div className="council-source-card">
              <h4>Files</h4>
              {draft.sourceBundle.files.map((file, index) => (
                <div key={`${file.path}-${index}`} className="council-chip-row">
                  <span>{file.label || file.path}</span>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        sourceBundle: {
                          ...current.sourceBundle,
                          files: current.sourceBundle.files.filter(
                            (_, itemIndex) => itemIndex !== index,
                          ),
                        },
                      }))
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
              {draft.sourceBundle.files.length === 0 && (
                <div className="settings-description">No files selected.</div>
              )}
            </div>

            <div className="council-source-card">
              <h4>URLs</h4>
              {draft.sourceBundle.urls.map((item, index) => (
                <div key={`${item.url}-${index}`} className="council-chip-row">
                  <span>{item.label || item.url}</span>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        sourceBundle: {
                          ...current.sourceBundle,
                          urls: current.sourceBundle.urls.filter(
                            (_, itemIndex) => itemIndex !== index,
                          ),
                        },
                      }))
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
              <div className="form-row">
                <div className="form-group form-group-flex">
                  <label>Label</label>
                  <input
                    type="text"
                    value={urlDraft.label}
                    onChange={(event) =>
                      setUrlDraft((current) => ({ ...current, label: event.target.value }))
                    }
                  />
                </div>
                <div className="form-group form-group-flex">
                  <label>URL</label>
                  <input
                    type="text"
                    value={urlDraft.url}
                    onChange={(event) =>
                      setUrlDraft((current) => ({ ...current, url: event.target.value }))
                    }
                    placeholder="https://example.com"
                  />
                </div>
              </div>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => {
                  const url = urlDraft.url.trim();
                  if (!url) return;
                  setDraft((current) => ({
                    ...current,
                    sourceBundle: {
                      ...current.sourceBundle,
                      urls: [
                        ...current.sourceBundle.urls,
                        { label: urlDraft.label.trim() || undefined, url },
                      ],
                    },
                  }));
                  setUrlDraft({ label: "", url: "" });
                }}
              >
                Add URL
              </button>
            </div>

            <div className="council-source-card">
              <h4>Connector References</h4>
              {draft.sourceBundle.connectors.map((item, index) => (
                <div key={`${item.provider}-${item.label}-${index}`} className="council-chip-row">
                  <span>
                    {item.label} [{item.provider}]
                  </span>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        sourceBundle: {
                          ...current.sourceBundle,
                          connectors: current.sourceBundle.connectors.filter(
                            (_, itemIndex) => itemIndex !== index,
                          ),
                        },
                      }))
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
              <div className="form-row">
                <div className="form-group form-group-flex">
                  <label>Provider</label>
                  <input
                    type="text"
                    value={connectorDraft.provider}
                    onChange={(event) =>
                      setConnectorDraft((current) => ({ ...current, provider: event.target.value }))
                    }
                    placeholder="notion, drive, hubspot..."
                  />
                </div>
                <div className="form-group form-group-flex">
                  <label>Label</label>
                  <input
                    type="text"
                    value={connectorDraft.label}
                    onChange={(event) =>
                      setConnectorDraft((current) => ({ ...current, label: event.target.value }))
                    }
                    placeholder="Roadmap board"
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group form-group-flex">
                  <label>Resource ID</label>
                  <input
                    type="text"
                    value={connectorDraft.resourceId}
                    onChange={(event) =>
                      setConnectorDraft((current) => ({
                        ...current,
                        resourceId: event.target.value,
                      }))
                    }
                  />
                </div>
                <div className="form-group form-group-flex">
                  <label>Notes</label>
                  <input
                    type="text"
                    value={connectorDraft.notes}
                    onChange={(event) =>
                      setConnectorDraft((current) => ({ ...current, notes: event.target.value }))
                    }
                  />
                </div>
              </div>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => {
                  const provider = connectorDraft.provider.trim();
                  const label = connectorDraft.label.trim();
                  if (!provider || !label) return;
                  setDraft((current) => ({
                    ...current,
                    sourceBundle: {
                      ...current.sourceBundle,
                      connectors: [
                        ...current.sourceBundle.connectors,
                        {
                          provider,
                          label,
                          resourceId: connectorDraft.resourceId.trim() || undefined,
                          notes: connectorDraft.notes.trim() || undefined,
                        },
                      ],
                    },
                  }));
                  setConnectorDraft({ provider: "", label: "", resourceId: "", notes: "" });
                }}
              >
                Add Connector
              </button>
            </div>
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-header">
            <div>
              <h3>Memo Delivery</h3>
              <p className="settings-description">
                Every run saves an in-app memo and notification. External delivery is optional.
              </p>
            </div>
          </div>
          <label className="settings-checkbox-label">
            <input
              type="checkbox"
              checked={draft.deliveryConfig.enabled}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  deliveryConfig: {
                    ...current.deliveryConfig,
                    enabled: event.target.checked,
                    channelType: event.target.checked
                      ? (selectedChannel?.type as CouncilConfig["deliveryConfig"]["channelType"])
                      : undefined,
                  },
                }))
              }
            />
            <span>Deliver memo to a gateway channel</span>
          </label>

          {draft.deliveryConfig.enabled && (
            <>
              <div className="form-row">
                <div className="form-group form-group-flex">
                  <label>Gateway Account</label>
                  <select
                    value={draft.deliveryConfig.channelDbId || ""}
                    onChange={(event) => {
                      const nextChannel = channels.find((item) => item.id === event.target.value);
                      setDraft((current) => ({
                        ...current,
                        deliveryConfig: {
                          ...current.deliveryConfig,
                          channelDbId: event.target.value,
                          channelType:
                            nextChannel?.type as CouncilConfig["deliveryConfig"]["channelType"],
                        },
                      }));
                    }}
                  >
                    <option value="">Select a connected channel</option>
                    {channels.map((channel) => (
                      <option key={channel.id} value={channel.id}>
                        {channel.name} ({channel.type})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group form-group-flex">
                  <label>Destination Chat / Channel ID</label>
                  <input
                    type="text"
                    value={draft.deliveryConfig.channelId || ""}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        deliveryConfig: {
                          ...current.deliveryConfig,
                          channelId: event.target.value,
                        },
                      }))
                    }
                  />
                </div>
              </div>
              {selectedChannel && (
                <div className="settings-description">
                  Delivery account: {selectedChannel.name} ({selectedChannel.type})
                </div>
              )}
            </>
          )}
        </div>

        <div className="council-history-grid">
          <div className="settings-section">
            <div className="settings-section-header">
              <div>
                <h3>Recent Runs</h3>
                <p className="settings-description">
                  Proposer rotation advances per run and the memo is persisted even if channel
                  delivery fails.
                </p>
              </div>
            </div>
            {runs.length === 0 && <div className="settings-description">No runs yet.</div>}
            <div className="council-run-list">
              {runs.map((run) => (
                <div key={run.id} className="council-run-item">
                  <div>
                    <strong>
                      {run.status === "running"
                        ? "Running"
                        : run.status === "failed"
                          ? "Failed"
                          : "Completed"}
                    </strong>
                    <div className="council-run-meta">
                      Started {formatDateTime(run.startedAt)} • proposer seat{" "}
                      {run.proposerSeatIndex + 1}
                    </div>
                  </div>
                  <div className="settings-section-actions">
                    {run.memoId && (
                      <button
                        className="btn btn-secondary"
                        type="button"
                        onClick={() => {
                          const memoId = run.memoId;
                          if (!memoId) return;
                          void window.electronAPI.getCouncilMemo(memoId).then(setMemo);
                        }}
                      >
                        View Memo
                      </button>
                    )}
                    {run.taskId && onOpenTask && (
                      <button
                        className="btn btn-secondary"
                        type="button"
                        onClick={() => onOpenTask(run.taskId!)}
                      >
                        Open Task
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-header">
              <div>
                <h3>Latest Memo</h3>
                <p className="settings-description">
                  Fixed v1 format: executive summary, agreement, disagreement, actions, experiments,
                  and risks.
                </p>
              </div>
            </div>
            {!memo && <div className="settings-description">No memo available yet.</div>}
            {memo && (
              <>
                <div className="council-run-meta">
                  Saved {formatDateTime(memo.createdAt)} • proposer seat{" "}
                  {memo.proposerSeatIndex + 1} •{" "}
                  {memo.delivered
                    ? "delivered"
                    : memo.deliveryError
                      ? `delivery failed: ${memo.deliveryError}`
                      : "in-app only"}
                </div>
                <pre className="council-memo-preview">{memo.content}</pre>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
