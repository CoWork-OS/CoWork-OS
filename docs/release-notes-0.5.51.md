# Release Notes 0.5.51

Release `0.5.51` is a reliability and governance release focused on safer agent execution, bounded long-document review, predictable long-session timelines, local voice output, and stronger cross-platform/runtime recovery.

## Highlights

- **Agent security with Numbat**: added an opt-in, checksum-verified security runtime with monitor/enforce modes, bounded and redacted tool-call projections, findings and decisions, policy provenance, scheduled scans, retention, CLI operations, incident bundles, and optional external hooks. Numbat can restrict an action but cannot grant permissions or bypass normal approvals. See [Agent Security with Numbat](agent-security-numbat.md).
- **Bounded long-document analysis**: read-only analysis of named `.docx`, `.pdf`, `.md`, and `.txt` sources now uses deterministic discovery, safe workspace boundaries, overlapping chunks, coverage accounting, retry/split handling, cancellation, and evidence-preserving partial success. See [Document Analysis](document-analysis.md).
- **Long-session timeline stability**: task history is now loaded with bounded cursor pages and byte budgets; large payloads are preview-truncated with metadata, replay can hydrate details on demand, and renderer caches reduce repeated work during task switching. See [Long-Session Performance](long-session-performance.md).
- **Native System Voice TTS**: local text-to-speech is detected and supported through macOS `say`, Windows PowerShell/SAPI, and Linux `espeak`. System speech recognition is reported clearly as unavailable in this build; OpenAI or Azure Whisper remains the transcription path.

## Safety and Reliability

- Numbat is disabled by default and is additive to existing workspace policy and approvals.
- Sensitive values, local paths, and arbitrary tool payloads are bounded or redacted before Numbat control/output handling.
- Document analysis is read-only and rejects symlinks, Office lock files, hidden/generated directories, unsupported extensions, empty extraction results, and sources outside the active workspace.
- Timeline completion events and relevant tool output are preserved while post-completion stage chatter and duplicate final responses are suppressed.
- Browser Workbench navigation is limited to approved web schemes, and renderer failures now have controlled recovery handling.

## Desktop and Developer Experience

- WSL/WSLg sessions retain the native operating-system window frame while the in-app toolbar becomes a non-draggable row.
- The update action now lives in the sidebar footer.
- Power UI density persists across restarts and is applied during early renderer bootstrap.
- Linked source-checkout dependency repair now preserves lockfile-defined versions and development dependencies; packaged npm installs retain their runtime-only repair path.
- The Electron, SQLite, provider, messaging, charting, and packaging dependency set was refreshed, and native/runtime compatibility checks were expanded.

## Release Readiness

- **Version bump**: package metadata is prepared for `0.5.51`.
- **Release baseline**: compare `v0.5.50...v0.5.51`.
- **Adoption metrics**: generated public adoption reports intentionally remain on `0.5.50` until `0.5.51` artifacts are published.
- **Packaging attention**: this release changes the Numbat runtime bundle, native/runtime repair path, Electron dependencies, timeline transport, and voice adapters. Validate the npm tarball, desktop artifacts, Linux server package, and platform-specific smoke checks.
- **Security attention**: run the security harness and the focused Numbat/document-analysis/timeline/voice tests before tagging or publishing.
- **Platform attention**: WSL framing and native System Voice behavior require host-specific validation; Linux System Voice requires `espeak-ng`, and transcription still requires an external provider.

## Suggested Validation

```bash
npm run fmt:check
npm run type-check
npm run lint
npx vitest run \
  src/electron/security/numbat/__tests__/NumbatBinaryResolver.test.ts \
  src/electron/security/numbat/__tests__/NumbatHookClient.test.ts \
  src/electron/security/numbat/__tests__/NumbatRecordIngestor.test.ts \
  src/electron/security/numbat/__tests__/NumbatService.test.ts \
  src/electron/agent/__tests__/document-analysis-pipeline.test.ts \
  src/electron/agent/__tests__/executor-plan-parsing.test.ts \
  src/electron/voice/__tests__/VoiceService.test.ts \
  src/electron/voice/__tests__/system-voice.test.ts \
  src/electron/database/__tests__/task-event-repository-replay.test.ts \
  src/renderer/utils/__tests__/task-timeline-cache.test.ts
npm run build
npm run release:smoke
npm run qa:security:harness
```

For platform packaging, run the matching desktop and Linux-server smoke checks after artifacts are built. Follow the repository's clean-worktree npm publication workflow before publishing to npm.
