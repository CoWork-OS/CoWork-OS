---
name: unbroker
description: Find and remove authorized personal information exposures from data brokers and people-search sites with a consent-gated local workflow.
version: "1.0.0"
metadata:
  author: CoWork OS Contributors <info@coworkosapp.com>
  source-author: "SHL0MS / Nous Research, ported by CoWork OS"
---

# unbroker

This CoWork OS bundled port is based on the upstream Hermes Agent `unbroker` skill:
https://github.com/NousResearch/hermes-agent/tree/main/optional-skills/security/unbroker

CoWork runtime mapping:

- Treat `terminal` as CoWork's shell/run_command capability.
- Treat `web_extract` as CoWork web search, fetch, or extraction tools.
- Treat `browser_*` as the available CoWork browser automation tools.
- Treat `delegate_task` as CoWork multi-agent orchestration when available.
- Treat `cronjob` as CoWork scheduling/automation.
- The Python engine stores data under `$PDD_DATA_DIR` when set. Otherwise it prefers
  `$COWORK_HOME/unbroker`, then `$COWORK_USER_DATA_DIR/unbroker`, then the upstream legacy
  `$HERMES_HOME/unbroker` / `~/.hermes/unbroker` path.

Code is MIT licensed. Broker data includes BADBOOL-derived data under CC BY-NC-SA 4.0; keep the
license and attribution notes in `LICENSE.txt` and the README intact when redistributing.

Find where a person's personal information (name, addresses, phone, email, relatives) is exposed on
data brokers and people-search sites, then remove it - automatically where possible, with guided
human steps only where a site demands a CAPTCHA, government ID, phone call, or fax. Manages multiple
people independently. It does **not** defeat anti-bot systems, does **not** act on anyone without
recorded consent, and does **not** remove public records (voter/property/court) or accounts the
person controls.

The Python CLI (`scripts/pdd.py`) owns the deterministic state - config, dossiers + consent, the
broker database, tier planning, the ledger, drafts, reports, **email sending (SMTP), verification-link
polling (IMAP), and the autonomous action queue (`next`)**. You (the agent) do the scanning,
form-driving, parallel work, and scheduling with the matching CoWork tools.

## Autonomy contract

This skill is designed to run **hands-off**. After intake (+ recorded consent) there are exactly TWO
legitimate human touchpoints: (1) the intake conversation itself, and (2) ONE consolidated human-task
digest at the end of the run (`$PDD tasks`). Between those:

- **Never ask the operator to choose configuration.** `$PDD setup --auto` detects capabilities and
  picks the most autonomous valid config itself.
- **Never pause before individual submissions** when `autonomy=full` (the default): the consent
  recorded at intake is standing authorization for T0-T2 opt-outs. (`autonomy=assisted` restores
  per-submission confirmation for cautious operators - honor `confirm_first` flags in `next` output.)
- **Never interrupt the run for human-only work.** Record it (`record ... human_task_queued
  --reason "..."`) and keep going; it all surfaces once in the final digest.
- **Drive the whole run as a loop over `$PDD next <subject>`** - it returns the exact ordered actions
  to take right now (scan, poll verification, re-check, opt out parents-first, requeue blocked), plus
  the human digest. Execute every action, record outcomes, re-run `next`, repeat until
  `done_for_now`. Then present the digest, report, and schedule the cron.

The hard limits that autonomy never overrides: no acting without recorded consent, no disclosure
beyond `disclosure_fields`, no CAPTCHA/anti-bot bypass, and `confirmed_removed` only after a
verifying re-scan.

## When to Use

- "Remove my (or my family member's) data from data brokers / people-search sites."
- "Opt me out", "delete me from Spokeo/Whitepages/etc.", "clean up after a doxxing."
- "Set up recurring privacy monitoring" (brokers re-list people).
- Checking which brokers still expose someone and why.

## Operational setup

Before running any command, read [references/operations.md](references/operations.md) for prerequisites, safe command syntax, quick reference, batch sequencing, consent boundaries, and failure recovery. Never infer consent or submit removals outside the recorded scope.

## Procedure (the autonomous loop)

1. **Setup (once, no questions).** Run `$PDD setup --auto` - it detects capabilities and configures
   the most autonomous valid combination itself (programmatic email when `EMAIL_*` creds exist,
   Browserbase when its key exists, `age` encryption when the binary exists, `autonomy=full`). Then
   `$PDD doctor` and show the operator the readiness output **for information, not as a question** -
   proceed immediately. Mention what would unlock more automation (e.g. email creds) but do not wait.
2. **Intake + consent (the ONE human conversation).** `$PDD intake ...` with `--consent` (and
   `--consent-method`). Without consent the engine refuses to plan or act. Collect everything in one
   pass - names/aliases, current + prior cities, emails, phones - so you never have to come back with
   questions. For California subjects, also read `references/legal/drop.md`: `next` will surface a
   `drop_submit` one-shot that deletes from every registered broker (~545) at once, which is the
   single highest-leverage action. File it, then `drop <subject> --filed`. For non-CA subjects the
   registry is covered by targeted CCPA/GDPR emails (`registry --search`, then `send-email`); the
   people-search sites are worked directly in either case.
3. **Drain the queue.** Loop:

   ```
   while true:
     q = $PDD next <subject>
     if q.actions is empty: break
     execute EVERY action in order; record each outcome via $PDD record
   ```

   `next` emits, in order: `refresh_brokers` (stale cache), `fanout_scan`/`scan_inline` (Phase 1
   crawl - see step 4), `poll_verification` (in-flight email confirmations), `verify_removal` (due
   re-checks), `optout_web_form`/`optout_email_send` (Phase 2, parents-first with playbook steps),
   `indirect_email_send`, and `stealth_rescan`. Human-only work never appears as an action - it
   accumulates in `q.human_digest`. In `autonomy=full`, execute actions without pausing; honor
   `confirm_first` in `assisted` mode.
4. **Scanning (when `next` says so).** For `fanout_scan`: run `$PDD fanout <subject>` and **spawn one
   CoWork subagent per `batch`, in parallel when multi-agent tools are available, passing that batch's ready-made `brief`** - do
   not scan all brokers yourself sequentially. For `scan_inline`: scan the few brokers yourself.
   Either way, each broker gets **every** `search_vectors` entry via the `references/methods.md`
   ladder (web extraction -> `site:` probe -> browser automation -> stealth-capable browser/scraping), a 404 is INCONCLUSIVE
   (not `not_found`), `blocked` is recorded when `antibot` is set and no stealth browser is available,
   and subject vs namesake/relative is confirmed before recording:
   `$PDD record <subject> <broker> <found|not_found|indirect_exposure|blocked> --found <bool> --evidence '{"listing_urls":[...]}'`.
   The parent re-verifies key `found` claims from subagents before trusting them.
5. **Opt-outs (when `next` says so).** Actions come pre-ordered parents-first with `steps` from each
   broker record's own `optout.playbook` (field-verified; cluster parents like PeopleConnect,
   Whitepages, BeenVerified, Spokeo have exact, live-checked recipes). **Deletion usually beats
   suppression**: when an action carries `prefer_deletion`, complete the record's DELETION lane, not
   just the hide-my-listing flow. When it carries `prefer_suppression` instead (**PeopleConnect** -
   deleting removes your suppressions and does not stop re-listing), do the suppression flow and keep
   it maintained; use their Delete button only for a deliberate data-purge. Per method:
   - **web_form** → drive `optout_url` with `browser_navigate`/`browser_type`/`browser_click`, submit
     only `disclosure_fields`, screenshot the confirmation, then the action's `after` record command.
     Playbooks may end with a right-to-delete `send-email` follow-up - do it (full erasure, not just
     listing suppression).
    - **email** → `$PDD send-email <subject> <broker> --kind <ccpa|gdpr|generic> --to <addr>
      --listing <url>` records + discloses in one step (recipient locked to addresses the broker
      record declares; `next` picks the kind from residency - never claim CCPA/GDPR for someone who
      can't). In **browser** mode it returns a recipient-locked `compose` payload: compose a new
      message to `compose.to` with `compose.subject`/`compose.body` exactly in the operator's webmail
      via CoWork browser tools and send (no password); in **programmatic** mode it SMTP-sends. `next` also
      routes human-gated forms (phone-callback/gov-ID) through a broker's deletion email when one
      exists - the **rescue lane** (verified Whitepages pattern). Draft-only falls back to
      `render-email` + a digest entry.
   - **captcha** → soft/managed challenges clear automatically on the default cloud browser (proceed
     as normal); only a hard interactive/behavioral challenge it can't pass is recorded `blocked`
     (requeued for the stealth/operator-browser pass). Never a solver service.
   - **phone_callback / account / gov_id / fax / mail / voice (T3)** *without a deletion email* →
     never an agent action; `next` already routed these to the digest. Record them:
     `$PDD record <subject> <broker> human_task_queued --reason "..."`.
 6. **Verification (when `next` says so).** In **programmatic** mode `$PDD poll-verification <subject>`
    finds arrived confirmation links via IMAP (anti-phishing scored, auto-advances state). In
    **browser** mode, open the broker's confirmation email in the operator's webmail and run
    `$PDD verify-link <subject> <broker> --text '<body>'` to score the link. Either way **open the
    link in the same browser** (several brokers bind the verification session to the browser that
    opens it), finish the flow, then record `awaiting_processing`. `confirmed_removed` ONLY after a
    verifying re-scan shows the listing gone - never off the submission flow's own confirmation page.
7. **Wrap up (once per run).** When `next` returns no actions: present `$PDD tasks <subject>` (the
   consolidated human digest) if non-empty, then `$PDD status <subject>`; if the Sheets tracker is
   on, append `$PDD report <subject> --sheets` rows via CoWork's Google Sheets/Workspace capability.
8. **Schedule the next wake-up.** `next` returns `next_wake_at` (earliest due re-check). Create ONE
   CoWork scheduled automation that re-runs this skill's loop for the subject (a prompt like: *"run the
   unbroker loop for <subject_id>: `$PDD next` and execute all actions"*). Processing
   windows, verification polls, and reappearance sweeps all flow through the same queue, so the case
   keeps advancing with zero human attention.

## Pitfalls

Apply the safety and recovery rules in [references/operations.md](references/operations.md), especially around CAPTCHA, verification links, duplicate submissions, rate limits, and evidence capture.

## Verification

- `scripts/run_tests.sh tests/skills/test_unbroker_skill.py` (hermetic; no network), or the
  dependency-free runner `python3 tests/skills/test_unbroker_skill.py`.
- Dry run: `$PDD setup --auto && $PDD doctor && SID=$($PDD intake --full-name "Test Person"
  --email t@example.com --consent | python3 -c 'import sys,json;print(json.load(sys.stdin)["subject_id"])')
  && $PDD next "$SID"` and confirm a readiness summary plus an ordered action queue.
