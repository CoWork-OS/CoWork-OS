# Release Notes 0.5.62

Release candidate: prepared for validation; not yet published.

CoWork 0.5.62 adds opt-in Linux task computers, browser access to the full app,
and 3D generation with Meshy. It also strengthens bot boundaries, interrupted-task
recovery and credential storage. This candidate includes the changes on main
since 0.5.61, not only the task-computer feature.

## Highlights

- **Task computers** — In Build, choose a fresh Linux computer. A bot can keep a
  computer across tasks or use a fresh one each time. Supported commands, code,
  files, browser actions and desktop input run in that same guest. Selected input
  files are copied in; selected results are published back with transfer receipts.
  Take over the desktop, make a change, and hand it back before the agent resumes.
  Docker and Podman use the existing bot-desktop image. Cua uses an installed Cua
  runtime and a Linux Space. See [Task computers](task-computers.md) for supported
  tools, prerequisites, network-policy limits and recovery.
- **Full app in a browser** — Enable **Settings > Web Access > Full app in the
  browser**, or run `cowork web`. One-use sign-in links expire after 90 seconds;
  all browser sessions can be revoked together. Browser sessions gain a host
  folder picker and workspace-local page previews. See [Browser application
  preview](browser-preview.md).
- **3D models with Meshy** — A pinned connector, bundled skill, interactive model
  cards and gallery support generation, texturing, rigging, animation and format
  downloads. Credit-spending tools show their estimated cost in approvals.
  See [3D Models with Meshy](meshy-3d.md).
- **Work that survives interruptions** — Background jobs, queued follow-ups,
  durable event waits, handoff notes and unknown-outcome records improve recovery.
  Recovery does not prove an external action failed and does not authorize
  replaying it. Review the recorded outcome before retrying consequential work.
- **Result review and coordination** — Shared-change coordination, Build Compare,
  revision-aware annotations, connector write previews and receipts, memory-source
  freshness checks and an agent card extend the existing review flows.

## Permissions and security

- Bot work location, access profile, model and task restrictions are checked at
  execution boundaries. Unsupported host tools stay unavailable in a task
  computer. Child tasks inherit the relevant restrictions.
- Only a current, verified user request offers tools that change persona, rules,
  skills or integration setup. Plans, page content, model output and automated
  messages do not grant that authority. Skill proposals still need a human
  decision before being saved.
- Approval requests can wait for 24 hours. Granted approvals retain their shorter
  use window; a waiting decision does not consume the tool's execution timeout.
- Secrets can be referenced through the vault without placing their values in
  ordinary model context. Credential storage uses a data key protected by the OS
  keychain, with asynchronous identity checks and fail-closed handling when the
  original keychain identity cannot be verified. Do not delete profile data to
  resolve a keychain-access problem.

## Upgrade notes

Candidate validation also fixed six release-path problems: desktop capture on Cua
images without `scrot`, partial migration-lock publication during simultaneous
startup, optional SQLite recovery removing Electron's download or setup directory,
the GUI preflight guard blocking a task computer's server command, and startup cleanup interrupting computers owned by another profile, and a failure exit
status from `coworkctl --help`. The host
command guard and explicit policy denials remain enforced.

- Back up the profile before upgrading. Keep the backup and the previous installer
  until the upgraded profile and saved provider sign-ins have been checked.
- Existing tasks and bots retain their execution route unless task-computer
  execution is selected. The model and orchestration still run on the host;
  connected services and memory keep their separate permissions.
- Guest execution cannot enforce domain-scoped or per-request network policies.
  Those combinations are refused. Select a compatible access profile deliberately;
  the app does not widen it automatically.
- Cua requires an installed CLI and a suitable Linux guest. Hosted provisioning,
  macOS/Windows guests and fencing other Cua clients are outside the qualified
  scope. Close Cua's external viewer before handing control back.
- The retired Sora video routes are replaced by an **OpenAI-compatible** video
  provider. Configure its endpoint, model and key explicitly. Other existing
  video providers retain their settings.
- The desktop runtime is Electron 45. The existing minimum-macOS policy remains
  in force. Installer generation and an installed-app walkthrough are separate
  acceptance checks.

## Release acceptance

See [0.5.62 validation](release-validation-0.5.62.md) for the candidate revision,
commands, observed results and remaining blockers. A successful build is not a
publication or an end-to-end provider test. Publish only the reviewed candidate
whose release gates have passed.
