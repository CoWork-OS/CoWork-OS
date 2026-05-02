# Everything Workbench

CoWork OS is a local-first personal agentic OS and everything app. It is meant to cover more than office-style files: coding, research, web design, documents, spreadsheets, decks, PDFs, automations, inbox work, channels, devices, skills, and long-running tasks all live in one governed workspace.

The Everything Workbench is one major surface inside that broader OS. Its goal is fewer context switches for generated knowledge work: ask for an artifact, open it in-place, review or edit it, then ask the agent for follow-up changes without leaving the task. CoWork does not try to clone every advanced native feature in Word, Excel, PowerPoint, Keynote, Numbers, Pages, or a browser IDE. It gives generated work a first-class in-app workspace, with external-open actions when a specialized native app is still the better tool.

## Broader Positioning

Use CoWork OS as the app where personal agentic work starts and stays:

- code, review repositories, and run local project tasks
- research, summarize, draft, and maintain knowledge
- design and revise web pages and frontend experiences
- create and work with documents, spreadsheets, presentations, PDFs, and local files
- automate recurring work across channels, connectors, devices, and schedules
- coordinate long-running personal or company operations with memory, skills, approvals, and runtime visibility

The artifact workbench strengthens this positioning because generated files become part of the same agentic loop instead of dead-end downloads.

## Core Model

The workbench model is shared across supported artifact types:

1. A task creates or updates a local file.
2. The task feed shows a compact artifact card instead of a plain file link.
3. The main **Open** action opens the artifact in a resizable right sidebar when an in-app surface is available.
4. The fullscreen button promotes the same artifact into a focused workspace.
5. The follow-up composer stays with the artifact so the user can request changes in context.
6. The preview refreshes after the follow-up finishes and the relevant file changes.
7. Dropdown actions still provide external app, browser, folder, and copy-path options.
8. Live websites can open in the Browser Workbench so interactive browser-use tasks happen beside the task instead of in a hidden or external browser.

This keeps the agent next to the work product. A spreadsheet can be selected and copied, a DOCX can be edited and saved, a deck can be reviewed slide by slide, a generated page can be opened in a sandboxed preview, and a PDF/LaTeX pair can be inspected from the same task surface.

## Supported Artifact Workspaces

- **Documents**: Word-style outputs render as document cards. DOCX opens directly in an editable sidebar/fullscreen document surface with Google Docs-style controls, save, copy, external-open, and follow-up refresh. Other Word-style formats use best-effort preview or external actions. See [Document Artifacts](document-artifacts.md).
- **Spreadsheets**: Excel workbooks and CSV/TSV files open in an editable sheet workbench with selection, row/column selection, copy, zoom, add row/column, save, and follow-up context. Native/app-owned spreadsheet formats keep card and external actions. See [Spreadsheet Artifacts](spreadsheet-artifacts.md).
- **Presentations**: PPTX decks open in a slide viewer with thumbnails, navigation, zoom, speaker notes, text-first loading, cached slide images, and follow-up refresh after requested edits. Legacy PowerPoint formats keep external actions. See [Presentation Artifacts and PPTX Preview](pptx-generation-and-preview.md).
- **Web pages**: Generated HTML/HTM files and built React output open in a sandboxed iframe preview with browser/folder/copy actions. Fullscreen mode supports follow-up edits and defers refresh until the updated output is ready. See [Web Page Artifacts](web-page-artifacts.md).
- **Live websites**: Browser-use tasks open a visible in-app Browser Workbench by default. The agent and user share the same right-sidebar/fullscreen webview, with navigation controls, screenshots, annotation, and visible cursor movement during actions. See [Browser Workbench](browser-workbench.md).
- **PDF and LaTeX**: Source-first LaTeX workflows preserve the editable `.tex` file and pair it with the compiled PDF in one artifact workbench when a local TeX engine is available.
- **Uploaded PDFs**: PDF attachments are imported into `.cowork/uploads/...`, summarized into a compact attachment block, and read more deeply on demand with `parse_document`. The attachment block preserves the workspace-relative path, page count, extraction status, OCR/scan signals, and a short excerpt without inlining the full PDF into every prompt. Visual/layout PDF questions use `read_pdf_visual` instead.
- **General previews**: The format-aware file preview popup remains available for files that do not have a dedicated artifact workbench.

## Positioning Boundary

Use CoWork OS as the first stop for generated knowledge work:

- draft and revise reports, memos, summaries, one-pagers, and DOCX files
- create and adjust spreadsheets, CSVs, tables, and lightweight workbook outputs
- review generated decks and request slide changes through follow-up prompts
- inspect generated HTML pages and built React output without leaving the task
- test live websites and local web apps in the in-app browser while watching the agent click, type, scroll, and inspect the page
- keep the task timeline, artifact, and follow-up request in one context

Use external apps when the work needs advanced native behavior:

- Excel pivot tables, complex charting, macros, and deep workbook modeling
- Word track changes, comments, embedded objects, and high-fidelity layout repair
- Keynote/PowerPoint direct slide authoring beyond review and agent-requested edits
- Pages, Numbers, Google Docs, Google Sheets, or Google Slides native cloud behavior

The product promise is not "replace every office app." The promise is "reduce the need to switch apps for generated work by making artifacts editable, reviewable, and agent-revisable inside CoWork OS."

## Related Docs

- [Features](features.md)
- [Getting Started](getting-started.md)
- [Document Artifacts](document-artifacts.md)
- [Spreadsheet Artifacts](spreadsheet-artifacts.md)
- [Presentation Artifacts and PPTX Preview](pptx-generation-and-preview.md)
- [Web Page Artifacts](web-page-artifacts.md)
- [Browser Workbench](browser-workbench.md)
