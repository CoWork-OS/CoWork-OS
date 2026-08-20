# Unbroker Operations

Operational setup, command reference, batch sequencing, and recovery guidance. Read before running the autonomous loop in ../SKILL.md.

## Prerequisites

- `python3` (stdlib only; no extra packages needed for the core engine).
- **Optional upgrades** (the skill works zero-config without these; `setup --auto` turns on every
  one it detects, reading credentials from the shell env **and from the CoWork runtime `.env`**
  (`$COWORK_HOME/.env` or `$COWORK_USER_DATA_DIR/.env`, with upstream `$HERMES_HOME/.env` as a
  compatibility fallback) so keys already loaded for local tools are picked up without re-exporting - each one converts a
  class of human tasks into agent actions):
  - **Cloud browser (recommended default): `BROWSERBASE_API_KEY`.** `setup --auto` selects it
    whenever the key is present, and it is the intended baseline: a real residential-IP cloud
    browser **clears soft/managed CAPTCHAs (Cloudflare Turnstile, hCaptcha/reCAPTCHA checkbox) as
    normal operation**, so those brokers stay automated (T1) instead of becoming human tasks. This
    is not CAPTCHA "solving" - no solver service, no fingerprint spoofing; only interactive/behavioral
    ("hard") challenges the browser genuinely cannot pass fall back to a human task. Without the key,
    the plain agent browser is used and soft-CAPTCHA brokers drop to T2 (human).
  - Email automation, two credential-free-or-not options:
    - **Browser mode (no password): `setup --email-mode browser`.** The agent sends opt-out/CCPA
      emails and opens verification links through the operator's **logged-in webmail** using
      browser tools. Nothing is stored. This requires CoWork to be pointed at the operator's own
      logged-in browser, **NOT** a cloud browser: a headless cloud browser (Browserbase) holds no
      webmail session and is itself Cloudflare/DataDome-gated on webmail and on session-bound broker
      gates (e.g. PeopleConnect guided-mode). Drive the operator's real Chrome over CDP - launch
      `chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.cowork/chrome-debug"` (a dedicated
      debug profile signed into the webmail once, not the Default profile) and connect the browser
      tools to `127.0.0.1:9222`. **`$PDD cdp` launches this for you** (finds Chrome/Chromium/Brave/Edge,
      starts it detached on the dedicated profile, prints the CDP endpoint; `--check` to test, `--print`
      for the command). See `references/methods.md` -> "Browser backends: scan vs execute".
      Falls back to drafts for an email if the inbox isn't reachable.
    - **SMTP/IMAP (stored creds): `EMAIL_ADDRESS` + `EMAIL_PASSWORD`** (+ `EMAIL_SMTP_HOST` /
      `EMAIL_IMAP_HOST` for non-mainstream providers; gmail/outlook/yahoo/icloud/fastmail inferred).
      The CLI sends via `send-email` and reads verify links via `poll-verification`. The `agentmail`
      skill (per-broker aliases) also counts.
  - Google Sheets tracker: CoWork's Google Workspace/Sheets capability, when configured.
  - Stealth-capable browser or scraping tools for Cloudflare-protected pages, when configured.

## How to Run

Run everything through CoWork's shell/run_command tool. From this skill's directory:

```bash
PDD="python3 scripts/pdd.py"
```

The engine stores data under `$PDD_DATA_DIR` when set, otherwise under the CoWork runtime home
(`$COWORK_HOME/unbroker` or `$COWORK_USER_DATA_DIR/unbroker`, with the upstream `$HERMES_HOME`
fallback), written `0600`. Run via shell/run_command, **not** a throwaway code-execution sandbox that
scrubs env and redacts output, which breaks reading the dossier.

## Quick Reference

| Command | Purpose |
|---|---|
| `$PDD setup --auto` | **Autonomous setup**: detect capabilities, pick the most autonomous valid config (no questions) |
| `$PDD doctor` | Readiness check: config, broker count, and which upgrades are on/available |
| `$PDD cdp [--check] [--print] [--port N]` | Launch/detect the operator's Chrome over CDP for Phase-2 browser + webmail (dedicated debug profile; the reliable way to send webmail and clear session-bound gates) |
| `$PDD intake --full-name "..." [--alias ...] [--email ... --phone ...] [--city --state] [--prior-location "City,ST"] --consent` | Create a consenting subject; captures aliases + multiple emails/phones + prior locations; prints `subject_id` |
| `$PDD next <subject>` | **The autonomous loop driver**: ordered agent actions right now + human digest + `next_wake_at` |
| `$PDD brokers [--priority crucial]` | List the people-search broker database (curated + live) |
| `$PDD refresh-brokers` | Pull the latest BADBOOL people-search list **and the CA Data Broker Registry** (`next` requeues this automatically when the cache is stale) |
| `$PDD registry [--search NAME]` | State registry coverage (CA ~545 ingested; VT/OR/TX portals surfaced); the DROP/email lane, not scanned |
| `$PDD drop <subject> [--filed]` | **The one-shot legal lever**: one CA DROP request deletes from ALL registered brokers; `--filed` records it |
| `$PDD plan <subject> [--priority crucial]` | Per-broker tier + method + `search_vectors` + the exact fields to disclose |
| `$PDD plan <subject> --batch` | **Reduce view**: overlays ledger state, groups brokers by next action (unscanned/found/indirect/blocked/in_progress/done), collapses ownership clusters, **orders `found` cluster-parents-first + emits a tailored `parent_playbook`**, prints `next_actions` |
| `$PDD fanout <subject> [--priority crucial] [--size 5]` | Batch brokers into parallel CoWork subagent/multi-agent tasks when available (auto for large runs; batches of 5 - 8+ time out) |
| `$PDD record <subject> <broker> <state> [--found true] [--evidence JSON] [--disclosed F --channel C] [--reason "..."]` | Update the ledger (validated state machine); **auto-stamps `next_recheck_at`** |
| `$PDD show <subject> <broker>` | Read back a case's recorded state + evidence + disclosure log (so the parent re-verifies a subagent's `found` without re-deriving the listing URL) |
| `$PDD send-email <subject> <broker> --listing <url> [--kind ccpa_indirect ...]` | Render + record the request (recipient locked to the broker's own address). **browser** mode returns a `compose` payload to send via webmail (no password); **programmatic** mode SMTP-sends |
| `$PDD verify-link <subject> <broker> --text '<body>'` | **browser mode**: extract a broker's verification link from webmail text you read (anti-phishing scored) |
| `$PDD poll-verification <subject> [--broker <id>]` | **programmatic mode**: poll IMAP for verification links (anti-phishing scored); auto-advances `submitted → verification_pending` |
| `$PDD render-email <subject> <broker> --listing <url>` | Draft only (fallback when no email mode is configured) |
| `$PDD due <subject>` | Cases whose recheck window arrived (the cron re-scan queue) |
| `$PDD tasks <subject>` | ONE consolidated human-task digest (present at END of run) |
| `$PDD status <subject>` | Markdown status report |
| `$PDD report <subject> --sheets` | Rows for the Google Sheets tracker |

## Batch operation (two-phase: crawl-all, then delete)

For anything past a couple of brokers, run this as **map → reduce → act**, not broker-by-broker:

- **Phase 1 - DISCOVER (read-only, parallel, idempotent).** Crawl *every* broker first and record a
  verdict for each (`found` / `not_found` / `indirect_exposure` / `blocked`). Scanning has no side
  effects, so it is safe to parallelize and retry. Getting the full exposure map *before* acting is
  what unlocks cluster dedup and prioritization below. **Default: the parent drives CoWork web
  extraction/search probes directly** - most people-search sites render name/phone/address results as
  static HTML that can be read in seconds. Escalate to browser automation only for the few JS-only
  sites, and to CoWork subagents only for genuinely *reasoning*-heavy work (large-scale namesake/relative
  disambiguation). **Do NOT hand a browser-toolset subagent a big list of brokers to crawl** - in the
  field this timed out repeatedly (600s, ~5-6 brokers each, no summary) because browser navigation is
  heavy; the ledger writes that survived came at 10x the cost of parent web extraction. A `blocked`
  (DataDome/Cloudflare/`antibot`) site is *not* a subagent job either: record `blocked` and requeue it
  for a stealth/cloud browser (Browserbase) pass. Subagent reports are self-reports - the parent
  re-fetches key URLs to confirm a `found` before trusting it (this cuts both ways: it caught a real
  listing the parent had wrongly assumed was a false positive).
- **REDUCE - `$PDD plan <subject> --batch`.** Collapses the crawl into a phase-oriented plan: groups by
  next action, **collapses ownership clusters** (a parent removal that clears children is ONE action,
  not N - e.g. one Intelius/PeopleConnect suppression covers Truthfinder/Instant Checkmate/US Search/…),
  and prints `next_actions`. `phase` is `discover` while anything is unscanned, else `delete`.
- **Phase 2 - DELETE (sequential, irreversible).** Work the reduced groups **parents first**:
  `plan --batch` orders the `found` group cluster-parents-first (most children first) and emits a
  `parent_playbook` with tailored, ordered steps per parent - follow that order and those steps
  (full recipes in `references/methods.md` → "Ownership clusters - DO PARENTS FIRST"). Do the
  cluster parents (skipping the covered children), **re-scan each parent's children after it confirms**
  (they usually drop out), then the standalone listings; send the `indirect_exposure` cases as
  CCPA/GDPR delete-my-PII emails (`send-email --kind ccpa_indirect`), and defer `blocked` to the
  stealth-browser pass. Opt-outs hit CAPTCHAs, email-verification loops, and session binding - work
  them **one at a time, carefully** (this is the opposite of fan-out), but do NOT stop to ask
  permission per submission in `autonomy=full`; in `assisted`, confirm each one. **Usually prefer
  deletion over suppression** where a broker offers both (Spokeo/BeenVerified) - but follow the
  record's `deletion.prefer`: **PeopleConnect is the exception** (`prefer: false`), where deleting
  your user data removes your suppressions and does not stop public-records re-listing, so you
  suppress-and-maintain instead.
- **Blind opt-out is the DEFAULT, not a fallback.** Submit an opt-out/deletion on **every site with an
  accessible removal channel, even when a listing was not first confirmed** - it discloses only the
  subject's own identifiers to the broker's own official channel, so it does not violate
  least-disclosure. Two corollaries: (1) a guided flow that matches email+DOB+name and says "no results"
  is a **stronger `not_found`** than any scrape - the opt-out flow doubles as the search; (2) when a form
  is automation-hostile (hard CAPTCHA, Cloudflare/DataDome, slide-to-verify slider), **default to the
  broker's cited rights-request email** (name+state+contact-email only) rather than recording `blocked`.
  CAPTCHA policy: never defeat behavioral/token/slider challenges; OK to read a static distorted-text or
  plain-arithmetic CAPTCHA on the subject's own opt-out, but stop if the site rejects the whole
  submission after a correct answer (it is fingerprinting the automation). Third-party/indirect records
  are the exception - still confirm those before acting. Per-site game plans + the meta-search no-op
  skip-list are in `references/site-playbooks.md`; the full policy is in `references/methods.md`.
- **PeopleConnect delete-wipes-suppression (permanent rule).** A PeopleConnect *deletion* wipes the
  suppression and the subject re-lists across the whole affiliate cluster. If a "Your deletion request
  for PeopleConnect.us is Complete" email ever appears, the suppression is gone -> **re-run suppression
  and re-verify** the Control step reads "suppressed". Never leave this cluster on a completed deletion
  (see `references/brokers/intelius.json`).

Subagent reports are self-reports: the parent re-verifies key claims (listing URLs, match basis) before
recording `found` and before any deletion.

---

## Pitfalls

- **Never disclose more than the broker already shows.** Submit only `disclosure_fields`. The engine
  never volunteers SSN/ID numbers; you must not either.
- **No consent, no action.** The engine enforces this; do not work around it to "research" a third party.
- **`send-email` is idempotent + rate-limited.** It refuses to re-send a case already `submitted`
  or beyond (use `--force` only if a genuine re-send is needed), and SMTP sends are paced by
  `email_min_interval_seconds` (default 20s) with retry/backoff. Do not loop it to "make sure" -
  a successful SMTP handoff is not proof of delivery; the due-queue re-scan is the real confirmation.
- **Ledger writes are locked.** Concurrent runs (cron + manual) serialize safely; if you ever see a
  lock timeout, another run is mid-write - let it finish, don't delete the `.lock` by hand.
- **Autonomy ≠ improvisation.** Full autonomy means not *asking* between steps; it does not loosen any
  gate. If a broker demands MORE than the planned `disclosure_fields` mid-flow, stop that case and
  queue it (`human_task_queued --reason`) rather than deciding alone to disclose extra PII.
- **Don't interrupt the run with questions.** Config choices are `setup --auto`'s job; human-only work
  goes to the digest. The only mid-run question that's ever warranted is a missing-identity fact that
  blocks scanning (e.g. no city at all) - and that should have been collected at intake.
- **Use shell/run_command, not a throwaway code-execution sandbox** for `pdd.py` (secret scrubbing + output redaction break it).
- **Dossiers are plaintext by default** (JSON, `0600` under the CoWork runtime home unless `PDD_DATA_DIR` is set). For at-rest encryption run
  `$PDD setup --encryption age` - it generates a local `age` key and encrypts dossiers + ledgers (the
  audit log holds field names only and stays plaintext). It guards casual/backup/commit exposure, not
  a full runtime-home read; set `PDD_AGE_IDENTITY` to a separate volume for real key separation.
  `$PDD doctor` shows whether encryption is *actually* engaged (not just whether `age` is installed).
- **"Hidden from free search" ≠ deleted.** Only mark `confirmed_removed` after verifying the record is
  actually gone; note paid-tier retention in the report.
- **Soft CAPTCHAs clear by default; don't fight the hard ones.** The default cloud browser passes
  managed/soft challenges as normal operation (those brokers stay T1). For a hard interactive one it
  genuinely can't pass, record `blocked` and let the stealth/operator-browser pass take it - never a
  third-party solver service or fingerprint spoofing.
- **Broker pages change.** If a flow breaks, `$PDD record ... blocked` and flag the broker file in
  `references/brokers/` for re-verification instead of guessing.
- **Verify non-field-verified records before submitting.** `confidence: auto` records came from
  parsing BADBOOL (read `optout.notes`/`optout.links`, confirm the real opt-out URL). `confidence:
  documented` records (several people-search sites) carry the correct published opt-out URL but have
  **not** been field-verified (they 403 datacenter IPs), so confirm the live flow via the operator's
  residential browser on first use, then set `last_verified`. Field-verified curated records (no
  `confidence`, e.g. the cluster parents) have checked mechanics and take precedence.
