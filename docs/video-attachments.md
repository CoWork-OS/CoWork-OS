# Video Attachments

CoWork can accept uploaded videos in task and follow-up prompts, extract representative still frames, pass those frames to image-capable models, and show the extracted screenshots in the task timeline.

This feature is for analyzing a user-provided video. It is separate from video generation, YouTube transcript ingestion, Browser Workbench screenshots, and the `manim-video` skill.

## User Experience

Attach a local `.mp4`, `.mov`, or `.webm` file to a task and ask a visual question such as:

```text
Inspect this video and summarize the UI states, visible errors, and final outcome.
```

When the task starts, CoWork:

1. Copies the uploaded video into the workspace upload area.
2. Extracts up to 10 representative frames with `ffmpeg`.
3. Builds a 5x2 contact sheet plus a representative full frame.
4. Sends the extracted images to the active image-capable model as visual input.
5. Emits the contact sheet and representative frame as image artifacts in the task timeline.
6. Stores generated previews under `.cowork/video-frames/...` so the renderer can open them with the same workspace-contained file preview path as other artifacts.

The timeline should show the extracted screenshots inline, similar to generated image artifacts. The model also receives a prompt note telling it to use the attached extracted frames as primary visual evidence instead of probing the original video with shell, glob, or file tools unless the user explicitly asks for deeper media forensics.

## Supported Formats

| Extension | MIME type |
|-----------|-----------|
| `.mp4` | `video/mp4` |
| `.mov` | `video/quicktime` |
| `.webm` | `video/webm` |

Videos are accepted only as file-backed attachments. Base64 inline video payloads are rejected because large video data should stay on disk and be sampled into frames.

The current upload validation limit is 500 MB per video. Image attachment limits remain separate from video limits.

## Model Requirements

Video attachment analysis depends on image input support because CoWork samples the video into still frames before calling the model.

If the active provider does not support image input, the task returns a user-facing message asking the user to switch to an image-capable model/provider and resend the video. The video is not silently analyzed through text-only fallback.

## Timeline And Artifacts

The extracted preview images are emitted as normal image artifacts:

- `Video contact sheet: <filename>`
- `Video representative frame: <filename>`

Artifact paths are workspace-relative when possible, for example:

```text
.cowork/video-frames/screen-recording-abc123/contact_sheet.jpg
.cowork/video-frames/screen-recording-abc123/frame_010.jpg
```

The renderer already treats `artifact_created` / `timeline_artifact_emitted` image events as inline image previews, so video screenshots use the existing artifact preview path instead of a separate video-only UI.

CoWork deduplicates these preview artifact events inside the executor. This prevents plan creation and step execution from showing duplicate screenshots when both phases build the same prompt content.

## Failure Behavior

If `ffmpeg` or `ffprobe` cannot extract frames, CoWork logs a concise skipped-extraction message and continues with a note that the video is available on disk. The agent should not repeatedly run blind shell/glob discovery against the upload path unless the user asks for deeper local media inspection.

Dev-log classification also treats command-start lines containing options such as `ffprobe -v error` as normal command text rather than application errors. Actual failed commands still appear through tool result status and structured task events.

## Implementation Landmarks

- `src/electron/preload.ts`: accepts video file attachments, MIME types, extensions, and size limits.
- `src/electron/utils/validation.ts`: validates video attachment shape and rejects inline video data.
- `src/renderer/components/MainContent/MainContent.tsx`: builds native visual attachments for uploaded videos while keeping video paths out of the text attachment summary that can trigger unnecessary file probing.
- `src/electron/agent/executor.ts`: extracts frames with `ffmpeg`, probes duration with `ffprobe`, attaches sampled frames to the model prompt, and emits timeline image artifacts.
- `src/renderer/components/MainContent/artifact-logic.ts` and `src/renderer/components/MainContent/timeline-event-rendering.tsx`: render emitted image artifacts inline in the task feed.

## Validation

Focused checks for this feature:

```bash
npx vitest run src/electron/agent/__tests__/executor-image-attachments.test.ts src/electron/utils/__tests__/validation.test.ts src/electron/ipc/__tests__/video-preview-transcode.test.ts tests/dev-log-utils.test.ts
npm run type-check
git diff --check
```

Manual smoke test:

1. Start a new task with an attached `.mp4`, `.mov`, or `.webm`.
2. Ask CoWork to inspect the video.
3. Confirm the task timeline shows a contact sheet and representative frame.
4. Confirm the agent answer references visible evidence from those frames.
5. Confirm the task does not produce a run-command/glob failure storm for basic video inspection.

## Related Docs

- [Everything Workbench](everything-workbench.md)
- [Features](features.md)
- [Getting Started](getting-started.md)
- [Use Cases](use-cases.md)
