# Task computers

An opt-in task computer runs commands, code, text-file tools, a browser and desktop
input in one Linux environment. CoWork's model and task orchestration stay on the
host. Connected service actions and CoWork memory retain their own permissions;
this feature does not put the entire agent process or every connector in a sandbox.

## Choose a computer

In **Build**, choose **Computer → Fresh Linux computer** or **Fresh Cua Space**.
Expand **Files for this computer** to select input and result paths, one per line.
Inputs are copied from the selected workspace. Result paths are relative to the
guest work folder and are published under `artifacts/computers/<computer-id>/`.
Build Compare retains its existing worktree execution mode.
Fresh computers require an Access profile with network enabled and no domain
rules. Build displays incompatible profiles before starting; it does not change
your access choice. Guest builds verify their pages with a guest-loopback server
and guest browser rather than the host page-preview tool.

For a bot, select **Works on → Its own desktop**, then **Computer execution**:

- **Desktop tools only** preserves the existing behavior.
- **All work in its Docker / Podman computer** enables unified guest routing.
- **All work in a Cua Space** uses the installed Cua integration.

Choose **Across this bot's tasks** for persistent files/sign-ins, or **Fresh computer
for each task** for disposable work. An existing Cua Space is always retained.
Existing bots and tasks keep their current routes unless this mode is selected.

The task API accepts `agentConfig.executionEnvironment`; bot create/update accepts
`executionEnvironment`. Both use this shape:

```json
{
  "backend": "bot-desktop",
  "lifetime": "task",
  "inputPaths": ["data/input.csv"],
  "outputPaths": ["result.csv"]
}
```

`backend` is `bot-desktop` or `cua`; `lifetime` is `task` or `persistent`.
Cua additionally accepts an existing `space`, an `image`, and placement `on` set
to `local` or `host:<computer>`. Hosted cloud provisioning and non-Linux guests are
not qualified by this implementation.

## Requirements and scope

The built-in backend needs a running Docker or Podman engine. It reuses the bot
desktop image, unprivileged user, network enforcement, resource limits and
loopback-only viewer. Its work folder is `/home/bot/work`. Existing SSH-host and
shared-desktop settings apply. Placement is pinned when the task allocates its
computer. At most two dedicated computers start concurrently by default;
`COWORK_MAX_TASK_COMPUTERS=1..8` changes the local limit.

The Cua backend needs `cua mcp`, `cua sandbox exec -i` (Cua 0.7+), and a Linux
Space with Python, Chromium, X11 capture/input tools, and Node for JavaScript.
Desktop capture supports `scrot` or ImageMagick's `import`; input uses `xdotool`.
It reuses Cua's sign-in; no token or host environment is forwarded to the guest.
Lifecycle uses a private MCP connection; command/file payloads use interactive
CLI transport, avoiding `space_bash`'s display-output truncation. Cua's account,
runtime and platform prerequisites remain external requirements. Cua live
acceptance must be performed on the deployment being used.

Supported guest tools include commands, Python/JavaScript/shell code, background
process output/stop, text-file read/write/edit, basic file discovery, bounded
browser navigation/snapshots/input/evaluation/screenshots/tabs, and `desktop_*`
capture/input. Advanced Browser Workbench features, native host integrations,
legacy desktop teaching, document-specific tools and unqualified MCP tools are
unavailable in this mode. Unsupported calls fail rather than execute locally.
Code can create other file formats inside the guest; delivery still requires an
explicit export. Browser and desktop tool success is not domain verification.

The guest browser uses guest-loopback CDP, with no debugging port published to
the host. A server started with `--bind 127.0.0.1` inside the guest is reachable by
that browser, not by the host's browser. Accounts and cookies are not imported
automatically. The minimal browser backend does not reproduce every local
Browser Workbench option; use supported parameters and inspect the result.

## Authority, results and recovery

The host persists the computer ID, generation, task/workspace ownership, placement,
pending operation, process handles and transfer receipts in the task's existing
agent configuration. Renderer configuration cannot supply this binding.
Descendants inherit the selected environment constraints. Host-only actions remain
unavailable, even if explicitly named after being hidden from the catalog.

Workspace/access-profile checks and the existing tool permission pipeline still
apply before dispatch. Domain-scoped and on-request network policies refuse this
coarse guest execution mode. Administrator subprocess-network restrictions also
apply. Offline execution requires a built-in bot desktop configured **No network**;
Cua is refused when it cannot enforce the active policy. The **Works on** setting
and inherited limits can narrow access after allocation. A disposable computer
does not authorize external messages, purchases or other connected-service writes.

Imports and exports use the existing SPACE transfer validation: regular files,
no private configuration or symlink paths, up to 64 selected paths, 2 MiB per file
and an 8 MiB input-manifest limit. Result publication is create-only, permission
checked, fsynced and read back. Byte equality verifies transfer, not semantic
correctness. Interrupted publication retains its file and expected hash.

The task's computer panel shows identity, lifetime, state and a preview. **Take
over** blocks new input from every task sharing that computer and drains/cancels
in-flight calls before opening an interactive viewer. Previously started
background jobs are shown as potentially still running. Hand-back through either
the panel or the takeover question closes CoWork's interactive viewer before
agent input resumes; fresh state is required before acting again. Cua's external
interactive viewer requires takeover and is managed by Cua; close it before
handing control back. These local leases do not fence other Cua clients or users.

The `computer_environment` tool supports `status`, `reconcile`, `import`, `export`,
`screenshot` and `finish`. An interrupted response retains the operation ID and
blocks new work. Reconciliation reads its guest completion receipt; it never
replays the command and does not claim independent verification of external
effects. An absent receipt stays unknown. Ambiguous Cua creation uses the original
name for lookup and does not issue another create.

Approval waits and assistant-turn boundaries retain the computer. Final completion
waits for unresolved operations and selected result exports. Task-owned disposable
resources are removed only after outputs publish; borrowed/persistent computers
are retained after their configured results publish. Delegated tasks share the
ancestor's work folder; the ancestor publishes its configured results when all
delegated work has finished. Missing output or failed cleanup leaves the task paused with its
recovery state. Use **Reconcile computer**, inspect the outcome, then resume the
task. Cancellation is not rollback of external effects. Recovery is driven by the
task or an explicit reconciliation; it is not an always-running orphan collector.

## Validation

```sh
npm run qa:computer-environments
npm run qa:computer-environments:smoke
npm run qa:computer-environments:cua
npm run qa:application-execution
npm run type-check
npm run build:daemon
npm run build:react
```

The live smoke uses two real Linux containers and synthetic files. It checks
separate files, imports, command readback, a web server bound to guest
`127.0.0.1`, browser click/readback, screenshots, takeover, artifact publication
and confirmed container/storage deletion. It also checks that startup cleanup in
another profile preserves the live browser and server. It removes only its own resources.
Set `COWORK_QA_CONTAINER_RUNTIME=podman` for an explicit Podman run; the smoke
will not fall back to Docker. The Cua smoke creates its own local Linux Space,
checks attachment, commands, files, browser interaction, desktop capture, takeover,
exports and deletion, and removes only its own resources. It requires a working
`cua` CLI and local runtime. Runtime selection remains Cua's decision: a successful
container run does not establish VM or gVisor isolation. Fixture tests and protocol
mocks do not establish live operation, macOS/Windows guest support, or packaged-app
acceptance.

For native Electron acceptance, run `npm run dev` with an isolated synthetic
profile and a guest web server explicitly bound to `127.0.0.1`. Open the desktop
before takeover and confirm clicks have no effect. Take over, reopen the viewer,
and confirm a click changes the guest page. Check both **Hand back** and the
takeover question's **Done** submission: each must close the interactive viewer
before the next agent browser action succeeds. Complete a follow-up and verify
the computer becomes released, selected files appear as host artifacts with
matching hashes, and the owned container and private storage are gone. A failed
export or unresolved operation must leave completion paused for recovery.

Startup cleanup stops only containers labelled for the current profile. Legacy
containers without a profile label are left untouched; inspect and stop those
explicitly rather than guessing their owner.
