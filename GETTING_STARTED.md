# Getting Started with CoWork OS

## Quick Start

### Step 1: Install Dependencies

```bash
git clone https://github.com/CoWork-OS/CoWork-OS.git
cd CoWork-OS
npm run setup
```

### Step 2: Run the App

```bash
npm run dev
```

This will:
1. Start the Vite dev server (React UI)
2. Launch Electron with hot reload enabled
3. Open DevTools automatically

### Step 3: Configure Your LLM Provider

1. Click the **Settings** icon (gear) in the sidebar
2. Choose your LLM provider:
   - **Anthropic** - Claude models (requires API key from [console.anthropic.com](https://console.anthropic.com))
   - **Google Gemini** - Gemini models (requires API key from [aistudio.google.com](https://aistudio.google.com/apikey))
   - **OpenRouter** - Multiple models (requires API key from [openrouter.ai](https://openrouter.ai/keys))
   - **OpenAI** - GPT-4o, o1 models (requires API key from [platform.openai.com](https://platform.openai.com/api-keys))
   - **AWS Bedrock** - Enterprise AWS (requires AWS credentials)
   - **Ollama** - Local models (free, requires [Ollama](https://ollama.ai) installed)
3. Enter your API key
4. Click **Test Connection** to verify
5. Save settings

## Troubleshooting

- If **Test Connection** fails with 401/403, verify the API key and account permissions.
- If the model list is empty, click **Refresh Models** after entering your API key (and Base URL if overridden).
- If a provider endpoint changes, override the **Base URL** in Settings (custom providers or Groq/xAI/Kimi/OpenRouter).
- If Ollama fails to connect, confirm the service is running and the base URL is correct (default `http://localhost:11434`).
- If `npm run setup` fails on macOS with `Killed: 9`, macOS terminated the native build due to memory pressure. The setup script retries automatically (with exponential backoff); if it still fails, close other apps and run `npm run setup` again.

### Step 4: Create Your First Task

1. **Select a Workspace**
   - Click "Select Folder"
   - Choose a folder you want CoWork OS to work in
   - This will be your workspace (e.g., `~/Documents/test-workspace`)

2. **Initialize the Workspace Kit (Optional, Recommended)**
   - Open **Settings** > **Memory Hub**
   - Under **Workspace Kit**, click **Initialize**
   - This creates a `.cowork/` directory in your workspace for durable context and project scaffolding

3. **Create a Task**
   - Click "+ New Task"
   - Title: "Organize my files"
   - Description: "Please organize all files in this folder by file type (Images, Documents, etc.)"
   - Click "Create Task"

4. **Watch it Work**
   - The agent will create a plan
   - Execute steps using available tools
   - Show real-time progress in the timeline
   - Request approval before destructive changes

### Step 5: Validate Relationship-Agent Behavior

Use this acceptance check after setup:

1. Create a strategic prompt:
   - `I built you, how should I position you, who should I target, and what should I aim to achieve?`
2. Confirm response quality:
   - You should get a direct answer early, then deeper execution if needed.
3. Confirm completion:
   - Task should end in `completed` with a usable final answer.
4. Confirm timeout handling:
   - If a step times out, the task should still produce a best-effort final answer.
5. Confirm memory continuity:
   - Send: `Call me Mesut. I prefer concise responses. Remind me to send investor update tomorrow.`
   - Open **Settings** > **Memory System** and confirm relationship memory + commitments are visible.
6. Confirm memory controls:
   - Edit a relationship item, mark a commitment done/reopen, and forget one item.
   - Restart app and verify changes persist.

## Example Tasks to Try

### 1. File Organization

```
Title: Organize Downloads
Description: Organize all files in this folder by type. Create folders for Images, Documents, Spreadsheets, and Other. Move files into appropriate folders.
```

### 2. Create a Spreadsheet

```
Title: Create sales report
Description: Create an Excel spreadsheet with monthly sales data for Q1-Q4. Include columns for Month, Revenue, Expenses, and Profit. Add a summary row with totals.
```

### 3. Create a Document

```
Title: Write project summary
Description: Create a Word document summarizing our project. Include sections for Overview, Goals, Timeline, and Next Steps. Use professional formatting.
```

### 4. Create a Presentation

```
Title: Create quarterly report
Description: Create a PowerPoint presentation with 5 slides covering Q1 2024 highlights. Include: Title slide, Overview, Key Metrics, Challenges, and Next Steps.
```

### 5. Web Research (requires search provider)

```
Title: Research AI trends
Description: Search the web for the latest trends in AI for 2024 and create a summary document with the top 5 findings.
```

### 6. Browser Automation

```
Title: Screenshot a webpage
Description: Navigate to https://example.com and take a screenshot. Save it as example-screenshot.png.
```

## Understanding the UI

### Sidebar (Left)

- **Workspace Info**: Shows current workspace name and path
- **Settings Button**: Configure LLM, search, and channel settings
- **New Task Button**: Create a new task
- **Task List**: All tasks sorted by creation date
- **Task Status Indicators**:
  - Blue = Active (planning/executing)
  - Green = Completed
  - Red = Failed/Cancelled
  - Gray = Pending

### Task View (Right)

- **Task Header**: Title and metadata
- **Task Description**: What you asked for
- **Activity Timeline**: Real-time execution log showing:
  - Task created
  - Plan created
  - Steps started/completed
  - Tool calls
  - Files created/modified
  - Errors

### Memory System (Relationship Controls)

In **Settings** > **Memory System**:

- **User Memory Facts**: curated profile facts (existing functionality).
- **Relationship Memory**: layered continuity memory:
  - identity
  - preferences
  - context
  - history
  - commitments
- **Commitment controls**:
  - Mark done/reopen
  - Edit text
  - Forget item
  - View due-soon reminders

### Approval Dialogs

When the agent needs permission for:
- Deleting files
- Bulk operations
- Shell commands

You'll see a dialog with:
- What it wants to do
- Why it needs to do it
- Approve or Deny buttons

## Configuring Providers

### LLM Providers

Open **Settings** > **Provider** tab:

| Provider | Setup |
|----------|-------|
| Anthropic | Enter API key from [console.anthropic.com](https://console.anthropic.com) |
| Google Gemini | Enter API key from [aistudio.google.com](https://aistudio.google.com/apikey) |
| OpenRouter | Enter API key from [openrouter.ai](https://openrouter.ai/keys) |
| OpenAI (API Key) | Enter API key from [platform.openai.com](https://platform.openai.com/api-keys) |
| OpenAI (ChatGPT) | Click "Sign in with ChatGPT" to use your subscription |
| AWS Bedrock | Enter AWS Access Key, Secret Key, and Region |
| Ollama | Install Ollama, pull a model, select it |
| Groq | Enter API key in Settings |
| xAI (Grok) | Enter API key in Settings |
| Kimi (Moonshot) | Enter API key in Settings |

### Compatible / Gateway Providers

Configure these in **Settings** > **LLM Provider** by entering API keys/tokens, model IDs, and base URLs when required.

| Provider | Setup |
|----------|-------|
| OpenCode Zen | API key + base URL in Settings |
| Google Vertex | Access token + base URL in Settings |
| Google Antigravity | Access token + base URL in Settings |
| Google Gemini CLI | Access token + base URL in Settings |
| Z.AI | API key + base URL in Settings |
| GLM | API key + base URL in Settings |
| Vercel AI Gateway | API key in Settings |
| Cerebras | API key in Settings |
| Mistral | API key in Settings |
| GitHub Copilot | GitHub token in Settings |
| Moonshot (Kimi) | API key in Settings |
| Qwen Portal | API key in Settings |
| MiniMax | API key in Settings |
| MiniMax Portal | API key in Settings |
| Xiaomi MiMo | API key in Settings |
| Venice AI | API key in Settings |
| Synthetic | API key in Settings |
| Kimi Code | API key in Settings |
| OpenAI-Compatible (Custom) | API key + base URL in Settings |
| Anthropic-Compatible (Custom) | API key + base URL in Settings |

### Search Providers (Optional)

Open **Settings** > **Web Search** tab:

| Provider | Setup |
|----------|-------|
| Tavily | Enter API key from [tavily.com](https://tavily.com) |
| Brave | Enter API key from [brave.com/search/api](https://brave.com/search/api) |
| SerpAPI | Enter API key from [serpapi.com](https://serpapi.com) |
| Google | Enter API key and Search Engine ID from Google Cloud Console |

### Channel Integrations (Optional)

#### WhatsApp Bot
1. Open **Settings** > **WhatsApp**
2. Click **Add WhatsApp Channel**
3. A QR code will appear
4. Open WhatsApp on phone → **Settings** > **Linked Devices** > **Link a Device**
5. Scan the QR code
6. Once connected, enable **Self-Chat Mode** if using your personal number
7. Set a **Response Prefix** (e.g., "🤖") to distinguish bot messages

#### Telegram Bot
1. Create bot with [@BotFather](https://t.me/BotFather)
2. Open **Settings** > **Channels** > **Telegram**
3. Enter bot token
4. Enable and test

#### Discord Bot
1. Create app at [Discord Developer Portal](https://discord.com/developers/applications)
2. Open **Settings** > **Channels** > **Discord**
3. Enter bot token and application ID
4. Invite bot to server
5. Enable and test

#### Slack Bot
1. Create app at [Slack API Apps](https://api.slack.com/apps)
2. Enable Socket Mode and create App-Level Token (xapp-...)
3. Add OAuth scopes: `app_mentions:read`, `chat:write`, `im:history`, `im:read`, `im:write`, `users:read`, `files:write`
4. Subscribe to events: `app_mention`, `message.im`
5. Install to workspace and copy Bot Token (xoxb-...)
6. Open **Settings** > **Channels** > **Slack**
7. Enter Bot Token and App-Level Token
8. Enable and test

### App Integrations (Optional)

Open **Settings** > **Integrations** to connect productivity and storage tools:

- Notion
- Box
- OneDrive
- Google Workspace (Gmail, Calendar, Drive)
- Dropbox
- SharePoint

### Enterprise MCP Connectors (Optional)

Install enterprise connectors from **Settings** > **MCP Servers** > **Browse Registry**:

| Connector | Type | Setup |
|-----------|------|-------|
| **Salesforce** | CRM | OAuth or API key |
| **Jira** | Issue Tracking | API token + domain |
| **HubSpot** | CRM | API key |
| **Zendesk** | Support | API key + subdomain |
| **ServiceNow** | ITSM | OAuth or credentials |
| **Linear** | Product/Issue | API key |
| **Asana** | Work Management | Personal access token |
| **Okta** | Identity | API token + domain |

Each connector provides tools like `search`, `get`, `create`, and `update` for its respective service.

### Social Integrations (Optional)

#### X (Twitter)
1. Open **Settings** > **X (Twitter)**
2. Choose Browser Cookies or Manual Cookies
3. Save and test the connection

## Development Workflow

### Making Changes

The app supports hot reload:

1. **React UI Changes**: Edit files in `src/renderer/` - auto-refreshes
2. **Electron Main Changes**: Edit files in `src/electron/` - auto-restarts
3. **Shared Types**: Edit `src/shared/types.ts` - both reload

### Project Structure

```
src/
├── electron/          # Backend (Node.js)
│   ├── main.ts       # App entry point
│   ├── agent/        # AI agent logic
│   │   ├── llm/      # LLM providers
│   │   ├── search/   # Search providers
│   │   ├── browser/  # Playwright
│   │   ├── tools/    # Tool implementations
│   │   └── skills/   # Document skills
│   ├── gateway/      # WhatsApp, Telegram, Discord & Slack
│   └── database/     # SQLite storage
├── renderer/         # Frontend (React)
│   ├── App.tsx       # Main component
│   └── components/   # UI components
└── shared/           # Shared between both
    └── types.ts      # TypeScript types
```

### Debugging

**Renderer Process (UI)**:
- DevTools open automatically in dev mode
- Use `console.log()` - shows in DevTools Console

**Main Process (Backend)**:
- Use `console.log()` - shows in terminal
- Check logs: `~/Library/Application Support/cowork-os/`

### Database

SQLite database location: `~/Library/Application Support/cowork-os/cowork-os.db`

View it with any SQLite browser or:
```bash
sqlite3 ~/Library/Application\ Support/cowork-os/cowork-os.db
.tables
SELECT * FROM tasks;
```

## Building for Production

```bash
# Build both renderer and electron
npm run build

# Package as macOS app
npm run package
```

Output: `release/CoWork-OS-{version}.dmg`

## Common Issues

### Issue: "No LLM provider configured"

**Solution**: Open Settings (gear icon) and configure at least one LLM provider.

### Issue: Electron won't start

**Solution**: Clear and reinstall:
```bash
rm -rf node_modules dist
npm run setup
npm run dev
```

### Issue: "Permission denied" for workspace

**Solution**: Choose a folder you have write access to, like:
- `~/Documents/cowork-test`
- `~/Downloads/test`

Don't use system folders like `/System` or `/Applications`.

### Issue: Tasks fail immediately

**Solution**: Check:
1. LLM provider is configured in Settings
2. API key is valid
3. Workspace has proper permissions
4. Network connection for API calls
5. Check console for error messages

### Issue: Ollama connection failed

**Solution**:
1. Make sure Ollama is running: `ollama serve`
2. Check URL is correct (default: `http://localhost:11434`)
3. Make sure you've pulled a model: `ollama pull llama3.2`

## Tips for Best Results

1. **Be Specific**: Clear task descriptions work better
2. **Start Small**: Test with a few files before bulk operations
3. **Review Plans**: Check the execution plan before it runs
4. **Approve Carefully**: Read approval requests before accepting
5. **Monitor Progress**: Watch the timeline to understand what's happening
6. **Use Local Models**: Ollama is free and works offline

## Next Steps

### Try Advanced Features

1. **Web Search**: Configure a search provider and ask research questions
2. **Browser Automation**: Have the agent navigate websites and extract data
3. **Remote Access**: Set up WhatsApp, Telegram, Discord, or Slack bot for mobile/remote access
4. **Document Creation**: Create professional Excel, Word, PDF, or PowerPoint files
5. **Goal Mode**: Define success criteria and let the agent auto-retry until verification passes
6. **Custom Skills**: Create reusable workflows with custom prompts in Settings > Custom Skills
7. **MCP Servers**: Connect to external tools via MCP in Settings > MCP Servers
8. **Enterprise Connectors**: Install Salesforce, Jira, HubSpot, and other connectors from the MCP Registry
9. **Cloud Storage**: Connect Notion, Box, OneDrive, Google Workspace (Gmail/Calendar/Drive), Dropbox, or SharePoint in Settings > Integrations
10. **Parallel Tasks**: Run multiple tasks concurrently (configure in Settings > Task Queue)
11. **Guardrails**: Set token/cost budgets and blocked commands in Settings > Guardrails

### Learn More

- [Full README](README.md) - Complete documentation
- [Implementation Summary](IMPLEMENTATION_SUMMARY.md) - Technical details
- [Project Status](PROJECT_STATUS.md) - Feature status

## Getting Help

- Check console output for errors
- Review the task timeline for clues
- Read error messages in the UI
- Report issues at [GitHub Issues](https://github.com/CoWork-OS/CoWork-OS/issues)
