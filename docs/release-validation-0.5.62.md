# 0.5.62 release validation

**Draft candidate; do not publish yet.** Prepared on 2026-10-27 from main at
`d14eed43545790c8f4a7cbfda03599b68c2f5313`, on macOS arm64 and Node 24.21.0.
The task-computer implementation in PR #774 is already merged. This preparation
adds fixes discovered during live qualification, release notes and repeatable QA.

## Verified locally

| Check | Command or surface | Result |
| --- | --- | --- |
| Locked install and build | `npm ci --no-audit --no-fund`; `npm run build` | Passed; subsequent Electron rebuild includes the final runtime fixes. |
| Full suite and bundled skills gates | `npm test` | 124 Node tests and 18,705 Vitest tests passed; five Vitest tests skipped. This run preceded the final profile-cleanup and CLI-help fixes, which have separate coverage below. |
| Final environment regressions | Vitest environment directory and bot-desktop manager | Four files, 72 tests passed, including profile ownership, both capture helpers, lifecycle and Cua protocol behavior. |
| Setup and CLI usage | Node setup-directory regression; CLI help regressions | Four tests passed. Missing commands still fail; explicit `coworkctl --help` and `-h` succeed. |
| Static checks | `npm run type-check`; `npm run lint`; `npm run fmt:check`; `npm run qa:docs-versions`; `git diff --check` | Passed. |
| Approval boundaries and reliability | `npm run qa:approval-boundaries`; `npm run qa:harness` | 546 approval tests; 1,516 harness tests, fixture evaluation and nine memory evaluation tests passed. |
| Docker | `COWORK_QA_CONTAINER_RUNTIME=docker node scripts/qa/task-computer-smoke.cjs` | Passed, including two guests, import/export, commands, browser click/readback, screenshots, takeover, actual SQLite/policy routing, host-tool denial and confirmed cleanup. A second profile's startup cleanup preserves the live browser and server. |
| Podman | Same smoke with `COWORK_QA_CONTAINER_RUNTIME=podman` | Passed with Podman 6.1.4 on a dedicated AppleHV VM, with Docker fallback excluded. VM stopped and removed afterward. |
| Cua | `node scripts/qa/task-computer-cua-smoke.cjs` | Passed on Cua 0.9.0: owned Space, borrowed attachment without deletion, imports, commands/files, browser interaction/readback, desktop capture, takeover lease, export and confirmed deletion. |
| Bot/database upgrade | `COWORK_UPGRADE_BASELINE=<installed-0.5.61> npm run qa:bots:upgrade` | Passed two current daemon starts and desktop startup, preserving synthetic bots and rows. |
| Memory upgrade | `release-upgrade-memory-smoke.mjs` against an immutable candidate copy and published 0.5.61 | Passed previous desktop/daemon, current daemon twice, current desktop twice, previous daemon downgrade and current daemon after downgrade. |
| Clean npm install | `npm pack --ignore-scripts`; `COWORK_RELEASE_TARBALL=<tarball> node scripts/release-smoke-install.mjs` | Passed `--ignore-scripts --omit=optional` install, installed setup without bootstrap fallback, Electron SQLite loading and deterministic browser-host workflow smoke. Required built desktop and CLI entrypoints verified. |
| macOS installers | Unsigned arm64 packaging; `smoke-desktop-artifacts.mjs --platform=mac --allow-unsigned --expected-version=0.5.62` | Passed ad hoc signature, mounted DMG launch and ZIP terminal installer. Final metadata includes actual ZIP/DMG sizes and SHA-512 hashes. |

The native packaged viewer visibly rejected input before takeover, accepted the
Verify click after takeover, and released control on Hand back and Done. That
UI observation alone does not establish the agent's subsequent readback.

## Real-model acceptance is still pending

The authorized ChatGPT sign-in successfully served real `gpt-6-luna` calls through
the installed CoWork OpenAI provider adapter and a temporary authenticated bridge
bound to `127.0.0.1`. The packaged app exercised real file, command, browser and
input-request tools. Tokens stayed in memory; neither the guest nor the synthetic
profile received the ChatGPT tokens. This does not validate native OAuth login or
refresh UX.

A complete real-model Ready → human Verify → Done → fresh Verified snapshot →
report export → guest deletion has **not passed**:

- One walkthrough lost its live guest state. Docker recorded a stop at
  `2026-10-27 13:18:53 UTC` and recreation at `13:19:07 UTC`. Review found that
  startup cleanup selected desktops across profiles; that flaw is fixed and its
  live Docker/Podman regression passes. The interrupted walkthrough is excluded.
- A subsequent fixture was incorrectly seeded with a placeholder page. Its
  negative readback is excluded. The fixture was corrected, and a bounded attempt
  confirmed Ready, but stopped before human interaction/readback.
- Real-model calls were stopped at approximately 996,000 logged input/output
  tokens across the approved allowances. No further model requests are running.
  A further complete real-model walkthrough requires a new usage-budget decision.

Only synthetic resources were removed. Interrupted/cancelled guests required
explicit task-owned cleanup; their durable records are not presented as evidence
of automatic completion cleanup.

## Installed CLI startup gate

CLI help checks pass, but the required installed `cowork run "who are you?"`
acceptance did not complete. The test used a disposable profile, a deterministic
Ollama-compatible fixture bound to `127.0.0.1`, and no real-model calls. A native
stack sample at `2026-10-27 13:44:59 UTC` showed the installed Electron process
waiting in macOS `SecItemCopyMatching` / `SecKeychainItemCopyContent` before task
startup. The task-owned process was stopped; Keychain permissions and existing
profile data were not changed. Resolve this native startup wait and repeat the
installed launcher/one-shot check before publication. Unpack-only harness attempts
with incomplete module-resolution layouts are excluded from install evidence.

## Scope and remaining release gates

- Cua selected Docker `runc` locally. No VM or gVisor isolation claim is made for
  Cua. Its external viewer's close/fencing behavior remains outside this proof.
- macOS artifacts are ad hoc signed and not notarized. Signed distribution needs
  the normal signing/notarization gate; Windows and Linux release artifacts need
  their own exact-candidate CI checks.
- The clean-install and upgrade fixtures use synthetic data. Existing personal
  provider sign-ins and real channel delivery are not covered by these fixtures.
- Local artifacts are `release/CoWork-OS-0.5.62-arm64.dmg`,
  `release/CoWork-OS-0.5.62-arm64-mac.zip` and an npm tarball. They have not been
  uploaded, tagged or published. Retain a SHA-256 sidecar outside the tarball.
- Keep the preparation PR draft until the real-model and installed CLI startup
  gates are resolved. Before
  publication, review/merge it, require green CI for the exact head, rebuild from
  the clean release revision and rerun release smoke. Tagging, npm publication and
  installer deployment are separate publication actions.

All test servers used explicit loopback bindings. Guest HTTP fixtures used
`python3 -m http.server 8765 --bind 127.0.0.1`; the model bridge used an ephemeral
host loopback port to avoid collisions with repository test fixtures.
