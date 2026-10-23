# Real-workflow QA — 22 October 2026

This receipt covers local development Electron QA based on merged `main`
`e2b8d726b0c4ef456c605cda119d4645432c9a31` (v0.5.61). It is not a
packaged-release or production acceptance claim. The app was launched with
`npm run dev`; a profile database backup was taken first and background
automation autostart was disabled for the QA process.

## Fixes

| User journey | Defect and correction | Evidence |
| --- | --- | --- |
| Compose a request with emoji or accented text | Plain Backspace/Delete removed one UTF-16 unit. Delete whole grapheme clusters instead. | Native emoji deletion; focused regressions for emoji, joined emoji, and combining marks. |
| Edit a request using word/line shortcuts | Modified Backspace/Delete was intercepted as a one-character edit. Delegate boundary selection to the native editor. | Native macOS Option–Backspace; real key-handler callback regressions for Alt/Ctrl/Meta Backspace/Delete. |
| Commit text with an IME | Parent Enter/Tab shortcuts ran before the composition check. Fence composing/keyCode-229 events before parent shortcuts. | Real key-handler callback regressions for composing Enter/Tab, legacy keyCode 229, and ordinary Enter; no native IME acceptance claim. |
| Paste a URL containing `%` | Label decoding could throw on malformed percent escapes. Keep the undecodable path segment as its label. | Native literal-percent URL paste and focused malformed-escape cases. |
| Attach a file while switching projects | Asynchronous picker/FileReader results could land in a new empty composer's workspace. Fence success, errors, and staged attachment references to their owner generation. | Workspace, session/device, A→B→A, and unmount regressions; no live delayed-picker race claim. |
| Edit a workbook or document, then enter full view | Separate render branches remounted the editor and lost unsaved state. Keep one editor mounted through the existing workbench dock. | Native XLSX and DOCX sidebar/fullscreen roundtrips retained unsaved edits and enabled Save; dock layout/cleanup tests. |
| Edit a spreadsheet cell, then select another cell, column, or sheet | Selection removed the input before blur could commit it; clicking inside the input also reset its draft. Commit the current draft once before selection changes, and preserve native input mouse events. | Native typed edit retained after clicking its neighbor and entering/exiting full view; eight behavior regressions, with selected cases confirmed failing on the original implementation. |
| Continue an approval-gated task through the local API | Advertised `input_request.list` and `input_request.respond` methods returned `UNKNOWN_METHOD`. Register both with admin scope, shared IPC response validation, bounded listing, and the existing daemon's revision/idempotency checks. | Live listing succeeded after rebuild; invalid responses returned `INVALID_PARAMS`, and a nonexistent request returned `not_found`. 29 focused API, approval-revision, and daemon input-request tests. |
| Review multiple or large files | `read_files` hid internal read-window truncation, dropped continuation metadata, and failed to name/count some budget-omitted files. Context compaction also dropped continuations from untouched entries. | File-tool and compaction regressions; compiled runtime read a 35,060-character source, returned `nextStartChar:30000`, and retrieved the missing end section. |
| Summarize invoices with a currency in the header | `amount_eur` failed raw regex word-boundary detection and blocked a valid EUR Markdown summary. Recognize separated currency tokens in normalized CSV headers. | Live failure at `write_file` with `source_evidence_validation`; exact six-row regression confirmed failing before the fix and passing afterward. Plain amount headers still reject invented currency. |

## Live workflows

The fixtures are fictional local invoices and planning notes, not personal or
customer work history. Both tasks ran through the configured OpenAI provider.

1. **Invoice reconciliation:** created `invoice-summary.xlsx` and
   `invoice-summary.md` from six invoices. Independent ZIP/XML inspection found
   six sheets, 103 formulas, no formula errors, and saved values of 2,829.25 EUR
   total, 1,414.50 paid, 1,414.75 unpaid, and 1,325.25 overdue unpaid across two
   invoices. The source file remained unchanged. The initial run exposed the
   currency-header validator defect; the agent eventually recovered through an
   edit after its first write was blocked.
2. **Meeting notes to DOCX:** created `pilot-brief.docx` with decisions,
   action owners/deadlines, risks, and open questions. Checked the DOCX XML and
   opened it in CoWork's editor. Unstated owners and readiness conditions were
   retained as uncertainties. Temporary unsaved QA edits were not saved to the
   original document or workbook.
3. **Post-rebuild currency regression:** submitted a narrowly scoped
   `currency-check.md` task through the app's existing local control-plane API.
   It completed in 1 minute 39 seconds using three `read_file` calls and one
   successful `write_file`, with zero `source_evidence_validation` blocks.
   Independent exact-decimal arithmetic confirmed six records, EUR 2,829.25
   total, and EUR 1,325.25 overdue unpaid for INV-1003/INV-1004. The report
   includes inspectable addition expressions and the strict due-date cutoff.
   The completed result was also verified in the native task UI.

Both initial tasks reported partial success for automatic opening: they tried
the native desktop tool and encountered the existing explicit-consent policy.
Manually opening the delivered artifacts in CoWork succeeded. This patch does
not change that authorization policy or add an agent tool for opening workbench
artifacts. No messages were sent or outputs published by these test tasks.

Native UI automation sometimes returned stale observations; apparent delayed
task navigation was not independently confirmed as an app defect and was not
patched. Native IME, delayed attachment reads, Windows, packaging, connectors,
and generic computer-use acceptance remain outside the verified surface.

## Validation

- Initial `npm test` before the API/cell-edit additions: 123 Node tests passed;
  1,615 Vitest files passed, two skipped;
  18,179 Vitest tests passed, seven skipped. The full run required localhost
  listeners permitted outside the filesystem sandbox.
- The later full run passed 123 Node tests and 18,192 Vitest tests, with six
  timeout failures across TranscriptStore, LuaLaTeX, subscription-cache transport,
  SQLite audit, document session service, and file-discovery cleanup. This run
  overlapped compiler/build jobs. A subsequent run without competing build jobs
  passed all seven selected suites and all 83 tests: the six affected suites plus
  the 12 newly added composer keyboard regressions. No timeout settings or
  production code were changed to make that rerun pass. The latest full run
  therefore retains six timeouts; all six cleared on isolated rerun.
- Renderer and Electron TypeScript checks passed.
- `npm run lint`, `npm run fmt:check`, and `git diff --check` passed.
- `npm run build:react` passed its renderer bundle-size gate.
- `npm run dev` rebuilt and started the corrected Electron harness.
- Independent review of the composer, attachment ownership, file continuation,
  and persistent artifact dock changes found no additional blocking issue.
