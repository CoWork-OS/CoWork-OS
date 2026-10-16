---
name: pdf-storybook
description: "Turn a dense PDF or document into an illustrated, partly animated scrollable web story in Live Canvas, using generate_image, generate_video and canvas assets."
version: "1.0.0"
metadata:
  author: CoWork OS Contributors <info@coworkosapp.com>
---

# PDF Storybook

## Purpose

Turn a dense PDF or document into an illustrated, partly animated scrollable web story in Live Canvas, using generate_image, generate_video and canvas assets.

## Routing

- Use when: Use when the user asks to turn a PDF, paper, textbook chapter or report into an illustrated or animated story, storybook, scrollable explainer page or interactive visual web app.
- Do not use when: Do not use for plain summaries, slide decks, Word or PDF documents, or videos rendered to MP4; use the summarize, slides, document or video skills instead.
- Outputs: A Live Canvas page with chapters, generated pictures and optional clips, plus an exportable folder.
- Success criteria: Every chapter's text is grounded in the source, all media loads from canvas assets, and the page scrolls with a working timeline.

Goal: turn a dense document (paper, textbook chapter, report) into an illustrated, scroll-driven web story in Live Canvas: one chapter per key idea or period, each with a generated picture, some with a short animated clip, and plain-language text grounded in the source.

## 1. Read the whole source

- Call `parse_document` on the file. If the result has `next_start_char`, keep calling with `start_char` until the whole document is read.
- If `pdf_extraction.status` is `preview` or `ocr`, tell the user the text is partial and work from what was read.
- For figures that matter (charts, diagrams), `read_pdf_visual` can describe specific pages.

## 2. Outline before generating anything

- Pick 5-8 chapters that follow the document's own structure (eras, stages, steps or sections). Each chapter gets: a short title, a 1-line label for the timeline (e.g. a date range or step number), 60-120 words rewritten for a general reader, and one visual idea (a single concrete scene, not a collage).
- Keep every claim traceable to the source. Do not invent numbers, dates or names.
- Pick one art direction for the whole story (medium, palette, lighting, framing), written as one reusable style sentence.

## 3. Create the canvas early

- `canvas_create` with the document title.
- `canvas_push` the full page layout right away with all chapter text and empty media slots (a soft gradient placeholder per chapter), so the user sees progress while media is generated.

## 4. Generate pictures with one consistent style

- Generate chapter 1's picture first with `generate_image` (`aspectRatio: "16:9"`; prompt = scene + style sentence). Pass that file in `referenceImages` for every later picture so palette and rendering stay consistent.
- After each picture: `canvas_add_asset` with the returned path, then update that chapter's `<img src="assets/...">` and `canvas_push` again.

## 5. Animate a few chapters

- Pick the 2-4 chapters that benefit most from motion. Call `generate_video` with `mode: "image_to_video"`, `referenceImagePath` set to that chapter's picture, and a short motion prompt (camera drift, weather, a figure walking). Keep clips short (`duration` 4-8 s), no on-screen text.
- Video jobs run in the background: start them all, keep working, and check with `get_video_generation_job`.
- When a clip finishes: `canvas_add_asset`, then swap the chapter's picture for `<video src="assets/..." poster="assets/<picture>" muted loop playsinline>`. Keep the picture as the poster.
- If no video provider is configured, skip this step and say so; the story still works with pictures plus subtle CSS motion (slow zoom or pan).

## 6. Page layout

- Single self-contained HTML file (inline CSS and JS, no external scripts or fonts required).
- Title block: source label, large serif title.
- Sticky vertical timeline on the left (top on narrow screens) listing the chapter labels; highlight the active chapter with an IntersectionObserver; clicking a label scrolls to that chapter.
- Each chapter: full-width rounded media (16:9, object-fit cover), then the text. Videos play only while in view (IntersectionObserver play/pause) and respect `prefers-reduced-motion` (show the poster only).
- Readable text: 17-19px, line length about 65 characters, good contrast over a light paper background.

## 7. Check and hand off

- `canvas_snapshot` and look at it: no broken media, no overlapping text, timeline visible. Fix and push again if needed.
- Offer `canvas_export` so the user gets a folder (index.html + assets/) they can open or share.
- Finish with: chapters covered, which ones are animated, providers used, and any parts of the source that were skipped or only partly read.
