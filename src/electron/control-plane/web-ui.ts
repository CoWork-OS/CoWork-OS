export function getControlPlaneWebUIHtml(): string {
  // Single-file HTML UI to manage a headless CoWork OS instance over the Control Plane.
  // This intentionally avoids a separate build step so it works in VPS/docker deployments.
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CoWork OS Control Plane</title>
    <style>
      :root {
        --bg: #0b0f14;
        --panel: #101826;
        --panel2: #0f1623;
        --text: #e6edf3;
        --muted: #9fb1c1;
        --border: rgba(255, 255, 255, 0.10);
        --accent: #4fd1c5;
        --danger: #ff6b6b;
        --warn: #f6c177;
        --ok: #63e6be;
        --mono: "SF Mono", "Fira Code", "Consolas", monospace;
        --sans: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Segoe UI", system-ui, sans-serif;
      }
      html, body { height: 100%; }
      body {
        margin: 0;
        font-family: var(--sans);
        background: radial-gradient(1200px 600px at 15% 10%, rgba(79, 209, 197, 0.13), transparent 55%),
                    radial-gradient(900px 500px at 85% 5%, rgba(246, 193, 119, 0.10), transparent 55%),
                    var(--bg);
        color: var(--text);
      }
      a { color: var(--accent); }
      .wrap { max-width: 1100px; margin: 0 auto; padding: 24px; }
      header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
      h1 { margin: 0; font-size: 20px; letter-spacing: 0.2px; }
      .sub { color: var(--muted); font-size: 13px; }
      .grid { display: grid; grid-template-columns: 1fr; gap: 14px; margin-top: 14px; }
      @media (min-width: 980px) { .grid { grid-template-columns: 1.1fr 0.9fr; } }
      .card {
        background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02));
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 14px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.35);
      }
      .card h2 { margin: 0 0 10px; font-size: 14px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; }
      .row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
      .row > * { flex: 0 0 auto; }
      .grow { flex: 1 1 auto; min-width: 240px; }
      label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
      input, textarea, select {
        width: 100%;
        background: rgba(0,0,0,0.25);
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 10px 10px;
        outline: none;
      }
      textarea { min-height: 84px; resize: vertical; font-family: var(--sans); }
      code, pre { font-family: var(--mono); }
      .btn {
        border: 1px solid var(--border);
        background: rgba(255,255,255,0.06);
        color: var(--text);
        border-radius: 10px;
        padding: 9px 12px;
        cursor: pointer;
      }
      .btn:hover { border-color: rgba(255,255,255,0.18); background: rgba(255,255,255,0.09); }
      .btn.primary { border-color: rgba(79, 209, 197, 0.35); background: rgba(79, 209, 197, 0.14); }
      .btn.danger { border-color: rgba(255, 107, 107, 0.35); background: rgba(255, 107, 107, 0.12); }
      .pill {
        display: inline-flex; align-items: center; gap: 8px;
        padding: 6px 10px; border-radius: 999px;
        border: 1px solid var(--border);
        background: rgba(0,0,0,0.25);
        font-size: 12px; color: var(--muted);
      }
      .dot { width: 8px; height: 8px; border-radius: 999px; background: var(--warn); }
      .dot.ok { background: var(--ok); }
      .dot.bad { background: var(--danger); }
      .table { width: 100%; border-collapse: collapse; }
      .table th, .table td { border-top: 1px solid var(--border); padding: 10px 8px; font-size: 13px; vertical-align: top; }
      .table th { color: var(--muted); font-weight: 600; text-align: left; }
      .mono { font-family: var(--mono); font-size: 12px; color: rgba(230, 237, 243, 0.92); }
      .muted { color: var(--muted); }
      .split { display: grid; grid-template-columns: 1fr; gap: 12px; }
      @media (min-width: 740px) { .split { grid-template-columns: 1fr 1fr; } }
      .log {
        background: rgba(0,0,0,0.30);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 10px;
        max-height: 340px;
        overflow: auto;
      }
      .logline { white-space: pre-wrap; font-family: var(--mono); font-size: 12px; line-height: 1.45; }
      .small { font-size: 12px; }
      .hint { font-size: 12px; color: var(--muted); margin-top: 8px; }
      .nowrap { white-space: nowrap; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <header>
        <div>
          <h1>CoWork OS Control Plane</h1>
          <div class="sub">Headless dashboard (LLM setup, workspaces, tasks, approvals). Use over SSH tunnel or Tailscale.</div>
        </div>
        <div class="pill" id="connPill"><span class="dot" id="connDot"></span><span id="connText">Disconnected</span></div>
      </header>

      <div class="grid">
        <div class="card">
          <h2>Connection</h2>
          <div class="split">
            <div>
              <label>Web UI URL</label>
              <input id="uiUrl" class="mono" readonly />
            </div>
            <div>
              <label>WebSocket URL</label>
              <input id="wsUrl" class="mono" readonly />
            </div>
          </div>

          <div class="split" style="margin-top: 10px;">
            <div>
              <label>Token</label>
              <input id="token" type="password" placeholder="Paste Control Plane token" autocomplete="off" />
            </div>
            <div>
              <label>Device Name</label>
              <input id="deviceName" placeholder="cowork-web" value="cowork-web" />
            </div>
          </div>

          <div class="row" style="margin-top: 10px;">
            <button class="btn primary" id="btnConnect">Connect</button>
            <button class="btn" id="btnDisconnect" disabled>Disconnect</button>
            <button class="btn" id="btnRefresh" disabled>Refresh</button>
            <span class="muted small" id="clientInfo"></span>
          </div>

          <div class="hint">
            Security: keep the Control Plane bound to loopback on the server and access it via SSH tunnel/Tailscale.
          </div>
        </div>

        <div class="card">
          <h2>Approvals</h2>
          <div class="row" style="margin-bottom: 10px;">
            <button class="btn" id="btnRefreshApprovals" disabled>Refresh</button>
            <span class="muted small" id="approvalCount"></span>
          </div>
          <div id="approvals"></div>
          <div class="hint">Approvals are log-only until you approve/deny. They auto-timeout after ~5 minutes.</div>
        </div>

        <div class="card" style="grid-column: 1 / -1;">
          <h2>Status</h2>
          <div class="row" style="margin-bottom: 10px;">
            <button class="btn" id="btnRefreshStatus" disabled>Refresh</button>
            <span class="muted small" id="statusSummary"></span>
          </div>
          <div class="log" id="statusBox"></div>
          <div class="hint">Sanitized runtime/config health (no secrets). Useful for headless/Linux deployments.</div>
        </div>

        <div class="card" style="grid-column: 1 / -1;">
          <h2>LLM Setup</h2>
          <div class="split">
            <div>
              <label>Provider</label>
              <select id="llmProvider"></select>
              <div class="muted small" id="llmProviderStatus" style="margin-top:6px;"></div>
            </div>
            <div>
              <label>API Key / Token</label>
              <input id="llmApiKey" type="password" placeholder="Optional for provider switch-only" autocomplete="off" />
            </div>
          </div>
          <div class="split" style="margin-top: 10px;">
            <div>
              <label>Model (optional)</label>
              <input id="llmModel" placeholder="e.g. gpt-4o-mini, sonnet-4-5, gemini-2.0-flash" />
            </div>
            <div>
              <label>Provider Settings JSON (optional)</label>
              <textarea id="llmSettingsJson" class="mono" placeholder='{"baseUrl":"http://127.0.0.1:11434"}'></textarea>
            </div>
          </div>
          <div class="row" style="margin-top: 10px;">
            <button class="btn primary" id="btnSaveLlm" disabled>Save LLM Settings</button>
            <span class="muted small" id="llmSaveResult"></span>
          </div>
          <div class="hint">
            Stored encrypted on server. JSON examples: Ollama <code>{"baseUrl":"http://127.0.0.1:11434"}</code>,
            Azure <code>{"endpoint":"https://...","deployment":"..."}</code>,
            Bedrock <code>{"region":"us-east-1","profile":"default"}</code>.
          </div>
        </div>

        <div class="card" style="grid-column: 1 / -1;">
          <h2>Channels</h2>
          <div class="row" style="margin-bottom: 10px;">
            <button class="btn" id="btnRefreshChannels" disabled>Refresh</button>
            <span class="muted small" id="channelCount"></span>
          </div>
          <div class="split">
            <div>
              <div id="channelTable"></div>
            </div>
            <div>
              <label>Create Channel</label>
              <div class="small muted">Secrets are stored on the server. This UI only shows masked values.</div>
              <div style="margin-top: 8px;">
                <label>Type</label>
                <input id="chCreateType" placeholder="telegram" />
              </div>
              <div style="margin-top: 8px;">
                <label>Name</label>
                <input id="chCreateName" placeholder="telegram" />
              </div>
              <div style="margin-top: 8px;">
                <label>Config (JSON)</label>
                <textarea id="chCreateConfig" class="mono" placeholder='{"botToken":"..."}'></textarea>
              </div>
              <div style="margin-top: 8px;">
                <label>Security Config (JSON, optional)</label>
                <textarea id="chCreateSecurity" class="mono" placeholder='{"mode":"pairing"}'></textarea>
              </div>
              <div class="row" style="margin-top: 10px;">
                <input type="checkbox" id="chCreateEnable" />
                <span class="muted small">Enable immediately</span>
              </div>
              <div class="row" style="margin-top: 10px;">
                <button class="btn primary" id="btnCreateChannel" disabled>Create</button>
                <span class="muted small" id="chCreateResult"></span>
              </div>

              <div style="margin-top: 14px;">
                <label>Update Channel</label>
                <div class="small muted">Re-submit full JSON (masked secrets will not round-trip).</div>
                <div style="margin-top: 8px;">
                  <label>Channel ID</label>
                  <input id="chUpdateId" class="mono" placeholder="..." />
                </div>
                <div style="margin-top: 8px;">
                  <label>Config (JSON)</label>
                  <textarea id="chUpdateConfig" class="mono" placeholder='{"botToken":"..."}'></textarea>
                </div>
                <div style="margin-top: 8px;">
                  <label>Security Config (JSON)</label>
                  <textarea id="chUpdateSecurity" class="mono" placeholder='{"mode":"pairing"}'></textarea>
                </div>
                <div class="row" style="margin-top: 10px;">
                  <button class="btn" id="btnUpdateChannel" disabled>Update</button>
                  <span class="muted small" id="chUpdateResult"></span>
                </div>
              </div>
            </div>
          </div>
          <div class="hint">VPS tip: prefer Telegram/Discord/Slack/etc. iMessage/BlueBubbles require a macOS relay.</div>
        </div>

        <div class="card">
          <h2>Workspaces</h2>
          <div class="row" style="margin-bottom: 10px;">
            <button class="btn" id="btnRefreshWorkspaces" disabled>Refresh</button>
            <span class="muted small" id="workspaceCount"></span>
          </div>
          <div class="split">
            <div>
              <div class="log" id="workspaceList"></div>
            </div>
            <div>
              <label>Create Workspace</label>
              <div class="small muted">Create the directory if missing.</div>
              <div style="margin-top: 8px;">
                <label>Name</label>
                <input id="wsCreateName" placeholder="main" />
              </div>
              <div style="margin-top: 8px;">
                <label>Path (absolute on server)</label>
                <input id="wsCreatePath" class="mono" placeholder="/workspace" />
              </div>
              <div class="row" style="margin-top: 10px;">
                <button class="btn primary" id="btnCreateWorkspace" disabled>Create</button>
                <span class="muted small" id="wsCreateResult"></span>
              </div>
            </div>
          </div>
        </div>

        <div class="card">
          <h2>Tasks</h2>
          <div class="row" style="margin-bottom: 10px;">
            <button class="btn" id="btnRefreshTasks" disabled>Refresh</button>
            <span class="muted small" id="taskCount"></span>
          </div>
          <div class="split">
            <div>
              <div class="log" id="taskList"></div>
            </div>
            <div>
              <label>Create Task</label>
              <div style="margin-top: 8px;">
                <label>Workspace</label>
                <select id="taskWorkspace"></select>
              </div>
              <div style="margin-top: 8px;">
                <label>Title</label>
                <input id="taskTitle" placeholder="Example task" />
              </div>
              <div style="margin-top: 8px;">
                <label>Prompt</label>
                <textarea id="taskPrompt" placeholder="What should the agent do?"></textarea>
              </div>
              <div class="row" style="margin-top: 10px;">
                <button class="btn primary" id="btnCreateTask" disabled>Create</button>
                <span class="muted small" id="taskCreateResult"></span>
              </div>
            </div>
          </div>
        </div>

        <div class="card" style="grid-column: 1 / -1;">
          <h2>Task Events</h2>
          <div class="row" style="margin-bottom: 10px;">
            <span class="muted small">Select a task to load history and stream live events.</span>
          </div>
          <div class="split">
            <div>
              <label>Selected Task ID</label>
              <input id="selectedTaskId" class="mono" readonly />
              <div class="row" style="margin-top: 10px;">
                <button class="btn" id="btnLoadEvents" disabled>Load Recent Events</button>
                <button class="btn danger" id="btnCancelTask" disabled>Cancel Task</button>
                <button class="btn" id="btnClearLog">Clear</button>
              </div>
              <div class="hint">Tip: long outputs are truncated in live broadcasts. Use event history for more detail.</div>
            </div>
            <div>
              <label>Send Message To Task</label>
              <textarea id="taskMessage" placeholder="Follow-up instruction"></textarea>
              <div class="row" style="margin-top: 10px;">
                <button class="btn" id="btnSendMessage" disabled>Send</button>
                <span class="muted small" id="taskMessageResult"></span>
              </div>
            </div>
          </div>
          <div class="log" id="eventLog" style="margin-top: 12px;"></div>
        </div>
      </div>
    </div>

    <script>
      const el = (id) => document.getElementById(id);
      const uiUrlEl = el('uiUrl');
      const wsUrlEl = el('wsUrl');
      const tokenEl = el('token');
      const deviceNameEl = el('deviceName');
      const btnConnect = el('btnConnect');
      const btnDisconnect = el('btnDisconnect');
      const btnRefresh = el('btnRefresh');
      const connDot = el('connDot');
      const connText = el('connText');
      const clientInfo = el('clientInfo');

      const approvalsEl = el('approvals');
      const approvalCountEl = el('approvalCount');
      const btnRefreshApprovals = el('btnRefreshApprovals');

      const btnRefreshStatus = el('btnRefreshStatus');
      const statusSummaryEl = el('statusSummary');
      const statusBox = el('statusBox');
      const llmProvider = el('llmProvider');
      const llmApiKey = el('llmApiKey');
      const llmModel = el('llmModel');
      const llmSettingsJson = el('llmSettingsJson');
      const llmProviderStatus = el('llmProviderStatus');
      const btnSaveLlm = el('btnSaveLlm');
      const llmSaveResult = el('llmSaveResult');

      const btnRefreshChannels = el('btnRefreshChannels');
      const channelCountEl = el('channelCount');
      const channelTableEl = el('channelTable');
      const chCreateType = el('chCreateType');
      const chCreateName = el('chCreateName');
      const chCreateConfig = el('chCreateConfig');
      const chCreateSecurity = el('chCreateSecurity');
      const chCreateEnable = el('chCreateEnable');
      const btnCreateChannel = el('btnCreateChannel');
      const chCreateResult = el('chCreateResult');
      const chUpdateId = el('chUpdateId');
      const chUpdateConfig = el('chUpdateConfig');
      const chUpdateSecurity = el('chUpdateSecurity');
      const btnUpdateChannel = el('btnUpdateChannel');
      const chUpdateResult = el('chUpdateResult');

      const btnRefreshWorkspaces = el('btnRefreshWorkspaces');
      const workspaceList = el('workspaceList');
      const workspaceCountEl = el('workspaceCount');
      const wsCreateName = el('wsCreateName');
      const wsCreatePath = el('wsCreatePath');
      const btnCreateWorkspace = el('btnCreateWorkspace');
      const wsCreateResult = el('wsCreateResult');

      const btnRefreshTasks = el('btnRefreshTasks');
      const taskList = el('taskList');
      const taskCountEl = el('taskCount');
      const taskWorkspace = el('taskWorkspace');
      const taskTitle = el('taskTitle');
      const taskPrompt = el('taskPrompt');
      const btnCreateTask = el('btnCreateTask');
      const taskCreateResult = el('taskCreateResult');

      const selectedTaskId = el('selectedTaskId');
      const btnLoadEvents = el('btnLoadEvents');
      const eventLog = el('eventLog');
      const btnClearLog = el('btnClearLog');
      const btnCancelTask = el('btnCancelTask');
      const taskMessage = el('taskMessage');
      const btnSendMessage = el('btnSendMessage');
      const taskMessageResult = el('taskMessageResult');

      const origin = window.location.origin;
      const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = wsProto + '//' + window.location.host;
      uiUrlEl.value = origin + '/';
      wsUrlEl.value = wsUrl;

      let ws = null;
      let connected = false;
      let rpcId = 1;
      const pending = new Map();
      let workspaces = [];
      let tasks = [];
      let pendingApprovals = [];
      let status = null;
      let channels = [];

      function setConn(state, detail) {
        const text = state + (detail ? ' • ' + detail : '');
        connText.textContent = text;
        if (state === 'Connected') {
          connDot.className = 'dot ok';
        } else if (state === 'Error') {
          connDot.className = 'dot bad';
        } else {
          connDot.className = 'dot';
        }
      }

      function safeJson(obj) {
        try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
      }

      function log(line) {
        const div = document.createElement('div');
        div.className = 'logline';
        div.textContent = line;
        eventLog.appendChild(div);
        eventLog.scrollTop = eventLog.scrollHeight;
      }

      function formatTs(ms) {
        try { return new Date(ms).toISOString(); } catch { return String(ms); }
      }

      function request(method, params) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('WebSocket not open'));
        const id = String(++rpcId);
        ws.send(JSON.stringify({ type: 'req', id, method, ...(params !== undefined ? { params } : {}) }));
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject, method, at: Date.now() });
          setTimeout(() => {
            if (!pending.has(id)) return;
            pending.delete(id);
            reject(new Error('Request timeout: ' + method));
          }, 30000);
        });
      }

      function updateButtons() {
        btnDisconnect.disabled = !connected;
        btnRefresh.disabled = !connected;
        btnRefreshApprovals.disabled = !connected;
        btnRefreshStatus.disabled = !connected;
        btnSaveLlm.disabled = !connected;
        btnRefreshChannels.disabled = !connected;
        btnRefreshWorkspaces.disabled = !connected;
        btnRefreshTasks.disabled = !connected;
        btnCreateWorkspace.disabled = !connected;
        btnCreateTask.disabled = !connected;
        btnCreateChannel.disabled = !connected;
        btnUpdateChannel.disabled = !connected;
        btnLoadEvents.disabled = !connected || !selectedTaskId.value;
        btnCancelTask.disabled = !connected || !selectedTaskId.value;
        btnSendMessage.disabled = !connected || !selectedTaskId.value;
      }

      function renderChannels() {
        channelTableEl.innerHTML = '';
        channelCountEl.textContent = channels.length ? (channels.length + ' channel(s)') : 'No channels configured';
        if (!channels.length) return;

        const table = document.createElement('table');
        table.className = 'table';
        table.innerHTML = '<thead><tr><th>Type</th><th>Name</th><th>Status</th><th>ID</th><th>Actions</th></tr></thead>';
        const tbody = document.createElement('tbody');

        for (const c of channels) {
          const tr = document.createElement('tr');

          const typeTd = document.createElement('td');
          typeTd.className = 'mono';
          typeTd.textContent = String(c.type || '');

          const nameTd = document.createElement('td');
          nameTd.textContent = String(c.name || '');

          const statusTd = document.createElement('td');
          statusTd.textContent = (c.enabled ? '[enabled] ' : '[disabled] ') + String(c.status || '');

          const idTd = document.createElement('td');
          idTd.className = 'mono';
          idTd.textContent = String(c.id || '').slice(0, 12);
          idTd.title = String(c.id || '');
          idTd.style.cursor = 'pointer';
          idTd.onclick = () => {
            chUpdateId.value = String(c.id || '');
          };

          const actionsTd = document.createElement('td');

          const btnDetails = document.createElement('button');
          btnDetails.className = 'btn';
          btnDetails.textContent = 'Details';
          btnDetails.onclick = async () => {
            try {
              const res = await request('channel.get', { channelId: c.id });
              alert(safeJson(res));
            } catch (e) {
              alert('Details failed: ' + (e?.message || e));
            }
          };

          const btnTest = document.createElement('button');
          btnTest.className = 'btn';
          btnTest.style.marginLeft = '8px';
          btnTest.textContent = 'Test';
          btnTest.onclick = async () => {
            btnTest.disabled = true;
            try {
              const res = await request('channel.test', { channelId: c.id });
              alert(safeJson(res));
            } catch (e) {
              alert('Test failed: ' + (e?.message || e));
            } finally {
              btnTest.disabled = false;
            }
          };

          const btnToggle = document.createElement('button');
          btnToggle.className = 'btn';
          btnToggle.style.marginLeft = '8px';
          btnToggle.textContent = c.enabled ? 'Disable' : 'Enable';
          btnToggle.onclick = async () => {
            btnToggle.disabled = true;
            try {
              if (c.enabled) await request('channel.disable', { channelId: c.id });
              else await request('channel.enable', { channelId: c.id });
              await refreshChannels();
              await refreshStatus();
            } catch (e) {
              alert('Update failed: ' + (e?.message || e));
            } finally {
              btnToggle.disabled = false;
            }
          };

          const btnRemove = document.createElement('button');
          btnRemove.className = 'btn danger';
          btnRemove.style.marginLeft = '8px';
          btnRemove.textContent = 'Remove';
          btnRemove.onclick = async () => {
            if (!confirm('Remove channel? This deletes the channel config and related history.')) return;
            btnRemove.disabled = true;
            try {
              await request('channel.remove', { channelId: c.id });
              await refreshChannels();
              await refreshStatus();
            } catch (e) {
              alert('Remove failed: ' + (e?.message || e));
            } finally {
              btnRemove.disabled = false;
            }
          };

          actionsTd.appendChild(btnDetails);
          actionsTd.appendChild(btnTest);
          actionsTd.appendChild(btnToggle);
          actionsTd.appendChild(btnRemove);

          tr.appendChild(typeTd);
          tr.appendChild(nameTd);
          tr.appendChild(statusTd);
          tr.appendChild(idTd);
          tr.appendChild(actionsTd);
          tbody.appendChild(tr);
        }

        table.appendChild(tbody);
        channelTableEl.appendChild(table);
      }

      function renderWorkspaces() {
        workspaceCountEl.textContent = workspaces.length ? workspaces.length + ' workspace(s)' : '';
        const lines = workspaces.map((w) => {
          const path = w.path ? ' • ' + w.path : '';
          return w.id + ' • ' + w.name + path;
        });
        workspaceList.textContent = lines.join('\\n');

        // Update workspace dropdown
        taskWorkspace.innerHTML = '';
        for (const w of workspaces) {
          const opt = document.createElement('option');
          opt.value = w.id;
          opt.textContent = w.name + ' (' + w.id.slice(0, 8) + ')';
          taskWorkspace.appendChild(opt);
        }
      }

      function setSelectedTask(id) {
        selectedTaskId.value = id || '';
        updateButtons();
      }

      function renderTasks() {
        taskCountEl.textContent = tasks.length ? tasks.length + ' task(s)' : '';
        const lines = tasks.map((t) => {
          const status = t.status || 'unknown';
          return t.id + ' • [' + status + '] ' + (t.title || '');
        });
        taskList.textContent = lines.join('\\n');
        // Click-to-select (simple: first match by prefix)
        taskList.onclick = (ev) => {
          const sel = window.getSelection ? window.getSelection().toString().trim() : '';
          const text = sel || '';
          if (!text) return;
          const id = tasks.find((t) => t.id.startsWith(text))?.id || tasks.find((t) => t.id === text)?.id;
          if (id) setSelectedTask(id);
        };
      }

      function renderApprovals() {
        approvalCountEl.textContent = pendingApprovals.length ? pendingApprovals.length + ' pending' : 'No pending approvals';
        approvalsEl.innerHTML = '';
        if (pendingApprovals.length === 0) return;

        const table = document.createElement('table');
        table.className = 'table';
        table.innerHTML = '<thead><tr><th>When</th><th>Task</th><th>Description</th><th>Actions</th></tr></thead>';
        const tbody = document.createElement('tbody');

        for (const a of pendingApprovals) {
          const tr = document.createElement('tr');
          const when = document.createElement('td');
          when.className = 'nowrap mono';
          when.textContent = formatTs(a.requestedAt || Date.now());

          const taskTd = document.createElement('td');
          taskTd.className = 'mono';
          taskTd.textContent = (a.taskTitle ? a.taskTitle + ' • ' : '') + (a.taskId || '').slice(0, 12);

          const desc = document.createElement('td');
          const pre = document.createElement('pre');
          pre.className = 'mono';
          pre.style.margin = '0';
          pre.style.whiteSpace = 'pre-wrap';
          pre.textContent = a.description || '';
          desc.appendChild(pre);
          if (a.details) {
            const details = document.createElement('details');
            const sum = document.createElement('summary');
            sum.textContent = 'details';
            sum.className = 'muted small';
            const pre2 = document.createElement('pre');
            pre2.className = 'mono';
            pre2.style.whiteSpace = 'pre-wrap';
            pre2.textContent = safeJson(a.details);
            details.appendChild(sum);
            details.appendChild(pre2);
            desc.appendChild(details);
          }

          const actions = document.createElement('td');
          const btnA = document.createElement('button');
          btnA.className = 'btn primary';
          btnA.textContent = 'Approve';
          btnA.onclick = async () => {
            btnA.disabled = true;
            btnD.disabled = true;
            try {
              await request('approval.respond', { approvalId: a.id, approved: true });
              await refreshApprovals();
            } catch (e) {
              alert('Approval failed: ' + (e?.message || e));
            } finally {
              btnA.disabled = false;
              btnD.disabled = false;
            }
          };
          const btnD = document.createElement('button');
          btnD.className = 'btn danger';
          btnD.style.marginLeft = '8px';
          btnD.textContent = 'Deny';
          btnD.onclick = async () => {
            btnA.disabled = true;
            btnD.disabled = true;
            try {
              await request('approval.respond', { approvalId: a.id, approved: false });
              await refreshApprovals();
            } catch (e) {
              alert('Denial failed: ' + (e?.message || e));
            } finally {
              btnA.disabled = false;
              btnD.disabled = false;
            }
          };
          actions.appendChild(btnA);
          actions.appendChild(btnD);

          tr.appendChild(when);
          tr.appendChild(taskTd);
          tr.appendChild(desc);
          tr.appendChild(actions);
          tbody.appendChild(tr);
        }

        table.appendChild(tbody);
        approvalsEl.appendChild(table);
      }

      function renderStatus() {
        if (!status) {
          statusSummaryEl.textContent = '';
          statusBox.textContent = '';
          renderLlmSetup();
          return;
        }
        const warnings = Array.isArray(status.warnings) ? status.warnings : [];
        statusSummaryEl.textContent = warnings.length ? (warnings.length + ' warning(s)') : 'OK';

        let out = '';
        if (warnings.length) {
          out += 'Warnings:\\n' + warnings.map((w) => '- ' + String(w)).join('\\n') + '\\n\\n';
        }
        out += safeJson(status);
        statusBox.textContent = out;
        renderLlmSetup();
      }

      function renderLlmSetup() {
        const llm = status && status.llm ? status.llm : null;
        const providers = llm && Array.isArray(llm.providers) ? llm.providers : [];

        llmProvider.innerHTML = '';
        if (!providers.length) {
          const opt = document.createElement('option');
          opt.value = '';
          opt.textContent = 'No providers';
          llmProvider.appendChild(opt);
          llmProviderStatus.textContent = 'No provider metadata available';
          return;
        }

        for (const p of providers) {
          const opt = document.createElement('option');
          opt.value = String(p.type || '');
          opt.textContent = String(p.name || p.type || '') + (p.configured ? ' [configured]' : '');
          llmProvider.appendChild(opt);
        }

        const targetProvider = llm && llm.currentProvider ? String(llm.currentProvider) : String(providers[0].type || '');
        if (targetProvider) {
          llmProvider.value = targetProvider;
        }

        if (!llmModel.value && llm && llm.currentModel) {
          llmModel.placeholder = 'Current: ' + String(llm.currentModel);
        }
        updateLlmSettingsPlaceholder();
        updateSelectedLlmProviderStatus();
      }

      function updateLlmSettingsPlaceholder() {
        const provider = (llmProvider.value || '').trim();
        if (provider === 'ollama') {
          llmSettingsJson.placeholder = '{"baseUrl":"http://127.0.0.1:11434"}';
          return;
        }
        if (provider === 'azure') {
          llmSettingsJson.placeholder = '{"endpoint":"https://...","deployment":"...","apiVersion":"2024-10-21"}';
          return;
        }
        if (provider === 'bedrock') {
          llmSettingsJson.placeholder = '{"region":"us-east-1","profile":"default"}';
          return;
        }
        if (provider === 'pi') {
          llmSettingsJson.placeholder = '{"provider":"anthropic"}';
          return;
        }
        llmSettingsJson.placeholder = '{"baseUrl":"https://..."}';
      }

      function updateSelectedLlmProviderStatus() {
        const llm = status && status.llm ? status.llm : null;
        const providers = llm && Array.isArray(llm.providers) ? llm.providers : [];
        const provider = (llmProvider.value || '').trim();
        if (!provider || providers.length === 0) {
          llmProviderStatus.textContent = '';
          return;
        }

        const matched = providers.find((p) => String(p.type || '') === provider);
        if (!matched) {
          llmProviderStatus.textContent = '';
          return;
        }

        const state = matched.configured ? 'configured' : 'not configured';
        llmProviderStatus.textContent = 'Selected provider status: ' + state;
      }

      async function refreshStatus() {
        const res = await request('config.get');
        status = res || null;
        renderStatus();
      }

      async function refreshChannels() {
        const res = await request('channel.list');
        channels = (res && res.channels) ? res.channels : [];
        renderChannels();
      }

      async function refreshWorkspaces() {
        const res = await request('workspace.list');
        workspaces = (res && res.workspaces) ? res.workspaces : [];
        renderWorkspaces();
      }

      async function refreshTasks() {
        const res = await request('task.list', { limit: 200, offset: 0 });
        tasks = (res && res.tasks) ? res.tasks : [];
        renderTasks();
      }

      async function refreshApprovals() {
        const res = await request('approval.list', { limit: 100, offset: 0 });
        pendingApprovals = (res && res.approvals) ? res.approvals : [];
        renderApprovals();
      }

      async function refreshAll() {
        await Promise.allSettled([refreshStatus(), refreshChannels(), refreshWorkspaces(), refreshTasks(), refreshApprovals()]);
      }

      function onFrame(frame) {
        if (!frame || typeof frame !== 'object') return;
        if (frame.type === 'res') {
          const p = pending.get(frame.id);
          if (!p) return;
          pending.delete(frame.id);
          if (frame.ok) p.resolve(frame.payload);
          else p.reject(new Error(frame?.error?.message || 'Request failed'));
          return;
        }

        if (frame.type === 'event') {
          // task.event is the main broadcast for operator clients.
          if (frame.event === 'task.event') {
            const evt = frame.payload || {};
            const tid = evt.taskId || '';
            const type = evt.type || 'event';
            const ts = evt.timestamp || Date.now();
            if (!selectedTaskId.value || selectedTaskId.value === tid) {
              log('[' + formatTs(ts) + '] ' + type + (tid ? ' (' + tid.slice(0, 8) + ')' : '') + '\\n' + safeJson(evt.payload || {}));
            }
            if (type === 'approval_requested') {
              // Opportunistically refresh approval list for user-actionable approvals.
              if (!evt?.payload?.autoApproved) {
                refreshApprovals().catch(() => {});
              }
            }
          }
        }
      }

      async function connect() {
        const token = tokenEl.value.trim();
        if (!token) { alert('Token is required'); return; }

        setConn('Connecting');
        ws = new WebSocket(wsUrl);

        ws.onopen = async () => {
          try {
            const payload = await new Promise((resolve, reject) => {
              const id = '1';
              pending.set(id, { resolve, reject, method: 'connect', at: Date.now() });
              ws.send(JSON.stringify({ type: 'req', id, method: 'connect', params: { token, deviceName: deviceNameEl.value || 'cowork-web' } }));
              setTimeout(() => {
                if (!pending.has(id)) return;
                pending.delete(id);
                reject(new Error('Auth timeout'));
              }, 15000);
            });

            connected = true;
            setConn('Connected');
            clientInfo.textContent = payload?.role ? (payload.role + ' • ' + (payload.scopes || []).join(',')) : '';
            btnConnect.disabled = true;
            updateButtons();
            await refreshAll();
          } catch (e) {
            setConn('Error', e?.message || String(e));
            try { ws.close(); } catch {}
          }
        };

        ws.onmessage = (ev) => {
          try {
            const frame = JSON.parse(String(ev.data));
            onFrame(frame);
          } catch {}
        };
        ws.onerror = () => {
          setConn('Error', 'socket error');
        };
        ws.onclose = () => {
          connected = false;
          btnConnect.disabled = false;
          btnDisconnect.disabled = true;
          setConn('Disconnected');
          updateButtons();
        };
      }

      function disconnect() {
        if (!ws) return;
        try { ws.close(1000, 'disconnect'); } catch {}
        ws = null;
        connected = false;
        setConn('Disconnected');
        updateButtons();
      }

      btnConnect.onclick = () => connect();
      btnDisconnect.onclick = () => disconnect();
      btnRefresh.onclick = () => refreshAll().catch((e) => alert(e?.message || e));
      btnRefreshStatus.onclick = () => refreshStatus().catch((e) => alert(e?.message || e));
      btnRefreshChannels.onclick = () => refreshChannels().catch((e) => alert(e?.message || e));
      btnRefreshWorkspaces.onclick = () => refreshWorkspaces().catch((e) => alert(e?.message || e));
      btnRefreshTasks.onclick = () => refreshTasks().catch((e) => alert(e?.message || e));
      btnRefreshApprovals.onclick = () => refreshApprovals().catch((e) => alert(e?.message || e));

      llmProvider.onchange = () => {
        updateLlmSettingsPlaceholder();
        updateSelectedLlmProviderStatus();
      };
      btnSaveLlm.onclick = async () => {
        llmSaveResult.textContent = '';
        const providerType = (llmProvider.value || '').trim();
        if (!providerType) {
          llmSaveResult.textContent = 'Provider required';
          return;
        }

        const payload: { providerType: string; apiKey?: string; model?: string; settings?: Record<string, unknown> } = {
          providerType,
          apiKey: undefined,
          model: undefined,
          settings: undefined,
        };
        const apiKey = (llmApiKey.value || '').trim();
        const model = (llmModel.value || '').trim();
        if (apiKey) payload.apiKey = apiKey;
        if (model) payload.model = model;

        const rawSettings = (llmSettingsJson.value || '').trim();
        if (rawSettings) {
          try {
            const parsed = JSON.parse(rawSettings);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              llmSaveResult.textContent = 'Provider settings JSON must be an object';
              return;
            }
            payload.settings = parsed;
          } catch {
            llmSaveResult.textContent = 'Provider settings JSON is invalid';
            return;
          }
        }

        btnSaveLlm.disabled = true;
        try {
          await request('llm.configure', payload);
          llmApiKey.value = '';
          llmSaveResult.textContent = 'Saved';
          await refreshStatus();
        } catch (e) {
          llmSaveResult.textContent = 'Error: ' + (e?.message || e);
        } finally {
          updateButtons();
        }
      };

      btnCreateChannel.onclick = async () => {
        chCreateResult.textContent = '';
        const type = (chCreateType.value || '').trim();
        const name = (chCreateName.value || '').trim();
        if (!type || !name) { chCreateResult.textContent = 'Type + name required'; return; }

        let config = {};
        const rawConfig = (chCreateConfig.value || '').trim();
        if (rawConfig) {
          try { config = JSON.parse(rawConfig); } catch { chCreateResult.textContent = 'Config must be valid JSON'; return; }
        }

        let securityConfig = undefined;
        const rawSec = (chCreateSecurity.value || '').trim();
        if (rawSec) {
          try { securityConfig = JSON.parse(rawSec); } catch { chCreateResult.textContent = 'Security config must be valid JSON'; return; }
        }

        btnCreateChannel.disabled = true;
        try {
          const payload = { type, name, enabled: !!chCreateEnable.checked, config, ...(securityConfig ? { securityConfig } : {}) };
          const res = await request('channel.create', payload);
          chCreateResult.textContent = 'Created: ' + (res?.channelId ? String(res.channelId).slice(0, 12) : 'ok');
          await refreshChannels();
          await refreshStatus();
        } catch (e) {
          chCreateResult.textContent = 'Error: ' + (e?.message || e);
        } finally {
          btnCreateChannel.disabled = false;
        }
      };

      btnUpdateChannel.onclick = async () => {
        chUpdateResult.textContent = '';
        const channelId = (chUpdateId.value || '').trim();
        if (!channelId) { chUpdateResult.textContent = 'Channel ID required'; return; }

        const updates = {};
        const rawConfig = (chUpdateConfig.value || '').trim();
        if (rawConfig) {
          try { updates.config = JSON.parse(rawConfig); } catch { chUpdateResult.textContent = 'Config must be valid JSON'; return; }
        }
        const rawSec = (chUpdateSecurity.value || '').trim();
        if (rawSec) {
          try { updates.securityConfig = JSON.parse(rawSec); } catch { chUpdateResult.textContent = 'Security config must be valid JSON'; return; }
        }

        if (!updates.config && !updates.securityConfig) { chUpdateResult.textContent = 'Provide config and/or security config JSON'; return; }

        btnUpdateChannel.disabled = true;
        try {
          await request('channel.update', { channelId, ...updates });
          chUpdateResult.textContent = 'Updated';
          await refreshChannels();
          await refreshStatus();
        } catch (e) {
          chUpdateResult.textContent = 'Error: ' + (e?.message || e);
        } finally {
          btnUpdateChannel.disabled = false;
        }
      };

      btnCreateWorkspace.onclick = async () => {
        wsCreateResult.textContent = '';
        const name = wsCreateName.value.trim();
        const path = wsCreatePath.value.trim();
        if (!name || !path) { wsCreateResult.textContent = 'Name + path required'; return; }
        try {
          const res = await request('workspace.create', { name, path });
          wsCreateResult.textContent = 'Created: ' + (res?.workspace?.id || '');
          await refreshWorkspaces();
        } catch (e) {
          wsCreateResult.textContent = 'Error: ' + (e?.message || e);
        }
      };

      btnCreateTask.onclick = async () => {
        taskCreateResult.textContent = '';
        const workspaceId = taskWorkspace.value;
        const title = taskTitle.value.trim();
        const prompt = taskPrompt.value.trim();
        if (!workspaceId || !title || !prompt) { taskCreateResult.textContent = 'Workspace + title + prompt required'; return; }
        try {
          const res = await request('task.create', { workspaceId, title, prompt });
          const tid = res?.taskId || res?.task?.id;
          taskCreateResult.textContent = tid ? ('Created: ' + tid) : 'Created';
          if (tid) setSelectedTask(tid);
          await refreshTasks();
        } catch (e) {
          taskCreateResult.textContent = 'Error: ' + (e?.message || e);
        }
      };

      btnLoadEvents.onclick = async () => {
        if (!selectedTaskId.value) return;
        try {
          const res = await request('task.events', { taskId: selectedTaskId.value, limit: 200 });
          const events = res?.events || [];
          log('--- loaded ' + events.length + ' event(s) ---');
          for (const e of events) {
            log('[' + formatTs(e.timestamp || Date.now()) + '] ' + (e.type || 'event') + '\\n' + safeJson(e.payload || {}));
          }
        } catch (e) {
          alert('Failed to load events: ' + (e?.message || e));
        }
      };

      btnCancelTask.onclick = async () => {
        if (!selectedTaskId.value) return;
        if (!confirm('Cancel task ' + selectedTaskId.value + '?')) return;
        try {
          await request('task.cancel', { taskId: selectedTaskId.value });
          await refreshTasks();
        } catch (e) {
          alert('Cancel failed: ' + (e?.message || e));
        }
      };

      btnSendMessage.onclick = async () => {
        taskMessageResult.textContent = '';
        const msg = taskMessage.value.trim();
        if (!msg) return;
        try {
          await request('task.sendMessage', { taskId: selectedTaskId.value, message: msg });
          taskMessage.value = '';
          taskMessageResult.textContent = 'Sent';
        } catch (e) {
          taskMessageResult.textContent = 'Error: ' + (e?.message || e);
        }
      };

      btnClearLog.onclick = () => { eventLog.innerHTML = ''; };

      // Initial state
      setConn('Disconnected');
      updateButtons();
      updateLlmSettingsPlaceholder();
    </script>
  </body>
</html>`;
}
