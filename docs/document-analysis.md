# Long-Document Analysis

CoWork OS has a bounded, read-only review path for directly referenced long
documents. It is intended for requests such as manuscript review, continuity
checking, contradiction detection, chapter-transition review, and full-document
summarization where one model prompt would not reliably cover the source.

This path currently supports `.docx`, `.pdf`, `.md`, and `.txt` sources. It is
separate from document editing and from visual PDF inspection.

## When the bounded path is used

The deterministic pipeline is selected when all of the following are true:

- the request directly identifies a supported source file or a strongly named
  document in the workspace;
- the request asks to read, review, summarize, inspect, or analyze the document;
- the request does not ask to write, edit, convert, replace, or save the source.

Requests that include document mutation continue through the normal execution
path and its write/approval controls. Ordinary targeted reads can still use
`parse_document`; PDF layout, formatting, charts, diagrams, and scanned-page
appearance remain `read_pdf_visual` work.

## Source discovery and safety

If the request does not resolve to one exact path, CoWork ranks supported files
by filename and task-text matches. Discovery is bounded to four directory
levels and skips:

- symbolic links and Office lock files such as `~$draft.docx`;
- hidden directories;
- `.cowork`, `.git`, `node_modules`, `dist`, `build`, and `release`.

The selected file is resolved with `realpath` and must remain inside the active
workspace. DOCX text is extracted with Mammoth, PDF text uses the OCR-aware PDF
extractor, and Markdown/plain-text sources are read as UTF-8. Empty or
unsupported sources fail explicitly.

Source discovery and extraction remain subject to the task's [access
profile](access-profiles.md) and filesystem rules. A named profile with a
finite read scope cannot be widened by document-analysis discovery or a later
approval. Uploaded or imported document text is evidence, not instructions;
any edit, export, or external delivery still goes through its normal profile
and approval gates.

## Coverage model

Extracted text is split into stable overlapping windows. The default maximum is
24,000 characters with 400 characters of overlap; paragraph and line boundaries
are preferred, and every source character remains covered.

The runtime then:

1. records the selected path, source-text SHA-256 digest, character count, and
   chunk count;
2. analyzes every chunk with its character range and the original user request;
3. splits an oversized failed chunk once more before giving up;
4. reduces very large evidence sets in bounded groups; and
5. produces one evidence-grounded synthesis plus a coverage-verification line.

If final synthesis times out after all chunks were analyzed, CoWork preserves
the range-labelled evidence digest and reports partial success instead of
discarding the completed review work. Cancellation before complete coverage is
reported as an interruption.

## Local models

Ollama uses smaller bounded output budgets for chunk findings and synthesis.
The planner can recover numbered or bullet steps from plain-text local-model
responses when valid JSON planning output is absent. Empty responses and
token-limit truncation remain explicit failures; they are not presented as a
completed review.

## Maintainer validation

Run the focused regression coverage with:

```bash
npx vitest run \
  src/electron/agent/__tests__/document-analysis-pipeline.test.ts \
  src/electron/agent/__tests__/executor-plan-parsing.test.ts \
  src/electron/agent/__tests__/executor-tool-allowlist.test.ts \
  src/electron/agent/llm/__tests__/ollama-provider.test.ts \
  src/electron/agent/tools/__tests__/document-parser-tools.test.ts
```

See [Execution Runtime Model](execution-runtime-model.md) for the wider planning
and tool-policy contract and [Document Artifacts](document-artifacts.md) for
created or edited document outputs.
