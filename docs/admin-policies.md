# Admin Policies

Admin Policies provide organization-level control over plugin packs, connectors, agents, and installation permissions. Policies are enforced at the IPC handler level, meaning the backend rejects policy-violating operations regardless of how they're triggered.

Access from **Settings** > **Admin Policies** (requires Power density mode).

---

## Concepts

### Policy File

Policies are stored as JSON in the CoWork OS user data directory:

```
~/.cowork/policies.json
```

The file is created when policies are first saved via the Admin Policies panel. If the file doesn't exist, permissive defaults apply (everything allowed, nothing blocked or required).

### Policy Scopes

| Scope | What It Controls |
|-------|-----------------|
| **Pack policies** | Which plugin packs are allowed, blocked, or required |
| **Connector policies** | Which MCP connectors are blocked |
| **Agent policies** | Heartbeat frequency limits, concurrent agent caps |
| **Installation policies** | Whether users can create, install from git, or install from URL |
| **Organization settings** | Org name, org plugin directory path |

### Enforcement Points

Policies are enforced in the following IPC handlers:

| Handler | Enforcement |
|---------|-------------|
| `pluginPack:list` | Blocked packs returned with `policyBlocked: true`, required packs with `policyRequired: true` |
| `pluginPack:get` | Same policy flags included in response |
| `pluginPack:toggle` | Blocked packs cannot be enabled; required packs cannot be disabled |
| `pluginPack:scaffold` | Blocked if `allowCustomPacks` is false |
| `pluginPack:installGit` | Blocked if `allowGitInstall` is false |
| `pluginPack:installUrl` | Blocked if `allowUrlInstall` is false |

---

## Policy Schema

```json
{
  "version": 1,
  "updatedAt": "2025-01-15T12:00:00Z",
  "packs": {
    "allowed": [],
    "blocked": ["unwanted-pack"],
    "required": ["engineering", "devops"]
  },
  "connectors": {
    "blocked": ["risky-connector"]
  },
  "agents": {
    "maxHeartbeatFrequencySec": 60,
    "maxConcurrentAgents": 10
  },
  "general": {
    "allowCustomPacks": true,
    "allowGitInstall": true,
    "allowUrlInstall": true,
    "orgName": "Acme Corp",
    "orgPluginDir": "/opt/acme/cowork-plugins"
  }
}
```

### Field Reference

#### `packs`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `allowed` | `string[]` | `[]` | Whitelist of allowed pack IDs. If empty, all packs are allowed (except blocked). If non-empty, only listed packs are permitted. |
| `blocked` | `string[]` | `[]` | Blacklist of blocked pack IDs. Takes precedence over `allowed`. Blocked packs appear disabled in the UI. |
| `required` | `string[]` | `[]` | Pack IDs that are auto-activated and cannot be disabled by users. |

**Precedence:** `blocked` > `allowed` > default (allow all)

#### `connectors`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `blocked` | `string[]` | `[]` | Connector IDs that are blocked from use. |

#### `agents`

| Field | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `maxHeartbeatFrequencySec` | `number` | `60` | >= 60 | Minimum seconds between agent heartbeats. Prevents excessive resource usage. |
| `maxConcurrentAgents` | `number` | `10` | >= 1 | Maximum number of agents that can run simultaneously per workspace. |

#### `general`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `allowCustomPacks` | `boolean` | `true` | Whether users can create custom plugin packs via scaffold. |
| `allowGitInstall` | `boolean` | `true` | Whether users can install packs from Git repositories. |
| `allowUrlInstall` | `boolean` | `true` | Whether users can install packs from URLs. |
| `orgName` | `string?` | — | Organization name displayed in the UI. |
| `orgPluginDir` | `string?` | — | Absolute path to the organization plugin packs directory. |

---

## Organization Plugin Directory

Organization admins can distribute plugin packs to all users by placing them in a shared directory.

### Setup

1. Create a directory for org plugins (e.g., `/opt/company/cowork-plugins/`)
2. Place plugin packs as subdirectories, each with a `cowork.plugin.json`
3. Set the path in Admin Policies > Organization > Organization Plugin Directory
4. Restart CoWork OS

### Directory Structure

```
/opt/company/cowork-plugins/
├── company-engineering/
│   └── cowork.plugin.json
├── company-sales/
│   └── cowork.plugin.json
└── company-compliance/
    └── cowork.plugin.json
```

### How It Works

1. On startup, the Plugin Loader scans three directories in order:
   - Built-in packs (`resources/plugin-packs/`)
   - Organization packs (from `orgPluginDir` or `~/.cowork/org-plugins/`)
   - User packs (`~/.cowork/extensions/`)
2. Organization packs are loaded with `scope: "organization"` in their manifest
3. In the Customize panel, org packs appear in a separate "Organization" section
4. Admin policies can make org packs required (cannot be disabled)

### Default Org Directory

If no custom `orgPluginDir` is configured, CoWork OS checks `~/.cowork/org-plugins/`. Create this directory to use it as the default org plugin location.

---

## Admin Policies Panel

The Admin Policies panel is accessible from **Settings** > **Admin Policies** (visible in Power density mode only).

### Sections

**Organization**
- Organization Name — displayed in the UI when set
- Organization Plugin Directory — path to the shared org plugins folder

**Plugin Pack Policies**
- Blocked Packs — comma-separated list of pack IDs to block
- Required Packs — comma-separated list of pack IDs that must stay enabled
- Allowed Packs (whitelist) — if set, only these packs are permitted

**Connector Policies**
- Blocked Connectors — comma-separated list of connector IDs to block

**Agent Policies**
- Max Heartbeat Frequency — minimum seconds between heartbeats (>= 60)
- Max Concurrent Agents — maximum agents per workspace (>= 1)

**Installation Permissions**
- Allow custom plugin packs (scaffold)
- Allow installation from Git repositories
- Allow installation from URLs

### Saving

Click "Save Policies" to persist changes to `~/.cowork/policies.json`. Changes take effect immediately — no restart required. The "Reset" button reloads the last saved state.

---

## Use Cases

### Restricting Pack Availability

Block specific packs that aren't relevant or approved for your organization:

```json
{
  "packs": {
    "blocked": ["content-marketing", "sales-crm"]
  }
}
```

### Enforcing Standard Packs

Ensure all users have essential packs enabled:

```json
{
  "packs": {
    "required": ["engineering", "devops", "qa-testing"]
  }
}
```

### Whitelist-Only Mode

Only allow specific approved packs:

```json
{
  "packs": {
    "allowed": ["engineering", "engineering-management", "product-management", "devops"]
  }
}
```

### Restricting External Installations

Prevent users from installing packs from external sources:

```json
{
  "general": {
    "allowCustomPacks": false,
    "allowGitInstall": false,
    "allowUrlInstall": false
  }
}
```

### Limiting Agent Resources

Cap heartbeat frequency and concurrent agents for resource management:

```json
{
  "agents": {
    "maxHeartbeatFrequencySec": 300,
    "maxConcurrentAgents": 5
  }
}
```

### Full Enterprise Configuration

A complete enterprise setup:

```json
{
  "version": 1,
  "updatedAt": "2025-01-15T12:00:00Z",
  "packs": {
    "allowed": [],
    "blocked": [],
    "required": ["engineering", "devops"]
  },
  "connectors": {
    "blocked": []
  },
  "agents": {
    "maxHeartbeatFrequencySec": 120,
    "maxConcurrentAgents": 8
  },
  "general": {
    "allowCustomPacks": true,
    "allowGitInstall": false,
    "allowUrlInstall": false,
    "orgName": "Acme Corp",
    "orgPluginDir": "/opt/acme/cowork-plugins"
  }
}
```

---

## IPC Channels

| Channel | Purpose |
|---------|---------|
| `admin:policiesGet` | Returns the full policy object |
| `admin:policiesUpdate` | Accepts partial updates, merges with existing policies |
| `admin:checkPack` | Returns `{ packId, allowed, required }` for a specific pack |

### Preload API

```typescript
// Get current policies
const policies = await window.electronAPI.getAdminPolicies();

// Update policies (partial merge)
const updated = await window.electronAPI.updateAdminPolicies({
  packs: { blocked: ["unwanted-pack"] },
  general: { allowGitInstall: false },
});

// Check a specific pack
const check = await window.electronAPI.checkPackPolicy("engineering");
// Returns: { packId: "engineering", allowed: true, required: false }
```

---

## Architecture

### Data Flow

```
┌──────────────────┐     IPC invoke      ┌──────────────────────┐
│  Renderer         │ ──────────────────► │  admin-policy-       │
│  (AdminPolicies   │                     │  handlers.ts         │
│   Panel)          │ ◄────────────────── │                      │
└──────────────────┘     IPC response     └──────────────────────┘
                                                  │
                                                  ▼
                                          ┌──────────────────────┐
                                          │  policies.ts          │
                                          │  (load/save/validate) │
                                          │                       │
                                          │  ~/.cowork/           │
                                          │   policies.json       │
                                          └──────────────────────┘

Enforcement:
┌──────────────────────┐     checks      ┌──────────────────────┐
│  plugin-pack-        │ ◄──────────────► │  policies.ts         │
│  handlers.ts         │                  │  isPackAllowed()     │
│  plugin-distribution │                  │  isPackRequired()    │
│  -handlers.ts        │                  │  loadPolicies()      │
└──────────────────────┘                  └──────────────────────┘
```

### Files

| File | Purpose |
|------|---------|
| `src/electron/admin/policies.ts` | Policy loading, saving, validation, and query functions |
| `src/electron/ipc/admin-policy-handlers.ts` | IPC handlers for policy CRUD operations |
| `src/renderer/components/AdminPoliciesPanel.tsx` | React UI for managing policies |
| `~/.cowork/policies.json` | Persisted policy configuration |

---

## Troubleshooting

### Policies not taking effect
- Policies are applied immediately on save — no restart needed
- Verify `~/.cowork/policies.json` was written correctly
- Check the main process console for policy-related errors

### Cannot toggle a pack on
- The pack may be in the `blocked` list
- If an `allowed` whitelist is set, the pack must be included
- Check Admin Policies > Plugin Pack Policies > Blocked Packs

### Cannot toggle a pack off
- The pack is in the `required` list
- Remove it from Admin Policies > Plugin Pack Policies > Required Packs

### Org plugins not loading
- Verify the org plugin directory path exists and contains valid packs
- Each subdirectory must have a `cowork.plugin.json` at its root
- Restart CoWork OS after changing the org directory path

### "Installation disabled by admin policy"
- Custom pack creation, git install, or URL install has been disabled
- Check Admin Policies > Installation Permissions

---

## Further Reading

- [Plugin Packs](plugin-packs.md) — Complete plugin pack system documentation
- [Digital Twin Personas](digital-twins.md) — Proactive AI twin personas
- [Features](features.md) — Complete feature reference
