# Release Notes 0.5.41

This page summarizes the product and engineering changes included in `0.5.41`, following `v0.5.40`.

## Summary

Release `0.5.41` is the Everything Workbench release. It turns generated documents, spreadsheets, presentations, web pages, and live browser sessions into first-class in-app work surfaces with compact task cards, sidebar/fullscreen viewers, follow-up composer context, and safer save/preview paths. It also adds structured memory observations, Mission Control intelligence projections, format-aware file previews, visible browser automation, developer log capture, renderer bundle reductions, and broader test coverage across the new artifact surfaces.

## New Features

- **Everything Workbench**: generated documents, spreadsheets, decks, web pages, PDFs, and previews now share a unified artifact model: task-feed card, in-app open action, sidebar workspace, fullscreen mode, follow-up composer, and refresh after the agent finishes edits. [Learn more](everything-workbench.md)
- **Document artifacts**: Word-style outputs now render as compact artifact cards. DOCX opens in an editable document surface with heading/text controls, bold/italic/underline, list controls, save/copy, external app actions, fullscreen mode, model picker, voice input, attachments, and task-follow-up context. DOC, RTF, ODT, OTT, Pages, DOCM, DOTX, and DOTM get preview or native-app handling. [Learn more](document-artifacts.md)
- **Spreadsheet artifacts**: Excel workbooks and CSV/TSV files open in a spreadsheet workbench with sheet tabs, cell/range/row/column selection, formula bar, copy, zoom, add row/column, save, fullscreen mode, model picker, voice input, attachments, and follow-up context. Numbers, Google Sheets shortcuts, ODS, and XLSB are recognized with external-app/folder actions. [Learn more](spreadsheet-artifacts.md)
- **Presentation artifacts**: PPTX outputs open in a resizable presentation viewer with thumbnails, slide navigation, zoom, speaker notes, text-first loading, cached rendered slide images, external actions, fullscreen mode, and follow-up context. Legacy PowerPoint formats are recognized with external-app/folder actions. [Learn more](pptx-generation-and-preview.md)
- **Web page artifacts**: generated `.html` / `.htm` files and built React output entrypoints open in a sandboxed iframe workbench with browser/folder/copy actions and follow-up context. React-style source projects without build output now show a build-output-needed state instead of auto-starting a dev server. [Learn more](web-page-artifacts.md)
- **Visible browser workbench**: interactive browser-use tasks now open a live Electron webview in the task sidebar by default, with URL controls, persistent workspace browser partitions, fullscreen mode, visible cursor movement/action pulses, screenshot capture, screenshot annotation, and follow-up handoff from the same workbench. Browser tools can still fall back to forced headless Playwright, external Chrome profiles, or DevTools attach when explicitly requested. [Learn more](browser-workbench.md)
- **Structured memory observations**: local memory now has inspectable observation metadata, progressive index/timeline/detail recall tools, Memory Hub Inspector actions, deterministic rebuild/backfill behavior, workspace-scoped mutation boundaries, privacy controls, soft-delete suppression, and Supermemory mirroring exclusions. [Learn more](memory-observations.md)
- **Mission Control intelligence**: Mission Control now has repository-backed projected items, evidence records, task/mention/activity/heartbeat refresh flows, intelligence UI surfaces, and stale terminal-task cleanup.
- **Format-aware file preview popup**: clicked file links now open a format-aware preview modal with tailored sizing, metadata subtitles, and unified Copy path / Show in Finder / Open externally / Close actions. New branches include JSON tree/raw preview, CSV/TSV table rendering, audio playback, richer image metadata, and syntax highlighting for code and LaTeX.
- **Structured dev logging**: `npm run dev:log` writes redacted text logs, JSONL logs, latest-run mirrors, retained-run manifests, and configurable cleanup controls for local debugging.

## Enhancements

- **Cleaner task artifact display**: document, spreadsheet, presentation, and web artifact cards now render only at the final output reference for a task instead of repeating throughout intermediate file and artifact events.
- **DOCX save fidelity**: DOCX editing preserves unsupported package parts, updates parsed blocks in place, keeps inserted blocks in editor order, and avoids collapsing existing formatted runs during save.
- **Large CSV/TSV safety**: delimited spreadsheet previews preserve rows outside the preview window, append newly added rows after hidden source rows, and prevent editing columns beyond the saveable preview cap.
- **PPTX generation and preview fidelity**: presentation generation and preview extraction were expanded with better layouts, richer text handling, thumbnail/render caching, and test coverage.
- **HTML asset inlining**: web previews now inline local relative and root-relative build assets so Vite/React-style `dist/index.html` outputs render in the sandboxed iframe.
- **Browser tool routing**: `browser_navigate`, click/fill/type/press/scroll/wait/select/content/text/evaluate/screenshot, and related browser tools now prefer the visible in-app browser session for user-facing site testing, keep session ids across calls, emit cursor events for visible actions, and report profile-launch conflicts with a visible-workbench retry path.
- **Browser screenshots and annotations**: browser workbench screenshots can be saved into the workspace, annotated directly in the app, and sent back to the agent as image attachments for follow-up inspection.
- **Renderer bundle reduction**: the app shell lazy-loads secondary renderer views, Mermaid loads only when needed, and syntax highlighting imports a bounded `highlight.js/lib/core` language set.
- **LLM provider settings**: OpenAI, Azure OpenAI, OpenAI-compatible, Pi AI, provider factory, OAuth, reasoning-effort typing, and model-selection behavior were tightened with expanded tests.
- **Image generation routing**: ChatGPT subscription sign-in is now treated as a first-class image generation route, OpenAI Codex image generation prefers `gpt-image-2`, older OpenAI image model aliases are normalized, and setup/error language now points users to ChatGPT sign-in when applicable.
- **Vision routing**: image analysis now uses the active image-capable provider path, supports OpenAI OAuth token refresh for vision requests, avoids treating Gemini as an inline-image provider, and gives clearer instructions when the current model cannot analyze images.
- **Follow-up permissions**: follow-up messages can carry permission-mode and shell-access overrides so users can continue an existing task with broader or narrower runtime access without recreating it.
- **Presentation artifact planning**: prompts that ask for presentations, slide decks, PowerPoint, or `.pptx` outputs now infer a required `.pptx` artifact, inject a presentation creation step when needed, and require real artifact evidence instead of accepting screenshots or text as a substitute.
- **Native setup reliability**: native setup now routes `better-sqlite3` Electron rebuilds through `@electron/rebuild` with isolated rebuild home directories, avoids unsupported npm job config keys, and keeps Windows ARM64 x64 fallback behavior explicit.
- **Timeline polish**: active image-generation lanes show an inline frame preview, pending parallel lanes are treated as active, and follow-up placeholders now consistently invite users to add context or steer current work.
- **Control plane and Symphony runtime**: added Symphony service plumbing, registration, protocol handling, and tests for richer control-plane orchestration.
- **Memory Hub controls**: Memory Hub settings gained observation-facing controls and supporting styles for inspecting and managing structured memory metadata.
- **File Hub and IPC support**: File Hub, preload, and IPC handlers now understand the new artifact preview/edit APIs and format-specific viewer payloads.
- **Documentation refresh**: README, docs index, Features, Getting Started, Use Cases, Showcase, Architecture, Development, Troubleshooting, GTM, Project Status, and artifact docs now frame generated files as a unified local-first workbench.
- **Bundled skill metadata**: frontend, frontend-design, Kami, Karpathy Guidelines, memory-kit, and routing eval metadata were refreshed.
- **App branding**: macOS app/Dock icons and dark-mode renderer assets now use `resources/branding/cowork-os-app-logo-dark.png`; Windows and light-mode renderer assets continue to use `resources/branding/cowork-os-app-logo.png`.

## Fixes

- **Repeated artifact cards**: office/web artifact cards are no longer shown over and over in verbose task timelines; the final output remains visible.
- **Type-check blockers**: delivery-mode timeline narrowing and delivery-row tests now type-check cleanly.
- **DOCX data loss**: saving existing DOCX files no longer rebuilds the package from only editable text blocks and drop headers, images, comments, section settings, or other unsupported Word structures.
- **CSV data loss**: editing and saving large CSV/TSV files no longer truncates rows after the preview window or overwrites the first hidden row when adding a row.
- **Root-relative web assets**: sandboxed web previews now handle `/assets/...` references from built web apps.
- **Browser workbench reliability**: visible browser sessions unregister/register through main-process IPC, keep status in sync with the renderer webview, and avoid silently launching separate profile-backed Chrome sessions when a visible session is already available.
- **Image attachment handling**: tasks now stop before sending attachments to providers that cannot accept images and tell the user to switch to an image-capable model/provider instead of sending unsupported inline image payloads.
- **Bypass permissions semantics**: `bypass_permissions` now consistently allows approval-gated actions unless a higher-precedence hard policy blocks them, while `dont_ask` still prompts for data export.
- **Follow-up runtime updates**: queued and resumed follow-ups now update executor workspace and agent config state so permission and shell-access changes take effect immediately.
- **Mission Control stale rows**: terminal tasks are removed from projected Mission Control task items so completed/cancelled work does not keep counting as active.
- **Provider and runtime reliability**: provider parsing, runtime visibility, workspace preflight acknowledgements, verification runtime behavior, mailbox behavior, permission settings, and task pause banners received targeted reliability fixes and tests.
- **Email HTML rendering**: email HTML layout handling now has dedicated utility coverage.

## Upgrade Notes

- This release prepares package metadata for `0.5.41`; publish only from a clean checkout or release worktree.
- Before npm publish, explicitly run `npm ci --no-audit --no-fund`, `npm run build`, and the tarball validation steps from `AGENTS.md`. Do not rely on `prepack`, because `.npmrc` sets `ignore-scripts=true`.
- DOCX editing is intentionally conservative: DOCX can be edited in-app, while legacy/app-owned document formats remain preview/external-app oriented.
- CSV/TSV and workbook editing is capped to the preview-safe row/column window; hidden source rows are preserved.
- PPTX rendered slide images depend on local conversion tools. Text-first preview still works when render dependencies are unavailable.
- Web page previews sandbox generated HTML and inline local assets; React/Vite source projects still need an explicit build output such as `dist/index.html`.

## References

- [Changelog](changelog.md) - full version history
- [Everything Workbench](everything-workbench.md) - unified artifact workspace
- [Document Artifacts](document-artifacts.md) - Word-style outputs
- [Spreadsheet Artifacts](spreadsheet-artifacts.md) - Excel, CSV, and TSV outputs
- [Presentation Artifacts and PPTX Preview](pptx-generation-and-preview.md) - PowerPoint outputs
- [Web Page Artifacts](web-page-artifacts.md) - HTML and built web outputs
- [Structured Memory Observations](memory-observations.md) - inspectable local memory metadata

This page is the canonical high-level summary for the changes included in `0.5.41`.
