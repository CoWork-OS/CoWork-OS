# Live Canvas

Live Canvas is an agent-driven visual workspace that allows CoWork OS agents to create, display, and interact with dynamic HTML/CSS/JavaScript content in real-time.

## Overview

Live Canvas enables agents to:
- Render interactive visualizations, dashboards, and forms
- Display data analysis results with charts and graphs
- Create prototypes and mockups
- Build interactive tools for user feedback
- Execute JavaScript in the canvas context and retrieve results

Each canvas session opens in a dedicated Electron BrowserWindow and is isolated per task.

## In-App Preview

When an agent pushes content to a canvas, a **live preview** appears directly in the task view:

### Preview Modes

The preview supports two modes, toggled with the **I** key or the pointer button:

#### Interactive Mode (Default)

- **Full browser experience**: Interact with canvas content directly in the preview
- **Click buttons, fill forms, scroll**: All standard browser interactions work
- **No external window needed**: Stay in the main app while using the canvas
- **Snapshot paused**: Auto-refresh is disabled to avoid interrupting your interaction

#### Snapshot Mode

- **Static screenshot**: Shows a captured image of the canvas content
- **Auto-refresh**: Automatically updates every 2 seconds while active
- **Click to expand**: Click the preview image to open the full canvas window
- **Lower resource usage**: Good for monitoring when not actively interacting

### Features

- **Resizable preview**: Drag the bottom edge to make the preview taller or shorter
- **Minimize/Expand**: Toggle button to collapse or expand the preview without closing the session
- **Status indicator**: Shows current session status:
  - 🟢 **Live** - Session is active and auto-refreshing
  - 🟡 **Paused** - Session is paused
  - 🔴 **Closed** - Session has been closed
- **Dimensions display**: Shows the current canvas resolution (e.g., "1800 x 1336")

### Preview Controls

| Button | Action | Keyboard |
|--------|--------|----------|
| 🖱️ Pointer | Toggle interactive/snapshot mode | I |
| 📋 Copy | Copy snapshot to clipboard | C |
| 💾 Save | Save snapshot as PNG file | S |
| 🕐 History | Show/hide snapshot history | H |
| 📺 Console | Show/hide console logs | L |
| 📤 Export | Export options menu | E |
| ⏸️ Pause/▶️ Resume | Toggle auto-refresh on/off | P |
| 🔄 Refresh | Force immediate snapshot update | R |
| 🌐 Browser | Open canvas in system browser | B |
| ↗️ Open in window | Open full interactive canvas window | O |
| ➖ Minimize | Collapse preview to header only | M |
| ✕ Close | Close the canvas session | - |

**Note:** Keyboard shortcuts work when the preview is focused (click on it first).

### Export Options

The export menu (E key or export button) provides three options:

- **Export HTML**: Download the canvas as a standalone HTML file
- **Open in Browser**: Open the canvas in your default system browser
- **Show in Finder**: Open the canvas session folder in Finder

### Additional Features

- **Snapshot history**: Browse through previous snapshots with the history panel
- **Console viewer**: View console logs from the canvas (when available)
- **Copy to clipboard**: Quickly copy the current snapshot for pasting into documents or chat
- **Save as PNG**: Download the snapshot with an auto-generated filename
- **Error details**: When errors occur, see specific details and a "Try Again" button
- **Memory efficient**: Previous images are cleared before loading new ones to reduce memory usage

The in-app preview allows you to interact with canvas content directly without switching windows. Use interactive mode (default) for full browser-like interaction, or switch to snapshot mode when you just want to monitor changes.

## Build Mode

Build Mode is a dedicated "idea → working prototype" workflow layered on top of Live Canvas. It guides the agent through four structured phases, each producing a named checkpoint that you can revert to or diff against.

### Phases

| Phase | What Happens |
|-------|-------------|
| **Concept** | Agent restates the idea, identifies core requirements, and selects a tech stack |
| **Plan** | Breaks down into components, defines file structure, outlines implementation steps |
| **Scaffold** | Generates working code, pushes to canvas, creates a checkpoint |
| **Iterate** | Refines based on feedback — adds features, fixes bugs, polishes UI |

### Using Build Mode

Build Mode is available as a built-in skill (`build-mode`). You can activate it by:

1. Selecting the **Build Mode** skill from the skill picker
2. Providing your idea and optionally a tech stack preference
3. The agent walks through each phase, creating canvas checkpoints at each stage

### Phase Checkpoints

Each phase creates a named checkpoint (e.g., `build:concept`, `build:plan`, `build:scaffold`, `build:iterate`). You can:

- **View timeline**: See all phases with their checkpoint IDs and timestamps
- **Revert to phase**: Roll back to any previous phase's checkpoint
- **Diff between phases**: Compare file-level changes between any two phase checkpoints (added, removed, modified files)

### Implementation Files

- `src/electron/canvas/build-mode-orchestrator.ts` — Phase management, checkpoint mapping, revert/diff logic
- `resources/skills/build-mode.json` — Skill definition with phase prompts and parameters

---

## Named Checkpoints

Canvas sessions support named checkpoints for saving, restoring, and comparing canvas states.

### Checkpoint Tools

| Tool | Description |
|------|-------------|
| `canvas_checkpoint` | Save current state with an optional label |
| `canvas_restore` | Restore a previous checkpoint by ID |
| `canvas_checkpoints` | List all checkpoints for a session |

### Advanced Checkpoint Methods

| Method | Description |
|--------|-------------|
| `findCheckpointByLabel(sessionId, label)` | Look up a checkpoint by its label name |
| `diffCheckpoints(sessionId, fromId, toId)` | Compare two checkpoints and return added, removed, and modified files |

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│              Agent (Task Executor)               │
│  Uses canvas_* tools to create visual content    │
└─────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────┐
│              Canvas Manager                      │
│  - Session lifecycle management                  │
│  - BrowserWindow creation (hidden for snapshots) │
│  - File watching (chokidar)                      │
│  - Event broadcasting                            │
│  - Snapshot capture for in-app preview           │
└─────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────┐
│           Canvas BrowserWindow                   │
│  - Loads content via canvas:// protocol          │
│  - Isolated session directory                    │
│  - A2UI bridge for user interactions             │
│  - Hidden by default, shown on demand            │
└─────────────────────────────────────────────────┘
          ↓                           ↓
┌─────────────────────────┐   ┌─────────────────────────┐
│     In-App Preview      │   │   Full Canvas Window    │
│  - Interactive mode     │   │   - Full interactivity  │
│    (embedded webview)   │   │   - Form submissions    │
│  - Snapshot mode        │   │   - A2UI communication  │
│  - Resizable            │   │   - Separate window     │
│  - Export options       │   │                         │
└─────────────────────────┘   └─────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────┐
│           canvas:// Protocol Handler             │
│  - Secure file serving from session directory    │
│  - MIME type detection                           │
│  - Path traversal protection                     │
└─────────────────────────────────────────────────┘
```

## Agent Tools

The following tools are available to agents for canvas operations:

### `canvas_create`

Creates a new canvas session.

**Input:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | No | Window title (default: "Canvas {timestamp}") |

**Output:**
```json
{
  "sessionId": "abc123-def456",
  "sessionDir": "/path/to/session/directory"
}
```

### `canvas_push`

Pushes content to the canvas session.

**Input:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | Yes | Canvas session ID |
| `content` | string | Yes | HTML/CSS/JS content |
| `filename` | string | No | Filename (default: "index.html") |

**Output:**
```json
{
  "success": true
}
```

### `canvas_show`

Shows the canvas window and brings it to focus.

**Input:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | Yes | Canvas session ID |

**Output:**
```json
{
  "success": true
}
```

### `canvas_hide`

Hides the canvas window without closing the session.

**Input:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | Yes | Canvas session ID |

**Output:**
```json
{
  "success": true
}
```

### `canvas_close`

Closes the canvas session and its window.

**Input:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | Yes | Canvas session ID |

**Output:**
```json
{
  "success": true
}
```

### `canvas_eval`

Executes JavaScript in the canvas context.

**Input:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | Yes | Canvas session ID |
| `script` | string | Yes | JavaScript code to execute |

**Output:**
```json
{
  "result": <any>
}
```

### `canvas_snapshot`

Takes a screenshot of the canvas content.

**Input:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | Yes | Canvas session ID |

**Output:**
```json
{
  "imageBase64": "iVBORw0KGgo...",
  "width": 800,
  "height": 600
}
```

### `canvas_list`

Lists all canvas sessions for the current task.

**Input:** None

**Output:**
```json
{
  "sessions": [
    {
      "id": "abc123",
      "title": "My Canvas",
      "status": "active",
      "createdAt": 1706789012345
    }
  ]
}
```

## Example Usage

### Creating a Data Visualization

```javascript
// Agent creates a canvas session
const { sessionId } = await canvas_create({ title: "Sales Dashboard" });

// Push HTML content with Chart.js
await canvas_push({
  session_id: sessionId,
  content: `
    <!DOCTYPE html>
    <html>
    <head>
      <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
      <style>
        body { font-family: system-ui; padding: 20px; }
        canvas { max-width: 600px; }
      </style>
    </head>
    <body>
      <h1>Q4 Sales by Region</h1>
      <canvas id="chart"></canvas>
      <script>
        new Chart(document.getElementById('chart'), {
          type: 'bar',
          data: {
            labels: ['North', 'South', 'East', 'West'],
            datasets: [{
              label: 'Sales ($M)',
              data: [12, 19, 8, 15],
              backgroundColor: ['#4CAF50', '#2196F3', '#FFC107', '#9C27B0']
            }]
          }
        });
      </script>
    </body>
    </html>
  `
});

// The in-app preview automatically shows the content!
// No need to call canvas_show unless user needs full interactivity

// Optional: Take a snapshot programmatically
const { imageBase64 } = await canvas_snapshot({ session_id: sessionId });
```

### Interactive Form

```javascript
// Create canvas with a form for user input
const { sessionId } = await canvas_create({ title: "Configuration" });

await canvas_push({
  session_id: sessionId,
  content: `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: system-ui; padding: 20px; }
        input, select { margin: 10px 0; padding: 8px; width: 200px; }
        button { background: #007AFF; color: white; padding: 10px 20px; border: none; cursor: pointer; }
      </style>
    </head>
    <body>
      <h2>Project Settings</h2>
      <form id="config">
        <div>
          <label>Project Name:</label><br>
          <input type="text" id="name" value="my-project">
        </div>
        <div>
          <label>Framework:</label><br>
          <select id="framework">
            <option value="react">React</option>
            <option value="vue">Vue</option>
            <option value="svelte">Svelte</option>
          </select>
        </div>
        <button type="button" onclick="window.coworkCanvas.sendA2UIAction('submit', 'config', getFormData())">
          Apply Settings
        </button>
      </form>
      <script>
        function getFormData() {
          return {
            name: document.getElementById('name').value,
            framework: document.getElementById('framework').value
          };
        }
      </script>
    </body>
    </html>
  `
});

// For interactive forms, show the canvas window so user can interact
// The in-app preview shows a snapshot, but for clicking buttons/filling forms,
// the user needs the full window
await canvas_show({ session_id: sessionId });
```

## A2UI (Agent-to-UI) Communication

Canvas windows can send actions back to the agent using the A2UI bridge. This enables interactive workflows where user actions in the canvas trigger agent responses.

### Sending Actions from Canvas

The canvas preload script exposes `window.coworkCanvas`:

```javascript
// Send an action to the agent
window.coworkCanvas.sendA2UIAction(
  'button_click',           // Action name
  'submit-button',          // Component ID
  { formData: {...} }       // Context object
);
```

### Receiving Actions in Agent

When a user interacts with the canvas, the agent receives a formatted message:

```
[Canvas Interaction]
Action: button_click
Component: submit-button
Context: { "formData": { ... } }

The user interacted with the canvas. Please respond appropriately based on this action.
```

## Security

### Path Traversal Protection

The `canvas://` protocol implements multiple layers of security:

1. **Double dot check**: Paths containing `..` are rejected
2. **Double slash check**: Paths containing `//` are rejected
3. **Path containment**: Resolved paths must be within the session directory

### Session Isolation

- Each canvas session has its own directory
- Sessions are scoped to specific tasks
- File operations are sandboxed to the session directory

### URL Format

```
canvas://{sessionId}/{filename}
```

Example: `canvas://abc123-def456/index.html`

## Configuration

Live Canvas uses the following directory for session storage:

```
~/Library/Application Support/cowork-os/canvas/{sessionId}/
```

Sessions are automatically cleaned up when:
- The session is explicitly closed via `canvas_close`
- The application exits
- The parent task is deleted

## Supported Content

### File Types

| Extension | MIME Type |
|-----------|-----------|
| `.html`, `.htm` | `text/html` |
| `.css` | `text/css` |
| `.js`, `.mjs` | `application/javascript` |
| `.json` | `application/json` |
| `.png` | `image/png` |
| `.jpg`, `.jpeg` | `image/jpeg` |
| `.svg` | `image/svg+xml` |
| `.gif` | `image/gif` |
| `.webp` | `image/webp` |
| `.woff`, `.woff2` | `font/woff`, `font/woff2` |
| `.ttf`, `.otf` | `font/ttf`, `font/otf` |
| `.mp3` | `audio/mpeg` |
| `.mp4` | `video/mp4` |
| `.pdf` | `application/pdf` |

### External Resources

Canvas content can load external resources via CDN:
- Chart.js, D3.js for visualizations
- Tailwind CSS, Bootstrap for styling
- Any other libraries via script/link tags

## Events

The Canvas Manager emits events that can be observed in the main process:

| Event | Description |
|-------|-------------|
| `session_created` | New canvas session created |
| `session_closed` | Canvas session closed |
| `content_pushed` | Content pushed to canvas |
| `window_opened` | Canvas window opened |
| `window_closed` | Canvas window closed |
| `a2ui_action` | User interaction from canvas |

## Troubleshooting

### In-App Preview Not Appearing

1. The preview only appears after content is pushed (not when session is created)
2. Wait for the initial load - the preview retries up to 3 times before showing an error
3. Ensure the canvas session is still active (not closed)

### Preview Shows "Failed to capture canvas"

1. The hidden browser window may not have loaded the content yet
2. Try clicking the refresh button to force a new snapshot
3. Check that the HTML content is valid and doesn't have JavaScript errors

### Preview Not Updating

1. Auto-refresh only works when the session status is "active"
2. Make sure the preview is not minimized (minimized previews don't auto-refresh)
3. The refresh interval is 2 seconds - be patient for updates

### Canvas Window Not Showing

1. Ensure the session exists with `canvas_list`
2. Check that `canvas_show` was called after `canvas_push`
3. Verify the content has valid HTML structure

### Content Not Updating

1. The canvas auto-reloads on file changes
2. Ensure you're pushing to the correct session ID
3. Check browser console for JavaScript errors

### A2UI Actions Not Received

1. Verify `window.coworkCanvas` is available in the canvas context
2. Check that the action name is descriptive
3. Ensure the canvas window is still open

## API Reference

See the following files for implementation details:

- `src/electron/canvas/canvas-manager.ts` - Session management
- `src/electron/canvas/canvas-protocol.ts` - URL protocol handler
- `src/electron/agent/tools/canvas-tools.ts` - Agent tool definitions
- `src/electron/ipc/canvas-handlers.ts` - IPC handlers
- `src/electron/canvas/build-mode-orchestrator.ts` - Build Mode phase management
- `src/renderer/components/CanvasPreview.tsx` - In-app preview component
- `src/renderer/components/MainContent.tsx` - Canvas session integration
