---
name: youtube
description: "Fetch transcripts, metadata, and captions from YouTube videos. Use when you need to summarize a video, answer questions about its content, extract key points, compare videos, or pull quotes with timestamps. Supports auto-generated and manual captions, multiple languages, and translation."
---

# YouTube

## Purpose

Fetch transcripts, metadata, and captions from YouTube videos. Use when you need to summarize a video, answer questions about its content, extract key points, compare videos, or pull quotes with timestamps. Supports auto-generated and manual captions, multiple languages, and translation.

## Routing

- Use when: User shares a YouTube link, asks to summarize a video, wants to know what a video says, asks to extract information from a YouTube video, or needs video transcripts
- Do not use when: User wants to upload or stream video, manage a YouTube channel, or edit video files
- Outputs: Video transcripts with timestamps, summaries, key quotes, metadata, chapter breakdowns
- Success criteria: User receives accurate transcript content with timestamps and clear formatting

## Trigger Examples

### Positive

- Use the youtube skill for this request.
- Help me with youtube.
- User shares a YouTube link, asks to summarize a video, wants to know what a video says, asks to extract information from a YouTube video, or needs video transcripts
- YouTube: provide an actionable result.

### Negative

- User wants to upload or stream video, manage a YouTube channel, or edit video files
- Do not use youtube for unrelated requests.
- This request is outside youtube scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| url | string | No | YouTube video URL or video ID |

## Runtime Prompt

- Current runtime prompt length: 821 characters.
- Runtime prompt is defined directly in `../youtube.json`. 
