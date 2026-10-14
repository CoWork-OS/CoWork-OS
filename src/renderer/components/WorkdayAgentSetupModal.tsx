import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { ModalDialog } from "./ModalDialog";
import type {
  WorkdayAgentExecutionMode,
  WorkdayAgentModel,
  WorkdayAgentResource,
  WorkdayAgentSaveResult,
} from "../../shared/types";
import {
  addSkill,
  addTool,
  adminConnectionRequest,
  adminFormFromServer,
  adminFormReady,
  agentProblems,
  agentRequest,
  EMPTY_NEW_SKILL,
  isAddableResource,
  missingToolLines,
  needsApproval,
  newAgentModel,
  removeSkill,
  removeTool,
  setSkillMode,
  skillIdFromName,
  toolCount,
  withServicesHost,
  withTenantHost,
  type NewSkillForm,
  type WorkdayAdminDisplay,
} from "./workday-agent-setup-model";

interface Props {
  serverId: string;
  serverName: string;
  tenant?: string;
  admin?: WorkdayAdminDisplay;
  onClose: () => void;
  /** Settings changed (admin connection saved); reload them. */
  onConnectionSaved: () => void;
  /** Starts the Workday server's own sign-in, so new tools reach CoWork. */
  onSignInServer: () => void;
}

const NEW_AGENT = "__new__";

/**
 * Manages the Workday external agent CoWork signs in as: admin sign-in, the
 * tool catalog, and the agent definition's skills and tools.
 */
export function WorkdayAgentSetupModal({
  serverId,
  serverName,
  tenant,
  admin,
  onClose,
  onConnectionSaved,
  onSignInServer,
}: Props) {
  const initial = adminFormFromServer(admin);
  const [form, setForm] = useState(initial.form);
  const [storedSecret, setStoredSecret] = useState(initial.storedSecret);
  const [busy, setBusy] = useState<null | "connection" | "sign-in" | "list" | "save">(null);
  const [error, setError] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [agents, setAgents] = useState<WorkdayAgentModel[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [draft, setDraft] = useState<WorkdayAgentModel | null>(null);
  const [query, setQuery] = useState("");
  const [includeOperations, setIncludeOperations] = useState(false);
  const [results, setResults] = useState<WorkdayAgentResource[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [targetSkill, setTargetSkill] = useState("");
  const [newSkill, setNewSkill] = useState<NewSkillForm>(EMPTY_NEW_SKILL);
  const [skillError, setSkillError] = useState<string | null>(null);
  const [saveResult, setSaveResult] = useState<WorkdayAgentSaveResult | null>(null);

  const api = window.electronAPI;

  /**
   * Lists the tenant's agent definitions. The first load picks CoWork's agent
   * (or a new one); after a save the saved definition stays selected.
   */
  const loadAgents = async (options: { quiet?: boolean; keep?: WorkdayAgentModel } = {}) => {
    setBusy("list");
    try {
      const listed = await api.listWorkdayAgents(serverId);
      if (listed.status === "signed_out") {
        setSignedIn(false);
        return;
      }
      setSignedIn(true);
      setAgents(listed.agents);
      const keep = options.keep;
      if (keep) {
        const index = listed.agents.findIndex(
          (agent) => agent.name === keep.name && agent.version === keep.version,
        );
        setSelected(index >= 0 ? String(index) : NEW_AGENT);
      } else if (!draft) {
        const first = listed.agents.find((agent) => agent.name === "CoWork") ?? listed.agents[0];
        selectAgent(first ? String(listed.agents.indexOf(first)) : NEW_AGENT, listed.agents);
      }
    } catch (failure: Any) {
      if (!options.quiet) setError(failure.message || "Could not list Workday agents");
    } finally {
      setBusy(null);
    }
  };

  // Load once when the panel opens: an admin token may still be in memory.
  useEffect(() => {
    if (admin?.tenantHost) void loadAgents({ quiet: true });
  }, []);

  const selectAgent = (value: string, list: WorkdayAgentModel[] = agents) => {
    setSelected(value);
    setSaveResult(null);
    const model = value === NEW_AGENT ? newAgentModel() : list[Number(value)];
    const next = model ? structuredClone(model) : newAgentModel();
    setDraft(next);
    setTargetSkill(next.skills[0]?.id ?? "");
  };

  const saveConnection = async (): Promise<boolean> => {
    setBusy("connection");
    setError(null);
    try {
      const summary = await api.saveWorkdayAdminConnection(adminConnectionRequest(serverId, form));
      setStoredSecret(summary.hasClientSecret);
      setForm((prev) => ({ ...prev, clientSecret: "" }));
      setSignedIn(summary.signedIn);
      onConnectionSaved();
      return true;
    } catch (failure: Any) {
      setError(failure.message || "Could not save the admin connection");
      return false;
    } finally {
      setBusy(null);
    }
  };

  const signIn = async () => {
    if (!(await saveConnection())) return;
    setBusy("sign-in");
    try {
      // A cancelled or replaced sign-in ends quietly.
      const result = await api.signInWorkdayAdmin(serverId);
      if (result.status === "signed_in") {
        setBusy(null);
        await loadAgents();
        return;
      }
    } catch (failure: Any) {
      setError(failure.message || "Admin sign-in failed");
    } finally {
      setBusy((current) => (current === "sign-in" ? null : current));
    }
  };

  const cancelSignIn = async () => {
    try {
      await api.cancelWorkdayAdminSignIn(serverId);
    } catch {
      // The sign-in ends on its own timeout.
    }
  };

  const search = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setError(null);
    try {
      const found = await api.searchWorkdayAgentResources({
        serverId,
        query: query.trim(),
        includeOperations,
      });
      setResults(found.resources);
    } catch (failure: Any) {
      setError(failure.message || "Search failed");
    } finally {
      setSearching(false);
    }
  };

  const updateDraft = (next: WorkdayAgentModel) => {
    setDraft(next);
    setSaveResult(null);
  };

  const handleAddSkill = () => {
    if (!draft) return;
    const added = addSkill(draft, newSkill);
    if ("error" in added) {
      setSkillError(added.error);
      return;
    }
    setSkillError(null);
    updateDraft(added.model);
    setTargetSkill(added.model.skills.at(-1)!.id);
    setNewSkill(EMPTY_NEW_SKILL);
  };

  const save = async () => {
    if (!draft) return;
    setBusy("save");
    setError(null);
    setSaveResult(null);
    try {
      const result = await api.saveWorkdayAgent({ serverId, agent: agentRequest(draft) });
      setSaveResult(result);
      if (result.status === "saved") {
        setBusy(null);
        await loadAgents({ keep: agentRequest(draft) });
      }
    } catch (failure: Any) {
      setError(failure.message || "Could not save the agent");
    } finally {
      setBusy((current) => (current === "save" ? null : current));
    }
  };

  const problems = draft ? agentProblems(draft) : [];
  const approvalTools = draft
    ? draft.skills.flatMap((skill) => skill.tools).filter((tool) => needsApproval(tool.toolName))
    : [];

  return (
    <div className="mcp-modal-overlay" onClick={onClose}>
      <ModalDialog
        onClose={onClose}
        aria-label="Workday agent setup"
        className="mcp-modal workday-agent-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mcp-modal-header">
          <h3>Agent setup · {serverName}</h3>
          <button className="mcp-modal-close" onClick={onClose} aria-label="Close">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="mcp-modal-content">
          <p className="settings-hint">
            Register or update the Workday external agent this server signs in as
            {tenant ? ` in tenant ${tenant}` : ""}. Sign in with a Workday admin API client (
            <strong>Register API Client</strong>, Agent System of Record scope).
          </p>

          {error && (
            <div className="mcp-server-error workday-agent-error">
              <span className="mcp-error-icon">
                <AlertTriangle size={14} strokeWidth={2} />
              </span>
              {error}
              <button className="mcp-error-dismiss" onClick={() => setError(null)} title="Dismiss">
                ×
              </button>
            </div>
          )}

          <section className="workday-agent-section">
            <h4>Admin connection{signedIn ? " · signed in" : ""}</h4>
            <div className="settings-field">
              <label htmlFor="workday-admin-tenant-host">Tenant host</label>
              <input
                id="workday-admin-tenant-host"
                type="text"
                className="settings-input"
                placeholder="impl.wd5.myworkday.com"
                value={form.tenantHost}
                onChange={(e) => setForm(withTenantHost(form, e.target.value))}
              />
            </div>
            <div className="settings-field">
              <label htmlFor="workday-admin-services-host">Services host</label>
              <input
                id="workday-admin-services-host"
                type="text"
                className="settings-input"
                placeholder="impl-services1.wd5.myworkday.com"
                value={form.servicesHost}
                onChange={(e) => setForm(withServicesHost(form, e.target.value))}
              />
              <p className="settings-hint">
                Derived from the tenant host; change it only if your tenant uses another one.
              </p>
            </div>
            <div className="settings-field">
              <label htmlFor="workday-admin-client-id">Admin client ID</label>
              <input
                id="workday-admin-client-id"
                type="text"
                className="settings-input"
                value={form.clientId}
                onChange={(e) => setForm({ ...form, clientId: e.target.value })}
              />
            </div>
            <div className="settings-field">
              <label htmlFor="workday-admin-client-secret">Admin client secret</label>
              <input
                id="workday-admin-client-secret"
                type="password"
                className="settings-input"
                autoComplete="off"
                placeholder={storedSecret ? "Saved secret" : undefined}
                value={form.clientSecret}
                onChange={(e) => setForm({ ...form, clientSecret: e.target.value })}
              />
              <p className="settings-hint">
                {storedSecret
                  ? "Leave blank to keep the saved secret. Stored encrypted on this device."
                  : "Stored encrypted on this device."}{" "}
                Register https://127.0.0.1:18768/oauth/callback as the client's redirect URI.
              </p>
            </div>
            <div className="settings-field">
              <label className="settings-checkbox">
                <input
                  type="checkbox"
                  checked={form.usePkce}
                  onChange={(e) => setForm({ ...form, usePkce: e.target.checked })}
                />
                <span>Use PKCE (only if the admin client has PKCE enabled)</span>
              </label>
            </div>
            <div className="mcp-form-actions">
              <button
                className="button-small button-secondary"
                disabled={!adminFormReady(form, storedSecret) || busy !== null}
                onClick={() => void saveConnection()}
              >
                Save
              </button>
              <button
                className="button-small button-primary"
                disabled={!adminFormReady(form, storedSecret) || busy !== null}
                onClick={() => void signIn()}
              >
                {busy === "sign-in" ? "Signing in..." : signedIn ? "Sign in again" : "Sign in"}
              </button>
              {busy === "sign-in" && (
                <button
                  className="button-small button-secondary"
                  onClick={() => void cancelSignIn()}
                >
                  Cancel
                </button>
              )}
            </div>
          </section>

          {signedIn && draft && (
            <>
              <section className="workday-agent-section">
                <h4>Agent</h4>
                <div className="settings-field">
                  <label htmlFor="workday-agent-select">Agent definition</label>
                  <select
                    id="workday-agent-select"
                    className="settings-select"
                    value={selected}
                    onChange={(e) => selectAgent(e.target.value)}
                  >
                    {agents.map((agent, index) => (
                      <option key={`${agent.name}-${agent.version}-${index}`} value={index}>
                        {agent.name} {agent.version}
                      </option>
                    ))}
                    <option value={NEW_AGENT}>New agent</option>
                  </select>
                </div>
                <div className="workday-agent-grid">
                  <div className="settings-field">
                    <label htmlFor="workday-agent-name">Name</label>
                    <input
                      id="workday-agent-name"
                      type="text"
                      className="settings-input"
                      maxLength={100}
                      value={draft.name}
                      onChange={(e) => updateDraft({ ...draft, name: e.target.value })}
                    />
                  </div>
                  <div className="settings-field">
                    <label htmlFor="workday-agent-version">Version</label>
                    <input
                      id="workday-agent-version"
                      type="text"
                      className="settings-input"
                      value={draft.version}
                      onChange={(e) => updateDraft({ ...draft, version: e.target.value })}
                    />
                  </div>
                </div>
                <div className="settings-field">
                  <label htmlFor="workday-agent-description">Description</label>
                  <input
                    id="workday-agent-description"
                    type="text"
                    className="settings-input"
                    value={draft.description}
                    onChange={(e) => updateDraft({ ...draft, description: e.target.value })}
                  />
                  <p className="settings-hint">
                    Workday keys a definition by name and version: saving the same name and version
                    updates it.
                  </p>
                </div>
              </section>

              <section className="workday-agent-section">
                <h4>
                  Skills and tools · {toolCount(draft)} tool{toolCount(draft) === 1 ? "" : "s"}
                </h4>
                {draft.skills.length === 0 && (
                  <p className="settings-hint">No skills yet. Add one below, then add tools.</p>
                )}
                <div className="mcp-tools-list">
                  {draft.skills.map((skill) => (
                    <div key={skill.id} className="mcp-tool-item">
                      <div className="workday-agent-row">
                        <div>
                          <div className="mcp-tool-name">{skill.name}</div>
                          <div className="workday-agent-wid">{skill.id}</div>
                        </div>
                        <div className="workday-agent-row-actions">
                          <select
                            className="settings-select"
                            aria-label={`Execution mode for ${skill.name}`}
                            value={skill.executionMode}
                            onChange={(e) =>
                              updateDraft(
                                setSkillMode(
                                  draft,
                                  skill.id,
                                  e.target.value as WorkdayAgentExecutionMode,
                                ),
                              )
                            }
                          >
                            <option value="Delegate">Delegate</option>
                            <option value="Ambient">Ambient</option>
                          </select>
                          <button
                            className="button-small button-secondary"
                            onClick={() => updateDraft(removeSkill(draft, skill.id))}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                      {skill.description && (
                        <div className="mcp-tool-description">{skill.description}</div>
                      )}
                      {skill.tools.length === 0 ? (
                        <p className="settings-hint">No tools in this skill.</p>
                      ) : (
                        <ul className="workday-agent-tools">
                          {skill.tools.map((tool) => (
                            <li key={tool.wid} className="workday-agent-row">
                              <div>
                                <span className="workday-agent-tool-name">{tool.toolName}</span>
                                <span className="workday-agent-wid">{tool.wid}</span>
                              </div>
                              <button
                                className="button-small button-secondary"
                                onClick={() => updateDraft(removeTool(draft, skill.id, tool.wid))}
                              >
                                Remove
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>

                <div className="workday-agent-subsection">
                  <div className="workday-agent-grid">
                    <div className="settings-field">
                      <label htmlFor="workday-skill-name">New skill name</label>
                      <input
                        id="workday-skill-name"
                        type="text"
                        className="settings-input"
                        placeholder="Time Off Balances"
                        value={newSkill.name}
                        onChange={(e) =>
                          setNewSkill({
                            ...newSkill,
                            name: e.target.value,
                            id:
                              newSkill.id === skillIdFromName(newSkill.name)
                                ? skillIdFromName(e.target.value)
                                : newSkill.id,
                          })
                        }
                      />
                    </div>
                    <div className="settings-field">
                      <label htmlFor="workday-skill-id">Skill ID</label>
                      <input
                        id="workday-skill-id"
                        type="text"
                        className="settings-input"
                        placeholder="time_off_balances"
                        value={newSkill.id}
                        onChange={(e) => setNewSkill({ ...newSkill, id: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className="workday-agent-grid">
                    <div className="settings-field">
                      <label htmlFor="workday-skill-description">Description</label>
                      <input
                        id="workday-skill-description"
                        type="text"
                        className="settings-input"
                        value={newSkill.description}
                        onChange={(e) => setNewSkill({ ...newSkill, description: e.target.value })}
                      />
                    </div>
                    <div className="settings-field">
                      <label htmlFor="workday-skill-mode">Execution mode</label>
                      <select
                        id="workday-skill-mode"
                        className="settings-select"
                        value={newSkill.executionMode}
                        onChange={(e) =>
                          setNewSkill({
                            ...newSkill,
                            executionMode: e.target.value as WorkdayAgentExecutionMode,
                          })
                        }
                      >
                        <option value="Delegate">Delegate</option>
                        <option value="Ambient">Ambient</option>
                      </select>
                    </div>
                  </div>
                  {skillError && <p className="settings-hint warning">{skillError}</p>}
                  <div className="mcp-form-actions">
                    <button className="button-small button-secondary" onClick={handleAddSkill}>
                      Add skill
                    </button>
                  </div>
                </div>
              </section>

              <section className="workday-agent-section">
                <h4>Tool catalog</h4>
                <div className="workday-agent-search">
                  <input
                    type="text"
                    className="settings-input"
                    aria-label="Search Workday tools"
                    placeholder="Search tools, e.g. absence"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void search();
                    }}
                  />
                  <button
                    className="button-small button-secondary"
                    disabled={!query.trim() || searching}
                    onClick={() => void search()}
                  >
                    {searching ? "Searching..." : "Search"}
                  </button>
                </div>
                <div className="settings-field">
                  <label className="settings-checkbox">
                    <input
                      type="checkbox"
                      checked={includeOperations}
                      onChange={(e) => setIncludeOperations(e.target.checked)}
                    />
                    <span>Include SOAP and REST operations</span>
                  </label>
                </div>
                {draft.skills.length > 0 && (
                  <div className="settings-field">
                    <label htmlFor="workday-target-skill">Add tools to</label>
                    <select
                      id="workday-target-skill"
                      className="settings-select"
                      value={targetSkill}
                      onChange={(e) => setTargetSkill(e.target.value)}
                    >
                      {draft.skills.map((skill) => (
                        <option key={skill.id} value={skill.id}>
                          {skill.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {results && results.length === 0 && (
                  <p className="settings-hint">No matching tools.</p>
                )}
                {results && results.length > 0 && (
                  <ul className="workday-agent-tools workday-agent-results">
                    {results.map((resource) => {
                      const added = draft.skills
                        .find((skill) => skill.id === targetSkill)
                        ?.tools.some((tool) => tool.wid === resource.wid);
                      return (
                        <li key={resource.wid} className="workday-agent-row">
                          <div>
                            <span className="workday-agent-tool-name">{resource.toolName}</span>
                            <span className="workday-agent-wid">{resource.wid}</span>
                          </div>
                          <button
                            className="button-small button-secondary"
                            disabled={!targetSkill || added || !isAddableResource(resource)}
                            title={
                              isAddableResource(resource)
                                ? undefined
                                : "This operation's name cannot be used as a tool name"
                            }
                            onClick={() => updateDraft(addTool(draft, targetSkill, resource))}
                          >
                            {added ? "Added" : "Add"}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {!targetSkill && results && results.length > 0 && (
                  <p className="settings-hint">Add a skill first to choose where tools go.</p>
                )}
              </section>

              {approvalTools.length > 0 && (
                <p className="settings-hint">
                  CoWork asks for approval before running tools that change Workday data:{" "}
                  {approvalTools.map((tool) => tool.toolName).join(", ")}.
                </p>
              )}
              {problems.length > 0 && <p className="settings-hint warning">{problems[0]}</p>}

              {saveResult?.status === "missing_tools" && (
                <div className="settings-hint warning">
                  Nothing was saved. These tools were not found in the tenant&apos;s catalog:
                  <ul className="workday-agent-missing">
                    {missingToolLines(saveResult).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              )}
              {saveResult?.status === "saved" && (
                <div className="workday-agent-saved">
                  <p>
                    Saved {saveResult.name}
                    {saveResult.id ? ` (Workday ID ${saveResult.id})` : ""} with{" "}
                    {saveResult.toolCount} tool{saveResult.toolCount === 1 ? "" : "s"}.
                  </p>
                  <p className="settings-hint">
                    Sign in again on the Workday server to use the new tools: its token carries the
                    tools granted when it was issued.
                  </p>
                  <button className="button-small button-primary" onClick={onSignInServer}>
                    Sign in to {serverName}
                  </button>
                </div>
              )}

              <div className="mcp-modal-actions">
                <button className="button-secondary" onClick={onClose}>
                  Close
                </button>
                <button
                  className="button-primary"
                  disabled={problems.length > 0 || busy !== null}
                  onClick={() => void save()}
                >
                  {busy === "save" ? "Saving..." : "Save agent"}
                </button>
              </div>
            </>
          )}
          {!signedIn && busy === "list" && <p className="settings-hint">Checking sign-in...</p>}
        </div>
      </ModalDialog>
    </div>
  );
}
