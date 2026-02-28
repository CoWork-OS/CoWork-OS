# YouTube — Video Intelligence

Fetch transcripts, metadata, and captions from YouTube videos. Two tools available depending on what's installed:

- **yt-dlp** — full-featured: metadata, thumbnails, subtitles, audio, chapters
- **youtube-transcript-api** (Python) — lightweight: transcripts only, with timestamps

Use whichever is available. Prefer `yt-dlp` when installed.

---

## Extracting the Video ID

YouTube URLs come in many formats. Extract the video ID first:

| URL Format | Video ID |
|------------|----------|
| `https://www.youtube.com/watch?v=dQw4w9WgXcQ` | `dQw4w9WgXcQ` |
| `https://youtu.be/dQw4w9WgXcQ` | `dQw4w9WgXcQ` |
| `https://youtube.com/embed/dQw4w9WgXcQ` | `dQw4w9WgXcQ` |
| `https://youtube.com/shorts/dQw4w9WgXcQ` | `dQw4w9WgXcQ` |
| `https://m.youtube.com/watch?v=dQw4w9WgXcQ` | `dQw4w9WgXcQ` |

Regex: `(?:v=|youtu\.be/|embed/|shorts/)([a-zA-Z0-9_-]{11})`

---

## Method 1: yt-dlp (Recommended)

### Get video metadata (no download)

```bash
yt-dlp --dump-json --no-download 'https://www.youtube.com/watch?v=VIDEO_ID' | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(f'Title: {d["title"]}')
print(f'Channel: {d["channel"]}')
print(f'Duration: {d["duration_string"]}')
print(f'Views: {d.get("view_count", "N/A"):,}')
print(f'Upload: {d["upload_date"]}')
print(f'Description: {d["description"][:500]}')
if d.get('chapters'):
    print('\nChapters:')
    for ch in d['chapters']:
        m, s = divmod(int(ch['start_time']), 60)
        print(f'  {m:02d}:{s:02d} - {ch["title"]}')
"
```

### Get available subtitles/captions

```bash
yt-dlp --list-subs --no-download 'https://www.youtube.com/watch?v=VIDEO_ID'
```

### Download transcript (auto-generated)

```bash
yt-dlp --write-auto-sub --sub-lang en --sub-format json3 --skip-download -o '/tmp/%(id)s' 'https://www.youtube.com/watch?v=VIDEO_ID'
```

Then read the subtitle file:

```bash
python3 -c "
import json
with open('/tmp/VIDEO_ID.en.json3') as f:
    data = json.load(f)
for event in data.get('events', []):
    if 'segs' in event:
        start = event.get('tStartMs', 0) / 1000
        text = ''.join(seg.get('utf8', '') for seg in event['segs']).strip()
        if text:
            m, s = divmod(int(start), 60)
            print(f'[{m:02d}:{s:02d}] {text}')
"
```

### Download manual captions (if available)

```bash
yt-dlp --write-sub --sub-lang en --sub-format json3 --skip-download -o '/tmp/%(id)s' 'https://www.youtube.com/watch?v=VIDEO_ID'
```

### Download transcript in a specific language

```bash
yt-dlp --write-auto-sub --sub-lang es --sub-format json3 --skip-download -o '/tmp/%(id)s' 'https://www.youtube.com/watch?v=VIDEO_ID'
```

Common language codes: `en`, `es`, `fr`, `de`, `pt`, `ja`, `ko`, `zh`, `ar`, `hi`, `tr`

### Download as plain text (SRT → readable)

```bash
yt-dlp --write-auto-sub --sub-lang en --sub-format srt --skip-download -o '/tmp/%(id)s' 'https://www.youtube.com/watch?v=VIDEO_ID'
cat /tmp/VIDEO_ID.en.srt | python3 -c "
import sys, re
lines = sys.stdin.read()
# Strip SRT formatting, keep text
text = re.sub(r'\d+\n[\d:,]+ --> [\d:,]+\n', '', lines)
text = re.sub(r'\n{2,}', '\n', text).strip()
print(text)
"
```

### Get chapters only

```bash
yt-dlp --dump-json --no-download 'https://www.youtube.com/watch?v=VIDEO_ID' | python3 -c "
import json, sys
d = json.load(sys.stdin)
for ch in d.get('chapters', []):
    m, s = divmod(int(ch['start_time']), 60)
    h, m = divmod(m, 60)
    ts = f'{h}:{m:02d}:{s:02d}' if h else f'{m:02d}:{s:02d}'
    print(f'{ts} - {ch["title"]}')
"
```

### Download thumbnail

```bash
yt-dlp --write-thumbnail --skip-download -o '/tmp/%(id)s' 'https://www.youtube.com/watch?v=VIDEO_ID'
```

### Extract audio only (for speech analysis)

```bash
yt-dlp -x --audio-format mp3 -o '/tmp/%(id)s.%(ext)s' 'https://www.youtube.com/watch?v=VIDEO_ID'
```

---

## Method 2: youtube-transcript-api (Python)

Lighter alternative when yt-dlp is not available.

### Fetch transcript

```bash
python3 -c "
from youtube_transcript_api import YouTubeTranscriptApi
api = YouTubeTranscriptApi()
transcript = api.fetch('VIDEO_ID')
for entry in transcript:
    m, s = divmod(int(entry.start), 60)
    print(f'[{m:02d}:{s:02d}] {entry.text}')
"
```

### Fetch in a specific language

```bash
python3 -c "
from youtube_transcript_api import YouTubeTranscriptApi
api = YouTubeTranscriptApi()
transcript = api.fetch('VIDEO_ID', languages=['es', 'en'])
for entry in transcript:
    m, s = divmod(int(entry.start), 60)
    print(f'[{m:02d}:{s:02d}] {entry.text}')
"
```

### List available transcripts

```bash
python3 -c "
from youtube_transcript_api import YouTubeTranscriptApi
api = YouTubeTranscriptApi()
transcripts = api.list('VIDEO_ID')
for t in transcripts:
    kind = 'manual' if not t.is_generated else 'auto'
    print(f'{t.language_code} ({t.language}) [{kind}]')
"
```

### Fetch as plain text (no timestamps)

```bash
python3 -c "
from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api.formatters import TextFormatter
api = YouTubeTranscriptApi()
transcript = api.fetch('VIDEO_ID')
print(TextFormatter().format_transcript(transcript))
"
```

### Fetch as JSON

```bash
python3 -c "
from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api.formatters import JSONFormatter
api = YouTubeTranscriptApi()
transcript = api.fetch('VIDEO_ID')
print(JSONFormatter().format_transcript(transcript, indent=2))
"
```

### Fetch as SRT

```bash
python3 -c "
from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api.formatters import SRTFormatter
api = YouTubeTranscriptApi()
transcript = api.fetch('VIDEO_ID')
print(SRTFormatter().format_transcript(transcript))
"
```

### CLI usage (if installed via pip)

```bash
youtube_transcript_api VIDEO_ID
youtube_transcript_api VIDEO_ID --languages en es
youtube_transcript_api VIDEO_ID --format json
youtube_transcript_api VIDEO_ID --translate de
youtube_transcript_api --list-transcripts VIDEO_ID
```

---

## Common Workflows

### "Summarize this YouTube video"

1. Extract video ID from the URL
2. Fetch metadata (title, channel, duration, chapters) with `yt-dlp --dump-json`
3. Fetch the full transcript
4. If chapters exist, organize the transcript by chapter sections
5. Summarize each section, then provide an overall summary

### "What did they say about X?"

1. Fetch the transcript with timestamps
2. Search for keywords related to X
3. Return the relevant segments with timestamps so the user can jump to that part
4. Format: `[12:34] "exact quote about X..."`

### "Compare these two videos"

1. Fetch transcripts for both videos
2. Identify key topics in each
3. Compare coverage, positions, and depth on shared topics
4. Note unique points each video makes

### "Extract all links/resources mentioned"

1. Fetch transcript + description
2. Parse description for URLs
3. Scan transcript for mentioned tools, books, websites
4. Compile a list with timestamps where each was mentioned

### "Turn this video into a blog post"

1. Fetch metadata + chapters + transcript
2. Use chapters as section headings (or create logical sections)
3. Clean up spoken language to written prose
4. Add the video link as source attribution

### "Pull the key quotes with timestamps"

1. Fetch transcript with timestamps
2. Identify notable/quotable statements
3. Return as: `[MM:SS] "quote"` — each linking to that moment
4. YouTube timestamp link format: `https://youtube.com/watch?v=VIDEO_ID&t=XXs`

---

## Timestamp Links

To link to a specific moment in a video:

```
https://youtube.com/watch?v=VIDEO_ID&t=123s
https://youtu.be/VIDEO_ID?t=123
```

Where `123` is the time in seconds. When showing quotes or references, always include a timestamp link so the user can verify.

---

## Formatting Guidelines

When presenting video content:

- **Always show the video title, channel, and duration** at the top
- **Include chapter breakdown** if available — it's the creator's own outline
- **Timestamps as [MM:SS]** — not raw seconds
- **Quotes in quotation marks** with timestamps
- **Distinguish manual vs auto-generated** captions — manual are more reliable
- **For long videos (>30 min)**, summarize by chapter/section rather than one big summary
- **Link to specific moments** using YouTube's `&t=` parameter
- **Note transcript quality** — auto-generated captions lack punctuation and may have errors in names/jargon

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

---

## Notes

- **No API key required** — both yt-dlp and youtube-transcript-api work without authentication
- **Auto-generated captions** are available for most videos but may have transcription errors, especially with names, technical terms, and non-English accents
- **Manual captions** (uploaded by creators) are more accurate but less common
- **Some videos disable captions** — if no transcript is available, fall back to the video description + chapters
- **Playlists**: yt-dlp can process entire playlists — use `--flat-playlist` to list videos without downloading
- **Age-restricted videos** may require cookies — use `yt-dlp --cookies-from-browser chrome`
- **Rate limiting**: YouTube may throttle repeated requests — space out batch operations
- **Subtitle files are saved to /tmp** by default — clean up after processing
- **yt-dlp updates frequently** — run `yt-dlp -U` to update if something breaks
