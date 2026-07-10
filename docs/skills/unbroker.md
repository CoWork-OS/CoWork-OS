# Unbroker Skill

`unbroker` is a bundled CoWork OS global skill for authorized personal-data cleanup across data brokers and people-search sites.

It is designed for:

- removing your own data from people-search and data-broker sites
- helping a family member or client who has explicitly authorized the cleanup
- cleaning up broker exposure after doxxing or harassment
- filing broker opt-outs, CCPA/CPRA/GDPR deletion requests, and recurring rechecks
- tracking which brokers are submitted, blocked, awaiting verification, or confirmed removed

It is not for:

- finding or enriching information about an unauthorized person
- stalking, doxxing, skip tracing, OSINT targeting, or identity verification
- deleting public records themselves, such as voter, property, court, or county records
- legal advice
- CAPTCHA-solver services, fingerprint spoofing, or anti-bot bypass

## What The Skill Does

The bundled skill ports the upstream [Nous Research Hermes Agent `unbroker` skill](https://github.com/NousResearch/hermes-agent/tree/main/optional-skills/security/unbroker) into CoWork's local skill runtime.

It uses a deterministic Python engine at `resources/skills/unbroker/scripts/pdd.py` to manage:

- consent-gated subject intake
- local dossiers and broker exposure ledgers
- broker data, including BADBOOL-derived people-search records and registry references
- scan, plan, opt-out, email, verification, recheck, and human-task states
- a `next` queue that tells the agent what to do next
- a final consolidated human-task digest for CAPTCHA, ID, phone, fax, or other human-only work

CoWork adds the runtime mapping around that engine: shell commands run through CoWork's command tools, browser work uses the available browser automation tools, recurring checks can use CoWork scheduling, and large discovery phases can use CoWork multi-agent orchestration when appropriate.

## How To Use It

`unbroker` is built in. There is nothing to install from the Skill Store.

The easiest way to use it is to ask directly:

```text
Use the unbroker skill to remove my data from data brokers and people-search sites.
Ask for the intake details you need, record my consent before acting, keep the ledger local, and give me one final human-task digest.
```

```text
/unbroker I was doxxed and want authorized cleanup of my own broker exposure.
Do not act without recorded consent. Start with setup, intake, and a scan plan.
```

```text
Use unbroker to set up recurring monitoring so brokers do not relist me after removals.
```

Good requests usually include:

- whose data is being cleaned up and whether they are present or have authorized it
- name aliases, current/prior cities and states, emails, and phone numbers the subject consents to use
- residency, especially California when CCPA/CPRA and DROP flows may apply
- whether the goal is one-time cleanup, post-doxxing triage, or recurring monitoring
- any brokers that are already known to expose the subject

## Invocation Model

`unbroker` follows CoWork's additive skill runtime.

- The original task remains canonical.
- The skill adds scoped privacy-cleanup instructions and local workflow expectations.
- It does not replace the user request with a synthetic prompt.
- Direct skill slash routing such as `/unbroker ...` uses the same additive model when enabled in the composer.

See [Skills Runtime Model](../skills-runtime-model.md).

## Consent And Safety

The skill must record consent before scanning or removal work. The local engine enforces this through `pdd.py intake ... --consent`, and the agent should not bypass that gate.

The autonomy contract is intentionally narrow:

- use only the planned disclosure fields for each broker action
- do not ask for per-submission permission when consent and `autonomy=full` are already recorded
- do not interrupt for human-only work; queue it and present one digest at the end
- never mark `confirmed_removed` until a verifying re-scan shows the listing is gone
- never use solver services, fingerprint spoofing, or anti-bot defeat techniques
- do not represent public-record deletion or legal outcomes as guaranteed

## Local Data Storage

Unbroker stores sensitive personal data locally.

The Python engine chooses its data root in this order:

1. `PDD_DATA_DIR`, when explicitly set
2. `$COWORK_HOME/unbroker`
3. `$COWORK_USER_DATA_DIR/unbroker`
4. legacy upstream fallback `$HERMES_HOME/unbroker`
5. legacy upstream fallback `~/.hermes/unbroker`

Files are written with restrictive permissions where supported. If the `age` binary is available, the skill can use local encryption support for stored dossiers and ledgers.

Operators should treat the data root as sensitive because it can contain names, contact details, locations, broker evidence, disclosed-field logs, and verification state.

## Workflow Commands

The agent normally runs these commands from the bundled skill directory. They are documented here so maintainers and power users can understand the flow:

```bash
python3 scripts/pdd.py setup --auto
python3 scripts/pdd.py doctor
python3 scripts/pdd.py intake --full-name "Subject Name" --email subject@example.com --city "City" --state CA --residency US-CA --consent --consent-method self
python3 scripts/pdd.py next <subject_id>
python3 scripts/pdd.py tasks <subject_id>
python3 scripts/pdd.py status <subject_id>
```

Core commands:

- `setup --auto`: detects available browser, email, encryption, and automation capabilities
- `doctor`: prints readiness and broker database status
- `intake`: creates the consent-gated subject record
- `next`: returns the ordered action queue the agent should drain
- `record`: writes scan, opt-out, verification, blocked, and human-task outcomes
- `tasks`: prints the consolidated human-task digest
- `status`: prints a markdown status report
- `due`: lists cases ready for recurring recheck

## Optional Automation Upgrades

The skill works with only `python3`, but additional local capabilities make more of the workflow hands-off:

- `BROWSERBASE_API_KEY` for a managed browser lane when appropriate
- an operator-controlled Chrome/Chromium CDP session for logged-in webmail and session-bound broker flows
- `EMAIL_ADDRESS` and `EMAIL_PASSWORD`, plus optional SMTP/IMAP host settings, for programmatic request and verification mail
- Google Sheets capability for tracker output
- `age` for local encrypted storage support

These upgrades should still respect the same consent, least-disclosure, CAPTCHA, and verification rules.

## Licensing And Attribution

The code is based on the upstream Hermes Agent `unbroker` skill and is MIT licensed.

The broker dataset includes BADBOOL-derived data under CC BY-NC-SA 4.0 terms. Keep the bundled `LICENSE.txt`, README attribution, and manifest license note intact when redistributing the skill.

## Implementation Files

The bundled port lives at:

- `resources/skills/unbroker.json`
- `resources/skills/unbroker/SKILL.md`
- `resources/skills/unbroker/scripts/`
- `resources/skills/unbroker/references/`
- `resources/skills/unbroker/templates/`
- `registry/skills/unbroker.json`

For maintenance validation, see [Development](../development.md#testing-unbroker).
