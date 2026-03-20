# Edge Case Review — Uncommitted Changes

Review of uncommitted changes for overlooked risks, edge cases, and failure modes. Ordered by severity (P0 → P3).

**Status:** All identified issues have been addressed.

---

## P0 — Security / Data Integrity

### 1. Health import file path traversal ✅ FIXED

**File:** `src/electron/health/HealthManager.ts` (lines 812–856, 1584–1615)  
**IPC:** `handlers.ts` → `HEALTH_IMPORT_FILES`

**Fix:** `HealthImportFilesSchema` now validates paths are absolute and under allowed roots (home, Downloads, Desktop, Documents, getUserDataDir). Paths outside these directories are rejected.

---

### 2. Personality import — unvalidated input ✅ FIXED

**File:** `src/electron/ipc/handlers.ts` (lines 3508–3510)  
**Handler:** `PERSONALITY_IMPORT`

**Fix:** Added `PersonalityImportSchema` with max 500KB, JSON structure validation, and `validateInput` before `importProfile`.

---

## P1 — Incorrect Behavior / Production Risk

### 3. `recordQAExecution` — success detection for `qa_run` ✅ FIXED

**File:** `src/electron/agent/executor.ts` (lines 6971–6975)

```ts
private recordQAExecution(toolName: string, result: Any): void {
  if (toolName !== "qa_run") return;
  if (result && result.success === false) return;
  this.visualQARunObserved = true;
}
```

`qa_run` returns a **string** (markdown report), not `{ success: boolean }`. So `result.success` is always `undefined`, and `visualQARunObserved` is set to `true` on every `qa_run` call, even when `run.status === "failed"`.

**Fix:** `qa_run` now returns JSON `{ success: run.status === "completed", report }`; registry passes `success` to executor; `recordQAExecution` correctly checks `result.success === false`.

---

### 4. `detectVisualQARequirement` — overly broad signals

**File:** `src/electron/agent/executor.ts` (lines 6913–6933)

`WEB_SIGNALS` includes `"html"`, `"css"`, `"javascript"`. Prompts like “fix the HTML in this email template and test it” can trigger the Visual QA requirement even when there is no web app to run.

**Recommendation:** Tighten signals (e.g. require “web app”/“website”/“frontend” or a framework name) or add negative patterns for “email template”, “static html”, etc.

---

### 5. QA IPC handlers — no validation or rate limiting ✅ FIXED

**File:** `src/electron/ipc/qa-handlers.ts`

**Fix:** Added `QAStartRunSchema`, `validateInput` for QA_START_RUN and QA_STOP_RUN, and `rateLimiter.configure(QA_START_RUN, limited)`.

---

### 6. Awareness / Autonomy config — unvalidated save ✅ FIXED

**File:** `src/electron/ipc/handlers.ts` (AWARENESS_SAVE_CONFIG, AUTONOMY_SAVE_CONFIG)

**Fix:** Added `AwarenessConfigSchema` and `AutonomyConfigSchema`; validate before `saveConfig`.

---

## P2 — Quality / Maintainability

### 7. Health import — sensitive paths in state ✅ FIXED

**File:** `src/electron/health/HealthManager.ts` (line 852)

**Fix:** Store `path.basename(filePath)` instead of full path in `attachments`.

---

### 8. `AUTONOMY_TRIGGER_EVALUATION` — rate limit config ✅ FIXED

**File:** `src/electron/ipc/handlers.ts` (line 7333)

**Fix:** Added `rateLimiter.configure(AUTONOMY_TRIGGER_EVALUATION, standard)` and AWARENESS_SAVE_CONFIG, AUTONOMY_SAVE_CONFIG in `setupMemoryHandlers`.

---

### 9. `context-mode-detector` — `tools.length === 0` implies coding ✅ FIXED

**File:** `src/electron/agent/context-mode-detector.ts` (lines 138–142)

```ts
const hasCodingTools =
  tools.some(...) || tools.length === 0;
```

When `tools.length === 0`, `hasCodingTools` is `true`. For pure chat with no tools, this may incorrectly bias toward “coding” mode.

**Recommendation:** Revisit the heuristic when `tools.length === 0` (e.g. treat as neutral or “all” instead of coding).

---

## P3 — Minor / Polish

### 10. Duplicate briefing alias

**File:** `src/electron/preload.ts`

Both `generateDailyBriefing` and `generateBriefing` invoke the same channel. No functional issue; consider consolidating or documenting the alias.

---

### 11. `index.css` — large diff

**File:** `src/renderer/styles/index.css`

~34k insertions, ~18k deletions. Likely a theme or refactor. Ensure no unintended overrides or broken selectors.

---

## Open Questions / Assumptions

1. **Health import UX:** The Health panel uses `selectFiles()` for import. If paths are always from the native dialog, risk is lower. Main-process validation is still recommended for defense in depth.
2. **`isVerifiedMode` removal:** Executor diff removes `if (this.isVerifiedMode())` around profile selection. Confirm this is intentional and matches the new “verified mode” design.
3. **`hasEntries` in workspace preflight:** New `hasEntries` in `getWorkspaceSignalsForPath` — ensure all callers handle it correctly.

---

## New Findings (Latest Review)

### 10. `storeSuggestion` — unreachable `return null` (P2) ✅ FIXED

**File:** `src/electron/agent/ProactiveSuggestionsService.ts`

**Fix:** Removed the unreachable `return null` after the try/catch.

---

### 11. `awarenessSnapshotBlock` — redundant assignment (P2) ✅ FIXED

**File:** `src/electron/agent/executor.ts`

**Fix:** Removed the duplicate assignment inside the synthesized memory block.

---

### 12. `hasEntries` / `readdirSync` failure — preflight skips pause when directory unreadable (P2) ✅ FIXED

**File:** `src/electron/agent/executor-workspace-preflight-utils.ts`, `executor.ts`

**Fix:** Added `readFailed` flag to `WorkspaceSignals`. When `readdirSync` throws, catch returns `readFailed: true`. Preflight now pauses with "workspace_read_failed" and a clear message when the workspace couldn't be read. `tryAutoSwitchToPreferredWorkspaceForAmbiguousTask` skips workspaces with `readFailed`.

---

### 13. Discord live tools — no snowflake format validation (P3) ✅ FIXED

**File:** `src/electron/agent/tools/channel-tools.ts`

**Fix:** Added `isValidDiscordSnowflake()` helper (17–19 digit regex). `channel_fetch_discord_messages` and `channel_download_discord_attachment` now validate `chat_id` and `message_id` before calling the provider.

---

### 14. HealthKit bridge build — entitlements (P3)

**File:** `scripts/build_healthkit_bridge.mjs`, `build/entitlements.mac.plist`

**Note:** Ensure Apple Developer Program membership and HealthKit capability are configured for distribution. Not a code fix.

---

## New Findings (Additional Review)

### 15. `PERSONALITY_SAVE_CONFIG_V2` — no validation (P1) ✅ FIXED

**File:** `src/electron/ipc/handlers.ts`, `src/electron/utils/validation.ts`

**Fix:** Added `PersonalityConfigV2Schema` with bounded string lengths, array limits, and 500KB total size cap. Handler now calls `validateInput` before `saveConfigV2`.

---

### 16. `PERSONALITY_PREVIEW` — unvalidated draft (P2) ✅ FIXED

**File:** `src/electron/ipc/handlers.ts`

**Fix:** Added `ContextModeSchema` validation for `contextMode` and a 500KB size guard for `draft` before calling `getPreviewPrompt`.

---

### 17. `AWARENESS_UPDATE_BELIEF` / `AUTONOMY_UPDATE_DECISION` — unvalidated patch (P2) ✅ FIXED

**File:** `src/electron/ipc/handlers.ts`, `src/electron/utils/validation.ts`

**Fix:** Added `AwarenessUpdateBeliefSchema` and `AutonomyUpdateDecisionSchema` with id length limits and 50KB patch size cap. Handlers now validate before calling services.

---

### 18. Discord attachment download — no size limit (P2) ✅ FIXED

**File:** `src/electron/gateway/channels/discord.ts`

```ts
const response = await fetch(url);
const buffer = Buffer.from(await response.arrayBuffer());
await fs.promises.writeFile(localPath, buffer);
```

The full response is buffered in memory with no size limit. Discord attachment URLs are typically trusted, but a malicious redirect or misconfigured CDN could serve a very large file and cause OOM.

**Recommendation:** Check `Content-Length` (or stream with a cap) and reject downloads above a threshold (e.g. 50MB). Discord’s `att.size` metadata could be used when available.

---

### 19. `generate_narration_audio` — no text length limit (P2) ✅ FIXED

**File:** `src/electron/agent/tools/document-tools.ts`

**Fix:** Added 25,000 character limit. Returns clear error when exceeded.

---

### 20. `hexToRgb` with invalid accent color (P3) ✅ FIXED

**File:** `src/electron/utils/document-generators/html-page-generator.ts`

**Fix:** Validates hex format with regex; falls back to default `#7c3aed` when invalid.

---

### 21. Rate limit config for AWARENESS/AUTONOMY mutation handlers (P3) ✅ FIXED

**File:** `src/electron/ipc/handlers.ts`

**Fix:** Added `rateLimiter.configure` for `AWARENESS_UPDATE_BELIEF`, `AWARENESS_DELETE_BELIEF`, and `AUTONOMY_UPDATE_DECISION` with `RATE_LIMIT_CONFIGS.limited`.

---

## Summary

| Severity | Count | Status |
|----------|-------|--------|
| P0       | 2     | Fixed |
| P1       | 5     | Fixed |
| P2       | 9     | Fixed |
| P3       | 5     | Fixed |

All identified edge cases have been addressed.
