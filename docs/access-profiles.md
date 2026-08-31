# Access Profiles

Access profiles are CoWork OS's canonical way to decide what an agent may do.
They package the execution sandbox, approval behavior, reviewer behavior, network
posture, and optional filesystem/domain boundaries into one named policy that is
carried with the task.

This follows the access model described in the official [Codex sandbox
guide](https://learn.chatgpt.com/docs/sandboxing?surface=app#how-you-control-it):
sandboxing defines the technical boundary, while approval policy defines when
the agent must stop and ask. CoWork adapts that model into a local, named
profile contract. Command tools are part of the selected profile; there is no
separate user-facing **Shell enabled** or **Shell disabled** switch for a new
task.

## Quick choice

The main composer exposes these built-in profiles:

| Profile | Sandbox | Approval and reviewer | Network | Best for |
|---|---|---|---|---|
| **Ask for approval** | `workspace-write` | `on-request` / `user` | `on-request` | Interactive work where boundary-crossing or risky actions should be shown to the operator |
| **Approve for me** | `workspace-write` | `on-request` / `auto-review` | `on-request` | The same bounded workspace posture with fewer interruptions for actions that pass automatic review |
| **Full access** | `danger-full-access` | `never` / `none` | `enabled` | Trusted local work that needs high autonomy |
| **Custom** | Named profile | Named profile | Named profile | A repeatable policy for a workspace, team, automation, or integration |

Full access is still subject to hard guardrails, protected operating-system
paths, administrator policy, explicit export/location consent, and any other
non-bypassable safety boundary. It is not a promise that every possible native
operation will be allowed.

## Select a profile

### Desktop tasks

1. Open the main task composer.
2. Open the **Permission access mode** selector.
3. Choose **Ask for approval**, **Approve for me**, **Full access**, or a saved custom profile.
4. Send the task or follow-up.

The selector applies to the next task or follow-up that supports execution. The
selected profile is persisted in task metadata so resuming the task does not
silently adopt a broader profile later.

### Defaults and custom profiles

Open **Settings → System & Security → Permissions** to:

- choose the default profile for newly created tasks;
- create, edit, validate, or remove custom profiles;
- review profile rules and workspace-local permission rules; and
- see the effective profile used by the runtime.

Custom profiles are stored through CoWork's encrypted settings store. The
current CoWork implementation does not treat a plain-text `config.toml` as the
authority for access profiles. The visible **Custom** choice is the UI for the
same named-profile concept, with settings validated before they are persisted.

Agents Hub environments also have an **Access profile** field. It controls the
profile inherited by managed sessions; command tools, filesystem access,
network access, and approvals follow that profile.

### Access profiles versus execution modes

An access profile answers **what the task may do**. The separate task modes and
toggles answer **how the task runs**. `Chat`, `Plan`, `Analyze`, `Execute`, and
`Verified` remain execution modes, while `Collaborative`, `Multi-LLM`, and
`Check-ins` remain orchestration or interaction choices. The legacy
`Autonomous` toggle can reduce optional pauses and enable eligible automatic
approval behavior, but it cannot add a tool, widen a profile boundary, defeat
an explicit deny, or bypass a hard guardrail. Choose **Full access** explicitly
when a trusted task genuinely needs the full-access profile.

## What a profile controls

An access profile has these independent dimensions:

| Field | Values | Meaning |
|---|---|---|
| `sandbox` | `read-only`, `workspace-write`, `danger-full-access` | Process/filesystem boundary applied to spawned commands and code execution |
| `approval` | `untrusted`, `on-request`, `never` | Baseline approval posture; hard denials remain hard |
| `reviewer` | `user`, `auto-review`, `none` | Whether a user or automatic safety reviewer handles approval decisions |
| `network` | `disabled`, `on-request`, `enabled` | Coarse network capability and approval posture |
| `workspaceRoots` | Relative or absolute paths | Additional roots that the profile may reach |
| `filesystemRules` | `read`, `write`, `deny` | Deny-first path rules; `write` includes reads but never deletes |
| `domainRules` | `allow` or `deny` patterns | Built-in network-tool destination boundaries |
| `extends` | Another profile id | Inherit a profile and narrow it without widening the parent |

The profile also determines whether command tools can be materialized for the
task. A legacy `shellAccess: false` value can preserve an old denial, but new
profiles should not use a shell boolean as a second policy dimension.

## Custom profile example

The following example keeps the normal workspace-write sandbox, limits network
tools to a documentation domain, permits writes under `src`, makes `docs`
read-only, and denies a sensitive directory:

```json
{
  "id": "review-repository",
  "label": "Review repository",
  "description": "Read the repository, update source files, and use approved docs APIs.",
  "sandbox": "workspace-write",
  "approval": "on-request",
  "reviewer": "user",
  "network": "on-request",
  "filesystemRules": [
    { "path": "docs", "access": "read" },
    { "path": "src", "access": "write" },
    { "path": ".env", "access": "deny" }
  ],
  "domainRules": [
    { "pattern": "docs.example.com", "access": "allow" },
    { "pattern": "*.example.com", "access": "deny" }
  ]
}
```

Paths that are not absolute are resolved relative to the active workspace.
`workspaceRoots` adds approved roots; it does not turn arbitrary paths into
approved paths. Filesystem rules are evaluated with component-aware path
matching after existing prefixes and symlinks are canonicalized.

Domain patterns are normalized to lowercase hostnames:

- `example.com` matches that exact hostname;
- `*.example.com` matches subdomains, not the apex;
- `**.example.com` matches the apex and descendants; and
- `*` is unrestricted for that domain-rule dimension.

Deny rules win over allow rules. An allowlist is a boundary: if an effective
profile has positive domain rules, a destination outside that allowlist is not
made available by a later approval or a legacy mode.

## Inheritance and narrowing

Custom profiles may use `extends` to share a baseline. Validation rejects:

- empty, duplicate, or built-in-colliding ids;
- missing parents and inheritance cycles;
- a child sandbox, approval, reviewer, or network setting that is broader than
  its parent;
- child filesystem roots/rules outside the parent's effective scope; and
- child domain allows that escape a parent's allowlist or remove a parent deny.

Inherited deny rules remain in the effective profile. A child can replace or
narrow positive grants, but it cannot use inheritance to recover access that a
parent denied.

This same ceiling applies to child tasks: a delegated task may choose a
strictly narrower profile, but it cannot widen the parent task's sandbox,
approval behavior, network, filesystem, or domain scope.

## Resolution and compatibility

Profile resolution happens before individual tool approvals:

1. An explicit task `accessProfileId` wins.
2. A configured `defaultAccessProfileId` is attached to new tasks that do not
   specify a profile or a legacy permission override.
3. If no named profile is configured, the compatibility mapping uses the
   existing permission settings and defaults.
4. Existing persisted tasks that have only legacy `permissionMode` or
   `shellAccess` keep their prior behavior until the user explicitly selects a
   profile.

The profile is then applied to the workspace view used by that task. The
per-request permission engine still evaluates hard task restrictions,
guardrails, workspace capabilities, explicit rules, and approval defaults.
The later stages cannot widen an earlier profile boundary.

Administrator policy can constrain the result. In particular, administrators
can restrict legacy permission-mode mappings, allowed sandbox types, the
requirement for sandboxed command execution, and shell egress. A scoped custom
profile cannot use an unsandboxed process path that would bypass its filesystem
or domain rules; CoWork constrains it to a representable sandbox instead.

If a named profile is missing, malformed, cyclic, or cannot be represented by
the selected execution backend, CoWork uses an unavailable read-only profile:

- filesystem access is limited to safe reads;
- command tools and network access are unavailable;
- the task pauses with a user-action state and an
  `access_profile_unavailable` reason; and
- no approval prompt can turn that unavailable profile into a broader one.

## Filesystem behavior

Profile filesystem access is evaluated separately for `read`, `write`, and
`delete`:

- a `write` rule grants read and write, not delete;
- an explicit `deny` always wins;
- profile rules are checked before legacy `allowedPaths` and unrestricted-file
  flags for profiled tasks;
- macOS and Windows operating-system mutation roots remain protected;
- `..` traversal, symlink escapes, macOS `/private` aliases, and non-existent
  file suffixes are canonicalized before the decision; and
- a plain path outside the workspace may receive a one-shot external-file
  approval only when no finite profile filesystem scope covers the task.

A finite profile scope is a hard boundary. The operator cannot use an external
file approval, a session “Approve all” shortcut, or a legacy permission mode to
expand it. Temporary-workspace scratch-file compatibility is retained only for
unprofiled legacy tasks.

## Network and command behavior

Built-in browser, web, and HTTP tools evaluate profile network and domain rules
in-process. Network `on-request` means the tool may reach an approval boundary;
it does not mean every request is automatically allowed. `data_export` remains
an explicit approval class even in high-autonomy profiles, and location access
always uses a separate operating-system consent flow.

Arbitrary subprocess and code-execution networking is stricter. The native
macOS and Docker sandbox boundaries provide coarse network isolation, not a
domain-aware proxy. Therefore a profile with domain-scoped network rules cannot
run arbitrary shell/code networking unless a domain-aware proxy exists; the
request fails closed. Full-profile shell egress also depends on the coarse
administrator shell-network gate.

Terminal tabs use the same profile boundary as command tools. A profile that
does not permit command tools cannot open a new terminal tab. Existing tabs are
revalidated when the profile changes, and a downgrade prevents further use.

## Surfaces and inheritance

| Surface | Profile contract |
|---|---|
| Desktop composer | Shows the four access choices and carries the selected id with the task |
| CLI | `cowork run "task" --access-profile <id>` uses the same resolver; `--permission-mode` and `--shell` are compatibility inputs |
| Remote Control Plane | Sends the requested profile id to the target node, where it is resolved and enforced; local credentials/cookies are not transferred |
| Managed Agents | `ManagedEnvironment.config.accessProfileId` is the canonical environment setting; `enableShell` is legacy compatibility |
| Task automations and cron | New jobs inherit an explicit profile and cannot widen it through a step or trigger setting |
| Agent Teams and child tasks | Child profiles are capped by the parent profile |
| Side Chat | Does not expose command tools and cannot widen the inherited profile |
| Browser, connector, native, and device tools | Use the same profile, admin policy, and hard guardrails before execution |
| Heartbeat/Dreaming | Background memory reads use a profile-derived read guard; unavailable or denied profiles skip analysis rather than bypassing the boundary |

## Migration from the shell toggle

The old shell switch was too narrow to describe the real access decision. The
current migration behavior is:

- new desktop tasks use the configured named profile;
- the main UI no longer presents a shell enable/disable control;
- old task records and integrations may still carry `shellAccess`,
  `enableShell`, `defaultShellEnabled`, or legacy permission modes;
- those fields are read only at compatibility boundaries and do not override a
  selected named profile;
- the CLI `--shell` flag remains a compatibility alias for the bounded
  `ask_for_approval` profile, not a new unrestricted switch; and
- managed environments should be edited to set `accessProfileId` explicitly.

Do not edit the database to migrate a task. Choose a profile in the task
selector, update the default in Settings, or update the managed environment
through its supported UI/API surface.

## Implementation map

The shared policy contract lives in:

- `src/shared/access-profiles.ts` — profile types, built-ins, inheritance, and
  privilege comparison;
- `src/electron/security/access-profile-resolver.ts` — resolution,
  compatibility mapping, admin constraints, and workspace projection;
- `src/electron/security/access-profile-paths.ts` — canonical path and
  profile-filesystem evaluation;
- `src/electron/security/permission-settings-manager.ts` — validated encrypted
  persistence for defaults and custom profiles;
- `src/electron/agent/runtime/PermissionEngine.ts` — per-request hard-stop and
  approval decisions; and
- `src/electron/agent/tools/shell-tools.ts` and the tool registry — command
  availability and sandbox/network enforcement.

Useful verification commands:

```bash
npx vitest run src/shared/__tests__/access-profiles.test.ts src/electron/security/__tests__/access-profile-resolver.test.ts src/electron/security/__tests__/access-profile-paths.test.ts
npx vitest run tests/tools/shell-tools.test.ts src/electron/agent/runtime/__tests__/PermissionEngine.test.ts
npm run type-check
npm run build:electron
npm run build:daemon
npm run build:react
```

## Related documentation

- [Permission System](permission-system.md) — request evaluation and rule precedence
- [Security Model](security/security-model.md) — defense layers and hard boundaries
- [Security Configuration](security/configuration-guide.md) — operator settings
- [Security Guide](security-guide.md) — practical safe-operation guidance
- [CoWork OS CLI](cli.md) — local and remote profile selection
- [Managed Agents](managed-agents.md) — managed environment inheritance
- [Task Automations](task-automations.md) — unattended profile behavior
- [Terminal Tabs](terminal-tabs.md) — interactive command sessions
- [Remote Access](remote-access.md) — target-node enforcement

---
