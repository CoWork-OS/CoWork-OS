# Workflow QA, third pass — 23 October 2026

Started from fetched main `76760b7df499269b41d02501c72cdfa5a9c4227a`,
including merged PR 767. Used `npm run dev`, existing provider configuration,
and fictional event-studio planning fixtures. Backed up the closed app's profile
first and enabled process-local quiet startup. No external messages, supplier
orders, or publication were requested by the app tasks.

## Reproduced defects and changes

1. **Deliverable links override filename citations.** A meeting follow-up asked
   for source filenames and links to the saved deliverables. Verification wrongly
   required direct source links or numbered citations in every factual table
   cell, initiating an unnecessary rewrite of already-correct DOCX/Markdown.
   The detector now excludes two explicit saved/output-file link phrasings from
   citation-format conflict detection. Other link requirements, including source
   and input-file links, remain strict. Three new cases fail before the fix and
   pass afterward; mixed source/deliverable and input-link cases retain coverage.
2. **Clicked spreadsheet cells do not acquire keyboard focus.** Cell mouse-down
   prevents default browser focus while committing pending edits, but did not
   return focus to the grid. A cell could appear selected while keyboard focus
   remained on the download link. The selection handler now focuses the grid
   after committing the pending editor. A regression against the real component
   handlers fails before this change and passes after it, including subsequent
   arrow navigation; existing blur/draft/patch-deduplication cases still pass.

## Workflow evidence

- **Native Ask composer:** submitted a supplied-data comparison through Ask.
  It returned EUR 1,650 versus EUR 1,470, saving EUR 180, in three bullets.
  The task completed with zero tool calls. No artifacts were requested or made.
- **Meeting follow-ups:** generated matching `action-register.md` and
  `workshop-update.docx`. The saved DOCX has one native action table. The final
  29 October deadline supersedes 28 October; missing owners/deadlines and venue,
  client, and invitation approvals remain unresolved. Initial verification
  triggered the spurious citation repair described above; the run completed
  after rewriting both files with numbered citations.
- **Fresh document rerun after rebuild:** the same request in a fresh workspace
  completed in 171 seconds with zero failed steps, one DOCX creation, and no
  citation-repair cycle or user clarification. Saved-file verification returned
  `OK`. Independent inspection found the corrected deadline and source filename
  in both files, plus one native action table with four records. Source bytes
  matched the original fixture. Rendered page count remains unmeasured and was
  not required.
- **Spend workbook:** generated Ledger/Summary with eight text IDs (`001`–`008`),
  fourteen formulas, and separate EUR/GBP totals. Independent saved-file reads
  confirmed EUR approved 250, proposed 1,850; GBP proposed 180; EUR cap 2,400 and
  proposed-spend headroom 550. The EUR −50 credit remains negative and duplicate
  entry 006 contributes zero. Estimates explicitly do not authorize purchases.
  The workbook on disk remained byte-identical during unsaved native edit tests.
- **Native inspection limit:** the accessibility tree exposed the generated
  document and workbook editors, while repeated screenshots retained an older
  Ask view and some controls returned stale IDs or `elementHasNoFrame`. Rebound
  the app, refreshed accessibility state, and tried the native window menu.
  These automation failures are not classified as product rendering defects.
  No fresh visual/keyboard acceptance is claimed solely from those snapshots.

## Validation

- 187 focused tests passed across five suites.
- Renderer TypeScript, Electron compilation through `npm run dev`, lint,
  formatting, renderer production build/bundle-size checks, and diff whitespace
  checks passed.
- Frozen full suite (`npm test -- --maxWorkers=2`, QA app closed): all 123 Node
  tests and 18,238 Vitest tests passed; seven Vitest tests were skipped across
  two files. Vitest finished in 550.00 seconds. Skill checks also passed.
- This is development-app evidence, not packaged release or production acceptance. The spreadsheet
  focus change has component-handler regression coverage; native acceptance
  remains limited by the automation observations above.
