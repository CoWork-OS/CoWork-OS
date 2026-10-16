# SPACE sandbox (opt-in pilot)

SPACE runs selected shell, Python, and JavaScript jobs on an operator-managed
Linux sandbox server. CoWork's models, approvals, workspace file tools, and
local application integrations continue to run through their existing routes.
`auto` never selects SPACE, and a failed SPACE invocation never falls back to
local execution.

## Operator setup

Deploy [Perplexity SPACE](https://github.com/perplexityai/SPACE) on a suitable
Linux/KVM host. The documented upstream local setup needs Linux x86_64, KVM,
tun/loop devices, btrfs, and privileged Docker; it does not run directly on
macOS. CoWork's desktop and Node host can connect over HTTPS.

This pilot targets the SPACE 0.8 API shapes inspected at source revision
`9d6f4f65d59f409e1d96b261e04e924bb897fb1b`. The network-policy override,
network-policy readback, and idle-delete settings include **experimental upstream
contracts**. Qualify your deployment before enabling it; unsupported or permissive
network-policy responses refuse execution before input upload. Successful desired
policy readback is a configuration check, not independent proof of host isolation.

Publish a credential-free template with `python3`, `/bin/sh`, a writable
`/workspace`, and `node` if JavaScript jobs are needed. Prefer a digest-pinned
template. Do not configure additive egress profiles or credential rules for this
pilot: the effective policy must be `v1`, default deny, with no allowed
destinations, credential rules, or TLS exemptions. Template startup must also
be safe without user input.

Set these on the **CoWork host process**, before starting the desktop app or daemon:

```sh
export COWORK_SPACE_API_URL=https://space-api.example.com
export COWORK_SPACE_DATA_PLANE_URL=https://space-streams.example.com
# Supply COWORK_SPACE_API_TOKEN through your host's secret management.
```

URLs accept an origin or `/api` base path. HTTP is accepted only for loopback
development. Connections bypass environment proxy settings and never follow
redirects. The management token stays on the host; attachment requests use the
session token only at the configured data-plane origin and exact session path.
No token is stored in workspace settings or the recovery journal.

In the profile's `policies.json`, explicitly include `"space"` in
`runtime.allowedSandboxTypes`, retaining the other backends your policy permits.
The default list excludes SPACE. Normal administrator policy-relaxation approval
still applies when updating through the app. Do not enable unsandboxed fallback
to work around a connection or policy error.

## Workspace selection

Select a saved workspace. Open **Settings → System & Security → SPACE sandbox**,
enable **Use SPACE**, choose the published template, and enter input and output
files, one workspace-relative path per line. Save the selection. Disable it and
save to return to local automatic selection. Named access profiles still decide
whether command tools and local file access are allowed; even Full access keeps
an explicit SPACE selection remote.

The workspace permission fields can also be supplied to the desktop workspace
create/update API:

```json
{
  "sandboxType": "space",
  "spaceConfig": {
    "template": "cowork-offline:latest",
    "inputPaths": ["data/input.csv"],
    "outputPaths": ["result.csv"]
  }
}
```

This is not a `workspace.create` Control Plane parameter: that endpoint retains
its existing default-permissions contract. The desktop settings panel uses
`updateWorkspacePermissions` to persist this selection.

## Execution and files

Each invocation creates a fresh VM, waits for lifecycle and process readiness,
checks deny-all egress, transfers only the selected regular files, executes one
command, downloads selected outputs after a successful exit, and confirms
asynchronous VM deletion. Transfers use bounded, base64-encoded commands over the
native command API; no E2B dependency, guest filesystem HTTP API, or host mount is
required. Python and JavaScript source are staged in the guest, not referenced
using a host `/tmp` path.

- At most 64 inputs and 64 outputs; 2 MiB per file and 8 MiB total per direction.
- Traversal, absolute paths, symlinks, directories, private configuration paths
  such as `.git`, `.cowork`, `.env`, and `.ssh`, Windows device names and trailing
  dot/space aliases, and denied profile paths are refused. Source files must stay stable during bounded reads.
- Output parent directories must already exist locally. Outputs must be **new
  files**: CoWork never replaces or deletes existing files. The delete capability
  is not required to publish a new file.
- CoWork validates the complete guest manifest, expected paths, sizes, and
  hashes before publishing. It rechecks current write permissions, uses exclusive
  creation, pins the workspace and output ancestor identities across execution,
  fsyncs, and reads back the saved bytes.
  Guest content remains untrusted; byte equality is not semantic artifact approval.
- Host file tools stay local. Files created with them become available remotely
  only if selected as inputs for a later invocation. A command must produce all
  selected outputs in that invocation; no guest state survives into the next one.
- Remote work has no guest egress, host environment forwarding, persistent shells,
  interactive input, background processes, published dev-server ports, or native
  Mac application control. Explicit requests for unsupported capabilities fail.
- User-command runtime is capped at 300 seconds. Output is bounded using the
  caller's cap (normally 100 KiB per stream); setup/transfer/lifecycle calls have
  their own bounded deadlines, with an overall setup/transfer budget of five
  minutes in addition to the requested command runtime.

The backend always creates writable **guest scratch**, including under a
read-only local profile. That scratch grants no write authority on the host.
Local output publication still requires the active profile's write grant.

## Recovery and cleanup

Private records under `<profile userData>/space-runs/<endpoint-workspace hash>/`
retain creation/deletion keys, sandbox/operation/process IDs, bounded user-command
output, and publication receipts. Intent is saved before mutations. Output is
checkpointed as it arrives (at most once a second; completion saves the rest)
because SPACE streams do not replay. A run that finishes with its VM deleted and
no unknown outcome removes its record; records kept only for inspection (unknown
outcomes, abandoned cleanup) are removed after seven days.

A valid terminal event completes attachment immediately, even if the stream stays
open. A stream closed before that event, sequence gap, `resync_required`, invalid exit identity/status,
or interrupted dispatch is a failed/unknown result, never success or an automatic
command retry. Unknown results preserve partial output. Command and transfer
requests are never replayed, including during restart recovery.

Stop and runtime cancellation abort attachment and request VM deletion using a
separate cleanup deadline. Permission or workspace changes cancel active remote
work as well. Deletion is complete only after its operation succeeds. A failed
delete leaves the journal pending and returns a failure with its recovery record
ID. The next invocation on that adapter first retries the deletion with the same
delete key, and starts new work only once it succeeds.

On the next initialization for the same workspace and endpoints, CoWork reconciles
stale records. It resumes deletion polling or reuses the original delete key
within 24 hours of the first deletion attempt. An old VM with no prior deletion
attempt can still be cleaned up; an expired ambiguous deletion requires inspection.
If creation lost its reply, it recovers the ID with the exact original create
body/key only inside the 24-hour upstream deduplication window, then deletes the
VM without executing anything. Expired unknown creates, endpoint mismatches, and
expired ambiguous deletions are marked `abandoned` for operator inspection and
no longer retried; unreadable records are skipped. Neither blocks new work, and a
transient cleanup failure is retried on the next initialization. Records owned by
a live process are left alone. Recovery is not a cross-host fencing mechanism.

An idle-delete policy of ten minutes is also requested as a server-side backstop;
it does not replace confirmed cleanup. Recovery runs when SPACE is next used,
not as a background monitor. Do not erase pending records to bypass recovery.
After resolving an expired record against the original deployment, an operator
may archive its record manually. Receipts and failed-output diagnostics remain
host-private; inspect them before sharing.

If publication is interrupted, already-written files stay in place and the
journal retains expected hashes and confirmed paths. Recovery never republishes
or deletes those files. Retrying with an existing output name fails safely.
Snapshots or VM deletion do not undo local files or external application effects.

## Validation

```sh
npx vitest run src/electron/agent/sandbox/__tests__/space-client.test.ts \
  src/electron/agent/sandbox/__tests__/space-files.test.ts \
  src/electron/agent/sandbox/__tests__/space-sandbox.test.ts
npm run type-check
```

After operator setup, an explicit live round-trip check is available:

```sh
COWORK_SPACE_TEMPLATE=cowork-offline:latest npm run qa:space:live
```

It uses the configured host credentials and administrator policy, transfers only
synthetic binary input, checks the downloaded bytes and command completion, and
requires confirmed deletion. Failed runs retain their synthetic workspace and
journal for recovery. It does not independently test tenant isolation or egress.

The HTTP integration fixture uses a real loopback server and SSE transport,
executing fixture commands in synthetic guest directories. It verifies file
round trips, token separation, interruption, permission revocation, cancellation,
idempotent reconciliation, and cleanup. It is **not Firecracker isolation proof**.
Before enabling a real deployment, qualify denied egress, host/tenant isolation,
template contents, command cancellation, crash/restart recovery, and confirmed
deletion against that deployment. No hosted account, deployment, or paid resources
are provisioned by the settings panel.
