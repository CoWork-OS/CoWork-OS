import { useEffect, useMemo, useState } from "react";

interface WebWorkspace {
  id: string;
  name: string;
  path?: string;
}

interface WebTask {
  id: string;
  title?: string;
  status?: string;
  workspaceId?: string;
  createdAt?: number;
}

interface WebTaskEvent {
  id?: string;
  type?: string;
  createdAt?: number;
  payload?: unknown;
}

async function apiRequest<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers || {});
  headers.set("Content-Type", "application/json");
  const trimmedToken = token.trim();
  if (trimmedToken) {
    headers.set("Authorization", `Bearer ${trimmedToken}`);
  }
  const response = await fetch(path, { ...init, headers });
  const bodyText = await response.text();
  const parsed = bodyText ? JSON.parse(bodyText) : null;
  if (!response.ok) {
    const msg =
      typeof parsed?.error === "string"
        ? parsed.error
        : `Request failed (${response.status}) for ${path}`;
    throw new Error(msg);
  }
  return parsed as T;
}

function formatDate(ts?: number): string {
  if (!ts) return "-";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "-";
  }
}

export function WebAccessClient() {
  const initialToken = useMemo(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get("token") || "";
    } catch {
      return "";
    }
  }, []);

  const [token, setToken] = useState(initialToken);
  const [workspaces, setWorkspaces] = useState<WebWorkspace[]>([]);
  const [tasks, setTasks] = useState<WebTask[]>([]);
  const [taskEvents, setTaskEvents] = useState<WebTaskEvent[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [title, setTitle] = useState("Web Access Task");
  const [prompt, setPrompt] = useState("");
  const [followupMessage, setFollowupMessage] = useState("");
  const [statusMessage, setStatusMessage] = useState("Disconnected");
  const [healthOk, setHealthOk] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshHealth = async () => {
    try {
      const health = await fetch("/api/health");
      setHealthOk(health.ok);
    } catch {
      setHealthOk(false);
    }
  };

  useEffect(() => {
    void refreshHealth();
    const timer = setInterval(() => void refreshHealth(), 5000);
    return () => clearInterval(timer);
  }, []);

  const refreshData = async () => {
    const [loadedWorkspaces, loadedTasks] = await Promise.all([
      apiRequest<WebWorkspace[]>("/api/workspaces", token),
      apiRequest<WebTask[]>("/api/tasks", token),
    ]);
    setWorkspaces(loadedWorkspaces || []);
    setTasks(loadedTasks || []);

    if (!selectedWorkspaceId && loadedWorkspaces.length > 0) {
      setSelectedWorkspaceId(loadedWorkspaces[0].id);
    }
  };

  const connect = async () => {
    setBusy(true);
    try {
      await refreshData();
      setStatusMessage("Connected");
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Connection failed");
    } finally {
      setBusy(false);
    }
  };

  const createTask = async () => {
    if (!prompt.trim()) {
      setStatusMessage("Task prompt is required");
      return;
    }
    setBusy(true);
    try {
      const payload: Record<string, string> = {
        prompt: prompt.trim(),
        title: title.trim() || "Web Access Task",
      };
      if (selectedWorkspaceId) {
        payload.workspaceId = selectedWorkspaceId;
      }
      await apiRequest<WebTask>("/api/tasks", token, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setPrompt("");
      setStatusMessage("Task created");
      await refreshData();
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Task create failed");
    } finally {
      setBusy(false);
    }
  };

  const loadTaskEvents = async () => {
    if (!selectedTaskId) return;
    setBusy(true);
    try {
      const events = await apiRequest<WebTaskEvent[]>(`/api/tasks/${selectedTaskId}/events`, token);
      setTaskEvents(events || []);
      setStatusMessage(`Loaded ${events?.length || 0} event(s)`);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Failed to load task events");
    } finally {
      setBusy(false);
    }
  };

  const sendTaskMessage = async () => {
    if (!selectedTaskId || !followupMessage.trim()) return;
    setBusy(true);
    try {
      await apiRequest(`/api/tasks/${selectedTaskId}/message`, token, {
        method: "POST",
        body: JSON.stringify({ message: followupMessage.trim() }),
      });
      setFollowupMessage("");
      setStatusMessage("Message sent");
      await loadTaskEvents();
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Failed to send message");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        padding: 20,
        color: "#e5e7eb",
        background:
          "radial-gradient(1200px 600px at 15% 10%, rgba(34,211,238,0.12), transparent 55%), radial-gradient(900px 500px at 85% 5%, rgba(251,146,60,0.10), transparent 55%), #0b1020",
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Segoe UI", system-ui, sans-serif',
      }}
    >
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <h1 style={{ marginBottom: 6, fontSize: 22 }}>CoWork OS Web Access</h1>
        <p style={{ margin: 0, color: "#9ca3af", fontSize: 13 }}>
          Browser client for the Web Access REST API.
        </p>

        <div
          style={{
            marginTop: 14,
            padding: 14,
            borderRadius: 12,
            background: "rgba(15, 23, 42, 0.7)",
            border: "1px solid rgba(255,255,255,0.12)",
          }}
        >
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "end" }}>
            <div style={{ minWidth: 260, flex: "1 1 260px" }}>
              <label style={{ fontSize: 12, color: "#9ca3af", display: "block", marginBottom: 6 }}>
                Access Token
              </label>
              <input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="Paste Access Token from Settings"
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid rgba(255,255,255,0.16)",
                  background: "rgba(0,0,0,0.25)",
                  color: "#e5e7eb",
                }}
              />
            </div>
            <button
              type="button"
              onClick={() => void connect()}
              disabled={busy || !token.trim()}
              style={{
                padding: "10px 14px",
                borderRadius: 8,
                border: "1px solid rgba(34,211,238,0.4)",
                background: "rgba(34,211,238,0.15)",
                color: "#e5e7eb",
                cursor: "pointer",
              }}
            >
              Connect
            </button>
            <button
              type="button"
              onClick={() => void refreshData()}
              disabled={busy || !token.trim()}
              style={{
                padding: "10px 14px",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.22)",
                background: "rgba(255,255,255,0.08)",
                color: "#e5e7eb",
                cursor: "pointer",
              }}
            >
              Refresh
            </button>
          </div>
          <div style={{ marginTop: 10, fontSize: 12, color: "#9ca3af" }}>
            Health:{" "}
            <strong
              style={{
                color: healthOk === true ? "#34d399" : healthOk === false ? "#f87171" : "#fbbf24",
              }}
            >
              {healthOk === null ? "checking..." : healthOk ? "ok" : "down"}
            </strong>{" "}
            | Status: <strong style={{ color: "#e5e7eb" }}>{statusMessage}</strong>
          </div>
        </div>

        <div style={{ display: "grid", gap: 14, marginTop: 14, gridTemplateColumns: "1fr 1fr" }}>
          <div
            style={{
              padding: 14,
              borderRadius: 12,
              background: "rgba(15, 23, 42, 0.7)",
              border: "1px solid rgba(255,255,255,0.12)",
            }}
          >
            <h2 style={{ marginTop: 0, marginBottom: 10, fontSize: 14, color: "#9ca3af" }}>
              Create Task
            </h2>
            <label style={{ fontSize: 12, color: "#9ca3af", display: "block", marginBottom: 6 }}>
              Workspace
            </label>
            <select
              value={selectedWorkspaceId}
              onChange={(event) => setSelectedWorkspaceId(event.target.value)}
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.16)",
                background: "rgba(0,0,0,0.25)",
                color: "#e5e7eb",
              }}
            >
              <option value="">Default workspace</option>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>

            <label
              style={{
                fontSize: 12,
                color: "#9ca3af",
                display: "block",
                marginTop: 10,
                marginBottom: 6,
              }}
            >
              Title
            </label>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.16)",
                background: "rgba(0,0,0,0.25)",
                color: "#e5e7eb",
              }}
            />

            <label
              style={{
                fontSize: 12,
                color: "#9ca3af",
                display: "block",
                marginTop: 10,
                marginBottom: 6,
              }}
            >
              Prompt
            </label>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="What should the agent do?"
              style={{
                width: "100%",
                minHeight: 120,
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.16)",
                background: "rgba(0,0,0,0.25)",
                color: "#e5e7eb",
              }}
            />
            <button
              type="button"
              onClick={() => void createTask()}
              disabled={busy || !token.trim() || !prompt.trim()}
              style={{
                marginTop: 10,
                padding: "10px 14px",
                borderRadius: 8,
                border: "1px solid rgba(34,211,238,0.4)",
                background: "rgba(34,211,238,0.15)",
                color: "#e5e7eb",
                cursor: "pointer",
              }}
            >
              Create Task
            </button>
          </div>

          <div
            style={{
              padding: 14,
              borderRadius: 12,
              background: "rgba(15, 23, 42, 0.7)",
              border: "1px solid rgba(255,255,255,0.12)",
            }}
          >
            <h2 style={{ marginTop: 0, marginBottom: 10, fontSize: 14, color: "#9ca3af" }}>
              Task Control
            </h2>
            <label style={{ fontSize: 12, color: "#9ca3af", display: "block", marginBottom: 6 }}>
              Task
            </label>
            <select
              value={selectedTaskId}
              onChange={(event) => setSelectedTaskId(event.target.value)}
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.16)",
                background: "rgba(0,0,0,0.25)",
                color: "#e5e7eb",
              }}
            >
              <option value="">Select task</option>
              {tasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {(task.title || "Untitled").slice(0, 40)} [{task.status || "unknown"}]
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={() => void loadTaskEvents()}
              disabled={busy || !token.trim() || !selectedTaskId}
              style={{
                marginTop: 10,
                padding: "10px 14px",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.22)",
                background: "rgba(255,255,255,0.08)",
                color: "#e5e7eb",
                cursor: "pointer",
              }}
            >
              Load Events
            </button>

            <label
              style={{
                fontSize: 12,
                color: "#9ca3af",
                display: "block",
                marginTop: 10,
                marginBottom: 6,
              }}
            >
              Follow-up Message
            </label>
            <textarea
              value={followupMessage}
              onChange={(event) => setFollowupMessage(event.target.value)}
              placeholder="Send message to selected task"
              style={{
                width: "100%",
                minHeight: 90,
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.16)",
                background: "rgba(0,0,0,0.25)",
                color: "#e5e7eb",
              }}
            />
            <button
              type="button"
              onClick={() => void sendTaskMessage()}
              disabled={busy || !token.trim() || !selectedTaskId || !followupMessage.trim()}
              style={{
                marginTop: 10,
                padding: "10px 14px",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.22)",
                background: "rgba(255,255,255,0.08)",
                color: "#e5e7eb",
                cursor: "pointer",
              }}
            >
              Send Message
            </button>
          </div>
        </div>

        <div
          style={{
            marginTop: 14,
            padding: 14,
            borderRadius: 12,
            background: "rgba(15, 23, 42, 0.7)",
            border: "1px solid rgba(255,255,255,0.12)",
          }}
        >
          <h2 style={{ marginTop: 0, marginBottom: 10, fontSize: 14, color: "#9ca3af" }}>
            Tasks ({tasks.length})
          </h2>
          <div style={{ maxHeight: 260, overflow: "auto", fontSize: 13 }}>
            {tasks.length === 0 ? (
              <div style={{ color: "#9ca3af" }}>No tasks yet.</div>
            ) : (
              tasks.map((task) => (
                <div
                  key={task.id}
                  style={{
                    borderTop: "1px solid rgba(255,255,255,0.12)",
                    padding: "8px 0",
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                  }}
                >
                  <div>
                    <div style={{ color: "#e5e7eb" }}>{task.title || "Untitled"}</div>
                    <div style={{ color: "#9ca3af", fontSize: 12 }}>
                      {task.id} · {task.status || "unknown"}
                    </div>
                  </div>
                  <div style={{ color: "#9ca3af", fontSize: 12 }}>{formatDate(task.createdAt)}</div>
                </div>
              ))
            )}
          </div>
        </div>

        <div
          style={{
            marginTop: 14,
            padding: 14,
            borderRadius: 12,
            background: "rgba(15, 23, 42, 0.7)",
            border: "1px solid rgba(255,255,255,0.12)",
          }}
        >
          <h2 style={{ marginTop: 0, marginBottom: 10, fontSize: 14, color: "#9ca3af" }}>
            Task Events ({taskEvents.length})
          </h2>
          <pre
            style={{
              margin: 0,
              maxHeight: 320,
              overflow: "auto",
              padding: 10,
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(0,0,0,0.25)",
              color: "#e5e7eb",
              fontSize: 12,
              lineHeight: 1.45,
            }}
          >
            {JSON.stringify(taskEvents, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
}
