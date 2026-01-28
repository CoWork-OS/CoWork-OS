# Getting Started with CoWork-OSS

## Quick Start

### Step 1: Install Dependencies

```bash
git clone https://github.com/mesutfelat/cowork-oss.git
cd cowork-oss
npm install
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
   - **AWS Bedrock** - Enterprise AWS (requires AWS credentials)
   - **Ollama** - Local models (free, requires [Ollama](https://ollama.ai) installed)
3. Enter your API key
4. Click **Test Connection** to verify
5. Save settings

### Step 4: Create Your First Task

1. **Select a Workspace**
   - Click "Select Folder"
   - Choose a folder you want CoWork-OSS to work in
   - This will be your workspace (e.g., `~/Documents/test-workspace`)

2. **Create a Task**
   - Click "+ New Task"
   - Title: "Organize my files"
   - Description: "Please organize all files in this folder by file type (Images, Documents, etc.)"
   - Click "Create Task"

3. **Watch it Work**
   - The agent will create a plan
   - Execute steps using available tools
   - Show real-time progress in the timeline
   - Request approval before destructive changes

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
| AWS Bedrock | Enter AWS Access Key, Secret Key, and Region |
| Ollama | Install Ollama, pull a model, select it |

### Search Providers (Optional)

Open **Settings** > **Web Search** tab:

| Provider | Setup |
|----------|-------|
| Tavily | Enter API key from [tavily.com](https://tavily.com) |
| Brave | Enter API key from [brave.com/search/api](https://brave.com/search/api) |
| SerpAPI | Enter API key from [serpapi.com](https://serpapi.com) |
| Google | Enter API key and Search Engine ID from Google Cloud Console |

### Channel Integrations (Optional)

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
│   ├── gateway/      # Telegram, Discord & Slack
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
- Check logs: `~/Library/Application Support/cowork-oss/`

### Database

SQLite database location: `~/Library/Application Support/cowork-oss/cowork-oss.db`

View it with any SQLite browser or:
```bash
sqlite3 ~/Library/Application\ Support/cowork-oss/cowork-oss.db
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

Output: `release/CoWork-OSS-{version}.dmg`

## Common Issues

### Issue: "No LLM provider configured"

**Solution**: Open Settings (gear icon) and configure at least one LLM provider.

### Issue: Electron won't start

**Solution**: Clear and reinstall:
```bash
rm -rf node_modules dist
npm install
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
3. **Remote Access**: Set up Telegram, Discord, or Slack bot for mobile/remote access
4. **Document Creation**: Create professional Excel, Word, PDF, or PowerPoint files
5. **Goal Mode**: Define success criteria and let the agent auto-retry until verification passes
6. **Custom Skills**: Create reusable workflows with custom prompts in Settings > Custom Skills
7. **MCP Servers**: Connect to external tools via MCP in Settings > MCP Servers
8. **Parallel Tasks**: Run multiple tasks concurrently (configure in Settings > Task Queue)
9. **Guardrails**: Set token/cost budgets and blocked commands in Settings > Guardrails

### Learn More

- [Full README](README.md) - Complete documentation
- [Implementation Summary](IMPLEMENTATION_SUMMARY.md) - Technical details
- [Project Status](PROJECT_STATUS.md) - Feature status

## Getting Help

- Check console output for errors
- Review the task timeline for clues
- Read error messages in the UI
- Report issues at [GitHub Issues](https://github.com/mesutfelat/cowork-oss/issues)
