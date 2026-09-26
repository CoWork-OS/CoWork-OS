# Meeting Artifacts

CoWork can save post-meeting transcripts as local Markdown notes, then let the agent read them to summarize meetings, extract decisions, or draft follow-ups. Live joining and live captions are not supported.

## Microsoft Teams

**Settings > Integrations > Teams meeting transcripts** saves transcripts of Teams meetings **you organize**. Microsoft only lets delegated access read transcripts for the organizer, so meetings you only attended are skipped.

### Requirements

- An Azure app registration (single or multi-tenant) with the redirect URI `http://localhost:18767` (public client / mobile and desktop).
- Delegated Graph permissions: `Calendars.Read`, `OnlineMeetings.Read`, `OnlineMeetingTranscript.Read.All`, `OnlineMeetingRecording.Read.All`, plus `offline_access` and `User.Read`. The two `*.Read.All` permissions need admin consent.
- A tenant administrator must allow Graph API access to meeting transcripts. If it is off, the status shows **Blocked by tenant policy** and sync stops until access is enabled.
- Transcription must be turned on in the meeting itself.

### How it works

1. **Discovery (always on).** Every 15 minutes (configurable, 5–240) CoWork reads your calendar for the look-back window (default 48 hours), picks Teams meetings that ended at least five minutes ago, resolves each join link to an online meeting, and lists its transcripts. No public URL is needed.
2. **Jobs.** Each transcript becomes an idempotent job keyed by meeting and transcript ID. Jobs survive restarts, retry with exponential backoff (up to six attempts), and a transcript is never fetched twice once saved. Deleted transcripts are dropped, and expired sign-ins stop the pipeline with **Sign-in expired** instead of retrying.
3. **Artifacts.** The transcript is fetched as WebVTT and written as Markdown with the meeting title, organizer, times, participants, join link and speaker-attributed turns. Files live under the CoWork user-data folder in `meeting-artifacts/artifacts/teams/`, readable only by your user account.
4. **Recordings.** Recording metadata is listed on each artifact. Recordings are downloaded **only when you click Download** (up to 4 GB).

### Optional change notifications

Setting a **public notification URL** (an HTTPS address that forwards to the local notification port, default `3984`) makes new transcripts arrive sooner:

- CoWork subscribes to `users/{you}/onlineMeetings/getAllTranscripts` with basic (no resource data) notifications and a `clientState` secret; notifications that do not echo it are ignored.
- Subscriptions last about 70 hours (Graph's limit for transcripts is three days) and are renewed 12 hours before they expire. Lifecycle notifications are handled: `reauthorizationRequired` renews, `subscriptionRemoved` recreates, and `missed` triggers a discovery pass.
- Notifications only trigger discovery; polling remains the source of truth, so a missed or failed subscription never loses a transcript. Subscription problems appear in the panel while polling continues.

### Agent access

Two read-only tools expose saved artifacts: `meeting_artifacts_list` and `meeting_artifact_get`. Nothing is sent to Teams, Notion or Linear automatically.

## Google Meet

The Google Workspace connector can read past Meet conferences when you tick **Also allow read-only access to Google Meet conference records** in its setup (scope `meetings.space.readonly`, never part of the default consent):

- `google-workspace.meet_conferences_list`: find conferences by meeting code or start time.
- `google-workspace.meet_conference_get`: attendance (join and leave times), recordings, transcripts and smart notes with their Drive/Docs links.
- `google-workspace.meet_transcript_entries`: speaker-attributed transcript entries, optionally as Markdown.

Google deletes transcript **entries** 30 days after the conference ends (the Docs copy follows Drive retention), so retrieve and save transcripts soon after the meeting. Automatic background capture for Meet, like the Teams pipeline, is not implemented yet.
