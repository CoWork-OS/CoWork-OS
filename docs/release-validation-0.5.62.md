# 0.5.62 release validation

Release preparation for PR #798, on macOS arm64 with Node 24.21.0. Nothing has
been tagged, uploaded or published. The branch includes main
`ebfa473455a8eda1b1e2ac2c3a092bc6703ef49f`, including #797 and subsequent terminal
and branding updates. The task-computer implementation in #774 is already merged.
The packaged real-provider and viewer qualification below used retry-fix commit
`4400e6a59` on main `8446d348371a46a6d2fb842d64a1f5ce661f8838`, before the later
terminal and branding changes. See the PR checks for the latest merged candidate.

## Current checks

| Check | Command or surface | Result |
| --- | --- | --- |
| Build | Explicit `npm run build` after the main refresh | Passed all renderer, web, location helper, Electron, daemon, CLI and connector builds. Locked dependency installation was also completed during candidate preparation. |
| Full suite and bundled skills gates | `npm test` | On the earlier main base, 128 Node tests and 18,712 Vitest tests passed; five Vitest tests skipped. |
| Terminal and takeover regressions | Terminal command-mark and block-runner tests plus executor step-failure suite | 346 tests passed after merging the terminal and branding changes. |
| Retry regression | Executor step-failure and computer-handoff suites | 323 tests passed, including two new cases that persist the failed tool result and pause before another provider call while human control blocks a required mutation. |
| Keychain regressions | Six focused storage/identity suites | 41 tests passed. |
| Installed launcher regression | Node dependency, setup cwd and CLI-help suites | Five tests passed; an installed import-only dependency no longer triggers an unnecessary npm reinstall. |
| Static checks | Type check, lint, formatting, docs versions and diff checks | Passed after the final runtime fix. |
| Approval/reliability baseline | `qa:approval-boundaries`; `qa:harness` | Earlier candidate: 546 approval tests, 1,516 harness tests, fixture evaluation and nine memory evaluation tests passed. |
| Docker | Explicit Docker task-computer smoke | Passed two guests, import/export, commands, browser click/readback, screenshots, takeover, actual SQLite/policy routing, host-tool denial and physical cleanup. Another profile's startup preserves the live browser/server. |
| Podman | Same smoke with `COWORK_QA_CONTAINER_RUNTIME=podman` | Passed with Podman 6.1.4 on a dedicated AppleHV VM and Docker fallback excluded. The test VM was stopped and removed. |
| Cua | `task-computer-cua-smoke.cjs` | Passed Cua 0.9.0 owned Space, borrowed attachment without deletion, imports, commands/files, browser interaction, desktop capture, takeover, export and confirmed deletion. |
| Bot/database upgrade | Published 0.5.61 → rebuilt current candidate | Passed two current daemon starts and current desktop startup; synthetic bots, teams, decisions, routines and history preserved. |
| Memory upgrade | `release-upgrade-memory-smoke.mjs`, published 0.5.61 baseline | Passed previous desktop and daemon, two current daemon and two current desktop starts, previous daemon downgrade, and current daemon after downgrade. |
| Clean npm install | Explicit pack → `release-smoke-install.mjs` | Earlier-base retry-fix tarball passed install/setup without bootstrap fallback, Electron SQLite loading, browser-host workflow, CLI help, cold/warm local execution with clean exit, and authenticated desktop launcher startup. |
| macOS artifacts | Ad hoc arm64 DMG/ZIP and packaged smoke | Earlier-base retry-fix artifacts passed signature, mounted DMG launch, ZIP installation and metadata checks. The packaged executor, storage code and all 20 compiled connectors matched that candidate. |

The Docker/Podman/Cua lifecycle runs preceded the final executor-only retry fix;
the packaged viewer check exercises that fix separately. An upgrade run
under simultaneous build/packaging load missed its shutdown deadline; the quiet
repeat passed without changing the timeout. An attempted memory run while the
failed build had removed daemon output is excluded and was restarted after a
successful full build.

## Native Keychain startup and recovery

The earlier installed CLI sample at `2026-10-27 13:44:59 UTC` was waiting in
`SecItemCopyMatching` before task startup. After merging #797, fresh captured
native development startup succeeded:

- `2026-10-27T14:06:10.992Z`: `Created the data key that seals secrets`.
- `2026-10-27T14:06:13.231Z`: first window `did_finish_load`.

Installed CLI cold and warm one-shot runs and the desktop launcher now pass.
These use a deterministic Ollama-compatible fixture on explicit `127.0.0.1`,
not a real model. A separate native packaged check backed up and removed only the
synthetic profile's `safe-storage-key.json`, then restarted with real OS Keychain
access enabled. The file was restored from the database with the identical sealed
key hash, and redacted `config.get` still reported the configured
`openai-compatible` provider. The restored window loaded in 831 ms. No real
profile, Keychain item, security setting or personal credential was modified.

## Real-provider acceptance and its limits

The authorized ChatGPT sign-in served real `gpt-6-luna` calls through CoWork's
installed OpenAI provider adapter and a temporary authenticated bridge bound to
host `127.0.0.1`. ChatGPT tokens stayed in bridge memory; neither the guest nor the
synthetic profile received them. This covers provider transport, not native OAuth
login or refresh UX.

The focused task used a preconfigured synthetic plan and a prevalidated static
input page. It exercised the real packaged executor, guest tools, native viewer
and normal artifact cleanup. This is not acceptance of model-generated planning.

1. The model started a guest-loopback server, navigated to the dashboard, read
   **Ready**, requested takeover and waited.
2. During GUI control navigation, the test operator dismissed the request. The
   agent retried completion while human control blocked its tools. The bridge
   stopped dispatch at 139,273 tokens. This exposed the retry bug fixed in
   `4400e6a59`; it is not counted as a successful uninterrupted run.
3. Native interactive viewer keyboard input changed the live page to **Verified**.
   Coordinate clicks failed in the external GUI automation tool with
   `noWindowsAvailable`; no programmatic guest click substituted for the human
   action. After Hand back and an explicit follow-up, the model took a fresh
   snapshot without navigating or reloading.
4. The task's original 150,000-token cap also stopped the first continuation.
   Only that synthetic task cap was raised to the user's approved combined
   225,000 allowance. The next continuation consumed the actual snapshot and wrote
   `Observed dashboard paragraph after handback: Verified` to `report.txt`, stopped
   the actual background process and completed.
5. Normal completion exported the 54-byte report with SHA-256
   `60f77669b7d5b38bcd4eb205dff82010c687e3381a0af725de9a92501541af89`.
   The exported bytes match the receipt; the binding is `released`, its process
   list is empty, and the named container and private work directory are absent.

This proves the **recovered** real-provider takeover → fresh readback → report →
export/cleanup workflow. It does not claim an uninterrupted Done-button real-model
run. The separate deterministic packaged viewer retest covers dismissal pausing
and the normal Done-button route after the fix.

For the dismissal case, the rebuilt app paused while the person held the computer;
the deterministic provider recorded no additional request until the explicit
follow-up. A separate fresh task exercised the normal Done route: keyboard input
changed **Ready** to **Verified** in the interactive viewer, Done handed control
back, and a fresh snapshot observed the change. It completed with status `ok`,
stopped the guest server, exported `report.txt` with a matching SHA-256 receipt,
and removed its owned container and private work folder. This was a scripted
provider fixture, not a real-model run. A combined dismissal/recovery fixture
reached export but returned partial completion because its fixed responses could
not handle a subsequent write-recovery prompt; it is excluded from the clean
Done-path result.

This focused run used **176,537 total input/output tokens**, including 912 tokens
for the app's composer prediction, within the combined 225,000 allowance. The
bridge is stopped. Earlier interrupted and incorrectly seeded walkthroughs remain
excluded from acceptance; they used approximately 996,000 tokens under the older
allowances. Only task-owned synthetic resources were cleaned up.

## Distribution gates

- Cua selected Docker `runc` locally. No VM or gVisor isolation is claimed for
  Cua. Its external viewer's close/fencing behavior is outside this proof.
- macOS qualification artifacts are ad hoc signed and not notarized. Signed
  distribution requires the normal signing/notarization gate. Windows and Linux
  need their own exact-candidate platform checks.
- Fresh install/upgrade fixtures use synthetic data; personal provider sign-ins
  and real channel delivery are not covered.
- Earlier-base local artifacts are staged outside the checkout under
  `/tmp/cowork-798-release/release/` and `/tmp/cowork-798-artifacts/`. They
  predate the later terminal and branding changes. Use a rebuilt release artifact;
  SHA-256 sidecars belong outside the npm tarball.
- Before publication, require review and green exact-head CI, merge the release
  preparation, rebuild from the clean release revision, and rerun release smoke.
  Merge, tagging, npm publication and installer deployment are separate actions.

All test listeners bind explicitly to loopback. Guest HTTP uses
`python3 -m http.server 8765 --bind 127.0.0.1`; host model/provider fixtures use
ephemeral ports on `127.0.0.1`. Baseline upgrade processes have Docker/Podman masked
so the older release's unscoped cleanup cannot interrupt another profile's guest.
