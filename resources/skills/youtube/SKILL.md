---
name: youtube
description:
  Fetch transcripts, metadata, and captions from YouTube videos.
  Use when you need to summarize a video, answer questions about its content,
  extract key points, compare videos, or pull quotes with timestamps.
homepage: https://github.com/yt-dlp/yt-dlp
metadata:
  {
    "cowork":
      {
        "emoji": "📺",
        "category": "Tools",
        "requires": { "anyBins": ["yt-dlp", "python3"] },
        "install":
          [
            {
              "id": "brew-yt-dlp",
              "kind": "brew",
              "formula": "yt-dlp",
              "bins": ["yt-dlp"],
              "label": "Install yt-dlp (brew)",
              "os": ["darwin", "linux"],
            },
          ],
      },
  }
---

# YouTube 📺

Fetch transcripts, metadata, chapters, and captions from YouTube videos. Summarize content, answer questions, extract quotes with timestamps, and turn videos into written content.

## Overview

This skill provides two methods for accessing YouTube video content:

| Tool | Install | Capabilities |
|------|---------|-------------|
| **yt-dlp** | `brew install yt-dlp` | Metadata, chapters, thumbnails, subtitles (auto + manual), audio extraction, playlists |
| **youtube-transcript-api** | `pip install youtube-transcript-api` | Transcripts with timestamps, language selection, translation, multiple export formats |

Both work without API keys. The skill prefers yt-dlp when available.

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | No | YouTube video URL or video ID |

## Install

```bash
# Recommended: yt-dlp via Homebrew
brew install yt-dlp

# Alternative: Python transcript API
pip install youtube-transcript-api
```

## Video ID Extraction

The skill handles all standard YouTube URL formats:

| URL Format | Video ID |
|------------|----------|
| `youtube.com/watch?v=dQw4w9WgXcQ` | `dQw4w9WgXcQ` |
| `youtu.be/dQw4w9WgXcQ` | `dQw4w9WgXcQ` |
| `youtube.com/embed/dQw4w9WgXcQ` | `dQw4w9WgXcQ` |
| `youtube.com/shorts/dQw4w9WgXcQ` | `dQw4w9WgXcQ` |

## Capabilities

### With yt-dlp

- **Video metadata** — title, channel, duration, views, upload date, description
- **Chapters** — creator-defined chapter list with timestamps
- **Subtitles/captions** — auto-generated and manual, any language
- **Subtitle formats** — json3, srt, vtt
- **Thumbnails** — download video thumbnail
- **Audio extraction** — extract audio as mp3 (for speech analysis)
- **Playlists** — list and process entire playlists

### With youtube-transcript-api

- **Transcripts** — full text with timestamps
- **Language selection** — fetch in specific languages, with priority ordering
- **Translation** — translate captions via YouTube's built-in translation
- **Transcript types** — filter manual vs auto-generated
- **Export formats** — JSON, text, SRT, WebVTT, pretty-print
- **CLI mode** — standalone command-line usage

## Common Workflows

### Summarize a video

1. Fetch metadata (title, channel, duration, chapters)
2. Fetch full transcript
3. Organize by chapter sections if available
4. Summarize each section, then overall summary

### Find what they said about X

1. Fetch transcript with timestamps
2. Search for relevant keywords
3. Return matching segments as `[MM:SS] "quote"`
4. Include YouTube timestamp links for verification

### Compare two videos

1. Fetch transcripts for both
2. Identify key topics in each
3. Compare coverage, positions, and depth
4. Note unique points per video

### Extract resources/links mentioned

1. Fetch transcript + description
2. Parse description for URLs
3. Scan transcript for mentioned tools, books, sites
4. Compile list with timestamps

### Turn video into blog post

1. Fetch metadata + chapters + transcript
2. Use chapters as section headings
3. Clean spoken language to written prose
4. Add video link as source attribution

### Pull key quotes with timestamps

1. Fetch transcript with timestamps
2. Identify notable statements
3. Format as: `[MM:SS] "quote"`
4. Link format: `https://youtube.com/watch?v=VIDEO_ID&t=XXs`

## Output Formatting

When presenting video content:

- Show **title, channel, and duration** at the top
- Include **chapter breakdown** if available
- Timestamps as **[MM:SS]**, not raw seconds
- **Quotes in quotation marks** with timestamps
- Distinguish **manual vs auto-generated** captions
- For videos **>30 min**, summarize by section
- **Link to specific moments** with `&t=` parameter
- Note **transcript quality** — auto-generated may have errors

### Example output

```
📺 How to Build a Startup in 2026 — Y Combinator (42:15)
   Channel: Y Combinator  |  Views: 1.2M  |  Uploaded: 2026-01-15

   Chapters:
   00:00 - Introduction
   03:22 - Finding a co-founder
   12:45 - Validating your idea
   24:10 - First 100 users
   35:30 - Fundraising mistakes

   Key points:
   • [03:45] "The best co-founder is someone you've already worked with"
   • [13:20] Talk to 50 potential customers before writing a line of code
   • [25:15] Launch in a community where your first users already hang out
   • [36:00] "Don't raise more than you need — it changes your psychology"
```

## Comparison with ClawHub Version

| Feature | ClawHub (youtube-watcher) | CoWork OS |
|---------|--------------------------|-----------|
| Transcript fetching | Yes | Yes — two methods (yt-dlp + Python API) |
| Video metadata | Not mentioned | Title, channel, duration, views, upload date, description |
| Chapter support | Not mentioned | Full chapter extraction and section-based summaries |
| Language selection | Not mentioned | Any language, priority ordering, translation |
| Manual vs auto captions | Not mentioned | Explicit filtering and quality notes |
| Timestamp links | Not mentioned | YouTube `&t=` deep links for every quote |
| Audio extraction | Not mentioned | mp3 extraction via yt-dlp |
| Thumbnail download | Not mentioned | Via yt-dlp |
| Playlist support | Not mentioned | Via yt-dlp `--flat-playlist` |
| Export formats | Not mentioned | JSON, text, SRT, WebVTT |
| Common workflows | Basic summarize/Q&A | 6 detailed workflows (summarize, search, compare, extract, blog, quotes) |
| Output formatting | Not documented | Structured format with example template |
| Install options | Not documented | brew + pip with eligibility checking |

## Notes

- No API key required
- Auto-generated captions may have errors with names, jargon, and accents
- Some videos disable captions — fall back to description + chapters
- Age-restricted videos may need cookies: `yt-dlp --cookies-from-browser chrome`
- Update yt-dlp regularly: `yt-dlp -U`
- Subtitle files save to `/tmp` by default — clean up after processing
