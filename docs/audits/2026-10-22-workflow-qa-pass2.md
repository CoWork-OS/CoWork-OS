# Workflow QA, second pass — 22 October 2026

Based on merged main `d1280056e936f22b2176f8a7989c4a7493c18fb1`, using
`npm run dev` with the configured OpenAI provider. The profile database was
backed up first. Startup automation was quiet for this QA process. Fixtures
describe a fictional agency portal pilot; no messages or outputs were published.

## Reproduced defects and fixes

1. **Silent loss of unsaved artifact edits.** In the running spreadsheet editor,
   changing a cell, closing the editor, and reopening restored the original value
   without a warning. Both editable artifact viewers directly called `onClose`.
   DOCX/XLSX close buttons now ask before discarding changes and remain disabled
   while saving. Pending spreadsheet input is included in the guard. Native
   checks confirmed that Cancel retains edits in both editors and explicit
   discard closes them. Independent ZIP/XML inspection confirmed temporary QA
   edits were absent from the saved originals. This protects the close buttons;
   task navigation, replacing an open artifact, and whole-app shutdown are not
   covered by this guard.
2. **Artifact requests diverted into a read-only review pipeline.** The first
   presentation task entered a bounded single-document analysis plan and failed
   with zero tool calls and no PPTX. Output detection now reuses completion's
   artifact contract, including decks, workbooks, webpages, and CSVs. Multi-source
   comparisons also use ordinary file tools because the bounded pipeline extracts
   only one source. Five artifact-routing cases failed before the fix; all seven
   artifact/multi-source cases pass afterward. Single-document reviews and
   verifier-worker exclusions retain coverage.
3. **Filename citations incorrectly required hyperlinks.** A correctly sourced
   local handover was blocked because the verifier required direct links or
   numbered citations, despite the request asking for filenames. Explicit
   filename-only requests now retain factual source verification without adding
   a hyperlink requirement. Explicit link requirements still take precedence.
   The filename-format regression failed before the fix and passes afterward.
4. **Invented historical checksum requirement.** A file-tool-only handover was
   blocked despite an operation audit showing only the requested output write:
   its generated verification step demanded full historical originals in its
   context. Guidance now accepts a complete, authoritative mutation audit as
   operation-level preservation evidence and requires that scope to be stated.
   Incomplete audits, shell/external writes, and explicit checksum or byte-equality
   requests still require stronger proof. This does not claim protection against
   concurrent external changes.

## Workflows and evidence

- **Long-source launch reconciliation:** three sources included two handovers
  of about 65 KB each. Their final paragraphs supersede the original launch date
  and withhold client approval. The generated handover identified 16 November
  2026 as a proposal, superseding 9 November; it retained the missing permission
  review, absent launch approval, and Client B sign-off as blockers. The original
  run completed after a citation-format clarification.
- **Local portal prototype:** produced self-contained `client-portal.html`.
  Source inspection found no remote URLs, network calls, or forms. In CoWork's
  native artifact viewer, the contact control displayed a non-sending demo
  notice; a demo approval changed the pending count from two to one; full view
  retained that state. All data and actions were marked as demo. Verification
  initially sought unnecessary TextEdit control (denied), then encountered the
  existing block on `file:` browser navigation. File verification completed after
  clarification, with interactive checks performed separately in the workbench.
  These permission policies were not weakened.
- **Presentation rerun:** the original request used normal file/presentation
  tools and produced `pilot-review.pptx`. Independent ZIP/XML inspection found
  six slides, six notes sections, the later date, approval blockers, and all three
  source filenames. The workbench accessibility tree reported six rendered
  slides and displayed speaker notes. Screenshot capture returned another
  Electron window, so visual layout is not claimed from that capture. Unneeded
  Keynote control was denied; the task finished with that verification step
  waived. Actual slides were valid despite the package metadata declaring zero.
- **Citation rerun:** the new handover passed filename attribution without a
  citation-format clarification, then exposed the separate preservation issue
  described above. After the final rebuild, restart resumed the task and a
  neutral request to continue verification was queued. The task completed with
  content checks satisfied and the historical byte-equality limitation still
  stated. This validates completion/resume, but does not establish a fresh
  end-to-end pass for the new preservation guidance; its conditional behavior
  is covered by focused tests.
- **Input integrity:** both long handovers still exactly matched independently
  reconstructed fixture bytes, including their final decision paragraphs. All
  three source SHA-256 values remained unchanged across the workflows.

## Validation

- 357 focused tests passed across six suites.
- Renderer/Electron TypeScript, lint, formatting, and renderer production build
  passed. `git diff --check` passed.
- Frozen full run (`npm test -- --maxWorkers=2`, QA app closed): skills checks,
  all 123 Node tests, and 18,231 Vitest tests passed; seven Vitest tests were
  skipped across two skipped files. Vitest finished in 550.64 seconds.
- An earlier overlapping run had three timeouts and two assertions added while
  that run was already evaluating old code. All five pass in the final frozen
  run; no timeouts or test behavior were weakened.
- This is development Electron evidence, not packaged release, Windows native,
  connector, or production acceptance.
