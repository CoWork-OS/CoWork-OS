# 0.5.62 release validation

Release preparation for PR #798, on macOS arm64 with Node 24.21.0. Nothing has
been tagged, uploaded or published. The qualified candidate is
`3e9624082`, which merges main `a82214d00eb1577a9d6e5a03bc8c7f715c163597`
(including #797, #800 and the terminal and branding updates) into the release
branch. The task-computer implementation in #774 is already merged. The
real-provider walkthrough below used the earlier retry-fix commit `4400e6a59` on
main `8446d348371a46a6d2fb842d64a1f5ce661f8838`; the deterministic packaged viewer
retest was repeated on the merged candidate. See the PR checks for the latest head.

#798 merged into main as `6ed0bea47`, together with #801 (data key on Linux
without a keyring, secrets upgrade smoke) and #803 (Open desktop restores a
minimized viewer). [Requalification on main](#requalification-on-main-6ed0bea47)
repeats the release checks on that revision.

## Current checks

| Check | Command or surface | Result |
| --- | --- | --- |
| Build | Explicit `npm run build` on `3e9624082` | Passed all renderer, web, location helper, Electron, daemon, CLI and connector builds. Locked dependency installation was also completed during candidate preparation. |
| Full suite and bundled skills gates | `npm test` | Before the #800 merge, 132 Node tests and 18,728 Vitest tests passed (five skipped). On `3e9624082`, 18,737 Vitest tests passed and one failed in two local full runs while host load averaged about 129 from unrelated processes: `execution-environment.test.ts` "recovers a lost background handle and stops it during completion", which waits on a real guest-agent process with a bounded stop. The file passed 30/30 in three isolated runs, and exact-head CI Tests passed. #800 does not touch this code. |
| Terminal and takeover regressions | Terminal command-mark and block-runner tests plus executor step-failure suite | 346 tests passed after merging the terminal and branding changes. |
| Retry regression | Executor step-failure and computer-handoff suites | 323 tests passed, including two new cases that persist the failed tool result and pause before another provider call while human control blocks a required mutation. |
| Keychain regressions | Storage/identity suites and startup-notice tests | The earlier candidate passed 41 tests; four focused suites passed 19 tests after adding the notice. |
| Installed launcher regression | Node dependency, setup cwd and CLI-help suites | Five tests passed; an installed import-only dependency no longer triggers an unnecessary npm reinstall. |
| Static checks | Type check, lint, formatting, docs versions, release surfaces, positioning copy and diff checks | Passed on `3e9624082`. |
| Approval/reliability baseline | `qa:approval-boundaries`; `qa:harness` | Earlier candidate: 546 approval tests, 1,516 harness tests, fixture evaluation and nine memory evaluation tests passed. |
| Docker | Explicit Docker task-computer smoke | Passed two guests, import/export, commands, browser click/readback, screenshots, takeover, actual SQLite/policy routing, host-tool denial and physical cleanup. Another profile's startup preserves the live browser/server. |
| Podman | Same smoke with `COWORK_QA_CONTAINER_RUNTIME=podman` | Passed with Podman 6.1.4 on a dedicated AppleHV VM and Docker fallback excluded. The test VM was stopped and removed. |
| Cua | `task-computer-cua-smoke.cjs` | Passed Cua 0.9.0 owned Space, borrowed attachment without deletion, imports, commands/files, browser interaction, desktop capture, takeover, export and confirmed deletion. |
| Bot/database upgrade | Published 0.5.61 → rebuilt current candidate | Passed two current daemon starts and current desktop startup; synthetic bots, teams, decisions, routines and history preserved. |
| Memory upgrade | `release-upgrade-memory-smoke.mjs`, published 0.5.61 baseline | Passed previous desktop and daemon, two current daemon and two current desktop starts, previous daemon downgrade, and current daemon after downgrade. |
| Clean npm install | Explicit pack → `release-smoke-install.mjs` | The `3e9624082` tarball (SHA-256 `18d782017a59e16704444b65a0700c91e6a4ce9dd32d6e314b56e85f04cd2339`) contains the required desktop, CLI and launcher entrypoints and passed install/setup without bootstrap fallback, Electron SQLite loading, browser-host workflow, cold/warm local execution with clean exit, and authenticated desktop launcher startup. |
| macOS artifacts | Ad hoc arm64 DMG/ZIP and `smoke-desktop-artifacts.mjs --allow-unsigned` | Built from a staging tree whose shipped tracked sources match `3e9624082`. Updater names aligned and checked; signature, mounted-DMG first-window load (`did_finish_load` within 60 seconds), ZIP installation, `hdiutil verify` and `unzip -t` passed. DMG `b3771dce4b0783d2cbbec62a74f74e4cf57da04396291046e743e85311452b0b`, ZIP `bf3bea4e028fb7ada5fa43864194a48227e9686ac98ca895d2fbde544174dd36`. The packaged app contains the #800 identity entry. |
| Packaged viewer | `3e9624082` packaged app, deterministic loopback provider fixture | With real Keychain access, a fresh synthetic profile created its data key and loaded the first window 465 ms into startup. The task started `python3 -m http.server 8765 --bind 127.0.0.1` in the guest, read **Ready** and requested takeover. After Take over, a pointer click on Verify in the native interactive viewer changed the page to **Verified**; Done was then submitted, and the next provider call followed only after that. A fresh snapshot without reload observed **Verified**; the task wrote `report.txt`, stopped the actual process and finished `completed` / `ok`. The 50-byte export matches its receipt (`f6eef934240fdb77d07fd25c3443a4f595eb788f0c24059e289176ceaf16593a`); the binding is `released` with no processes, and the task-owned container and private folder are absent. The pre-merge head `216fcb31b` passed the same retest. |

The Docker/Podman/Cua lifecycle runs preceded the final executor-only retry fix;
the packaged viewer check exercises that fix separately. An upgrade run
under simultaneous build/packaging load missed its shutdown deadline; the quiet
repeat passed without changing the timeout. An attempted memory run while the
failed build had removed daemon output is excluded and was restarted after a
successful full build.

## Requalification on main `6ed0bea47`

Run on 2026-10-28 after #798, #801 and #803 merged. The earlier table describes
`3e9624082`; these results replace it for the release revision.

| Check | Result |
| --- | --- |
| Build and static checks | `npm run build`, type check, lint, formatting, docs versions, release surfaces, positioning copy and `git diff --check` passed. The #801 and #803 suites (`safe-storage-data-key`, `desktop-viewer-window`) passed 12/12. |
| Clean npm install | The tarball (SHA-256 `c441307f9ba3c6ffffe667941fc6e976a4d838f0c44d5f4185e5c2cbb20338e1`) contains the required entrypoints, including `ipc/desktop-viewer-window.js`, and passed the same install, setup, SQLite, browser-host, CLI and launcher checks without bootstrap fallback. |
| macOS artifacts | Ad hoc arm64 DMG/ZIP built from a staging tree whose shipped sources match `6ed0bea47`. Updater names aligned; signature, mounted-DMG first-window load, ZIP installation, `hdiutil verify` and `unzip -t` passed. DMG `e193c75e488006a27039d01e690e6a33bac6df06f239500fc817b469686da93e`, ZIP `27462dda546d2f50613fad6749477bbea2b4c032f7cc78e4eae39cf0827d05a3`. |
| Packaged viewer | With real Keychain access, a fresh synthetic profile created its data key and loaded the first window 483 ms into startup. The task read **Ready** and requested takeover. After Take over, a real pointer click on Verify in the native viewer changed the page to **Verified**. The viewer was then minimized, and **Open desktop** brought it back on screen still showing **Verified** (#803). Done was submitted; the fresh snapshot observed **Verified**, the task wrote `report.txt`, stopped the process and finished `completed` / `ok`. The 50-byte export matches its receipt (`f6eef934240fdb77d07fd25c3443a4f595eb788f0c24059e289176ceaf16593a`), the binding is `released` with no processes, and the container and private folder are absent. |
| CI | [Run 40764993519](https://github.com/CoWork-OS/CoWork-OS/actions/runs/40764993519) on `6ed0bea47`: every job passed, including the macOS and Windows builds. On the first attempt Tests (macOS) failed `execution-environment.test.ts` "recovers a lost background handle and stops it during completion" (1 of 18,749), the same timing-sensitive test that failed locally under load; the rerun of that job passed. #798 did not change this stop path, and earlier main runs passed it. On a macOS host there is no `/proc`, so `stop_process` relies on the cancel file and waits at most two seconds for the supervisor to exit. |

Two attempts are excluded. The first started while Docker Desktop was not running,
so the guest could not start. In the second, the post-Done snapshot still read
**Ready** because the Verify click had not reached the guest page; the task failed
closed (`failed`, binding `cleanup_pending`, "Invalid output transfer") rather than
reporting success. That fixture advanced past its failed check and returned scripted
text claiming a written report, so the fixture now stops at the first failed check.
The external GUI automation tool would not start, so the accepted run used guarded
native pointer events: each click was refused unless the test app's window was
topmost at that point, and only that app's windows were captured.

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

The refreshed ad hoc package encountered another startup wait: at
`2026-10-27T16:58:13Z`, macOS `securityd` reported displaying a Keychain access
prompt for the new bundle. A native sample at `16:59:01Z` showed the asynchronous
request waiting in `SecItemCopyMatching`. A retry eventually reached the first
window after about 37 minutes; the delay must not be counted as a normal startup
pass. CoWork now shows a notice if this operation remains pending for two seconds,
and closes it when the operation completes. It continues waiting for the real
Keychain result without granting access or switching encryption methods.
The macOS artifact smoke now waits up to 60 seconds for the first-window load
event and fails if the app exits or never reaches it; regression tests cover a
pending process, an early clean exit and split log output.
An Electron fixture displayed the notice and closed it after a synthetic wait.
A fresh development profile using the real Keychain opened its data key at
`2026-10-27T20:27:39.186Z` and loaded the first window at
`2026-10-27T20:27:41.805Z`. The rebuilt ad hoc packages for `216fcb31b` and
`3e9624082` each started fresh synthetic profiles with real Keychain access and no
visible wait (first window 551 ms and 465 ms into startup). That does not prove a
prompt cannot appear for other bundle identities or machines.

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
- macOS releases ship ad hoc signed and not notarized, by design (see
  [macOS Installation](macos-installation.md)); the terminal installer is the
  recommended path, and the artifact smoke covers its ZIP installation. There is
  no Developer ID gate. Browser-downloaded DMGs still need **Open Anyway**.
- Platform artifacts on the merged candidate (`0a9017f3a`/`992c5b298`, code identical
  to `3e9624082`): the manual **Windows Installer Smoke** workflow
  ([run 40597821782](https://github.com/CoWork-OS/CoWork-OS/actions/runs/40597821782))
  packaged and passed `CoWork-OS-Setup-0.5.62.exe`. The manual **macOS DMG Smoke**
  ([run 40600468769](https://github.com/CoWork-OS/CoWork-OS/actions/runs/40600468769))
  passed signature, DMG first-window and terminal-installer checks on a clean runner,
  after giving that workflow the same 4 GB Node heap as CI. Its first run ran out of
  heap during the Electron TypeScript build. The Linux x64 server package was built
  with `npm run package:linux:server` in an emulated `node:24-bookworm` amd64 container
  and passed `package:linux:server:smoke` (daemon `/health` on `127.0.0.1`); SHA-256
  `a023bfd55ea90a02b24a19941ad2eb4d78c0effdffd3395d8153e077c2326c6f`. The tag-triggered
  release workflow rebuilds all of these; nothing was uploaded.
- Fresh install/upgrade fixtures use synthetic data; personal provider sign-ins
  and real channel delivery are not covered.
- Local qualification artifacts are staged outside the checkout: `3e9624082`
  under `/tmp/cowork-798-upstream-stage/release-merge/` and
  `/tmp/cowork-798-merge-artifacts/`; `6ed0bea47` under
  `/tmp/cowork-798-upstream-stage/release-main/` and `/tmp/cowork-798-main-artifacts/`. They are not release artifacts: rebuild from
  the clean release revision. SHA-256 sidecars belong outside the npm tarball.
- During the merged-head viewer run, the app window twice stopped repainting
  while its page kept updating, and resizing the window restored it once. Both
  windows were behind another app or Space at the time, so this is recorded as
  an observation, not a confirmed defect. **Open desktop** also did not restore a
  minimized viewer window; #803 fixed this, and the packaged check on `6ed0bea47`
  confirms it.
- Before publication, require review and green exact-head CI, merge the release
  preparation, rebuild from the clean release revision, and rerun release smoke.
  Merge, tagging, npm publication and installer deployment are separate actions.

All test listeners bind explicitly to loopback. Guest HTTP uses
`python3 -m http.server 8765 --bind 127.0.0.1`; host model/provider fixtures use
ephemeral ports on `127.0.0.1`. Baseline upgrade processes have Docker/Podman masked
so the older release's unscoped cleanup cannot interrupt another profile's guest.
