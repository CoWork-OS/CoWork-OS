# Release Notes 0.5.40

This page summarizes the product and engineering changes included in `0.5.40`, following `v0.5.35`.

## Summary

Release `0.5.40` is a broad workflow release. It adds Chronicle desktop screen context, reframes the always-on learning system as Workflow Intelligence, introduces routines as the primary saved-automation surface, expands Inbox Agent into a more complete email workspace, adds AgentMail support, improves Managed Agents, and upgrades output artifacts with rich PPTX previews and source-first LaTeX/PDF workflows. It also adds multi-provider image generation, new bundled skills, safer computer-use defaults, and several mailbox, image, runtime, and developer-startup fixes.

## New Features

- **Chronicle Desktop Research Preview**: opt-in desktop screen context resolves vague on-screen references such as `this`, `the right side`, or `the latest draft`, with Memory Hub controls, pause/resume, per-task toggles, observation management, and promoted `screen_context` evidence. [Learn more](chronicle.md)
- **Workflow Intelligence**: the former Subconscious product framing is now Memory + Heartbeat + internal Reflection + reviewable Suggestions, with user response feedback from act, edit, snooze, dismiss, and ignore behavior. [Learn more](workflow-intelligence.md)
- **Routines**: saved automations now have a first-class product surface with schedule, API, connector, channel, mailbox, GitHub, and manual triggers; run history; outputs; approval policy; connector allowlists; and token regeneration. [Learn more](core-automation.md)
- **AgentMail integration**: CoWork can configure AgentMail settings, pods, workspace bindings, inboxes, domains, allow/block lists, API keys, and realtime mailbox streaming.
- **Expanded Inbox Agent**: Inbox Agent now includes Classic and Today modes, Mailbox Ask, attachment-aware search, manual reply/reply-all/forward, editable AI drafts, sender cleanup, commitments, provider-backed read/unread, and Gmail forwarding automations. [Learn more](inbox-agent.md)
- **Managed Agents Hub improvements**: reusable managed agents now include templates, conversions from agent roles or automation profiles, governance settings, runtime tool catalogs, routines, insights, audit history, Slack health, workpapers, and image-generation profiles.
- **Multi-provider image generation**: image settings now support OpenAI, OpenAI Codex/OAuth, Azure, OpenRouter, and Gemini paths with default/backup providers, model selection, per-provider timeouts, and provider-attempt progress.
- **Rich PPTX previews**: generated PowerPoint artifacts open in an in-app viewer with slide thumbnails, navigation, zoom, extracted text, and speaker notes. Slide images are best-effort via local `soffice` and `pdftoppm`.
- **LaTeX/PDF artifact workflow**: explicit LaTeX/TikZ tasks can write `.tex`, compile with an installed TeX engine, and show paired source/PDF artifacts in the task UI. [Learn more](use-cases.md#16-latex-paper-with-compiled-pdf)
- **Bundled `kami` skill**: a new editorial-document workflow for resumes, one-pagers, white papers, letters, portfolios, diagrams, and slide decks. [Learn more](skills/kami.md)
- **Bundled `taste-skill` workflow**: CoWork now ships a high-agency frontend design skill with stricter layout, typography, motion, dependency, and responsive-implementation rules.
- **Additional bundled workflow resources**: new architecture-diagram, GSAP, Hyperframes, Hyperframes CLI, and Hyperframes registry skill resources are included.

## Enhancements

- **Built-in skills count**: docs and product copy now reflect 140 built-in skills.
- **Computer use runtime**: macOS desktop control now uses helper-targeted Accessibility and Screen Recording permissions, screenshot-relative coordinates, fresh `captureId` validation, single-session sequential execution, Esc abort, and normalized tools such as `screenshot`, `click`, `type_text`, and `keypress`. [Learn more](computer-use.md)
- **Chronicle and memory integration**: promoted screen observations stay provenance-rich, screen-derived text is marked untrusted, and optional linked `screen_context` memories flow through the normal memory service instead of creating a parallel memory lane. [Learn more](workspace-memory-flow.md)
- **Automation onboarding**: Getting Started, Core Automation, Mission Control, and related docs now guide users toward routines first, with Scheduled Tasks, Webhooks, and Event Triggers documented as lower-level engines.
- **Artifact surfaces**: completion cards, timeline details, Files, presentation previews, markdown image previews, HTML previews, video previews, and LaTeX source/PDF pairs share richer output metadata.
- **Settings surfaces**: AI model settings now separate LLM, Image, Video, and Search configuration; Automations emphasizes routines; Chronicle appears in Memory Hub and Tools; and AgentMail settings appear under integrations.
- **Runtime visibility and tool policy**: executor visibility, destination hints, task pause messaging, awaiting-input messages, screen-context routing, private workspace path exclusions, and native-GUI tool policy were refined.
- **LLM/provider behavior**: Azure OpenAI streaming, streamed tool calls, Responses API fallback handling, provider factory behavior, and reasoning-effort metadata were tightened.
- **Developer and packaging docs**: build, setup, QA, skills-check, format, lint, type-check, dev logging, Kami validation, PPTX preview dependencies, and LaTeX compile troubleshooting guidance were expanded.
- **Packaging**: packaged builds now include skill asset folders, computer-use helper resources, and refreshed app icons from `build/icon.png` and `build/icon.ico`. macOS fallback builds can now be produced explicitly with `npm run package:mac:unsigned`, which disables accidental Developer ID auto-discovery.

## Fixes

- **Mailbox autosync**: autosync is scoped to the singleton IPC service instead of starting from every `MailboxService` instance.
- **Mailbox search upgrades**: mailbox FTS is backfilled before being trusted so upgraded users can still search existing synced mail.
- **Attachment filtering**: attachment-content filters now work with decrypted extracted attachment text.
- **Welcome suggestions**: suggestions are marked acted-on only after prompt submission, not when a suggestion is merely copied into the composer.
- **Image generation dedupe**: duplicate protection now blocks identical duplicate requests without preventing distinct image generations in the same task.
- **OpenAI OAuth images**: OAuth image generation now uses the derived Codex API key path correctly.
- **Managed routines**: managed routine lifecycle changes now sync through the routines service.
- **Hook mappings**: same-path mapping tokens are scoped to the matched source.
- **Workflow Intelligence noise control**: reflection evidence gating, restart/catch-up behavior, and low-signal heartbeat filtering reduce duplicate or noisy proactive work.
- **Dev startup**: `npm run dev:start` can repair a missing Electron binary by running native driver setup before launching.
- **Renderer reliability**: sidebar navigation, session filters, initial session loading, task replay snapshots, task pause banners, notification panels, Inbox Agent UI, voice input, and task-event visibility were refined and covered by tests.

## Upgrade Notes

- Chronicle is opt-in, desktop-only, and should be paused or disabled when viewing sensitive or untrusted screen content.
- Screen-derived Chronicle text is untrusted context. Prefer direct source tools when CoWork can read the actual file, URL, PR, or thread.
- Computer-use permissions now target the bundled helper path shown in Settings, not Terminal or the main app alone.
- PPTX slide thumbnails require local `soffice` and `pdftoppm`; without them, CoWork still shows extracted text and speaker notes.
- LaTeX/PDF compilation requires an installed TeX engine such as `tectonic`, `latexmk`, `xelatex`, `lualatex`, or `pdflatex`; failed compiles keep the editable `.tex` source.
- Routines are now the preferred saved-automation surface. Use Scheduled Tasks, Webhooks, and Event Triggers directly only when you need the lower-level engine.
- Inbox Agent has a replacement-client foundation, but native new-mail compose, provider draft save/update, attachment upload, full outgoing queue draining, Microsoft Graph mail execution, folder/label navigation, and notification preferences remain future work.
- The bundled Kami port ships open English font assets, but it does not ship the proprietary Chinese serif font used by upstream Kami.
- macOS release artifacts are still distributed as unsigned fallback builds unless a release maintainer supplies an explicit Developer ID signing identity in `.env.mac`; first launch may require **Open Anyway** in System Settings.

## References

- [Changelog](changelog.md) - full version history
- [Chronicle](chronicle.md) - desktop screen context
- [Workflow Intelligence](workflow-intelligence.md) - memory, heartbeat, reflection, suggestions, and feedback learning
- [Inbox Agent](inbox-agent.md) - email workspace, Mailbox Ask, attachments, compose, and forwarding
- [Core Automation](core-automation.md) - routines and automation runtime boundaries
- [Computer use](computer-use.md) - macOS desktop GUI control
- [Kami Skill](skills/kami.md) - editorial documents and slide decks

This page is the canonical high-level summary for the changes included in `0.5.40`.
