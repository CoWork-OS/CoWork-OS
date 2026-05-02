# Release Notes 0.5.43

Release `0.5.43` ships the Ask Inbox sidebar workflow, richer composer routing, a new bundled React guidance skill, and stronger release packaging validation across macOS, Windows, and Linux artifacts.

## Highlights

- **Ask Inbox sidebar chat**: Inbox Agent now includes a right-sidebar Ask Inbox tab with live mailbox-agent progress, final answers, matched email evidence, and a pinned composer for follow-up questions.
- **Hybrid mailbox retrieval**: Ask Inbox plans broad searches across local FTS, semantic mailbox embeddings, provider-native search, and attachment text before reading evidence and answering.
- **Composer integration mentions**: the message box `@` picker now groups Agents, configured Integrations, and Files. Integration chips persist in prompts and task history while passing soft runtime guidance through `integrationMentions`.
- **`@Inbox` routing**: `@Inbox` and `@inbox ...` prompts from the main composer now open Inbox Agent and send the remaining query through Ask Inbox.
- **React best-practices skill**: the bundled skill set now includes `react-best-practices` for React and Next.js implementation, review, refactor, data-fetching, bundle-size, and rendering-performance work.

## Release Validation

- **macOS DMG smoke tests**: release packaging now validates updater metadata, mounts the versioned DMG, checks the embedded `.app` bundle version, and verifies the app executable.
- **Windows installer smoke tests**: the Windows workflow now uses the shared smoke runner to validate updater metadata, install the versioned `.exe` silently, check the installed app version, launch it briefly, and uninstall it.
- **Linux server smoke tests**: the release workflow continues to build the Linux x64 server tarball, verify its checksum, and boot-smoke `coworkd-node` against `/health` before publishing artifacts.

## Fixes

- Fixed duplicate `@` rendering and the React `removeChild` crash when deleting a raw mention or integration chip.
- Cleared stale Google Workspace refresh tokens after refresh bad-request failures, including credential or scope changes before reconnect.
- Normalized long Azure OpenAI Responses fallback tool-call ids so integration-heavy turns no longer fail on `call_id` length limits.

