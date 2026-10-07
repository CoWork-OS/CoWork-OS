import { ResponsibilityOperationEditor } from "./ResponsibilityOperationEditor";
import { useEffect, useRef, useState } from "react";
import type {
  BotResponsibility,
  BotResponsibilityFutureControl,
  BotResponsibilityDefinition,
  BotResponsibilityEngine,
  BotResponsibilityPreview,
  BotResponsibilityScope,
} from "../../shared/bot-responsibility";
import type { MailboxAccount } from "../../shared/mailbox";
import {
  buildPausedResponsibilityRoutine,
  RESPONSIBILITY_TIMING,
  type ResponsibilityTiming,
} from "../../shared/bot-responsibility-routine";
import "./bot-responsibility.css";

const blank = (): BotResponsibilityDefinition => ({
  objective: "",
  engine: { kind: "routine", id: "" },
  mode: "observe",
  sources: [],
  permittedActions: [],
  expectedOutput: "",
  reviewBoundary: "all_effects",
  destination: { channel: "internal", id: "results" },
  backend: "node",
  budget: { maxTokens: 8000, maxCost: 2 },
});
const modeLabels = { observe: "Observe", propose: "Propose", act: "Act within granted scope" };
function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Responsibility request failed. Refresh to check the saved state.";
}

export function BotResponsibilityPanel({
  workspaceId,
  botId,
  reloadToken,
}: {
  workspaceId: string;
  botId: string;
  /** Changes when the parent refreshes or the bot's future-run state changes. */
  reloadToken?: string;
}) {
  const scope: BotResponsibilityScope = { workspaceId, agentRoleId: botId };
  const [saved, setSaved] = useState<BotResponsibility[]>([]);
  const [engines, setEngines] = useState<BotResponsibilityEngine[]>([]);
  const [mailboxAccounts, setMailboxAccounts] = useState<MailboxAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [editing, setEditing] = useState<BotResponsibility | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<BotResponsibilityDefinition>(blank);
  const [preview, setPreview] = useState<BotResponsibilityPreview | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [pending, setPending] = useState<"preview" | "save" | null>(null);
  const [creatingRoutine, setCreatingRoutine] = useState(false);
  const [routineName, setRoutineName] = useState("");
  const [timing, setTiming] = useState<ResponsibilityTiming>("manual");
  const [routineSetupAttempted, setRoutineSetupAttempted] = useState(false);
  const routineSetupInFlight = useRef(false);
  const [controlling, setControlling] = useState<string | null>(null);
  const runRequests = useRef(new Map<string, string>());
  const futureRequests = useRef(new Map<string, BotResponsibilityFutureControl>());
  const [notice, setNotice] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const objectiveRef = useRef<HTMLTextAreaElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const requestId = useRef(0);
  const scopeVersion = useRef(0);
  const returnFocus = useRef(false);
  const mounted = useRef(true);
  const available = typeof window.electronAPI.listBotResponsibilities === "function";

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestId.current += 1;
    };
  }, []);
  useEffect(() => {
    requestId.current += 1;
    scopeVersion.current += 1;
    setNotice(null);
    setOpen(false);
    setEditing(null);
    setDraft(blank());
    setPreview(null);
    setPreviewKey(null);
    setPending(null);
    setControlling(null);
    setCreatingRoutine(false);
    setRoutineSetupAttempted(false);
    runRequests.current.clear();
    futureRequests.current.clear();
  }, [workspaceId, botId]);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(null);
    setSaved([]);
    setEngines([]);
    if (!available) {
      setLoading(false);
      return;
    }
    void Promise.all([
      window.electronAPI.listBotResponsibilities(scope),
      window.electronAPI.listBotResponsibilityEngines(scope),
    ])
      .then(([records, choices]) => {
        if (disposed) return;
        setSaved(records);
        setEngines(choices);
        setLoading(false);
      })
      .catch((error) => {
        if (!disposed) {
          setError(message(error));
          setLoading(false);
        }
      });
    return () => {
      disposed = true;
    };
  }, [workspaceId, botId, refresh, available, reloadToken]);
  useEffect(() => {
    let disposed = false;
    setMailboxAccounts([]);
    if (typeof window.electronAPI.getMailboxSyncStatus !== "function") return;
    void window.electronAPI
      .getMailboxSyncStatus()
      .then((status) => {
        if (!disposed) setMailboxAccounts(status.accounts);
      })
      .catch(() => {
        if (!disposed) setMailboxAccounts([]);
      });
    return () => {
      disposed = true;
    };
  }, [workspaceId, botId, refresh]);
  useEffect(() => {
    if (open) objectiveRef.current?.focus();
  }, [open, editing?.id]);

  useEffect(() => {
    if (returnFocus.current && !open && !loading && pending === null && controlling === null) {
      addRef.current?.focus();
      returnFocus.current = false;
    }
  }, [open, loading, pending, controlling]);

  const change = (next: BotResponsibilityDefinition) => {
    requestId.current += 1;
    setDraft(next);
    setPreview(null);
    setPreviewKey(null);
    setError(null);
    setNotice(null);
    if (pending === "preview") setPending(null);
  };
  const begin = (record?: BotResponsibility) => {
    requestId.current += 1;
    setCreatingRoutine(false);
    setRoutineName("");
    setTiming("manual");
    setRoutineSetupAttempted(false);
    setEditing(record ?? null);
    setDraft(record ? structuredClone(record.definition) : blank());
    setPreview(null);
    setPreviewKey(null);
    setError(null);
    setNotice(null);
    setOpen(true);
  };
  const close = () => {
    requestId.current += 1;
    setOpen(false);
    setEditing(null);
    setPreview(null);
    setPending(null);
    returnFocus.current = true;
  };
  const createRoutine = async () => {
    if (pending || controlling || routineSetupAttempted || routineSetupInFlight.current) return;
    const id = ++requestId.current;
    let payload;
    try {
      payload = buildPausedResponsibilityRoutine({
        scope,
        name: routineName,
        timing,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
    } catch (error) {
      setError(message(error));
      return;
    }
    routineSetupInFlight.current = true;
    setRoutineSetupAttempted(true);
    setPending("save");
    setError(null);
    try {
      const routine = await window.electronAPI.createRoutine(payload);
      if (!mounted.current || id !== requestId.current) return;
      if (
        !routine ||
        typeof routine.id !== "string" ||
        !routine.id ||
        routine.enabled !== false ||
        routine.workspaceId !== workspaceId
      )
        throw new Error("Routine creation could not be confirmed.");
      setEngines((choices) => [
        ...choices,
        { kind: "routine", id: routine.id, name: routine.name, enabled: false },
      ]);
      setDraft((value) => ({ ...value, engine: { kind: "routine", id: routine.id } }));
      setPreview(null);
      setPreviewKey(null);
      setCreatingRoutine(false);
      setNotice("Routine saved paused. Preview the responsibility before saving it.");
    } catch (error) {
      if (mounted.current && id === requestId.current) {
        setNotice(
          `${message(error)} Check the refreshed routine list for the saved routine before creating another.`,
        );
        setRefresh((value) => value + 1);
      }
    } finally {
      routineSetupInFlight.current = false;
      if (mounted.current && id === requestId.current) setPending(null);
    }
  };
  const loadPreview = async () => {
    if (!formRef.current?.reportValidity()) return;
    const id = ++requestId.current;
    const key = JSON.stringify(draft);
    setPending("preview");
    setError(null);
    try {
      const result = await window.electronAPI.previewBotResponsibility({
        scope,
        definition: draft,
      });
      if (mounted.current && id === requestId.current) {
        setPreview(result);
        setPreviewKey(key);
      }
    } catch (error) {
      if (mounted.current && id === requestId.current) setError(message(error));
    } finally {
      if (mounted.current && id === requestId.current) setPending(null);
    }
  };
  const save = async () => {
    if (
      !preview ||
      previewKey !== JSON.stringify(draft) ||
      pending ||
      !formRef.current?.reportValidity()
    )
      return;
    const id = ++requestId.current;
    setPending("save");
    setError(null);
    try {
      const result = editing
        ? await window.electronAPI.reviseBotResponsibility({
            scope,
            id: editing.id,
            expectedRevision: editing.revision,
            definition: draft,
          })
        : await window.electronAPI.createBotResponsibility({ scope, definition: draft });
      if (!mounted.current || id !== requestId.current) return;
      setNotice(`Saved paused · revision ${result.revision}`);
      setOpen(false);
      setEditing(null);
      setPreview(null);
      setPreviewKey(null);
      setRefresh((value) => value + 1);
      returnFocus.current = true;
    } catch (error) {
      if (mounted.current && id === requestId.current) {
        setError(message(error));
      }
    } finally {
      if (mounted.current && id === requestId.current) setPending(null);
    }
  };
  const control = async (
    record: BotResponsibility,
    action: "activate" | "pause" | "run" | "future",
  ) => {
    if (controlling || pending) return;
    const version = scopeVersion.current;
    const current = () => mounted.current && version === scopeVersion.current;
    setControlling(record.id);
    setError(null);
    setNotice(null);
    const request = {
      scope,
      id: record.id,
      expectedRevision: record.revision,
      expectedControlVersion: record.controlVersion,
    };
    try {
      if (action === "future") {
        let saved = futureRequests.current.get(record.id);
        if (!saved) {
          saved = {
            ...request,
            requestId: crypto.randomUUID(),
            expectedFutureControlVersion: record.futureControlVersion ?? 0,
            paused: !record.futurePaused,
          };
          futureRequests.current.set(record.id, saved);
        }
        const receipt = await window.electronAPI.setBotResponsibilityFutureRuns(saved);
        if (!current()) return;
        futureRequests.current.delete(record.id);
        setNotice(
          `Future runs ${receipt.futurePaused ? "paused" : "resumed"}. Existing work is unchanged (${receipt.stillActiveTaskIds.length} unfinished work ${receipt.stillActiveTaskIds.length === 1 ? "item" : "items"}).`,
        );
      } else if (action === "run") {
        let requestId = runRequests.current.get(record.id);
        if (!requestId) {
          requestId = crypto.randomUUID();
          runRequests.current.set(record.id, requestId);
        }
        const result = await window.electronAPI.runBotResponsibility({ ...request, requestId });
        if (!current()) return;
        if (!result || result.status === "failed")
          throw new Error(result?.errorSummary ?? "Run admission was unavailable.");
        runRequests.current.delete(record.id);
        setNotice(`Run ${result.status}.`);
      } else {
        const result =
          action === "activate"
            ? await window.electronAPI.activateBotResponsibility(request)
            : await window.electronAPI.pauseBotResponsibility(request);
        if (!current()) return;
        setNotice(
          `Responsibility ${result.state === "active" ? "activated" : "paused"} · Revision ${result.revision}`,
        );
      }
      setRefresh((value) => value + 1);
      returnFocus.current = true;
    } catch (error) {
      if (!current()) return;
      if (
        action === "future" &&
        error instanceof Error &&
        error.message === "Responsibility revision or control changed"
      )
        futureRequests.current.delete(record.id);
      if (current()) setError(message(error));
    } finally {
      if (current()) setControlling(null);
    }
  };
  const operations = (key: "sources" | "permittedActions", title: string) => (
    <fieldset className="responsibility-operations">
      <legend>{title}</legend>
      {draft[key].map((item, index) => (
        <div className="responsibility-operation" key={index}>
          <ResponsibilityOperationEditor
            operation={item}
            effect={key === "sources" ? "read" : "write"}
            index={index}
            mailboxAccounts={mailboxAccounts}
            onChange={(next) =>
              change({ ...draft, [key]: draft[key].map((row, i) => (i === index ? next : row)) })
            }
          />
          <button
            type="button"
            aria-label={`Remove ${title.toLowerCase()} ${index + 1}`}
            onClick={() => change({ ...draft, [key]: draft[key].filter((_, i) => i !== index) })}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={draft[key].length >= 50}
        onClick={() =>
          change({
            ...draft,
            [key]: [
              ...draft[key],
              {
                connectorId: "workspace_files",
                method: key === "sources" ? "read_file" : "write_file",
                resourceId: "",
              },
            ],
          })
        }
      >
        Add {key === "sources" ? "source" : "action"}
      </button>
    </fieldset>
  );

  return (
    <div className="bot-responsibility-panel" aria-label="Bot responsibilities">
      <div className="responsibility-heading">
        <div>
          <h3>Responsibilities</h3>
          <p>Ongoing jobs this bot owns in this workspace. Each runs only while active.</p>
        </div>
        <button
          ref={addRef}
          type="button"
          disabled={!available || loading || pending === "save" || controlling !== null}
          onClick={() => begin()}
        >
          Add responsibility
        </button>
      </div>
      {!available && <p>Responsibility controls are unavailable in this app version.</p>}
      {loading && <p role="status">Loading responsibilities…</p>}
      {error && (
        <div className="responsibility-error" role="alert">
          {error}
          <button
            type="button"
            disabled={pending === "save"}
            onClick={() => {
              close();
              setRefresh((value) => value + 1);
            }}
          >
            Refresh saved state
          </button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {!loading && available && !open && saved.length === 0 && !error && (
        <p>No responsibilities yet. Give this bot an ongoing job, such as a daily check.</p>
      )}
      {!open && (
        <ul className="responsibility-list">
          {saved.map((record) => (
            <li key={record.id}>
              <div>
                <strong>{record.definition.objective}</strong>
                <p>
                  <span
                    className={`responsibility-state ${
                      record.state === "active" && !record.botFuturePaused && !record.futurePaused
                        ? "active"
                        : "paused"
                    }`}
                  >
                    {record.state === "active"
                      ? record.botFuturePaused
                        ? "Paused with the bot"
                        : record.futurePaused
                          ? "Paused"
                          : "On"
                      : "Off"}
                  </span>{" "}
                  · {modeLabels[record.definition.mode]} · Revision {record.revision}
                </p>
                <p>{record.definition.expectedOutput}</p>
              </div>
              <button
                type="button"
                disabled={record.state === "active" || controlling !== null}
                title={record.state === "active" ? "Turn it off to edit" : undefined}
                onClick={() => begin(record)}
                aria-label={`Edit responsibility: ${record.definition.objective}`}
              >
                Edit
              </button>
              {typeof window.electronAPI.activateBotResponsibility === "function" && (
                <div className="responsibility-buttons">
                  {record.state === "active" ? (
                    <>
                      <button
                        type="button"
                        disabled={
                          controlling !== null ||
                          record.futurePaused === true ||
                          record.botFuturePaused === true
                        }
                        onClick={() => void control(record, "run")}
                      >
                        Run now
                      </button>
                      {typeof window.electronAPI.setBotResponsibilityFutureRuns === "function" && (
                        <button
                          type="button"
                          disabled={
                            controlling !== null ||
                            (record.botFuturePaused === true && record.futurePaused === true)
                          }
                          onClick={() => void control(record, "future")}
                        >
                          {record.futurePaused ? "Resume" : "Pause"}
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={controlling !== null}
                        title="Stop it from running and allow editing"
                        onClick={() => void control(record, "pause")}
                      >
                        Turn off
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={controlling !== null}
                      onClick={() => void control(record, "activate")}
                    >
                      Turn on
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {open && (
        <form
          ref={formRef}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          aria-label={editing ? "Edit responsibility" : "New responsibility"}
        >
          <fieldset disabled={pending === "save"} className="responsibility-fields">
            <h4>
              {editing ? `Edit revision ${editing.revision}` : "Give this bot a responsibility"}
            </h4>
            <label>
              Objective
              <textarea
                ref={objectiveRef}
                required
                maxLength={4000}
                rows={3}
                value={draft.objective}
                onChange={(event) => change({ ...draft, objective: event.target.value })}
              />
            </label>
            <label>
              Routine or trigger
              <select
                required
                disabled={!!editing}
                value={`${draft.engine.kind}:${draft.engine.id}`}
                onChange={(event) => {
                  const engine = engines.find(
                    (item) => `${item.kind}:${item.id}` === event.target.value,
                  );
                  if (engine) change({ ...draft, engine: { kind: engine.kind, id: engine.id } });
                }}
              >
                <option value="routine:">Choose a paused routine or trigger</option>
                {engines
                  .filter((item) => !item.bindingId || item.bindingId === editing?.id)
                  .map((item) => (
                    <option
                      key={`${item.kind}:${item.id}`}
                      value={`${item.kind}:${item.id}`}
                      disabled={item.enabled}
                    >
                      {item.name} · {item.kind}
                      {item.enabled ? " · pause first" : ""}
                    </option>
                  ))}
              </select>
            </label>
            {!editing && typeof window.electronAPI.createRoutine === "function" && (
              <div className="responsibility-fields">
                {!creatingRoutine ? (
                  <button
                    type="button"
                    disabled={pending !== null}
                    onClick={() => setCreatingRoutine(true)}
                  >
                    Create a paused routine here
                  </button>
                ) : (
                  <>
                    <label>
                      Routine name
                      <input
                        maxLength={120}
                        value={routineName}
                        onChange={(event) => setRoutineName(event.target.value)}
                      />
                    </label>
                    <label>
                      Timing
                      <select
                        value={timing}
                        onChange={(event) => setTiming(event.target.value as ResponsibilityTiming)}
                      >
                        {Object.entries(RESPONSIBILITY_TIMING).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p className="responsibility-help">
                      Daily timings use {Intl.DateTimeFormat().resolvedOptions().timeZone}. The
                      routine stays paused until you save and activate its responsibility.
                    </p>
                    <button
                      type="button"
                      disabled={pending !== null || !routineName.trim() || routineSetupAttempted}
                      onClick={() => void createRoutine()}
                    >
                      {pending === "save" ? "Saving routine…" : "Save paused routine"}
                    </button>
                  </>
                )}
              </div>
            )}
            {engines.length === 0 && typeof window.electronAPI.createRoutine !== "function" && (
              <p>Create a paused routine or trigger in Automations, then select it here.</p>
            )}
            <div className="responsibility-grid">
              <label>
                Behavior
                <select
                  value={draft.mode}
                  onChange={(event) => {
                    const mode = event.target.value as BotResponsibilityDefinition["mode"];
                    change({
                      ...draft,
                      mode,
                      permittedActions: mode === "act" ? draft.permittedActions : [],
                    });
                  }}
                >
                  {Object.entries(modeLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Run on
                <select
                  value={draft.backend}
                  onChange={(event) =>
                    change({ ...draft, backend: event.target.value as "node" | "desktop" })
                  }
                >
                  <option value="node">Node or desktop runtime</option>
                  <option value="desktop">Desktop required</option>
                </select>
              </label>
            </div>
            <p className="responsibility-help">
              {draft.mode === "observe"
                ? "Read selected permitted sources and produce an internal result."
                : draft.mode === "propose"
                  ? "Prepare a draft for review. External effects remain unavailable."
                  : "Perform selected actions only within current permissions and the review boundary."}
            </p>
            <label>
              Expected output
              <textarea
                required
                maxLength={2000}
                rows={2}
                value={draft.expectedOutput}
                onChange={(event) => change({ ...draft, expectedOutput: event.target.value })}
              />
            </label>
            <label>
              Work context ID (optional)
              <input
                maxLength={128}
                value={draft.contextId ?? ""}
                onChange={(event) => {
                  const { contextId: _, ...rest } = draft;
                  change(event.target.value ? { ...rest, contextId: event.target.value } : rest);
                }}
              />
            </label>
            {operations("sources", "Selected sources")}
            {draft.mode === "act" && operations("permittedActions", "Permitted actions")}
            <label className="responsibility-checkbox">
              <input
                type="checkbox"
                checked={draft.reviewBoundary === "all_effects"}
                onChange={(event) =>
                  change({
                    ...draft,
                    reviewBoundary: event.target.checked ? "all_effects" : "outside_granted_scope",
                  })
                }
              />
              Ask before every action, even permitted ones
            </label>
            <div className="responsibility-grid">
              <label>
                Result destination
                <select
                  value={draft.destination.channel}
                  onChange={(event) => {
                    const channel = event.target
                      .value as BotResponsibilityDefinition["destination"]["channel"];
                    change({
                      ...draft,
                      destination: { channel, id: channel === "internal" ? "results" : "" },
                    });
                  }}
                >
                  <option value="internal">Internal results</option>
                  <option value="slack">Slack</option>
                  <option value="teams">Teams</option>
                </select>
              </label>
              {draft.destination.channel !== "internal" && (
                <label>
                  Channel or chat ID
                  <input
                    required
                    maxLength={128}
                    value={draft.destination.id}
                    onChange={(event) =>
                      change({
                        ...draft,
                        destination: { ...draft.destination, id: event.target.value },
                      })
                    }
                  />
                </label>
              )}
              <label>
                Token budget
                <input
                  required
                  type="number"
                  min={1}
                  max={1000000}
                  step={1}
                  value={draft.budget.maxTokens}
                  onChange={(event) =>
                    change({
                      ...draft,
                      budget: { ...draft.budget, maxTokens: Number(event.target.value) },
                    })
                  }
                />
              </label>
              <label>
                Cost budget (USD)
                <input
                  required
                  type="number"
                  min={0}
                  max={1000}
                  step="0.01"
                  value={draft.budget.maxCost}
                  onChange={(event) =>
                    change({
                      ...draft,
                      budget: { ...draft.budget, maxCost: Number(event.target.value) },
                    })
                  }
                />
              </label>
            </div>
            {preview && (
              <div className="responsibility-preview" aria-live="polite">
                <h4>Run preview</h4>
                <p>
                  {preview.engine.name} · {modeLabels[preview.definition.mode]}
                </p>
                <p>{preview.triggerSummary.join(" · ") || "No enabled triggers"}</p>
                {preview.nextRunIfEnabledAt !== undefined && (
                  <p>
                    Next scheduled time if enabled:{" "}
                    {new Date(preview.nextRunIfEnabledAt).toLocaleString()}
                  </p>
                )}
                {preview.schedulePreviewState === "unavailable" && (
                  <p>The next scheduled time is unavailable.</p>
                )}
                <p>{preview.definition.expectedOutput}</p>
                <p>Objective: {preview.definition.objective}</p>
                <p>
                  Destination: {preview.definition.destination.channel} ·{" "}
                  {preview.definition.destination.id}
                </p>
                <p>
                  Budget: {preview.definition.budget.maxTokens.toLocaleString()} tokens · $
                  {preview.definition.budget.maxCost.toFixed(2)}
                </p>
                <p>
                  Review:{" "}
                  {preview.definition.reviewBoundary === "all_effects"
                    ? "before every action"
                    : "only for actions outside the permitted list"}
                </p>
                {(["sources", "permittedActions"] as const).map((kind) => (
                  <div key={kind}>
                    <strong>{kind === "sources" ? "Selected sources" : "Permitted actions"}</strong>
                    {preview.definition[kind].length === 0 ? (
                      <p>None</p>
                    ) : (
                      <ul>
                        {preview.definition[kind].map((operation, index) => (
                          <li key={index}>
                            {operation.connectorId} · {operation.method} · {operation.resourceId}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
                <p>
                  {preview.backendPresence === "requires_desktop"
                    ? "Waiting for a desktop runtime."
                    : preview.backendPresence === "unavailable"
                      ? "Runtime presence is unavailable."
                      : "Requested runtime is present."}
                </p>
                <p>
                  Saving keeps this responsibility paused.{" "}
                  {preview.activationAvailable
                    ? "Activation is available after saving."
                    : preview.activationIssues.join(" ")}
                </p>
              </div>
            )}
            <div className="responsibility-buttons">
              <button
                type="button"
                disabled={pending !== null || !draft.engine.id}
                onClick={() => void loadPreview()}
              >
                {pending === "preview" ? "Preparing preview…" : "Preview run"}
              </button>
              <button
                type="submit"
                className="bot-work-primary"
                disabled={!preview || previewKey !== JSON.stringify(draft) || pending !== null}
              >
                {pending === "save" ? "Saving…" : "Save paused"}
              </button>
              <button type="button" onClick={close}>
                Cancel
              </button>
            </div>
          </fieldset>
        </form>
      )}
    </div>
  );
}
