# Interrupted turn recovery

Interrupted turns expose Resume and Discard turn in the main conversation, even
if the right panel is closed or progress projection is unavailable. Resume can
reconstruct an executor from durable state. Discard uses the existing task
cancellation path and retains the transcript and saved outputs. The backend checks the
interrupted state and revision and fences resume during cleanup; a stale Discard is refused.

The Desktop acceptance runner also submits Discard against an active turn and verifies
that the backend refuses it without cancelling the task. Full crash/restart recovery
is covered by durable-state unit tests; this runner does not force-crash Electron.

After building Electron and the renderer, the same acceptance flow can use built files:

```sh
COWORK_QA_RENDERER=production node scripts/qa/queued-input-runtime-acceptance.mjs
```

The default remains `npm run dev`. Both modes use an isolated profile and loopback provider.
