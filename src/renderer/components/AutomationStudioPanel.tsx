import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  RoutineWorkflowDefinition,
  RoutineWorkflowNode,
  RoutineWorkflowRunRecord,
  RoutineWorkflowStepRecord,
  RoutineWorkflowTemplate,
  WorkflowCapabilities,
  WorkflowFieldDefinition,
  WorkflowInputValue,
  WorkflowOperationDefinition,
  WorkflowValidationResult,
} from "../../shared/routine-workflow";
import { ROUTINE_WORKFLOW_VERSION } from "../../shared/routine-workflow";
import {
  AlertTriangleIcon,
  BotIcon,
  CalendarIcon,
  CheckIcon,
  CodeIcon,
  FileIcon,
  MessageIcon,
  PlayIcon,
  SlidersIcon,
  TrashIcon,
  ZapIcon,
} from "./LineIcons";
import "./automation-studio.css";

type StudioView = "discover" | "library" | "builder" | "activity";
export type PendingConnection = { sourceNodeId: string; sourcePort: "true" | "false" };

type RoutineSummary = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  workspaceId: string;
  workflow?: RoutineWorkflowDefinition;
  activeWorkflowVersionId?: string;
  updatedAt: number;
};

type WorkspaceSummary = { id: string; name: string; path?: string };

type WorkflowSecretSummary = {
  id: string;
  name: string;
  configured: true;
  createdAt: number;
  updatedAt: number;
};

type TestResult = {
  run: RoutineWorkflowRunRecord;
  steps: RoutineWorkflowStepRecord[];
};

const STARTER_OUTPUT_HINTS: Record<string, string[]> = {
  "starter.manual": ["timestamp", "source"],
  "starter.schedule": ["timestamp", "scheduledAt", "jobId"],
  "starter.gmail_message": [
    "messageId",
    "threadId",
    "subject",
    "from",
    "to",
    "body",
    "attachments",
  ],
  "starter.chat_message": ["spaceName", "sender", "text", "messageId"],
  "starter.chat_mention": ["spaceName", "sender", "text", "messageId"],
  "starter.chat_reaction": ["spaceName", "sender", "reaction", "messageId"],
  "starter.chat_member_joined": ["spaceName", "member"],
  "starter.sheet_changed": ["spreadsheetId", "spreadsheetName", "range", "actor", "values"],
  "starter.drive_item_added": ["id", "name", "mimeType", "webViewLink", "folderId"],
  "starter.drive_file_edited": ["id", "name", "modifiedTime", "webViewLink"],
  "starter.drive_folder_item_edited": ["id", "name", "modifiedTime", "folderId"],
  "starter.meeting_relative": ["summary", "description", "attendees", "organizer", "start", "end"],
  "starter.meeting_outputs_ready": ["meetingTitle", "content", "notesUrl", "transcriptUrl"],
  "starter.form_response": ["formId", "responseId", "answers", "respondentEmail"],
};

const CATEGORY_ICON: Record<string, typeof ZapIcon> = {
  Starters: ZapIcon,
  AI: BotIcon,
  "AI actions": BotIcon,
  Tools: SlidersIcon,
  NotebookLM: FileIcon,
  Gmail: MessageIcon,
  Chat: MessageIcon,
  Sheets: CodeIcon,
  Drive: FileIcon,
  Calendar: CalendarIcon,
  Docs: FileIcon,
  Tasks: CheckIcon,
  CoWork: BotIcon,
  Integrations: CodeIcon,
};

export default function AutomationStudioPanel({
  workspaceId,
  onOpenTask,
}: {
  workspaceId?: string;
  onOpenTask?: (taskId: string) => void;
}) {
  const [view, setView] = useState<StudioView>("discover");
  const [capabilities, setCapabilities] = useState<WorkflowCapabilities | null>(null);
  const [routines, setRoutines] = useState<RoutineSummary[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [googleAccounts, setGoogleAccounts] = useState<string[]>([]);
  const [workflowSecrets, setWorkflowSecrets] = useState<WorkflowSecretSummary[]>([]);
  const [runs, setRuns] = useState<RoutineWorkflowRunRecord[]>([]);
  const [steps, setSteps] = useState<RoutineWorkflowStepRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRoutineId, setSelectedRoutineId] = useState<string | null>(null);
  const [workflow, setWorkflow] = useState<RoutineWorkflowDefinition>(() => createBlankWorkflow());
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [routineName, setRoutineName] = useState("Untitled flow");
  const [routineDescription, setRoutineDescription] = useState("");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(workspaceId || "");
  const [prompt, setPrompt] = useState("");
  const [sampleJson, setSampleJson] = useState(
    '{\n  "source": "test",\n  "subject": "Quarterly review",\n  "body": "Please prepare the action list."\n}',
  );
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [validation, setValidation] = useState<WorkflowValidationResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [inspectorField, setInspectorField] = useState<string | null>(null);
  const [newSecretName, setNewSecretName] = useState("");
  const [newSecretValue, setNewSecretValue] = useState("");
  const [pendingConnection, setPendingConnection] = useState<PendingConnection | null>(null);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [
        nextCapabilities,
        nextRoutines,
        nextWorkspaces,
        nextRuns,
        googleSettings,
        nextSecrets,
      ] = await Promise.all([
        window.electronAPI.getRoutineWorkflowCapabilities(),
        window.electronAPI.listRoutines(),
        window.electronAPI.listWorkspaces(),
        window.electronAPI.listRoutineWorkflowRuns(undefined, 60),
        window.electronAPI.getGoogleWorkspaceSettings().catch(() => null),
        window.electronAPI.listRoutineWorkflowSecrets().catch(() => []),
      ]);
      setCapabilities(nextCapabilities as WorkflowCapabilities);
      setRoutines(nextRoutines as RoutineSummary[]);
      setWorkspaces(nextWorkspaces as WorkspaceSummary[]);
      setRuns(nextRuns as RoutineWorkflowRunRecord[]);
      setWorkflowSecrets(nextSecrets as WorkflowSecretSummary[]);
      setGoogleAccounts(
        Array.from(
          new Set(
            ((googleSettings as Any)?.accounts || [])
              .map((account: Any) => String(account.email || "").trim())
              .filter(Boolean),
          ),
        ),
      );
      setSelectedWorkspaceId((current) => current || workspaceId || nextWorkspaces[0]?.id || "");
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "Automation Studio could not load.",
      );
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    if (!selectedRunId) {
      setSteps([]);
      return;
    }
    let cancelled = false;
    void window.electronAPI
      .listRoutineWorkflowRunSteps(selectedRunId)
      .then((nextSteps) => {
        if (!cancelled) setSteps(nextSteps as RoutineWorkflowStepRecord[]);
      })
      .catch((loadError: unknown) => {
        if (!cancelled)
          setError(loadError instanceof Error ? loadError.message : "Run steps could not load.");
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRunId]);

  const selectedNode = useMemo(
    () => workflow.nodes.find((node) => node.id === selectedNodeId) || null,
    [selectedNodeId, workflow.nodes],
  );
  const selectedOperation = useMemo(
    () =>
      capabilities?.operations.find((operation) => operation.id === selectedNode?.operation) ||
      null,
    [capabilities?.operations, selectedNode?.operation],
  );
  const orderedNodes = useMemo(() => orderWorkflowNodes(workflow), [workflow]);
  const workflowRoutines = useMemo(
    () => routines.filter((routine) => routine.workflow),
    [routines],
  );
  const filteredOperations = useMemo(() => {
    const query = catalogQuery.trim().toLocaleLowerCase();
    const actions =
      capabilities?.operations.filter((operation) => operation.kind !== "starter") || [];
    if (!query) return actions;
    return actions.filter((operation) =>
      `${operation.name} ${operation.description} ${operation.category} ${operation.provider}`
        .toLocaleLowerCase()
        .includes(query),
    );
  }, [capabilities?.operations, catalogQuery]);
  const groupedOperations = useMemo(
    () => groupBy(filteredOperations, (operation) => operation.category),
    [filteredOperations],
  );
  const requiredScopes = useMemo(() => {
    if (!capabilities) return [];
    const scopes = new Set<string>();
    for (const node of flattenNodes(workflow.nodes)) {
      const operation = capabilities.operations.find(
        (candidate) => candidate.id === node.operation,
      );
      operation?.requiredScopes.forEach((scope) => scopes.add(scope));
    }
    return Array.from(scopes).sort();
  }, [capabilities, workflow.nodes]);
  const availableVariables = useMemo(
    () => buildVariableOptions(workflow, capabilities),
    [workflow, capabilities],
  );

  function openWorkflow(routine: RoutineSummary) {
    if (!routine.workflow) return;
    setSelectedRoutineId(routine.id);
    setWorkflow(structuredClone(routine.workflow));
    setRoutineName(routine.name);
    setRoutineDescription(routine.description || "");
    setSelectedWorkspaceId(routine.workspaceId);
    setSelectedNodeId(routine.workflow.starterNodeId);
    setValidation(null);
    setTestResult(null);
    setPendingConnection(null);
    setView("builder");
  }

  function openTemplate(template: RoutineWorkflowTemplate) {
    const draft = structuredClone(template.workflow);
    setSelectedRoutineId(null);
    setWorkflow(draft);
    setRoutineName(template.name);
    setRoutineDescription(template.description);
    setSelectedNodeId(draft.starterNodeId);
    setValidation(null);
    setTestResult(null);
    setPendingConnection(null);
    setView("builder");
  }

  function newBlankWorkflow() {
    const draft = createBlankWorkflow();
    setSelectedRoutineId(null);
    setWorkflow(draft);
    setRoutineName("Untitled flow");
    setRoutineDescription("");
    setSelectedNodeId(draft.starterNodeId);
    setValidation(null);
    setTestResult(null);
    setPendingConnection(null);
    setView("builder");
  }

  async function generateFromPrompt() {
    if (!prompt.trim()) return;
    setBusy("generate");
    setError(null);
    setNotice(null);
    try {
      const generated = await window.electronAPI.generateRoutineWorkflow(prompt.trim());
      const draft = generated.workflow as RoutineWorkflowDefinition;
      setWorkflow(draft);
      setSelectedRoutineId(null);
      setRoutineName(
        generated.matchedTemplateId
          ? capabilities?.templates.find((template) => template.id === generated.matchedTemplateId)
              ?.name || "Generated flow"
          : deriveNameFromPrompt(prompt),
      );
      setRoutineDescription(`Generated from: ${prompt.trim()}`);
      setSelectedNodeId(draft.starterNodeId);
      setValidation(null);
      setTestResult(null);
      setNotice(
        generated.matchedTemplateId
          ? "Template matched. Review its fields before activation."
          : "Editable draft created. Review every action before activation.",
      );
      setView("builder");
    } catch (generationError) {
      setError(
        generationError instanceof Error
          ? generationError.message
          : "The workflow draft could not be generated.",
      );
    } finally {
      setBusy(null);
    }
  }

  function selectStarter(operation: WorkflowOperationDefinition) {
    const starter = workflow.nodes.find((node) => node.id === workflow.starterNodeId);
    if (!starter) return;
    setWorkflow((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === starter.id
          ? {
              ...node,
              operation: operation.id,
              name: operation.name,
              config: defaultOperationConfig(operation),
            }
          : node,
      ),
      updatedAt: Date.now(),
    }));
    setSelectedNodeId(starter.id);
  }

  function addOperation(operation: WorkflowOperationDefinition) {
    const result = appendWorkflowOperation(workflow, operation, pendingConnection || undefined);
    setWorkflow(result.workflow);
    setSelectedNodeId(result.nodeId);
    setPendingConnection(null);
  }

  function removeNode(nodeId: string) {
    if (nodeId === workflow.starterNodeId) return;
    setWorkflow((current) => {
      const incoming = current.edges.find((edge) => edge.targetNodeId === nodeId);
      const outgoing = current.edges.filter((edge) => edge.sourceNodeId === nodeId);
      const retainedEdges = current.edges.filter(
        (edge) => edge.sourceNodeId !== nodeId && edge.targetNodeId !== nodeId,
      );
      if (incoming && outgoing.length === 1) {
        retainedEdges.push({
          id: `${incoming.sourceNodeId}:${incoming.sourcePort || "success"}:${outgoing[0].targetNodeId}`,
          sourceNodeId: incoming.sourceNodeId,
          targetNodeId: outgoing[0].targetNodeId,
          sourcePort: incoming.sourcePort,
        });
      }
      return {
        ...current,
        nodes: current.nodes.filter((node) => node.id !== nodeId),
        edges: retainedEdges,
        updatedAt: Date.now(),
      };
    });
    setSelectedNodeId(workflow.starterNodeId);
    setPendingConnection((current) => (current?.sourceNodeId === nodeId ? null : current));
  }

  function updateSelectedNode(patch: Partial<RoutineWorkflowNode>) {
    if (!selectedNodeId) return;
    setWorkflow((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === selectedNodeId ? { ...node, ...patch } : node,
      ),
      updatedAt: Date.now(),
    }));
  }

  function updateNodeField(field: WorkflowFieldDefinition, raw: string | boolean) {
    if (!selectedNode) return;
    try {
      const nextValue = parseFieldValue(field, raw);
      updateSelectedNode({ config: { ...selectedNode.config, [field.key]: nextValue } });
      setInspectorField(field.key);
      setError(null);
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : `Invalid ${field.label}.`);
    }
  }

  function insertVariable(path: string) {
    if (!selectedNode || !inspectorField) return;
    updateSelectedNode({
      config: {
        ...selectedNode.config,
        [inspectorField]: { $ref: path },
      },
    });
  }

  async function persistDraft(): Promise<{ routineId: string; versionId: string }> {
    setError(null);
    const result = (await window.electronAPI.validateRoutineWorkflow(
      workflow,
      true,
    )) as WorkflowValidationResult;
    setValidation(result);
    if (result.issues.some((issue) => issue.severity === "error")) {
      throw new Error("Resolve the workflow structure errors before saving.");
    }
    if (selectedRoutineId) {
      await window.electronAPI.updateRoutine(selectedRoutineId, {
        name: routineName.trim() || "Untitled flow",
        description: routineDescription.trim(),
        workspaceId: selectedWorkspaceId,
      });
      const saved = await window.electronAPI.saveRoutineWorkflowDraft(selectedRoutineId, workflow);
      return { routineId: selectedRoutineId, versionId: saved.version.id };
    }
    const created = (await window.electronAPI.createRoutine({
      name: routineName.trim() || "Untitled flow",
      description: routineDescription.trim(),
      enabled: false,
      workspaceId: selectedWorkspaceId,
      instructions: `Execute the deterministic workflow named ${routineName.trim() || "Untitled flow"}.`,
      executionTarget: { kind: "workspace" },
      contextBindings: {},
      outputs: [{ kind: "task_only" }],
      approvalPolicy: { mode: "confirm_external" },
      connectorPolicy: { mode: "prefer", connectorIds: [] },
      workflow,
    })) as RoutineSummary;
    const versions = await window.electronAPI.listRoutineWorkflowVersions(created.id);
    const draftVersion = versions.find((version: Any) => version.status === "draft") || versions[0];
    if (!draftVersion) throw new Error("The workflow draft version was not created.");
    setSelectedRoutineId(created.id);
    return { routineId: created.id, versionId: draftVersion.id };
  }

  async function saveDraft() {
    setBusy("save");
    setNotice(null);
    try {
      await persistDraft();
      setNotice("Draft saved. Activation remains off.");
      await loadOverview();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The draft could not be saved.");
    } finally {
      setBusy(null);
    }
  }

  async function activateFlow() {
    setBusy("activate");
    setNotice(null);
    try {
      const strictValidation = (await window.electronAPI.validateRoutineWorkflow(
        workflow,
        false,
      )) as WorkflowValidationResult;
      setValidation(strictValidation);
      if (!strictValidation.valid)
        throw new Error("Complete the required fields before turning on this flow.");
      const saved = await persistDraft();
      await window.electronAPI.activateRoutineWorkflowVersion(saved.routineId, saved.versionId);
      setNotice("Flow turned on. New matching events will enter the durable queue.");
      await loadOverview();
    } catch (activationError) {
      setError(
        activationError instanceof Error
          ? activationError.message
          : "The flow could not be activated.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function testFlow() {
    setBusy("test");
    setNotice(null);
    try {
      const sample = JSON.parse(sampleJson) as Record<string, unknown>;
      const result = (await window.electronAPI.testRoutineWorkflow({
        routineId: selectedRoutineId || undefined,
        workflow,
        sampleEvent: sample,
        dryRun: true,
      })) as TestResult;
      setTestResult(result);
      setNotice("Dry run completed. External writes were previewed, not performed.");
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : "The test run failed.");
    } finally {
      setBusy(null);
    }
  }

  async function runNow() {
    if (!selectedRoutineId) return;
    setBusy("run");
    try {
      const run = await window.electronAPI.runRoutineNow(selectedRoutineId);
      setNotice(run ? "Workflow run started." : "Turn on the flow before running it.");
      await loadOverview();
      setView("activity");
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "The workflow could not start.");
    } finally {
      setBusy(null);
    }
  }

  async function deactivateFlow() {
    if (!selectedRoutineId) return;
    setBusy("deactivate");
    setError(null);
    setNotice(null);
    try {
      await window.electronAPI.updateRoutine(selectedRoutineId, { enabled: false });
      setNotice("Flow turned off. Queued events will not start new runs.");
      await loadOverview();
    } catch (deactivationError) {
      setError(
        deactivationError instanceof Error
          ? deactivationError.message
          : "The flow could not be turned off.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function respondToApproval(step: RoutineWorkflowStepRecord, approved: boolean) {
    setBusy(`approval:${step.id}`);
    try {
      await window.electronAPI.respondToRoutineWorkflowApproval({
        runId: step.runId,
        stepId: step.id,
        approved,
      });
      const [nextRuns, nextSteps] = await Promise.all([
        window.electronAPI.listRoutineWorkflowRuns(undefined, 60),
        window.electronAPI.listRoutineWorkflowRunSteps(step.runId),
      ]);
      setRuns(nextRuns as RoutineWorkflowRunRecord[]);
      setSteps(nextSteps as RoutineWorkflowStepRecord[]);
    } catch (approvalError) {
      setError(
        approvalError instanceof Error
          ? approvalError.message
          : "The approval could not be recorded.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function createWorkflowSecret() {
    if (!newSecretName.trim() || !newSecretValue) return;
    setBusy("secret");
    setError(null);
    try {
      const saved = (await window.electronAPI.upsertRoutineWorkflowSecret({
        name: newSecretName.trim(),
        value: newSecretValue,
      })) as WorkflowSecretSummary;
      setWorkflowSecrets((current) => [
        ...current.filter((secret) => secret.id !== saved.id),
        saved,
      ]);
      if (selectedNode?.operation === "custom.webhook") {
        updateSelectedNode({ config: { ...selectedNode.config, secretRef: saved.id } });
      }
      setNewSecretName("");
      setNewSecretValue("");
      setNotice("Signing secret stored securely and selected for this step.");
    } catch (secretError) {
      setError(
        secretError instanceof Error
          ? secretError.message
          : "The signing secret could not be stored.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function removeWorkflowSecret(id: string) {
    setBusy(`secret:${id}`);
    setError(null);
    try {
      await window.electronAPI.removeRoutineWorkflowSecret(id);
      setWorkflowSecrets((current) => current.filter((secret) => secret.id !== id));
      setWorkflow((current) => ({
        ...current,
        nodes: current.nodes.map((node) =>
          node.config.secretRef === id
            ? { ...node, config: { ...node.config, secretRef: "" } }
            : node,
        ),
        updatedAt: Date.now(),
      }));
      setNotice("Signing secret removed. Any affected webhook step must select another secret.");
    } catch (secretError) {
      setError(
        secretError instanceof Error
          ? secretError.message
          : "The signing secret could not be removed.",
      );
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <StudioSkeleton />;

  return (
    <section className="automation-studio" aria-label="Automation Studio">
      <header className="studio-topbar">
        <div>
          <span className="studio-eyebrow">Automation Studio</span>
          <h2>Build work that runs itself</h2>
        </div>
        <nav className="studio-view-tabs" aria-label="Automation Studio views">
          {(["discover", "library", "builder", "activity"] as StudioView[]).map((item) => (
            <button
              key={item}
              className={view === item ? "active" : ""}
              onClick={() => setView(item)}
            >
              {item[0].toUpperCase() + item.slice(1)}
            </button>
          ))}
        </nav>
      </header>

      {(error || notice) && (
        <div
          className={`studio-inline-message ${error ? "error" : "success"}`}
          role={error ? "alert" : "status"}
        >
          {error ? <AlertTriangleIcon size={17} /> : <CheckIcon size={17} />}
          <span>{error || notice}</span>
          <button
            onClick={() => {
              setError(null);
              setNotice(null);
            }}
            aria-label="Dismiss message"
          >
            Dismiss
          </button>
        </div>
      )}

      {view === "discover" && capabilities && (
        <div className="studio-discover">
          <div className="studio-prompt-block">
            <div>
              <span className="studio-section-index">01</span>
              <h3>Describe the outcome</h3>
              <p>
                CoWork creates an editable draft. It stays off until validation and scope review are
                complete.
              </p>
            </div>
            <div className="studio-prompt-input">
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Summarize unread customer emails every weekday and post the action items to Chat"
                rows={4}
              />
              <button
                className="studio-primary"
                disabled={!prompt.trim() || busy === "generate"}
                onClick={() => void generateFromPrompt()}
              >
                {busy === "generate" ? "Creating draft…" : "Create draft"}
              </button>
            </div>
          </div>

          <div className="studio-template-heading">
            <div>
              <span className="studio-section-index">02</span>
              <h3>Start from a proven pattern</h3>
            </div>
            <button className="studio-secondary" onClick={newBlankWorkflow}>
              Blank flow
            </button>
          </div>
          <div className="studio-template-grid">
            {capabilities.templates.map((template, index) => (
              <button
                key={template.id}
                className="studio-template"
                onClick={() => openTemplate(template)}
                style={{ "--studio-order": index } as React.CSSProperties}
              >
                <span>{template.category}</span>
                <strong>{template.name}</strong>
                <p>{template.description}</p>
                <small>{template.workflow.nodes.length} steps</small>
              </button>
            ))}
          </div>
        </div>
      )}

      {view === "library" && (
        <div className="studio-library">
          <div className="studio-library-summary">
            <div>
              <strong>{workflowRoutines.length}</strong>
              <span>structured flows</span>
            </div>
            <div>
              <strong>{workflowRoutines.filter((routine) => routine.enabled).length}</strong>
              <span>currently on</span>
            </div>
            <button className="studio-primary" onClick={newBlankWorkflow}>
              New flow
            </button>
          </div>
          {workflowRoutines.length === 0 ? (
            <StudioEmpty
              title="No structured flows yet"
              body="Create a blank flow or begin with a template."
              action="Browse templates"
              onAction={() => setView("discover")}
            />
          ) : (
            <div className="studio-flow-list">
              {workflowRoutines.map((routine) => {
                const recent = runs.find((run) => run.routineId === routine.id);
                return (
                  <button
                    key={routine.id}
                    className="studio-flow-row"
                    onClick={() => openWorkflow(routine)}
                  >
                    <span className={`studio-status-dot ${routine.enabled ? "on" : "draft"}`} />
                    <div>
                      <strong>{routine.name}</strong>
                      <p>{routine.description || "No description"}</p>
                    </div>
                    <span>{routine.workflow?.nodes.length || 0} steps</span>
                    <span className={`studio-run-state state-${recent?.status || "idle"}`}>
                      {recent?.status?.replace(/_/g, " ") || "Not run"}
                    </span>
                    <time>{formatRelativeTime(routine.updatedAt)}</time>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {view === "builder" && capabilities && (
        <div className="studio-builder-shell">
          <aside className="studio-catalog">
            <div className="studio-pane-heading">
              <span>Actions</span>
              <small>{filteredOperations.length}</small>
            </div>
            {pendingConnection && (
              <div className={`studio-branch-target branch-${pendingConnection.sourcePort}`}>
                <span>
                  Next action: {pendingConnection.sourcePort === "true" ? "Yes" : "No"} branch
                </span>
                <button type="button" onClick={() => setPendingConnection(null)}>
                  Clear
                </button>
              </div>
            )}
            <input
              value={catalogQuery}
              onChange={(event) => setCatalogQuery(event.target.value)}
              placeholder="Find an action"
              aria-label="Find an action"
            />
            <div className="studio-catalog-scroll">
              {Object.entries(groupedOperations).map(([category, operations]) => {
                const Icon = CATEGORY_ICON[category] || CodeIcon;
                return (
                  <section key={category}>
                    <h4>
                      <Icon size={15} />
                      {category}
                    </h4>
                    {operations.map((operation) => (
                      <button key={operation.id} onClick={() => addOperation(operation)}>
                        <span>{operation.name}</span>
                        <small>
                          {operation.availability === "preview" ? "Preview" : operation.provider}
                        </small>
                      </button>
                    ))}
                  </section>
                );
              })}
            </div>
          </aside>

          <main className="studio-canvas">
            <div className="studio-flow-meta">
              <div>
                <input
                  value={routineName}
                  onChange={(event) => setRoutineName(event.target.value)}
                  aria-label="Flow name"
                />
                <input
                  value={routineDescription}
                  onChange={(event) => setRoutineDescription(event.target.value)}
                  placeholder="What this flow accomplishes"
                  aria-label="Flow description"
                />
                <select
                  value={selectedWorkspaceId}
                  onChange={(event) => setSelectedWorkspaceId(event.target.value)}
                  aria-label="Flow workspace"
                >
                  {workspaces.map((workspace) => (
                    <option value={workspace.id} key={workspace.id}>
                      {workspace.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="studio-builder-actions">
                <button
                  className="studio-secondary"
                  disabled={Boolean(busy)}
                  onClick={() => void testFlow()}
                >
                  <PlayIcon size={15} />
                  Test
                </button>
                <button
                  className="studio-secondary"
                  disabled={Boolean(busy)}
                  onClick={() => void saveDraft()}
                >
                  {busy === "save" ? "Saving…" : "Save draft"}
                </button>
                {selectedRoutineId &&
                  routines.find((routine) => routine.id === selectedRoutineId)?.enabled && (
                    <>
                      <button
                        className="studio-secondary studio-danger-action"
                        disabled={Boolean(busy)}
                        onClick={() => void deactivateFlow()}
                      >
                        {busy === "deactivate" ? "Turning off…" : "Turn off"}
                      </button>
                      <button
                        className="studio-secondary"
                        disabled={Boolean(busy)}
                        onClick={() => void runNow()}
                      >
                        Run now
                      </button>
                    </>
                  )}
                <button
                  className="studio-primary"
                  disabled={Boolean(busy)}
                  onClick={() => void activateFlow()}
                >
                  {busy === "activate" ? "Turning on…" : "Turn on"}
                </button>
              </div>
            </div>

            <div className="studio-canvas-workspace">
              <div className="studio-starter-picker">
                <span>Starter</span>
                <select
                  value={
                    workflow.nodes.find((node) => node.id === workflow.starterNodeId)?.operation ||
                    "starter.manual"
                  }
                  onChange={(event) => {
                    const operation = capabilities.operations.find(
                      (candidate) => candidate.id === event.target.value,
                    );
                    if (operation) selectStarter(operation);
                  }}
                >
                  {capabilities.operations
                    .filter((operation) => operation.kind === "starter")
                    .map((operation) => (
                      <option value={operation.id} key={operation.id}>
                        {operation.name}
                        {operation.availability === "preview" ? " (Preview)" : ""}
                      </option>
                    ))}
                </select>
              </div>

              <div className="studio-node-flow">
                {orderedNodes.map((node, index) => {
                  const operation = capabilities.operations.find(
                    (candidate) => candidate.id === node.operation,
                  );
                  const Icon = CATEGORY_ICON[operation?.category || ""] || CodeIcon;
                  const incomingEdge = workflow.edges.find((edge) => edge.targetNodeId === node.id);
                  return (
                    <div key={node.id} className="studio-node-wrap">
                      {index > 0 && <span className="studio-connector-line" />}
                      <button
                        className={`studio-node ${selectedNodeId === node.id ? "selected" : ""}`}
                        onClick={() => setSelectedNodeId(node.id)}
                      >
                        <span className="studio-node-icon">
                          <Icon size={18} />
                        </span>
                        <span>
                          <small>{node.kind}</small>
                          <strong>{node.name}</strong>
                          <em>{operation?.provider || "CoWork"}</em>
                          {incomingEdge?.sourcePort === "true" && (
                            <b className="studio-branch-label branch-true">Yes branch</b>
                          )}
                          {incomingEdge?.sourcePort === "false" && (
                            <b className="studio-branch-label branch-false">No branch</b>
                          )}
                        </span>
                        <span className={`studio-risk risk-${operation?.risk || "read"}`}>
                          {formatRisk(operation?.risk)}
                        </span>
                      </button>
                    </div>
                  );
                })}
                <button
                  className="studio-add-step"
                  onClick={() =>
                    document.querySelector<HTMLInputElement>(".studio-catalog > input")?.focus()
                  }
                >
                  Add the next action
                </button>
              </div>
            </div>
          </main>

          <aside className="studio-inspector">
            {selectedNode && selectedOperation ? (
              <>
                <div className="studio-pane-heading">
                  <span>Configure</span>
                  <small>{selectedOperation.provider}</small>
                </div>
                <div className="studio-inspector-title">
                  <input
                    value={selectedNode.name}
                    onChange={(event) => updateSelectedNode({ name: event.target.value })}
                    aria-label="Step name"
                  />
                  {selectedNode.id !== workflow.starterNodeId && (
                    <button onClick={() => removeNode(selectedNode.id)} aria-label="Remove step">
                      <TrashIcon size={16} />
                    </button>
                  )}
                </div>
                <p>{selectedOperation.description}</p>
                {selectedNode.kind === "condition" && (
                  <div className="studio-branch-builder">
                    <span>Add the next action to</span>
                    <div>
                      <button
                        type="button"
                        className={
                          pendingConnection?.sourceNodeId === selectedNode.id &&
                          pendingConnection.sourcePort === "true"
                            ? "selected"
                            : ""
                        }
                        onClick={() => {
                          setPendingConnection({
                            sourceNodeId: selectedNode.id,
                            sourcePort: "true",
                          });
                          document
                            .querySelector<HTMLInputElement>(".studio-catalog > input")
                            ?.focus();
                        }}
                      >
                        Yes branch
                      </button>
                      <button
                        type="button"
                        className={
                          pendingConnection?.sourceNodeId === selectedNode.id &&
                          pendingConnection.sourcePort === "false"
                            ? "selected"
                            : ""
                        }
                        onClick={() => {
                          setPendingConnection({
                            sourceNodeId: selectedNode.id,
                            sourcePort: "false",
                          });
                          document
                            .querySelector<HTMLInputElement>(".studio-catalog > input")
                            ?.focus();
                        }}
                      >
                        No branch
                      </button>
                    </div>
                    <small>Select a branch, then choose an action from the catalog.</small>
                  </div>
                )}
                <div className="studio-field-list">
                  {selectedOperation.fields.map((field) => (
                    <StudioField
                      key={field.key}
                      field={field}
                      value={selectedNode.config[field.key]}
                      onFocus={() => setInspectorField(field.key)}
                      onChange={(value) => updateNodeField(field, value)}
                      optionsOverride={
                        field.key === "secretRef"
                          ? workflowSecrets.map((secret) => ({
                              value: secret.id,
                              label: secret.name,
                            }))
                          : undefined
                      }
                    />
                  ))}
                </div>
                {selectedNode.operation === "custom.webhook" && (
                  <details className="studio-secret-manager" open={workflowSecrets.length === 0}>
                    <summary>Signing secrets</summary>
                    <p>
                      Values are encrypted with the operating-system keychain and never returned to
                      the renderer.
                    </p>
                    {workflowSecrets.map((secret) => (
                      <div className="studio-secret-row" key={secret.id}>
                        <span>
                          <strong>{secret.name}</strong>
                          <small>Configured</small>
                        </span>
                        <button
                          type="button"
                          disabled={busy === `secret:${secret.id}`}
                          onClick={() => void removeWorkflowSecret(secret.id)}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                    <label>
                      Name
                      <input
                        value={newSecretName}
                        onChange={(event) => setNewSecretName(event.target.value)}
                        placeholder="CRM webhook"
                      />
                    </label>
                    <label>
                      Secret value
                      <input
                        type="password"
                        value={newSecretValue}
                        onChange={(event) => setNewSecretValue(event.target.value)}
                        autoComplete="new-password"
                      />
                    </label>
                    <button
                      className="studio-secondary"
                      type="button"
                      disabled={!newSecretName.trim() || !newSecretValue || busy === "secret"}
                      onClick={() => void createWorkflowSecret()}
                    >
                      {busy === "secret" ? "Storing…" : "Store and select"}
                    </button>
                  </details>
                )}
                <div className="studio-variable-picker">
                  <h4>Variables</h4>
                  <p>Choose a value from the starter or an earlier step.</p>
                  <div>
                    {availableVariables.map((variable) => (
                      <button
                        key={variable}
                        disabled={!inspectorField}
                        onClick={() => insertVariable(variable)}
                      >
                        {variable}
                      </button>
                    ))}
                  </div>
                </div>
                <details className="studio-advanced-settings">
                  <summary>Reliability and approvals</summary>
                  <label>
                    Failure behavior
                    <select
                      value={selectedNode.onError || "fail"}
                      onChange={(event) =>
                        updateSelectedNode({ onError: event.target.value as "fail" | "continue" })
                      }
                    >
                      <option value="fail">Stop flow</option>
                      <option value="continue">Continue</option>
                    </select>
                  </label>
                  <label>
                    Approval
                    <select
                      value={selectedNode.approvalMode || "inherit"}
                      onChange={(event) =>
                        updateSelectedNode({
                          approvalMode: event.target.value as RoutineWorkflowNode["approvalMode"],
                        })
                      }
                    >
                      <option value="inherit">Use flow policy</option>
                      <option value="always_confirm">Always confirm</option>
                      <option value="never_confirm_safe">Skip for safe actions</option>
                    </select>
                  </label>
                  <label>
                    Retry attempts
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={selectedNode.retry?.maxAttempts || 1}
                      onChange={(event) =>
                        updateSelectedNode({
                          retry: { ...selectedNode.retry, maxAttempts: Number(event.target.value) },
                        })
                      }
                    />
                  </label>
                </details>
              </>
            ) : (
              <StudioEmpty
                title="Select a step"
                body="Step fields, variables, reliability, and approval controls appear here."
              />
            )}
          </aside>

          <section className="studio-test-drawer">
            <div className="studio-pane-heading">
              <span>Test and scope review</span>
              <small>Dry run</small>
            </div>
            <div className="studio-test-grid">
              <label>
                Sample event
                <textarea
                  rows={7}
                  value={sampleJson}
                  onChange={(event) => setSampleJson(event.target.value)}
                  spellCheck={false}
                />
              </label>
              <div className="studio-scope-review">
                <h4>Required Google scopes</h4>
                {googleAccounts.length > 0 && (
                  <label>
                    Google account
                    <select
                      value={workflow.accountBindings?.["google-workspace"] || ""}
                      onChange={(event) =>
                        setWorkflow((current) => ({
                          ...current,
                          accountBindings: {
                            ...current.accountBindings,
                            "google-workspace": event.target.value,
                          },
                          updatedAt: Date.now(),
                        }))
                      }
                    >
                      <option value="">Current active account</option>
                      {googleAccounts.map((email) => (
                        <option value={email} key={email}>
                          {email}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {requiredScopes.length ? (
                  requiredScopes.map((scope) => (
                    <code key={scope}>{scope.replace("https://www.googleapis.com/auth/", "")}</code>
                  ))
                ) : (
                  <span>No Google scopes required</span>
                )}
                {validation?.issues.map((issue) => (
                  <p key={`${issue.code}:${issue.path}`} className={issue.severity}>
                    {issue.message}
                  </p>
                ))}
              </div>
              <div className="studio-test-result">
                <h4>Latest test</h4>
                {!testResult ? (
                  <span>No test run yet</span>
                ) : (
                  testResult.steps.map((step) => (
                    <div key={step.id}>
                      <span className={`studio-status-dot ${step.status}`} />
                      <strong>{step.operation}</strong>
                      <small>{step.status.replace(/_/g, " ")}</small>
                    </div>
                  ))
                )}
              </div>
            </div>
          </section>
        </div>
      )}

      {view === "activity" && (
        <div className="studio-activity">
          <aside>
            <div className="studio-pane-heading">
              <span>Runs</span>
              <small>{runs.length}</small>
            </div>
            {runs.length === 0 ? (
              <StudioEmpty title="No runs yet" body="Test or turn on a flow to create activity." />
            ) : (
              runs.map((run) => (
                <button
                  key={run.id}
                  className={selectedRunId === run.id ? "selected" : ""}
                  onClick={() => setSelectedRunId(run.id)}
                >
                  <span className={`studio-status-dot ${run.status}`} />
                  <span>
                    <strong>
                      {routines.find((routine) => routine.id === run.routineId)?.name || "Workflow"}
                    </strong>
                    <small>{formatRelativeTime(run.createdAt)}</small>
                  </span>
                  <em>{run.status.replace(/_/g, " ")}</em>
                </button>
              ))
            )}
          </aside>
          <main>
            {!selectedRunId ? (
              <StudioEmpty
                title="Select a run"
                body="Inspect step inputs, outputs, retries, failures, and approvals."
              />
            ) : (
              <>
                <div className="studio-activity-header">
                  <div>
                    <span>Run</span>
                    <code>{selectedRunId}</code>
                  </div>
                  <button
                    className="studio-secondary"
                    onClick={() =>
                      void window.electronAPI
                        .cancelRoutineWorkflowRun(selectedRunId)
                        .then(loadOverview)
                    }
                  >
                    Cancel run
                  </button>
                </div>
                <div className="studio-step-timeline">
                  {steps.map((step) => (
                    <article key={step.id}>
                      <span className={`studio-status-dot ${step.status}`} />
                      <div>
                        <small>{step.operation}</small>
                        <strong>{step.status.replace(/_/g, " ")}</strong>
                        {step.error && <p>{step.error}</p>}
                        <em>
                          {step.attemptCount} attempt{step.attemptCount === 1 ? "" : "s"}
                        </em>
                      </div>
                      {step.status === "waiting_for_approval" && (
                        <div className="studio-approval-actions">
                          <button
                            className="studio-secondary"
                            disabled={busy === `approval:${step.id}`}
                            onClick={() => void respondToApproval(step, false)}
                          >
                            Reject
                          </button>
                          <button
                            className="studio-primary"
                            disabled={busy === `approval:${step.id}`}
                            onClick={() => void respondToApproval(step, true)}
                          >
                            Approve once
                          </button>
                        </div>
                      )}
                      {step.output && (
                        <details>
                          <summary>Output</summary>
                          <pre>{JSON.stringify(step.output, null, 2)}</pre>
                        </details>
                      )}
                    </article>
                  ))}
                </div>
                {steps.some((step) => step.output?.taskId) && onOpenTask && (
                  <button
                    className="studio-secondary"
                    onClick={() => {
                      const taskId = steps.find((step) => typeof step.output?.taskId === "string")
                        ?.output?.taskId;
                      if (typeof taskId === "string") onOpenTask(taskId);
                    }}
                  >
                    Open backing task
                  </button>
                )}
              </>
            )}
          </main>
        </div>
      )}
    </section>
  );
}

function StudioField({
  field,
  value,
  onChange,
  onFocus,
  optionsOverride,
}: {
  field: WorkflowFieldDefinition;
  value: WorkflowInputValue | undefined;
  onChange: (value: string | boolean) => void;
  onFocus: () => void;
  optionsOverride?: Array<{ value: string; label: string }>;
}) {
  const display = displayFieldValue(value);
  if (field.type === "boolean") {
    return (
      <label className="studio-toggle-field">
        <span>
          {field.label}
          {field.required && <sup>Required</sup>}
        </span>
        <input
          type="checkbox"
          checked={Boolean(value)}
          onFocus={onFocus}
          onChange={(event) => onChange(event.target.checked)}
        />
      </label>
    );
  }
  return (
    <label>
      <span>
        {field.label}
        {field.required && <sup>Required</sup>}
      </span>
      {field.type === "select" || optionsOverride ? (
        <select
          value={display}
          onFocus={onFocus}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">Select</option>
          {(optionsOverride || field.options)?.map((option) => (
            <option value={option.value} key={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : field.type === "json" ? (
        <textarea
          rows={5}
          value={display}
          onFocus={onFocus}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
        />
      ) : (
        <input
          type={field.type === "number" ? "number" : "text"}
          value={display}
          onFocus={onFocus}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
        />
      )}
      {field.description && <small>{field.description}</small>}
    </label>
  );
}

function StudioSkeleton() {
  return (
    <section className="automation-studio studio-skeleton" aria-label="Loading Automation Studio">
      <div />
      <div />
      <div className="studio-skeleton-grid">
        <span />
        <span />
        <span />
      </div>
    </section>
  );
}

function StudioEmpty({
  title,
  body,
  action,
  onAction,
}: {
  title: string;
  body: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="studio-empty">
      <span className="studio-empty-mark" />
      <strong>{title}</strong>
      <p>{body}</p>
      {action && onAction && (
        <button className="studio-secondary" onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  );
}

export function appendWorkflowOperation(
  workflow: RoutineWorkflowDefinition,
  operation: WorkflowOperationDefinition,
  connection?: PendingConnection,
  nodeId: string = crypto.randomUUID(),
): { workflow: RoutineWorkflowDefinition; nodeId: string } {
  const ordered = orderWorkflowNodes(workflow);
  const requestedSource = connection
    ? workflow.nodes.find((node) => node.id === connection.sourceNodeId)
    : undefined;
  const source = requestedSource || ordered.at(-1);
  const sourcePort = connection?.sourcePort || (source?.kind === "condition" ? "true" : "success");
  const nextNode: RoutineWorkflowNode = {
    id: nodeId,
    kind: operation.kind,
    operation: operation.id,
    name: operation.name,
    description: operation.description,
    config: defaultOperationConfig(operation),
    position: { x: 84, y: ordered.length * 132 + 80 },
    retry: {
      maxAttempts: operation.risk === "read" ? 2 : 1,
      initialDelayMs: 750,
      backoffMultiplier: 2,
    },
    onError: "fail",
  };
  return {
    nodeId,
    workflow: {
      ...workflow,
      nodes: [...workflow.nodes, nextNode],
      edges: source
        ? [
            ...workflow.edges,
            {
              id: `${source.id}:${sourcePort}:${nodeId}`,
              sourceNodeId: source.id,
              targetNodeId: nodeId,
              sourcePort,
            },
          ]
        : workflow.edges,
      updatedAt: Date.now(),
    },
  };
}

function createBlankWorkflow(): RoutineWorkflowDefinition {
  const starterId = crypto.randomUUID();
  return {
    version: ROUTINE_WORKFLOW_VERSION,
    starterNodeId: starterId,
    nodes: [
      {
        id: starterId,
        kind: "starter",
        operation: "starter.manual",
        name: "Run manually",
        config: {},
        position: { x: 84, y: 80 },
      },
    ],
    edges: [],
    settings: {
      maxRunDurationMs: 1_800_000,
      maxStepCount: 100,
      maxForEachItems: 100,
      maxParallelSteps: 4,
      retainStepDataDays: 30,
    },
    updatedAt: Date.now(),
  };
}

function defaultOperationConfig(
  operation: WorkflowOperationDefinition,
): Record<string, WorkflowInputValue> {
  return Object.fromEntries(
    operation.fields
      .filter((field) => field.defaultValue !== undefined)
      .map((field) => [field.key, structuredClone(field.defaultValue!)]),
  );
}

function orderWorkflowNodes(workflow: RoutineWorkflowDefinition): RoutineWorkflowNode[] {
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
  const ordered: RoutineWorkflowNode[] = [];
  const visited = new Set<string>();
  const queue = [workflow.starterNodeId];
  while (queue.length) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    const node = byId.get(id);
    if (!node) continue;
    visited.add(id);
    ordered.push(node);
    queue.push(
      ...workflow.edges.filter((edge) => edge.sourceNodeId === id).map((edge) => edge.targetNodeId),
    );
  }
  return [...ordered, ...workflow.nodes.filter((node) => !visited.has(node.id))];
}

function flattenNodes(nodes: RoutineWorkflowNode[]): RoutineWorkflowNode[] {
  return nodes.flatMap((node) => [node, ...flattenNodes(node.children || [])]);
}

function buildVariableOptions(
  workflow: RoutineWorkflowDefinition,
  capabilities: WorkflowCapabilities | null,
): string[] {
  const values = new Set<string>();
  const starter = workflow.nodes.find((node) => node.id === workflow.starterNodeId);
  for (const field of STARTER_OUTPUT_HINTS[starter?.operation || "starter.manual"] || [])
    values.add(`trigger.${field}`);
  for (const node of orderWorkflowNodes(workflow)) {
    if (node.id === workflow.starterNodeId) continue;
    const operation = capabilities?.operations.find((candidate) => candidate.id === node.operation);
    operation?.outputFields.forEach((field) => values.add(`${node.id}.${field}`));
  }
  return Array.from(values);
}

function parseFieldValue(
  field: WorkflowFieldDefinition,
  raw: string | boolean,
): WorkflowInputValue {
  if (typeof raw === "boolean") return raw;
  if (field.type === "number") return Number(raw);
  if (field.type === "list")
    return raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  if (field.type === "json") return raw.trim() ? (JSON.parse(raw) as WorkflowInputValue) : {};
  const exactReference = raw.match(/^{{\s*([^{}]+?)\s*}}$/);
  if (exactReference) return { $ref: exactReference[1].trim() };
  if (/{{\s*[^{}]+?\s*}}/.test(raw)) return { $template: raw };
  return raw;
}

function displayFieldValue(value: WorkflowInputValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (typeof value === "object") {
    if ("$ref" in value) return `{{${value.$ref}}}`;
    if ("$template" in value && typeof value.$template === "string") return value.$template;
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  return items.reduce<Record<string, T[]>>((groups, item) => {
    const group = key(item);
    groups[group] = [...(groups[group] || []), item];
    return groups;
  }, {});
}

function formatRisk(risk?: string): string {
  if (!risk || risk === "read") return "Read";
  if (risk === "local_write") return "Local";
  if (risk === "external_write") return "Writes";
  return "Export";
}

function deriveNameFromPrompt(value: string): string {
  const words = value.trim().split(/\s+/).slice(0, 7).join(" ");
  return words ? words[0].toUpperCase() + words.slice(1) : "Generated flow";
}

function formatRelativeTime(timestamp: number): string {
  const delta = Date.now() - Number(timestamp || 0);
  if (delta < 60_000) return "Just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return new Date(timestamp).toLocaleDateString();
}
