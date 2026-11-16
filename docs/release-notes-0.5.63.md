# Release Notes 0.5.63

Release `0.5.63`, 2026-11-15.

CoWork 0.5.63 is mostly a reliability release. Twenty-one rounds of click-through testing of the desktop app fixed dozens of bugs in follow-ups, retries, waiting sessions, Settings and the conversation view, and a security assessment closed 26 findings. It also lets you bring back archived sessions, adds an opt-in Camofox browser with cookies.txt import, makes the browser app's tab show when a task needs you, and gives memory a better choice of what to bring into each task.

## Highlights

- **Archived sessions come back** — Choose **Archived** in the sidebar search filter to find an archived session and restore it, and use **Undo** right after archiving. Sessions with running work can no longer be archived out of sight. See [Getting Started](getting-started.md#orientation-where-the-new-product-surfaces-live).
- **Camofox browser and cookies.txt (opt-in)** — Drive a Camofox server on your Mac through CoWork's network-policy proxy, and import Netscape `cookies.txt` files into the encrypted vault. Saved cookies load into a single task's identity only after you approve. Setup needs a small CoWork plugin for Camofox, shown in **Settings > Browser > Camofox**. See [Camofox Browser](browser-workbench.md#camofox-browser).
- **Browser app tells you when a task needs you** — The tab title counts sessions waiting on you and the icon gets a dot. Opt-in browser notifications mirror the desktop alerts while you are away from the tab. See [When a task needs you](browser-preview.md#when-a-task-needs-you).
- **Memory that fits the task** — Task prompts carry the saved notes most relevant to your request instead of whatever comes first in the file, and the framing before planning sees the same memory. Dreaming can propose lessons from checks that actually passed, always for your review. See [Selective memory recall](selective-memory-recall.md) and [Dreaming](dreaming.md#lessons-from-execution).
- **New model options** — GPT-6.1 Terra is in the OpenAI, ChatGPT subscription, OpenRouter, OpenCode and Azure routes, and first-run setup finds a running LM Studio server. See [LM Studio (Local)](providers.md#lm-studio-local).
- **Fixes from live sweeps** — Follow-ups sent during a provider retry finish, a key change in Settings reaches open sessions, sessions waiting for your answer no longer resume on their own after a restart, code keeps its indentation, rename and other text prompts work, custom skills are saved, and Cloudflare checks pass in the in-app browser. See the [changelog](changelog.md) for the full list.
- **Security hardening** — 26 assessment findings are fixed across sandbox setup, file operations, email transport, approvals, browser access and task ownership. Regex "matches" conditions in triggers and routines can no longer freeze the app, and trigger edits from the app window are validated.
- **Smaller app surface** — 183 unused calls between the app window and the main process, dead code and duplicate root documents are removed. Nothing you can click changes.

See the [changelog](changelog.md) for every change in this release.

## Upgrade notes

- **SMTP needs verified TLS.** An email account that sends over SMTP without verified TLS or STARTTLS now fails instead of signing in over an unprotected connection. (#878)
- **Recurring approvals ask once more.** Standing "always allow" grants made before this release use an older fingerprint and need a fresh decision. (#878)
- **No-network commands on macOS can't start servers.** A command that runs without network access can no longer open a listening port, including a loopback dev server. Give the task and profile network access for dev servers; outbound loopback clients still work. See [Network and command behavior](access-profiles.md#network-and-command-behavior). (#878)
- **Stricter file and install paths.** Affected file operations refuse symlinks inside the workspace, read-only Git runs without configured helpers, and URL installs and browser diagnostics fail when an environment proxy can't pin the destination. (#878)
- **Some "matches" patterns are refused on save.** Trigger and routine patterns that don't compile or can take too long are rejected when saved. Triggers and routines saved earlier keep running under the new time limits. Text past the first 20,000 characters of a field is no longer searched, and a routine run stops after 500 ms of total "matches" time. (#866, #881)
- **Running sessions can't be archived.** Stop the work first, or archive once it finishes. (#875)
- **Camofox is opt-in and needs a plugin.** Stock Camofox fails CoWork's loopback check; add the documented CoWork plugin. Browser notifications in the browser app are opt-in per browser and need HTTPS or localhost. (#856, #892)
- **Skills created in Settings before this release** were saved as `skills/.json` and are not recovered automatically; create them again. (#863)
- **The Chinese README moved** to `i18n/README.zh-CN.md`. Links to the old root path need updating. The published 0.5.61 and 0.5.62 npm pages keep the Chinese README; this version shows the English one. (#817)
- **Local `http://localhost/` previews on the default port now need approval** in the in-app browser, like any other port. (#815)

## Release acceptance

See [0.5.63 validation](release-validation-0.5.63.md) for the candidate revision,
commands, observed results and remaining blockers. A successful build is not a
publication or an end-to-end provider test. Publish only the reviewed candidate
whose release gates have passed.
